// extension/src/runner.ts
// Robust dev-server runner + minimal inline static server.
// - Autostartar Vite/preview när index.html refererar .ts/.tsx/.jsx
// - Auto-install av deps (npm/pnpm/yarn/bun) när node_modules saknas/lockfile ändrats
// - Fångar URL:er från loggar för populära dev-servrar
// - Portgissning (parallell) på vanliga portar
// - Reachability-koll (HEAD/GET, "/", "/index.html", "@vite/client")
// - Processhantering med kill tree
// - Ultralätt inline-server för statiska HTML-mappar

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
   URL-upptäckt i loggar
   ───────────────────────────────────────────────────────── */

/**
 * Mönster plockade från:
 * - Vite/Astro/Nuxt: "Local:", "Network:", "Available on:"
 * - Next 13–15: "ready - started server on ... url: http://localhost:3000"
 * - Remix/Solid: "started server on http://localhost:xxxx"
 * - Storybook: "started ... at http://localhost:6006"
 * - CRA/Webpack: "Project is running at http://localhost:8080", "Local: http://localhost:3000"
 * - Generiska fall: http://localhost:PORT, 127.0.0.1, 0.0.0.0, IPv6
 */
const URL_PATTERNS: RegExp[] = [
  // http-server
  /Available on:\s*(https?:\/\/[^\s/]+:\d+\/?)/i,

  // Vite / Astro / Nuxt / CRA / Angular
  /Local:\s*(https?:\/\/[^\s/]+:\d+\/?)/i,
  /Network:\s*(https?:\/\/[^\s/]+:\d+\/?)/i,
  /Project (?:is )?running at:\s*(https?:\/\/[^\s/]+:\d+\/?)/i,

  // Astro
  /ready in .*? and running at:\s*(https?:\/\/[^\s]+)/i,

  // Remix / Solid
  /started server on .*?(https?:\/\/[^\s]+)/i,

  // Next 13-15 (url: …)
  /ready - started server on .*?url:\s*(https?:\/\/[^\s/]+:\d+\/?)/i,

  // Storybook
  /Storybook .* started .* (?:at|on)\s*(https?:\/\/[^\s]+)/i,

  // Angular (vanlig default-port)
  /http:\/\/localhost:4200\/?/i,

  // Generiska lokala endpoints
  /http:\/\/localhost:\d+\/?/i,
  /https?:\/\/127\.0\.0\.1:\d+\/?/i,
  /https?:\/\/0\.0\.0\.0:\d+\/?/i,
  /https?:\/\/\[[^\]]+\]:\d+\/?/i, // IPv6
  /https?:\/\/[^\s]+:\d+\/?/i
];

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

function extractUrl(text: string): string | null {
  for (const re of URL_PATTERNS) {
    const m = text.match(re);
    if (m) return (m[1] ?? m[0]);
  }
  return null;
}

function normalizeLocalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    // Normalisera till loopback för extensionens probes
    if (
      u.hostname === "0.0.0.0" ||
      u.hostname === "::" ||
      u.hostname === "[::]" ||
      u.hostname === "localhost"
    ) {
      u.hostname = "127.0.0.1";
    }
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.toString();
  } catch {
    return raw;
  }
}

/* ─────────────────────────────────────────────────────────
   Snabb HEAD/GET-ping + “reachability”
   ───────────────────────────────────────────────────────── */

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function headPing(url: string, timeoutMs = 900): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === "https:" ? https : http;
      const req = client.request(
        {
          method: "HEAD",
          hostname: u.hostname,
          port: u.port,
          path: u.pathname || "/",
          timeout: timeoutMs
        },
        (res) => {
          res.resume();
          const ok = (res.statusCode ?? 500) < 400;
          resolve(ok);
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    } catch {
      resolve(false);
    }
  });
}

