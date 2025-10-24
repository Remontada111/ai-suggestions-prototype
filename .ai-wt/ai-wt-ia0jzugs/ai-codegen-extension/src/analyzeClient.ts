// extension/src/analyzeClient.ts
// Startar /analyze och pollar tills resultat eller fel.
// Kör i VS Code Extension Host (Node 18+ → global fetch finns).

import type { WebviewPanel } from "vscode";
import * as vscode from "vscode";

/* ─────────────────────────────────────────────────────────
   Konfiguration (VS Code settings)
   ─────────────────────────────────────────────────────────
   aiFigmaCodegen.backendUrl        (str)  ex: "http://localhost:8000" (default)
   aiFigmaCodegen.analyze.startPath (str)  ex: "/analyze"      (default)
   aiFigmaCodegen.analyze.statusPath(str)  ex: "/analyze/{id}" (default)
   aiFigmaCodegen.analyze.profile   (str)  "fast"|"full"       (default: "fast")
   aiFigmaCodegen.analyze.pollTimeoutMs (number, default 120000)
---------------------------------------------------------------- */

const LOG_NS = "ai-figma-codegen/analyze";
const log = (...args: any[]) => console.log(`[${LOG_NS}]`, ...args);
const warn = (...args: any[]) => console.warn(`[${LOG_NS}]`, ...args);
const errlog = (...args: any[]) => console.error(`[${LOG_NS}]`, ...args);

function getCfg() {
  const cfg = vscode.workspace.getConfiguration("aiFigmaCodegen");
  const base = (cfg.get<string>("backendUrl") || "http://localhost:8000").replace(/\/+$/, "");
  const startPath = cfg.get<string>("analyze.startPath") || "/analyze";
  const statusPath = cfg.get<string>("analyze.statusPath") || "/analyze/{id}";
  const defaultProfile = (cfg.get<string>("analyze.profile") || "fast") as "fast" | "full";
  const pollTimeoutMs = cfg.get<number>("analyze.pollTimeoutMs") ?? 120000;

  log("Konfiguration laddad:", {
    base,
    startPath,
    statusPath,
    defaultProfile,
    pollTimeoutMs,
  });

  return { base, startPath, statusPath, defaultProfile, pollTimeoutMs };
}

