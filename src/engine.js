// 博物馆导览制作间 —— 领域引擎
// 所有函数接收 store（JSON 文档对象），便于用隔离内存库做验收演练。
const crypto = require('crypto');

const AUDIENCES = ['child', 'general', 'expert'];
const LANGS = ['zh', 'en'];
const AUDIENCE_LABEL = { child: '儿童', general: '普通', expert: '专家' };
const LANG_LABEL = { zh: '中文', en: '英文' };

// 馆内拓扑：展厅为节点，相邻关系与步行距离（米）
const HALLS = {
  lobby:   { zh: '中央大厅', en: 'Grand Hall' },
  bronze:  { zh: '青铜厅',   en: 'Bronze Gallery' },
  jade:    { zh: '玉器厅',   en: 'Jade Gallery' },
  pottery: { zh: '陶器厅',   en: 'Pottery Gallery' },
  slips:  { zh: '简牍厅',   en: 'Bamboo Slips Gallery' },
};
const HALL_GRAPH = {
  lobby:   [{ to: 'bronze', m: 25 }, { to: 'jade', m: 20 }, { to: 'pottery', m: 30 }],
  bronze:  [{ to: 'lobby', m: 25 }],
  jade:    [{ to: 'lobby', m: 20 }],
  pottery: [{ to: 'lobby', m: 30 }, { to: 'slips', m: 18 }],
  slips:   [{ to: 'pottery', m: 18 }],
};

const now = () => new Date().toISOString();
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function voices(lang, audience) {
  const table = {
    zh: { child: ['zh-warm-female', 0.92], general: ['zh-neutral-male', 1.0], expert: ['zh-calm-female', 1.14] },
    en: { child: ['en-warm-female', 0.95], general: ['en-neutral-male', 1.0], expert: ['en-calm-male', 1.12] },
  };
  const [voiceId, rate] = table[lang][audience];
  return { voiceId, rate };
}

// ---------- 基础工具 ----------
function find(store, coll, id) {
  return store[coll].find((x) => x.id === id);
}
function scriptsOfExhibit(store, exhibitId) {
  return store.scripts.filter((s) => s.exhibitId === exhibitId);
}
function referencedFactVersions(script) {
  const sigs = {};
  for (const seg of script.segments) for (const f of seg.factRefs || []) sigs[f] = Math.max(sigs[f] || 0, 0);
  return sigs;
}

// 文稿复核状态：由「审批快照」与当前措辞/事实版本比对得出，不覆盖任何措辞
function reviewStatus(store, script) {
  const a = script.approval;
  if (!a) return { status: 'draft', reasons: ['NEVER_APPROVED'] };
  const reasons = [];
  if (a.wordingHash !== script.wordingHash) reasons.push('WORDING_CHANGED');
  for (const seg of script.segments) {
    for (const fid of seg.factRefs || []) {
      const f = find(store, 'facts', fid);
      if (f && (a.factSigs[fid] || 0) < f.version) reasons.push(`FACT_REVISED:${f.code}`);
    }
  }
  return reasons.length ? { status: 'need_review', reasons } : { status: 'reviewed', reasons: [] };
}

function computeWordingHash(script) {
  return hash(script.segments.map((s) => `${s.code}=${s.text}`).join('|'));
}

// ---------- TTS 时长仿真（确定性：同文本/音色/语速 => 同长度） ----------
function durationMs(text, voice) {
  const isZh = /[一-鿿]/.test(text);
  const units = isZh ? (text.match(/[一-鿿]/g) || []).length : text.trim().split(/\s+/).filter(Boolean).length;
  const base = isZh ? units / 4.3 : units / 2.6;
  const jitter = 1 + (parseInt(hash(text).slice(0, 2), 16) % 7 - 3) * 0.006;
  return Math.round(((base + 0.4) / voice.rate) * jitter * 1000);
}

function expectedAudioHash(text, voice) {
  return hash(`${text}|${voice.voiceId}|${voice.rate.toFixed(2)}`);
}

// ---------- 任务队列 ----------
// scope: {kind:'script', scriptId, segCode, type:'audio'|'subtitle'}
//      或 {kind:'transit', routeId, edgeKey, lang, audience, type:'audio'}
function taskScopeKey(sc) {
  return sc.kind === 'script'
    ? `script:${sc.scriptId}:${sc.segCode}:${sc.type}`
    : `transit:${sc.routeId}:${sc.edgeKey}:${sc.lang}:${sc.audience}`;
}

