"""音频处理任务引擎（模拟 TTS）。

模式对比：
- segment：以稳定片段身份产出 asset(kind in audio/subtitle/script)，
  改一句话后仅对应片段缓存未命中并重做，其余命中缓存；导出时顺序拼接。
- whole：整篇用一个内容哈希，改任何一句 -> 整篇全部重做（音色更连续，但无片段缓存）。

音色连续性：segment 拼接在句边界可能有轻微韵律跳变（原型以 continuity_gap 秒建模）；
whole 无跳变。成本：以“实际合成字数/总字数”作为计费量；缓存命中不产生费用。
"""
from __future__ import annotations

import json
import os
import time

from . import db, services

VOICE_BY_LANG = {"zh": "shuxiang", "en": "aria", "ja": "suzume"}
CONTINUITY_GAP = 0.12          # 每处拼接的韵律间隔（秒），建模音色连续性损耗
STORE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "packages", "store")


def _ensure_store():
    os.makedirs(STORE, exist_ok=True)


def estimate_duration(text: str, rate_wpm: int) -> float:
    # 中文按字数近似（约 wpm*1.7 字/分），英文按词；统一用“音节数”近似
    chars = len([c for c in text if not c.isspace()])
    units = chars if any('一' <= c <= '鿿' for c in text) else max(1, len(text.split()))
    cpm = rate_wpm * (1.7 if any('一' <= c <= '鿿' for c in text) else 1.0)
    return round(units / cpm * 60.0, 3)


def _write_payload(path: str, payload: dict):
    _ensure_store()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)


def enqueue_render(conn, manuscript_id: str, mode: str = "segment", voice: str | None = None):
    """为文稿创建渲染任务。segment 模式逐句一个子任务；whole 模式单任务。
    返回任务清单（含 cache_hit 标记的计划）。"""
    m = conn.execute("SELECT * FROM manuscript WHERE id=?", (manuscript_id,)).fetchone()
    if not m:
        raise ValueError("manuscript not found")
    voice = voice or VOICE_BY_LANG[m["lang"]]
    ts = services.now()
    tasks = []

    with db.tx(conn):
        # 幂等键：同 (文稿,模式,音色) 已有 queued/running 任务则直接复用
        if mode == "segment":
            segs = conn.execute("SELECT * FROM segment WHERE manuscript_id=? ORDER BY seq",
                                (manuscript_id,)).fetchall()
            for s in segs:
                idem = f"render:{mode}:{s['id']}:{s['content_hash']}:{s['rate_wpm']}:{voice}"
                tasks.append(_upsert_task(conn, idem, manuscript_id, mode, voice, s["seq"], ts))
        else:
            full = services.render_script_text(conn, manuscript_id)
            chash = services.h(full + f"@{m['rate_wpm']}")
            idem = f"render:{mode}:{manuscript_id}:{chash}:{voice}"
            tasks.append(_upsert_task(conn, idem, manuscript_id, mode, voice, 0, ts))
    return tasks


def _upsert_task(conn, idem, manuscript_id, mode, voice, seq, ts):
    # 同一幂等键的历史任务（done/superseded）也复用：重复入队不产生新任务
    row = conn.execute(
        "SELECT * FROM task WHERE idem_key=? ORDER BY created_at DESC LIMIT 1", (idem,)).fetchone()
    if row:
        return {"task_id": row["id"], "idem_key": idem, "seq": seq,
                "deduplicated": True, "status": row["status"]}
    tid = db.new_id("task")
    conn.execute(
        """INSERT INTO task(id,idem_key,kind,manuscript_id,mode,voice,seq,status,created_at)
           VALUES(?,?, 'render_manuscript',?,?,?,?,'queued',?)""",
        (tid, idem, manuscript_id, mode, voice, seq, ts))
    return {"task_id": tid, "idem_key": idem, "seq": seq, "deduplicated": False}


def _segment_cache_hit(conn, seg, voice, kind):
    row = conn.execute(
        """SELECT * FROM asset WHERE kind=? AND mode='segment' AND segment_id=?
           AND content_hash=? AND rate_wpm=? AND voice=?""",
        (kind, seg["id"], seg["content_hash"], seg["rate_wpm"], voice)).fetchone()
    return dict(row) if row else None


