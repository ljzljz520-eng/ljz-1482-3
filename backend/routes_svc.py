"""路线服务。

- 稳定卡片身份 route_card:{route_id}#seq；转场指路文本也是哈希化稳定片段。
- 两人同时编辑：乐观版本号 + 编辑锁；base_version 不匹配 -> 409，拒绝覆盖。
- 展品临时撤展：不能只删卡片（会留下“音频指路”指向空展柜），
  必须重新验证“可达顺序”（连续悬空/缺资产即不可达），路线置 invalid 直到重排。
- 时长 = Σ(展品三语解说中本路线语言 normal 受众音频或预计时长 + 驻留 + 转场音频)。
"""
from __future__ import annotations

import json
import time

from . import db, services, audio


class Conflict(Exception):
    pass


def get_route(conn, route_id: str):
    r = conn.execute("SELECT * FROM route WHERE id=?", (route_id,)).fetchone()
    if not r:
        raise ValueError("route not found")
    d = dict(r)
    cards = [dict(c) for c in conn.execute(
        "SELECT * FROM route_card WHERE route_id=? ORDER BY seq", (route_id,))]
    exhibits = {x["id"]: dict(x) for x in conn.execute("SELECT * FROM exhibit")}
    for c in cards:
        c["exhibit"] = exhibits.get(c["exhibit_id"])
    d["cards"] = cards
    return d


def create_route(conn, name: str, lang: str, exhibit_ids: list[str], editor: str):
    ts = services.now()
    rid = db.new_id("route")
    with db.tx(conn):
        conn.execute(
            "INSERT INTO route(id,name,lang,version,duration,valid,updated_at) VALUES(?,?,?,1,0,1,?)",
            (rid, name, lang, ts))
        for i, ex_id in enumerate(exhibit_ids, 1):
            cid = f"route_card:{rid}#{i}"
            conn.execute(
                """INSERT INTO route_card(id,route_id,seq,exhibit_id,dwell,transition_text,
                   transition_hash,version) VALUES(?,?,?,?,?,'', '',1)""",
                (cid, rid, i, ex_id, 10.0))
        conn.execute(
            "INSERT INTO route_edit(route_id,editor,base_version,locked_at) VALUES(?,?,1,?)",
            (rid, editor, ts))
    recompute_duration(conn, rid)
    return validate_route(conn, rid)


def begin_edit(conn, route_id: str, editor: str):
    r = conn.execute("SELECT * FROM route WHERE id=?", (route_id,)).fetchone()
    if not r:
        raise ValueError("route not found")
    lock = conn.execute("SELECT * FROM route_edit WHERE route_id=?", (route_id,)).fetchone()
    ts = services.now()
    # 允许同一编辑者续租；他人持锁不阻塞读取，但提交时做版本校验
    with db.tx(conn):
        if lock:
            conn.execute("UPDATE route_edit SET editor=?, base_version=?, locked_at=? WHERE route_id=?",
                         (editor, r["version"], ts, route_id))
        else:
            conn.execute("INSERT INTO route_edit(route_id,editor,base_version,locked_at) VALUES(?,?,?,?)",
                         (route_id, editor, r["version"], ts))
    return {"route_id": route_id, "editor": editor, "base_version": r["version"]}


def update_route(conn, route_id: str, editor: str, base_version: int, cards: list[dict]):
    """整体提交有序卡片。cards: [{exhibit_id, dwell, transition_text}]
    乐观并发：version 不符 -> Conflict（两人改路线，后提交者必须先合并）。"""
    r = conn.execute("SELECT * FROM route WHERE id=?", (route_id,)).fetchone()
    if not r:
        raise ValueError("route not found")
    if base_version != r["version"]:
        raise Conflict(
            f"路线已被他人更新（服务器 v{r['version']}，你的基线 v{base_version}），请拉取最新版本合并后重试")

    ts = services.now()
    with db.tx(conn):
        old = {c["seq"]: c for c in conn.execute(
            "SELECT * FROM route_card WHERE route_id=?", (route_id,)).fetchall()}
        # 清空重排时：保留稳定身份的做法是按 seq 复用既有卡 id（内容变化则 version+1）
        conn.execute("DELETE FROM route_card WHERE route_id=?", (route_id,))
        for i, spec in enumerate(cards, 1):
            cid = f"route_card:{route_id}#{i}"
            prev = old.get(i)
            thash = services.h(spec.get("transition_text", ""))
            v = (prev["version"] + 1) if prev and (
                prev["exhibit_id"] != spec["exhibit_id"]
                or prev["transition_text"] != spec.get("transition_text", "")
                or abs(prev["dwell"] - float(spec.get("dwell", 10))) > 1e-6) else (
                prev["version"] if prev else 1)
            conn.execute(
                """INSERT INTO route_card(id,route_id,seq,exhibit_id,dwell,transition_text,
                   transition_hash,version) VALUES(?,?,?,?,?,?,?,?)""",
                (cid, route_id, i, spec["exhibit_id"], float(spec.get("dwell", 10)),
                 spec.get("transition_text", ""), thash, v))
        conn.execute("UPDATE route SET version=version+1, updated_at=? WHERE id=?", (ts, route_id))
        conn.execute("UPDATE route_edit SET editor=?, base_version=base_version+1, locked_at=? WHERE route_id=?",
                     (editor, ts, route_id))
    recompute_duration(conn, route_id)
    return validate_route(conn, route_id)


