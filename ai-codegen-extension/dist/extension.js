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
const classifier_1 = require("./ml/classifier");
const exportDataset_1 = require("./commands/exportDataset");
let currentPanel;
const LOG_NS = "ai-figma-codegen/ext";
const log = (...args) => console.log(`[${LOG_NS}]`, ...args);
const warn = (...args) => console.warn(`[${LOG_NS}]`, ...args);
const errlog = (...args) => console.error(`[${LOG_NS}]`, ...args);
let lastInitPayload = null;
let lastDevUrl = null;
let pendingCandidate = null;
let lastCandidates = [];
let statusItem;
// ── Ny: behåll context så vi kan öppna projektväljaren från asynka verifieringar
let extCtxRef = null;
const AUTO_START_SURE_THRESHOLD = 12;
let lastUiPhase = "default";
/* ─────────────────────────────────────────────────────────
   AUTO-RELOAD (inline/http-server)
   ───────────────────────────────────────────────────────── */
let reloadWatcher;
let reloadTimer;
let reloadBaseUrl = null;
function stopReloadWatcher() {
    try {
        reloadWatcher === null || reloadWatcher === void 0 ? void 0 : reloadWatcher.dispose();
    }
    catch (_a) { }
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
                path: (u.pathname || "/") + (u.search || ""),
                timeout: 1500,
            }, (res) => {
                var _a;
                res.resume();
                resolve(((_a = res.statusCode) !== null && _a !== void 0 ? _a : 500) < 400);
            });
            req.on("timeout", () => { req.destroy(); resolve(false); });
            req.on("error", () => resolve(false));
            req.end();
        });
    }
    catch (_a) {
        return false;
    }
}
// ── Ny: verifiera devUrl och öppna projektväljaren vid ihållande 404/otillgänglig
async function verifyDevUrlAndMaybeRechoose(url, reason) {
    if (!extCtxRef)
        return;
    // 3 försök med kort backoff för att ge dev-servern tid att spinna upp
    for (let i = 0; i < 3; i++) {
        const ok = await headExists(url);
        if (ok)
            return;
        await new Promise(r => setTimeout(r, 700));
    }
    warn(`Preview otillgänglig (${reason}) på ${url}. Öppnar projektväljare.`);
    try {
        await showProjectQuickPick(extCtxRef);
    }
    catch (e) {
        warn("Kunde inte öppna projektväljaren:", e);
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
        catch (_a) { }
    }
    return undefined;
}
/* ─────────────────────────────────────────────────────────
   UI-status och remember
   ───────────────────────────────────────────────────────── */