function getOk(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === "https:" ? https : http;
      const req = client.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port,
          path: u.pathname || "/",
          timeout: timeoutMs
        },
        (res) => {
          const ok = (res.statusCode ?? 500) < 400;
          res.resume();
          resolve(ok);
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function waitForReachable(rawUrl: string, timeoutMs = 12000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  const base = normalizeLocalUrl(rawUrl);
  const cand = [base, base + "index.html", base + "@vite/client"];

  while (Date.now() < until) {
    for (const u of cand) {
      if (await headPing(u, 900)) return true;
      if (await getOk(u, 1500)) return true; // vissa dev-servrar svarar inte på HEAD
    }
    await sleep(350);
  }
  return false;
}

/** Returnera första “truthy” från en uppsättning promisor – annars null. */
function firstTruthy<T>(promises: Promise<T>[], pred: (v: T) => boolean): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = promises.length;
    let resolved = false;
    for (const p of promises) {
      p.then((v) => {
        if (!resolved && pred(v)) {
          resolved = true;
          resolve(v);
        }
      }).finally(() => {
        pending -= 1;
        if (!resolved && pending === 0) resolve(null);
      });
    }
  });
}

async function guessPortsFast(): Promise<string | null> {
  const ports = [
    5173, 4173,        // Vite dev / preview
    3000, 3001,        // Next/React/Remix
    4200,              // Angular
    8080, 8081,        // webpack dev server
    4321,              // Astro
    6006,              // Storybook
    1420,              // Nx/Tauri m.fl.
    5174, 5175, 5172,  // fler Vite-varianter
    3333,              // Nx defaults
    1234,              // Parcel
    5500               // Live Server / statiska
  ];

  const urls: string[] = [];
  for (const p of ports) {
    urls.push(`http://127.0.0.1:${p}/`, `http://localhost:${p}/`);
  }

  const probes = urls.map(u => headPing(u, 900).then(ok => (ok ? u : null)));
  const hit = await firstTruthy(probes as unknown as Promise<string>[], (v) => Boolean(v));
  return (hit as string | null) ?? null;
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
      try {
        process.kill(-child.pid, "SIGTERM"); // -pid = grupp
      } catch {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }

      setTimeout(() => {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
        }
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        done();
      }, 400);
    } catch {
      done();
    }
  });
}

