// 博物馆导览制作间 —— 前端逻辑
const app = document.getElementById('app');
const toastBox = document.getElementById('toast');
const LANGNAME = {zh:'中文', en:'英文', ja:'日文'};
const AUDNAME = {child:'儿童', normal:'普通', expert:'专家'};
const today = '2026-10-03';

async function api(path, body) {
  const opt = { headers: {'Content-Type':'application/json'} };
  if (body !== undefined) { opt.method='POST'; opt.body=JSON.stringify(body); }
  const r = await fetch(path, opt);
  const data = await r.json();
  if (!r.ok) {
    toast((data.error||r.status)+(data.conflict?' ⚠️ 冲突':' ❌'), true);
    throw Object.assign(new Error(data.error), {data, status:r.status});
  }
  return data;
}
function toast(msg, isErr) {
  const d = document.createElement('div');
  d.className = isErr ? 'err' : '';
  d.textContent = msg;
  toastBox.appendChild(d);
  setTimeout(()=>d.remove(), 5600);
}
function esc(s){ return String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function pill(s){ return `<span class="pill ${esc(s)}">${esc(s)}</span>`; }

let state = { tab:'exhibits', exhibits:[], manuscripts:[], msId:null, pkgId:null,
              routeId:null, editor:'策展人甲' };

document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); state.tab=b.dataset.tab; render();
});
async function loadExhibits(){ state.exhibits = (await api('/api/exhibits')).exhibits; }
async function loadManuscripts(){ state.manuscripts = (await api('/api/manuscripts')).manuscripts; }