const STORAGE_KEYS = { remembered: "aiFigmaCodegen.rememberedProject.v1" };
const SETTINGS_NS = "aiFigmaCodegen";
const STORAGE_KEYS_UI = { askedFullView: "ui.askedFullView.v1", zenApplied: "ui.zenApplied.v1" };
function updateStatusBar(current) {
    if (!statusItem)
        return;
    if (current) {
        statusItem.text = `$(rocket) Preview: ${current.pkgName || path.basename(current.dir)}`;
        statusItem.tooltip = "Standardprojekt för förhandsvisning • klicka för att byta";
    }
    else {
        statusItem.text = "$(rocket) Preview";
        statusItem.tooltip = "Välj standardprojekt för förhandsvisning";
    }
}
async function rememberCandidate(c, context) {
    const payload = { dir: c.dir, savedAt: Date.now() };
    await context.globalState.update(STORAGE_KEYS.remembered, payload);
    updateStatusBar(c);
    log("Sparade valt projekt:", c.dir);
}
async function forgetRemembered(context) {
    await context.globalState.update(STORAGE_KEYS.remembered, undefined);
    updateStatusBar(null);
    vscode.window.showInformationMessage("Glömde sparat projekt.");
}
async function tryGetRememberedCandidate(context) {
    const rec = context.globalState.get(STORAGE_KEYS.remembered);
    if (!(rec === null || rec === void 0 ? void 0 : rec.dir))
        return null;
    try {
        if (!fs.existsSync(rec.dir)) {
            await context.globalState.update(STORAGE_KEYS.remembered, undefined);
            return null;
        }
    }
    catch (_a) {
        return null;
    }
    try {
        const cands = await (0, detector_1.detectProjects)([rec.dir]);
        if (cands === null || cands === void 0 ? void 0 : cands.length)
            return cands[0];
    }
    catch (_b) { }
    return null;
}
/** Visa panelen i editor-kolumnen. */
async function enterFullView(panel) {
    try {
        panel === null || panel === void 0 ? void 0 : panel.reveal(vscode.ViewColumn.One, false);
    }
    catch (_a) { }
}
/** Zen Mode, close panels, etc. */
async function tryAutoFullView(panel, context) {
    var _a;
    const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
    const useZen = cfg.get("autoZenMode", true);
    const useWinFS = cfg.get("autoWindowFullScreen", false);
    const closeSb = cfg.get("autoCloseSidebar", true);
    const asked = context.globalState.get(STORAGE_KEYS_UI.askedFullView, false);
    if (!asked && ((_a = cfg.inspect("autoFullView")) === null || _a === void 0 ? void 0 : _a.globalValue) === undefined) {
        await context.globalState.update(STORAGE_KEYS_UI.askedFullView, true);
        const yes = "Ja, kör Full View";
        const no = "Inte nu";
        const pick = await vscode.window.showInformationMessage("Vill du öppna förhandsvisningen i Full View-läge framöver?", yes, no);
        try {
            await cfg.update("autoFullView", pick === yes, vscode.ConfigurationTarget.Global);
        }
        catch (_b) { }
    }
    await enterFullView(panel);
    if (closeSb) {
        try {
            await vscode.commands.executeCommand("workbench.action.closeSidebar");
        }
        catch (_d) { }
        try {
            await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
        }
        catch (_e) { }
        try {
            await vscode.commands.executeCommand("workbench.action.maximizeEditor");
        }
        catch (_f) { }
        try {
            await new Promise(r => setTimeout(r, 60));
            panel === null || panel === void 0 ? void 0 : panel.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
        }
        catch (_g) { }
    }
    if (useZen) {
        try {
            const zenCfg = vscode.workspace.getConfiguration("zenMode");
            await zenCfg.update("fullScreen", false, vscode.ConfigurationTarget.Workspace);
            await zenCfg.update("centerLayout", true, vscode.ConfigurationTarget.Workspace);
            await zenCfg.update("hideActivityBar", true, vscode.ConfigurationTarget.Workspace);
            await zenCfg.update("hideStatusBar", true, vscode.ConfigurationTarget.Workspace);
            await zenCfg.update("restore", true, vscode.ConfigurationTarget.Workspace);
        }
        catch (_h) { }
        const alreadyApplied = context.globalState.get(STORAGE_KEYS_UI.zenApplied, false);
        if (!alreadyApplied) {
            try {
                await vscode.commands.executeCommand("workbench.action.toggleZenMode");
            }
            catch (_j) { }
            try {
                await context.globalState.update(STORAGE_KEYS_UI.zenApplied, true);
            }
            catch (_k) { }
        }
        try {
            await vscode.commands.executeCommand("workbench.action.closePanel");
        }
        catch (_l) { }
        try {
            await new Promise(r => setTimeout(r, 120));
            panel === null || panel === void 0 ? void 0 : panel.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
        }
        catch (_o) { }
    }
    if (useWinFS) {
        try {
            await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
            await new Promise(r => setTimeout(r, 120));
            panel === null || panel === void 0 ? void 0 : panel.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
        }
        catch (_p) { }
    }
}
/* ─────────────────────────────────────────────────────────
   FIGMA via backend-proxy (sRGB-normalisering)
   ───────────────────────────────────────────────────────── */
