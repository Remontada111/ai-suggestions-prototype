// extension/src/extension.ts
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";

import { detectProjects, Candidate } from "./detector";
import { runDevServer, stopDevServer, runInlineStaticServer, stopInlineServer } from "./runner";
import { loadModelIfAny } from "./ml/classifier";
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

let lastCandidates: Candidate[] = [];
let statusItem: vscode.StatusBarItem | undefined;

// ── Ny: behåll context så vi kan öppna projektväljaren från asynka verifieringar
let extCtxRef: vscode.ExtensionContext | null = null;

const AUTO_START_SURE_THRESHOLD = 12;

type UiPhase = "default" | "onboarding" | "loading";
let lastUiPhase: UiPhase = "default";

/* ─────────────────────────────────────────────────────────
   AUTO-RELOAD (inline/http-server)
   ───────────────────────────────────────────────────────── */
let reloadWatcher: vscode.FileSystemWatcher | undefined;
let reloadTimer: NodeJS.Timeout | undefined;
let reloadBaseUrl: string | null = null;

function stopReloadWatcher() {
  try { reloadWatcher?.dispose(); } catch {}
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
      // ── Ny: verifiera att URL:en faktiskt svarar, annars öppna väljare
      void verifyDevUrlAndMaybeRechoose(bust, "reload");
    }, 200);
  };

  reloadWatcher.onDidChange(onEvt);
  reloadWatcher.onDidCreate(onEvt);
  reloadWatcher.onDidDelete(onEvt);

  log("Auto-reload watcher startad:", { rootDir, baseUrl });
}

/* ─────────────────────────────────────────────────────────
   Hjälpare – nätverksprober och URL-normalisering
   ───────────────────────────────────────────────────────── */
async function headExists(url: string): Promise<boolean> {
  // Behålls för bakåtkompabilitet på vissa ställen
  try {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    return await new Promise<boolean>((resolve) => {
      const req = mod.request(
        {
          method: "HEAD",
          hostname: u.hostname,
          port: u.port,
          path: (u.pathname || "/") + (u.search || ""),
          timeout: 1500,
        },
        (res) => {
          res.resume();
          resolve((res.statusCode ?? 500) < 400);
        }
      );
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
      req.end();
    });
  } catch {
    return false;
  }
}

// ── Ny: generell probe som kan göra HEAD eller GET
async function probe(url: string, method: "HEAD" | "GET", timeoutMs = 2500): Promise<boolean> {
  try {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    return await new Promise<boolean>((resolve) => {
      const req = mod.request(
        {
          method,
          hostname: u.hostname,
          port: u.port,
          path: (u.pathname || "/") + (u.search || ""),
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          const code = res.statusCode ?? 500;
          resolve(code >= 200 && code < 400);
        }
      );
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
      req.end();
    });
  } catch {
    return false;
  }
}

// ── Ny: säkerställ "/" i slutet när vi vill testa rot
function withSlash(u: string): string {
  try {
    const url = new URL(u);
    if (!url.pathname || !url.pathname.endsWith("/")) {
      if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
        url.pathname = (url.pathname || "") + "/";
      }
    }
    return url.toString();
  } catch {
    return u;
  }
}

// ── Ny: enkel cache-bust som garanterar faktisk iframe-reload
function addBust(u: string): string {
  try {
    const url = new URL(u);
    url.searchParams.set("__ext_bust", Date.now().toString(36));
    return url.toString();
  } catch {
    const sep = u.includes("?") ? "&" : "?";
    return `${u}${sep}__ext_bust=${Date.now().toString(36)}`;
  }
}

// ── Ny: snabbcheck (HEAD→GET)
async function quickCheck(url: string): Promise<boolean> {
  if (await probe(url, "HEAD")) return true;
  if (await probe(url, "GET")) return true;
  return false;
}

// ── Ny: endast rotverifiering. Ingen auto-append av /index.html.
async function rootReachable(urlRaw: string): Promise<boolean> {
  const root = withSlash(urlRaw);
  if (await probe(root, "HEAD")) return true;
  if (await probe(root, "GET")) return true;
  return false;
}

