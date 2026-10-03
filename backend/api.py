"""HTTP API：仅标准库。路由 -> 服务层；乐观锁冲突返回 409。"""
from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import db, services, audio, routes_svc, package as pkg_svc
from .seed import seed as seed_demo

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "museum.db")
WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "web")
_lock = threading.Lock()   # 串行化写操作，原型层面保证任务/版本一致性


def get_conn():
    return db.connect(DB_PATH)


class Api:
    def __init__(self):
        self.routes = []

    def add(self, method, pattern, fn):
        import re
        rx = re.compile("^" + pattern.replace("{id}", r"(?P<id>[^/]+)") + "$")
        self.routes.append((method, rx, fn))

    def dispatch(self, method, path, body):
        for m, rx, fn in self.routes:
            if m != method:
                continue
            mt = rx.match(path)
            if mt:
                return fn(body or {}, **mt.groupdict())
        return 404, {"error": f"not found: {method} {path}"}


api = Api()


def ok(data, status=200):
    return status, data


# ---- 展品 ----
api.add("GET", "/api/exhibits", lambda b: ok({"exhibits": services.list_exhibits(get_conn())}))
api.add("POST", "/api/exhibits/{id}/withdraw",
        lambda b, id: ok(services.set_withdrawn(get_conn(), id, b.get("withdrawn", True))))

# ---- 事实 ----
api.add("POST", "/api/facts/{id}/revise",
        lambda b, id: ok(services.revise_fact(get_conn(), id, b["body"], b.get("editor", "web"))))
api.add("GET", "/api/manuscripts",
        lambda b: ok({"manuscripts": services.list_manuscripts(
            get_conn(), b.get("exhibit_id"), b.get("lang"))}))
api.add("GET", "/api/manuscripts/{id}",
        lambda b, id: ok(services.manuscript_detail(get_conn(), id)))
api.add("POST", "/api/manuscripts/{id}/sentence",
        lambda b, id: ok(services.update_sentence(get_conn(), id, int(b["seq"]), b["text"])))
api.add("POST", "/api/manuscripts/{id}/rate",
        lambda b, id: ok(services.set_rate(get_conn(), id, int(b["rate_wpm"]))))
api.add("POST", "/api/manuscripts/{id}/approve",
        lambda b, id: ok(services.approve_manuscript(get_conn(), id, b.get("reviewer", "reviewer"))))

# ---- 音频任务 ----
api.add("POST", "/api/manuscripts/{id}/render",
        lambda b, id: ok({"tasks": audio.enqueue_render(
            get_conn(), id, b.get("mode", "segment"), b.get("voice"))}))
api.add("POST", "/api/tasks/run",
        lambda b: ok(audio.run_pending(get_conn(), shuffle=bool(b.get("shuffle", False)))))
api.add("GET", "/api/tasks", lambda b: ok({"tasks": [
    dict(r) for r in get_conn().execute(
        "SELECT id,manuscript_id,mode,voice,seq,status,error,created_at,finished_at FROM task ORDER BY created_at")]}))
api.add("GET", "/api/manuscripts/{id}/compare",
        lambda b, id: ok(audio.compare_strategies(get_conn(), id, b.get("voice"))))

# ---- 路线 ----
api.add("POST", "/api/routes",
        lambda b: ok(routes_svc.create_route(get_conn(), b["name"], b["lang"],
                                             b["exhibit_ids"], b.get("editor", "curator"))))
api.add("GET", "/api/routes/{id}", lambda b, id: ok(routes_svc.get_route(get_conn(), id)))
api.add("POST", "/api/routes/{id}/edit",
        lambda b, id: ok(routes_svc.begin_edit(get_conn(), id, b.get("editor", "curator"))))
api.add("POST", "/api/routes/{id}/update",
        lambda b, id: _update_route(b, id))
api.add("POST", "/api/routes/{id}/validate", lambda b, id: ok(routes_svc.validate_route(get_conn(), id)))
api.add("POST", "/api/routes/{id}/recompute", lambda b, id: ok(routes_svc.recompute_duration(get_conn(), id)))


def _update_route(b, id):
    try:
        return ok(routes_svc.update_route(
            get_conn(), id, b.get("editor", "curator"),
            int(b["base_version"]), b["cards"]))
    except routes_svc.Conflict as e:
        return 409, {"error": str(e), "conflict": True}


# ---- 导览包 ----
api.add("POST", "/api/packages",
        lambda b: ok(pkg_svc.assemble_package(get_conn(), b["route_id"], b["lang"],
                                              b.get("release", "patch"), b.get("editor", "ops"))))
api.add("POST", "/api/packages/{id}/publish",
        lambda b, id: ok(pkg_svc.publish_package(get_conn(), id)))
api.add("GET", "/api/packages", lambda b: ok({"packages": [
    {k: r[k] for k in ("id", "lang", "route_id", "semver", "status", "published_at")}
    for r in get_conn().execute(
        "SELECT * FROM package ORDER BY created_at DESC")]}))
api.add("GET", "/api/packages/{id}/report", lambda b, id: ok(
    json.loads(get_conn().execute("SELECT closure_report c FROM package WHERE id=?", (id,)).fetchone()["c"])))
api.add("POST", "/api/packages/{id}/export",
        lambda b, id: ok(pkg_svc.start_export(get_conn(), id, b.get("device_tag", "device-A1"),
                                              b.get("fail_at_step"))))
api.add("POST", "/api/jobs/{id}/resume",
        lambda b, id: ok(pkg_svc.run_export(get_conn(), id)))
api.add("GET", "/api/jobs", lambda b: ok({"jobs": [
    dict(r) for r in get_conn().execute("SELECT * FROM export_job ORDER BY updated_at DESC")]}))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        ln = int(self.headers.get("Content-Length", 0))
        if not ln:
            return {}
        try:
            return json.loads(self.rfile.read(ln).decode("utf-8"))
        except Exception:
            return {}

    def _serve_static(self, path):
        if path in ("/", "/index.html"):
            path = "/index.html"
        fp = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not fp.startswith(WEB_DIR) or not os.path.isfile(fp):
            self.send_error(404)
            return
        ctype = "text/html; charset=utf-8" if fp.endswith(".html") else \
                "application/javascript; charset=utf-8" if fp.endswith(".js") else \
                "text/css; charset=utf-8" if fp.endswith(".css") else "application/octet-stream"
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            with _lock:
                try:
                    status, payload = api.dispatch("GET", path, {})
                except Exception as e:
                    status, payload = 400, {"error": str(e)}
            self._send(status, payload)
        else:
            self._serve_static(path)

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._read_body()
        with _lock:
            try:
                status, payload = api.dispatch("POST", path, body)
            except routes_svc.Conflict as e:
                status, payload = 409, {"error": str(e), "conflict": True}
            except Exception as e:
                status, payload = 400, {"error": str(e)}
        self._send(status, payload)


def serve(host="127.0.0.1", port=8070):
    conn = get_conn()  # 初始化
    seed_demo(conn)    # 首次启动播种演示数据
    conn.close()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"museum studio on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    serve()
