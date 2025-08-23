// extension/src/extension.ts
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";

import { detectProjects, Candidate } from "./detector";
import { runDevServer, stopDevServer, runInlineStaticServer, stopInlineServer } from "./runner";

// ⬇️ ML: ladda eventuell modell (faller tillbaka till heuristik om ingen finns)
import { loadModelIfAny } from "./ml/classifier";

// ⬇️ Dataset-export (för träning senare)
import { exportDatasetCommand } from "./commands/exportDataset";

let currentPanel: vscode.WebviewPanel | undefined;

const LOG_NS = "ai-figma-codegen/ext";
const log = (...args: any[]) => console.log(`[${LOG_NS}]`, ...args);
const warn = (...args: any[]) => console.warn(`[${LOG_NS}]`, ...args);
const errlog = (...args: any[]) => console.error(`[${LOG_NS}]`, ...args);

type InitPayload = {
  type: "init";
  taskId?: string;
  fileKey: string;
  nodeId: string;
  token?: string;
  figmaToken?: string;
};

let lastInitPayload: InitPayload | null = null;
let lastDevUrl: string | null = null;
let pendingCandidate: Candidate | null = null;

// 🔹 Cache för senaste detekterade kandidater + statusknapp
let lastCandidates: Candidate[] = [];
let statusItem: vscode.StatusBarItem | undefined;

const AUTO_START_SURE_THRESHOLD = 12;

// 🔹 Enkel UI-fas som webview kan återställas till vid behov
type UiPhase = "default" | "onboarding" | "loading";
let lastUiPhase: UiPhase = "default";

/* ─────────────────────────────────────────────────────────
   AUTO-RELOAD för statiska previews (inline/http-server)
   ───────────────────────────────────────────────────────── */
let reloadWatcher: vscode.FileSystemWatcher | undefined;
let reloadTimer: NodeJS.Timeout | undefined;
let reloadBaseUrl: string | null = null;

function stopReloadWatcher() {
  try { reloadWatcher?.dispose(); } catch { /* ignore */ }
  reloadWatcher = undefined;
  if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = undefined; }
  reloadBaseUrl = null;
}

function startReloadWatcher(rootDir: string, baseUrl: string) {
  stopReloadWatcher();
  reloadBaseUrl = baseUrl;

  const pattern = new vscode.RelativePattern(
    rootDir,
    "**/*.{html,htm,css,js,jsx,tsx,vue,svelte}"
  );

  reloadWatcher = vscode.workspace.createFileSystemWatcher(pattern);

  const onEvt = (uri: vscode.Uri) => {
    const p = uri.fsPath.replace(/\\/g, "/");
    if (/\/(node_modules|\.git|dist|build|out)\//.test(p)) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!currentPanel || !reloadBaseUrl) return;
      const bust =
        `${reloadBaseUrl}${reloadBaseUrl.includes("?") ? "&" : "?"}` +
        `__ext_bust=${Date.now().toString(36)}`;
      lastDevUrl = bust;
      currentPanel.webview.postMessage({ type: "devurl", url: bust });
    }, 200);
  };

  reloadWatcher.onDidChange(onEvt);
  reloadWatcher.onDidCreate(onEvt);
  reloadWatcher.onDidDelete(onEvt);

  log("Auto-reload watcher startad:", { rootDir, baseUrl });
}

/* ─────────────────────────────────────────────────────────
   Hjälpare
   ───────────────────────────────────────────────────────── */
