// extension/src/runner.ts
// Robust dev-server runner + minimal inline static server.
// - Autostartar Vite (dev/preview) när index.html refererar .ts/.tsx/.jsx
// - Auto-install av deps (npm/pnpm/yarn/bun) när node_modules saknas/lockfile ändrats
// - Fångar URL:er från loggar för populära dev-servrar (buffer över chunk-gränser)
// - Uthållig portdetektion med HEAD + GET och flera paths
// - Reachability-koll (HEAD/GET, "/", "/index.html", "@vite/client")
// - Processhantering med kill tree
// - Ultralätt inline-server för statiska HTML-mappar
// - Tydliga loggar för felsökning

import * as vscode from "vscode";
import { spawn, ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { AddressInfo } from "node:net";

/* ─────────────────────────────────────────────────────────
   Logging
   ───────────────────────────────────────────────────────── */
const OUT = vscode.window.createOutputChannel("AI Figma Codegen – Dev Server");
function logInfo(msg: string, data?: any)  { OUT.appendLine(`[info] ${msg}${data !== undefined ? " " + safeJson(data) : ""}`); }
function logWarn(msg: string, data?: any)  { OUT.appendLine(`[warn] ${msg}${data !== undefined ? " " + safeJson(data) : ""}`); }
function logErr(msg: string, data?: any)   { OUT.appendLine(`[error] ${msg}${data !== undefined ? " " + safeJson(data) : ""}`); }
function safeJson(x: any) { try { return JSON.stringify(x); } catch { return String(x); } }

/* ─────────────────────────────────────────────────────────
   URL-upptäckt i loggar
   ───────────────────────────────────────────────────────── */
const URL_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "http-server Available on", re: /Available on:\s*(https?:\/\/[^\s/]+:\d+\/?)/i },
  { label: "Vite Local",               re: /Local:\s*(https?:\/\/[^\s/]+:\d+\/?)/i },
  { label: "Vite Network",             re: /Network:\s*(https?:\/\/[^\s/]+:\d+\/?)/i },
  { label: "Project running at",       re: /Project (?:is )?running at:\s*(https?:\/\/[^\s/]+:\d+\/?)/i },
  { label: "Astro ready",              re: /ready in .*? and running at:\s*(https?:\/\/[^\s]+)/i },
  { label: "Remix/Solid started",      re: /started server on .*?(https?:\/\/[^\s]+)/i },
  { label: "Next url",                 re: /ready - started server on .*?url:\s*(https?:\/\/[^\s/]+:\d+\/?)/i },
  { label: "Storybook",                re: /Storybook .* started .* (?:at|on)\s*(https?:\/\/[^\s]+)/i },
  { label: "Generic localhost",        re: /https?:\/\/localhost:\d+\/?/i },
  { label: "Generic 127.0.0.1",        re: /https?:\/\/127\.0\.0\.1:\d+\/?/i },
  { label: "Generic 0.0.0.0",          re: /https?:\/\/0\.0\.0\.0:\d+\/?/i },
  { label: "Generic IPv6",             re: /https?:\/\/\[[^\]]+\]:\d+\/?/i },
  { label: "Generic host:port",        re: /https?:\/\/[^\s]+:\d+\/?/i },
];

function stripAnsi(s: string): string {
  // Ta bort CSI-sekvenser och övriga ESC-sekvenser
  return s
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "");
}

function extractUrlLabeled(text: string): { url: string; by: string } | null {
  for (const p of URL_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { url: (m[1] ?? m[0]), by: p.label };
  }
  return null;
}

function normalizeLocalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.hostname === "0.0.0.0" || u.hostname === "::" || u.hostname === "[::]" || u.hostname === "localhost") {
      u.hostname = "127.0.0.1";
    }
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.toString();
  } catch {
    return raw;
  }
}

/* ─────────────────────────────────────────────────────────
   Snabb HEAD/GET-ping + reachability
   ───────────────────────────────────────────────────────── */
function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function headPing(url: string, timeoutMs = 900): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === "https:" ? https : http;
      const req = client.request(
        { method: "HEAD", hostname: u.hostname, port: u.port, path: u.pathname || "/", timeout: timeoutMs },
        (res) => { res.resume(); resolve((res.statusCode ?? 500) < 400); }
      );
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
      req.end();
    } catch { resolve(false); }
  });
}