function joinUrl(base: string, path: string) {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function makeStatusUrl(base: string, statusPath: string, taskId: string) {
  return joinUrl(base, statusPath.replace("{id}", encodeURIComponent(taskId)));
}

/* ─────────────────────────────────────────────────────────
   Typer
   ───────────────────────────────────────────────────────── */
export type AnalyzeMode = "local_paths" | "streamed_files";

export interface AnalyzeManifest {
  mode: AnalyzeMode;
  root_path?: string;
  include?: string[];
  exclude?: string[];
  files?: { path: string; content_b64: string }[];
  max_files?: number;
  max_file_bytes?: number;
  ignored_dirs?: string[];
  /** Valfri profil: "fast" (snabb uppstartsanalys) eller "full" (fördjupad). */
  profile?: "fast" | "full";
}

type StartResp = {
  task_id: string;
  /** Valfri: backend kan returnera absolut eller relativ URL att polla */
  poll_url?: string;
};

type StatusResp = {
  status: "PENDING" | "STARTED" | "RETRY" | "FAILURE" | "SUCCESS" | string;
  project_model?: any;
  error?: string | null;
};

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const method = (init?.method || "GET").toUpperCase();

  log("HTTP →", method, url, init?.headers || {}, init?.body ? "(med body)" : "");
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const ct = res.headers.get("content-type") || "";

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        /* ignore */
      }
      let hint = bodyText;
      try {
        const j = JSON.parse(bodyText);
        if ((j as any)?.detail) {
          hint = typeof (j as any).detail === "string" ? (j as any).detail : JSON.stringify((j as any).detail);
        }
      } catch {
        /* not JSON */
      }
      errlog("HTTP FEL ←", method, url, res.status, res.statusText, "hint:", hint);
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${hint || bodyText || "Unknown error"}`);
    }

    if (/application\/json/i.test(ct)) {
      const data = (await res.json()) as T;
      log("HTTP OK ←", method, url, "(JSON)");
      return data;
    } else {
      const text = (await res.text()) as unknown as T;
      log("HTTP OK ←", method, url, "(TEXT)");
      return text;
    }
  } finally {
    clearTimeout(t);
  }
}

/* ─────────────────────────────────────────────────────────
   Standardmanifest
   ───────────────────────────────────────────────────────── */
export function buildDefaultLocalManifest(workspaceRoot: string, profile?: "fast" | "full"): AnalyzeManifest {
  return {
    mode: "local_paths",
    root_path: workspaceRoot,
    include: ["**/*"],
    exclude: [],
    max_files: 2000,
    max_file_bytes: 300000,
    ignored_dirs: [
      "node_modules","dist","build","out",".next",".svelte-kit",".output",
      ".git","coverage",".venv","venv","__pycache__","dist-webview"
    ],
    profile, // kan vara undefined → backend ignorerar
  };
}

/* ─────────────────────────────────────────────────────────
   Kör analys + polla tills resultat
   ───────────────────────────────────────────────────────── */
export async function runProjectAnalysis(
  panel: WebviewPanel,
  manifest: AnalyzeManifest,
  opts?: { pollTimeoutMs?: number; profile?: "fast" | "full" }
) {
  const cfg = getCfg();
  const pollTimeoutMs = opts?.pollTimeoutMs ?? cfg.pollTimeoutMs;
  const profile = opts?.profile ?? manifest.profile ?? cfg.defaultProfile;

  const startUrl = joinUrl(cfg.base, cfg.startPath);
  const startBody: AnalyzeManifest = { ...manifest, profile };

  // Sanera logg av filer så vi inte spammar base64-innehåll
  const sanitized: any = {
    ...startBody,
    files: startBody.files?.map(f => ({ path: f.path, bytes: f.content_b64?.length ?? 0 })),
  };

  try {
    panel.webview.postMessage({ type: "analysis/status", payload: { status: "STARTING" } });
    log("Startar analys:", { startUrl, body: sanitized });

    const start = await fetchJson<StartResp>(
      startUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody),
      },
      20000
    );

    const taskId = start.task_id;
    let pollUrl = start.poll_url || makeStatusUrl(cfg.base, cfg.statusPath, taskId);
    // Om poll_url är relativ → gör den absolut mot base
    if (!/^https?:\/\//i.test(pollUrl)) pollUrl = joinUrl(cfg.base, pollUrl);

    log("Analys påbörjad:", { taskId, pollUrl });
    panel.webview.postMessage({
      type: "analysis/status",
      payload: { status: "PENDING", taskId, pollUrl }
    });

    const t0 = Date.now();
    let delay = 600;
    let tryCount = 0;

    while (true) {
      tryCount += 1;
      log(`Polling [#${tryCount}]`, { pollUrl, delayMs: delay });

      const st = await fetchJson<StatusResp>(pollUrl, undefined, 15000);
      log("Poll-svar:", st);

      if (st.status === "SUCCESS" && st.project_model) {
        log("Analys SUCCESS – projektmodell mottagen.");
        panel.webview.postMessage({ type: "analysis/result", payload: st.project_model });
        break;
      }
      if (st.status === "FAILURE") {
        errlog("Analys FAILURE:", st.error);
        panel.webview.postMessage({ type: "analysis/error", payload: st.error || "Okänt fel" });
        break;
      }
      if (Date.now() - t0 > pollTimeoutMs) {
        errlog("Analys TIMEOUT:", { elapsedMs: Date.now() - t0, pollTimeoutMs });
        panel.webview.postMessage({ type: "analysis/error", payload: "Timeout: analys tog för lång tid." });
        break;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 200, 2000);
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    errlog("Analysmisslyckande:", msg);
    vscode.window.showWarningMessage(`Analysmisslyckande: ${msg}`);
    panel.webview.postMessage({ type: "analysis/error", payload: msg });
  }
}