async function headExists(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    return await new Promise<boolean>((resolve) => {
      const req = mod.request(
        {
          method: "HEAD",
          hostname: u.hostname,
          port: u.port,
          path: u.pathname || "/",
          timeout: 1500,
        },
        (res) => {
          res.resume();
          resolve((res.statusCode ?? 500) < 400);
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
  } catch {
    return false;
  }
}

function normalizeDevCmdPorts(raw: string): string {
  let cmd = raw;
  if (/\bnext\s+dev\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd)) cmd += " --port 0";
  if (/\bvite(\s+dev)?\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd)) cmd += " --port 0";
  if (/\bastro\s+dev\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd)) cmd += " --port 0";
  if (/\bremix\s+dev\b/.test(cmd) && !/\s(--port|-p)\s+\d+/.test(cmd)) cmd += " --port 0";
  if (/\bsolid-start\s+dev\b/.test(cmd) && !/\s(--port|-p)\s+\d+/.test(cmd)) cmd += " --port 0";
  if (/\bnuxi\s+dev\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd)) cmd += " --port 0";
  if (/\bwebpack\s+serve\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd)) cmd += " --port 0";
  if (/\bstorybook\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd)) cmd += " --port 0";
  return cmd;
}

function resolveBundledModelPath(context: vscode.ExtensionContext): string | undefined {
  const cand: string[] = [
    path.resolve(context.asAbsolutePath("."), "ml_artifacts", "frontend-detector-gbdt.json"),
    path.resolve(context.asAbsolutePath("."), "dist", "ml_artifacts", "frontend-detector-gbdt.json"),
    path.resolve(__dirname, "..", "ml_artifacts", "frontend-detector-gbdt.json"),
    path.resolve(__dirname, "..", "..", "ml_artifacts", "frontend-detector-gbdt.json"),
  ];
  for (const p of cand) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return undefined;
}

/* ─────────────────────────────────────────────────────────
   Panel och meddelandehantering
   ───────────────────────────────────────────────────────── */
function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (!currentPanel) {
    log("Skapar ny Webview-panel …");
    currentPanel = vscode.window.createWebviewPanel(
      "aiFigmaCodegen.panel",
      "🎯 Project Preview",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))],
      }
    );

    currentPanel.onDidDispose(() => {
      log("Panel stängdes – städar upp servrar och state.");
      currentPanel = undefined;
      lastDevUrl = null;
      lastInitPayload = null;
      pendingCandidate = null;
      lastUiPhase = "default";
      stopReloadWatcher();
      (async () => {
        try { await stopDevServer(); } catch (e) { warn("stopDevServer fel:", e); }
        try { await stopInlineServer(); } catch (e) { warn("stopInlineServer fel:", e); }
      })();
    });

    currentPanel.webview.onDidReceiveMessage(async (msg: any) => {
      log("Meddelande från webview:", msg?.type ?? msg?.cmd ?? msg);
      if (msg?.type === "ready") {
        if (lastInitPayload) currentPanel!.webview.postMessage(lastInitPayload);
        if (lastDevUrl) currentPanel!.webview.postMessage({ type: "devurl", url: lastDevUrl });
        if (lastUiPhase === "onboarding") {
          currentPanel!.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
        } else if (lastUiPhase === "loading") {
          currentPanel!.webview.postMessage({ type: "ui-phase", phase: "loading" });
        }
        if (pendingCandidate) postCandidateProposal(pendingCandidate);
        return;
      }

      if (msg?.cmd === "acceptCandidate") {
        if (!pendingCandidate) { warn("acceptCandidate utan pendingCandidate – ignorerar."); return; }
        await startCandidatePreviewWithFallback(pendingCandidate, context);
        return;
      }

      if (msg?.cmd === "chooseProject") {
        await showProjectQuickPick(context);
        return;
      }

      // 🟡 NYTT: Onboarding-knapp – välj MAPP
      if (msg?.cmd === "pickFolder") {
        await pickFolderAndStart(context);
        return;
      }

      if (msg?.cmd === "openPR" && typeof msg.url === "string") {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      }

      if (msg?.cmd === "chat" && typeof msg.text === "string") {
        log("[chat]", msg.text);
        return;
      }
    });

    currentPanel.webview.html = getWebviewHtml(context, currentPanel.webview);
    log("Webview HTML laddad.");
  } else {
    currentPanel.reveal(vscode.ViewColumn.Two);
  }
  return currentPanel;
}

