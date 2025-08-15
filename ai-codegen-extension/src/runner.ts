import * as fs from "node:fs";
import * as path from "node:path";
import { AddressInfo } from "node:net";

let activeInline: http.Server | null = null;

function contentType(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return ({
    ".html":"text/html; charset=utf-8",
    ".js":"application/javascript; charset=utf-8",
    ".mjs":"application/javascript; charset=utf-8",
    ".css":"text/css; charset=utf-8",
    ".json":"application/json; charset=utf-8",
    ".png":"image/png",
    ".jpg":"image/jpeg",
    ".jpeg":"image/jpeg",
    ".gif":"image/gif",
    ".svg":"image/svg+xml",
    ".ico":"image/x-icon",
    ".txt":"text/plain; charset=utf-8",
  } as Record<string,string>)[ext] || "application/octet-stream";
}

export async function stopInlineServer(): Promise<void> {
  if (!activeInline) return;
  await new Promise<void>(r => activeInline!.close(() => r()));
  activeInline = null;
}

export async function runInlineStaticServer(
  dir: string
): Promise<{ localUrl: string; externalUrl: string; stop: () => Promise<void> }> {
  await stopInlineServer();

  activeInline = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      let fp = path.join(dir, decodeURIComponent(url.pathname));
      // säkra mot path traversal
      if (!fp.startsWith(path.resolve(dir) + path.sep)) {
        res.statusCode = 400; return void res.end("Bad request");
      }
      if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) {
        fp = path.join(fp, "index.html");
      }
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
        res.statusCode = 404; return void res.end("Not found");
      }
      res.setHeader("Content-Type", contentType(fp));
      fs.createReadStream(fp).pipe(res);
    } catch {
      res.statusCode = 500; res.end("Server error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    activeInline!.once("error", reject);
    activeInline!.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (activeInline!.address() as AddressInfo).port;
  const localUrl = `http://localhost:${port}/`;
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(localUrl));
  const stop = async () => { await stopInlineServer(); };

  return { localUrl, externalUrl: external.toString(true), stop };
}
// extension/src/runner.ts
import * as vscode from "vscode";
import { spawn, ChildProcess } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";

const URL_PATTERNS = [
  /Local:\s*(https?:\/\/localhost:\d+\/?)/i,                  // Vite/Astro/Nuxt-varianter
  /ready in .*? and running at:\s*(https?:\/\/[^\s]+)/i,      // Astro
  /started server on .*?(https?:\/\/[^\s]+)/i,                // Remix/Solid
  /Storybook .* started .* at (https?:\/\/[^\s]+)/i,          // Storybook
  /http:\/\/localhost:\d+\/?/i,
  /https?:\/\/127\.0\.0\.1:\d+\/?/i,
  /https?:\/\/0\.0\.0\.0:\d+\/?/i,
  /https?:\/\/[^\s]+:\d+\/?/i
];

function extractUrl(line: string): string | null {
  for (const re of URL_PATTERNS) {
    const m = line.match(re);
    if (m) return (m[1] ?? m[0]);
  }
  return null;
}

async function waitForReachable(rawUrl: string, timeoutMs = 15000): Promise<boolean> {
  const end = Date.now() + timeoutMs;

  const ping = () => new Promise<boolean>(resolve => {
    try {
      const u = new URL(rawUrl);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(
        { method: "HEAD", hostname: u.hostname, port: u.port, path: u.pathname, timeout: 2500 },
        () => { resolve(true); req.destroy(); }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });

  while (Date.now() < end) {
    if (await ping()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function guessPorts(): Promise<string | null> {
  const candidates = [5173, 3000, 4200, 8080, 4321, 6006, 5174, 5175, 3333, 5172];
  for (const p of candidates) {
    const u = `http://localhost:${p}/`;
    if (await waitForReachable(u, 2000)) return u;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────
   Process-hantering (kill tree, aktiv process)
   ───────────────────────────────────────────────────────── */
let activeChild: ChildProcess | null = null;

async function killProcessTree(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!child.pid) return resolve();

    const onDone = () => resolve();

    if (process.platform === "win32") {
      // Dödar hela trädet på Windows
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      killer.on("exit", onDone);
      killer.on("error", onDone);
    } else {
      try {
        // Om vi spawna med detached: true kan vi signala gruppen via -pid
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* fall back below */ }
        // Sista utväg: SIGKILL på huvudprocessen efter kort väntan
        setTimeout(() => {
          if (child.pid !== undefined) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* ok */ }
          }
          try { child.kill("SIGKILL"); } catch { /* ok */ }
          onDone();
        }, 1500);
      } catch {
        onDone();
      }
    }
  });
}

/** Stoppa nuvarande dev-server om en finns. Säkert att kalla flera gånger. */
export async function stopDevServer(): Promise<void> {
  if (activeChild) {
    const c = activeChild;
    activeChild = null;
    try { c.kill("SIGTERM"); } catch { /* ignore */ }
    await killProcessTree(c);
  }
}

/* ─────────────────────────────────────────────────────────
   Kör dev-kommando och hitta URL
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
  // Säkerställ endast en aktiv server i taget
  await stopDevServer();

  const out = vscode.window.createOutputChannel("AI Figma Codegen – Dev Server");
  out.appendLine(`Startar: "${devCmd}" i ${cwd}`);
  out.show(true);

  // Viktigt: detached:true skapar en egen processgrupp (kill -PID funkar på *nix)
  const child = spawn(devCmd, {
    cwd,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "1" },
    detached: os.platform() !== "win32", // windows använder taskkill oavsett
  });
  activeChild = child;

  let foundUrl: string | null = null;

  const handleChunk = (buf: Buffer) => {
    const text = buf.toString();
    out.append(text);
    if (!foundUrl) {
      const maybe = extractUrl(text);
      if (maybe) foundUrl = maybe;
    }
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  // Om processen dör tidigt, rensa state
  child.on("exit", (code, signal) => {
    if (activeChild === child) activeChild = null;
    out.appendLine(`\n[server] Avslutad (code=${code}, signal=${signal})`);
  });

  // Fallback: om vi inte hittar URL inom 30s, gissa vanliga portar
  const deadline = Date.now() + 30000;
  while (!foundUrl && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
  }
  if (!foundUrl) {
    foundUrl = await guessPorts();
  }

  if (!foundUrl) {
    // Städa upp processen innan vi kastar fel
    await stopDevServer();
    throw new Error("Kunde inte hitta dev-serverns URL i loggarna eller via portgissning. Kontrollera output-kanalen.");
  }

  // Vänta tills servern faktiskt svarar
  const ok = await waitForReachable(foundUrl, 15000);
  if (!ok) {
    await stopDevServer();
    throw new Error(`Dev-servern svarar inte på ${foundUrl}`);
  }

  const external = await vscode.env.asExternalUri(vscode.Uri.parse(foundUrl));

  const stop = async () => {
    if (activeChild === child) {
      await stopDevServer();
    } else if (child.pid) {
      // Om någon annan redan tagit över activeChild, försök ändå stänga denna
      await killProcessTree(child);
    }
  };

  return { localUrl: foundUrl, externalUrl: external.toString(true), stop };
}
