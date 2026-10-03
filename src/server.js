// 零依赖 HTTP 服务：REST API + 静态前端 + 后台音频 worker
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');
const engine = require('./engine');
const seed = require('./seed');

const PORT = process.env.PORT || 3000;
let workerOn = true;

function state() {
  const s = db.db;
  return {
    exhibits: s.exhibits,
    facts: s.facts,
    scripts: s.scripts.map((sc) => ({ ...sc, review: engine.reviewStatus(s, sc) })),
    audioTasks: s.audioTasks,
    routes: s.routes.map((r) => ({ ...r, closure: engine.evaluateClosure(s, r) })),
    packages: s.packages,
    halls: engine.HALLS,
    graph: engine.HALL_GRAPH,
    workerOn,
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e6) reject(new Error('BODY_TOO_LARGE')); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

// ---- 后台 worker：模拟 TTS / 字幕流水线。同一片段的旧任务被取代后不会覆盖新产物 ----
setInterval(() => {
  if (!workerOn) return;
  // 每次 tick 都从 db.db 取实时引用，避免 reset 后持有旧集合
  for (const p of db.db.packages) {
    if (p.status === 'building') engine.advanceBuild(db.db, p.id);
  }
  const t0 = db.db.audioTasks.find((x) => x.status === 'queued');
  if (t0) {
    t0.status = 'running'; t0.startedAt = engine.now();
    const delay = 120 + (engine.hash(t0.id).charCodeAt(0) % 260);
    setTimeout(() => {
      const live = db.db;
      engine.completeTask(live, t0.id);
      db.save();
    }, delay);
  }
  db.save();
}, 400);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  try {
    if (p === '/' || p === '/index.html') return staticFile(res, 'index.html');
    if (p.startsWith('/static/')) return staticFile(res, p.replace('/static/', ''));
    if (p === '/api/state') return send(res, 200, state());

    if (p === '/api/reset' && req.method === 'POST') {
      db.reset({ meta: { version: 1, seq: 0 }, exhibits: [], facts: [], scripts: [], audioTasks: [], routes: [], packages: [] });
      seed.build(Object.assign(db.db, { nextId: db.nextId }));
      db.save();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/worker' && req.method === 'POST') {
      const b = await readBody(req); workerOn = !!b.on; return send(res, 200, { workerOn });
    }

    if (p === '/api/facts/revise' && req.method === 'POST') {
      const b = await readBody(req);
      const out = engine.reviseFact(db.db, b.factId, b.patch, b.actor); db.save(); return send(res, 200, out);
    }
    if (p === '/api/scripts/update' && req.method === 'POST') {
      const b = await readBody(req);
      const out = engine.updateScript(db.db, b.scriptId, b.edits, b.actor); db.save(); return send(res, 200, out);
    }
    if (p === '/api/scripts/approve' && req.method === 'POST') {
      const b = await readBody(req);
      const out = engine.approveScript(db.db, b.scriptId, b.actor); db.save(); return send(res, 200, out);
    }
    if (p.match(/^\/api\/tasks\/[^/]+\/complete$/) && req.method === 'POST') {
      const id = p.split('/')[3];
      const out = engine.completeTask(db.db, id); db.save(); return send(res, 200, out);
    }

    if (p === '/api/exhibits/withdraw' && req.method === 'POST') {
      const b = await readBody(req);
      const out = engine.withdrawExhibit(db.db, b.exhibitId, b.actor); db.save(); return send(res, 200, out);
    }
    if (p === '/api/exhibits/reinstate' && req.method === 'POST') {
      const b = await readBody(req);
      const out = engine.reinstateExhibit(db.db, b.exhibitId); db.save(); return send(res, 200, out);
    }
    if (p === '/api/exhibits/license' && req.method === 'POST') {
      const b = await readBody(req);
      const ex = db.db.exhibits.find((x) => x.id === b.exhibitId);
      ex.imageLicense = { ...ex.imageLicense, ...b.patch }; db.save(); return send(res, 200, ex);
    }

    if (p === '/api/routes/update' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const out = engine.updateRoute(db.db, b.routeId, b.stops, b.expectedVersion, b.actor);
        db.save(); return send(res, 200, out);
      } catch (e) {
        if (e.code === 'VERSION_CONFLICT') return send(res, 409, { error: 'VERSION_CONFLICT', serverVersion: e.serverVersion });
        throw e;
      }
    }

    if (p === '/api/packages/start' && req.method === 'POST') {
      const b = await readBody(req);
      const out = engine.startBuild(db.db, b.routeId); db.save(); return send(res, 200, out);
    }
    if (p.match(/^\/api\/packages\/[^/]+\/interrupt$/) && req.method === 'POST') {
      const id = p.split('/')[3]; engine.interruptBuild(db.db, id); db.save(); return send(res, 200, { ok: true });
    }
    if (p.match(/^\/api\/packages\/[^/]+\/resume$/) && req.method === 'POST') {
      const id = p.split('/')[3]; engine.resumeBuild(db.db, id); db.save(); return send(res, 200, { ok: true });
    }
    if (p.match(/^\/api\/packages\/[^/]+\/publish$/) && req.method === 'POST') {
      const id = p.split('/')[3];
      try { const out = engine.publishPackage(db.db, id); db.save(); return send(res, 200, out); }
      catch (e) { if (e.code === 'CLOSURE_DRIFT') return send(res, 409, { error: 'CLOSURE_DRIFT', closure: e.closure }); if (e.code === 'NOT_BUILDABLE') return send(res, 409, { error: e.code }); throw e; }
    }
    if (p === '/api/offline-status' && req.method === 'GET') {
      const routeId = u.query.routeId, installed = u.query.installed || null;
      const pkg = [...db.db.packages].filter((x) => x.routeId === routeId && x.status === 'published').sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
      return send(res, 200, engine.offlineStatus(pkg, installed));
    }

    if (p === '/api/drills/run' && req.method === 'POST') {
      const drills = require('./drills');
      const b = await readBody(req);
      return send(res, 200, drills.run(b.scenario || 'all', b.opts || {}));
    }

    send(res, 404, { error: 'NOT_FOUND', path: p });
  } catch (e) {
    send(res, 500, { error: e.message, stack: e.stack });
  }
});

function staticFile(res, name) {
  const fp = path.join(__dirname, '..', 'public', path.basename(name));
  if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  res.end(fs.readFileSync(fp));
}

db.load();
if (!db.db.exhibits.length) {
  seed.build(Object.assign(db.db, { nextId: db.nextId }));
  db.save();
}

server.listen(PORT, () => console.log(`博物馆导览制作间: http://localhost:${PORT}`));
module.exports = server;
