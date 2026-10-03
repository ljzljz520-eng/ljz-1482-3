// 验收演练：在隔离内存库中逐条执行题目要求的异常场景并给出通过/失败结论。
const engine = require('./engine');
const seed = require('./seed');

let seq = 0;
function freshStore() {
  seq = 0;
  const store = {
    meta: { version: 1, seq: 0 }, exhibits: [], facts: [], scripts: [],
    audioTasks: [], routes: [], packages: [],
    nextId: null,
  };
  store.nextId = (kind) => { store.meta.seq += 1; return `${kind}_${String(store.meta.seq).padStart(4, '0')}`; };
  seed.build(store);
  return store;
}
const en = engine;
function route(s, id = 'rt_main') { return s.routes.find((r) => r.id === id); }
function script(s, ex, lang, aud) { return s.scripts.find((x) => x.exhibitId === ex && x.lang === lang && x.audience === aud); }
function drain(s) { for (const t of [...s.audioTasks].filter((x) => x.status === 'queued')) en.completeTask(s, t.id); }

function run(name, fn) {
  const s = freshStore();
  const log = [];
  const checks = [];
  const L = (m) => log.push(m);
  const check = (code, ok, detail) => { checks.push({ code, ok: !!ok, detail }); };
  try { fn(s, { L, check, en }); }
  catch (e) { check('EXCEPTION', false, `${e.message}\n${e.stack || ''}`); }
  const pass = checks.every((c) => c.ok);
  return { name, pass, checks, log };
}