/** Stoppa nuvarande dev-server om en finns. Säkert att kalla flera gånger. */
export async function stopDevServer(): Promise<void> {
  if (!activeChild) return;
  const child = activeChild;
  activeChild = null;
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
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
    ".ts":   "text/javascript; charset=utf-8",   // OBS: transpilerar inte TS
    ".tsx":  "text/javascript; charset=utf-8",   // OBS: transpilerar inte TSX
    ".jsx":  "text/javascript; charset=utf-8",   // OBS: transpilerar inte JSX
    ".wasm": "application/wasm",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".txt":  "text/plain; charset=utf-8"
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

      // Säkra mot path traversal
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

      // Svara snabbt på HEAD utan kropp
      if (req.method === "HEAD") {
        try {
          const s = fs.statSync(filePath);
          res.setHeader("Content-Length", String(s.size));
        } catch { /* ignore size */ }
        res.end();
        return;
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
    if (activeInline === server) {
      await stopInlineServer();
    } else {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  return { localUrl, externalUrl: externalUri.toString(true), stop };
}

/* ─────────────────────────────────────────────────────────
   Kör dev-kommando och hitta URL (race: loggar + portgissning)
   ───────────────────────────────────────────────────────── */

/**
 * Kör ett dev-kommando och försök hitta URL att bädda in.
 * Rensar alltid upp ev. tidigare process först.
 * Returnerar även en stop()-funktion för explicit nedstängning.
 */
export async function runDevServer(
  devCmd: string,
  cwd: string
): Promise<{ localUrl: string; externalUrl: string; stop: () => Promise<void> }> {
  // Endast en aktiv server åt gången
  await stopDevServer();

  const out = vscode.window.createOutputChannel("AI Figma Codegen – Dev Server");
  out.appendLine(`Startar: "${devCmd}" i ${cwd}`);

  const child = spawn(devCmd, {
    cwd,
    shell: true,
    env: {
      ...process.env,
      HOST: "127.0.0.1",  // undvik "::" / 0.0.0.0
      BROWSER: "none",    // förhindra att CLI öppnar systembrowser
      // Viktigt: sätt INTE PORT=0 här – låt verktyget välja egen port om vi inte explicit sätter det i kommandot
      NO_COLOR: "1",      // be CLIs att inte färga
      FORCE_COLOR: "0"    // säkerhetsbälte om NO_COLOR ignoreras
    },
    detached: os.platform() !== "win32",
    windowsHide: true
  });

  activeChild = child;

  let resolvedUrl: string | null = null;
  let resolveLogUrl: ((u: string | null) => void) | null = null;

  const logUrlPromise = new Promise<string | null>((resolve) => {
    resolveLogUrl = resolve;
  });

  const handleChunk = (buf: Buffer) => {
    const raw = buf.toString();
    out.append(raw);               // visa original i Output
    const text = stripAnsi(raw);   // strippa ANSI innan matchning
    if (!resolvedUrl) {
      const maybe = extractUrl(text);
      if (maybe) {
        const normalized = normalizeLocalUrl(maybe);
        resolvedUrl = normalized;
        if (resolveLogUrl) {
          resolveLogUrl(normalized);
          resolveLogUrl = null;
        }
      }
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  child.on("exit", (code, signal) => {
    if (activeChild === child) activeChild = null;
    out.appendLine(`\n[server] Avslutad (code=${code}, signal=${signal})`);
    if (resolveLogUrl) {
      resolveLogUrl(null);
      resolveLogUrl = null;
    }
  });

  // Starta samtidigt snabb portgissning
  const portGuessPromise = guessPortsFast();

  // Total deadline – generös för kallstart
  const overallDeadlineMs = 30000; // 30s
  const overallTimeout = sleep(overallDeadlineMs).then(() => null as string | null);

  // Race: loggar vs portgissning vs timeout
  const url = (await Promise.race([logUrlPromise, portGuessPromise, overallTimeout])) as string | null;

  if (!url) {
    await stopDevServer();
    throw new Error("Kunde inte hitta dev-serverns URL via loggar eller portgissning inom tidsgränsen.");
  }

  // Säkerställ att servern är nåbar innan vi returnerar
  const reachable = await waitForReachable(url, 12000);
  if (!reachable) {
    await stopDevServer();
    throw new Error(`Dev-servern svarar inte på ${url}`);
  }

  const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));

  const stop = async () => {
    if (activeChild === child) {
      await stopDevServer();
    } else if (child.pid) {
      await killProcessTree(child);
    }
  };

  return { localUrl: normalizeLocalUrl(url), externalUrl: external.toString(true), stop };
}

/* ─────────────────────────────────────────────────────────
   Autodetektera module-entry → starta rätt server automatiskt
   ───────────────────────────────────────────────────────── */

async function findIndexHtml(dir: string): Promise<string | null> {
  const cand = [
    "index.html",
    "public/index.html",
    "dist/index.html", // byggd artefakt
    // Vanliga monorepo/webview-layouter
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
    } catch { /* ignore */ }
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
      return "npm run dev";
    }
  } catch { /* ignore */ }
  return null;
}

/* ─────────────────────────────────────────────────────────
   Auto-install (npm/pnpm/yarn/bun) vid behov
   ───────────────────────────────────────────────────────── */

function detectPM(cwd: string): { pm: "pnpm" | "yarn" | "bun" | "npm"; lock: string | null } {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return { pm: "pnpm", lock: "pnpm-lock.yaml" };
  if (fs.existsSync(path.join(cwd, "yarn.lock")))     return { pm: "yarn", lock: "yarn.lock" };
  if (fs.existsSync(path.join(cwd, "bun.lockb")))     return { pm: "bun",  lock: "bun.lockb" };
  if (fs.existsSync(path.join(cwd, "package-lock.json"))) return { pm: "npm", lock: "package-lock.json" };
  return { pm: "npm", lock: null };
}

