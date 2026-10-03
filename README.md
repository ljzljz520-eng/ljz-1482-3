# 🏛️ 博物馆导览制作间（Museum Guide Studio）

一个零依赖、可直接运行的全栈原型：网页端编辑展品讲述与路线，后端管理音频/字幕处理任务，
数据库把**展品事实、语言版本、儿童/普通/专家三种文稿**关联起来，并以「资料闭包」作为导览包能否发布的唯一闸门。

## 运行

```bash
node src/server.js            # 需要 Node 18+，无需 npm install
# 打开 http://localhost:3000
```

- 数据持久化在 `data/studio.json`（原子写：写临时文件后 rename）。
- 右上角「重置演示数据」可随时回到初始状态：3 件展品、9 条共享事实、18 份文稿（2 语言 × 3 受众）、
  156 个初始片段任务（72 讲解音频 + 72 字幕 + 12 指路音频）全部就绪，示范路线六单元闭包满足。
- 「验收演练」页对 7 个场景在**隔离内存库**中自动断言，不触碰当前编辑数据。

## 目录结构

| 文件 | 职责 |
|---|---|
| `src/db.js` | JSON 文档库：加载/原子保存/重置/取号 |
| `src/engine.js` | 全部领域规则（不依赖 HTTP，可独立单测）：复核传播、片段身份、任务队列、路线拓扑、闭包、打包发布、离线状态 |
| `src/seed.js` | 初始展品/事实/三受众双语文稿/路线 |
| `src/server.js` | 零依赖 HTTP：REST API、静态资源、后台 TTS worker（模拟） |
| `src/drills.js` | 7 个验收场景的自动化断言 |
| `public/` | 无框架网页编辑器（展品/事实、文稿、路线、任务、闭包发布、离线包、演练） |

## 数据模型（关联关系）

```
exhibit ──< script（展品 × 语言 zh/en × 受众 child/general/expert = 6 份/展品）
fact ──< script_segment.factRefs        # 事实是语言中性的共享数据
script ──< segment（稳定身份 seg:{scriptId}:{code}，如 seg:…:age）
segment ── audio_artifact / subtitle_artifact（contentHash + voice + rate + durationMs）
route ──< stop(exhibit) ── transit(相邻展品对) ── artifacts[语言][受众]
route_version（乐观锁）/ validation / durations[语言][受众]
package（building/interrupted/built/blocked/published；版本 1.0.x + contentHash + manifest）
```

三种文稿不是同一份内容的「滤镜」，而是各自独立的措辞；事实是共享层。每种语言×受众绑定
独立音色与语速：儿童（0.92/0.95x、温暖音色）、普通（1.0x）、专家（1.14/1.12x、沉稳音色）。

## 核心业务规则如何落地

### 1. 共享事实修订 → 引用文稿进入待复核，但措辞/语速绝不被自动覆盖
- 事实保存时若内容变化则 `version+1`。
- 文稿保存「复核快照」`{wordingHash, factSigs: {factId: version}}`；复核状态由快照与当前值**推导**：
  `need_review` 的原因细分为 `FACT_REVISED:<code>` 或 `WORDING_CHANGED`。
- 修订事实**只打标记**：没有任何一句话被改写，没有任何音色/语速被改动。
  儿童版口语（「快三千岁啦」）、普通版书面语、专家版术语与各自语速原样保留。
- 旧音频仍保留可播放，但闭包检查把待复核文稿计入缺口，防止把未核实的话发布到现场。
- **中文稿更新并复核后，英文稿以及另外两种受众仍各自待复核**——闭包按 6 个独立单元核算。

### 2. 录音、字幕、脚本共用稳定片段身份；改一句话只重做受影响部分
- 片段身份是 `seg:{scriptId}:{code}`（intro/age/find/cast…），编辑文本不改 code。
- 保存文稿时逐片段比对 `expectedAudioHash(text, voiceId, rate)`：
  哈希命中的片段**零任务（缓存命中）**；只有文本变化的片段排队音频 + 字幕两个任务。
