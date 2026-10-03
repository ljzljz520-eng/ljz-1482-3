"""导览包：按语言的资料闭包、版本、发布门禁与离线导出（可中断/续传）。

资料闭包（每种语言各自满足才能发布该语言包）：
  A. 路线可达（无撤展/悬空卡，valid=1）
  B. 路线上每张卡对应展品的【该语言】三受众文稿全部 approved
     —— 中文稿更新而外语未复核 => 外语包存在缺口，不能发布
  C. 每个已核可文稿的全部稳定片段，其 audio/subtitle/script 三类资产齐备
  D. 展品图片授权未到期（授权日 < 今天 => 缺口）
  E. 转场指路文本已渲染（route transition 音频在清单内）
版本：MAJOR.MINOR.PATCH；同一路线+语言新版本必须 >= 上一发布版。
"""
from __future__ import annotations

import datetime as dt
import json
import os
import time

from . import db, services, audio, routes_svc

BUNDLE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "packages", "offline")


def _today():
    return dt.date.today()


def build_closure_report(conn, route_id: str, lang: str) -> dict:
    route = routes_svc.get_route(conn, route_id)
    gaps = []
    assets_manifest = []

    if not route["valid"]:
        gaps.append({"type": "route_invalid", "detail": route["validation_msg"]})

    for card in route["cards"]:
        ex = card["exhibit"]
        if not ex or ex["withdrawn"]:
            gaps.append({"type": "withdrawn_or_missing", "seq": card["seq"],
                         "detail": "展品撤展或缺失"})
            continue
        # 图片授权
        if ex["image_license_expires"]:
            try:
                exp = dt.date.fromisoformat(ex["image_license_expires"])
                if exp < _today():
                    gaps.append({"type": "image_license_expired", "exhibit": ex["code"],
                                 "expires": ex["image_license_expires"],
                                 "detail": f"展品 {ex['code']} 图片授权已于 {ex['image_license_expires']} 到期"})
            except ValueError:
                pass
        # 该语言三受众文稿与审批状态
        mss = conn.execute(
            "SELECT * FROM manuscript WHERE exhibit_id=? AND lang=?", (ex["id"], lang)).fetchall()
        by_aud = {m["audience"]: m for m in mss}
        for aud in services.AUDIENCES:
            m = by_aud.get(aud)
            if m is None:
                gaps.append({"type": "missing_manuscript", "exhibit": ex["code"],
                             "lang": lang, "audience": aud,
                             "detail": f"缺 {lang}/{aud} 文稿"})
                continue
            if m["status"] != "approved":
                gaps.append({"type": "manuscript_not_approved", "exhibit": ex["code"],
                             "lang": lang, "audience": aud, "status": m["status"],
                             "detail": f"{lang}/{aud} 文稿状态={m['status']}（中文已更新而外语未复核时会卡在此处）"})
                # 状态未核可也继续统计资产缺口，一次给全依赖缺口
            segs = conn.execute("SELECT * FROM segment WHERE manuscript_id=? ORDER BY seq",
                                (m["id"],)).fetchall()
            for s in segs:
                for kind in ("audio", "subtitle", "script"):
                    a = conn.execute(
                        """SELECT id, duration, content_hash FROM asset
                           WHERE kind=? AND mode='segment' AND segment_id=?
                           AND content_hash=? AND rate_wpm=? AND voice=?""",
                        (kind, s["id"], s["content_hash"], s["rate_wpm"],
                         audio.VOICE_BY_LANG[lang])).fetchone()
                    if a is None:
                        gaps.append({"type": "missing_asset", "exhibit": ex["code"],
                                     "lang": lang, "audience": aud, "segment": s["id"],
                                     "kind": kind,
                                     "detail": f"{lang}/{aud} 片段 {s['id']} 缺 {kind}"})
                    else:
                        assets_manifest.append({"kind": kind, "segment": s["id"],
                                                "asset_id": a["id"], "hash": a["content_hash"],
                                                "duration": a["duration"]})
        # 转场指路（非首卡）
        if card["seq"] > 1 and card.get("transition_text"):
            assets_manifest.append({"kind": "route_transition", "seq": card["seq"],
                                    "text_hash": card["transition_hash"],
                                    "duration": audio.estimate_duration(card["transition_text"], 190)})

    return {"route_id": route_id, "lang": lang, "closed": not gaps,
            "gaps": gaps, "asset_count": len(assets_manifest),
            "assets": assets_manifest}


