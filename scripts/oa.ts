#!/usr/bin/env node
// 需要 Node >= 22.18（内置 TypeScript 类型擦除，零依赖）
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0"; // OA 多为自签名 HTTPS

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const COOKIE_FILE = join(homedir(), ".cache", "ecology9-oa", "cookies.json");
const TIMEOUT_MS = 30_000;

const LIST_ENDPOINTS: Record<string, string> = {
  all: "getAllWorkflowRequestList",
  doing: "getDoingWorkflowRequestList",
  processed: "getProcessedWorkflowRequestList",
  toread: "getToBeReadWorkflowRequestList",
  cc: "getCCWorkflowRequestList",
  my: "getMyWorkflowRequestList",
};

type Config = { base: string; user: string; pass: string };

class CookieJar {
  private map = new Map<string, string>();

  load(): boolean {
    if (!existsSync(COOKIE_FILE)) return false;
    try {
      this.map = new Map(Object.entries(JSON.parse(readFileSync(COOKIE_FILE, "utf-8"))));
      return this.map.size > 0;
    } catch {
      return false;
    }
  }

  save(): void {
    mkdirSync(dirname(COOKIE_FILE), { recursive: true });
    writeFileSync(COOKIE_FILE, JSON.stringify(Object.fromEntries(this.map)));
  }

  header(): string {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  storeFrom(resp: Response): void {
    for (const sc of resp.headers.getSetCookie()) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /expires=Thu, 01 Jan 1970/i.test(sc)) this.map.delete(name);
      else this.map.set(name, value);
    }
  }
}

interface Session {
  jar: CookieJar;
}

function newSession(): Session {
  return { jar: new CookieJar() };
}

async function request(
  s: Session,
  method: string,
  url: string,
  opts: { form?: Record<string, string>; json?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookie = s.jar.header();
  if (cookie) headers.cookie = cookie;
  let body: BodyInit | undefined;
  const canHaveBody = method !== "GET" && method !== "HEAD";
  if (opts.form && canHaveBody) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined && canHaveBody) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  s.jar.storeFrom(resp);
  return resp;
}

async function respText(resp: Response): Promise<string> {
  const buf = await resp.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  return utf8.includes("") ? new TextDecoder("gbk").decode(buf) : utf8;
}

async function respJson(resp: Response): Promise<any> {
  try {
    return await resp.json();
  } catch {
    fatal(`非 JSON 响应 (HTTP ${resp.status}): ${(await respText(resp)).slice(0, 300)}`);
  }
}

function fatal(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function unwrap(data: any): any {
  if (data && typeof data === "object" && data.code !== undefined && data.code !== null && data.code !== "SUCCESS") {
    fatal(`接口错误: ${JSON.stringify(data).slice(0, 800)}`);
  }
  return data;
}

function loadConfig(): Config {
  const env = { base: process.env.OA_BASE, user: process.env.OA_USER, pass: process.env.OA_PASS };
  const cfgPath = join(SKILL_DIR, "config.json");
  let cfg: Record<string, string> = {};
  if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  const base = (env.base ?? cfg.base ?? "").replace(/\/+$/, "");
  const user = env.user ?? cfg.user ?? "";
  const pass = env.pass ?? cfg.pass ?? "";
  const missing = [
    ["OA_BASE", base],
    ["OA_USER", user],
    ["OA_PASS", pass],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) fatal(`缺少配置: ${missing.join(", ")}，请设置环境变量或创建 ${cfgPath}`);
  return { base, user, pass };
}

async function webLogin(cfg: Config): Promise<Session> {
  const s = newSession();
  await request(s, "GET", `${cfg.base}/login/Login.jsp`);
  const r = await request(s, "POST", `${cfg.base}/login/VerifyLogin.jsp`, {
    form: { loginid: cfg.user, userpassword: cfg.pass, logintype: "1", isremember: "1" },
  });
  const text = await respText(r);
  if (!text.includes("RemindLogin.jsp")) {
    fatal(`网页登录失败（账号或密码错误？），VerifyLogin.jsp 返回片段: ${JSON.stringify(text.slice(0, 200))}`);
  }
  await request(s, "GET", `${cfg.base}/login/RemindLogin.jsp?RedirectFile=/wui/main.jsp`);
  await request(s, "GET", `${cfg.base}/wui/main.jsp`);
  await request(s, "GET", `${cfg.base}/wui/index.html`);
  s.jar.save();
  return s;
}

async function getSession(cfg: Config, force = false): Promise<Session> {
  const s = newSession();
  if (!force && s.jar.load()) {
    try {
      const r = await request(s, "GET", `${cfg.base}/api/hrm/user/currentUser`);
      if (!(await respText(r)).includes("登录信息超时")) return s;
    } catch {}
  }
  return webLogin(cfg);
}

function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
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

  async todo(_args, cfg) {
    const s = await getSession(cfg);
    const countResp = await request(s, "POST", `${cfg.base}/api/workflow/paService/getToDoWorkflowRequestCount`, { json: {} });
    const count = (await respText(countResp)).trim();
    const data = unwrap(await respJson(await request(s, "POST", `${cfg.base}/api/workflow/paService/getToDoWorkflowRequestList`, { json: {} })));
    console.log(`# 待办 ${count} 条`);
    for (const it of data ?? []) {
      console.log(
        `${it.requestId}\t${it.requestName}\t[${it.status}] 节点=${it.currentNodeName} 创建人=${it.creatorName} ${it.createTime}`,
      );
    }
  },

  async list(args, cfg) {
    const s = await getSession(cfg);
    const data = unwrap(await respJson(await request(s, "POST", `${cfg.base}/api/workflow/paService/${LIST_ENDPOINTS[args[0]]}`, { json: {} })));
    for (const it of data ?? []) {
      console.log(`${it.requestId}\t${it.requestName}\t[${it.status}] 创建人=${it.creatorName} ${it.createTime}`);
    }
  },

  async api(args, cfg) {
    const s = await getSession(cfg);
    const [method, path, body] = args;
    const r = await request(s, method.toUpperCase(), `${cfg.base}${path}`, { json: body ? JSON.parse(body) : {} });
    try {
      printJson(await r.json());
    } catch {
      console.log(await respText(r));
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