// ── Ny: 404 → öppna projektväljaren
async function verifyDevUrlAndMaybeRechoose(url: string, reason: "initial" | "reload") {
  if (!extCtxRef) return;

  const ok = await rootReachable(url);
  if (ok) return;

  const msg = `Preview verkar otillgänglig (${reason}) på ${url}.`;
  warn(msg);
  vscode.window.showWarningMessage(msg);

  lastUiPhase = "onboarding";
  try {
    currentPanel?.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
  } catch {}
  try {
    await showProjectQuickPick(extCtxRef);
  } catch (e) {
    warn("Kunde inte öppna projektväljaren:", e);
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
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return undefined;
}

/* ─────────────────────────────────────────────────────────
   UI-status och remember
   ───────────────────────────────────────────────────────── */
const STORAGE_KEYS = { remembered: "aiFigmaCodegen.rememberedProject.v1" };
type RememberedProject = { dir: string; savedAt: number };

const SETTINGS_NS = "aiFigmaCodegen";
const STORAGE_KEYS_UI = { askedFullView: "ui.askedFullView.v1", zenApplied: "ui.zenApplied.v1" };

function updateStatusBar(current?: Candidate | null) {
  if (!statusItem) return;
  if (current) {
    statusItem.text = `$(rocket) Preview: ${current.pkgName || path.basename(current.dir)}`;
    statusItem.tooltip = "Standardprojekt för förhandsvisning • klicka för att byta";
  } else {
    statusItem.text = "$(rocket) Preview";
    statusItem.tooltip = "Välj standardprojekt för förhandsvisning";
  }
}

async function rememberCandidate(c: Candidate, context: vscode.ExtensionContext) {
  const payload: RememberedProject = { dir: c.dir, savedAt: Date.now() };
  await context.globalState.update(STORAGE_KEYS.remembered, payload);
  updateStatusBar(c);
  log("Sparade valt projekt:", c.dir);
}

async function forgetRemembered(context: vscode.ExtensionContext) {
  await context.globalState.update(STORAGE_KEYS.remembered, undefined);
  updateStatusBar(null);
  vscode.window.showInformationMessage("Glömde sparat projekt.");
}

async function tryGetRememberedCandidate(context: vscode.ExtensionContext): Promise<Candidate | null> {
  const rec = context.globalState.get<RememberedProject | undefined>(STORAGE_KEYS.remembered);
  if (!rec?.dir) return null;
  try {
    if (!fs.existsSync(rec.dir)) {
      await context.globalState.update(STORAGE_KEYS.remembered, undefined);
      return null;
    }
  } catch { return null; }

  try {
    const cands = await detectProjects([rec.dir]);
    if (cands?.length) return cands[0];
  } catch {}
  return null;
}

/** Visa panelen i editor-kolumnen. */
async function enterFullView(panel?: vscode.WebviewPanel) {
  try { panel?.reveal(vscode.ViewColumn.One, false); } catch {}
}

/** Zen Mode, close panels, etc. */
async function tryAutoFullView(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
  const cfg     = vscode.workspace.getConfiguration(SETTINGS_NS);
  const useZen  = cfg.get<boolean>("autoZenMode", true);
  const useWinFS = cfg.get<boolean>("autoWindowFullScreen", false);
  const closeSb = cfg.get<boolean>("autoCloseSidebar", true);
  const asked   = context.globalState.get<boolean>(STORAGE_KEYS_UI.askedFullView, false);

  if (!asked && cfg.inspect<boolean>("autoFullView")?.globalValue === undefined) {
    await context.globalState.update(STORAGE_KEYS_UI.askedFullView, true);
    const yes = "Ja, kör Full View";
    const no  = "Inte nu";
    const pick = await vscode.window.showInformationMessage(
      "Vill du öppna förhandsvisningen i Full View-läge framöver?", yes, no
    );
    try { await cfg.update("autoFullView", pick === yes, vscode.ConfigurationTarget.Global); } catch {}
  }

  await enterFullView(panel);

  if (closeSb) {
    try { await vscode.commands.executeCommand("workbench.action.closeSidebar"); } catch {}
    try { await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar"); } catch {}
    try { await vscode.commands.executeCommand("workbench.action.maximizeEditor"); } catch {}
    try { await new Promise(r => setTimeout(r, 60)); panel?.webview.postMessage({ type: "ui-phase", phase: lastUiPhase }); } catch {}
  }

  if (useZen) {
    try {
      const zenCfg = vscode.workspace.getConfiguration("zenMode");
      await zenCfg.update("fullScreen", false, vscode.ConfigurationTarget.Workspace);
      await zenCfg.update("centerLayout", true, vscode.ConfigurationTarget.Workspace);
      await zenCfg.update("hideActivityBar", true, vscode.ConfigurationTarget.Workspace);
      await zenCfg.update("hideStatusBar", true, vscode.ConfigurationTarget.Workspace);
      await zenCfg.update("restore", true, vscode.ConfigurationTarget.Workspace);
    } catch {}

    const alreadyApplied = context.globalState.get<boolean>(STORAGE_KEYS_UI.zenApplied, false);
    if (!alreadyApplied) {
      try { await vscode.commands.executeCommand("workbench.action.toggleZenMode"); } catch {}
      try { await context.globalState.update(STORAGE_KEYS_UI.zenApplied, true); } catch {}
    }

    try { await vscode.commands.executeCommand("workbench.action.closePanel"); } catch {}

    try {
      await new Promise(r => setTimeout(r, 120));
      panel?.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
    } catch {}
  }

  if (useWinFS) {
    try {
      await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
      await new Promise(r => setTimeout(r, 120));
      panel?.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
    } catch {}
  }
}

/* ─────────────────────────────────────────────────────────
   FIGMA via backend-proxy (sRGB-normalisering)
   ───────────────────────────────────────────────────────── */
function buildProxyUrl(fileKey: string, nodeId: string, scale = "2"): string | null {
  const base = vscode.workspace.getConfiguration(SETTINGS_NS).get<string>("backendBaseUrl");
  if (!base) return null;
  let u: URL;
  try {
    u = new URL("/api/figma-image", base);
  } catch {
    return null;
  }
  u.searchParams.set("fileKey", fileKey);
  u.searchParams.set("nodeId", nodeId);
  u.searchParams.set("scale", scale);
  return u.toString();
}

async function sendFreshFigmaImageUrlToWebview(source: "init" | "refresh") {
  if (!currentPanel || !lastInitPayload) return;
  const { fileKey, nodeId } = lastInitPayload;
  const url = buildProxyUrl(fileKey, nodeId, "2");
  if (!url) {
    currentPanel.webview.postMessage({
      type: "ui-error",
      message: "Saknar giltig backendBaseUrl i inställningarna.",
    });
    return;
  }
  currentPanel.webview.postMessage({ type: "figma-image-url", url });
  lastUiPhase = "default";
  currentPanel.webview.postMessage({ type: "ui-phase", phase: "default" });
  log(`Proxy image-url (${source}) skickad.`);
}

/* ─────────────────────────────────────────────────────────
   Panel och meddelanden
   ───────────────────────────────────────────────────────── */
function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (!currentPanel) {
    log("Skapar ny Webview-panel …");
    currentPanel = vscode.window.createWebviewPanel(
      "aiFigmaCodegen.panel",
      "🎯 Project Preview",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))],
      }
    );

    currentPanel.onDidDispose(async () => {
      log("Panel stängdes – städar upp servrar och state.");
      currentPanel = undefined;
      lastDevUrl = null;
      lastInitPayload = null;
      pendingCandidate = null;
      lastUiPhase = "default";
      stopReloadWatcher();
      try { await stopDevServer(); } catch (e) { warn("stopDevServer fel:", e); }
      try { await stopInlineServer(); } catch (e) { warn("stopInlineServer fel:", e); }

      const zenApplied = context.globalState.get<boolean>(STORAGE_KEYS_UI.zenApplied, false);
      if (zenApplied) {
        try { await vscode.commands.executeCommand("workbench.action.toggleZenMode"); } catch {}
        try { await context.globalState.update(STORAGE_KEYS_UI.zenApplied, false); } catch {}
      }
    });

    currentPanel.webview.onDidReceiveMessage(async (msg: any) => {
      log("Meddelande från webview:", msg?.type ?? msg?.cmd ?? msg);

      if (msg?.type === "ready") {
        if (lastInitPayload) {
          currentPanel!.webview.postMessage(lastInitPayload);
          await sendFreshFigmaImageUrlToWebview("init");
        }
        if (lastDevUrl) currentPanel!.webview.postMessage({ type: "devurl", url: lastDevUrl });
        if (lastUiPhase === "onboarding") {
          currentPanel!.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
        } else if (lastUiPhase === "loading") {
          currentPanel!.webview.postMessage({ type: "ui-phase", phase: "loading" });
        }
        return;
      }

      if (msg?.type === "placementAccepted" && msg?.payload) {
        try {
          const ws = vscode.workspace.getConfiguration(SETTINGS_NS);
          const persist = ws.get<boolean>("persistPlacements", true);
          if (persist) {
            const key = "lastPlacement.v1";
            await vscode.workspace.getConfiguration().update(
              `${SETTINGS_NS}.${key}`,
              msg.payload,
              vscode.ConfigurationTarget.Workspace
            );
          }
          log("Placement accepted:", msg.payload);
          vscode.window.showInformationMessage("Placement mottagen. Redo för ML-analys.");
        } catch (e: any) {
          errlog("Kunde inte spara placement:", e?.message || String(e));
        }
        return;
      }

      if (msg?.cmd === "acceptCandidate") {
        if (!pendingCandidate) {
          try {
            const cands = await detectProjects([]);
            if (cands.length) pendingCandidate = cands[0];
          } catch (e) {
            warn("Detektering misslyckades i acceptCandidate:", e);
          }
        }
        if (!pendingCandidate) { warn("acceptCandidate utan kandidat – ignorerar."); return; }
        await rememberCandidate(pendingCandidate, context);
        await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
        return;
      }

      if (msg?.cmd === "forgetProject") {
        await forgetRemembered(context);
        return;
      }

      if (msg?.cmd === "chooseProject") {
        await showProjectQuickPick(context);
        return;
      }

      if (msg?.cmd === "pickFolder") {
        await pickFolderAndStart(context);
        return;
      }

      if (msg?.cmd === "openPR" && typeof msg.url === "string") {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      }

      if (msg?.cmd === "enterFullView") {
        await enterFullView(currentPanel);
        try { await new Promise(r => setTimeout(r, 60)); currentPanel?.webview.postMessage({ type: "ui-phase", phase: lastUiPhase }); } catch {}
        return;
      }

      if (msg?.cmd === "refreshFigmaImage") {
        await sendFreshFigmaImageUrlToWebview("refresh");
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
    currentPanel.reveal(vscode.ViewColumn.One);
  }
  return currentPanel;
}

function postCandidateProposal(_c: Candidate) {}

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
        // ── Ändrat: använd snabb HEAD→GET + index.html-fallback
        const ok = await quickCheck(externalUrl);
        if (!ok) {
          const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
          if (await quickCheck(base + "index.html")) {
            return { externalUrl: base + "index.html", mode: "dev" };
          }
          if (c.entryHtml) {
            const url = base + encodeURI(normalizeRel(c.entryHtml));
            return { externalUrl: url, mode: "dev" };
          }
        }
      } catch {}

      return { externalUrl, mode: "dev" };
    } catch (e: any) {
      errlog("Dev-server start misslyckades:", e?.message || e);
    }
  }

  const html = await findExistingHtml(c);
  if (html) {
    const { externalUrl } = await runInlineStaticServer(html.root);
    const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
    return { externalUrl, mode: "inline", watchRoot: html.root };
  }

  const storageDir = await ensureStoragePreview(context);
  const { externalUrl } = await runInlineStaticServer(storageDir);
  return { externalUrl, mode: "inline", watchRoot: storageDir };
}