function supersede(store, scopeKey, byTaskId) {
  // 只取代仍在队列中的任务；running 任务已经提交给 TTS 服务无法撤回，
  // 其迟到结果将由内容哈希（hash_mismatch）拦截，不会覆盖新文本。
  for (const t of store.audioTasks) {
    if (t.scopeKey === scopeKey && t.status === 'queued') {
      t.status = 'superseded';
      t.supersededBy = byTaskId || null;
      t.finishedAt = now();
    }
  }
}

function enqueueTask(store, scope, payload) {
  const key = taskScopeKey(scope);
  const t = {
    id: store.nextId('task'),
    kind: scope.kind,
    scopeKey: key,
    scope,
    payload, // 提交时的文本哈希快照
    status: 'queued',
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  supersede(store, key, t.id);
  store.audioTasks.push(t);
  return t;
}

// 改一句话：只为受影响片段排队，且只排文本/音色哈希过期的产物
function reconcileScript(store, script) {
  const made = [];
  const taskIsRunning = (id) => {
    const t = id && find(store, 'audioTasks', id);
    return t && (t.status === 'queued' || t.status === 'running');
  };
  for (const seg of script.segments) {
    const v = voices(script.lang, script.audience);
    const h = expectedAudioHash(seg.text, v);
    const prev = seg.audio && seg.audio.status === 'ready'
      ? seg.audio
      : (seg.audio && taskIsRunning(seg.audio.taskId) ? seg.audio : null);
    seg.audio = prev ? { ...prev, status: 'running' } : { status: 'pending' };
    seg.subtitle = seg.subtitle || { status: 'pending' };
    if (!taskIsRunning(seg.audio.taskId) || seg.audio.contentHash !== h) {
      const t = enqueueTask(store,
        { kind: 'script', scriptId: script.id, segCode: seg.code, type: 'audio' },
        { textHash: h, text: seg.text, voice: v });
      // 若上一条任务仍 running（已提交给 TTS 无法撤回），保留旧 taskId 指针：
      // 旧音频迟到时将按内容哈希判 stale；新任务完成后再切换指针。
      const keepOld = taskIsRunning(seg.audio.taskId) && seg.audio.taskId !== t.id;
      seg.audio = keepOld
        ? { status: 'running', taskId: seg.audio.taskId, contentHash: seg.audio.contentHash, nextTaskId: t.id }
        : { status: 'pending', taskId: t.id, contentHash: h };
      made.push(t.id);
    }
    if (!taskIsRunning(seg.subtitle.taskId) || seg.subtitle.contentHash !== h) {
      const t = enqueueTask(store,
        { kind: 'script', scriptId: script.id, segCode: seg.code, type: 'subtitle' },
        { textHash: h, text: seg.text });
      const keepOld = taskIsRunning(seg.subtitle.taskId) && seg.subtitle.taskId !== t.id;
      seg.subtitle = keepOld
        ? { status: 'running', taskId: seg.subtitle.taskId, contentHash: seg.subtitle.contentHash, nextTaskId: t.id }
        : { status: 'pending', taskId: t.id, contentHash: h };
      made.push(t.id);
    }
  }
  recomputeAllRouteDurations(store);
  return made;
}

function completeTask(store, taskId) {
  const t = find(store, 'audioTasks', taskId);
  if (!t) throw new Error('TASK_NOT_FOUND');
  // 乱序完成：被更新任务取代的旧任务不得覆盖产物
  if (t.status === 'superseded') return { accepted: false, reason: 'superseded', task: t };
  if (t.status === 'done') return { accepted: false, reason: 'already_done', task: t };
  const currentHash = () => {
    if (t.kind === 'script') {
      const sc = find(store, 'scripts', t.scope.scriptId);
      const seg = sc && sc.segments.find((s) => s.code === t.scope.segCode);
      return seg ? expectedAudioHash(seg.text, voices(sc.lang, sc.audience)) : null;
    }
    const tr = routeEdge(store, t.scope.routeId, t.scope.edgeKey);
    return tr ? expectedAudioHash(tr.text[t.scope.lang], voices(t.scope.lang, t.scope.audience)) : null;
  };
  const want = t.payload.textHash;
  const nowHash = currentHash();
  if (nowHash && nowHash !== want) {
    t.status = 'stale';
    t.finishedAt = now();
    // 旧音频回报作废：把片段指针切换到已排队的新任务（nextTaskId）
    if (t.kind === 'script') {
      const sc0 = find(store, 'scripts', t.scope.scriptId);
      const seg0 = sc0 && sc0.segments.find((s) => s.code === t.scope.segCode);
      if (seg0) {
        const art = t.scope.type === 'audio' ? seg0.audio : seg0.subtitle;
        if (art && art.taskId === t.id && art.nextTaskId) {
          const nt = find(store, 'audioTasks', art.nextTaskId);
          art.taskId = art.nextTaskId;
          art.contentHash = nt ? nt.payload.textHash : art.contentHash;
          art.status = 'pending'; delete art.nextTaskId;
        }
      }
    }
    return { accepted: false, reason: 'hash_mismatch', task: t };
  }
  t.status = 'done';
  t.startedAt = t.startedAt || now();
  t.finishedAt = now();

  if (t.kind === 'script') {
    const sc = find(store, 'scripts', t.scope.scriptId);
    const seg = sc.segments.find((s) => s.code === t.scope.segCode);
    if (t.scope.type === 'audio') {
      seg.audio = {
        status: 'ready', taskId: t.id, contentHash: want,
        voice: t.payload.voice, durationMs: durationMs(t.payload.text, t.payload.voice), readyAt: now(),
      };
    } else {
      seg.subtitle = {
        status: 'ready', taskId: t.id, contentHash: want,
        cues: [{ i: 0, text: t.payload.text }], readyAt: now(),
      };
    }
  } else {
    const tr = routeEdge(store, t.scope.routeId, t.scope.edgeKey);
    const art = tr.artifacts[t.scope.lang][t.scope.audience];
    const v = voices(t.scope.lang, t.scope.audience);
    const text = tr.text[t.scope.lang];
    art.status = 'ready'; art.taskId = t.id; art.contentHash = want;
    art.voice = v; art.durationMs = durationMs(text, v); art.readyAt = now();
  }
  recomputeAllRouteDurations(store);
  return { accepted: true, task: t };
}

// ---------- 事实修订（共享事实 -> 全部引用文稿进入待复核，但不动措辞/音频） ----------
function reviseFact(store, factId, patch, actor) {
  const f = find(store, 'facts', factId);
  if (!f) throw new Error('FACT_NOT_FOUND');
  const before = hash(JSON.stringify(f.content));
  Object.assign(f, patch);
  f.updatedAt = now(); f.updatedBy = actor || 'editor';
  if (hash(JSON.stringify(f.content)) !== before) f.version += 1;
  // 状态由 approval 快照推导，这里仅留下传播痕迹用于网页展示
  const affected = [];
  for (const sc of store.scripts) {
    if (sc.segments.some((s) => (s.factRefs || []).includes(factId))) {
      sc.factFlag = { factCode: f.code, at: f.updatedAt, version: f.version };
      affected.push(sc.id);
    }
  }
  return { fact: f, affectedScripts: affected };
}

// ---------- 文稿编辑（按片段稳定身份改一句话） ----------
function updateScript(store, scriptId, edits /* {segCode:text} */, actor) {
  const sc = find(store, 'scripts', scriptId);
  if (!sc) throw new Error('SCRIPT_NOT_FOUND');
  const changed = [];
  for (const [code, text] of Object.entries(edits || {})) {
    const seg = sc.segments.find((s) => s.code === code);
    if (!seg) continue;
    if (seg.text === text) continue;
    seg.text = text;
    seg.updatedAt = now();
    seg.updatedBy = actor || 'editor';
    changed.push(code); // 稳定身份 code 不变
  }
  if (changed.length) {
    sc.wordingHash = computeWordingHash(sc);
    sc.updatedAt = now();
    reconcileScript(store, sc); // 仅受影响片段产生任务
  }
  return { script: sc, changedSegments: changed };
}

function approveScript(store, scriptId, actor) {
  const sc = find(store, 'scripts', scriptId);
  const sigs = {};
  for (const seg of sc.segments) for (const fid of seg.factRefs || []) {
    sigs[fid] = (sigs[fid] || 0) >= 0 ? (find(store, 'facts', fid) ? find(store, 'facts', fid).version : 0) : 0;
  }
  sc.approval = { at: now(), by: actor || 'editor', wordingHash: sc.wordingHash, factSigs: sigs };
  return reviewStatus(store, sc);
}

// ---------- 路线：拓扑、可达性、指路音频稳定身份 ----------
function hallPath(store, fromHall, toHall) {
  if (fromHall === toHall) return { path: [fromHall], distance: 0 };
  const q = [[fromHall, [fromHall]]];
  const seen = new Set([fromHall]);
  while (q.length) {
    const [h, p] = q.shift();
    for (const e of HALL_GRAPH[h] || []) {
      if (seen.has(e.to)) continue;
      const np = [...p, e.to];
      if (e.to === toHall) {
        let d = 0;
        for (let i = 0; i < np.length - 1; i++) {
          d += (HALL_GRAPH[np[i]].find((x) => x.to === np[i + 1]) || {}).m;
        }
        return { path: np, distance: d };
      }
      seen.add(e.to); q.push([e.to, np]);
    }
  }
  return null;
}

function transitTexts(path, distance) {
  const names = path.map((h) => HALLS[h]);
  if (path.length === 3) {
    return {
      zh: `请走至${names[0].zh}，经${names[1].zh}继续前行约${distance}米，到达${names[2].zh}。`,
      en: `Head through ${names[0].en}, continue via ${names[1].en} for about ${distance} meters to reach ${names[2].en}.`,
    };
  }
  if (path.length === 2) {
    return {
      zh: `由${names[0].zh}前行约${distance}米，即到${names[1].zh}。`,
      en: `Walk about ${distance} meters from ${names[0].en} to ${names[1].en}.`,
    };
  }
  const via = names.slice(1, -1).map((n) => n.zh).join('、');
  return {
    zh: `沿参观通道经${via}，全程约${distance}米，到达${names[names.length - 1].zh}。`,
    en: `Follow the visitor route via ${names.slice(1, -1).map((n) => n.en).join(', ')}, about ${distance} meters to ${names[names.length - 1].en}.`,
  };
}

function edgeKeyOf(a, b) { return `${a}->${b}`; }
function routeEdge(store, routeId, key) {
  const r = find(store, 'routes', routeId);
  return r.transits.find((t) => t.key === key);
}

function syncRouteTransits(store, route) {
  const desired = [];
  const gaps = [];
  for (let i = 0; i < route.stops.length - 1; i++) {
    const a = find(store, 'exhibits', route.stops[i].exhibitId);
    const b = find(store, 'exhibits', route.stops[i + 1].exhibitId);
    const key = edgeKeyOf(a.id, b.id);
    desired.push(key);
    let tr = route.transits.find((t) => t.key === key && !t.retired);
    const hp = hallPath(store, a.hallId, b.hallId);
    if (!hp) {
      if (tr) tr.retired = true;
      gaps.push({ code: 'UNREACHABLE_ORDER', edge: key });
      continue;
    }
    const text = transitTexts(hp.path, hp.distance);
    if (!tr) {
      tr = { key, from: a.id, to: b.id, path: hp.path, distanceM: hp.distance, text, retired: false, artifacts: {} };
      for (const lang of LANGS) tr.artifacts[lang] = {};
      route.transits.push(tr);
    } else {
      tr.text = text; tr.path = hp.path; tr.distanceM = hp.distance;
    }
    for (const lang of LANGS) for (const aud of AUDIENCES) {
      const v = voices(lang, aud);
      const h = expectedAudioHash(tr.text[lang], v);
      const art = tr.artifacts[lang][aud] || { status: 'pending' };
      tr.artifacts[lang][aud] = art;
      if (art.status !== 'ready' || art.contentHash !== h) {
        if (art.taskId && art.contentHash === h && art.status !== 'ready') continue;
        const t = enqueueTask(store,
          { kind: 'transit', routeId: route.id, edgeKey: key, lang, audience: aud },
          { textHash: h, text: tr.text[lang], voice: v });
        tr.artifacts[lang][aud] = { status: 'pending', taskId: t.id, contentHash: h };
      }
    }
  }
  // 消失的边：保留退役记录，不再指路；取消其在途任务
  for (const tr of route.transits) {
    if (!desired.includes(tr.key) && !tr.retired) {
      tr.retired = true; tr.retiredAt = now();
      supersede(store, `transit:${route.id}:${tr.key}`, null);
    }
  }
  return gaps;
}

function recomputeRouteDuration(store, route) {
  const out = {};
  for (const lang of LANGS) {
    out[lang] = {};
    for (const aud of AUDIENCES) {
      let speech = 0, transit = 0, ready = route.stops.length > 0;
      for (const st of route.stops) {
        const sc = store.scripts.find((s) => s.exhibitId === st.exhibitId && s.lang === lang && s.audience === aud);
        if (!sc) { ready = false; continue; }
        for (const seg of sc.segments) {
          if (seg.audio && seg.audio.status === 'ready') speech += seg.audio.durationMs;
          else ready = false;
        }
      }
      for (let i = 0; i < route.stops.length - 1; i++) {
        const a = route.stops[i].exhibitId, b = route.stops[i + 1].exhibitId;
        const tr = route.transits.find((t) => t.key === edgeKeyOf(a, b) && !t.retired);
        const art = tr && tr.artifacts[lang][aud];
        if (art && art.status === 'ready') transit += art.durationMs;
        else ready = false;
      }
      out[lang][aud] = { speechMs: speech, transitMs: transit, totalMs: speech + transit, audioReady: ready };
    }
  }
  route.durations = out;
  route.durationsAt = now();
}
function recomputeAllRouteDurations(store) { store.routes.forEach((r) => recomputeRouteDuration(store, r)); }

function updateRoute(store, routeId, stops, expectedVersion, actor) {
  const r = find(store, 'routes', routeId);
  if (!r) throw new Error('ROUTE_NOT_FOUND');
  if (expectedVersion != null && expectedVersion !== r.version) {
    const err = new Error('VERSION_CONFLICT');
    err.code = 'VERSION_CONFLICT';
    err.serverVersion = r.version; err.actor = actor;
    throw err;
  }
  r.stops = stops.map((s, i) => ({ stopId: s.stopId || `stop_${i}_${s.exhibitId}`, exhibitId: s.exhibitId }));
  r.version += 1;
  r.updatedAt = now(); r.updatedBy = actor || 'editor';
  syncRouteTransits(store, r);
  validateRoute(store, r);
  recomputeRouteDuration(store, r);
  return r;
}

function withdrawExhibit(store, exhibitId, actor) {
  const ex = find(store, 'exhibits', exhibitId);
  ex.status = 'withdrawn'; ex.withdrawnAt = now(); ex.withdrawnBy = actor || 'curator';
  for (const r of store.routes) {
    if (r.stops.some((s) => s.exhibitId === exhibitId)) {
      validateRoute(store, r);
      recomputeRouteDuration(store, r);
    }
  }
  return ex;
}

function reinstateExhibit(store, exhibitId) {
  const ex = find(store, 'exhibits', exhibitId);
  ex.status = 'on_display'; delete ex.withdrawnAt;
  for (const r of store.routes) {
    if (r.stops.some((s) => s.exhibitId === exhibitId)) { validateRoute(store, r); recomputeRouteDuration(store, r); }
  }
  return ex;
}

// ---------- 闭包检查：每个 语言×受众 单元必须资料齐备 ----------
function licenseOk(ex) {
  return ex.imageLicense && ex.imageLicense.expiresAt && new Date(ex.imageLicense.expiresAt).getTime() > Date.now();
}

function evaluateClosure(store, route) {
  const units = [];
  const globalGaps = [];
  for (const st of route.stops) {
    const ex = find(store, 'exhibits', st.exhibitId);
    if (ex.status === 'withdrawn') globalGaps.push({ code: 'EXHIBIT_WITHDRAWN', stopId: st.stopId, exhibitId: ex.id, detail: `${ex.name.zh} 已临时撤展` });
    if (!licenseOk(ex)) globalGaps.push({ code: 'IMAGE_LICENSE_EXPIRED', stopId: st.stopId, exhibitId: ex.id, detail: `${ex.name.zh} 图片授权已到期` });
  }
  for (let i = 0; i < route.stops.length - 1; i++) {
    const a = route.stops[i], b = route.stops[i + 1];
    const ea = find(store, 'exhibits', a.exhibitId), eb = find(store, 'exhibits', b.exhibitId);
    const hp = hallPath(store, ea.hallId, eb.hallId);
    if (!hp) globalGaps.push({ code: 'UNREACHABLE_ORDER', detail: `${ea.name.zh} → ${eb.name.zh} 展厅之间不存在可达路径` });
  }
  for (const lang of LANGS) for (const aud of AUDIENCES) {
    const gaps = [];
    for (const st of route.stops) {
      const sc = store.scripts.find((s) => s.exhibitId === st.exhibitId && s.lang === lang && s.audience === aud);
      if (!sc) { gaps.push({ code: 'SCRIPT_MISSING', stopId: st.stopId, lang, audience: aud }); continue; }
      const rv = reviewStatus(store, sc);
      if (rv.status !== 'reviewed') gaps.push({ code: 'FACT_OR_WORDING_PENDING_REVIEW', scriptId: sc.id, stopId: st.stopId, reasons: rv.reasons });
      for (const seg of sc.segments) {
        if (!seg.audio || seg.audio.status !== 'ready') gaps.push({ code: 'AUDIO_PENDING', scriptId: sc.id, segment: seg.code });
        if (!seg.subtitle || seg.subtitle.status !== 'ready') gaps.push({ code: 'SUBTITLE_PENDING', scriptId: sc.id, segment: seg.code });
      }
    }
    for (let i = 0; i < route.stops.length - 1; i++) {
      const tr = route.transits.find((t) => t.key === edgeKeyOf(route.stops[i].exhibitId, route.stops[i + 1].exhibitId) && !t.retired);
      const art = tr && tr.artifacts[lang][aud];
      if (!art || art.status !== 'ready') gaps.push({ code: 'TRANSIT_AUDIO_PENDING', edge: tr ? tr.key : null });
    }
    units.push({ lang, audience: aud, ok: gaps.length === 0, gaps });
  }
  const routeIssues = (route.validation && route.validation.gaps) || [];
  const publishable = units.every((u) => u.ok) && globalGaps.length === 0 && routeIssues.length === 0;
  return { units, globalGaps, routeIssues, publishable };
}

function validateRoute(store, route) {
  const gaps = [];
  for (const st of route.stops) {
    const ex = find(store, 'exhibits', st.exhibitId);
    if (!ex || ex.status === 'withdrawn') gaps.push({ code: 'EXHIBIT_WITHDRAWN', stopId: st.stopId, exhibitId: st.exhibitId });
  }
  for (let i = 0; i < route.stops.length - 1; i++) {
    const ea = find(store, 'exhibits', route.stops[i].exhibitId);
    const eb = find(store, 'exhibits', route.stops[i + 1].exhibitId);
    if (ea && eb && ea.status !== 'withdrawn' && eb.status !== 'withdrawn' && !hallPath(store, ea.hallId, eb.hallId)) {
      gaps.push({ code: 'UNREACHABLE_ORDER', from: ea.id, to: eb.id });
    }
  }
  route.validation = { valid: gaps.length === 0, gaps, at: now() };
  return route.validation;
}

// ---------- 导览包：构建（可中断/续作）、发布、离线版本状态 ----------
const BUILD_STEPS = ['manifest', 'audio_zh_child', 'audio_zh_general', 'audio_zh_expert', 'audio_en_all', 'subtitles', 'images', 'checksum'];

function startBuild(store, routeId) {
  const route = find(store, 'routes', routeId);
  if (!route) throw new Error('ROUTE_NOT_FOUND');
  validateRoute(store, route); recomputeRouteDuration(store, route);
  const closure = evaluateClosure(store, route);
  if (!closure.publishable) {
    const pkg = {
      id: store.nextId('pkg'), routeId, status: 'blocked', createdAt: now(),
      closure, version: null, progress: null,
    };
    store.packages.push(pkg);
    return pkg;
  }
  const prev = store.packages.filter((p) => p.routeId === routeId && p.publishedVersion).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const version = bumpPatch(prev ? prev.publishedVersion : null);
  const pkg = {
    id: store.nextId('pkg'), routeId, status: 'building', version, createdAt: now(),
    progress: { step: 0, total: BUILD_STEPS.length, steps: BUILD_STEPS.slice() },
    interrupted: false, closure,
  };
  store.packages.push(pkg);
  return pkg;
}

function bumpPatch(v) {
  if (!v) return '1.0.0';
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

function advanceBuild(store, pkgId) {
  const pkg = find(store, 'packages', pkgId);
  if (!pkg || pkg.status !== 'building') return pkg;
  if (pkg.interrupted) { pkg.status = 'interrupted'; pkg.interruptedAt = now(); return pkg; }
  pkg.progress.step += 1;
  if (pkg.progress.step >= pkg.progress.total) {
    pkg.status = 'built'; pkg.builtAt = now();
    pkg.contentHash = hash(JSON.stringify(closureSnapshot(store, pkg.routeId)));
  }
  return pkg;
}
function interruptBuild(store, pkgId) {
  const pkg = find(store, 'packages', pkgId);
  if (pkg && pkg.status === 'building') pkg.interrupted = true;
  return pkg;
}
function resumeBuild(store, pkgId) {
  const pkg = find(store, 'packages', pkgId);
  if (!pkg) throw new Error('PACKAGE_NOT_FOUND');
  if (pkg.status !== 'interrupted') throw new Error('NOT_RESUMABLE');
  pkg.interrupted = false; pkg.status = 'building'; pkg.resumedAt = now();
  return pkg;
}
function publishPackage(store, pkgId) {
  const pkg = find(store, 'packages', pkgId);
  if (!pkg) throw new Error('PACKAGE_NOT_FOUND');
  if (pkg.status !== 'built') { const e = new Error('NOT_BUILDABLE'); e.code = 'NOT_BUILDABLE'; throw e; }
  // 发布前再做一次闭包（防止构建后事实又被改）
  const closure = evaluateClosure(store, find(store, 'routes', pkg.routeId));
  if (!closure.publishable) { pkg.status = 'blocked'; pkg.closure = closure; const e = new Error('CLOSURE_DRIFT'); e.code = 'CLOSURE_DRIFT'; e.closure = closure; throw e; }
  pkg.status = 'published'; pkg.publishedAt = now(); pkg.publishedVersion = pkg.version;
  pkg.manifest = releaseManifest(store, pkg);
  return pkg;
}

function closureSnapshot(store, routeId) {
  const r = find(store, 'routes', routeId);
  return {
    stops: r.stops, transits: r.transits.filter((t) => !t.retired).map((t) => ({ key: t.key, text: t.text, artifacts: t.artifacts })),
    scripts: store.scripts.filter((s) => r.stops.some((st) => st.exhibitId === s.exhibitId)).map((s) => ({
      id: s.id, lang: s.lang, audience: s.audience, approval: s.approval,
      segments: s.segments.map((g) => ({ code: g.code, audio: g.audio && g.audio.contentHash, subtitle: g.subtitle && g.subtitle.contentHash })),
    })),
    durations: r.durations,
  };
}

function releaseManifest(store, pkg) {
  const r = find(store, 'routes', pkg.routeId);
  return {
    packageId: pkg.id, routeId: r.id, version: pkg.publishedVersion,
    contentHash: pkg.contentHash, releasedAt: pkg.publishedAt,
    units: ['zh', 'en'].flatMap((l) => AUDIENCES.map((a) => ({ lang: l, audience: a, closure: 'sealed' }))),
    media: { audioEncoding: 'opus/48kHz', subtitle: 'webvtt', images: 'webp', offline: true },
    routeVersion: r.version,
  };
}

// 现场设备上报已装版本 -> 明确更新状态
function offlineStatus(pkg, installedVersion) {
  if (!pkg || !pkg.publishedVersion) return { state: 'not_published', installedVersion, currentVersion: null };
  if (!installedVersion) return { state: 'not_installed', installedVersion: null, currentVersion: pkg.publishedVersion };
  const cmp = cmpVersion(installedVersion, pkg.publishedVersion);
  return {
    state: cmp === 0 ? 'up_to_date' : cmp < 0 ? 'update_available' : 'ahead_of_release',
    installedVersion, currentVersion: pkg.publishedVersion, contentHash: pkg.contentHash,
  };
}
function cmpVersion(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; }
  return 0;
}

module.exports = {
  AUDIENCES, LANGS, AUDIENCE_LABEL, LANG_LABEL, HALLS, HALL_GRAPH,
  now, hash, voices, durationMs, expectedAudioHash,
  reviewStatus, computeWordingHash, reconcileScript, completeTask, enqueueTask,
  reviseFact, updateScript, approveScript,
  hallPath, transitTexts, syncRouteTransits, recomputeRouteDuration, recomputeAllRouteDurations,
  updateRoute, withdrawExhibit, reinstateExhibit, validateRoute,
  evaluateClosure, licenseOk, edgeKeyOf,
  startBuild, advanceBuild, interruptBuild, resumeBuild, publishPackage, offlineStatus,
  closureSnapshot, BUILD_STEPS,
};
