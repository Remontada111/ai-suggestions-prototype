import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";

const URL_PATTERNS = [
  /Local:\s*(https?:\/\/localhost:\d+\/?)/i,           // Vite
  /http:\/\/localhost:\d+\/?/i,
  /http:\/\/127\.0\.0\.1:\d+\/?/i,
  /http:\/\/0\.0\.0\.0:\d+\/?/i,
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

export async function runDevServer(devCmd: string, cwd: string): Promise<{ localUrl: string; externalUrl: string; }> {
  const out = vscode.window.createOutputChannel("AI Figma Codegen – Dev Server");
  out.appendLine(`Startar: "${devCmd}" i ${cwd}`);
  out.show(true);

  const child = spawn(devCmd, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: "1" } });

  let foundUrl: string | null = null;
  child.stdout.on("data", (buf) => {
    const text = buf.toString();
    out.append(text);
    if (!foundUrl) {
      const maybe = extractUrl(text);
      if (maybe) foundUrl = maybe;
    }
  });
  child.stderr.on("data", (buf) => {
    const text = buf.toString();
    out.append(text);
    if (!foundUrl) {
      const maybe = extractUrl(text);
      if (maybe) foundUrl = maybe;
    }
  });

  // Fallback: om vi inte hittar URL inom 30s, gissa vanliga portar
  const deadline = Date.now() + 30000;
  while (!foundUrl && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
  }
  if (!foundUrl) {
    const guesses = ["http://localhost:5173/", "http://localhost:3000/", "http://localhost:4200/"];
    for (const g of guesses) {
      if (await waitForReachable(g, 3000)) { foundUrl = g; break; }
    }
  }

  if (!foundUrl) {
    throw new Error("Kunde inte hitta dev-serverns URL i loggarna. Kontrollera output-kanalen.");
  }

  // Vänta tills servern faktiskt svarar
  const ok = await waitForReachable(foundUrl, 15000);
  if (!ok) {
    throw new Error(`Dev-servern svarar inte på ${foundUrl}`);
  }

  const external = await vscode.env.asExternalUri(vscode.Uri.parse(foundUrl));
  return { localUrl: foundUrl, externalUrl: external.toString(true) };
}