function buildProxyUrl(fileKey, nodeId, scale = "2") {
    const base = vscode.workspace.getConfiguration(SETTINGS_NS).get("backendBaseUrl");
    if (!base)
        return null;
    let u;
    try {
        u = new URL("/api/figma-image", base);
    }
    catch (_a) {
        return null;
    }
    u.searchParams.set("fileKey", fileKey);
    u.searchParams.set("nodeId", nodeId);
    u.searchParams.set("scale", scale);
    return u.toString();
}
async function sendFreshFigmaImageUrlToWebview(source) {
    if (!currentPanel || !lastInitPayload)
        return;
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
function ensurePanel(context) {
    if (!currentPanel) {
        log("Skapar ny Webview-panel …");
        currentPanel = vscode.window.createWebviewPanel("aiFigmaCodegen.panel", "🎯 Project Preview", vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))],
        });
        currentPanel.onDidDispose(async () => {
            log("Panel stängdes – städar upp servrar och state.");
            currentPanel = undefined;
            lastDevUrl = null;
            lastInitPayload = null;
            pendingCandidate = null;
            lastUiPhase = "default";
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
            const zenApplied = context.globalState.get(STORAGE_KEYS_UI.zenApplied, false);
            if (zenApplied) {
                try {
                    await vscode.commands.executeCommand("workbench.action.toggleZenMode");
                }
                catch (_a) { }
                try {
                    await context.globalState.update(STORAGE_KEYS_UI.zenApplied, false);
                }
                catch (_b) { }
            }
        });
        currentPanel.webview.onDidReceiveMessage(async (msg) => {
            var _a, _b;
            log("Meddelande från webview:", (_b = (_a = msg === null || msg === void 0 ? void 0 : msg.type) !== null && _a !== void 0 ? _a : msg === null || msg === void 0 ? void 0 : msg.cmd) !== null && _b !== void 0 ? _b : msg);
            if ((msg === null || msg === void 0 ? void 0 : msg.type) === "ready") {
                if (lastInitPayload) {
                    currentPanel.webview.postMessage(lastInitPayload);
                    await sendFreshFigmaImageUrlToWebview("init");
                }
                if (lastDevUrl)
                    currentPanel.webview.postMessage({ type: "devurl", url: lastDevUrl });
                if (lastUiPhase === "onboarding") {
                    currentPanel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
                }
                else if (lastUiPhase === "loading") {
                    currentPanel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                }
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.type) === "placementAccepted" && (msg === null || msg === void 0 ? void 0 : msg.payload)) {
                try {
                    const ws = vscode.workspace.getConfiguration(SETTINGS_NS);
                    const persist = ws.get("persistPlacements", true);
                    if (persist) {
                        const key = "lastPlacement.v1";
                        await vscode.workspace.getConfiguration().update(`${SETTINGS_NS}.${key}`, msg.payload, vscode.ConfigurationTarget.Workspace);
                    }
                    log("Placement accepted:", msg.payload);
                    vscode.window.showInformationMessage("Placement mottagen. Redo för ML-analys.");
                }
                catch (e) {
                    errlog("Kunde inte spara placement:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
                }
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "acceptCandidate") {
                if (!pendingCandidate) {
                    try {
                        const cands = await (0, detector_1.detectProjects)([]);
                        if (cands.length)
                            pendingCandidate = cands[0];
                    }
                    catch (e) {
                        warn("Detektering misslyckades i acceptCandidate:", e);
                    }
                }
                if (!pendingCandidate) {
                    warn("acceptCandidate utan kandidat – ignorerar.");
                    return;
                }
                await rememberCandidate(pendingCandidate, context);
                await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "forgetProject") {
                await forgetRemembered(context);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "chooseProject") {
                await showProjectQuickPick(context);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "pickFolder") {
                await pickFolderAndStart(context);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "openPR" && typeof msg.url === "string") {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "enterFullView") {
                await enterFullView(currentPanel);
                try {
                    await new Promise(r => setTimeout(r, 60));
                    currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
                }
                catch (_d) { }
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "refreshFigmaImage") {
                await sendFreshFigmaImageUrlToWebview("refresh");
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
        currentPanel.reveal(vscode.ViewColumn.One);
    }
    return currentPanel;
}
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
            catch (_a) { }
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
        return { externalUrl, mode: "inline", watchRoot: html.root };
    }
    const storageDir = await ensureStoragePreview(context);
    const { externalUrl } = await (0, runner_1.runInlineStaticServer)(storageDir);
    return { externalUrl, mode: "inline", watchRoot: storageDir };
}
async function ensureStoragePreview(context) {
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
async function startCandidatePreviewWithFallback(c, context, opts) {
    const panel = ensurePanel(context);
    try {
        await (0, runner_1.stopDevServer)();
    }
    catch (_a) { }
    try {
        await (0, runner_1.stopInlineServer)();
    }
    catch (_b) { }
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
            // ── Ny: verifiera att URL:en svarar, annars öppna projektväljaren
            void verifyDevUrlAndMaybeRechoose(res.externalUrl, "initial");
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
   QuickPick
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
    panel.reveal(vscode.ViewColumn.One);
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
    await rememberCandidate(pendingCandidate, context);
    lastUiPhase = "loading";
    panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
    await tryAutoFullView(panel, context);
    await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
}
/* Välj mapp (onboarding) */
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
        await rememberCandidate(pendingCandidate, context);
        await tryAutoFullView(panel, context);
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
   Webview HTML + CSP
   ───────────────────────────────────────────────────────── */
function getWebviewHtml(context, webview) {
    const distDir = path.join(context.extensionPath, "dist-webview");
    const htmlPath = path.join(distDir, "index.html");
    let html = "";
    try {
        html = fs.readFileSync(htmlPath, "utf8");
    }
    catch (_a) {
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
  img-src http: https: data:;
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
async function activate(context) {
    extCtxRef = context; // ── Ny: spara context för verifierings-flöden
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
    statusItem.tooltip = "Välj standardprojekt för förhandsvisning";
    statusItem.command = "ai-figma-codegen.chooseProject";
    statusItem.show();
    context.subscriptions.push(statusItem);
    (async () => {
        const rem = await tryGetRememberedCandidate(context);
        updateStatusBar(rem);
    })();
    const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
        var _a;
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
            const candidates = await (0, detector_1.detectProjects)([]);
            lastCandidates = candidates;
            if (!candidates.length) {
                vscode.window.showWarningMessage("Hittade inga kandidater (körbara frontend-projekt eller statiska mappar).");
                return;
            }
            const panel = ensurePanel(context);
            pendingCandidate = candidates[0];
            panel.reveal(vscode.ViewColumn.One);
            if (candidates.length === 1 || ((_a = pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.confidence) !== null && _a !== void 0 ? _a : 0) >= AUTO_START_SURE_THRESHOLD) {
                lastUiPhase = "loading";
                panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                await rememberCandidate(pendingCandidate, context);
                await tryAutoFullView(panel, context);
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
                    await rememberCandidate(pendingCandidate, context);
                    await tryAutoFullView(panel, context);
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
            const candidates = await (0, detector_1.detectProjects)([]);
            lastCandidates = candidates;
            if (candidates.length) {
                pendingCandidate = candidates[0];
                if (candidates.length === 1 || ((_a = pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.confidence) !== null && _a !== void 0 ? _a : 0) >= AUTO_START_SURE_THRESHOLD) {
                    lastUiPhase = "loading";
                    panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                    await rememberCandidate(pendingCandidate, context);
                    await tryAutoFullView(panel, context);
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
    const forgetCmd = vscode.commands.registerCommand("ai-figma-codegen.forgetProject", async () => {
        await forgetRemembered(context);
    });
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
                const token = vscode.workspace.getConfiguration(SETTINGS_NS).get("figmaToken") || undefined;
                const panel = ensurePanel(context);
                lastInitPayload = { type: "init", fileKey, nodeId, token, figmaToken: token };
                panel.webview.postMessage(lastInitPayload);
                panel.reveal(vscode.ViewColumn.One);
                await sendFreshFigmaImageUrlToWebview("init");
                const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
                const autoStartImport = cfg.get("autoStartOnImport", true);
                if (autoStartImport) {
                    const remembered = await tryGetRememberedCandidate(context);
                    if (remembered) {
                        pendingCandidate = remembered;
                        updateStatusBar(remembered);
                        lastUiPhase = "loading";
                        panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                        await tryAutoFullView(panel, context);
                        await startCandidatePreviewWithFallback(remembered, context, { silentUntilReady: true });
                    }
                    else {
                        try {
                            const cands = await (0, detector_1.detectProjects)([]);
                            if (cands.length) {
                                pendingCandidate = cands[0];
                                await rememberCandidate(pendingCandidate, context);
                                updateStatusBar(pendingCandidate);
                                lastUiPhase = "loading";
                                panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                                await tryAutoFullView(panel, context);
                                await startCandidatePreviewWithFallback(pendingCandidate, context, { silentUntilReady: true });
                            }
                            else {
                                lastUiPhase = "onboarding";
                                panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
                            }
                        }
                        catch (_a) {
                            lastUiPhase = "onboarding";
                            panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
                        }
                    }
                }
                else {
                    lastUiPhase = "onboarding";
                    panel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
                }
            }
            catch (e) {
                errlog("URI-öppning misslyckades:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
                vscode.window.showErrorMessage(`URI-öppning misslyckades: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
            }
        },
    });
    context.subscriptions.push(scanCmd, openCmd, chooseCmd, exportCmd, uriHandler, forgetCmd);
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