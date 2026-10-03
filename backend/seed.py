"""演示数据：同一共享事实被三语三受众文稿引用。"""
from __future__ import annotations

import time

from . import db


def seed(conn) -> None:
    if conn.execute("SELECT COUNT(*) c FROM exhibit").fetchone()["c"]:
        return
    now = time.time()

    exhibits = [
        ("E001", "青铜神鸟尊", "一号厅", "2027-06-30"),
        ("E002", "青花缠枝莲纹瓶", "一号厅", "2026-03-01"),  # 验收用：授权临近/已到期场景
        ("E003", "彩绘陶俑群", "二号厅", None),
    ]
    for code, name, hall, lic in exhibits:
        conn.execute(
            "INSERT INTO exhibit(id,code,name,hall,image_license_expires,created_at) VALUES(?,?,?,?,?,?)",
            (db.new_id("ex"), code, name, hall, lic, now),
        )

    e1 = conn.execute("SELECT id FROM exhibit WHERE code='E001'").fetchone()["id"]
    e2 = conn.execute("SELECT id FROM exhibit WHERE code='E002'").fetchone()["id"]
    e3 = conn.execute("SELECT id FROM exhibit WHERE code='E003'").fetchone()["id"]

    facts = {
        "f_age": (e1, "年代", "约公元前1200年，商代晚期。"),
        "f_use": (e1, "用途", "祭祀礼器，用于盛放酒鬯。"),
        "f_bird": (e1, "纹饰", "器盖与器身立体凤鸟，象征通神使者。"),
        "f_porcelain": (e2, "瓷种", "景德镇官窑青花瓷，明永乐年间。"),
        "f_army": (e3, "阵列", "陶俑以军阵排列，共修复展示二十二件。"),
    }
    fact_ids = {}
    for key, (ex, topic, body) in facts.items():
        fid = db.new_id("fact")
        fact_ids[key] = fid
        conn.execute(
            "INSERT INTO fact(id,exhibit_id,topic,body,version,updated_at) VALUES(?,?,?,?,1,?)",
            (fid, ex, topic, body, now),
        )

    # 文稿：三语 × 三受众。措辞与语速各异；中文先成稿，外语标记 draft 以演示语言闭包。
    copy = {
        "zh": {
            "child":  ("会飞的青铜小鸟", ["快看！这只青铜大鸟背上站着小鸟，", "它生活在三千多年前，", "古人把它当作和神灵说话的小信使哟。"], 210),
            "normal": ("青铜神鸟尊导览", ["这件神鸟尊约铸于商代晚期，", "是祭祀时盛酒的礼器。", "盖部凤鸟被视为沟通天地的使者。"], 180),
            "expert": ("青铜神鸟尊考释", ("器表凤鸟纹与器盖立鸟构成三位一体的神鸟母题；"
                                          "形制与殷墟花园庄东地 M54 出土器物接近，"
                                          "铸造使用分铸与铆接工艺，铅同位素示踪指向西南矿料。").split("，"), 150),
        },
        "en": {
            "child":  ("The Little Bronze Bird", ["Look! A little bird stands on this big bronze bird.",
                                                  "It lived over three thousand years ago.",
                                                  "People long ago saw it as a messenger to the spirits."], 200),
            "normal": ("Bronze Bird Vessel Guide", ["This bird-shaped vessel was cast in the late Shang dynasty.",
                                                    "It held ritual wine during ceremonies.",
                                                    "The phoenix on its lid links earth and heaven."], 170),
            "expert": ("Bronze Bird Vessel: Notes", ["The avian motif combines applied birds and cast relief.",
                                                     "Parallels exist with Huayuanzhuang M54 at Yinxu.",
                                                     "Piece-mould casting plus riveting; isotopes point southwest."], 145),
        },
        "ja": {
            "child":  ("とぶ青銅の小鳥", ["見て！大きな青銅の鳥の上に小鳥がいるよ。",
                                         "3000年以上むかしに生きていたんだ。",
                                         "神さまへのおてつだいをする鳥だと考えられていたよ。"], 200),
            "normal": ("青銅神鳥尊のご案内", ["この神鳥尊は商代晩期の鋳造です。",
                                              "祭祀で酒を入れた礼器でした。",
                                              "ふたの鳳凰は天地をつなぐ使者とされます。"], 170),
            "expert": ("青銅神鳥尊考釈", ["鳳凰文と立体の鳥が神鳥モチーフを構成する。",
                                         "殷墟花園荘東地M54出土品に近似する。",
                                         "分鋳と鋲接、鉛同位体は西南鉱床を示す。"], 145),
        },
    }
    refs = [fact_ids["f_age"], fact_ids["f_use"], fact_ids["f_bird"]]
    for lang, auds in copy.items():
        for aud, (title, sentences, rate) in auds.items():
            mid = db.new_id("ms")
            # 中文初稿为 approved；外语为 draft（验收：中文更新而外语未复核）
            status = "approved" if lang == "zh" else "draft"
            conn.execute(
                """INSERT INTO manuscript(id,exhibit_id,lang,audience,title,rate_wpm,status,
                   last_fact_version,editor,updated_at)
                   VALUES(?,?,?,?,?,?,?,1,'seed',?)""",
                (mid, e1, lang, aud, title, rate, status, now),
            )
            for fid in refs:
                conn.execute("INSERT INTO manuscript_fact(manuscript_id,fact_id) VALUES(?,?)", (mid, fid))
            for i, sent in enumerate(sentences, 1):
                import hashlib
                h = hashlib.sha256(sent.strip().encode()).hexdigest()[:16]
                sid = f"seg:{mid}#{i}"
                conn.execute(
                    "INSERT INTO segment(id,manuscript_id,seq,text,content_hash,rate_wpm) VALUES(?,?,?,?,?,?)",
                    (sid, mid, i, sent, h, rate),
                )

    print("seed done")


if __name__ == "__main__":
    conn = db.connect()
    seed(conn)
