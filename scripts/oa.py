#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["requests>=2.31"]
# ///
import argparse
import json
import os
import sys
from http.cookiejar import MozillaCookieJar
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings()

SKILL_DIR = Path(__file__).resolve().parent.parent
COOKIE_JAR = Path.home() / ".cache" / "ecology9-oa" / "cookies.txt"
TIMEOUT = 30


def load_config():
    base = os.environ.get("OA_BASE")
    user = os.environ.get("OA_USER")
    pwd = os.environ.get("OA_PASS")
    cfg_path = SKILL_DIR / "config.json"
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        base = base or cfg.get("base")
        user = user or cfg.get("user")
        pwd = pwd or cfg.get("pass")
    missing = [k for k, v in (("OA_BASE", base), ("OA_USER", user), ("OA_PASS", pwd)) if not v]
    if missing:
        sys.exit(f"缺少配置: {', '.join(missing)}，请设置环境变量或创建 {cfg_path}")
    return base.rstrip("/"), user, pwd


def new_session():
    return requests.Session()


def save_cookies(session):
    COOKIE_JAR.parent.mkdir(parents=True, exist_ok=True)
    jar = MozillaCookieJar(str(COOKIE_JAR))
    for c in session.cookies:
        jar.set_cookie(c)
    jar.save(ignore_discard=True, ignore_expires=True)


def load_cookies(session):
    if not COOKIE_JAR.exists():
        return False
    jar = MozillaCookieJar(str(COOKIE_JAR))
    jar.load(ignore_discard=True, ignore_expires=True)
    for c in jar:
        session.cookies.set_cookie(c)
    return True


def web_login(base, user, pwd):
    s = new_session()
    s.get(f"{base}/login/Login.jsp", timeout=TIMEOUT, verify=False)
    r = s.post(
        f"{base}/login/VerifyLogin.jsp",
        data={"loginid": user, "userpassword": pwd, "logintype": "1", "isremember": "1"},
        timeout=TIMEOUT,
        verify=False,
    )
    r.encoding = r.apparent_encoding or "utf-8"
    if "RemindLogin.jsp" not in r.text:
        sys.exit(f"网页登录失败（账号或密码错误？），VerifyLogin.jsp 返回片段: {r.text[:200]!r}")
    # 走完登录跳转链，会话才完全生效
    s.get(f"{base}/login/RemindLogin.jsp?RedirectFile=/wui/main.jsp", timeout=TIMEOUT, verify=False)
    s.get(f"{base}/wui/main.jsp", timeout=TIMEOUT, verify=False)
    s.get(f"{base}/wui/index.html", timeout=TIMEOUT, verify=False)
    save_cookies(s)
    return s


def get_session(base, user, pwd, force=False):
    s = new_session()
    if not force and load_cookies(s):
        try:
            r = s.get(f"{base}/api/hrm/user/currentUser", timeout=TIMEOUT, verify=False)
            if "登录信息超时" not in r.text:
                return s
        except requests.RequestException:
            pass
    return web_login(base, user, pwd)


def print_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def unwrap(resp):
    try:
        data = resp.json()
    except ValueError:
        sys.exit(f"非 JSON 响应 (HTTP {resp.status_code}): {resp.text[:300]!r}")
    if isinstance(data, dict) and data.get("code") not in (None, "SUCCESS"):
        sys.exit(f"接口错误: {json.dumps(data, ensure_ascii=False)[:800]}")
    return data


def cmd_login(args, cfg):
    base, user, pwd = cfg
    get_session(base, user, pwd, force=True)
    print("登录成功")


def cmd_workflows(args, cfg):
    base, user, pwd = cfg
    s = get_session(base, user, pwd)
    data = unwrap(s.post(f"{base}/api/workflow/paService/getCreateWorkflowList",
                         json={}, timeout=TIMEOUT, verify=False))
    for w in data or []:
        print(f"{w.get('workflowId')}\t{w.get('workflowTypeName')}\t{w.get('workflowName')}")


def cmd_fields(args, cfg):
    base, user, pwd = cfg
    s = get_session(base, user, pwd)
    data = unwrap(s.get(f"{base}/api/workflow/paService/getCreateWorkflowRequestInfo",
                        params={"workflowId": args.workflow_id},
                        timeout=TIMEOUT, verify=False))
    info = data.get("data", data)
    recs = (info.get("workflowMainTableInfo") or {}).get("requestRecords") or []
    if args.json:
        print_json(info)
        return
    for r in recs:
        for f in r.get("workflowRequestTableFields") or []:
            unsupported = "[该字段暂不支持]" in str(f.get("fieldShowValue", ""))
            mark = " *必填" if f.get("mand") else ""
            mark += " *不支持API赋值" if unsupported else ""
            print(f"{f.get('fieldName',''):20s} {f.get('fieldShowName',''):15s} "
                  f"html={f.get('fieldHtmlType')} value={f.get('fieldValue')!r}{mark}")
    for dt in info.get("workflowDetailTableInfos") or []:
        print(f"--- 明细表 {dt.get('tableDBName')}")
        for rec in dt.get("workflowRequestTableRecords") or []:
            for f in rec.get("workflowRequestTableFields") or []:
                unsupported = "[该字段暂不支持]" in str(f.get("fieldShowValue", ""))
                mark = " *必填" if f.get("mand") else ""
                mark += " *不支持API赋值" if unsupported else ""
                print(f"{f.get('fieldName',''):20s} {f.get('fieldShowName',''):15s} "
                      f"html={f.get('fieldHtmlType')} value={f.get('fieldValue')!r}{mark}")


