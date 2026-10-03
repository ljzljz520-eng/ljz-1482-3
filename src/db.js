// 极简 JSON 文档库：零依赖、同步、带写时持久化。
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'studio.json');

const empty = () => ({
  meta: { version: 1, seq: 0 },
  exhibits: [],
  facts: [],
  scripts: [],      // 文稿 = 展品 × 语言 × 受众
  audioTasks: [],
  routes: [],
  packages: [],
});

let db = empty();

function nextId(kind) {
  db.meta.seq += 1;
  return `${kind}_${String(db.meta.seq).padStart(4, '0')}`;
}

function attach() {
  // 引擎统一以 store.nextId 取号；绑定到文档对象本身（JSON 序列化时函数被忽略，不会写盘）
  db.nextId = nextId;
}

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    db = empty();
    save();
  }
  attach();
  return db;
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function reset(data) {
  db = data || empty();
  attach();
  save();
}

// 深快照（构建包时冻结现场数据用）
function snapshot() {
  return JSON.parse(JSON.stringify(db));
}

module.exports = { load, save, reset, snapshot, nextId, get db() { return db; } };