def run_task(conn, task_id: str, *, force_order: bool = False):
    """执行单个音频任务。乱序安全：任务只依赖自身幂等键与资产表唯一约束，
    完成顺序不影响结果正确性；后到的旧任务（哈希已过期）标记 superseded。"""
    t = conn.execute("SELECT * FROM task WHERE id=?", (task_id,)).fetchone()
    if not t:
        raise ValueError("task not found")
    if t["status"] in ("done", "superseded"):
        return {"task_id": task_id, "noop": t["status"]}

    m = conn.execute("SELECT * FROM manuscript WHERE id=?", (t["manuscript_id"],)).fetchone()
    voice = t["voice"]
    ts = services.now()
    produced, cached, cost_chars = [], [], 0

    with db.tx(conn):
        conn.execute("UPDATE task SET status='running' WHERE id=?", (task_id,))

    with db.tx(conn):
        if t["mode"] == "segment":
            seg = conn.execute("SELECT * FROM segment WHERE manuscript_id=? AND seq=?",
                               (t["manuscript_id"], t["seq"])).fetchone()
            if seg is None:
                conn.execute("UPDATE task SET status='failed', error='segment missing' WHERE id=?", (task_id,))
                return {"task_id": task_id, "error": "segment missing"}
            # 片段已被改写：该任务对应的旧哈希过期 -> superseded（乱序完成的旧任务）
            if t["idem_key"] != f"render:segment:{seg['id']}:{seg['content_hash']}:{seg['rate_wpm']}:{voice}":
                conn.execute("UPDATE task SET status='superseded', finished_at=? WHERE id=?", (ts, task_id))
                return {"task_id": task_id, "superseded": True}

            for kind in ("audio", "subtitle", "script"):
                hit = _segment_cache_hit(conn, seg, voice, kind)
                if hit:
                    cached.append({"kind": kind, "asset_id": hit["id"]})
                    continue
                dur = estimate_duration(seg["text"], seg["rate_wpm"]) if kind == "audio" else 0.0
                aid = db.new_id("ast")
                path = os.path.join(STORE, f"{aid}.{kind}.json")
                _write_payload(path, {"segment_id": seg["id"], "kind": kind,
                                      "text": seg["text"], "hash": seg["content_hash"]})
                conn.execute(
                    """INSERT INTO asset(id,kind,mode,segment_id,manuscript_id,lang,voice,
                       content_hash,rate_wpm,duration,bytes,storage_path,created_at)
                       VALUES(?,?, 'segment',?,?,?,?,?,?,?,?,?,?)""",
                    (aid, kind, seg["id"], t["manuscript_id"], m["lang"], voice,
                     seg["content_hash"], seg["rate_wpm"], dur, len(seg["text"]), path, ts))
                produced.append({"kind": kind, "asset_id": aid, "duration": dur})
                cost_chars += len(seg["text"])
        else:
            full = services.render_script_text(conn, t["manuscript_id"])
            chash = services.h(full + f"@{m['rate_wpm']}")
            expected_idem = f"render:whole:{t['manuscript_id']}:{chash}:{voice}"
            if t["idem_key"] != expected_idem:
                conn.execute("UPDATE task SET status='superseded', finished_at=? WHERE id=?", (ts, task_id))
                return {"task_id": task_id, "superseded": True}
            dur = estimate_duration(full, m["rate_wpm"])
            aid = db.new_id("ast")
            path = os.path.join(STORE, f"{aid}.whole.json")
            _write_payload(path, {"manuscript_id": t["manuscript_id"], "text": full, "hash": chash})
            conn.execute(
                """INSERT INTO asset(id,kind,mode,segment_id,manuscript_id,lang,voice,
                   content_hash,rate_wpm,duration,bytes,storage_path,created_at)
                   VALUES(?, 'audio','whole',NULL,?,?,?,?,?,?,?,?,?)""",
                (aid, t["manuscript_id"], m["lang"], voice, chash, m["rate_wpm"],
                 dur, len(full), path, ts))
            produced.append({"kind": "audio", "asset_id": aid, "duration": dur})
            cost_chars = len(full)

        payload = {"produced": produced, "cached": cached, "cost_chars": cost_chars,
                   "finished_at": ts}
        conn.execute(
            "UPDATE task SET status='done', result_payload=?, finished_at=? WHERE id=?",
            (json.dumps(payload, ensure_ascii=False), ts, task_id))

    return {"task_id": task_id, "status": "done", **payload}


def run_pending(conn, *, shuffle: bool = False):
    """排空队列。shuffle=True 模拟处理任务乱序完成（结果仍须正确）。"""
    rows = conn.execute("SELECT id, seq, created_at FROM task WHERE status='queued'").fetchall()
    ordered = sorted(rows, key=lambda r: (r["created_at"], r["seq"]))
    if shuffle:
        import random
        random.Random(7).shuffle(ordered)
    results = [run_task(conn, r["id"]) for r in ordered]
    return {"ran": len(results),
            "out_of_order": shuffle,
            "results": results}


