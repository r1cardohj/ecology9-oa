#!/usr/bin/env node
// 需要 Node >= 22.18（内置 TypeScript 类型擦除，零依赖）
import { fatal, getSession, loadConfig, printJson, request, respJson, respText, unwrap } from "./lib/session.mjs";

type Config = { base: string; user: string; pass: string };
type Session = Awaited<ReturnType<typeof getSession>>;

const LIST_ENDPOINTS: Record<string, string> = {
  all: "getAllWorkflowRequestList",
  doing: "getDoingWorkflowRequestList",
  processed: "getProcessedWorkflowRequestList",
  toread: "getToBeReadWorkflowRequestList",
  cc: "getCCWorkflowRequestList",
  my: "getMyWorkflowRequestList",
};

// 服务端列表接口固定每页 10 条，count 参数被忽略；分页用 query 参数 pageNo（从 1 开始）
const PAGE_SIZE = 10;

function optValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function fetchPage(s: Session, cfg: Config, endpoint: string, pageNo: number): Promise<any[]> {
  const data = unwrap(
    await respJson(await request(s, "POST", `${cfg.base}/api/workflow/paService/${endpoint}?pageNo=${pageNo}`, { json: {} })),
  );
  return data ?? [];
}

async function fetchPages(
  s: Session,
  cfg: Config,
  endpoint: string,
  opts: { page?: number; all?: boolean; total?: number },
): Promise<any[]> {
  if (!opts.all) return fetchPage(s, cfg, endpoint, opts.page ?? 1);
  const out: any[] = [];
  const maxPage = opts.total ? Math.max(1, Math.ceil(opts.total / PAGE_SIZE)) : 100;
  for (let p = 1; p <= maxPage; p++) {
    const items = await fetchPage(s, cfg, endpoint, p);
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

const commands: Record<string, (args: string[], cfg: Config) => Promise<void>> = {
  async login(_args, cfg) {
    await getSession(cfg, true);
    console.log("登录成功");
  },

  async workflows(_args, cfg) {
    const s = await getSession(cfg);
    const data = unwrap(await respJson(await request(s, "POST", `${cfg.base}/api/workflow/paService/getCreateWorkflowList`, { json: {} })));
    for (const w of data ?? []) {
      console.log(`${w.workflowId}\t${w.workflowTypeName}\t${w.workflowName}`);
    }
  },

  async fields(args, cfg) {
    const json = args.includes("--json");
    const workflowId = args.find((a) => !a.startsWith("--"))!;
    const s = await getSession(cfg);
    const data = unwrap(
      await respJson(await request(s, "GET", `${cfg.base}/api/workflow/paService/getCreateWorkflowRequestInfo?workflowId=${encodeURIComponent(workflowId)}`)),
    );
    const info = data?.data ?? data;
    if (json) {
      printJson(info);
      return;
    }
    const dumpFields = (fields: any[]) => {
      for (const f of fields ?? []) {
        const unsupported = String(f.fieldShowValue ?? "").includes("[该字段暂不支持]");
        let mark = f.mand ? " *必填" : "";
        if (unsupported) mark += " *不支持API赋值";
        console.log(
          `${String(f.fieldName ?? "").padEnd(20)} ${String(f.fieldShowName ?? "").padEnd(15)} ` +
            `html=${f.fieldHtmlType} value=${JSON.stringify(f.fieldValue)}${mark}`,
        );
      }
    };
    for (const r of info?.workflowMainTableInfo?.requestRecords ?? []) {
      dumpFields(r.workflowRequestTableFields);
    }
    for (const dt of info?.workflowDetailTableInfos ?? []) {
      console.log(`--- 明细表 ${dt.tableDBName}`);
      for (const rec of dt.workflowRequestTableRecords ?? []) {
        dumpFields(rec.workflowRequestTableFields);
      }
    }
  },

  async create(args, cfg) {
    const opt = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const fields: [string, string][] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--field") fields.push([args[i + 1], args[i + 2]]);
    }
    const workflowId = opt("--workflow-id")!;
    const title = opt("--title")!;
    const main = fields.map(([k, v]) => ({ fieldName: k, fieldValue: v }));
    const fieldsJson = opt("--fields-json");
    if (fieldsJson) {
      for (const item of JSON.parse(fieldsJson)) {
        main.push({ fieldName: item.name, fieldValue: String(item.value) });
      }
    }
    const payload: Record<string, unknown> = {};
    const detailsJson = opt("--details-json");
    const s = await getSession(cfg);
    if (detailsJson) {
      const rows = JSON.parse(detailsJson);
      const info = unwrap(
        await respJson(await request(s, "GET", `${cfg.base}/api/workflow/paService/getCreateWorkflowRequestInfo?workflowId=${encodeURIComponent(workflowId)}`)),
      );
      const details = (info?.data ?? info)?.workflowDetailTableInfos ?? [];
      if (!details.length) fatal("该流程没有明细表，但传了 --details-json");
      const normalized = rows.map((row: any) =>
        typeof row === "object" && !Array.isArray(row)
          ? Object.entries(row).map(([fieldName, fieldValue]) => ({ fieldName, fieldValue: String(fieldValue) }))
          : row,
      );
      payload.detailData = [
        {
          tableDBName: details[0].tableDBName,
          workflowRequestTableRecords: normalized.map((f: any, i: number) => ({
            recordOrder: i,
            workflowRequestTableFields: f,
          })),
        },
      ];
    }
    payload.workflowId = String(workflowId);
    payload.requestName = title;
    payload.mainData = main;
    const data = unwrap(await respJson(await request(s, "POST", `${cfg.base}/api/workflow/paService/doCreateRequest`, { json: payload })));
    const result = data?.data ?? data;
    console.log(typeof result === "object" ? result?.requestid : result);
  },

  async get(args, cfg) {
    const s = await getSession(cfg);
    const data = unwrap(
      await respJson(await request(s, "GET", `${cfg.base}/api/workflow/paService/getWorkflowRequest?requestId=${encodeURIComponent(args[0])}`)),
    );
    printJson(data?.data ?? data);
  },

  async todo(args, cfg) {
    const json = args.includes("--json");
    const all = args.includes("--all");
    const page = parseInt(optValue(args, "--page") ?? "1", 10);
    const s = await getSession(cfg);
    const total = parseInt(
      (await respText(await request(s, "POST", `${cfg.base}/api/workflow/paService/getToDoWorkflowRequestCount`, { json: {} }))).trim(),
      10,
    );
    const items = await fetchPages(s, cfg, "getToDoWorkflowRequestList", { page, all, total });
    if (json) {
      printJson(items);
      return;
    }
    console.log(`# 待办 ${total} 条${all ? "" : ` (第 ${page}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页)`}`);
    for (const it of items) {
      console.log(
        `${it.requestId}\t${it.requestName}\t[${it.status}] 节点=${it.currentNodeName} 创建人=${it.creatorName} ${it.createTime}`,
      );
    }
  },

  async list(args, cfg) {
    const json = args.includes("--json");
    const all = args.includes("--all");
    const page = parseInt(optValue(args, "--page") ?? "1", 10);
    const key = args.find((a) => !a.startsWith("--"))!;
    const s = await getSession(cfg);
    const items = await fetchPages(s, cfg, LIST_ENDPOINTS[key], { page, all });
    if (json) {
      printJson(items);
      return;
    }
    for (const it of items) {
      console.log(`${it.requestId}\t${it.requestName}\t[${it.status}] 创建人=${it.creatorName} ${it.createTime}`);
    }
  },

  async api(args, cfg) {
    const s = await getSession(cfg);
    const [method, path, body] = args;
    const r = await request(s, method.toUpperCase(), `${cfg.base}${path}`, { json: body ? JSON.parse(body) : {} });
    const text = await respText(r);
    try {
      printJson(JSON.parse(text));
    } catch {
      console.log(text);
    }
  },
};

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || !commands[cmd]) {
    fatal(`用法: node scripts/oa.ts <${Object.keys(commands).join("|")}> ...`);
  }
  await commands[cmd](args, loadConfig());
}

main().catch((e) => fatal(e instanceof Error ? e.message : String(e)));