function postCandidateProposal(c: Candidate) {
  if (!currentPanel) return;
  const label = c.pkgName ? c.pkgName : path.basename(c.dir);
  const launchCmd = selectLaunchCommand(c);
  const description = `${c.framework} • ${launchCmd ?? c.runCandidates?.[0]?.cmd ?? "auto"}`;
  currentPanel.webview.postMessage({
    type: "candidate-proposal",
    payload: { label, description, dir: c.dir, launchCmd: launchCmd ?? undefined },
  });
}

/* ─────────────────────────────────────────────────────────
   Upptäckt & uppstart
   ───────────────────────────────────────────────────────── */
function selectLaunchCommand(c: Candidate): string | undefined {
  const raw = c.devCmd ?? c.runCandidates?.[0]?.cmd;
  if (!raw) {
    warn("Inget devCmd funnet för kandidat:", c.dir);
    return undefined;
  }
  if (/\bhttp-server\b/i.test(raw)) {
    let patched = raw
      .replace(/\s--port\s+\d+/i, " --port 0")
      .replace(/\s-p\s+\d+/i, " -p 0");
    if (!/(\s--port|\s-p)\s+\d+/i.test(patched)) patched += " -p 0";
    return patched;
  }
  const norm = normalizeDevCmdPorts(raw);
  return norm;
}

