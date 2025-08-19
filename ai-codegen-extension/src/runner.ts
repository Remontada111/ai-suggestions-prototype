// extension/src/runner.ts
// Robust dev-server runner + minimal inline static server.
// - Fångar URL:er från loggar för de flesta populära dev-servrar
// - Portgissning (parallell) på vanliga portar
// - Tuff reachability-koll (HEAD/GET, "/", "/index.html")
// - Säkra uppstartsmiljövariabler (HOST=127.0.0.1, BROWSER=none)
// - Processhantering med kill tree
// - Ultralätt inline-server för statiska HTML-mappar

import * as vscode from "vscode";
import { spawn, ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
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
  // ta bort ANSI-färgkoder (räcker för Vite/Nuxt/Remix m.fl.)
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
    // Normalisera till localhost för inbäddning i webview/proxy
    if (
      u.hostname === "0.0.0.0" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::" ||
      u.hostname === "[::]"
    ) {
      u.hostname = "localhost";
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
          // Alla svar räcker för “levande”
          res.resume();
          resolve(true);
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
          // 2xx/3xx betraktas som OK
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
  const cand = [base, base + "index.html"];

  while (Date.now() < until) {
    for (const u of cand) {
      if (await headPing(u, 900)) return true;
      // Om HEAD misslyckas (en del dev-servrar svarar inte på HEAD) → prova GET
      if (await getOk(u, 1500)) return true;
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
  // Utökad lista med vanliga dev/preview-portar
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
  const hit = await firstTruthy(probes, (v) => Boolean(v));
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
      // Dödar hela trädet på Windows
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("exit", done);
      killer.on("error", done);
      return;
    }

    try {
      // Signala processgruppen om möjligt
      try {
        // -pid = grupp
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }

      // Kort fallback till SIGKILL efter ~400ms
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
    ".js":  "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm":"application/wasm",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8"
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
    // Stoppa just denna instans
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
      // Viktigt: sätt INTE PORT=0 här – låt verktyget välja egen port
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
    // Om processen dog innan vi hittade URL – avsluta log-promise
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
    // Stoppa just den här processen
    if (activeChild === child) {
      await stopDevServer();
    } else if (child.pid) {
      await killProcessTree(child);
    }
  };

  return { localUrl: normalizeLocalUrl(url), externalUrl: external.toString(true), stop };
}