function getOk(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === "https:" ? https : http;
      const req = client.request(
        { method: "GET", hostname: u.hostname, port: u.port, path: u.pathname || "/", timeout: timeoutMs },
        (res) => { res.resume(); resolve((res.statusCode ?? 500) < 400); }
      );
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
      req.end();
    } catch { resolve(false); }
  });
}

async function waitForReachable(rawUrl: string, timeoutMs = 60000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const base = normalizeLocalUrl(rawUrl);
  const cand = [base, base + "index.html", base + "@vite/client"];
  logInfo("reachable:start", { base, candidates: cand });

  while (Date.now() < until) {
    for (const u of cand) {
      if (await headPing(u, 900)) { logInfo("reachable:HEAD ok", { u }); return true; }
      if (await getOk(u, 1500))   { logInfo("reachable:GET ok",  { u }); return true; }
    }
    await sleep(350);
  }
  logWarn("reachable:timeout", { tried: cand });
  return false;
}

/* ─────────────────────────────────────────────────────────
   Portgissning (uthållig)
   ───────────────────────────────────────────────────────── */
function baseTargetsFor(port: number): string[] {
  const bases = [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`];
  const targets: string[] = [];
  for (const b of bases) targets.push(b, b + "index.html", b + "@vite/client");
  return targets;
}

async function guessPortsFast(): Promise<string | null> {
  // Vanliga dev-portar + några närliggande
  const ports = [5173, 4173, 3000, 3001, 4200, 8080, 8081, 4321, 6006, 1420, 5174, 5175, 5172, 3333, 1234, 5500];
  const until = Date.now() + 60000; // polla upp till 60s

  logInfo("port-guess:start", { candidates: ports.length, windowMs: until - Date.now() });

  while (Date.now() < until) {
    for (const p of ports) {
      for (const u of baseTargetsFor(p)) {
        if (await headPing(u, 700) || await getOk(u, 1100)) {
          const normalized = normalizeLocalUrl(u.replace(/(@vite\/client|index\.html).*$/, ""));
          logInfo("port-guess:hit", { url: normalized });
          return normalized;
        }
      }
    }
    await sleep(300);
  }

  logInfo("port-guess:end", { hit: null });
  return null;
}

/* ─────────────────────────────────────────────────────────
   Process-hantering (kill tree, aktiv process)
   ───────────────────────────────────────────────────────── */
let activeChild: ChildProcess | null = null;

async function killProcessTree(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    if (!child.pid) return done();

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("exit", done);
      killer.on("error", done);
      return;
    }

    try {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      setTimeout(() => {
        try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch {}
        try { child.kill("SIGKILL"); } catch {}
        done();
      }, 400);
    } catch { done(); }
  });
}

/** Stoppa nuvarande dev-server om en finns. Säkert att kalla flera gånger. */
export async function stopDevServer(): Promise<void> {
  if (!activeChild) return;
  const child = activeChild;
  activeChild = null;
  try { child.kill("SIGTERM"); } catch {}
  await killProcessTree(child);
}

/* ─────────────────────────────────────────────────────────
   Inline ultralätt statisk server
   ───────────────────────────────────────────────────────── */
let activeInline: http.Server | null = null;

function contentType(p: string): string {
  const ext = path.extname(p).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".mjs":  "text/javascript; charset=utf-8",
    ".ts":   "text/javascript; charset=utf-8",   // OBS: transpileras inte
    ".tsx":  "text/javascript; charset=utf-8",   // OBS: transpileras inte
    ".jsx":  "text/javascript; charset=utf-8",   // OBS: transpileras inte
    ".wasm": "application/wasm",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".txt":  "text/plain; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

function isPathInside(childPath: string, parentDir: string): boolean {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(parent + path.sep);
}

export async function stopInlineServer(): Promise<void> {
  if (!activeInline) return;
  const srv = activeInline;
  activeInline = null;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

export async function runInlineStaticServer(
  dir: string
): Promise<{ localUrl: string; externalUrl: string; stop: () => Promise<void> }> {
  await stopInlineServer();

  const base = path.resolve(dir);
  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", "http://localhost");
      const decodedPath = decodeURIComponent(reqUrl.pathname);
      let filePath = path.join(base, decodedPath);

      if (!isPathInside(filePath, base)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Bad request");
        return;
      }

      let stat: fs.Stats | null = null;
      if (fs.existsSync(filePath)) stat = fs.statSync(filePath);

      if (stat && stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        if (!(fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }
      }

      if (!(fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not found");
        return;
      }

      const ctype = contentType(filePath);
      res.setHeader("Content-Type", ctype);

      if (req.method === "HEAD") {
        try { const s = fs.statSync(filePath); res.setHeader("Content-Length", String(s.size)); } catch {}
        res.end(); return;
      }

      fs.createReadStream(filePath)
        .on("error", () => {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Server error");
        })
        .pipe(res);
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Server error");
    }
  });

  activeInline = server;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const localUrl = `http://localhost:${port}/`;
  const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(localUrl));

  const stop = async () => {
    if (activeInline === server) await stopInlineServer();
    else await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  logInfo("inline:ready", { base, localUrl, externalUrl: externalUri.toString(true) });
  return { localUrl, externalUrl: externalUri.toString(true), stop };
}

/* ─────────────────────────────────────────────────────────
   PM-detektering och install
   ───────────────────────────────────────────────────────── */
function detectPM(cwd: string): { pm: "pnpm" | "yarn" | "bun" | "npm"; lock: string | null } {
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const pm: string | undefined = pkg?.packageManager;
      if (typeof pm === "string") {
        if (pm.startsWith("npm@"))  return { pm: "npm",  lock: "package-lock.json" };
        if (pm.startsWith("pnpm@")) return { pm: "pnpm", lock: "pnpm-lock.yaml" };
        if (pm.startsWith("yarn@")) return { pm: "yarn", lock: "yarn.lock" };
        if (pm.startsWith("bun@"))  return { pm: "bun",  lock: "bun.lockb" };
      }
    }
  } catch {}

  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return { pm: "npm",  lock: "package-lock.json" };
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml")))   return { pm: "pnpm", lock: "pnpm-lock.yaml" };
  if (fs.existsSync(path.join(cwd, "yarn.lock")))        return { pm: "yarn", lock: "yarn.lock" };
  if (fs.existsSync(path.join(cwd, "bun.lockb")))        return { pm: "bun",  lock: "bun.lockb" };
  return { pm: "npm", lock: null };
}

