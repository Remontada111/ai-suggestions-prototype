"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// extension/src/extension.ts
const vscode = __importStar(require("vscode"));
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const fsp = __importStar(require("node:fs/promises"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const detector_1 = require("./detector");
const runner_1 = require("./runner");
// ⬇️ ML: ladda eventuell modell (faller tillbaka till heuristik om ingen finns)
const classifier_1 = require("./ml/classifier");
// ⬇️ Dataset-export (för träning senare)
const exportDataset_1 = require("./commands/exportDataset");
let currentPanel;
const LOG_NS = "ai-figma-codegen/ext";
const log = (...args) => console.log(`[${LOG_NS}]`, ...args);
const warn = (...args) => console.warn(`[${LOG_NS}]`, ...args);
const errlog = (...args) => console.error(`[${LOG_NS}]`, ...args);
let lastInitPayload = null;
let lastDevUrl = null;
let pendingCandidate = null;
// 🔹 Cache för senaste detekterade kandidater + statusknapp
let lastCandidates = [];
let statusItem;
const AUTO_START_SURE_THRESHOLD = 12;
let lastUiPhase = "default";
/* ─────────────────────────────────────────────────────────
   AUTO-RELOAD för statiska previews (inline/http-server)
   ───────────────────────────────────────────────────────── */
let reloadWatcher;
let reloadTimer;
let reloadBaseUrl = null;
function stopReloadWatcher() {
    try {
        reloadWatcher === null || reloadWatcher === void 0 ? void 0 : reloadWatcher.dispose();
    }
    catch ( /* ignore */_a) { /* ignore */ }
    reloadWatcher = undefined;
    if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = undefined;
    }
    reloadBaseUrl = null;
}
function startReloadWatcher(rootDir, baseUrl) {
    stopReloadWatcher();
    reloadBaseUrl = baseUrl;
    const pattern = new vscode.RelativePattern(rootDir, "**/*.{html,htm,css,js,jsx,tsx,vue,svelte}");
    reloadWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onEvt = (uri) => {
        const p = uri.fsPath.replace(/\\/g, "/");
        if (/\/(node_modules|\.git|dist|build|out)\//.test(p))
            return;
        if (reloadTimer)
            clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
            if (!currentPanel || !reloadBaseUrl)
                return;
            const bust = `${reloadBaseUrl}${reloadBaseUrl.includes("?") ? "&" : "?"}` +
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
async function headExists(url) {
    try {
        const u = new URL(url);
        const mod = u.protocol === "https:" ? https : http;
        return await new Promise((resolve) => {
            const req = mod.request({
                method: "HEAD",
                hostname: u.hostname,
                port: u.port,
                path: u.pathname || "/",
                timeout: 1500,
            }, (res) => {
                var _a;
                res.resume();
                resolve(((_a = res.statusCode) !== null && _a !== void 0 ? _a : 500) < 400);
            });
            req.on("timeout", () => {
                req.destroy();
                resolve(false);
            });
            req.on("error", () => resolve(false));
            req.end();
        });
    }
    catch (_a) {
        return false;
    }
}
function normalizeDevCmdPorts(raw) {
    let cmd = raw;
    if (/\bnext\s+dev\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    if (/\bvite(\s+dev)?\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    if (/\bastro\s+dev\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    if (/\bremix\s+dev\b/.test(cmd) && !/\s(--port|-p)\s+\d+/.test(cmd))
        cmd += " --port 0";
    if (/\bsolid-start\s+dev\b/.test(cmd) && !/\s(--port|-p)\s+\d+/.test(cmd))
        cmd += " --port 0";
    if (/\bnuxi\s+dev\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    if (/\bwebpack\s+serve\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    if (/\bstorybook\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    return cmd;
}
function resolveBundledModelPath(context) {
    const cand = [
        path.resolve(context.asAbsolutePath("."), "ml_artifacts", "frontend-detector-gbdt.json"),
        path.resolve(context.asAbsolutePath("."), "dist", "ml_artifacts", "frontend-detector-gbdt.json"),
        path.resolve(__dirname, "..", "ml_artifacts", "frontend-detector-gbdt.json"),
        path.resolve(__dirname, "..", "..", "ml_artifacts", "frontend-detector-gbdt.json"),
    ];
    for (const p of cand) {
        try {
            if (fs.existsSync(p))
                return p;
        }
        catch ( /* ignore */_a) { /* ignore */ }
    }
    return undefined;
}
/* ─────────────────────────────────────────────────────────
   Panel och meddelandehantering
   ───────────────────────────────────────────────────────── */
function ensurePanel(context) {
    if (!currentPanel) {
        log("Skapar ny Webview-panel …");
        currentPanel = vscode.window.createWebviewPanel("aiFigmaCodegen.panel", "🎯 Project Preview", vscode.ViewColumn.Two, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))],
        });
        currentPanel.onDidDispose(() => {
            log("Panel stängdes – städar upp servrar och state.");
            currentPanel = undefined;
            lastDevUrl = null;
            lastInitPayload = null;
            pendingCandidate = null;
            lastUiPhase = "default";
            stopReloadWatcher();
            (async () => {
                try {
                    await (0, runner_1.stopDevServer)();
                }
                catch (e) {
                    warn("stopDevServer fel:", e);
                }
                try {
                    await (0, runner_1.stopInlineServer)();
                }
                catch (e) {
                    warn("stopInlineServer fel:", e);
                }
            })();
        });
        currentPanel.webview.onDidReceiveMessage(async (msg) => {
            var _a, _b;
            log("Meddelande från webview:", (_b = (_a = msg === null || msg === void 0 ? void 0 : msg.type) !== null && _a !== void 0 ? _a : msg === null || msg === void 0 ? void 0 : msg.cmd) !== null && _b !== void 0 ? _b : msg);
            if ((msg === null || msg === void 0 ? void 0 : msg.type) === "ready") {
                if (lastInitPayload)
                    currentPanel.webview.postMessage(lastInitPayload);
                if (lastDevUrl)
                    currentPanel.webview.postMessage({ type: "devurl", url: lastDevUrl });
                if (lastUiPhase === "onboarding") {
                    currentPanel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
                }
                else if (lastUiPhase === "loading") {
                    currentPanel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                }
                // (Minimal UI) – ingen kandidat-proposal att posta längre
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "acceptCandidate") {
                if (!pendingCandidate) {
                    warn("acceptCandidate utan pendingCandidate – ignorerar.");
                    return;
                }
                await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "chooseProject") {
                await showProjectQuickPick(context);
                return;
            }
            // Onboarding-knapp – välj MAPP
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "pickFolder") {
                await pickFolderAndStart(context);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "openPR" && typeof msg.url === "string") {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "chat" && typeof msg.text === "string") {
                log("[chat]", msg.text);
                return;
            }
        });
        currentPanel.webview.html = getWebviewHtml(context, currentPanel.webview);
        log("Webview HTML laddad.");
    }
    else {
        currentPanel.reveal(vscode.ViewColumn.Two);
    }
    return currentPanel;
}
// (behåller postCandidateProposal-funktionen om den behövs senare,
// men den används inte längre av minimal UI)
function postCandidateProposal(_c) { }
/* ─────────────────────────────────────────────────────────
   Upptäckt & uppstart
   ───────────────────────────────────────────────────────── */
function selectLaunchCommand(c) {
    var _a, _b, _d;
    const raw = (_a = c.devCmd) !== null && _a !== void 0 ? _a : (_d = (_b = c.runCandidates) === null || _b === void 0 ? void 0 : _b[0]) === null || _d === void 0 ? void 0 : _d.cmd;
    if (!raw) {
        warn("Inget devCmd funnet för kandidat:", c.dir);
        return undefined;
    }
    if (/\bhttp-server\b/i.test(raw)) {
        let patched = raw
            .replace(/\s--port\s+\d+/i, " --port 0")
            .replace(/\s-p\s+\d+/i, " -p 0");
        if (!/(\s--port|\s-p)\s+\d+/i.test(patched))
            patched += " -p 0";
        return patched;
    }
    const norm = normalizeDevCmdPorts(raw);
    return norm;
}
async function findExistingHtml(c) {
    if (c.entryHtml)
        return { relHtml: normalizeRel(c.entryHtml), root: c.dir };
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
function normalizeRel(rel) {
    return rel.replace(/^\.\//, "").replace(/^\/+/, "");
}
async function startOrRespectfulFallback(c, context) {
    const cmd = selectLaunchCommand(c);
    if (cmd) {
        try {
            const { externalUrl } = await (0, runner_1.runDevServer)(cmd, c.dir);
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
            }
            catch ( /* ignore */_a) { /* ignore */ }
            return { externalUrl, mode: "dev" };
        }
        catch (e) {
            errlog("Dev-server start misslyckades:", (e === null || e === void 0 ? void 0 : e.message) || e);
        }
    }
    const html = await findExistingHtml(c);
    if (html) {
        const { externalUrl } = await (0, runner_1.runInlineStaticServer)(html.root);
        const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
        return { externalUrl: base + encodeURI(html.relHtml), mode: "inline", watchRoot: html.root };
    }
    const storageDir = await ensureStoragePreview(context);
    const { externalUrl } = await (0, runner_1.runInlineStaticServer)(storageDir);
    return { externalUrl, mode: "inline", watchRoot: storageDir };
}
/** Bygg mycket minimalistisk temporär preview i globalStorage (fritt från text/labels) */
async function ensureStoragePreview(context) {
    const root = context.globalStorageUri.fsPath;
    const previewDir = path.join(root, "ai-figma-preview");
    await fsp.mkdir(previewDir, { recursive: true });
    const indexPath = path.join(previewDir, "index.html");
    // Skriv alltid om för att säkerställa uppdaterad minimal version
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
      .mini {
        width: 100%;
        height: 100%;
        background: var(--card);
        border: 1px solid var(--border);
      }
    </style>
  </head>
  <body>
    <div class="mini"></div>
  </body>
</html>`;
    await fsp.writeFile(indexPath, html, "utf8");
    return previewDir;
}
/**
 * Starta kandidatens preview:
 * - Minimal UI: använd alltid silentUntilReady där vi själva triggar start,
 *   och visa loader i webview tills verklig URL finns.
 */
async function startCandidatePreviewWithFallback(c, context, opts) {
    const panel = ensurePanel(context);
    try {
        await (0, runner_1.stopDevServer)();
    }
    catch ( /* ignore */_a) { /* ignore */ }
    try {
        await (0, runner_1.stopInlineServer)();
    }
    catch ( /* ignore */_b) { /* ignore */ }
    stopReloadWatcher();
    const silent = !!(opts === null || opts === void 0 ? void 0 : opts.silentUntilReady);
    let placeholder = null;
    if (!silent) {
        const storageDir = await ensureStoragePreview(context);
        placeholder = await (0, runner_1.runInlineStaticServer)(storageDir);
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
            }
            else {
                stopReloadWatcher();
            }
            if (placeholder) {
                try {
                    await placeholder.stop();
                }
                catch (e) {
                    warn("Kunde inte stoppa placeholder-server:", e);
                }
            }
            // Klart
            lastUiPhase = "default";
            panel.webview.postMessage({ type: "ui-phase", phase: "default" });
        }
        catch (err) {
            errlog("Primär preview misslyckades:", (err === null || err === void 0 ? void 0 : err.message) || String(err));
            if (!silent)
                return;
            panel.webview.postMessage({ type: "ui-error", message: String((err === null || err === void 0 ? void 0 : err.message) || err) });
        }
    })();
}
/* ─────────────────────────────────────────────────────────
   UI: Manuell projektväljare (QuickPick)
   ───────────────────────────────────────────────────────── */
function toPickItems(candidates) {
    return candidates.map((c) => {
        var _a, _b, _d, _e;
        const label = c.pkgName || path.basename(c.dir);
        const cmd = (_e = (_a = selectLaunchCommand(c)) !== null && _a !== void 0 ? _a : (_d = (_b = c.runCandidates) === null || _b === void 0 ? void 0 : _b[0]) === null || _d === void 0 ? void 0 : _d.cmd) !== null && _e !== void 0 ? _e : "auto";
        const description = `${c.framework} • ${cmd}`;
        const detail = c.dir;
        return { label, description, detail, _c: c };
    });
}
async function showProjectQuickPick(context) {
    const panel = ensurePanel(context);
    panel.reveal(vscode.ViewColumn.Two);
    if (!lastCandidates.length) {
        try {
            lastCandidates = await (0, detector_1.detectProjects)([]);
        }
        catch (e) {
            vscode.window.showErrorMessage(`Kunde inte hitta kandidater: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
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
    if (!chosen)
        return;
    pendingCandidate = chosen._c;
    // Minimal UI: visa loader + starta tyst
    lastUiPhase = "loading";
    panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
    await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
}
/* Välj mapp (onboarding) och starta i bakgrunden – oförändrat då det redan kör silent */
async function pickFolderAndStart(context) {
    const panel = ensurePanel(context);
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: "Välj folder",
        openLabel: "Välj folder",
    });
    if (!uris || !uris.length)
        return;
    const folderPath = uris[0].fsPath;
    lastUiPhase = "loading";
    panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
    try {
        const candidates = await (0, detector_1.detectProjects)([folderPath]);
        lastCandidates = candidates;
        if (!candidates.length) {
            vscode.window.showWarningMessage("Inga körbara frontend-kandidater hittades i vald folder.");
            lastUiPhase = "onboarding";
            panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
            return;
        }
        pendingCandidate = candidates[0];
        await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
    }
    catch (e) {
        errlog("Folder-start misslyckades:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
        vscode.window.showErrorMessage(`Start i vald folder misslyckades: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
        lastUiPhase = "onboarding";
        panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
    }
}
/* ─────────────────────────────────────────────────────────
   Webview HTML + CSP (fallback om dist saknas)
   ───────────────────────────────────────────────────────── */
function getWebviewHtml(context, webview) {
    const distDir = path.join(context.extensionPath, "dist-webview");
    const htmlPath = path.join(distDir, "index.html");
    let html = "";
    try {
        html = fs.readFileSync(htmlPath, "utf8");
    }
    catch (e) {
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
    html = html.replace("<head>", `<head>
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src https: data:;
  style-src 'unsafe-inline' ${cspSource};
  script-src ${cspSource};
  connect-src ${cspSource} http: https: ws: wss:;
  frame-src   http: https:;
">
`);
    return html;
}
function basicFallbackHtml(webview) {
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
async function activate(context) {
    log("Aktiverar extension …");
    const bundledModelPath = resolveBundledModelPath(context);
    if (bundledModelPath)
        log("Försöker ladda bundlad ML-modell:", bundledModelPath);
    else
        log("Ingen bundlad ML-modell hittades (OK för MVP).");
    (0, classifier_1.loadModelIfAny)({
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
        var _a;
        try {
            const candidates = await (0, detector_1.detectProjects)([]);
            lastCandidates = candidates;
            if (!candidates.length) {
                vscode.window.showWarningMessage("Hittade inga kandidater (körbara frontend-projekt eller statiska mappar).");
                return;
            }
            const panel = ensurePanel(context);
            pendingCandidate = candidates[0];
            panel.reveal(vscode.ViewColumn.Two);
            if (candidates.length === 1 || ((_a = pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.confidence) !== null && _a !== void 0 ? _a : 0) >= AUTO_START_SURE_THRESHOLD) {
                // Minimal UI: visa loader + starta tyst
                lastUiPhase = "loading";
                panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
            }
            else {
                const pickNow = "Välj projekt…";
                const startTop = "Starta föreslagen";
                const choice = await vscode.window.showInformationMessage("Flera kandidater hittades. Vill du välja manuellt eller starta föreslagen?", pickNow, startTop);
                if (choice === pickNow) {
                    await showProjectQuickPick(context);
                }
                else if (choice === startTop) {
                    lastUiPhase = "loading";
                    panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                    await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
                }
            }
        }
        catch (err) {
            errlog("Scan & Preview misslyckades:", (err === null || err === void 0 ? void 0 : err.message) || err);
            vscode.window.showErrorMessage(`Scan & Preview misslyckades: ${err.message}`);
        }
    });
    const openCmd = vscode.commands.registerCommand("ai-figma-codegen.openPanel", async () => {
        var _a;
        const panel = ensurePanel(context);
        panel.reveal(vscode.ViewColumn.Two);
        // Minimal UI: ingen auto-onboarding här, men om vi autostartar så gör det tyst med loader
        if (!pendingCandidate) {
            const candidates = await (0, detector_1.detectProjects)([]);
            lastCandidates = candidates;
            if (candidates.length) {
                pendingCandidate = candidates[0];
                if (candidates.length === 1 || ((_a = pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.confidence) !== null && _a !== void 0 ? _a : 0) >= AUTO_START_SURE_THRESHOLD) {
                    lastUiPhase = "loading";
                    panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                    await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
                }
            }
        }
    });
    const chooseCmd = vscode.commands.registerCommand("ai-figma-codegen.chooseProject", async () => {
        await showProjectQuickPick(context);
    });
    const exportCmd = vscode.commands.registerCommand("ai-figma-codegen.exportFrontendDetectorDataset", async () => {
        try {
            await (0, exportDataset_1.exportDatasetCommand)();
        }
        catch (e) {
            errlog("ExportDataset fel:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
            vscode.window.showErrorMessage(`ExportDataset misslyckades: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
        }
    });
    // 🔹 URI-handler (Figma import) – visa onboarding först, starta sedan tyst
    const uriHandler = vscode.window.registerUriHandler({
        handleUri: async (uri) => {
            try {
                const params = new URLSearchParams(uri.query);
                const fileKey = params.get("fileKey") || "";
                const nodeId = params.get("nodeId") || "";
                if (!fileKey || !nodeId) {
                    vscode.window.showErrorMessage("Saknar fileKey eller nodeId i URI.");
                    return;
                }
                const token = vscode.workspace.getConfiguration("aiFigmaCodegen").get("figmaToken") || undefined;
                const panel = ensurePanel(context);
                lastInitPayload = { type: "init", fileKey, nodeId, token, figmaToken: token };
                panel.webview.postMessage(lastInitPayload);
                lastUiPhase = "onboarding";
                panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
                panel.reveal(vscode.ViewColumn.Two);
            }
            catch (e) {
                errlog("URI-öppning misslyckades:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
                vscode.window.showErrorMessage(`URI-öppning misslyckades: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
            }
        },
    });
    context.subscriptions.push(scanCmd, openCmd, chooseCmd, exportCmd, uriHandler);
    log("Extension aktiverad.");
}
async function deactivate() {
    log("Avaktiverar extension – stänger ev. servrar …");
    stopReloadWatcher();
    try {
        await (0, runner_1.stopDevServer)();
    }
    catch (e) {
        warn("stopDevServer fel:", e);
    }
    try {
        await (0, runner_1.stopInlineServer)();
    }
    catch (e) {
        warn("stopInlineServer fel:", e);
    }
}
//# sourceMappingURL=extension.js.map