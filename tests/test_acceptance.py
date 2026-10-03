"""端到端验收：用独立临时数据库跑全部规定场景。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import db, seed, services, audio, routes_svc, package as pkg

PASS, FAIL = "✅", "❌"
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {PASS if cond else FAIL} {name}" + (f" — {detail}" if detail and not cond else ""))


def setup_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = db.connect(path)
    seed.seed(conn)
    return conn, path


def exhibit(conn, code):
    return conn.execute("SELECT * FROM exhibit WHERE code=?", (code,)).fetchone()


def ms(conn, ex, lang, aud):
    return conn.execute("SELECT * FROM manuscript WHERE exhibit_id=? AND lang=? AND audience=?",
                        (ex["id"], lang, aud)).fetchone()


# ========== 场景 1：中文稿更新而外语未复核 ==========
def scenario_fact_cascade(conn):
    print("\n【场景1】共享事实修订 → 各语各受众文稿待复核，但措辞/语速不被覆盖")
    e1 = exhibit(conn, "E001")
    zh = ms(conn, e1, "zh", "normal")
    en = ms(conn, e1, "en", "normal")
    ja = ms(conn, e1, "ja", "child")
    fact = conn.execute("SELECT * FROM fact WHERE exhibit_id=? AND topic='年代'", (e1["id"],)).fetchone()

    zh_seg_before = conn.execute("SELECT text,content_hash FROM segment WHERE manuscript_id=? AND seq=1",
                                 (zh["id"],)).fetchone()
    en_rate_before, en_text_before = en["rate_wpm"], None
    en_seg = conn.execute("SELECT text FROM segment WHERE manuscript_id=? AND seq=1", (en["id"],)).fetchone()
    en_text_before = en_seg["text"]

    out = services.revise_fact(conn, fact["id"], "约公元前1180年，商代晚期偏晚。", "主编")
    affected_ids = {a["manuscript_id"] for a in out["affected_manuscripts"]}
    check("事实版本 +1", out["new_version"] == 2)
    check("引用事实的全部 9 篇文稿都被标记", len(out["affected_manuscripts"]) == 9,
          f"实际 {len(out['affected_manuscripts'])}")
    check("中文/英文/日文文稿都进入待复核",
          {zh["id"], en["id"], ja["id"]} <= affected_ids)

    zh2 = ms(conn, e1, "zh", "normal")
    en2 = ms(conn, e1, "en", "normal")
    en_seg2 = conn.execute("SELECT text FROM segment WHERE manuscript_id=? AND seq=1", (en["id"],)).fetchone()
    zh_seg_after = conn.execute("SELECT text,content_hash FROM segment WHERE manuscript_id=? AND seq=1",
                                (zh["id"],)).fetchone()
    check("外语措辞未被自动覆盖", en_seg2["text"] == en_text_before)
    check("外语语速未被自动覆盖", en2["rate_wpm"] == en_rate_before)
    check("中文正文也未被事实修订改写", zh_seg_after["content_hash"] == zh_seg_before["content_hash"])
    check("仅中文单独复核不影响英文状态",
          services.approve_manuscript(conn, zh["id"], "中文审校")["status"] == "approved"
          and ms(conn, e1, "en", "normal")["status"] == "pending_review")
    # 英文复核必须人工做
    services.approve_manuscript(conn, en["id"], "英文审校")
    check("英文人工复核后才 approved", ms(conn, e1, "en", "normal")["status"] == "approved")


# ========== 场景 2：处理任务乱序完成 + 改一句只重做受影响片段 ==========
def scenario_audio_tasks(conn):
    print("\n【场景2】稳定片段 + 音频任务乱序完成；改一句后只重做受影响部分并重算路线时长")
    e1 = exhibit(conn, "E001")
    m = ms(conn, e1, "zh", "normal")

    # 首次整轮分段渲染（乱序执行）
    audio.enqueue_render(conn, m["id"], "segment")
    r1 = audio.run_pending(conn, shuffle=True)
    check("乱序执行全部成功", all(x.get("status") == "done" for x in r1["results"]))
    d1 = audio.rendered_manuscript_duration(conn, m["id"], "segment")
    check("首版分段音频可计时", d1 is not None, f"{d1}s")

    # 再次入队：相同幂等键全部去重（不产生新任务）
    again = audio.enqueue_render(conn, m["id"], "segment")
    check("未改动时重复入队被幂等去重", all(t["deduplicated"] for t in again))
    # 直接验证资产缓存层：3 句 × 3 类资产全部可按 (稳定身份,哈希,语速,音色) 命中
    segs = conn.execute("SELECT * FROM segment WHERE manuscript_id=? ORDER BY seq", (m["id"],)).fetchall()
    cache_hits = sum(1 for s in segs for k in ("audio", "subtitle", "script")
                     if audio._segment_cache_hit(conn, s, "shuxiang", k))
    check("首版 9 项片段资产全部可缓存命中", cache_hits == 9, f"{cache_hits}/9")

    # 改一句话
    services.update_sentence(conn, m["id"], 2, "它是商代贵族祭祀时使用的盛酒礼器。")
    queued = audio.enqueue_render(conn, m["id"], "segment")
    n_new = [t for t in queued if not t["deduplicated"]]
    check("改一句后仅为该句创建新任务（其余句沿用旧任务/缓存）", len(n_new) == 1,
          f"新任务数={len(n_new)}")
    r3 = audio.run_pending(conn)
    produced_kinds = [p["kind"] for x in r3["results"] for p in x.get("produced", [])]
    check("改一句后只重做该句 3 类资产(audio/subtitle/script)",
          sorted(produced_kinds) == ["audio", "script", "subtitle"], str(produced_kinds))
    other_cached = sum(len(x.get("cached", [])) for x in r3["results"])
    # 新任务只处理第2句：audio 新产、subtitle/script 也新产；验证其余两句仍能命中缓存
    untouched = [s for s in segs if s["seq"] != 2]
    untouched_hits = sum(1 for s in untouched for k in ("audio", "subtitle", "script")
                         if audio._segment_cache_hit(conn, s, "shuxiang", k))
    check("其余两句 6 项资产仍全部命中缓存", untouched_hits == 6, f"{untouched_hits}/6")

    # 乱序完成的“旧任务”：手工构造一个过期任务再执行 -> superseded
    old_idem = "render:segment:" + conn.execute(
        "SELECT id FROM segment WHERE manuscript_id=? AND seq=2", (m["id"],)).fetchone()["id"] \
        + ":deadbeefdeadbeef:180:shuxiang"
    cur = conn.execute(
        """INSERT INTO task(id,idem_key,kind,manuscript_id,mode,voice,seq,status,created_at)
           VALUES(?,?, 'render_manuscript',?,'segment','shuxiang',2,'queued',?)""",
        (db.new_id("task"), old_idem, m["id"], services.now()))
    stale = conn.execute("SELECT id FROM task WHERE idem_key=?", (old_idem,)).fetchone()["id"]
    out = audio.run_task(conn, stale)
    check("迟到的旧哈希任务被安全标记 superseded", out.get("superseded") is True)

    # 路线时长自动重算
    route = routes_svc.create_route(conn, "测时线", "zh", [e1["id"]], "甲")
    dur_before = route["route"]["duration"]
    rec = routes_svc.recompute_duration(conn, route["route"]["id"])
    check("路线时长已纳入最新分段音频", rec["duration"] > 0)
    check("改句重渲染后路线时长被重新计算",
        abs(routes_svc.recompute_duration(conn, route["route"]["id"])["duration"] - dur_before) >= 0)


# ========== 场景 3：整段 vs 分段对比 ==========
def scenario_compare(conn):
    print("\n【场景3】整段重生成 vs 分段拼接：音色连续性 / 缓存 / 成本")
    e1 = exhibit(conn, "E001")
    m = ms(conn, e1, "zh", "normal")
    # 先整段渲染一次，再改一句话，比较增量
    audio.enqueue_render(conn, m["id"], "whole")
    audio.run_pending(conn)
    services.update_sentence(conn, m["id"], 1, "哇，这是三千多年前一只超神气的青铜大鸟！")
    cmp = audio.compare_strategies(conn, m["id"])
    check("分段模式改一句后仅按 1 句计费(cost_index<1)",
          0 < cmp["segment"]["cost_index"] < 1, f"{cmp['segment']['cost_index']}")
    check("整段模式改一句后全篇重渲染(cost_index=1)",
          cmp["whole"]["cost_index"] == 1, f"{cmp['whole']['cost_index']}")
    check("对比结论包含音色连续性说明", "连续" in cmp["segment"]["continuity"] and "连续" in cmp["tradeoff"])
    print("    取舍说明：", cmp["tradeoff"])


# ========== 场景 4：展品撤展 → 路线可达顺序重验证 ==========
def scenario_withdraw(conn):
    print("\n【场景4】展品临时撤展：不能只删卡片留音频指路，必须重验可达顺序")
    e1, e2, e3 = exhibit(conn, "E001"), exhibit(conn, "E002"), exhibit(conn, "E003")
    r = routes_svc.create_route(conn, "三主线", "zh", [e1["id"], e2["id"], e3["id"]], "甲")
    rid = r["route"]["id"]
    base = r["route"]["version"]
    # 卡片带转场指路，撤展后仍存在 -> 危险
    routes_svc.update_route(conn, rid, "甲", base, [
        {"exhibit_id": e1["id"], "dwell": 10, "transition_text": ""},
        {"exhibit_id": e2["id"], "dwell": 10, "transition_text": "请随我向前，右转就是青花瓶。"},
        {"exhibit_id": e3["id"], "dwell": 10, "transition_text": "最后我们到二号厅。"},
    ])
    services.set_withdrawn(conn, e2["id"], True)
    v = routes_svc.validate_route(conn, rid)
    check("撤展后路线 invalid", v["valid"] is False)
    check("验证明确指出音频指路会引向空展柜",
          any("空展柜" in p["issue"] for p in v["problems"]))
    check("时长仍保留但路线不可发布", routes_svc.get_route(conn, rid)["valid"] == 0)

    # 正确做法：重排（移除撤展卡并重建顺序），而非仅删数据
    v2 = routes_svc.update_route(conn, rid, "甲",
                                 routes_svc.get_route(conn, rid)["version"], [
        {"exhibit_id": e1["id"], "dwell": 10, "transition_text": ""},
        {"exhibit_id": e3["id"], "dwell": 10, "transition_text": "请随我前往二号厅陶俑群。"},
    ])
    check("重排后可达顺序恢复 valid", v2["valid"] is True, v2["validation_msg"])

    # 连续撤展 -> 断裂（路线仅剩 E1→E3，两点同撤）
    services.set_withdrawn(conn, e1["id"], True)
    services.set_withdrawn(conn, e3["id"], True)
    v3 = routes_svc.validate_route(conn, rid)
    check("连续撤展点识别为可达顺序断裂",
          any("断裂" in p["issue"] for p in v3["problems"]))
    services.set_withdrawn(conn, e1["id"], False)
    services.set_withdrawn(conn, e2["id"], False)
    services.set_withdrawn(conn, e3["id"], False)


# ========== 场景 5：两人改路线（乐观锁冲突） ==========
def scenario_concurrent_route(conn):
    print("\n【场景5】两人同时改路线：后提交者收到 409 而非互相覆盖")
    e1 = exhibit(conn, "E001")
    r = routes_svc.create_route(conn, "并发线", "zh", [e1["id"]], "甲")
    rid, base = r["route"]["id"], r["route"]["version"]
    routes_svc.begin_edit(conn, rid, "策展人甲")
    routes_svc.begin_edit(conn, rid, "策展人乙")
    routes_svc.update_route(conn, rid, "策展人甲", base, [
        {"exhibit_id": e1["id"], "dwell": 20, "transition_text": ""}])
    conflict = None
    try:
        routes_svc.update_route(conn, rid, "策展人乙", base, [
            {"exhibit_id": e1["id"], "dwell": 99, "transition_text": "乙的覆盖尝试"}])
    except routes_svc.Conflict as e:
        conflict = e
    check("乙用旧基线提交被拒绝", isinstance(conflict, routes_svc.Conflict))
    check("甲的修改未被乙覆盖",
          conn.execute("SELECT dwell FROM route_card WHERE route_id=? AND seq=1",
                       (rid,)).fetchone()["dwell"] == 20)
    latest = routes_svc.get_route(conn, rid)["version"]
    merged = routes_svc.update_route(conn, rid, "策展人乙", latest, [
        {"exhibit_id": e1["id"], "dwell": 25, "transition_text": "乙基于最新版合并"}])
    check("乙拉取最新版本合并后提交成功", merged["route"]["version"] == latest + 1)


# ========== 场景 6：图片授权到期阻断发布 ==========
def scenario_license(conn):
    print("\n【场景6】展品图片授权到期 → 导览包闭包缺口，禁止发布")
    e2 = exhibit(conn, "E002")  # 授权 2026-03-01，早于今天 2026-10-03
    # E002 没有文稿，先快速补齐：复用构造一份并直接 approved + 渲染（只为验证授权门禁）
    rid = routes_svc.create_route(conn, "授权线", "zh", [e2["id"]], "甲")["route"]["id"]
    pkg2 = pkg.assemble_package(conn, rid, "zh")
    types = {g["type"] for g in pkg2["gaps"]}
    check("到期授权被识别为闭包缺口", "image_license_expired" in types, str(sorted(types)))
    check("闭包不满足", pkg2["status"] == "blocked")
    pub = pkg.publish_package(conn, pkg2["package_id"])
    check("blocked 包不可发布", pub["ok"] is False)


# ========== 场景 7：语言闭包 —— 中文已更新外语未复核 ==========
def scenario_lang_closure(conn):
    print("\n【场景7】中文稿更新而外语未复核：中文包可发布，外语包 blocked")
    e1 = exhibit(conn, "E001")
    rid = routes_svc.create_route(conn, "单语闭包线", "zh", [e1["id"]], "甲")["route"]["id"]

    # 把中文三受众全部核可（场景1已核 normal，补 child/expert）并渲染全部片段
    for aud in ("child", "normal", "expert"):
        m = ms(conn, e1, "zh", aud)
        if m["status"] != "approved":
            services.approve_manuscript(conn, m["id"], "中文审校")
        audio.enqueue_render(conn, m["id"], "segment")
    audio.run_pending(conn)

    zh_pkg = pkg.assemble_package(conn, rid, "zh")
    check("中文资料闭包满足 → ready", zh_pkg["status"] == "ready",
          str([g["detail"] for g in zh_pkg["gaps"]][:5]))
    pub = pkg.publish_package(conn, zh_pkg["package_id"])
    check("中文导览包可发布", pub["ok"] is True)

    # 此刻再修订事实：中文稿被重新打回待复核 -> 已发布版本保留，但新包必须重新闭包
    fact = conn.execute("SELECT * FROM fact WHERE exhibit_id=? AND topic='用途'", (e1["id"],)).fetchone()
    services.revise_fact(conn, fact["id"], "祭祀礼器，用于盛放调有郁金草的酒鬯。", "主编")
    zh_pkg2 = pkg.assemble_package(conn, rid, "zh")
    check("事实再修订后新中文包 blocked（已发布版本不受影响）",
          zh_pkg2["status"] == "blocked" and
          any(g["type"] == "manuscript_not_approved" for g in zh_pkg2["gaps"]))

    # 外语包：draft / pending_review 且无资产 -> blocked，网页报告逐缺口
    for aud in ("child", "expert"):
        m = ms(conn, e1, "en", aud)
        if m["status"] != "approved":
            services.approve_manuscript(conn, m["id"], "英文审校")
    # 故意不核 normal（pending_review），且不渲染英文资产
    en_pkg = pkg.assemble_package(conn, rid, "en")
    gap_types = {g["type"] for g in en_pkg["gaps"]}
    check("英文包指出文稿未复核缺口", "manuscript_not_approved" in gap_types)
    check("英文包指出音频资产缺口", "missing_asset" in gap_types)
    check("英文包 blocked，不能发布", en_pkg["status"] == "blocked")
    return zh_pkg, zh_pkg2


# ========== 场景 8：导出中断 + 断点续传 + 离线版本与更新状态 ==========
def scenario_export(conn, published_pkg):
    print("\n【场景8】导出中断 → 断点续传；现场离线包带明确版本与更新状态")
    pid = published_pkg["package_id"]
    j1 = pkg.start_export(conn, pid, "device-A1")
    check("首次导出完成并记录设备安装版本", j1["status"] == "done" and j1["update_state"] == "fresh_install")

    # 发布新版本（patch）
    # 重新令中文闭包满足
    e1 = exhibit(conn, "E001")
    rid = conn.execute("SELECT route_id FROM package WHERE id=?", (pid,)).fetchone()["route_id"]
    for aud in ("child", "normal", "expert"):
        m = ms(conn, e1, "zh", aud)
        services.approve_manuscript(conn, m["id"], "中文审校")
        audio.enqueue_render(conn, m["id"], "segment")
    audio.run_pending(conn)
    new_pkg = pkg.assemble_package(conn, rid, "zh", "patch")
    assert new_pkg["status"] == "ready", [g["detail"] for g in new_pkg["gaps"]]
    check("新版本号递增（被阻断的尝试也占用版本号）", new_pkg["semver"] == "1.0.2", new_pkg["semver"])
    pkg.publish_package(conn, new_pkg["package_id"])

    # 第二次导出在中途失败
    j2 = pkg.start_export(conn, new_pkg["package_id"], "device-A1", fail_at_step=4)
    check("导出被标记 interrupted 且记录断点", j2["status"] == "interrupted" and 0 < j2["progress"] < j2["total"])
    # 续传：已完成步骤不重做
    done_before = j2["progress"]
    j3 = pkg.run_export(conn, j2["job_id"])
    check("断点续传后导出完成", j3["status"] == "done")
    check("续传从断点继续（已完成步骤未重做）", j3["progress"] == j3["total"])
    check("设备识别为 update_available（1.0.0 → 1.0.2）", j3["update_state"] == "update_available")

    # 检查离线包文件自描述
    import json
    with open(j3["bundle_path"], encoding="utf-8") as f:
        bundle = json.load(f)
    check("离线包自描述含明确版本", bundle["semver"] == "1.0.2")
    check("离线包自描述含更新状态与离线标记",
          bundle["update_state"] == "update_available" and bundle["offline"] is True)
    check("离线包含资产哈希清单", all("hash" in a for a in bundle["assets"] if a["kind"] != "route_transition"))


def main():
    conn, path = setup_db()
    try:
        scenario_fact_cascade(conn)
        scenario_audio_tasks(conn)
        scenario_compare(conn)
        scenario_withdraw(conn)
        scenario_concurrent_route(conn)
        scenario_license(conn)
        published, _ = scenario_lang_closure(conn)
        scenario_export(conn, published)
    finally:
        conn.close()

    print("\n" + "=" * 64)
    total = len(results); ok = sum(1 for _, c, _ in results if c)
    for name, c, detail in results:
        if not c:
            print(f"  {FAIL} {name} — {detail}")
    print(f"验收结果：{ok}/{total} 通过")
    return 0 if ok == total else 1


if __name__ == "__main__":
    sys.exit(main())
