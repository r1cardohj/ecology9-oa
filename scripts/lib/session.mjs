// 需要 Node >= 22.18（零依赖）
process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0"; // OA 多为自签名 HTTPS

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const COOKIE_FILE = join(homedir(), ".cache", "ecology9-oa", "cookies.json");
const TIMEOUT_MS = 30_000;

export class CookieJar {
  #map = new Map();

  load() {
    if (!existsSync(COOKIE_FILE)) return false;
    try {
      this.#map = new Map(Object.entries(JSON.parse(readFileSync(COOKIE_FILE, "utf-8"))));
      return this.#map.size > 0;
    } catch {
      return false;
    }
  }

  save() {
    mkdirSync(dirname(COOKIE_FILE), { recursive: true });
    writeFileSync(COOKIE_FILE, JSON.stringify(Object.fromEntries(this.#map)));
  }

  header() {
    return [...this.#map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  storeFrom(resp) {
    for (const sc of resp.headers.getSetCookie()) {
      const pair = sc.split(";")[0];
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /expires=Thu, 01 Jan 1970/i.test(sc)) this.#map.delete(name);
      else this.#map.set(name, value);
    }
  }
}

export function newSession() {
  return { jar: new CookieJar() };
}

export async function request(s, method, url, opts = {}) {
  const headers = {};
  const cookie = s.jar.header();
  if (cookie) headers.cookie = cookie;
  let body;
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

export async function respText(resp) {
  const buf = await resp.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buf);
  return utf8.includes("�") ? new TextDecoder("gbk").decode(buf) : utf8;
}

export async function respJson(resp) {
  const text = await respText(resp);
  try {
    return JSON.parse(text);
  } catch {
    fatal(`非 JSON 响应 (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
}

export function fatal(msg) {
  console.error(msg);
  process.exit(1);
}

export function unwrap(data) {
  if (data && typeof data === "object" && data.code !== undefined && data.code !== null && data.code !== "SUCCESS") {
    fatal(`接口错误: ${JSON.stringify(data).slice(0, 800)}`);
  }
  return data;
}

export function loadConfig() {
  const env = { base: process.env.OA_BASE, user: process.env.OA_USER, pass: process.env.OA_PASS };
  const cfgPath = join(SKILL_DIR, "config.json");
  let cfg = {};
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

async function webLogin(cfg) {
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

export async function getSession(cfg, force = false) {
  const s = newSession();
  if (!force && s.jar.load()) {
    try {
      const r = await request(s, "GET", `${cfg.base}/api/hrm/user/currentUser`);
      if (!(await respText(r)).includes("登录信息超时")) return s;
    } catch {}
  }
  return webLogin(cfg);
}

export function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}