function pmRun(pm: "pnpm" | "yarn" | "bun" | "npm", script: string): string {
  if (pm === "pnpm") return `pnpm run ${script}`;
  if (pm === "yarn") return `yarn ${script}`;
  if (pm === "bun")  return `bun run ${script}`;
  return `npm run ${script}`;
}

function pmExec(pm: "pnpm" | "yarn" | "bun" | "npm", bin: string, args: string[]): string {
  const tail = [bin, ...args].join(" ");
  if (pm === "pnpm") return `pnpm exec ${tail}`;
  if (pm === "yarn") return `yarn ${tail}`;
  if (pm === "bun")  return `bunx ${tail}`;
  return `npx ${tail}`;
}

function hashFile(p: string): string | null {
  try { return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
}

function installStampPath(cwd: string) { return path.join(cwd, "node_modules", ".ai-figma-install.json"); }

function needsInstall(cwd: string): boolean {
  const { lock } = detectPM(cwd);
  const nodeMods = path.join(cwd, "node_modules");
  const stampPath = installStampPath(cwd);

  if (!lock) return !fs.existsSync(nodeMods);

  const lockPath = path.join(cwd, lock);
  if (!fs.existsSync(lockPath)) return false;
  if (!fs.existsSync(nodeMods)) return true;

  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    const cur = { lock: hashFile(lockPath), node: process.version };
    return !(stamp && stamp.lock === cur.lock && stamp.node === cur.node);
  } catch { return true; }
}