async function findExistingHtml(c: Candidate): Promise<{ relHtml: string; root: string } | null> {
  if (c.entryHtml) return { relHtml: normalizeRel(c.entryHtml), root: c.dir };
  const candidates = [
    "index.html",
    "public/index.html",
    "apps/web/index.html",
    "packages/web/public/index.html",
  ];
  for (const rel of candidates) {
    const p = path.join(c.dir, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return { relHtml: normalizeRel(rel), root: c.dir };
    }
  }
  return null;
}
function normalizeRel(rel: string): string {
  return rel.replace(/^\.\//, "").replace(/^\/+/, "");
}

async function startOrRespectfulFallback(
  c: Candidate,
  context: vscode.ExtensionContext
): Promise<{ externalUrl: string; mode: "dev" | "http" | "inline"; watchRoot?: string }> {
  const cmd = selectLaunchCommand(c);
  if (cmd) {
    try {
      const { externalUrl } = await runDevServer(cmd, c.dir);

      if (/\bhttp-server\b/i.test(cmd)) {
        const html = await findExistingHtml(c);
        if (html) {
          const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
          const url = base + encodeURI(html.relHtml);
          return { externalUrl: url, mode: "http", watchRoot: html.root };
        }
        return { externalUrl, mode: "http", watchRoot: c.dir };
      }

      try {
        const ok = await headExists(externalUrl);
        if (!ok && c.entryHtml) {
          const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
          const url = base + encodeURI(normalizeRel(c.entryHtml));
          return { externalUrl: url, mode: "dev" };
        }
      } catch { /* ignore */ }

      return { externalUrl, mode: "dev" };
    } catch (e: any) {
      errlog("Dev-server start misslyckades:", e?.message || e);
    }
  }

  const html = await findExistingHtml(c);
  if (html) {
    const { externalUrl } = await runInlineStaticServer(html.root);
    const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
    return { externalUrl: base + encodeURI(html.relHtml), mode: "inline", watchRoot: html.root };
  }

  const storageDir = await ensureStoragePreview(context);
  const { externalUrl } = await runInlineStaticServer(storageDir);
  return { externalUrl, mode: "inline", watchRoot: storageDir };
}

/** Bygg liten temporär preview i globalStorage (används som fallback) */
async function ensureStoragePreview(context: vscode.ExtensionContext): Promise<string> {
  const root = context.globalStorageUri.fsPath;
  const previewDir = path.join(root, "ai-figma-preview");
  await fsp.mkdir(previewDir, { recursive: true });

  const indexPath = path.join(previewDir, "index.html");
  const mainPath = path.join(previewDir, "main.js");

  if (!fs.existsSync(indexPath)) {
    const html = `<!doctype html>
<html lang="sv">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>AI Preview</title>
    <style>
      :root {
        --bg: var(--vscode-sideBar-background);
        --fg: var(--vscode-foreground);
        --muted: color-mix(in srgb, var(--vscode-foreground) 65%, var(--vscode-sideBar-background) 35%);
        --border: color-mix(in srgb, var(--vscode-foreground) 20%, var(--vscode-sideBar-background) 80%);
        --card: var(--vscode-editorWidget-background);
        --btn-bg: var(--vscode-button-background);
        --btn-fg: var(--vscode-button-foreground);
        --btn-hover: color-mix(in srgb, var(--vscode-button-background) 85%, black 15%);
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 ui-sans-serif,system-ui; }
      .wrap { padding: 10px; display: grid; gap: 10px; }
      .bar {
        display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        border: 1px solid var(--border); border-radius: 10px; background: var(--card);
      }
      .bar .grow { flex: 1; min-width: 0; }
      .btn {
        appearance: none; border: 0; border-radius: 8px; padding: 6px 10px;
        background: var(--btn-bg); color: var(--btn-fg); cursor: pointer; font: inherit;
      }
      .btn:hover { background: var(--btn-hover); }
      .mini {
        width: 100%; height: 260px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--card);
      }
      iframe { display:block; width:100%; height:100%; border:0; }
      .url { opacity:.9; word-break: break-all; }
      .muted { color: var(--muted); }
      .card {
        border: 1px solid var(--border); border-radius: 12px; background: var(--card); padding: 10px; display: grid; gap: 6px;
      }
      .row { display:flex; gap:8px; align-items:center; }
      .label { font-weight:600; }
      .desc { opacity:.9; }
      .dir { font-family: ui-monospace, Menlo, Monaco, "SF Mono", monospace; opacity:.85; }
      .actions { display:flex; gap:8px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="bar">
        <div class="grow">
          <div class="muted">Förhandsvisning</div>
          <div id="info" class="url">Väntar på URL …</div>
        </div>
        <button class="btn" id="chooseBtn">Välj projekt…</button>
      </div>

      <div id="proposal" class="card" style="display:none">
        <div class="row"><div class="label">Föreslagen kandidat</div></div>
        <div class="row"><div id="pLabel"></div></div>
        <div class="row desc"><div id="pDesc"></div></div>
        <div class="row dir"><div id="pDir"></div></div>
        <div class="actions">
          <button class="btn" id="acceptBtn">Starta föreslagen</button>
          <button class="btn" id="altBtn">Välj projekt…</button>
        </div>
      </div>

      <div class="mini"><iframe id="preview" sandbox="allow-scripts allow-forms allow-same-origin"></iframe></div>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const iframe = document.getElementById('preview');
      const info = document.getElementById('info');
      const proposal = document.getElementById('proposal');
      const pLabel = document.getElementById('pLabel');
      const pDesc  = document.getElementById('pDesc');
      const pDir   = document.getElementById('pDir');

      document.getElementById('chooseBtn').addEventListener('click', () => vscode.postMessage({ cmd: 'chooseProject' }));
      document.getElementById('altBtn').addEventListener('click', () => vscode.postMessage({ cmd: 'chooseProject' }));
      document.getElementById('acceptBtn').addEventListener('click', () => vscode.postMessage({ cmd: 'acceptCandidate' }));

      window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg?.type === 'devurl') { iframe.src = msg.url; info.textContent = msg.url; }
        if (msg?.type === 'candidate-proposal' && msg?.payload) {
          const { label, description, dir } = msg.payload;
          pLabel.textContent = label;
          pDesc.textContent = description || '';
          pDir.textContent = dir || '';
          proposal.style.display = 'grid';
        }
      });

      vscode.postMessage({ type: 'ready' });
    </script>
  </body>
</html>`;
    await fsp.writeFile(indexPath, html, "utf8");
  }

  if (!fs.existsSync(mainPath)) {
    const js = `const el = document.getElementById('app');
el.style.fontFamily = 'ui-sans-serif, system-ui';
el.style.padding = '12px';
el.style.lineHeight = '1.4';
el.innerHTML = '<h1 style="margin:0 0 4px 0;font-size:18px">AI Preview</h1>' +
               '<p>Ingen körbar dev-server och ingen befintlig index.html hittades i projektet.</p>' +
               '<p>Denna temporära yta ligger i extensionens storage – inget skrevs in i projektet.</p>';`;
    await fsp.writeFile(mainPath, js, "utf8");
  }

  return previewDir;
}

/**
 * Starta kandidatens preview:
 * - Normalt: placeholder → byt när redo.
 * - Med silentUntilReady: ingen placeholder; skicka bara devurl när klart.
 */
async function startCandidatePreviewWithFallback(
  c: Candidate,
  context: vscode.ExtensionContext,
  opts?: { silentUntilReady?: boolean }
) {
  const panel = ensurePanel(context);

  try { await stopDevServer(); } catch { /* ignore */ }
  try { await stopInlineServer(); } catch { /* ignore */ }
  stopReloadWatcher();

  // Silent-läget används för onboarding-flowet (visa loader tills klart)
  const silent = !!opts?.silentUntilReady;

  let placeholder: Awaited<ReturnType<typeof runInlineStaticServer>> | null = null;

  if (!silent) {
    const storageDir = await ensureStoragePreview(context);
    placeholder = await runInlineStaticServer(storageDir);
    lastDevUrl = placeholder.externalUrl;
    panel.webview.postMessage({ type: "devurl", url: lastDevUrl });
  }

  (async () => {
    try {
      const res = await startOrRespectfulFallback(c, context);
      lastDevUrl = res.externalUrl;
      panel.webview.postMessage({ type: "devurl", url: res.externalUrl });

      if ((res.mode === "inline" || res.mode === "http") && res.watchRoot) {
        startReloadWatcher(res.watchRoot, res.externalUrl);
      } else {
        stopReloadWatcher();
      }

      if (placeholder) {
        try { await placeholder.stop(); } catch (e) { warn("Kunde inte stoppa placeholder-server:", e); }
      }

      // Meddela att bakgrundsladdning är klar
      lastUiPhase = "default";
      panel.webview.postMessage({ type: "ui-phase", phase: "default" });
    } catch (err: any) {
      errlog("Primär preview misslyckades:", err?.message || String(err));
      if (!silent) return; // i normal-läge finns redan placeholder
      // I silent-läge: signalera fel (enkelt)
      panel.webview.postMessage({ type: "ui-error", message: String(err?.message || err) });
    }
  })();
}

/* ─────────────────────────────────────────────────────────
   UI: Manuell projektväljare (QuickPick)
   ───────────────────────────────────────────────────────── */
function toPickItems(candidates: Candidate[]): Array<vscode.QuickPickItem & { _c: Candidate }> {
  return candidates.map((c) => {
    const label = c.pkgName || path.basename(c.dir);
    const cmd = selectLaunchCommand(c) ?? c.runCandidates?.[0]?.cmd ?? "auto";
    const description = `${c.framework} • ${cmd}`;
    const detail = c.dir;
    return { label, description, detail, _c: c };
  });
}

async function showProjectQuickPick(context: vscode.ExtensionContext) {
  const panel = ensurePanel(context);
  panel.reveal(vscode.ViewColumn.Two);

  if (!lastCandidates.length) {
    try { lastCandidates = await detectProjects([]); }
    catch (e: any) {
      vscode.window.showErrorMessage(`Kunde inte hitta kandidater: ${e?.message || String(e)}`);
      return;
    }
  }
  if (!lastCandidates.length) {
    vscode.window.showWarningMessage("Hittade inga kandidater att välja bland.");
    return;
  }

  const chosen = await vscode.window.showQuickPick(toPickItems(lastCandidates), {
    placeHolder: "Välj projekt att förhandsvisa",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!chosen) return;

  pendingCandidate = chosen._c;
  postCandidateProposal(pendingCandidate);
  await startCandidatePreviewWithFallback(pendingCandidate, context);
}

/* 🟡 NYTT: Välj mapp (onboarding) och starta i bakgrunden */
async function pickFolderAndStart(context: vscode.ExtensionContext) {
  const panel = ensurePanel(context);
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: "Välj folder",
    openLabel: "Välj folder",
  });
  if (!uris || !uris.length) return;

  const folderPath = uris[0].fsPath;
  lastUiPhase = "loading";
  panel.webview.postMessage({ type: "ui-phase", phase: "loading" });

  try {
    const candidates = await detectProjects([folderPath]);
    lastCandidates = candidates;
    if (!candidates.length) {
      vscode.window.showWarningMessage("Inga körbara frontend-kandidater hittades i vald folder.");
      lastUiPhase = "onboarding";
      panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
      return;
    }
    pendingCandidate = candidates[0];
    // Starta tyst i bakgrunden; webview visar loader tills vi skickar devurl
    await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
  } catch (e: any) {
    errlog("Folder-start misslyckades:", e?.message || String(e));
    vscode.window.showErrorMessage(`Start i vald folder misslyckades: ${e?.message || String(e)}`);
    lastUiPhase = "onboarding";
    panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
  }
}