- 指路音频同样有稳定身份：`transit:{route}:{fromId}->${toId}:{lang}:{audience}`。
  调整顺序后，未受影响的边沿用缓存；消失的边标记 `retired` 并取消其排队任务。
- 任意任务完成（或被取代）都会触发**路线总时长重算**，按语言×受众给出「讲解 + 指路」时长。

### 3. 任务乱序完成的两条防线（不会用旧音频覆盖新句子）
1. **取代（supersede）**：同一片段新任务入队时，仍在 `queued` 的旧任务标记 `superseded`。
2. **内容哈希（hash_mismatch）**：已经 `running`（等于已提交 TTS 服务、无法撤回）的旧任务
   完成回报时，比对其载荷 `textHash` 与当前文本哈希；不一致直接作废，片段指针切到排队中的新任务。
片段上可同时看到「旧任务处理中 · 有更新在排队」。演练 `out_of_order` 同时覆盖两条路径。

### 4. 临时撤展：重新验证可达顺序，不能只删卡片留音频指路
- 撤展只改展品状态，**不删路线卡片**；关联路线 `validation.valid=false`，闭包出现 `EXHIBIT_WITHDRAWN`，构建被阻断。
- 编辑器必须显式重新规划。保存路线时按馆内拓扑（大厅↔三厅↔简牍厅的图）做 BFS：
  - 青铜厅 → 陶器厅 = `bronze → lobby → pottery = 55m`，自动生成新指路稿与新指路音频；
  - 旧边 `bronze→jade`、`jade→pottery` 退役（不会再播「前方去看玉璧」）；
  - 若两站展厅间本就无路（图上不连通），报 `UNREACHABLE_ORDER`。
- 重新规划后再次校验通过、闭包满足才可构建。

### 5. 只有满足资料闭包的导览包可发布；网页直接指出版本间依赖缺口
每个 `语言 × 受众` 单元独立检查：文稿存在、已复核、每片段音频+字幕就绪、每段指路音频就绪；
外加全局项：展品在展、图片授权未到期、顺序可达。缺口按单元/全局在「路线编辑器」「闭包与发布」页列出
（缺口码 + 文稿 id + 片段 code + 复核原因），点击构建时若不满足直接返回 `blocked` + 缺口清单，
发布前还会再做一次闭包（防止构建期间事实又被修订，`CLOSURE_DRIFT`）。

### 6. 版本明确、可中断续作的离线包与更新状态
- 构建分 8 步（manifest / 6 单元媒体 / 校验和），可在任意时刻「模拟中断」：
  状态转 `interrupted`，禁止发布；「续作」从当前步骤继续，**已完成步骤不重来**。
- 发布版本语义化补丁号 `1.0.0 → 1.0.1`，manifest 内含包版本、路线版本、内容哈希、
  6 个 `closure: sealed` 单元、媒体编码（opus/webvtt/webp/offline=true）。
- 现场设备上报已装版本，得到明确状态：`up_to_date / update_available / not_installed / ahead_of_release`。

### 7. 两人同改路线：乐观锁
保存接口带 `expectedVersion`；后提交者收到 `409 VERSION_CONFLICT` 与服务器当前版本，
网页提示其重取、在新版本上合并后再保存（「我已重取，基于最新版本覆盖保存」为显式动作）。

## 整段音频重生成 vs 分段拼接：音色连续性、缓存与成本取舍