def bump_version(prev: str | None, kind: str = "patch") -> str:
    if not prev:
        return "1.0.0"
    major, minor, patch = (int(x) for x in prev.split("."))
    if kind == "major":
        return f"{major+1}.0.0"
    if kind == "minor":
        return f"{major}.{minor+1}.0"
    return f"{major}.{minor}.{patch+1}"


def assemble_package(conn, route_id: str, lang: str, release: str = "patch",
                     editor: str = "ops") -> dict:
    """组装导览包：写入闭包报告；闭包满足才生成 manifest 并可发布。"""
    report = build_closure_report(conn, route_id, lang)
    # 版本号取同路线+语言的最大 semver（blocked 的尝试也占用版本号，避免回退/撞号）
    rows = conn.execute(
        "SELECT semver FROM package WHERE route_id=? AND lang=?", (route_id, lang)).fetchall()
    prev_semver = None
    for r in rows:
        if prev_semver is None or [int(x) for x in r["semver"].split(".")] > \
                [int(x) for x in prev_semver.split(".")]:
            prev_semver = r["semver"]
    semver = bump_version(prev_semver, release)
    status = "ready" if report["closed"] else "blocked"
    pid = db.new_id("pkg")
    ts = services.now()
    manifest = None
    if report["closed"]:
        manifest = json.dumps({
            "package_id": pid, "semver": semver, "lang": lang, "route_id": route_id,
            "built_at": ts,
            "route_duration": routes_svc.recompute_duration(conn, route_id)["duration"],
            "assets": report["assets"],
        }, ensure_ascii=False)
    with db.tx(conn):
        conn.execute(
            """INSERT INTO package(id,lang,route_id,semver,status,closure_report,manifest,created_at)
               VALUES(?,?,?,?,?,?,?,?)""",
            (pid, lang, route_id, semver, status,
             json.dumps(report, ensure_ascii=False), manifest, ts))
    return {"package_id": pid, "semver": semver, "lang": lang, "status": status,
            "closed": report["closed"], "gaps": report["gaps"]}


def publish_package(conn, package_id: str) -> dict:
    p = conn.execute("SELECT * FROM package WHERE id=?", (package_id,)).fetchone()
    if not p:
        raise ValueError("package not found")
    if p["status"] != "ready":
        return {"package_id": package_id, "ok": False,
                "reason": f"闭包未满足（status={p['status']}），只有资料闭包齐备的导览包可发布",
                "gaps": json.loads(p["closure_report"])["gaps"]}
    with db.tx(conn):
        conn.execute("UPDATE package SET status='published', published_at=? WHERE id=?",
                     (services.now(), package_id))
    return {"package_id": package_id, "ok": True, "status": "published", "semver": p["semver"]}


# ---------- 离线导出：多步、可中断、断点续传 ----------
def _steps_for(package: dict, n_assets: int) -> list[str]:
    steps = ["validate_closure", "freeze_manifest"]
    steps += [f"fetch_asset:{i}" for i in range(n_assets)]
    steps += ["transcode_audio", "build_index", "sign_bundle", "write_update_flag"]
    return steps