/* ─────────────────────────────────────────────────────────
   Webview HTML + CSP (fallback om dist saknas)
   ───────────────────────────────────────────────────────── */
function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const distDir = path.join(context.extensionPath, "dist-webview");
  const htmlPath = path.join(distDir, "index.html");

  let html = "";
  try {
    html = fs.readFileSync(htmlPath, "utf8");
  } catch (e) {
    return basicFallbackHtml(webview);
  }

  html = html.replace(/(src|href)=\"([^\"]+)\"/g, (_m, attr, value) => {
    if (/^(https?:)?\/\//.test(value) || value.startsWith("data:") || value.startsWith("#")) {
      return `${attr}="${value}"`;
    }
    const cleaned = value.replace(/^\/+/, "").replace(/^\.\//, "");
    const onDisk = vscode.Uri.file(path.join(distDir, cleaned));
    const asWebview = webview.asWebviewUri(onDisk);
    return `${attr}="${asWebview}"`;
  });

  const cspSource = webview.cspSource;
  html = html.replace(
    "<head>",
    `<head>
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src https: data:;
  style-src 'unsafe-inline' ${cspSource};
  script-src ${cspSource};
  connect-src ${cspSource} http: https: ws: wss:;
  frame-src   http: https:;
">
`
  );

  return html;
}

