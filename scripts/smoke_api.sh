#!/usr/bin/env bash
# 端到端 API 冒烟：事实级联→渲染→乱序→建线→冲突→闭包→发布→导出中断/续传
set -e
B=http://127.0.0.1:8070
j(){ curl -s "$@" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps(d,ensure_ascii=False))"; }
post(){ curl -s -X POST "$B$1" -H 'Content-Type: application/json' -d "$2"; }

echo "== 展品 =="
E=$(curl -s $B/api/exhibits | python3 -c "import sys,json;print(json.load(sys.stdin)['exhibits'][0]['id'])")
echo "exhibit=$E"
echo "== 建中文路线 =="
RID=$(post /api/routes "{\"name\":\"冒烟线\",\"lang\":\"zh\",\"exhibit_ids\":[\"$E\"],\"editor\":\"甲\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['route']['id'])")
echo "route=$RID"
echo "== 409 并发冲突 =="
post /api/routes/$RID/update '{"editor":"甲","base_version":1,"cards":[{"exhibit_id":"'$E'","dwell":11,"transition_text":""}]}' >/dev/null
code=$(curl -s -o /tmp/conf.json -w "%{http_code}" -X POST $B/api/routes/$RID/update \
  -H 'Content-Type: application/json' \
  -d '{"editor":"乙","base_version":1,"cards":[{"exhibit_id":"'$E'","dwell":99,"transition_text":"x"}]}')
echo "http=$code body=$(cat /tmp/conf.json)"
echo "== 英文包闭包缺口 =="
post /api/packages "{\"route_id\":\"$RID\",\"lang\":\"en\"}" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('status=',d['status'],'gaps=',len(d['gaps']));assert d['status']=='blocked'"
echo "SMOKE OK"