| 维度 | 方案 A：整段重合成（全展品/整条路线一次 TTS） | 方案 B：分段合成 + 拼接（本方案） |
|---|---|---|
| 音色连续性 | **最好**：一次推理覆盖整段，韵律、句间停顿、跨句语气天然连贯，无接缝 | 段边界可能有微接缝；需要约束音色（同 voiceId+风格向量）、统一响度/采样率、加交叉淡入淡出（10–30ms）与停顿对齐；句中改词最伤，所以**编辑单位是整句不是词组** |
| 改一句话的代价 | 全部重算：N 分钟音频 × 每次改稿；等待长、浪费大 | 只重做 1 个片段：本原型中即「哈希失配片段」产生 1 音频 + 1 字幕任务，其余全部缓存命中 |
| 缓存 | 粒度粗，任何一处文本变化整体 key 失效 | 细粒度 key = hash(文本, 音色, 语速, 编码参数)，命中率高；事实修订但未改措辞时缓存仍有效（只待复核） |
| TTS/带宽成本 | O(全文长度) × 修改次数；夜间整包重算简单但昂贵 | O(变更量)；增量出包体积小，现场可只下载变化片段（配合 contentHash 做差量） |
| 一致性风险 | 低：版本即整段，天然原子 | 需要版本清单锁定每片段哈希，避免「新句配旧段」；本原型用 manifest contentHash + 每片段 contentHash 双层锁定，闭包未密封不发布 |
| 适用场景 | 终审后的整包出厂灌录、对连贯性要求极高的开篇/结束语；或 TTS 支持「长文档+时间戳」且便宜时 | 日常高频改稿、多语言多受众并行、现场增量更新、撤展改路线后的快速重发 |

**推荐的混合策略（本原型的数据结构为此预留）**：日常编辑走分段增量（快、省、可差量）；
每次正式发布前对受影响展品做一次「段落级重润色」（把同一文稿 4 个片段整体送 TTS 做韵律对齐，
而不是整条路线），片段身份不变、只更新 contentHash；开篇/结束等跨展品内容用整段母带。
这样把接缝限制在展品内部，跨展品的指路音频始终独立合成，撤展改路线不会连累讲解母带。

## 七个验收场景（网页「验收演练」页可一键运行）

1. **中文稿更新而外语未复核** (`fact_gap`)：事实升版 → 6 份引用文稿待复核、措辞不动；
   中文改句复核后英文/儿童仍阻塞，闭包页面能看到外语单元缺口。
2. **处理任务乱序完成** (`out_of_order`)：排队旧任务被 supersede；running 旧任务迟到被 hash_mismatch 拦截；最终产物始终等于最新文本；片段 code 不变。
3. **某展品图片授权到期** (`license_expiry`)：闭包出现 `IMAGE_LICENSE_EXPIRED`，构建 blocked；续签后可正常出包。
4. **两人改路线** (`two_editors`)：先提交者成功，后提交者 409，重取新版本后再提交成功。
5. **导出中断** (`export_interrupt`)：第 2 步中断不可发布，续作从第 2 步走到第 8 步，发布 1.0.0。
6. **依赖缺口 + 闭包发布 + 离线状态** (`closure_and_offline`)：缺口被枚举（音频待处理 + 待复核）；
   补齐后再发为 1.0.1，contentHash 变化；旧设备 `update_available`、新设备 `up_to_date`、空设备 `not_installed`。
7. **展品临时撤展** (`withdrawal`)：卡片保留、路线失效、构建被阻断；重新规划后旧指路边退役、
   新边按馆内拓扑生成（青铜→陶器经大厅 55m），闭包恢复；专家版因语速更快总时长明显短于儿童版。

命令行也可直接跑：

```bash
curl -s -X POST localhost:3000/api/drills/run -H 'Content-Type: application/json' -d '{"scenario":"all"}'
```

## 主要 API

| 方法 & 路径 | 说明 |
|---|---|
| GET `/api/state` | 全量状态（含每份文稿的推导复核状态、每条路线的闭包报告） |
| POST `/api/facts/revise` | 修订共享事实（内容变化升版并传播待复核标记） |
| POST `/api/scripts/update` `/approve` | 按片段 code 改句（增量任务）/ 复核通过 |
| POST `/api/tasks/:id/complete` | 模拟 TTS/字幕回报（乱序安全） |
| POST `/api/exhibits/withdraw` `reinstate` `/license` | 撤展/恢复/授权变更 |
| POST `/api/routes/update` | 乐观锁保存路线（expectedVersion），增量指路音频 + 时长重算 |
| POST `/api/packages/start` `/:id/interrupt` `resume` `publish` | 闭包闸门 + 可续作构建 |
| GET `/api/offline-status?routeId=&installed=` | 设备更新状态 |
| POST `/api/drills/run` | 隔离库验收演练 |
| POST `/api/reset` `/api/worker` | 重置演示数据 / 暂停恢复后台 worker |
