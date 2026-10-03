#!/usr/bin/env bash
# 启动博物馆导览制作间（仅 Python3 标准库 + 浏览器）
set -e
cd "$(dirname "$0")"
[ -f museum.db ] || { python3 -c "from backend import db; from backend.seed import seed as s; c=db.connect(); s(c); c.close()"; }
exec python3 -u -m backend.api
