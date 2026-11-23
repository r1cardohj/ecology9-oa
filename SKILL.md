---
name: ecology9-oa
description: 操作泛微 E-cology 9 OA：网页登录、查询可发起流程、查看表单字段、读取流程详情、待办/已办列表、发起流程、任意 REST 接口调用。当用户需要操作泛微OA、ecology、E9 流程时使用。
---

# 泛微 E-cology 9 OA REST 工具

通过 `scripts/oa.ts` 调用（Node >= 22.18 零依赖，直接 `node` 运行） E9 的 `/api/workflow/paService/*` REST 接口，认证方式是**网页登录拿会话 cookie**（不是 SOAP，不是 appid token——实测这套环境的 `/services/WorkflowService` 列表方法服务端 500 不可用，`/api/*` 无 token 体系）。

## 配置

复制 `config.example.json` 为 `config.json` 并填写，或用环境变量 `OA_BASE` / `OA_USER` / `OA_PASS`（环境变量优先）。cookie 缓存在 `~/.cache/ecology9-oa/cookies.json`，失效自动重新登录。

## 常用命令

```bash
cd <skill目录>

node scripts/oa.ts login                     # 强制重新登录
node scripts/oa.ts workflows                 # 可发起的流程列表（workflowId/类型/名称）
node scripts/oa.ts fields <workflowId>       # 表单字段明细（发起前必看！）
node scripts/oa.ts create \
  --workflow-id 1136 --title "会议申请单-张三-20261123" \
  --field name "测试会议" --field begindate 2026-11-24 --field hrmmembers 1234
node scripts/oa.ts get <requestId>           # 流程详情（字段值、当前节点、状态）
node scripts/oa.ts todo [--all|--page N] [--json]   # 待办（--all 翻页取全量，默认只第 1 页）
node scripts/oa.ts list processed [--all|--page N]   # 已办；可选 all/doing/toread/cc/my
node scripts/oa.ts api POST /api/workflow/paService/submitRequest '{...}'  # 任意接口兜底（GET/POST 均可，path 可带 query string）

# 会话/请求层已抽为 scripts/lib/session.mjs，可 import 复用：
#   import { getSession, loadConfig, request, respJson } from "./scripts/lib/session.mjs";
```

## 发起流程步骤

1. `workflows` 找 `workflowId`（不同环境不同，禁止硬编码）
2. `fields <workflowId>` 看字段：每行给出 `fieldName`（提交用）、显示名、html 类型、当前值、必填/不支持标记
3. `create` 提交。字段值规则：
   - **fieldName 是字段数据库标识**（如 `name`、`begindate`），不是显示名（"会议主题"）
   - 浏览框字段（人员/部门/日期等 html=3）：填**数字 id**，多值逗号分隔（人员 id 就是 HRM id，可从 `fields` 输出里别的同类字段的当前值参考，或问用户）
   - 选择框（html=5）：填选项值（如 `0`/`1`），可选值在 `fields --json` 的 `selectvalues` 里
   - 日期 `2026-11-24`，时间 `09:00`
### 明细表 & 出口条件实战案例：请假申请单（workflowId=1972）

- 数据在**明细表**：`create` 加 `--details-json '[{"xm":"1234","ksrq":"2026-11-20","kssj":"08:00","jsrq":"2026-11-20","jssj":"17:00","qjlx":"15","qjdd":"0","qjsy":"..."}]'`
- 出口条件按**主表**字段判断，必须传齐 `sqraqjb`(安全级别)、`sfzj`(是否总监)、`gh`(工号)、`sqr`(申请人id)、`sqbm`(申请部门id)、`tx`(体系id)，否则 `LINK_CONDITION_NOT_MET` 所有分支全灭，报错不指明缺哪个字段
- 这些值从哪来：用 `get` 读本人一条历史同类型流程照抄（`fields` 里只读字段的默认值也是来源）
- `qjlx` 标了"不支持"但实际可赋值（15=调休）
- 完整例子：
  `node scripts/oa.ts create --workflow-id 1972 --title "请假申请单-张三-2026-11-20" --field tx 5 --field sqraqjb 10 --field sfzj 1 --field gh A0000 --field sqr 1234 --field sqbm 61 --details-json '[{"xm":"1234","gh":"A0000","bm":"61","qjlx":"15","ksrq":"2026-11-20","kssj":"08:00","jsrq":"2026-11-20","jssj":"17:00","qjdd":"0","qjsy":"家中有事"}]'`
- 创建成功即提交（doCreateRequest 无草稿模式），按出口条件自动路由（安全级别10 走 直属上司）
- 想撤掉：`node scripts/oa.ts api POST /api/workflow/reqform/requestWithdraw '{"requestid":"..."}'` 或网页端撤回
   - 标注 `*不支持API赋值` 的字段（fieldShowValue 为 `[该字段暂不支持]`）**传了也没用**，这类流程可能无法通过 API 发起，需实测（有些必填但不校验，如会议申请单）
4. 成功输出 `requestId`；失败会打印服务端错误（常见 `LINK_CONDITION_NOT_MET` 出口条件不满足 = 某条件字段没传值，错误详情里会写明缺哪个字段）

## 环境实际探测结论（2026-11，某 E9 实例；示例中的人名/工号/人员 id 均为脱敏示例，需按实际环境替换）

- 列表类接口分页：POST body 带 `{}`，分页用 **query 参数 `?pageNo=N`**（从 1 开始）；`count`/`currentPage`/`page` 等参数均被服务端忽略，每页固定 10 条
- REST `/api/workflow/paService/` 可用：getCreateWorkflowList、getCreateWorkflowTypeList、getToDoWorkflowRequestList(Count)、getAllWorkflowRequestList、getDoingWorkflowRequestList、getProcessedWorkflowRequestList、getToBeReadWorkflowRequestList、getCCWorkflowRequestList、getMyWorkflowRequestList、getCreateWorkflowCount、**getWorkflowRequest(GET)**、**getCreateWorkflowRequestInfo(GET)**、**doCreateRequest(POST)**、submitRequest
- doCreateRequest 参数：`{"workflowId": "...", "requestName": "...", "mainData": [{"fieldName": "...", "fieldValue": "..."}]}`
- getCreateWorkflowRequestInfo 参数：query string `?workflowId=xxx`（POST 会 405）
- getWorkflowRequest 参数：query string `?requestId=xxx`

## 排错

- **登录失败**：脚本用 VerifyLogin.jsp 成功页特征判断，失败会打印返回片段
- **登录信息超时 / errorCode 002**：会话过期，脚本会自动重登；持续失败就 `login` 强制刷新
- **create 报 SAVE_MAIN_TABLE_FAIL**：mainData 格式错误，必须是 `[{"fieldName":..,"fieldValue":..}]` 数组
- **出口条件不满足**：看错误 detail，把条件字段（如 `tx` 体系）加进 mainData