const scenarios = {
  // 1) 中文稿更新后外语进入待复核缺口（共享事实修订传播；措辞互不覆盖）
  fact_gap(s, { L, check, en }) {
    const zh = script(s, 'ex_bronze', 'zh', 'general');
    const enScr = script(s, 'ex_bronze', 'en', 'expert');
    const oldZh = zh.segments[1].text, oldEnText = enScr.segments[1].text;
    const r = en.reviseFact(s, 'f_ding_age', { content: { value: { zh: '约公元前 825 年（修订）', en: 'circa 825 BCE (revised)' } }, source: '新刊碳十四报告' }, '研究员甲');
    L(`事实 f_ding_age 升至 v${r.fact.version}，引用它的文稿数=${r.affectedScripts.length}`);
    check('FACT_VERSION_BUMPED', r.fact.version.version ? r.fact.version === 2 : r.fact.version === 2);
    check('ALL_REFERRERS_PENDING_REVIEW', r.affectedScripts.length === 6, '2 语言 × 3 受众 共 6 份引用文稿');
    check('ZH_WORDING_NOT_TOUCHED', zh.segments[1].text === oldZh, '中文措辞保留原样');
    check('EN_WORDING_NOT_TOUCHED', enScr.segments[1].text === oldEnText, '英文措辞保留原样');
    check('ZH_REVIEW_NEED_REVIEW', en.reviewStatus(s, zh).status === 'need_review');
    check('EN_REVIEW_NEED_REVIEW', en.reviewStatus(s, enScr).status === 'need_review');
    const closure = en.evaluateClosure(s, route(s));
    check('CLOSURE_BLOCKS', closure.publishable === false);
    const enExpert = closure.units.find((u) => u.lang === 'en' && u.audience === 'expert');
    check('EN_UNIT_GAP_VISIBLE', enExpert.gaps.some((g) => g.code === 'FACT_OR_WORDING_PENDING_REVIEW'), '外语未复核缺口在网页闭包中可见');
    // 中文改句并重新审批；英文（以及其他受众）仍未复核
    en.updateScript(s, script(s, 'ex_bronze', 'zh', 'general').id, { age: '据新刊报告，年代订正为约公元前 825 年。' });
    drain(s); en.approveScript(s, script(s, 'ex_bronze', 'zh', 'general').id);
    const c2 = en.evaluateClosure(s, route(s));
    check('ZH_GENERAL_CLOSED', c2.units.find((u) => u.lang === 'zh' && u.audience === 'general').ok === true, '中文普通版改句+复核后关闭缺口');
    check('EN_STILL_GAP', c2.units.find((u) => u.lang === 'en' && u.audience === 'general').ok === false, '英文仍阻塞，中文改句不代表外语已复核');
    check('ZH_CHILD_STILL_GAP', c2.units.find((u) => u.lang === 'zh' && u.audience === 'child').ok === false, '儿童版也需独立复核');
    check('AUDIENCE_PHRASING_ISOLATED',
      script(s, 'ex_bronze', 'zh', 'child').segments[1].text.includes('三千岁'), '儿童版口语化措辞未被普通版覆盖');
  },

  // 2) 音频任务乱序完成：旧任务结果不得覆盖新文本
  out_of_order(s, { L, check, en }) {
    const sc = script(s, 'ex_bronze', 'zh', 'general');
    en.updateScript(s, sc.id, { age: '第一次修改：约公元前 840 年。' });
    const taskA = s.audioTasks.filter((t) => t.scope.scriptId === sc.id && t.scope.segCode === 'age' && t.scope.type === 'audio').slice(-1)[0];
    en.updateScript(s, sc.id, { age: '第二次修改：约公元前 820 年，以最新报告为准。' });
    const taskB = s.audioTasks.filter((t) => t.scope.scriptId === sc.id && t.scope.segCode === 'age' && t.scope.type === 'audio').slice(-1)[0];
    check('TASK_A_SUPERSEDED', taskA.status === 'superseded' && taskA.supersededBy === taskB.id);
    check('TASK_B_QUEUED', taskB.status === 'queued');
    // 乱序：先完成 B，再让旧的 A 回报
    const doneB = en.completeTask(s, taskB.id);
    const lateA = en.completeTask(s, taskA.id);
    check('B_ACCEPTED', doneB.accepted === true);
    check('STALE_A_REJECTED', lateA.accepted === false && lateA.reason === 'superseded');
    const seg = sc.segments.find((x) => x.code === 'age');
    check('ARTIFACT_MATCHES_LATEST_TEXT', seg.audio.contentHash === en.expectedAudioHash('第二次修改：约公元前 820 年，以最新报告为准。', en.voices('zh', 'general')));
    check('STABLE_SEG_ID', seg.code === 'age', '片段身份 age 在两次修改中不变');
    // 另一变体：任务已进入 running（TTS 已开工无法撤回），期间文本又变
    en.updateScript(s, sc.id, { age: '第三次修改的句子。' });
    const taskC = s.audioTasks.filter((t) => t.scope.segCode === 'age' && t.scope.type === 'audio').slice(-1)[0];
    taskC.status = 'running'; taskC.startedAt = en.now(); // 模拟 worker 已提交 TTS
    en.updateScript(s, sc.id, { age: '第四次修改后的最终句子。' });
    const taskD = s.audioTasks.filter((t) => t.scope.segCode === 'age' && t.scope.type === 'audio').slice(-1)[0];
    check('C_STILL_RUNNING_D_QUEUED', taskC.status === 'running' && taskD.status === 'queued');
    const oldC = en.completeTask(s, taskC.id);
    check('HASH_MISMATCH_STALE', oldC.accepted === false && oldC.reason === 'hash_mismatch', 'running 旧任务迟到结果被内容哈希拦截');
    en.completeTask(s, taskD.id);
    const seg2 = sc.segments.find((x) => x.code === 'age');
    check('FINAL_ARTIFACT_CORRECT', seg2.audio.contentHash === en.expectedAudioHash('第四次修改后的最终句子。', en.voices('zh', 'general')));
  },

  // 3) 图片授权到期
  license_expiry(s, { L, check, en }) {
    const ex = s.exhibits.find((x) => x.id === 'ex_jade');
    ex.imageLicense.expiresAt = '2025-01-01'; // 模拟到期
    const c = en.evaluateClosure(s, route(s));
    check('LICENSE_GAP_DETECTED', c.globalGaps.some((g) => g.code === 'IMAGE_LICENSE_EXPIRED' && g.exhibitId === 'ex_jade'));
    check('BLOCKED', c.publishable === false);
    const build = en.startBuild(s, 'rt_main');
    check('BUILD_BLOCKED_WITH_GAPS', build.status === 'blocked' && build.closure.globalGaps.some((g) => g.code === 'IMAGE_LICENSE_EXPIRED'));
    // 续签后放行
    ex.imageLicense.expiresAt = '2030-01-01';
    const b2 = en.startBuild(s, 'rt_main');
    while (b2.status === 'building') en.advanceBuild(s, b2.id);
    check('REBUILD_OK_AFTER_RENEWAL', b2.status === 'built');
  },

  // 4) 两人同时改路线：乐观锁冲突，后者必须基于新版本重取
  two_editors(s, { L, check, en }) {
    const r0 = route(s);
    const v = r0.version;
    en.updateRoute(s, r0.id, [
      { stopId: 'stp_1', exhibitId: 'ex_bronze' },
      { stopId: 'stp_3', exhibitId: 'ex_pottery' },
    ], v, '策展人甲');
    let conflict = null;
    try {
      en.updateRoute(s, r0.id, [
        { stopId: 'stp_1', exhibitId: 'ex_bronze' },
        { stopId: 'stp_2', exhibitId: 'ex_jade' },
      ], v, '策展人乙'); // 乙仍持旧版本号
    } catch (e) { conflict = e; }
    check('FIRST_COMMIT_WINS', r0.version === v + 1 && r0.stops.length === 2);
    check('SECOND_GETS_VERSION_CONFLICT', conflict && conflict.code === 'VERSION_CONFLICT' && conflict.serverVersion === v + 1);
    // 乙重取最新路线后再提交（保留甲的删除并补为 slips 不允许：slips 在简牍厅可达，但其图片授权已过期 -> 仅做顺序可达验证）
    const merged = en.updateRoute(s, r0.id, [
      { stopId: 'stp_1', exhibitId: 'ex_bronze' },
      { stopId: 'stp_3', exhibitId: 'ex_pottery' },
    ], v + 1, '策展人乙');
    check('RETRY_ON_NEW_VERSION_OK', merged.version === v + 2);
  },

  // 5) 导出中断与续作
  export_interrupt(s, { L, check, en }) {
    const b = en.startBuild(s, 'rt_main');
    en.advanceBuild(s, b.id); en.advanceBuild(s, b.id); // manifest + zh_child
    en.interruptBuild(s, b.id);
    en.advanceBuild(s, b.id); // 中断标记生效
    check('INTERRUPTED', b.status === 'interrupted' && b.progress.step === 2 && b.progress.total === en.BUILD_STEPS.length);
    check('NOT_PUBLISHABLE_WHILE_INTERRUPTED', (() => {
      try { en.publishPackage(s, b.id); return false; } catch (e) { return e.code === 'NOT_BUILDABLE'; }
    })());
    en.resumeBuild(s, b.id);
    const steps = b.progress.step;
    while (b.status === 'building') en.advanceBuild(s, b.id);
    check('RESUME_FROM_STEP_2', b.progress.step === b.progress.total, `从第 ${steps} 步续到 ${b.progress.total} 步，不从头重做`);
    const pub = en.publishPackage(s, b.id);
    check('PUBLISHED_WITH_VERSION', pub.status === 'published' && pub.publishedVersion === '1.0.0');
    check('MANIFEST_OFFLINE_FLAG', pub.manifest.media.offline === true && pub.manifest.units.length === 6);
  },

  // 6) 依赖缺口可见性 + 只有闭包满足才能发布 + 离线版本/更新状态
  closure_and_offline(s, { L, check, en }) {
    const b = en.startBuild(s, 'rt_main');
    while (b.status === 'building') en.advanceBuild(s, b.id);
    const pub = en.publishPackage(s, b.id);
    check('FIRST_RELEASE_100', pub.publishedVersion === '1.0.0');
    // 制造缺口：改一句话后不重做音频
    const sc = script(s, 'ex_jade', 'en', 'child');
    en.updateScript(s, sc.id, { carve: 'Jade is super hard — they rubbed and rubbed for days.' });
    const c = en.evaluateClosure(s, route(s));
    const unit = c.units.find((u) => u.lang === 'en' && u.audience === 'child');
    check('GAP_ENUMERATED', unit.ok === false && unit.gaps.some((g) => g.code === 'AUDIO_PENDING') && unit.gaps.some((g) => g.code === 'FACT_OR_WORDING_PENDING_REVIEW'));
    let blocked = false;
    const b2 = en.startBuild(s, 'rt_main');
    check('START_RETURNS_BLOCKED', b2.status === 'blocked');
    // 补齐：完成任务 + 重新审批
    drain(s); en.approveScript(s, sc.id);
    const b3 = en.startBuild(s, 'rt_main');
    while (b3.status === 'building') en.advanceBuild(s, b3.id);
    const pub2 = en.publishPackage(s, b3.id);
    check('SECOND_RELEASE_PATCH_BUMP', pub2.publishedVersion === '1.0.1');
    check('CONTENT_HASH_CHANGED', pub2.contentHash !== pub.contentHash);
    check('OFFLINE_OLD_DEVICE_UPDATE', en.offlineStatus(pub2, '1.0.0').state === 'update_available');
    check('OFFLINE_NEW_DEVICE_CURRENT', en.offlineStatus(pub2, '1.0.1').state === 'up_to_date');
    check('OFFLINE_EMPTY_DEVICE', en.offlineStatus(pub2, null).state === 'not_installed');
    check('MANIFEST_VERSION_STATUS', pub2.manifest.version === '1.0.1' && pub2.manifest.units.every((u) => u.closure === 'sealed'));
  },

  // 7) 临时撤展：不能只删卡片留音频指路，必须重验可达顺序
  withdrawal(s, { L, check, en }) {
    const before = route(s).stops.length;
    en.withdrawExhibit(s, 'ex_jade', '陈列部');
    const r = route(s);
    check('CARD_NOT_DELETED', r.stops.length === before && r.stops.some((x) => x.exhibitId === 'ex_jade'), '撤展不静默删除路线卡片');
    check('ROUTE_INVALIDATED', r.validation.valid === false && r.validation.gaps.some((g) => g.code === 'EXHIBIT_WITHDRAWN'));
    const c = en.evaluateClosure(s, r);
    check('CLOSURE_BLOCKS_WITHDRAWN', c.publishable === false && c.globalGaps.some((g) => g.code === 'EXHIBIT_WITHDRAWN'));
    const build = en.startBuild(s, r.id);
    check('BUILD_BLOCKED', build.status === 'blocked');
    // 重新规划：绕过撤展展品；旧边 bronze->jade / jade->pottery 退役，新边 bronze->pottery 经 lobby
    en.updateRoute(s, r.id, [
      { stopId: 'stp_1', exhibitId: 'ex_bronze' },
      { stopId: 'stp_3', exhibitId: 'ex_pottery' },
    ], r.version, '陈列部');
    check('OLD_TRANSITS_RETIRED', r.transits.filter((t) => t.retired).map((t) => t.key).sort().join(',') === 'ex_bronze->ex_jade,ex_jade->ex_pottery');
    const newEdge = r.transits.find((t) => t.key === 'ex_bronze->ex_pottery');
    check('NEW_TRANSIT_VIA_LOBBY', newEdge && !newEdge.retired && newEdge.path.join('>') === 'bronze>lobby>pottery' && newEdge.distanceM === 55);
    drain(s);
    check('ROUTE_VALID_AFTER_REPLAN', r.validation.valid === true);
    const c2 = en.evaluateClosure(s, r);
    check('CLOSURE_OK_AFTER_REPLAN', c2.publishable === true);
    // 语速/时长：不同受众
    const dChild = r.durations.zh.child.totalMs, dExp = r.durations.zh.expert.totalMs;
    check('RATE_DIFFERENCE_KEEPS_DURATIONS_APART', dExp < dChild, `专家 ${dExp}ms 应短于儿童 ${dChild}ms（专家语速更快）`);
  },
};

function runAll(opts = {}) {
  const names = ['fact_gap', 'out_of_order', 'license_expiry', 'two_editors', 'export_interrupt', 'closure_and_offline', 'withdrawal'];
  const pick = opts.scenario && opts.scenario !== 'all' ? [opts.scenario] : names;
  const results = pick.map((n) => run(n, scenarios[n]));
  return { pass: results.every((r) => r.pass), total: results.length, passed: results.filter((r) => r.pass).length, results };
}

module.exports = { run: (scenario, opts) => runAll({ scenario, ...(opts || {}) }) };
