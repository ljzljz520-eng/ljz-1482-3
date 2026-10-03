"""数据库层：展品 / 共享事实 / 三语三受众文稿 / 稳定片段 / 音频任务 / 路线 / 导览包。"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS exhibit (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    hall TEXT NOT NULL,
    image_license_expires TEXT,          -- ISO 日期；NULL 表示无图片或永久授权
    withdrawn INTEGER NOT NULL DEFAULT 0,-- 临时撤展标记
    created_at REAL NOT NULL
);

-- 共享事实（展品事实，语言中立；修订留痕）
CREATE TABLE IF NOT EXISTS fact (
    id TEXT PRIMARY KEY,
    exhibit_id TEXT NOT NULL REFERENCES exhibit(id),
    topic TEXT NOT NULL,
    body TEXT NOT NULL,                 -- 当前事实陈述
    version INTEGER NOT NULL DEFAULT 1,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS fact_revision (
    id TEXT PRIMARY KEY,
    fact_id TEXT NOT NULL REFERENCES fact(id),
    version INTEGER NOT NULL,
    old_body TEXT,
    new_body TEXT NOT NULL,
    editor TEXT NOT NULL,
    created_at REAL NOT NULL
);

-- 文稿：展品 × 语言(zh/en/ja) × 受众(child/normal/expert)
-- per_language_review: 中文稿更新后，外语版本须独立复核，不被中文改动自动覆盖
CREATE TABLE IF NOT EXISTS manuscript (
    id TEXT PRIMARY KEY,
    exhibit_id TEXT NOT NULL REFERENCES exhibit(id),
    lang TEXT NOT NULL,
    audience TEXT NOT NULL,            -- child / normal / expert
    title TEXT NOT NULL,
    rate_wpm INTEGER NOT NULL DEFAULT 180,   -- 各受众独立语速
    status TEXT NOT NULL DEFAULT 'draft',    -- draft / pending_review / approved
    last_fact_version INTEGER NOT NULL DEFAULT 0,
    editor TEXT,
    updated_at REAL NOT NULL,
    UNIQUE(exhibit_id, lang, audience)
);

-- 文稿对事实的引用（多对多）。事实修订后，引用它的全部文稿进入 pending_review，
-- 但正文/措辞/语速不会被自动改写。
CREATE TABLE IF NOT EXISTS manuscript_fact (
    manuscript_id TEXT NOT NULL REFERENCES manuscript(id),
    fact_id TEXT NOT NULL REFERENCES fact(id),
    PRIMARY KEY (manuscript_id, fact_id)
);

-- 稳定片段身份：一句话一个稳定 segment_id（f"seg:{manuscript_id}#n"），
-- 改一句话只令该片段失效重做，其余缓存命中。
CREATE TABLE IF NOT EXISTS segment (
    id TEXT PRIMARY KEY,                -- seg:{manuscript_id}#1
    manuscript_id TEXT NOT NULL REFERENCES manuscript(id),
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    content_hash TEXT NOT NULL,         -- 该句内容哈希（措辞）
    rate_wpm INTEGER NOT NULL,          -- 录制时语速快照
    UNIQUE(manuscript_id, seq)
);

-- 音频/字幕/脚本资产：绑定 (稳定片段身份 + 内容哈希 + 语速 + 音色)
-- 整段重生成模式另产生 mode='whole' 的资产（key 含 manuscript）。
CREATE TABLE IF NOT EXISTS asset (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                -- audio / subtitle / script
    mode TEXT NOT NULL,                -- segment / whole
    segment_id TEXT,                   -- mode=segment 时必填
    manuscript_id TEXT NOT NULL,
    lang TEXT NOT NULL,
    voice TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    rate_wpm INTEGER NOT NULL,
    duration REAL NOT NULL DEFAULT 0,  -- 秒
    bytes INTEGER NOT NULL DEFAULT 0,
    storage_path TEXT,
    created_at REAL NOT NULL,
    UNIQUE(kind, mode, segment_id, manuscript_id, lang, voice, content_hash, rate_wpm)
);

-- 后端音频处理任务（可乱序完成；以 idempotency_key 去重；只重做受影响片段）
CREATE TABLE IF NOT EXISTS task (
    id TEXT PRIMARY KEY,
    idem_key TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,                -- render_manuscript
    manuscript_id TEXT NOT NULL,
    mode TEXT NOT NULL,                -- segment / whole
    voice TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,    -- 排队顺序
    status TEXT NOT NULL DEFAULT 'queued', -- queued / running / done / failed / superseded
    result_payload TEXT,
    error TEXT,
    created_at REAL NOT NULL,
    finished_at REAL
);

-- 路线：有序卡片 + 转场。卡片片段身份稳定（route_card:{route_id}#n），
-- 路线内解说文本（转场指路）也是稳定片段。
CREATE TABLE IF NOT EXISTS route (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    lang TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    duration REAL NOT NULL DEFAULT 0,
    valid INTEGER NOT NULL DEFAULT 1,
    validation_msg TEXT,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS route_card (
    id TEXT PRIMARY KEY,                -- route_card:{route_id}#n
    route_id TEXT NOT NULL REFERENCES route(id),
    seq INTEGER NOT NULL,
    exhibit_id TEXT REFERENCES exhibit(id), -- 撤展后允许悬空引用以便验证报错
    dwell REAL NOT NULL DEFAULT 10,
    transition_text TEXT NOT NULL DEFAULT '',
    transition_hash TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(route_id, seq)
);

-- 路线编辑锁（乐观并发：两人同时改，第二个提交得到冲突而非互相覆盖）
CREATE TABLE IF NOT EXISTS route_edit (
    route_id TEXT PRIMARY KEY REFERENCES route(id),
    editor TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    locked_at REAL NOT NULL
);

-- 导览包（按语言闭包）
CREATE TABLE IF NOT EXISTS package (
    id TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    route_id TEXT NOT NULL,
    semver TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'building', -- building / ready / blocked / published / exported
    closure_report TEXT,               -- JSON：缺口清单
    manifest TEXT,                     -- JSON：资产清单+哈希
    created_at REAL NOT NULL,
    published_at REAL,
    UNIQUE(route_id, lang, semver)
);

-- 离线导出（可断点续传；按 step 记录进度；中断后 resume 跳过已完成 step）
CREATE TABLE IF NOT EXISTS export_job (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES package(id),
    device_tag TEXT,
    status TEXT NOT NULL DEFAULT 'running', -- running / interrupted / done
    progress INTEGER NOT NULL DEFAULT 0,    -- 0..total_steps
    total_steps INTEGER NOT NULL DEFAULT 0,
    completed_steps TEXT NOT NULL DEFAULT '[]', -- JSON 数组
    bundle_path TEXT,
    updated_at REAL NOT NULL
);

-- 现场设备已装版本（用于离线包“更新状态”：up_to_date / update_available）
CREATE TABLE IF NOT EXISTS device_install (
    device_tag TEXT NOT NULL,
    lang TEXT NOT NULL,
    package_id TEXT NOT NULL,
    semver TEXT NOT NULL,
    installed_at REAL NOT NULL,
    PRIMARY KEY (device_tag, lang)
);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def connect(path: str = "museum.db") -> sqlite3.Connection:
    fresh = not os.path.exists(path)
    conn = sqlite3.connect(path, timeout=15, isolation_level=None)  # autocommit；事务统一由 tx() 管理
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if fresh:
        conn.executescript(SCHEMA)
        conn.commit()
    else:
        # 轻量迁移：开发原型直接确保表存在
        conn.executescript(SCHEMA)
        conn.commit()
    return conn


@contextmanager
def tx(conn: sqlite3.Connection):
    # isolation_level=None 下显式事务；保证多语句原子性与失败回滚
    conn.execute("BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