def rendered_manuscript_duration(conn, manuscript_id: str, mode: str = "segment",
                                 voice: str | None = None, include_gaps: bool = True):
    """汇总音频时长。segment：Σ片段 + (n-1)*拼接间隔；whole：整段。
    无资产时返回 None（调用方据此重算/等待）。"""
    m = conn.execute("SELECT * FROM manuscript WHERE id=?", (manuscript_id,)).fetchone()
    voice = voice or VOICE_BY_LANG[m["lang"]]
    if mode == "whole":
        row = conn.execute(
            """SELECT duration FROM asset WHERE kind='audio' AND mode='whole'
               AND manuscript_id=? AND voice=? ORDER BY created_at DESC LIMIT 1""",
            (manuscript_id, voice)).fetchone()
        return round(row["duration"], 3) if row else None
    segs = conn.execute("SELECT id FROM segment WHERE manuscript_id=? ORDER BY seq",
                        (manuscript_id,)).fetchall()
    total, n_hits = 0.0, 0
    for s in segs:
        row = conn.execute(
            """SELECT duration FROM asset WHERE kind='audio' AND mode='segment'
               AND segment_id=? AND voice=?""", (s["id"], voice)).fetchone()
        if not row:
            return None
        total += row["duration"]; n_hits += 1
    if include_gaps and n_hits > 1:
        total += (n_hits - 1) * CONTINUITY_GAP
    return round(total, 3)


def compare_strategies(conn, manuscript_id: str, voice: str | None = None):
    """对同一文稿比较整段重生成 vs 分段拼接：音色连续性 / 缓存 / 成本。
    模拟“改一句话”后第二次渲染的增量。"""
    m = conn.execute("SELECT * FROM manuscript WHERE id=?", (manuscript_id,)).fetchone()
    voice = voice or VOICE_BY_LANG[m["lang"]]
    segs = conn.execute("SELECT * FROM segment WHERE manuscript_id=? ORDER BY seq",
                        (manuscript_id,)).fetchall()
    total_chars = sum(len(s["text"]) for s in segs)
    n = len(segs)

    def seg_hits():
        hit_chars = 0
        for s in segs:
            if _segment_cache_hit(conn, s, voice, "audio"):
                hit_chars += len(s["text"])
        return hit_chars

    def whole_hit():
        full = services.render_script_text(conn, manuscript_id)
        chash = services.h(full + f"@{m['rate_wpm']}")
        return conn.execute(
            "SELECT 1 FROM asset WHERE mode='whole' AND manuscript_id=? AND content_hash=? AND voice=?",
            (manuscript_id, chash, voice)).fetchone() is not None

    seg_hit_chars = seg_hits()
    seg_regen = total_chars - seg_hit_chars
    whole_regen = 0 if whole_hit() else total_chars
    seg_dur = rendered_manuscript_duration(conn, manuscript_id, "segment", voice)
    whole_dur = rendered_manuscript_duration(conn, manuscript_id, "whole", voice)

    return {
        "manuscript_id": manuscript_id,
        "lang": m["lang"],
        "voice": voice,
        "total_chars": total_chars,
        "segment": {
            "strategy": "分段拼接（稳定片段身份，句级缓存）",
            "continuity": f"句边界存在约 {CONTINUITY_GAP*1000:.0f}ms 韵律间隔，"
                          f"{n-1} 处拼接；音色同源但句调独立，跨句呼吸可能不连续",
            "cache": f"{n} 句中按 (片段身份,哈希,语速,音色) 命中；改一句仅 1 句失效",
            "regen_chars": seg_regen,
            "cache_hit_ratio": round(seg_hit_chars / total_chars, 3) if total_chars else 1,
            "billed": f"按重做字数计费：{seg_regen}/{total_chars} 字",
            "duration": seg_dur,
            "cost_index": round(seg_regen / total_chars, 3) if total_chars else 0,
        },
        "whole": {
            "strategy": "整段重生成（单一全片哈希）",
            "continuity": "整篇一次合成，呼吸/语调自然过渡，音色连续性最好",
            "cache": "缓存粒度为整篇；任何一句改动或语速调整都使整篇失效",
            "regen_chars": whole_regen,
            "cache_hit_ratio": (1.0 if whole_regen == 0 else 0.0),
            "billed": f"按全篇计费：{whole_regen}/{total_chars} 字",
            "duration": whole_dur,
            "cost_index": round(whole_regen / total_chars, 3) if total_chars else 0,
        },
        "tradeoff": (
            "首版成本相同；改一句话后分段仅重做该句（成本≈1/n），整段需重做全篇；"
            "整段在音色连续性与后期母带上占优，分段在迭代改稿、多语速、CDN 缓存与并行渲染上占优；"
            "推荐生产用分段渲染 + 关键展项用整段重渲做质量兜底（双轨 A/B）。"),
    }