function hashFile(p: string): string | null {
  try { return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
}

function installStampPath(cwd: string) {
  return path.join(cwd, "node_modules", ".ai-figma-install.json");
}

function needsInstall(cwd: string): boolean {
  const { lock } = detectPM(cwd);
  const nodeMods = path.join(cwd, "node_modules");
  const stampPath = installStampPath(cwd);

  if (!lock) return !fs.existsSync(nodeMods); // inget lock → heuristik

  const lockPath = path.join(cwd, lock);
  if (!fs.existsSync(lockPath)) return false; // inget att installera
  if (!fs.existsSync(nodeMods)) return true;

  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    const cur = { lock: hashFile(lockPath), node: process.version };
    return !(stamp && stamp.lock === cur.lock && stamp.node === cur.node);
  } catch {
    return true;
  }
}

async function runInstall(cwd: string, out: vscode.OutputChannel) {
  const { pm, lock } = detectPM(cwd);
  const cmd =
    pm === "pnpm" ? "pnpm install --frozen-lockfile" :
    pm === "yarn" ? "yarn install --immutable || yarn install --frozen-lockfile" :
    pm === "bun"  ? "bun install" :
                    "npm ci";

  out.appendLine(`[deps] Kör: ${cmd}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: process.env,
      detached: os.platform() !== "win32",
      windowsHide: true
    });
    child.stdout?.on("data", b => out.append(b.toString()));
    child.stderr?.on("data", b => out.append(b.toString()));
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`install exit ${code}`)));
  });

  try {
    const lockHash = lock ? hashFile(path.join(cwd, lock)) : null;
    const stamp = { lock: lockHash, node: process.version, ts: Date.now() };
    await fsp.mkdir(path.join(cwd, "node_modules"), { recursive: true });
    fs.writeFileSync(installStampPath(cwd), JSON.stringify(stamp), "utf8");
  } catch { /* ignore */ }
}

/* ─────────────────────────────────────────────────────────
   Smart server-start
   ───────────────────────────────────────────────────────── */

/**
 * Starta rätt server automatiskt:
 * 1) auto-installera deps om behövs
 * 2) explicit kommando
 * 3) package.json:s "dev"
 * 4) module-entry hittad → prova Vite dev, sedan preview (port 0)
 * 5) annars inline statisk server
 *
 * OBS: Om index.html refererar .ts/.tsx/.jsx och Vite/preview inte startar
 *      kastas fel i stället för att falla tillbaka till inline.
 */
export async function runSmartServer(
  cwd: string,
  explicitDevCmd?: string
): Promise<{ localUrl: string; externalUrl: string; stop: () => Promise<void> }> {
  // Skapa output-kanal för ev. auto-install
  const out = vscode.window.createOutputChannel("AI Figma Codegen – Dev Server");

  // 0) auto-install om node_modules saknas eller lockfile ändrats
  try {
    if (needsInstall(cwd)) {
      out.appendLine(`[deps] Upptäckte saknade/inkonsistenta beroenden i ${cwd}`);
      await runInstall(cwd, out);
    }
  } catch (e: any) {
    out.appendLine(`[deps] Installationsfel ignoreras: ${e?.message || String(e)}`);
  }

  // 1) explicit kommando
  if (explicitDevCmd?.trim()) {
    try { return await runDevServer(explicitDevCmd, cwd); } catch {}
  }

  // 2) package.json:s dev-script
  const devScript = await readPkgDevScript(cwd);
  if (devScript) {
    try { return await runDevServer(devScript, cwd); } catch {}
  }

  // 3) module-entry ⇒ prova Vite
  const modEntry = await detectModuleEntry(cwd);
  if (modEntry) {
    // Kör Vite på ledig port
    try { return await runDevServer("npx vite --host 127.0.0.1 --port 0", cwd); } catch {}
    try { return await runDevServer("npx vite preview --host 127.0.0.1 --port 0", cwd); } catch {}

    // Om TS/TSX/JSX i index.html → kasta fel i stället för inline-fallback
    if (/\.(ts|tsx|jsx)(\?|#|$)/i.test(modEntry)) {
      throw new Error(
        `index.html refererar ${modEntry}. Starta Vite (npm run dev) eller bygg + "vite preview". ` +
        `Statisk server stödjer inte TS/TSX/JSX utan bundling.`
      );
    }
  }

  // 4) inline fallback – statisk mapp (t.ex. dist/)
  const idx = await findIndexHtml(cwd);
  return await runInlineStaticServer(idx ? path.dirname(idx) : cwd);
}