function basicFallbackHtml(webview: vscode.Webview): string {
  const cspSource = webview.cspSource;
  return /* html */ `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src https: data:;
  style-src 'unsafe-inline' ${cspSource};
  script-src ${cspSource};
  connect-src ${cspSource} http: https: ws: wss:;
  frame-src   http: https:;
">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Project Preview (fallback)</title>
</head>
<body>
<div>Installera webview-bundlen (dist-webview) för full funktion.</div>
<script>window.addEventListener('load',()=>acquireVsCodeApi().postMessage({type:'ready'}));</script>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────
   Aktivering
   ───────────────────────────────────────────────────────── */
export async function activate(context: vscode.ExtensionContext) {
  log("Aktiverar extension …");

  const bundledModelPath = resolveBundledModelPath(context);
  if (bundledModelPath) log("Försöker ladda bundlad ML-modell:", bundledModelPath);
  else log("Ingen bundlad ML-modell hittades (OK för MVP).");

  loadModelIfAny({
    globalStoragePath: context.globalStorageUri.fsPath,
    bundledModelPath,
  });

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = "$(rocket) Preview";
  statusItem.tooltip = "Välj projekt för förhandsvisning";
  statusItem.command = "ai-figma-codegen.chooseProject";
  statusItem.show();
  context.subscriptions.push(statusItem);

  const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
    try {
      const candidates = await detectProjects([]);
      lastCandidates = candidates;
      if (!candidates.length) {
        vscode.window.showWarningMessage("Hittade inga kandidater (körbara frontend-projekt eller statiska mappar).");
        return;
      }
      const panel = ensurePanel(context);
      pendingCandidate = candidates[0];
      postCandidateProposal(pendingCandidate);
      panel.reveal(vscode.ViewColumn.Two);

      if (candidates.length === 1 || (pendingCandidate?.confidence ?? 0) >= AUTO_START_SURE_THRESHOLD) {
        await startCandidatePreviewWithFallback(pendingCandidate!, context);
      } else {
        const pickNow = "Välj projekt…";
        const startTop = "Starta föreslagen";
        const choice = await vscode.window.showInformationMessage(
          "Flera kandidater hittades. Vill du välja manuellt eller starta föreslagen?",
          pickNow, startTop
        );
        if (choice === pickNow) await showProjectQuickPick(context);
        else if (choice === startTop) await startCandidatePreviewWithFallback(pendingCandidate!, context);
      }
    } catch (err: any) {
      errlog("Scan & Preview misslyckades:", err?.message || err);
      vscode.window.showErrorMessage(`Scan & Preview misslyckades: ${err.message}`);
    }
  });

  const openCmd = vscode.commands.registerCommand("ai-figma-codegen.openPanel", async () => {
    const panel = ensurePanel(context);
    panel.reveal(vscode.ViewColumn.Two);
    // OBS: openPanel lämnas som tidigare (ingen onboarding-tvingan här)
    if (!pendingCandidate) {
      const candidates = await detectProjects([]);
      lastCandidates = candidates;
      if (candidates.length) {
        pendingCandidate = candidates[0];
        postCandidateProposal(pendingCandidate);
        if (candidates.length === 1 || (pendingCandidate?.confidence ?? 0) >= AUTO_START_SURE_THRESHOLD) {
          await startCandidatePreviewWithFallback(pendingCandidate!, context);
        }
      }
    }
  });

  const chooseCmd = vscode.commands.registerCommand("ai-figma-codegen.chooseProject", async () => {
    await showProjectQuickPick(context);
  });

  const exportCmd = vscode.commands.registerCommand(
    "ai-figma-codegen.exportFrontendDetectorDataset",
    async () => {
      try { await exportDatasetCommand(); }
      catch (e: any) {
        errlog("ExportDataset fel:", e?.message || String(e));
        vscode.window.showErrorMessage(`ExportDataset misslyckades: ${e?.message || String(e)}`);
      }
    }
  );

  // 🔹 URI-handler (Figma import) – visa BARA onboarding först
  const uriHandler = vscode.window.registerUriHandler({
    handleUri: async (uri: vscode.Uri) => {
      try {
        const params = new URLSearchParams(uri.query);
        const fileKey = params.get("fileKey") || "";
        const nodeId = params.get("nodeId") || "";
        if (!fileKey || !nodeId) {
          vscode.window.showErrorMessage("Saknar fileKey eller nodeId i URI.");
          return;
        }

        const token =
          vscode.workspace.getConfiguration("aiFigmaCodegen").get<string>("figmaToken") || undefined;

        const panel = ensurePanel(context);
        lastInitPayload = { type: "init", fileKey, nodeId, token, figmaToken: token };
        panel.webview.postMessage(lastInitPayload);

        // 🔸 Viktigt: Ingen auto-scan/auto-start här – visa onboarding
        lastUiPhase = "onboarding";
        panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
        panel.reveal(vscode.ViewColumn.Two);
      } catch (e: any) {
        errlog("URI-öppning misslyckades:", e?.message || String(e));
        vscode.window.showErrorMessage(`URI-öppning misslyckades: ${e?.message || String(e)}`);
      }
    },
  });

  context.subscriptions.push(scanCmd, openCmd, chooseCmd, exportCmd, uriHandler);
  log("Extension aktiverad.");
}

export async function deactivate() {
  log("Avaktiverar extension – stänger ev. servrar …");
  stopReloadWatcher();
  try { await stopDevServer(); } catch (e) { warn("stopDevServer fel:", e); }
  try { await stopInlineServer(); } catch (e) { warn("stopInlineServer fel:", e); }
}