def _normal_manuscript(conn, exhibit_id: str, lang: str):
    return conn.execute(
        "SELECT id FROM manuscript WHERE exhibit_id=? AND lang=? AND audience='normal'",
        (exhibit_id, lang)).fetchone()


def card_narration_duration(conn, exhibit_id: str, lang: str):
    """优先已渲染音频时长；无资产则按文稿脚本与语速预计（标注 estimated）。"""
    row = _normal_manuscript(conn, exhibit_id, lang)
    if not row:
        return {"duration": 0.0, "source": "missing_manuscript"}
    mid = row["id"]
    d = audio.rendered_manuscript_duration(conn, mid, "segment")
    if d is not None:
        return {"duration": d, "source": "rendered"}
    return {"duration": audio.estimate_duration(
        services.render_script_text(conn, mid),
        conn.execute("SELECT rate_wpm FROM manuscript WHERE id=?", (mid,)).fetchone()["rate_wpm"]),
        "source": "estimated"}


def recompute_duration(conn, route_id: str) -> dict:
    r = conn.execute("SELECT * FROM route WHERE id=?", (route_id,)).fetchone()
    cards = conn.execute("SELECT * FROM route_card WHERE route_id=? ORDER BY seq",
                         (route_id,)).fetchall()
    total, estimated = 0.0, False
    breakdown = []
    for c in cards:
        narr = card_narration_duration(conn, c["exhibit_id"], r["lang"])
        trans = audio.estimate_duration(c["transition_text"], 190) if c["transition_text"] else 0.0
        subtotal = narr["duration"] + c["dwell"] + trans
        total += subtotal
        if narr["source"] == "estimated":
            estimated = True
        breakdown.append({"seq": c["seq"], "narration": narr, "dwell": c["dwell"],
                          "transition": round(trans, 3), "subtotal": round(subtotal, 3)})
    with db.tx(conn):
        conn.execute("UPDATE route SET duration=? WHERE id=?", (round(total, 3), route_id))
    return {"route_id": route_id, "duration": round(total, 3),
            "estimated": estimated, "breakdown": breakdown}


def validate_route(conn, route_id: str) -> dict:
    """撤展可达性验证：
    - 悬空卡片（展品缺失/撤展）不允许孤立删除：其前一张卡仍有“指路音频”会把观众带到空柜。
    - 规则：起点与终点必须可达；任意撤展卡使路线 invalid；
      连续两张撤展卡视为“可达顺序断裂”。需重排（移除或替换）后才能恢复 valid。
    """
    r = conn.execute("SELECT * FROM route WHERE id=?", (route_id,)).fetchone()
    cards = conn.execute("SELECT * FROM route_card WHERE route_id=? ORDER BY seq",
                         (route_id,)).fetchall()
    problems = []
    prev_bad = False
    for c in cards:
        ex = conn.execute("SELECT * FROM exhibit WHERE id=?", (c["exhibit_id"],)).fetchone()
        bad = ex is None or ex["withdrawn"] == 1
        label = (ex["code"] if ex else "?") + ("(已撤展)" if ex and ex["withdrawn"] else "")
        if bad:
            problems.append({
                "seq": c["seq"], "card_id": c["id"], "exhibit": label,
                "issue": "展品临时撤展：该卡片的解说与前序转场指路仍会把观众引向空展柜，"
                         "不能仅删除卡片，必须重排可达顺序"})
            if prev_bad:
                problems[-1]["issue"] += "；连续撤展点导致可达顺序断裂"
        prev_bad = bad

    valid = not problems
    msg = "可达顺序通过" if valid else f"{len(problems)} 处撤展/悬空点，路线待重排"
    with db.tx(conn):
        conn.execute("UPDATE route SET valid=?, validation_msg=? WHERE id=?",
                     (1 if valid else 0, msg, route_id))
    d = get_route(conn, route_id)
    return {"valid": valid, "validation_msg": msg, "problems": problems, "route": d}
