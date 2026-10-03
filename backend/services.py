"""核心领域服务。

关键不变量：
1) 共享事实修订 -> 引用它的各语言/各受众文稿 status='pending_review'，
   但 segment 文本（措辞）与 rate_wpm（语速）绝不被自动覆盖。
2) 片段以稳定身份 seg:{manuscript_id}#seq 存在；改一句话仅该片段哈希变化，
   音频/字幕/脚本按 (稳定身份, 哈希, 语速, 音色) 缓存，只重做受影响片段。
3) 中文稿更新不代表外语已复核；各语言文稿有独立 status。
"""
from __future__ import annotations

import hashlib
import json
import time

from . import db

LANGS = ("zh", "en", "ja")
AUDIENCES = ("child", "normal", "expert")


# ---------- 工具 ----------
def now() -> float:
    return time.time()


def h(text: str) -> str:
    return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()[:16]


def split_sentences(text: str) -> list[str]:
    """按中英文句读切句，保留非空片段。"""
    out, buf = [], []
    for ch in text:
        buf.append(ch)
        if ch in "。！？!?；;\n":
            s = "".join(buf).strip()
            if s:
                out.append(s)
            buf = []
    s = "".join(buf).strip()
    if s:
        out.append(s)
    return out


# ---------- 展品 ----------
def list_exhibits(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM exhibit ORDER BY code")]


def set_withdrawn(conn, exhibit_id: str, withdrawn: bool):
    with db.tx(conn):
        conn.execute("UPDATE exhibit SET withdrawn=? WHERE id=?",
                     (1 if withdrawn else 0, exhibit_id))
    return {"exhibit_id": exhibit_id, "withdrawn": withdrawn}


# ---------- 共享事实修订（级联待复核，不覆盖措辞/语速） ----------
def revise_fact(conn, fact_id: str, new_body: str, editor: str):
    fact = conn.execute("SELECT * FROM fact WHERE id=?", (fact_id,)).fetchone()
    if not fact:
        raise ValueError("fact not found")
    if new_body.strip() == fact["body"].strip():
        return {"fact_id": fact_id, "changed": False, "affected_manuscripts": []}

    ts = now()
    affected = []
    with db.tx(conn):
        new_version = fact["version"] + 1
        conn.execute(
            "INSERT INTO fact_revision(id,fact_id,version,old_body,new_body,editor,created_at) VALUES(?,?,?,?,?,?,?)",
            (db.new_id("fr"), fact_id, new_version, fact["body"], new_body, editor, ts),
        )
        conn.execute("UPDATE fact SET body=?, version=?, updated_at=? WHERE id=?",
                     (new_body, new_version, ts, fact_id))

        # 仅级联“状态”，不动 segment.text / rate_wpm / title
        rows = conn.execute(
            """SELECT m.id, m.lang, m.audience, m.status FROM manuscript m
               JOIN manuscript_fact mf ON mf.manuscript_id=m.id
               WHERE mf.fact_id=?""", (fact_id,)).fetchall()
        for r in rows:
            conn.execute(
                "UPDATE manuscript SET status='pending_review', last_fact_version=?, updated_at=? WHERE id=?",
                (new_version, ts, r["id"]))
            affected.append({"manuscript_id": r["id"], "lang": r["lang"],
                             "audience": r["audience"], "from_status": r["status"]})
    return {"fact_id": fact_id, "changed": True, "new_version": new_version,
            "affected_manuscripts": affected}


# ---------- 文稿编辑：改一句话 -> 仅该稳定片段哈希变化 ----------
def update_sentence(conn, manuscript_id: str, seq: int, new_text: str):
    seg = conn.execute("SELECT * FROM segment WHERE manuscript_id=? AND seq=?",
                       (manuscript_id, seq)).fetchone()
    if not seg:
        raise ValueError("segment not found")
    new_hash = h(new_text)
    changed = new_hash != seg["content_hash"]
    if changed:
        with db.tx(conn):
            # 稳定身份 seg id 不变，只更新文本与哈希
            conn.execute("UPDATE segment SET text=?, content_hash=? WHERE id=?",
                         (new_text, new_hash, seg["id"]))
            conn.execute("UPDATE manuscript SET status='pending_review', updated_at=? WHERE id=?",
                         (now(), manuscript_id))
    return {"segment_id": seg["id"], "seq": seq, "changed": changed,
            "old_hash": seg["content_hash"], "new_hash": new_hash}


def set_rate(conn, manuscript_id: str, rate_wpm: int):
    if not (100 <= rate_wpm <= 300):
        raise ValueError("rate out of range")
    with db.tx(conn):
        conn.execute("UPDATE manuscript SET rate_wpm=?, updated_at=? WHERE id=?",
                     (rate_wpm, now(), manuscript_id))
    return {"manuscript_id": manuscript_id, "rate_wpm": rate_wpm}


def approve_manuscript(conn, manuscript_id: str, reviewer: str):
    """逐语言独立复核：编辑确认措辞未受事实修订影响（或已手工改稿）后通过。"""
    m = conn.execute("SELECT * FROM manuscript WHERE id=?", (manuscript_id,)).fetchone()
    if not m:
        raise ValueError("manuscript not found")
    with db.tx(conn):
        conn.execute(
            "UPDATE manuscript SET status='approved', editor=?, updated_at=? WHERE id=?",
            (reviewer, now(), manuscript_id))
    return {"manuscript_id": manuscript_id, "status": "approved", "lang": m["lang"]}


def manuscript_detail(conn, manuscript_id: str):
    m = conn.execute("SELECT * FROM manuscript WHERE id=?", (manuscript_id,)).fetchone()
    if not m:
        raise ValueError("manuscript not found")
    segs = [dict(r) for r in conn.execute(
        "SELECT * FROM segment WHERE manuscript_id=? ORDER BY seq", (manuscript_id,))]
    facts = [dict(r) for r in conn.execute(
        """SELECT f.* FROM fact f JOIN manuscript_fact mf ON mf.fact_id=f.id
           WHERE mf.manuscript_id=? ORDER BY f.topic""", (manuscript_id,))]
    d = dict(m)
    d["segments"] = segs
    d["facts"] = facts
    return d


def list_manuscripts(conn, exhibit_id=None, lang=None):
    q = "SELECT * FROM manuscript WHERE 1=1"
    args = []
    if exhibit_id:
        q += " AND exhibit_id=?"; args.append(exhibit_id)
    if lang:
        q += " AND lang=?"; args.append(lang)
    q += " ORDER BY exhibit_id, lang, audience"
    return [dict(r) for r in conn.execute(q, args)]


def render_script_text(conn, manuscript_id: str) -> str:
    rows = conn.execute("SELECT text FROM segment WHERE manuscript_id=? ORDER BY seq",
                        (manuscript_id,)).fetchall()
    return " ".join(r["text"] for r in rows)
