// extension/src/analyzeClient.ts
// Klient som startar /analyze och pollar tills resultat eller fel.
// Kör i VS Code Extension Host (Node 18+ → global fetch finns).

import type { WebviewPanel } from "vscode";
import * as vscode from "vscode";

const API_BASE = "http://localhost:8000";

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
}

type StartResp = { task_id: string };
type StatusResp = {
  status: "PENDING" | "STARTED" | "RETRY" | "FAILURE" | "SUCCESS" | string;
  project_model?: any;
  error?: string | null;
};

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export function buildDefaultLocalManifest(workspaceRoot: string): AnalyzeManifest {
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
  };
}

export async function runProjectAnalysis(panel: WebviewPanel, manifest: AnalyzeManifest, opts?: { pollTimeoutMs?: number }) {
  const pollTimeoutMs = opts?.pollTimeoutMs ?? 120000;
  try {
    panel.webview.postMessage({ type: "analysis/status", payload: { status: "STARTING" } });

    const start = await fetchJson<StartResp>(`${API_BASE}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });

    const taskId = start.task_id;
    panel.webview.postMessage({ type: "analysis/status", payload: { status: "PENDING", taskId } });

    const t0 = Date.now();
    let delay = 600;
    while (true) {
      const st = await fetchJson<StatusResp>(`${API_BASE}/analyze/${encodeURIComponent(taskId)}`, undefined, 15000);

      if (st.status === "SUCCESS" && st.project_model) {
        panel.webview.postMessage({ type: "analysis/result", payload: st.project_model });
        break;
      }
      if (st.status === "FAILURE") {
        panel.webview.postMessage({ type: "analysis/error", payload: st.error || "Okänt fel" });
        break;
      }
      if (Date.now() - t0 > pollTimeoutMs) {
        panel.webview.postMessage({ type: "analysis/error", payload: "Timeout: analys tog för lång tid." });
        break;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 200, 2000);
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    vscode.window.showWarningMessage(`Analysmisslyckande: ${msg}`);
    panel.webview.postMessage({ type: "analysis/error", payload: msg });
  }
}