def cmd_create(args, cfg):
    base, user, pwd = cfg
    s = get_session(base, user, pwd)
    main = [{"fieldName": k, "fieldValue": v} for k, v in args.field]
    if args.fields_json:
        for item in json.loads(args.fields_json):
            main.append({"fieldName": item["name"], "fieldValue": str(item["value"])})
    payload = {}
    if args.details_json:
        rows = json.loads(args.details_json)
        info = unwrap(s.get(f"{base}/api/workflow/paService/getCreateWorkflowRequestInfo",
                            params={"workflowId": args.workflow_id},
                            timeout=TIMEOUT, verify=False))
        details = (info.get("data", info).get("workflowDetailTableInfos")) or []
        if not details:
            sys.exit("该流程没有明细表，但传了 --details-json")
        rows = [[{"fieldName": k, "fieldValue": str(v)} for k, v in row.items()]
                if isinstance(row, dict) else row for row in rows]
        payload["detailData"] = [{
            "tableDBName": details[0]["tableDBName"],
            "workflowRequestTableRecords": [
                {"recordOrder": i, "workflowRequestTableFields": f} for i, f in enumerate(rows)
            ],
        }]
    payload.update({
        "workflowId": str(args.workflow_id),
        "requestName": args.title,
        "mainData": main,
    })
    data = unwrap(s.post(f"{base}/api/workflow/paService/doCreateRequest",
                         json=payload, timeout=TIMEOUT, verify=False))
    result = data.get("data", data)
    print(result.get("requestid") if isinstance(result, dict) else result)


def cmd_get(args, cfg):
    base, user, pwd = cfg
    s = get_session(base, user, pwd)
    data = unwrap(s.get(f"{base}/api/workflow/paService/getWorkflowRequest",
                        params={"requestId": args.request_id},
                        timeout=TIMEOUT, verify=False))
    print_json(data.get("data", data))


def cmd_todo(args, cfg):
    base, user, pwd = cfg
    s = get_session(base, user, pwd)
    count = s.post(f"{base}/api/workflow/paService/getToDoWorkflowRequestCount",
                   json={}, timeout=TIMEOUT, verify=False).text
    data = unwrap(s.post(f"{base}/api/workflow/paService/getToDoWorkflowRequestList",
                         json={}, timeout=TIMEOUT, verify=False))
    print(f"# 待办 {count.strip()} 条")
    for it in data or []:
        print(f"{it.get('requestId')}\t{it.get('requestName')}\t[{it.get('status')}] "
              f"节点={it.get('currentNodeName')} 创建人={it.get('creatorName')} {it.get('createTime')}")


LIST_ENDPOINTS = {
    "all": "getAllWorkflowRequestList",
    "doing": "getDoingWorkflowRequestList",
    "processed": "getProcessedWorkflowRequestList",
    "toread": "getToBeReadWorkflowRequestList",
    "cc": "getCCWorkflowRequestList",
    "my": "getMyWorkflowRequestList",
}


def cmd_list(args, cfg):
    base, user, pwd = cfg
    s = get_session(base, user, pwd)
    data = unwrap(s.post(f"{base}/api/workflow/paService/{LIST_ENDPOINTS[args.kind]}",
                         json={}, timeout=TIMEOUT, verify=False))
    for it in data or []:
        print(f"{it.get('requestId')}\t{it.get('requestName')}\t[{it.get('status')}] "
              f"创建人={it.get('creatorName')} {it.get('createTime')}")


def cmd_api(args, cfg):
    base, user, pwd = cfg
    s = get_session(base, user, pwd)
    body = json.loads(args.json) if args.json else {}
    r = s.request(args.method, f"{base}{args.path}", json=body,
                  timeout=TIMEOUT, verify=False)
    try:
        print_json(r.json())
    except ValueError:
        print(r.text)


def main():
    parser = argparse.ArgumentParser(description="泛微 E-cology 9 OA REST 工具（会话认证）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("login", help="强制重新登录（网页登录，缓存 cookie）")
    sub.add_parser("workflows", help="列出当前用户可发起的流程")

    p = sub.add_parser("fields", help="查看流程表单字段（发起前必看）")
    p.add_argument("workflow_id")
    p.add_argument("--json", action="store_true", help="输出完整 JSON")

    p = sub.add_parser("create", help="发起流程")
    p.add_argument("--workflow-id", required=True)
    p.add_argument("--title", required=True, help="流程标题")
    p.add_argument("--field", action="append", nargs=2, metavar=("NAME", "VALUE"),
                   default=[], help="表单字段(fieldName)，可多次，如 --field name 测试会议")
    p.add_argument("--fields-json", help='JSON 数组，如 [{"name":"name","value":"测试会议"}]')
    p.add_argument("--details-json", help='明细表行数组，如 [{"xm":"1234","ksrq":"2026-11-20"}]，'
                   'tableDBName 自动获取，仅支持第一个明细表')

    p = sub.add_parser("get", help="查看流程请求详情")
    p.add_argument("request_id")

    sub.add_parser("todo", help="待办列表")

    p = sub.add_parser("list", help="其他流程列表")
    p.add_argument("kind", choices=sorted(LIST_ENDPOINTS))

    p = sub.add_parser("api", help="调用任意 REST 接口（如审批 submitRequest）")
    p.add_argument("method", choices=["GET", "POST"])
    p.add_argument("path", help="如 /api/workflow/paService/submitRequest")
    p.add_argument("json", nargs="?", help="请求体 JSON 字符串")

    args = parser.parse_args()
    cfg = load_config()
    {"login": cmd_login, "workflows": cmd_workflows, "fields": cmd_fields,
     "create": cmd_create, "get": cmd_get, "todo": cmd_todo,
     "list": cmd_list, "api": cmd_api}[args.cmd](args, cfg)


if __name__ == "__main__":
    main()