async function runInstall(cwd: string, out: vscode.OutputChannel) {
  const primary = detectPM(cwd).pm;
  const cmds = [
    primary === "pnpm" ? "pnpm install --frozen-lockfile -s" :
    primary === "yarn" ? "yarn install --immutable" :
    primary === "bun"  ? "bun install" :
                         "npm ci",
    // Fallbacks
    "npm ci",
    "npm install",
  ];

  let lastErr: any;
  for (const cmd of cmds) {
    try {
      out.appendLine(`[deps] Kör: ${cmd}`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(cmd, { cwd, shell: true, env: process.env, detached: os.platform() !== "win32", windowsHide: true });
        child.stdout?.on("data", b => out.append(b.toString()));
        child.stderr?.on("data", b => out.append(b.toString()));
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      });

      const { lock } = detectPM(cwd);
      const lockHash = lock ? hashFile(path.join(cwd, lock)) : null;
      const stamp = { lock: lockHash, node: process.version, ts: Date.now() };
      await fsp.mkdir(path.join(cwd, "node_modules"), { recursive: true });
      fs.writeFileSync(installStampPath(cwd), JSON.stringify(stamp), "utf8");
      return;
    } catch (e) {
      lastErr = e;
      out.appendLine(`[deps] ${cmd} misslyckades: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw lastErr ?? new Error("Install misslyckades");
}

/* ─────────────────────────────────────────────────────────
   Kör dev-kommando och hitta URL (race: loggbuffer + uthållig portgissning)
   ───────────────────────────────────────────────────────── */
export async function runDevServer(
  devCmd: string,
  cwd: string
): Promise<{ localUrl: string; externalUrl: string; stop: () => Promise<void> }> {
  await stopDevServer();

  logInfo("spawn:start", { cmd: devCmd, cwd });
  const child = spawn(devCmd, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      BROWSER: "none",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    detached: os.platform() !== "win32",
    windowsHide: true,
  });

  activeChild = child;

  let resolvedUrl: string | null = null;
  let resolveLogUrl: ((u: string | null) => void) | null = null;
  const logUrlPromise = new Promise<string | null>((resolve) => { resolveLogUrl = resolve; });

  // Buffra stdout/stderr över chunk-gränser
  let logBuf = "";

  const handleChunk = (buf: Buffer) => {
    const raw = buf.toString();
    OUT.append(raw); // spegla rålogg
    const cleaned = stripAnsi(raw).replace(/\r/g, "");
    logBuf += cleaned;
    if (logBuf.length > 8192) logBuf = logBuf.slice(-8192); // håll liten buffer

    if (!resolvedUrl) {
      const hit = extractUrlLabeled(logBuf);
      if (hit) {
        const normalized = normalizeLocalUrl(hit.url);
        resolvedUrl = normalized;
        logInfo("log-url:match", { pattern: hit.by, url: normalized });
        if (resolveLogUrl) { resolveLogUrl(normalized); resolveLogUrl = null; }
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  child.on("exit", (code, signal) => {
    if (activeChild === child) activeChild = null;
    logWarn("spawn:exit", { code, signal, hadUrl: !!resolvedUrl });
    if (resolveLogUrl) { resolveLogUrl(null); resolveLogUrl = null; }
  });

  const portGuessPromise = guessPortsFast();
  const overallDeadlineMs = 60000; // 60s
  const overallTimeout = sleep(overallDeadlineMs).then(() => null as string | null);

  const url = (await Promise.race([logUrlPromise, portGuessPromise, overallTimeout])) as string | null;
  logInfo("race:done", { urlFound: !!url });

  if (!url) {
    await stopDevServer();
    logErr("race:timeout-no-url", { cmd: devCmd, cwd });
    throw new Error("Kunde inte hitta dev-serverns URL via loggar eller portgissning inom tidsgränsen.");
  }

  const reachable = await waitForReachable(url, 60000);
  if (!reachable) {
    await stopDevServer();
    logErr("reachable:failed", { url });
    throw new Error(`Dev-servern svarar inte på ${url}`);
  }

  const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
  const stop = async () => {
    if (activeChild === child) await stopDevServer();
    else if (child.pid) await killProcessTree(child);
  };

  logInfo("dev:ready", { localUrl: normalizeLocalUrl(url), externalUrl: external.toString(true) });
  return { localUrl: normalizeLocalUrl(url), externalUrl: external.toString(true), stop };
}

/* ─────────────────────────────────────────────────────────
   Autodetektera index.html/module-entry
   ───────────────────────────────────────────────────────── */
async function findIndexHtml(dir: string): Promise<string | null> {
  const cand = [
    "index.html",
    "public/index.html",
    "dist/index.html",
    "src/webview/index.html",
    "src/webview/public/index.html",
    "src/index.html",
    "web/index.html",
    "apps/web/index.html",
    "packages/web/public/index.html",
  ];
  for (const f of cand) {
    const p = path.join(dir, f);
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) return p;
    } catch {}
  }
  return null;
}

async function detectModuleEntry(dir: string): Promise<string | null> {
  const indexPath = await findIndexHtml(dir);
  if (!indexPath) return null;
  const html = await fsp.readFile(indexPath, "utf8");
  const re = /<script\s+[^>]*type\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i;
  const m = html.match(re);
  if (!m) return null;
  const src = m[1].trim();
  return /\.(ts|tsx|js|jsx)(\?|#|$)/i.test(src) ? src : null;
}

async function readPkgDevScript(dir: string): Promise<string | null> {
  const p = path.join(dir, "package.json");
  try {
    const txt = await fsp.readFile(p, "utf8");
    const pkg = JSON.parse(txt);
    if (pkg?.scripts?.dev && typeof pkg.scripts.dev === "string") {
      const pm = detectPM(dir).pm;
      const cmd = pmRun(pm, "dev");
      logInfo("pkg:dev-script", { pm, cmd });
      return cmd;
    }
  } catch {}
  return null;
}

/* ─────────────────────────────────────────────────────────
   Smart server-start
   ───────────────────────────────────────────────────────── */
export async function runSmartServer(
  cwd: string,
  explicitDevCmd?: string
): Promise<{ localUrl: string; externalUrl: string; stop: () => Promise<void> }> {
  // 0) deps
  if (needsInstall(cwd)) {
    logInfo("deps:install-needed", { cwd });
    try { await runInstall(cwd, OUT); logInfo("deps:installed"); }
    catch (e: any) {
      logErr("deps:failed", { error: e?.message });
      vscode.window.showErrorMessage(`Dependency install failed i ${cwd}. Öppna "${OUT.name}" för loggar.`);
      throw e;
    }
  }

  // 1) explicit kommando
  if (explicitDevCmd?.trim()) {
    logInfo("strategy:explicit", { cmd: explicitDevCmd });
    try { return await runDevServer(explicitDevCmd, cwd); }
    catch (e:any) { logWarn("strategy:explicit:fail", { error: e?.message }); }
  }

  // 2) package.json dev-script (med rätt PM)
  const devScript = await readPkgDevScript(cwd);
  if (devScript) {
    logInfo("strategy:dev-script", { cmd: devScript });
    try { return await runDevServer(devScript, cwd); }
    catch (e:any) { logWarn("strategy:dev-script:fail", { error: e?.message }); }
  }

  // 3) module-entry ⇒ bundler (vite dev/preview) med rätt PM
  const modEntry = await detectModuleEntry(cwd);
  logInfo("strategy:module-entry", { modEntry });
  if (modEntry) {
    const pm = detectPM(cwd).pm;
    const devCmd = pmExec(pm, "vite", ["--host", "127.0.0.1", "--port", "0"]);
    const previewCmd = pmExec(pm, "vite", ["preview", "--host", "127.0.0.1", "--port", "0"]);
    try { logInfo("strategy:vite-dev", { cmd: devCmd }); return await runDevServer(devCmd, cwd); }
    catch (e:any) { logWarn("vite-dev:fail", { error: e?.message }); }
    try { logInfo("strategy:vite-preview", { cmd: previewCmd }); return await runDevServer(previewCmd, cwd); }
    catch (e:any) { logWarn("vite-preview:fail", { error: e?.message }); }

    if (/\.(ts|tsx|jsx)(\?|#|$)/i.test(modEntry)) {
      logErr("inline:not-allowed", { reason: "index.html refererar TS/TSX/JSX" });
      throw new Error("index.html refererar TS/TSX/JSX. Starta en bundler (vite dev/preview).");
    }
  }

  // 4) inline fallback – statisk mapp
  const idx = await findIndexHtml(cwd);
  const root = idx ? path.dirname(idx) : cwd;
  logInfo("strategy:inline", { root, hasIndex: !!idx });
  return await runInlineStaticServer(root);
}