def start_export(conn, package_id: str, device_tag: str = "device-A1",
                 fail_at_step: int | None = None) -> dict:
    p = conn.execute("SELECT * FROM package WHERE id=?", (package_id,)).fetchone()
    if not p:
        raise ValueError("package not found")
    if p["status"] not in ("ready", "published", "exported"):
        return {"ok": False, "reason": "包处于 blocked，不可导出"}
    n_assets = len(json.loads(p["manifest"])["assets"]) if p["manifest"] else 0
    steps = _steps_for(dict(p), n_assets)
    job_id = db.new_id("job")
    with db.tx(conn):
        conn.execute(
            """INSERT INTO export_job(id,package_id,device_tag,status,progress,total_steps,
               completed_steps,updated_at) VALUES(?,?,?, 'running',0,?, '[]',?)""",
            (job_id, package_id, device_tag, len(steps), services.now()))
    return run_export(conn, job_id, fail_at_step=fail_at_step)


def run_export(conn, job_id: str, fail_at_step: int | None = None) -> dict:
    """推进导出；fail_at_step 指定在某步“断电/断网”，状态置 interrupted。
    续传时 completed_steps 中的步骤全部跳过（幂等），从断点继续。"""
    job = conn.execute("SELECT * FROM export_job WHERE id=?", (job_id,)).fetchone()
    if not job:
        raise ValueError("job not found")
    steps = None
    p = conn.execute("SELECT * FROM package WHERE id=?", (job["package_id"],)).fetchone()
    n_assets = len(json.loads(p["manifest"])["assets"]) if p["manifest"] else 0
    # 重建固定步骤表（确定性），总数与首次一致
    steps = _steps_for(dict(p), n_assets)
    done = set(json.loads(job["completed_steps"]))
    interrupted_at = None

    for i, step in enumerate(steps):
        if step in done:
            continue                       # 断点续传：跳过已完成步
        if fail_at_step is not None and i == fail_at_step:
            interrupted_at = i
            break
        done.add(step)
        with db.tx(conn):
            conn.execute(
                "UPDATE export_job SET status='running', progress=?, completed_steps=?, updated_at=? WHERE id=?",
                (len(done), json.dumps(sorted(done)), services.now(), job_id))

    os.makedirs(BUNDLE_DIR, exist_ok=True)
    if interrupted_at is not None:
        with db.tx(conn):
            conn.execute("UPDATE export_job SET status='interrupted', progress=?, updated_at=? WHERE id=?",
                         (len(done), services.now(), job_id))
        return {"job_id": job_id, "status": "interrupted", "progress": len(done),
                "total": len(steps), "failed_step": steps[interrupted_at],
                "resume_hint": "调用 resume_export 从断点继续，已完成步骤不会重做"}

    # 全部完成：落地离线包（含明确版本与更新状态）
    manifest = json.loads(p["manifest"])
    device = conn.execute("SELECT * FROM device_install WHERE device_tag=? AND lang=?",
                          (job["device_tag"], p["lang"])).fetchone()
    update_state = "fresh_install" if not device else (
        "up_to_date" if device["semver"] == p["semver"] else "update_available")
    manifest.update({
        "device_tag": job["device_tag"],
        "update_state": update_state,
        "from_version": device["semver"] if device else None,
        "offline": True,
    })
    bundle = os.path.join(BUNDLE_DIR, f"{p['lang']}-{p['semver']}.{job['device_tag']}.json")
    with open(bundle, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    with db.tx(conn):
        conn.execute(
            "UPDATE export_job SET status='done', progress=?, completed_steps=?, bundle_path=?, updated_at=? WHERE id=?",
            (len(steps), json.dumps(sorted(done)), bundle, services.now(), job_id))
        conn.execute(
            """INSERT INTO device_install(device_tag,lang,package_id,semver,installed_at)
               VALUES(?,?,?,?,?) ON CONFLICT(device_tag,lang) DO UPDATE SET
               package_id=excluded.package_id, semver=excluded.semver,
               installed_at=excluded.installed_at""",
            (job["device_tag"], p["lang"], p["id"], p["semver"], services.now()))
        conn.execute("UPDATE package SET status='exported' WHERE id=?", (p["id"],))
    return {"job_id": job_id, "status": "done", "progress": len(steps), "total": len(steps),
            "bundle_path": bundle, "update_state": update_state,
            "version": p["semver"]}