async function ensureStoragePreview(context: vscode.ExtensionContext): Promise<string> {
  const root = context.globalStorageUri.fsPath;
  const previewDir = path.join(root, "ai-figma-preview");
  await fsp.mkdir(previewDir, { recursive: true });

  const indexPath = path.join(previewDir, "index.html");
  const html = `<!doctype html>
<html lang="sv">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Preview</title>
    <style>
      :root {
        --bg: var(--vscode-sideBar-background);
        --border: color-mix(in srgb, var(--vscode-foreground) 18%, var(--vscode-sideBar-background) 82%);
        --card: var(--vscode-editorWidget-background);
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body { margin: 0; background: var(--bg); }
      .mini { width: 100%; height: 100%; background: var(--card); border: 1px solid var(--border); }
    </style>
  </head>
  <body><div class="mini"></div></body>
</html>`;
  await fsp.writeFile(indexPath, html, "utf8");
  return previewDir;
}

/**
 * Starta kandidatens preview
 */
async function startCandidatePreviewWithFallback(
  c: Candidate,
  context: vscode.ExtensionContext,
  opts?: { silentUntilReady?: boolean }
) {
  const panel = ensurePanel(context);

  try { await stopDevServer(); } catch {}
  try { await stopInlineServer(); } catch {}
  stopReloadWatcher();

  const silent = !!opts?.silentUntilReady;
  let placeholder: Awaited<ReturnType<typeof runInlineStaticServer>> | null = null;

  if (!silent) {
    const storageDir = await ensureStoragePreview(context);
    placeholder = await runInlineStaticServer(storageDir);
    lastDevUrl = addBust(placeholder.externalUrl);
    panel.webview.postMessage({ type: "devurl", url: lastDevUrl });
  }

  (async () => {
    try {
      const res = await startOrRespectfulFallback(c, context);
      const busted = addBust(res.externalUrl);
      lastDevUrl = busted;
      panel.webview.postMessage({ type: "devurl", url: busted });

      // ── Ny: verifiera att URL:en svarar, annars öppna projektväljaren
      void verifyDevUrlAndMaybeRechoose(busted, "initial");

      if ((res.mode === "inline" || res.mode === "http") && res.watchRoot) {
        startReloadWatcher(res.watchRoot, res.externalUrl);
      } else {
        stopReloadWatcher();
      }

      if (placeholder) {
        try { await placeholder.stop(); } catch (e) { warn("Kunde inte stoppa placeholder-server:", e); }
      }

      lastUiPhase = "default";
      panel.webview.postMessage({ type: "ui-phase", phase: "default" });
    } catch (err: any) {
      errlog("Primär preview misslyckades:", err?.message || String(err));
      if (!silent) return;
      panel.webview.postMessage({ type: "ui-error", message: String(err?.message || err) });
    }
  })();
}