// ---------- Tab 1: 展品与共享事实 ----------
async function tabExhibits(){
  await loadExhibits(); await loadManuscripts();
  app.innerHTML = state.exhibits.map(ex=>{
    const licWarn = ex.image_license_expires && ex.image_license_expires < today;
    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>${esc(ex.code)} · ${esc(ex.name)} <span class="muted">[${esc(ex.hall)}]</span></h2>
        <div>${ex.withdrawn ? pill('invalid 已撤展') : pill('valid 在展')}
          <button class="ghost act" onclick="toggleWithdraw('${ex.id}', ${ex.withdrawn?0:1})">
            ${ex.withdrawn?'恢复上架':'临时撤展'}</button>
        </div>
      </div>
      <div class="muted">图片授权至：${esc(ex.image_license_expires||'永久/无图')}
        ${licWarn?'<span class="gap"> ⚠ 授权已到期（发布门禁阻断）</span>':''}</div>
      <div id="facts-${ex.id}"></div>
    </div>`;
  }).join('');
  for (const ex of state.exhibits) await renderFacts(ex.id);
}
async function renderFacts(exhibitId){
  const ms = state.manuscripts.find(m=>m.exhibit_id===exhibitId && m.lang==='zh');
  const box = document.getElementById('facts-'+exhibitId);
  if (!ms) { box.innerHTML = '<div class="muted">暂无文稿引用事实</div>'; return; }
  const d = await api(`/api/manuscripts/${ms.id}`);
  const rows = d.facts.map(f=>`
    <tr><td><b>${esc(f.topic)}</b><div class="muted">v${f.version}</div></td>
    <td>${esc(f.body)}</td>
    <td><button class="act" onclick="reviseFact('${f.id}','${esc(f.body)}')">修订事实</button></td>
    </tr>`).join('');
  box.innerHTML = `<h3>共享事实（修订后引用文稿全部进入“待复核”，措辞/语速不被覆盖）</h3>
    <table><thead><tr><th>事实</th><th>当前陈述</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
window.toggleWithdraw = async (id, w) => {
  await api(`/api/exhibits/${id}/withdraw`, {withdrawn:!!w});
  toast(w?'已标记临时撤展：相关路线将需重验可达顺序':'已恢复上架');
  render();
};
window.reviseFact = async (factId, oldBody) => {
  const body = prompt('修订共享事实（新陈述）：', oldBody);
  if (!body || body===oldBody) return;
  const d = await api(`/api/facts/${factId}/revise`, {body, editor:state.editor});
  if (d.changed){
    toast(`事实升至 v${d.new_version}，${d.affected_manuscripts.length} 篇各语/各受众文稿进入待复核（正文未改动）`);
    render();
  } else toast('内容无变化');
};

// ---------- Tab 2: 三语文稿 ----------
async function tabManuscripts(){
  await loadExhibits(); await loadManuscripts();
  if (!state.msId) state.msId = state.manuscripts[0]?.id;
  const exName = id => state.exhibits.find(e=>e.id===id)?.code || id;
  const list = state.manuscripts.map(m=>`
    <tr style="cursor:pointer; background:${m.id===state.msId?'#f3ead9':'transparent'}"
        onclick="pickMs('${m.id}')">
      <td>${esc(exName(m.exhibit_id))}</td><td>${LANGNAME[m.lang]}</td>
      <td>${AUDNAME[m.audience]}</td><td>${pill(m.status)}</td><td>${m.rate_wpm} wpm</td>
    </tr>`).join('');
  app.innerHTML = `<div class="grid2">
    <div class="card"><h2>文稿矩阵（展品 × 语言 × 受众）</h2>
      <table><thead><tr><th>展品</th><th>语言</th><th>受众</th><th>状态</th><th>语速</th></tr></thead>
      <tbody>${list}</tbody></table>
      <p class="muted">事实修订只级联状态；中文稿更新后，英文/日文需各自独立复核，措辞与语速不被覆盖。</p>
    </div>
    <div class="card" id="ms-detail"><h2>文稿详情</h2><div class="muted">点击左侧行</div></div>
  </div>`;
  if (state.msId) renderMsDetail();
}
window.pickMs = id => { state.msId=id; renderMsDetail(); };
async function renderMsDetail(){
  const d = await api(`/api/manuscripts/${state.msId}`);
  const factRows = d.facts.map(f=>`<li>${esc(f.topic)}（事实 v${f.version}）</li>`).join('');
  const segs = d.segments.map(s=>`
    <div class="seg">
      <div class="sid">${esc(s.id)}<br>hash ${esc(s.content_hash.slice(0,8))}</div>
      <textarea rows="2" id="seg-${s.seq}">${esc(s.text)}</textarea>
      <button class="ghost act" onclick="saveSentence('${d.id}',${s.seq})">保存这句</button>
    </div>`).join('');
  document.getElementById('ms-detail').innerHTML = `<h2>${LANGNAME[d.lang]} · ${AUDNAME[d.audience]}
      ${pill(d.status)} <span class="muted">语速</span>
      <input id="rate" type="number" value="${d.rate_wpm}" style="width:80px">
      <button class="ghost act" onclick="saveRate('${d.id}')">改语速</button>
      <button class="act" onclick="approveMs('${d.id}')">复核通过</button></h2>
    <h3>引用的共享事实</h3><ul>${factRows}</ul>
    <h3>稳定片段身份（改一句 → 仅该句哈希变化 → 只重做该句音频/字幕/脚本）</h3>${segs}
    <div class="row" style="margin-top:10px">
      <button class="act" onclick="enqueueRender('${d.id}','segment')">入队：分段渲染</button>
      <button class="ghost act" onclick="enqueueRender('${d.id}','whole')">入队：整段渲染</button>
      <button class="ghost act" onclick="compare('${d.id}')">对比整段 vs 分段</button>
    </div><pre id="cmp" hidden></pre>`;
}
window.saveSentence = async (id, seq) => {
  const text = document.getElementById('seg-'+seq).value;
  const d = await api(`/api/manuscripts/${id}/sentence`, {seq, text});
  toast(d.changed?`片段 ${d.seq} 哈希更新，仅该句重做；文稿转待复核`:'该句无变化');
};
window.saveRate = async id => {
  await api(`/api/manuscripts/${id}/rate`, {rate_wpm:+document.getElementById('rate').value});
  toast('语速已独立修改（不会被事实修订覆盖）');
};
window.approveMs = async id => {
  await api(`/api/manuscripts/${id}/approve`, {reviewer:state.editor});
  toast('该语言文稿已独立复核通过'); render();
};
window.enqueueRender = async (id, mode) => {
  const d = await api(`/api/manuscripts/${id}/render`, {mode});
  toast(`已入队 ${d.tasks.length} 个${mode==='segment'?'片段':'整段'}任务（幂等去重）`);
};
window.compare = async id => {
  const d = await api(`/api/manuscripts/${id}/id/compare`.replace('/id/','/'));
  document.getElementById('cmp').hidden=false;
  document.getElementById('cmp').textContent =
    JSON.stringify({分段:d.segment, 整段:d.whole, 取舍:d.tradeoff}, null, 2);
};

// ---------- Tab 3: 音频任务 ----------
async function tabAudio(){
  const t = await api('/api/tasks');
  const rows = t.tasks.map(x=>`<tr>
    <td>${esc(x.id.slice(-6))}</td><td>${esc(x.manuscript_id.slice(-6))}</td>
    <td>${x.mode==='segment'?`分段 #${x.seq}`:'整段'}</td><td>${esc(x.voice)}</td>
    <td>${pill(x.status)}</td><td class="muted">${esc(x.error||'')}</td></tr>`).join('');
  app.innerHTML = `<div class="card"><h2>后端音频处理任务</h2>
    <div class="row">
      <button class="act" onclick="runQueue(false)">按序执行队列</button>
      <button class="ghost act" onclick="runQueue(true)">模拟任务乱序完成</button>
      <span class="muted">乱序/迟到结果安全：旧哈希任务自动 superseded，幂等键去重</span>
    </div>
    <table><thead><tr><th>任务</th><th>文稿</th><th>类型</th><th>音色</th><th>状态</th><th>错误</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
window.runQueue = async shuffle => {
  const d = await api('/api/tasks/run', {shuffle});
  toast(`完成 ${d.ran} 个任务${d.out_of_order?'（乱序执行，结果仍一致）':''}`);
  render();
};


// ---------- Tab 4: 路线 ----------
async function tabRoutes(){
  await loadExhibits();
  const ids = state.exhibits.map(e=>e.id);
  app.innerHTML = `<div class="card">
    <h2>路线工作台</h2>
    <div class="row">
      <input id="rname" value="镇馆之宝精华线" style="width:200px">
      <select id="rlang"><option value="zh">中文</option><option value="en">英文</option>
      <option value="ja">日文</option></select>
      <label>编辑者 <input id="reditor" value="${esc(state.editor)}" style="width:110px"></label>
      <button class="act" onclick="createRoute('${ids.join(',')}')">新建：当前全部展品</button>
    </div>
    <p class="muted">稳定卡片身份 route_card:…#序号；撤展后不能只删卡片，必须重排可达顺序。
      两人同时改：先各点“开始编辑”，先提交成功，后提交收到 409 冲突。</p>
    <div id="route-box" class="muted">尚未在本会话选择路线。</div>
  </div>
  <div class="card">
    <h2>并发演练（两人改路线）</h2>
    <div class="row">
      <button class="ghost act" onclick="demoConflict()">演练：甲先改并提交 → 乙用旧基线提交被拒(409)</button>
      <button class="ghost act" onclick="demoWithdraw()">演练：撤展 E002 → 路线重验失败 → 重排恢复</button>
    </div>
    <pre id="demo-out" hidden></pre>
  </div>`;
}
function cardsPayload(route){
  return route.cards.map(c=>({exhibit_id:c.exhibit_id, dwell:c.dwell,
                              transition_text:c.transition_text||''}));
}
window.createRoute = async (csvIds) => {
  const ids = csvIds.split(',');
  state.editor = document.getElementById('reditor').value || '策展人甲';
  const d = await api('/api/routes', {name:document.getElementById('rname').value,
    lang:document.getElementById('rlang').value, exhibit_ids:ids, editor:state.editor});
  state.routeId = d.route.id;
  toast('路线已创建并完成首次可达性验证');
  showRoute(d.route);
};
window.beginEdit = async () => {
  state.editor = document.getElementById('reditor').value || '策展人甲';
  const d = await api(`/api/routes/${state.routeId}/edit`, {editor:state.editor});
  toast(`${state.editor} 已取得基线版本 v${d.base_version}`);
  const r = await api(`/api/routes/${state.routeId}`);
  showRoute(r, d.base_version);
};
window.submitRoute = async () => {
  const base = +document.getElementById('basever').value;
  const cards = [...document.querySelectorAll('#cards tr')].map(tr=>({
    exhibit_id: tr.dataset.exhibit, dwell: +tr.querySelector('.dwell').value,
    transition_text: tr.querySelector('.trans').value }));
  try {
    const d = await api(`/api/routes/${state.routeId}/update`,
      {editor:state.editor, base_version:base, cards});
    toast(`提交成功 → v${d.route.version}，总时长 ${d.route.duration}s，可达性：${d.validation_msg}`);
    showRoute(d.route);
  } catch(e) { /* 409 toast 已弹出 */ }
};
window.revalidate = async () => {
  const d = await api(`/api/routes/${state.routeId}/validate`, {});
  toast('可达顺序重新验证：'+d.validation_msg);
  showRoute(d.route);
};
window.recompute = async () => {
  const d = await api(`/api/routes/${state.routeId}/recompute`, {});
  toast(`路线时长已重算：${d.duration}s${d.estimated?'（含未渲染片段的预计值）':''}`);
};
function showRoute(route, baseVersion){
  const exById = Object.fromEntries(state.exhibits.map(e=>[e.id,e]));
  const rows = route.cards.map((c,i)=>{
    const ex = exById[c.exhibit_id] || {code:'?', name:'缺失', withdrawn:1};
    const bad = ex.withdrawn;
    return `<tr data-exhibit="${esc(c.exhibit_id)}" style="${bad?'background:#fbe9e7':''}">
      <td>#${c.seq} <div class="sid muted">${esc(c.id)} v${c.version}</div></td>
      <td>${esc(ex.code)} ${esc(ex.name)} ${bad?'<span class="gap">已撤展</span>':''}</td>
      <td><input class="dwell" type="number" value="${c.dwell}" style="width:70px"> 秒驻留</td>
      <td><input class="trans" value="${esc(c.transition_text||'')}" placeholder="前往下一站的指路词"
           style="width:320px"></td>
      <td><button class="ghost act" onclick="moveCard(${i},-1)">↑</button>
          <button class="ghost act" onclick="moveCard(${i},1)">↓</button>
          <button class="ghost act" onclick="dropCard(${i})">移除卡</button></td>
    </tr>`;
  }).join('');
  const exOpts = state.exhibits.filter(e=>!e.withdrawn).map(e=>
    `<option value="${e.id}">${e.code} ${e.name}</option>`).join('');
  document.getElementById('route-box').innerHTML = `
    <h3>${esc(route.name)} · ${LANGNAME[route.lang]}
      当前 v${route.version} · ${route.valid?pill('valid 可达'):pill('invalid 待重排')}
      <span class="muted">${esc(route.validation_msg||'')}</span></h3>
    <div class="muted">路线总时长：<b>${route.duration}</b> 秒（Σ解说音频+驻留+转场；改一句话并重渲染后自动重算）</div>
    <table id="cards"><thead><tr><th>稳定卡片身份</th><th>展品</th><th>驻留</th><th>转场指路（稳定片段）</th><th>重排</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="row" style="margin-top:8px">
      追加展品：<select id="addex">${exOpts}</select>
      <button class="ghost act" onclick="addCard()">追加卡</button>
      提交基线：<input id="basever" type="number" value="${baseVersion??route.version}" style="width:70px">
      <button class="ghost act" onclick="beginEdit()">开始编辑(取基线)</button>
      <button class="act" onclick="submitRoute()">提交路线</button>
      <button class="ghost act" onclick="revalidate()">重新验证可达顺序</button>
      <button class="ghost act" onclick="recompute()">重算时长</button>
    </div>
    <div id="problems"></div>`;
  const pr = window._lastValidation?.problems || [];
  if (pr.length) document.getElementById('problems').innerHTML =
    '<h3>验证问题</h3>'+pr.map(p=>`<div class="gap">#${p.seq} ${esc(p.exhibit)}：${esc(p.issue)}</div>`).join('');
  window._routeCache = route;
}
window.moveCard = (i,dir)=>{
  const r = window._routeCache; const cards=cardsPayload(r);
  const j=i+dir; if(j<0||j>=cards.length) return;
  [cards[i],cards[j]]=[cards[j],cards[i]];
  patchSubmit(cards);
};
window.dropCard = i => patchSubmit(cardsPayload(window._routeCache).filter((_,k)=>k!==i));
window.addCard = () => {
  const cards = cardsPayload(window._routeCache);
  cards.push({exhibit_id:document.getElementById('addex').value, dwell:10, transition_text:''});
  patchSubmit(cards);
};
async function patchSubmit(cards){
  try {
    const d = await api(`/api/routes/${state.routeId}/update`,
      {editor:state.editor||document.getElementById('reditor').value,
       base_version:window._routeCache.version, cards});
    window._lastValidation = {problems:d.problems};
    showRoute(d.route);
  } catch(e){ /* 冲突提示已显示 */ }
}

async function demoConflict(){
  const out = document.getElementById('demo-out'); out.hidden=false; out.textContent='演练中…';
  const log=[];
  await loadExhibits();
  const ids = state.exhibits.map(e=>e.id);
  let r = await api('/api/routes', {name:'并发演练线', lang:'zh', exhibit_ids:ids, editor:'策展人甲'});
  const rid = r.route.id;
  const base = r.route.version;
  const cards = cardsPayload(r.route);
  // 甲先改
  r = await api(`/api/routes/${rid}/update`, {editor:'策展人甲', base_version:base, cards});
  log.push(`甲基于 v${base} 提交成功 -> v${r.route.version}`);
  // 乙仍用旧基线
  let conflict=null;
  try {
    await api(`/api/routes/${rid}/update`, {editor:'策展人乙', base_version:base, cards});
  } catch(e){ conflict=e; }
  log.push(conflict ? `乙仍基于 v${base} 提交 -> 409：${conflict.data.error}` : '异常：未冲突');
  // 乙拉取最新再提交
  r = await api(`/api/routes/${rid}`);
  const rr = await api(`/api/routes/${rid}/update`, {editor:'策展人乙',
    base_version:r.version, cards:cardsPayload(r)});
  log.push(`乙拉取 v${r.version} 合并后提交成功 -> v${rr.route.version}`);
  out.textContent = log.join('\n');
  state.routeId=rid;
}
async function demoWithdraw(){
  const out=document.getElementById('demo-out'); out.hidden=false; out.textContent='撤展演练中…';
  const log=[];
  await loadExhibits();
  const e2 = state.exhibits.find(e=>e.code==='E002');
  const ids = state.exhibits.map(e=>e.id);
  let r = await api('/api/routes',{name:'撤展演练线',lang:'zh',exhibit_ids:ids,editor:'策展人甲'});
  const rid=r.route.id;
  log.push(`建线 v${r.route.version}，${r.route.cards.length} 张卡，valid=${r.route.valid}`);
  await api(`/api/exhibits/${e2.id}/withdraw`,{withdrawn:true});
  r = await api(`/api/routes/${rid}/validate`,{});
  log.push(`E002 临时撤展后重验：valid=${r.valid} — ${r.validation_msg}`);
  r.problems.forEach(p=>log.push(`  · #${p.seq} ${p.exhibit}: ${p.issue}`));
  const kept = r.route.cards.filter(c=>{
    const ex=state.exhibits.find(x=>x.id===c.exhibit_id); return ex && ex.code!=='E002';
  }).map(c=>({exhibit_id:c.exhibit_id,dwell:c.dwell,transition_text:c.transition_text}));
  r = await api(`/api/routes/${rid}/update`,{editor:'策展人甲',
    base_version:r.route.version,cards:kept});
  log.push(`重排（移除撤展卡而非留空指路）后提交：valid=${r.valid} — ${r.validation_msg}`);
  await api(`/api/exhibits/${e2.id}/withdraw`,{withdrawn:false});
  log.push('（演练结束已恢复 E002 在展）');
  out.textContent=log.join('\n');
  state.routeId=rid;
}


// ---------- Tab 5: 导览包与发布 ----------
async function tabPackages(){
  await loadExhibits();
  const pkgs = (await api('/api/packages')).packages;
  const routesHint = state.routeId ? `当前路线 ${state.routeId.slice(-6)}` : '请先在“路线”页新建路线';
  const rows = pkgs.map(p=>`<tr>
    <td>${esc(p.semver)}</td><td>${LANGNAME[p.lang]}</td><td>${pill(p.status)}</td>
    <td class="muted">${esc((p.published_at||'').toString().slice(0,19))}</td>
    <td><button class="ghost act" onclick="showReport('${p.id}')">闭包报告/依赖缺口</button>
        <button class="act" ${p.status!=='ready'?'disabled':''} onclick="publishPkg('${p.id}')">发布</button>
        <button class="ghost act" onclick="exportPkg('${p.id}')">导出离线包</button>
        <button class="ghost act" onclick="exportInterrupt('${p.id}')">导出中断演练</button>
    </td></tr>`).join('');
  app.innerHTML = `<div class="card">
    <h2>导览包（按语言独立闭包，独立版本）</h2>
    <div class="row">
      <select id="plang"><option value="zh">中文</option><option value="en">英文</option>
      <option value="ja">日文</option></select>
      <span class="muted">${routesHint}</span>
      <button class="act" onclick="assemble()">组装导览包（检查闭包）</button>
    </div>
    <p class="muted">门禁：路线可达 + 该语言三受众文稿全部 approved + 每片段 audio/subtitle/script 齐备
      + 图片授权有效；中文稿更新而外语未复核时外语包 blocked。只有闭包满足才 ready/可发布。</p>
    <table><thead><tr><th>版本</th><th>语言</th><th>状态</th><th>发布时间</th><th>操作</th></tr></thead>
      <tbody id="pkgs">${rows}</tbody></table>
  </div>
  <div class="card"><h2>版本间依赖缺口</h2><pre id="report" hidden></pre></div>
  <div class="card"><h2>离线导出与更新状态</h2>
    <div id="jobs"></div>
  </div>`;
  renderJobs();
}
async function renderJobs(){
  const j = await api('/api/jobs');
  document.getElementById('jobs').innerHTML = j.jobs.length ? j.jobs.map(job=>`
    <div class="row" style="margin:4px 0">
      <span>导出任务 ${esc(job.id.slice(-6))}</span>
      ${pill(job.status)} <span>进度 ${job.progress}/${job.total_steps}</span>
      <span class="muted">${esc(job.bundle_path||'')}</span>
      ${job.status==='interrupted'?`<button class="act" onclick="resumeJob('${job.id}')">断点续传</button>`:''}
    </div>`).join('') : '<div class="muted">暂无导出任务</div>';
}
window.assemble = async () => {
  if (!state.routeId){ toast('请先到“路线”页新建一条路线', true); return; }
  const lang = document.getElementById('plang').value;
  const d = await api('/api/packages', {route_id:state.routeId, lang, release:'patch'});
  state.pkgId = d.package_id;
  if (d.closed){ toast(`${d.lang} 包 v${d.semver} 闭包满足 → ready，可发布`); }
  else { toast(`${d.lang} 包 v${d.semver} blocked：发现 ${d.gaps.length} 个依赖缺口`, true); }
  render();
  showReport(d.package_id);
};
window.showReport = async id => {
  const rpt = await api(`/api/packages/${id}/report`);
  const pre=document.getElementById('report'); pre.hidden=false;
  pre.textContent = rpt.closed
    ? `[${rpt.lang}] 资料闭包满足 ✅  资产 ${rpt.asset_count} 项，无依赖缺口`
    : `[${rpt.lang}] 闭包缺口 ${rpt.gaps.length} 项 ❌\n\n` +
      rpt.gaps.map(g=>`· [${g.type}] ${g.detail}`).join('\n');
};
window.publishPkg = async id => {
  const d = await api(`/api/packages/${id}/publish`, {});
  if (d.ok) toast(`已发布 ${d.semver}`); else { toast(d.reason, true); showReport(id); }
  render();
};
window.exportPkg = async id => {
  const d = await api(`/api/packages/${id}/export`, {device_tag:'device-A1'});
  if (d.status==='done') toast(`离线包导出完成：${d.version}，设备更新状态=${d.update_state}`);
  render();
};
window.exportInterrupt = async id => {
  // 先导出一次制造已装版本，再发布新版本后“断网”演练，再续传
  const first = await api(`/api/packages/${id}/export`, {device_tag:'device-A1'});
  const d2 = await api(`/api/packages/${id}/export`,
    {device_tag:'device-A1', fail_at_step:4});
  toast(`导出在第 ${d2.failed_step} 步中断（进度 ${d2.progress}/${d2.total}），可断点续传`, true);
  state._resumeJob = d2.job_id;
  render();
  document.getElementById('jobs').insertAdjacentHTML('beforeend',
    `<div class="row"><button class="act" onclick="resumeJob('${d2.job_id}')">立即断点续传</button></div>`);
};
window.resumeJob = async id => {
  const d = await api(`/api/jobs/${id}/resume`, {});
  if (d.status==='done') toast(`续传完成，已完成步骤未重做；版本 ${d.version}，更新状态=${d.update_state}`);
  render();
};

function render(){ const t=state.tab;
  ({exhibits:tabExhibits, manuscripts:tabManuscripts, audio:tabAudio,
    routes:tabRoutes, packages:tabPackages}[t])(); }
render();
