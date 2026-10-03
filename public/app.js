// 博物馆导览制作间 —— 网页编辑器（无框架）
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const A = { child: '儿童', general: '普通', expert: '专家' };
const L = { zh: '中文', en: '英文' };
const GAP_LABEL = {
  FACT_OR_WORDING_PENDING_REVIEW: '事实/措辞待复核',
  AUDIO_PENDING: '音频未就绪', SUBTITLE_PENDING: '字幕未就绪',
  TRANSIT_AUDIO_PENDING: '指路音频未就绪', SCRIPT_MISSING: '文稿缺失',
  IMAGE_LICENSE_EXPIRED: '图片授权到期', EXHIBIT_WITHDRAWN: '展品已撤展',
  UNREACHABLE_ORDER: '路线顺序不可达',
};

let S = null, tab = 'exhibits';
let ui = { exhibitId: 'ex_bronze', lang: 'zh', audience: 'general', routeId: 'rt_main', installed: '1.0.0' };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}
async function refresh() { S = await api('/api/state'); render(); }
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.style.background = bad ? '#7a2a22' : '#22303f';
  t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200);
}
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMs = (ms) => ms == null ? '—' : `${Math.round(ms / 100) / 10}s`;
const exById = (id) => S.exhibits.find((e) => e.id === id);
const scrById = (id) => S.scripts.find((x) => x.id === id);
const reviewPill = (rv) => ({ reviewed: '<span class="pill ok">已复核</span>', need_review: '<span class="pill bad">待复核</span>', draft: '<span class="pill mut">未审批</span>' }[rv.status]);
const artPill = (art) => art && art.status === 'ready' ? `<span class="pill ok">就绪 ${fmtMs(art.durationMs)}</span>`
  : art && (art.status === 'running' || art.status === 'pending') ? `<span class="pill warn">${art.status === 'running' ? '处理中' : '排队'}${art.nextTaskId ? ' · 有更新在排队' : ''}</span>`
  : '<span class="pill mut">无</span>';
const licensePill = (ex) => {
  const ok = ex.imageLicense && new Date(ex.imageLicense.expiresAt).getTime() > Date.now();
  return ok ? `<span class="pill ok">授权至 ${ex.imageLicense.expiresAt}</span>` : `<span class="pill bad">授权到期 ${ex.imageLicense?.expiresAt || ''}</span>`;
};

const TABS = [
  ['exhibits', '展品与事实'], ['scripts', '文稿（儿童/普通/专家）'], ['route', '路线编辑器'],
  ['tasks', '音频处理任务'], ['packages', '闭包与发布'], ['offline', '现场离线包'], ['drills', '验收演练'],
];

function render() {
  $('#nav').innerHTML = TABS.map(([id, name]) => `<button class="${tab === id ? 'on' : ''}" data-tab="${id}">${name}</button>`).join('');
  ({
    exhibits: renderExhibits, scripts: renderScripts, route: renderRoute,
    tasks: renderTasks, packages: renderPackages, offline: renderOffline, drills: renderDrills,
  }[tab])();
  $$('#nav button').forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
}