/* ─────────────────────────────────────────────────────────
   QuickPick
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
  panel.reveal(vscode.ViewColumn.One);

  // ── Ny: rescan varje gång
  try { lastCandidates = await detectProjects([]); }
  catch (e: any) {
    vscode.window.showErrorMessage(`Kunde inte hitta kandidater: ${e?.message || String(e)}`);
    return;
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

  await rememberCandidate(pendingCandidate, context);

  lastUiPhase = "loading";
  panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
  await tryAutoFullView(panel, context);
  await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
}

/* Välj mapp (onboarding) */
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

    await rememberCandidate(pendingCandidate, context);

    await tryAutoFullView(panel, context);
    await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
  } catch (e: any) {
    errlog("Folder-start misslyckades:", e?.message || String(e));
    vscode.window.showErrorMessage(`Start i vald folder misslyckades: ${e?.message || String(e)}`);
    lastUiPhase = "onboarding";
    panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
  }
}

/* ─────────────────────────────────────────────────────────
   Webview HTML + CSP
   ───────────────────────────────────────────────────────── */
function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const distDir = path.join(context.extensionPath, "dist-webview");
  const htmlPath = path.join(distDir, "index.html");

  let html = "";
  try {
    html = fs.readFileSync(htmlPath, "utf8");
  } catch {
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
  img-src http: https: data:;
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
  img-src http: https: data:;
  style-src 'unsafe-inline' ${cspSource};
  script-src ${cspSource};
  connect-src ${cspSource} http: https: ws: wss:;
  frame-src   http: https:;
">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Project Preview</title>
</head>
<body>
<script>window.addEventListener('load',()=>acquireVsCodeApi().postMessage({type:'ready'}));</script>
</body>
</html>`;
}

/* ─────────────────────────────────────────────────────────
   Aktivering
   ───────────────────────────────────────────────────────── */
export async function activate(context: vscode.ExtensionContext) {
  extCtxRef = context; // ── Ny: spara context för verifierings-flöden
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
  statusItem.tooltip = "Välj standardprojekt för förhandsvisning";
  statusItem.command = "ai-figma-codegen.chooseProject";
  statusItem.show();
  context.subscriptions.push(statusItem);

  (async () => {
    const rem = await tryGetRememberedCandidate(context);
    updateStatusBar(rem);
  })();

  const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
    try {
      const remembered = await tryGetRememberedCandidate(context);
      if (remembered) {
        const panel = ensurePanel(context);
        pendingCandidate = remembered;
        updateStatusBar(remembered);
        panel.reveal(vscode.ViewColumn.One);
        lastUiPhase = "loading";
        panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
        await tryAutoFullView(panel, context);
        await startCandidatePreviewWithFallback(remembered, context, { silentUntilReady: true });
        return;
      }

      const candidates = await detectProjects([]);
      lastCandidates = candidates;
      if (!candidates.length) {
        vscode.window.showWarningMessage("Hittade inga kandidater (körbara frontend-projekt eller statiska mappar).");
        return;
      }
      const panel = ensurePanel(context);
      pendingCandidate = candidates[0];
      panel.reveal(vscode.ViewColumn.One);

      if (candidates.length === 1 || (pendingCandidate?.confidence ?? 0) >= AUTO_START_SURE_THRESHOLD) {
        lastUiPhase = "loading";
        panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
        await rememberCandidate(pendingCandidate!, context);
        await tryAutoFullView(panel, context);
        await startCandidatePreviewWithFallback(pendingCandidate!, context, { silentUntilReady: true });
      } else {
        const pickNow = "Välj projekt…";
        const startTop = "Starta föreslagen";
        const choice = await vscode.window.showInformationMessage(
          "Flera kandidater hittades. Vill du välja manuellt eller starta föreslagen?",
          pickNow, startTop
        );
        if (choice === pickNow) {
          await showProjectQuickPick(context);
        } else if (choice === startTop) {
          lastUiPhase = "loading";
          panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
          await rememberCandidate(pendingCandidate!, context);
          await tryAutoFullView(panel, context);
          await startCandidatePreviewWithFallback(pendingCandidate!, context, { silentUntilReady: true });
        }
      }
    } catch (err: any) {
      errlog("Scan & Preview misslyckades:", err?.message || err);
      vscode.window.showErrorMessage(`Scan & Preview misslyckades: ${err.message}`);
    }
  });

  const openCmd = vscode.commands.registerCommand("ai-figma-codegen.openPanel", async () => {
    const panel = ensurePanel(context);
    panel.reveal(vscode.ViewColumn.One);

    const remembered = await tryGetRememberedCandidate(context);
    if (remembered) {
      pendingCandidate = remembered;
      updateStatusBar(remembered);
      lastUiPhase = "loading";
      panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
      await tryAutoFullView(panel, context);
      await startCandidatePreviewWithFallback(remembered, context, { silentUntilReady: true });
      return;
    }

    if (!pendingCandidate) {
      const candidates = await detectProjects([]);
      lastCandidates = candidates;
      if (candidates.length) {
        pendingCandidate = candidates[0];
        if (candidates.length === 1 || (pendingCandidate?.confidence ?? 0) >= AUTO_START_SURE_THRESHOLD) {
          lastUiPhase = "loading";
          panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
          await rememberCandidate(pendingCandidate!, context);
          await tryAutoFullView(panel, context);
          await startCandidatePreviewWithFallback(pendingCandidate!, context, { silentUntilReady: true });
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

  const forgetCmd = vscode.commands.registerCommand("ai-figma-codegen.forgetProject", async () => {
    await forgetRemembered(context);
  });

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
          vscode.workspace.getConfiguration(SETTINGS_NS).get<string>("figmaToken") || undefined;

        const panel = ensurePanel(context);
        lastInitPayload = { type: "init", fileKey, nodeId, token, figmaToken: token };
        panel.webview.postMessage(lastInitPayload);
        panel.reveal(vscode.ViewColumn.One);

        await sendFreshFigmaImageUrlToWebview("init");

        const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
        const autoStartImport = cfg.get<boolean>("autoStartOnImport", true);

        if (autoStartImport) {
          const remembered = await tryGetRememberedCandidate(context);
          if (remembered) {
            pendingCandidate = remembered;
            updateStatusBar(remembered);
            lastUiPhase = "loading";
            panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
            await tryAutoFullView(panel, context);
            await startCandidatePreviewWithFallback(remembered, context, { silentUntilReady: true });
          } else {
            try {
              const cands = await detectProjects([]);
              if (cands.length) {
                pendingCandidate = cands[0];
                await rememberCandidate(pendingCandidate, context);
                updateStatusBar(pendingCandidate);
                lastUiPhase = "loading";
                panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                await tryAutoFullView(panel, context);
                await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
              } else {
                lastUiPhase = "onboarding";
                panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
              }
            } catch {
              lastUiPhase = "onboarding";
              panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
            }
          }
        } else {
          lastUiPhase = "onboarding";
          panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
        }
      } catch (e: any) {
        errlog("URI-öppning misslyckades:", e?.message || String(e));
        vscode.window.showErrorMessage(`URI-öppning misslyckades: ${e?.message || String(e)}`);
      }
    },
  });

  context.subscriptions.push(scanCmd, openCmd, chooseCmd, exportCmd, uriHandler, forgetCmd);
  log("Extension aktiverad.");
}

export async function deactivate() {
  log("Avaktiverar extension – stänger ev. servrar …");
  stopReloadWatcher();
  try { await stopDevServer(); } catch (e) { warn("stopDevServer fel:", e); }
  try { await stopInlineServer(); } catch (e) { warn("stopInlineServer fel:", e); }
}