/* ---------- 展品与事实 ---------- */
function renderExhibits() {
  const app = $('#app');
  app.innerHTML = S.exhibits.map((ex) => {
    const facts = S.facts.filter((f) => {
      // 事实与展品的关联通过文稿 factRefs 体现
      return S.scripts.some((sc) => sc.exhibitId === ex.id && sc.segments.some((g) => (g.factRefs || []).includes(f.id)));
    });
    const withdrawn = ex.status === 'withdrawn';
    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${withdrawn ? '🚫 ' : '🏺 '}${esc(ex.name.zh)} <span class="muted">${esc(ex.name.en)} · ${S.halls[ex.hallId].zh}</span></h2>
        <div class="row">${licensePill(ex)} ${withdrawn ? '<span class="pill bad">临时撤展</span>' : ''}
          <button class="act danger" data-ex="${ex.id}" data-act="withdraw" ${withdrawn ? 'disabled' : ''}>临时撤展</button>
          <button class="act" data-ex="${ex.id}" data-act="reinstate" ${withdrawn ? '' : 'disabled'}>恢复展出</button>
          <button class="act" data-ex="${ex.id}" data-act="expire">模拟授权到期</button>
          <button class="act" data-ex="${ex.id}" data-act="renew">续签授权</button>
        </div>
      </div>
      <p class="muted" style="margin:8px 0">${esc(ex.summary.zh)} / ${esc(ex.summary.en)}</p>
      <h3>关联的共享事实（修订会传播到全部引用文稿，使其进入待复核；不改写任何措辞/语速）</h3>
      <table><thead><tr><th>事实代码</th><th>当前内容</th><th>版本/来源</th><th style="width:230px">修订（保存即 v+1）</th></tr></thead><tbody>
      ${facts.map((f) => `<tr>
        <td><span class="badge">${esc(f.code)}</span><div class="muted">${esc(f.id)}</div></td>
        <td>中：${esc(f.content.value?.zh || '')}<br>英：${esc(f.content.value?.en || '')}</td>
        <td>v${f.version}<div class="muted">${esc(f.source)}</div></td>
        <td><textarea data-fact="${f.id}" rows="2">${esc(f.content.value?.zh || '')}</textarea>
            <button class="act primary" data-factsave="${f.id}">保存事实修订</button></td>
      </tr>`).join('')}
      </tbody></table>
      <div class="legend">修订后：引用该事实的 ${2 * 3} 份文稿（2 语言 × 3 受众）全部显示「待复核」，但儿童版口语、专家版术语与各自语速保持不变。</div>
    </div>`;
  }).join('');

  $$('[data-factsave]', app).forEach((b) => b.onclick = async () => {
    const fid = b.dataset.factsave;
    const f = S.facts.find((x) => x.id === fid);
    const zh = $(`[data-fact="${fid}"]`, app).value.trim();
    await api('/api/facts/revise', { factId: fid, patch: { content: { value: { zh, en: f.content.value.en } } }, actor: 'curator' });
    toast(`事实 ${f.code} 已升版，引用文稿进入待复核（措辞不变）`);
    await refresh();
  });
  $$('[data-ex]', app).forEach((b) => b.onclick = async () => {
    const id = b.dataset.ex, act = b.dataset.act;
    try {
      if (act === 'withdraw') { await api('/api/exhibits/withdraw', { exhibitId: id, actor: '陈列部' }); toast('展品已标记撤展，相关路线待重新验证可达顺序（卡片保留，不会只删卡片）'); }
      if (act === 'reinstate') { await api('/api/exhibits/reinstate', { exhibitId: id }); toast('展品已恢复展出'); }
      if (act === 'expire') { await api('/api/exhibits/license', { exhibitId: id, patch: { expiresAt: '2025-01-01' } }); toast('图片授权已置为到期，闭包将阻止发布'); }
      if (act === 'renew') { await api('/api/exhibits/license', { exhibitId: id, patch: { expiresAt: '2030-12-31' } }); toast('授权已续签至 2030-12-31'); }
      await refresh();
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------- 文稿 ---------- */
function renderScripts() {
  const app = $('#app');
  const exs = S.exhibits;
  app.innerHTML = `
  <div class="card">
    <div class="row">
      <label>展品 <select id="f-ex">${exs.map((e) => `<option value="${e.id}" ${ui.exhibitId === e.id ? 'selected' : ''}>${esc(e.name.zh)}</option>`).join('')}</select></label>
      <label>语言 <select id="f-lang">${Object.entries(L).map(([k, v]) => `<option value="${k}" ${ui.lang === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>受众 <select id="f-aud">${Object.entries(A).map(([k, v]) => `<option value="${k}" ${ui.audience === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <span class="muted">三种受众各自独立措辞与语速；编辑只改选中这一份。</span>
    </div>
  </div>
  <div id="scr-body"></div>`;
  $('#f-ex').onchange = (e) => { ui.exhibitId = e.target.value; render(); };
  $('#f-lang').onchange = (e) => { ui.lang = e.target.value; render(); };
  $('#f-aud').onchange = (e) => { ui.audience = e.target.value; render(); };
  renderScriptBody();
}
function renderScriptBody() {
  const app = $('#scr-body'); if (!app) return;
  const sc = S.scripts.find((x) => x.exhibitId === ui.exhibitId && x.lang === ui.lang && x.audience === ui.audience);
  const v = voiceInfo(sc.lang, sc.audience);
  app.innerHTML = `<div class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">${L[sc.lang]} · ${A[sc.audience]} 文稿 <span class="muted">版本 v${sc.version}</span> ${reviewPill(sc.review)}</h2>
      <div class="row">
        <span class="pill info">音色 ${v.voiceId}</span><span class="pill info">语速 ×${v.rate}</span>
        <button class="act primary" id="btn-save">保存改句（仅受影响片段重做）</button>
        <button class="act" id="btn-approve">复核通过</button>
      </div>
    </div>
    ${sc.review.status === 'need_review' ? `<div class="gap" style="margin-top:10px"><b>待复核原因：</b>${sc.review.reasons.map((r) => esc(r)).join('、')}。旧音频仍可播放但闭包不放行；重新措辞或确认无误后点「复核通过」。</div>` : ''}
    <div style="margin:10px 0">
      ${sc.segments.map((g) => `<div class="seg" data-seg="${g.code}">
        <div class="row" style="justify-content:space-between"><span class="code">稳定片段身份 <b>seg:${sc.id}:${g.code}</b></span>
          <span class="muted">${(g.factRefs || []).map((f) => `<span class="badge">${(S.facts.find((x) => x.id === f) || {}).code || f}</span>`).join(' ') || '无事实引用'}</span></div>
        <textarea data-text="${g.code}" style="margin-top:6px">${esc(g.text)}</textarea>
        <div class="meta">${artPill(g.audio)} ${artPill(g.subtitle)}
          <span class="muted">字幕 hash <span class="badge">${(g.subtitle.contentHash || '—').slice(0, 8)}</span></span>
          <span class="muted">音频 hash <span class="badge">${(g.audio.contentHash || '—').slice(0, 8)}</span></span></div>
      </div>`).join('')}
    </div>
    <div class="legend">改一句话 → 片段 code 不变，仅该片段的音频/字幕任务失效并重排；完成后路线总时长自动重算。切换到其他受众可验证措辞互不覆盖。</div>
  </div>`;
  $('#btn-save').onclick = async () => {
    const edits = {};
    $$('[data-text]', app).forEach((ta) => { const orig = sc.segments.find((x) => x.code === ta.dataset.text).text; if (ta.value !== orig) edits[ta.dataset.text] = ta.value; });
    if (!Object.keys(edits).length) return toast('没有改动');
    const r = await api('/api/scripts/update', { scriptId: sc.id, edits, actor: 'editor' });
    toast(`已保存，受影响片段：${r.changedSegments.join(', ')}；对应音频/字幕任务已排队（其他片段命中缓存）`);
    await refresh();
  };
  $('#btn-approve').onclick = async () => { await api('/api/scripts/approve', { scriptId: sc.id, actor: 'reviewer' }); toast('复核通过：已记录当前措辞与事实版本快照'); await refresh(); };
}
function voiceInfo(lang, aud) {
  const m = {
    zh: { child: ['zh-warm-female', 0.92], general: ['zh-neutral-male', 1.0], expert: ['zh-calm-female', 1.14] },
    en: { child: ['en-warm-female', 0.95], general: ['en-neutral-male', 1.0], expert: ['en-calm-male', 1.12] },
  };
  return { voiceId: m[lang][aud][0], rate: m[lang][aud][1] };
}

/* ---------- 路线编辑器 ---------- */
function renderRoute() {
  const app = $('#app');
  const r = S.routes.find((x) => x.id === ui.routeId);
  const closure = r.closure;
  app.innerHTML = `<div class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">🗺️ ${esc(r.name.zh)} <span class="muted">路线版本 v${r.version}</span></h2>
      <span class="muted">带版本号保存；两人同时编辑时后提交者会收到冲突提示。</span>
    </div>
    <div id="stops" style="margin-top:12px"></div>
    <div class="row" style="margin-top:10px">
      <button class="act primary" id="btn-save-route">保存路线（乐观锁 v${r.version}）</button>
      <button class="act" id="btn-force">我已重取，基于最新版本覆盖保存</button>
    </div>
    <div id="savemsg"></div>
  </div>
  <div class="card">
    <h2>路线验证与时长（每次改动自动重算）</h2>
    <div class="row" style="margin-bottom:8px">
      ${r.validation.valid ? '<span class="pill ok">顺序可达</span>' : '<span class="pill bad">路线无效，需重新规划</span>'}
      ${closure.publishable ? '<span class="pill ok">六单元资料闭包满足</span>' : '<span class="pill bad">存在依赖缺口，不能发布</span>'}
    </div>
    ${r.validation.gaps.length ? r.validation.gaps.map((g) => `<div class="gap"><b>${esc(GAP_LABEL[g.code] || g.code)}</b> ${g.stopId ? `（${esc(g.stopId)}）` : ''}${g.from ? ` ${esc(g.from)} → ${esc(g.to)}` : ''}</div>`).join('') : '<div class="muted">展厅间步行路径均可由馆内拓扑求出。</div>'}
    <h3>各语言 × 受众 总时长（讲解 + 指路）</h3>
    <table><thead><tr><th></th>${['child', 'general', 'expert'].map((a) => `<th>${A[a]}</th>`).join('')}</tr></thead><tbody>
    ${['zh', 'en'].map((lg) => `<tr><td><b>${L[lg]}</b></td>${['child', 'general', 'expert'].map((a) => {
      const d = r.durations[lg][a];
      return `<td>${fmtMs(d.totalMs)} <span class="muted">（讲 ${fmtMs(d.speechMs)} / 路 ${fmtMs(d.transitMs)}）${d.audioReady ? ' ✅' : ' ⏳'}</span></td>`;
    }).join('')}</tr>`).join('')}
    </tbody></table>
  </div>
  <div class="card"><h2>依赖缺口（版本间依赖视图）</h2><div id="gapview"></div></div>`;

  // stops editor
  const body = $('#stops');
  body.innerHTML = r.stops.map((st, i) => stopRow(st, i, r)).join('')
    + `<div class="row" style="margin-top:8px"><select id="new-ex" style="max-width:260px">${S.exhibits.map((e) => `<option value="${e.id}">${esc(e.name.zh)}（${S.halls[e.hallId].zh}）${e.status === 'withdrawn' ? ' — 已撤展' : ''}</option>`).join('')}</select>
        <button class="act" id="add-stop">追加展品</button></div>`;
  function stopRow(st, i, r) {
    const ex = exById(st.exhibitId);
    let trans = '';
    if (i < r.stops.length - 1) {
      const key = `${st.exhibitId}->${r.stops[i + 1].exhibitId}`;
      const tr = r.transits.find((t) => t.key === key);
      trans = tr ? `<div class="transit">🚶 ${esc(tr.text.zh)} <span class="muted">(${tr.path.map((h) => S.halls[h].zh).join(' → ')} · ${tr.distanceM}m)</span></div>` : '<div class="transit">⚠️ 无可达路径</div>';
    }
    return `<div><div class="stop" data-i="${i}">
      <div class="n">${i + 1}</div>
      <select data-stopsel="${i}" style="max-width:340px">${S.exhibits.map((e) => `<option value="${e.id}" ${e.id === st.exhibitId ? 'selected' : ''}>${esc(e.name.zh)}（${S.halls[e.hallId].zh}）${e.status === 'withdrawn' ? ' — 已撤展' : ''}</option>`).join('')}</select>
      ${ex.status === 'withdrawn' ? '<span class="pill bad">已撤展：必须绕过，不能只删卡片</span>' : licensePill(ex)}
      <span style="flex:1"></span>
      <button class="act" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="act" data-down="${i}" ${i === r.stops.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="act danger" data-del="${i}">移除卡片</button>
    </div>${trans}</div>`;
  }
  function collectStops() {
    return $$('[data-stopsel]', body).map((sel, i) => ({ stopId: r.stops[i]?.stopId || `stp_${i}`, exhibitId: sel.value }));
  }
  async function save(force) {
    try {
      await api('/api/routes/update', { routeId: r.id, stops: collectStops(), expectedVersion: force ? undefined : r.version, actor: force ? 'editor(rebased)' : 'editor' });
      $('#savemsg').innerHTML = '<span class="pill ok">已保存，指路音频按稳定边身份增量重做，时长已重算</span>';
      await refresh();
    } catch (e) {
      if (e.status === 409) {
        $('#savemsg').innerHTML = `<div class="gap"><b>版本冲突：</b>另一位编辑已提交（服务器版本 v${e.data.serverVersion}）。你的改动未写入，请点「我已重取，基于最新版本覆盖保存」或刷新后在其版本上合并，避免覆盖对方的路线调整。</div>`;
        toast('路线版本冲突，请先重取', true);
      } else toast(e.message, true);
    }
  }
  $('#btn-save-route').onclick = () => save(false);
  $('#btn-force').onclick = () => save(true);
  $('#add-stop').onclick = async () => { const id = $('#new-ex').value; const tmp = collectStops(); tmp.push({ exhibitId: id }); localStops(tmp); };
  $$('[data-del]', body).forEach((b) => b.onclick = () => { const tmp = collectStops(); tmp.splice(+b.dataset.del, 1); localStops(tmp); });
  $$('[data-up]', body).forEach((b) => b.onclick = () => { const tmp = collectStops(); const i = +b.dataset.up; [tmp[i - 1], tmp[i]] = [tmp[i], tmp[i - 1]]; localStops(tmp); });
  $$('[data-down]', body).forEach((b) => b.onclick = () => { const tmp = collectStops(); const i = +b.dataset.down; [tmp[i + 1], tmp[i]] = [tmp[i], tmp[i + 1]]; localStops(tmp); });
  function localStops(stops) {
    // 仅本地重排展示（不调用 API），用户确认后再保存
    const fake = { ...r, stops: stops.map((s, i) => ({ stopId: s.stopId || `stp_${i}`, exhibitId: s.exhibitId })) };
    body.innerHTML = fake.stops.map((st, i) => stopRow(st, i, fake)).join('')
      + `<div class="row" style="margin-top:8px"><select id="new-ex" style="max-width:260px">${S.exhibits.map((e) => `<option value="${e.id}">${esc(e.name.zh)}</option>`).join('')}</select><button class="act" id="add-stop">追加展品</button></div>`;
    bindLocal(fake);
  }
  function bindLocal(fake) {
    $('#add-stop').onclick = () => { const tmp = collectStops(); tmp.push({ exhibitId: $('#new-ex').value }); localStops(tmp); };
    $$('[data-del]', body).forEach((b) => b.onclick = () => { const tmp = collectStops(); tmp.splice(+b.dataset.del, 1); localStops(tmp); });
    $$('[data-up]', body).forEach((b) => b.onclick = () => { const tmp = collectStops(); const i = +b.dataset.up; [tmp[i - 1], tmp[i]] = [tmp[i], tmp[i - 1]]; localStops(tmp); });
    $$('[data-down]', body).forEach((b) => b.onclick = () => { const tmp = collectStops(); const i = +b.dataset.down; [tmp[i + 1], tmp[i]] = [tmp[i], tmp[i + 1]]; localStops(tmp); });
  }
  renderGapView($('#gapview'), closure, r);
}

function renderGapView(el, closure, r) {
  const globals = closure.globalGaps.map((g) => `<div class="gap"><b>${esc(GAP_LABEL[g.code] || g.code)}</b>：${esc(g.detail || '')} ${g.stopId ? `<span class="badge">${esc(g.stopId)}</span>` : ''}</div>`).join('')
    + closure.routeIssues.map((g) => `<div class="gap"><b>${esc(GAP_LABEL[g.code] || g.code)}</b>：路线顺序问题</div>`).join('');
  const units = closure.units.map((u) => `<div class="unitbox ${u.ok ? 'ok' : 'bad'}">
      <div class="row" style="justify-content:space-between"><b>${L[u.lang]} · ${A[u.audience]}</b>
      ${u.ok ? '<span class="pill ok">闭包满足</span>' : `<span class="pill bad">${u.gaps.length} 项缺口</span>`}</div>
      ${u.gaps.map((g) => `<div class="gap" style="background:#fff"><b>${esc(GAP_LABEL[g.code] || g.code)}</b>
        ${g.scriptId ? `文稿 <span class="badge">${esc(g.scriptId)}</span>` : ''}${g.segment ? `片段 <span class="badge">${esc(g.segment)}</span>` : ''}
        ${g.reasons ? `<div class="muted">${g.reasons.map(esc).join('、')}</div>` : ''}</div>`).join('')}
    </div>`).join('');
  el.innerHTML = `<div class="grid3">${units}</div>${globals ? '<h3>全局阻断</h3>' + globals : '<div class="muted" style="margin-top:8px">无全局阻断项。</div>'}`;
}

/* ---------- 任务队列 ---------- */
function renderTasks() {
  const app = $('#app');
  const counts = ['queued', 'running', 'done', 'superseded', 'stale'].map((k) => `${k}:${S.audioTasks.filter((t) => t.status === k).length}`);
  app.innerHTML = `<div class="card">
    <h2>🎧 音频处理任务（后端流水线） <button class="act" id="toggle-worker">${S.workerOn ? '暂停 worker' : '恢复 worker'}</button></h2>
    <div class="muted">${counts.join(' · ')} ｜ 同一稳定片段身份的任务形成取代链：排队中的旧任务被 superseded；已 running 的旧任务迟到时按内容哈希判 stale，绝不覆盖新文本。</div>
    <table style="margin-top:10px"><thead><tr><th>任务</th><th>片段/路线边</th><th>类型</th><th>文本哈希</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${S.audioTasks.slice().reverse().slice(0, 80).map((t) => {
      const scope = t.kind === 'script'
        ? `<span class="badge">seg:${t.scope.scriptId}:${t.scope.segCode}</span>`
        : `<span class="badge">${t.scope.routeId} ${t.scope.edgeKey}</span> ${L[t.scope.lang]}/${A[t.scope.audience]}`;
      return `<tr>
        <td>${esc(t.id)}<div class="muted">${t.createdAt.slice(11, 19)}${t.supersededBy ? `<br>→ ${esc(t.supersededBy)}` : ''}</div></td>
        <td>${scope}</td><td>${t.kind === 'script' ? t.scope.type : '指路音频'}</td>
        <td><span class="badge">${t.payload.textHash.slice(0, 8)}</span></td>
        <td>${statusPill(t.status)}</td>
        <td>${(t.status === 'queued' || t.status === 'running') ? `<button class="act" data-complete="${t.id}">模拟完成回报</button>` : ''}</td>
      </tr>`;
    }).join('')}
    </tbody></table>
    <div class="legend">手动「模拟完成回报」可制造乱序：先让任务 running 后再改文本，然后先完成新任务、再回报旧任务，观察旧任务被拒绝。</div>
  </div>`;
  $('#toggle-worker').onclick = async () => { await api('/api/worker', { on: !S.workerOn }); await refresh(); };
  $$('[data-complete]', app).forEach((b) => b.onclick = async () => {
    const r = await api(`/api/tasks/${b.dataset.complete}/complete`, {});
    toast(r.accepted ? '任务结果已写入对应片段' : `任务回报被拒绝（${r.reason}），未覆盖产物`, !r.accepted);
    await refresh();
  });
}
function statusPill(s) {
  return ({ queued: '<span class="pill info">排队</span>', running: '<span class="pill warn">处理中</span>', done: '<span class="pill ok">完成</span>', superseded: '<span class="pill mut">已取代</span>', stale: '<span class="pill bad">哈希失配/作废</span>' }[s]) || s;
}

/* ---------- 闭包与发布 ---------- */
function renderPackages() {
  const app = $('#app');
  const r = S.routes.find((x) => x.id === ui.routeId);
  const c = r.closure;
  app.innerHTML = `<div class="card">
    <h2>📦 导览包构建（只有资料闭包满足的包可发布）</h2>
    <div class="row">${c.publishable ? '<span class="pill ok">闭包满足，可开始构建</span>' : '<span class="pill bad">闭包不满足：开始构建会直接返回 blocked 与缺口清单</span>'}
      <button class="act primary" id="start-build">开始构建离线包</button></div>
    <div id="gapview2" style="margin-top:12px"></div>
  </div>
  <div class="card"><h2>构建记录</h2><div id="pkgs"></div></div>`;
  renderGapView($('#gapview2'), c, r);
  $('#start-build').onclick = async () => {
    const p = await api('/api/packages/start', { routeId: r.id });
    if (p.status === 'blocked') toast('构建被阻止：存在依赖缺口（见清单）', true);
    else toast(`构建已开始 v${p.version}`);
    await refresh();
  };
  const el = $('#pkgs');
  el.innerHTML = S.packages.length ? `<table><thead><tr><th>包</th><th>版本</th><th>状态/进度</th><th>操作</th></tr></thead><tbody>
    ${S.packages.slice().reverse().map((p) => `<tr>
      <td>${esc(p.id)}</td>
      <td>${p.version || '—'}</td>
      <td>${pkgStatus(p)}</td>
      <td class="row">
        ${p.status === 'building' ? `<button class="act danger" data-int="${p.id}">模拟导出中断</button>` : ''}
        ${p.status === 'interrupted' ? `<button class="act primary" data-res="${p.id}">续作（从断点继续）</button>` : ''}
        ${p.status === 'built' ? `<button class="act primary" data-pub="${p.id}">发布</button>` : ''}
        ${p.status === 'published' ? `<span class="muted">content <span class="badge">${(p.contentHash || '').slice(0, 8)}</span></span>` : ''}
        ${p.status === 'blocked' ? '<span class="muted">补齐缺口后重新构建</span>' : ''}
      </td></tr>`).join('')}
  </tbody></table>` : '<div class="muted">暂无构建记录。</div>';
  $$('[data-int]', el).forEach((b) => b.onclick = async () => { await api(`/api/packages/${b.dataset.int}/interrupt`, {}); toast('已请求中断：当前步结束后暂停，不允许发布'); await refresh(); });
  $$('[data-res]', el).forEach((b) => b.onclick = async () => { await api(`/api/packages/${b.dataset.res}/resume`, {}); toast('已从断点续作'); await refresh(); });
  $$('[data-pub]', el).forEach((b) => b.onclick = async () => {
    try { await api(`/api/packages/${b.dataset.pub}/publish`, {}); toast('已发布，现场设备将看到更新状态'); await refresh(); }
    catch (e) { toast('发布被拒：' + (e.data.error || e.message), true); }
  });
}
function pkgStatus(p) {
  if (p.status === 'building' || p.status === 'interrupted') {
    const pc = p.progress.step / p.progress.total * 100;
    return `${p.status === 'interrupted' ? '⏸ 已中断 @' : '构建中'} 步骤 ${p.progress.step}/${p.progress.total}
      <div class="progress" style="width:160px;margin-top:3px"><i style="width:${pc}%"></i></div>
      <div class="muted">${p.progress.steps.slice(0, p.progress.step).join(' → ')}</div>`;
  }
  const m = { blocked: '<span class="pill bad">blocked（闭包缺口）</span>', built: '<span class="pill warn">待发布</span>', published: '<span class="pill ok">已发布</span>' };
  return m[p.status] || p.status;
}

/* ---------- 现场离线包 ---------- */
function renderOffline() {
  const app = $('#app');
  const published = S.packages.filter((p) => p.status === 'published').slice().reverse();
  app.innerHTML = `<div class="card">
    <h2>📡 现场设备更新状态</h2>
    <div class="row">设备已装版本：
      <input id="inst" value="${esc(ui.installed)}" style="max-width:140px" placeholder="如 1.0.0，留空=未安装">
      <button class="act" id="check">查询更新状态</button></div>
    <div id="ost" style="margin-top:12px"></div>
  </div>
  <div class="card"><h2>已发布离线包（含明确版本与更新清单）</h2>
    ${published.map((p) => `<div class="seg">
      <div class="row" style="justify-content:space-between"><b>版本 ${p.publishedVersion}</b>
      <span class="pill ok">${p.manifest.routeId} · 路线 v${p.manifest.routeVersion}</span></div>
      <pre style="white-space:pre-wrap;background:#f7f8fa;border-radius:7px;padding:10px;font-size:12px">${esc(JSON.stringify(p.manifest, null, 2))}</pre>
    </div>`).join('') || '<div class="muted">还没有发布任何版本。</div>'}
    <div class="legend">离线包三层标识：包版本（1.0.x）＋内容哈希（任一讲解/指路音频或顺序变化）＋六单元闭包标记 sealed。设备对照得到「已是最新 / 有更新 / 未安装」。</div>
  </div>`;
  const doCheck = async () => {
    ui.installed = $('#inst').value.trim();
    const q = await api(`/api/offline-status?routeId=rt_main&installed=${encodeURIComponent(ui.installed)}`);
    const map = { up_to_date: ['ok', '✅ 已是最新'], update_available: ['warn', '⬆️ 有可用更新'], not_installed: ['info', '设备尚未安装'], ahead_of_release: ['bad', '设备版本新于发布（异常）'], not_published: ['mut', '尚无发布版本'] };
    const [cls, txt] = map[q.state];
    $('#ost').innerHTML = `<span class="pill ${cls}">${txt}</span> <span class="kv" style="margin-left:8px">设备：<b>${esc(q.installedVersion || '无')}</b> ｜ 当前发布：<b>${esc(q.currentVersion || '无')}</b> ｜ 内容哈希：<b>${esc(q.contentHash || '—')}</b></span>`;
  };
  $('#check').onclick = doCheck; doCheck();
}

/* ---------- 验收演练 ---------- */
function renderDrills() {
  const app = $('#app');
  app.innerHTML = `<div class="card drill">
    <h2>🧪 验收演练（隔离内存库，不影响当前编辑数据）</h2>
    <div class="row">
      <button class="act primary" id="run-all">运行全部 7 个场景</button>
      ${['fact_gap', 'out_of_order', 'license_expiry', 'two_editors', 'export_interrupt', 'closure_and_offline', 'withdrawal'].map((s) => `<button class="act" data-run="${s}">${{
        fact_gap: '中文更新外语未复核', out_of_order: '任务乱序完成', license_expiry: '图片授权到期',
        two_editors: '两人改路线', export_interrupt: '导出中断', closure_and_offline: '闭包/离线版本', withdrawal: '临时撤展',
      }[s]}</button>`).join('')}
    </div>
    <div id="drill-out" style="margin-top:14px"></div>
  </div>`;
  const run = async (scenario) => {
    $('#drill-out').innerHTML = '<div class="muted">运行中…</div>';
    const r = await api('/api/drills/run', { scenario });
    $('#drill-out').innerHTML = `<div style="margin-bottom:10px">合计 <b>${r.total}</b>，通过 <b style="color:var(--ok)">${r.passed}</b> ${r.pass ? '<span class="pill ok">全部通过</span>' : '<span class="pill bad">存在失败</span>'}</div>`
      + r.results.map((x) => `<div class="seg">
        <h3>${x.pass ? '✅' : '❌'} ${esc(x.name)}</h3>
        ${x.checks.map((c) => `<div style="margin:3px 0">${c.ok ? '✓' : '✗'} <code>${esc(c.code)}</code> ${c.detail ? `<span class="muted">— ${esc(c.detail)}</span>` : ''}</div>`).join('')}
      </div>`).join('');
  };
  $('#run-all').onclick = () => run('all');
  $$('[data-run]', app).forEach((b) => b.onclick = () => run(b.dataset.run));
}

$('#btn-reset').onclick = async () => {
  if (!confirm('重置为初始演示数据？当前修改将丢失。')) return;
  await api('/api/reset', {});
  toast('已重置：3 展品、9 事实、18 份文稿、156 个初始音频/字幕片段任务全部就绪，示范路线闭包满足');
  await refresh();
};

refresh();
setInterval(() => { if (!document.hidden && ['tasks', 'packages', 'scripts', 'route'].includes(tab)) refresh(); }, 1800);
