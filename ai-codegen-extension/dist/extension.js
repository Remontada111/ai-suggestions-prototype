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
// ── Logg-hjälpare
const safeUrl = (u) => {
    if (!u)
        return u;
    try {
        const x = new URL(u);
        if (x.searchParams.has("token"))
            x.searchParams.set("token", "***");
        if (x.searchParams.has("figmaToken"))
            x.searchParams.set("figmaToken", "***");
        if (x.searchParams.has("auth"))
            x.searchParams.set("auth", "***");
        return x.toString();
    }
    catch (_a) {
        return u;
    }
};
const redactPath = (p) => (p ? p.replace(process.cwd() || "", ".") : p);
const nodeKey = (f, n) => `${f}:${n}`;
let activeNodes = new Map();
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
    log("Auto-reload watcher stoppad");
    reloadBaseUrl = null;
}
function startReloadWatcher(rootDir, baseUrl) {
    stopReloadWatcher();
    reloadBaseUrl = baseUrl;
    const pattern = new vscode.RelativePattern(rootDir, "**/*.{html,htm,css,js,jsx,tsx,vue,svelte}");
    reloadWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    log("Auto-reload watcher startad", { rootDir: redactPath(rootDir), baseUrl: safeUrl(baseUrl) });
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
            log("Auto-reload posting devurl (file change)", { path: p, url: safeUrl(bust) });
            currentPanel.webview.postMessage({ type: "devurl", url: bust });
            // ── Ny: verifiera att URL:en faktiskt svarar, annars öppna väljare
            void verifyDevUrlAndMaybeRechoose(bust, "reload");
        }, 200);
    };
    reloadWatcher.onDidChange(onEvt);
    reloadWatcher.onDidCreate(onEvt);
    reloadWatcher.onDidDelete(onEvt);
}
/* ─────────────────────────────────────────────────────────
   Hjälpare – nätverksprober och URL-normalisering
   ───────────────────────────────────────────────────────── */
async function probe(url, method, timeoutMs = 2500) {
    try {
        const u = new URL(url);
        const mod = u.protocol === "https:" ? https : http;
        return await new Promise((resolve) => {
            const req = mod.request({
                method,
                hostname: u.hostname,
                port: u.port,
                path: (u.pathname || "/") + (u.search || ""),
                timeout: timeoutMs,
            }, (res) => {
                var _a;
                res.resume();
                const code = (_a = res.statusCode) !== null && _a !== void 0 ? _a : 500;
                resolve(code >= 200 && code < 400);
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
function withSlash(u) {
    try {
        const url = new URL(u);
        if (!url.pathname || !url.pathname.endsWith("/")) {
            if (!/\.[a-z0-9]+$/i.test(url.pathname)) {
                url.pathname = (url.pathname || "") + "/";
            }
        }
        return url.toString();
    }
    catch (_a) {
        return u;
    }
}
function addBust(u) {
    try {
        const url = new URL(u);
        url.searchParams.set("__ext_bust", Date.now().toString(36));
        return url.toString();
    }
    catch (_a) {
        const sep = u.includes("?") ? "&" : "?";
        return `${u}${sep}__ext_bust=${Date.now().toString(36)}`;
    }
}
async function quickCheck(url) {
    const h = await probe(url, "HEAD");
    if (h) {
        log("quickCheck OK (HEAD)", { url: safeUrl(url) });
        return true;
    }
    const g = await probe(url, "GET");
    if (g) {
        log("quickCheck OK (GET)", { url: safeUrl(url) });
        return true;
    }
    warn("quickCheck FAIL", { url: safeUrl(url) });
    return false;
}
async function rootReachable(urlRaw) {
    const root = withSlash(urlRaw);
    const h = await probe(root, "HEAD");
    if (h) {
        log("rootReachable OK (HEAD)", { url: safeUrl(root) });
        return true;
    }
    const g = await probe(root, "GET");
    if (g) {
        log("rootReachable OK (GET)", { url: safeUrl(root) });
        return true;
    }
    warn("rootReachable FAIL", { url: safeUrl(root) });
    return false;
}
async function verifyDevUrlAndMaybeRechoose(url, reason) {
    if (!extCtxRef)
        return;
    const ok = await rootReachable(url);
    if (ok)
        return;
    const msg = `Preview verkar otillgänglig (${reason}) på ${url}.`;
    warn(msg);
    vscode.window.showWarningMessage(msg);
    // Visa endast webviewns folder-UI. Ingen QuickPick här.
    lastUiPhase = "onboarding";
    pendingCandidate = null;
    try {
        currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
    }
    catch (_a) { }
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
    log("Sparade valt projekt", { dir: redactPath(c.dir) });
}
async function forgetRemembered(context) {
    await context.globalState.update(STORAGE_KEYS.remembered, undefined);
    updateStatusBar(null);
    vscode.window.showInformationMessage("Glömde sparat projekt.");
    log("Glömde sparat projekt");
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
    catch (e) {
        warn("tryGetRememberedCandidate detectProjects fel", e);
    }
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
            await zenCfg.update("centerLayout", false, vscode.ConfigurationTarget.Workspace);
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
function buildProxyUrl(fileKey, nodeId, scale = "2", token) {
    const base = vscode.workspace.getConfiguration(SETTINGS_NS).get("backendBaseUrl");
    log("buildProxyUrl()", { base, fileKey, nodeId, scale, hasToken: !!token });
    if (!base)
        return null;
    let u;
    try {
        u = new URL("/api/figma-image", base);
    }
    catch (_a) {
        errlog("Ogiltig backendBaseUrl", { base });
        return null;
    }
    u.searchParams.set("fileKey", fileKey);
    u.searchParams.set("nodeId", nodeId);
    u.searchParams.set("scale", scale);
    if (token)
        u.searchParams.set("token", token);
    // OBS: tidigare satte vi flatten=0 här, vilket gav ljusare bild pga transparens över vit bakgrund.
    // Vi skickar inte flatten-override längre. Backend auto-flattenar vid behov.
    const built = u.toString();
    log("buildProxyUrl →", { url: safeUrl(built) });
    return built;
}
// Vänta tills backend rapporterar frisk /healthz innan vi postar bild-URL till webview.
async function waitForBackendHealth(attempts = 8, intervalMs = 300) {
    try {
        const base = vscode.workspace.getConfiguration(SETTINGS_NS).get("backendBaseUrl");
        if (!base)
            return true; // inget att vänta på
        const health = new URL("/healthz", base).toString();
        for (let i = 1; i <= attempts; i++) {
            const ok = await quickCheck(health);
            if (ok)
                return true;
            await new Promise(r => setTimeout(r, intervalMs));
        }
        return false;
    }
    catch (e) {
        warn("waitForBackendHealth error", e);
        return false;
    }
}
async function sendFreshFigmaImageUrlToWebview(node, source) {
    if (!currentPanel) {
        warn("sendFreshFigmaImageUrlToWebview utan panel");
        return;
    }
    const { fileKey, nodeId, figmaToken } = node;
    log("figma-image request", { source, fileKey, nodeId, hasToken: !!figmaToken });
    // Nytt: säkerställ att backend är redo innan vi ger webview en URL att ladda.
    const healthy = await waitForBackendHealth();
    if (!healthy) {
        errlog("Backend /healthz nåddes inte i tid – hoppar inte över men varnar.");
    }
    const raw = buildProxyUrl(fileKey, nodeId, "2", figmaToken);
    if (!raw) {
        errlog("Saknar giltig backendBaseUrl");
        currentPanel.webview.postMessage({
            type: "ui-error",
            message: "Saknar giltig backendBaseUrl i inställningarna.",
        });
        return;
    }
    const url = addBust(raw);
    log("Postar figma-image-url till webview", { url: safeUrl(url), fileKey, nodeId });
    currentPanel.webview.postMessage({ type: "figma-image-url", fileKey, nodeId, url });
    lastUiPhase = "default";
    currentPanel.webview.postMessage({ type: "ui-phase", phase: "default" });
}
// ── NY: skicka sparad placement till webview om sådan finns (per nod)
async function sendSeedPlacementIfAny(node) {
    var _a;
    if (!currentPanel)
        return;
    const key = `${SETTINGS_NS}.placements.v1`;
    const id = `${node.fileKey}:${node.nodeId}`;
    const all = (_a = extCtxRef === null || extCtxRef === void 0 ? void 0 : extCtxRef.workspaceState.get(key)) !== null && _a !== void 0 ? _a : {};
    const saved = all === null || all === void 0 ? void 0 : all[id];
    if (saved === null || saved === void 0 ? void 0 : saved.overlayStage) {
        currentPanel.webview.postMessage({ type: "seed-placement", fileKey: node.fileKey, nodeId: node.nodeId, payload: saved });
    }
}
/* ─────────────────────────────────────────────────────────
   Panel och meddelanden
   ───────────────────────────────────────────────────────── */
const jobPollers = new Map(); // taskId -> timer
function ensurePanel(context) {
    if (!currentPanel) {
        log("Skapar ny Webview-panel");
        currentPanel = vscode.window.createWebviewPanel("aiFigmaCodegen.panel", "🎯 Project Preview", vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))],
        });
        currentPanel.onDidDispose(async () => {
            log("Panel stängdes – städar upp servrar och state");
            currentPanel = undefined;
            lastDevUrl = null;
            pendingCandidate = null;
            lastUiPhase = "default";
            activeNodes.clear();
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
            const zenApplied = (extCtxRef !== null && extCtxRef !== void 0 ? extCtxRef : context).globalState.get(STORAGE_KEYS_UI.zenApplied, false);
            if (zenApplied) {
                try {
                    await vscode.commands.executeCommand("workbench.action.toggleZenMode");
                }
                catch (_a) { }
                try {
                    await (extCtxRef !== null && extCtxRef !== void 0 ? extCtxRef : context).globalState.update(STORAGE_KEYS_UI.zenApplied, false);
                }
                catch (_b) { }
            }
        });
        currentPanel.webview.onDidReceiveMessage(async (msg) => {
            var _a, _b, _d, _e, _f, _g, _h, _j, _k;
            log("[wv→ext] message", (_b = (_a = msg === null || msg === void 0 ? void 0 : msg.type) !== null && _a !== void 0 ? _a : msg === null || msg === void 0 ? void 0 : msg.cmd) !== null && _b !== void 0 ? _b : msg);
            if ((msg === null || msg === void 0 ? void 0 : msg.type) === "ready") {
                log("[wv→ext] ready");
                // Rehydrera ev. tidigare noder
                for (const n of activeNodes.values()) {
                    currentPanel.webview.postMessage({ type: "add-node", ...n });
                    await sendFreshFigmaImageUrlToWebview(n, "init");
                    await sendSeedPlacementIfAny(n);
                }
                if (lastDevUrl) {
                    log("Skickar tidigare devurl till webview", { url: safeUrl(lastDevUrl) });
                    currentPanel.webview.postMessage({ type: "devurl", url: lastDevUrl });
                }
                if (lastUiPhase === "onboarding") {
                    currentPanel.webview.postMessage({ type: "ui-phase", phase: "onboarding" });
                }
                else if (lastUiPhase === "loading") {
                    currentPanel.webview.postMessage({ type: "ui-phase", phase: "loading" });
                }
                return;
            }
            // ── Ny: spara endast placement vid drag/resize/import (ingen backend)
            if ((msg === null || msg === void 0 ? void 0 : msg.type) === "placementPreview" && (msg === null || msg === void 0 ? void 0 : msg.payload)) {
                try {
                    const persist = vscode.workspace.getConfiguration(SETTINGS_NS).get("persistPlacements", true);
                    if (persist) {
                        let fileKey = msg.fileKey;
                        let nodeId = msg.nodeId;
                        if (!fileKey || !nodeId) {
                            if (activeNodes.size === 1) {
                                const one = [...activeNodes.values()][0];
                                fileKey = one.fileKey;
                                nodeId = one.nodeId;
                            }
                        }
                        if (fileKey && nodeId) {
                            const id = `${fileKey}:${nodeId}`;
                            const key = `${SETTINGS_NS}.placements.v1`;
                            const all = (_d = extCtxRef === null || extCtxRef === void 0 ? void 0 : extCtxRef.workspaceState.get(key)) !== null && _d !== void 0 ? _d : {};
                            all[id] = {
                                ...msg.payload,
                                fileKey,
                                nodeId,
                                savedAt: Date.now(),
                                schema: 1,
                            };
                            await (extCtxRef === null || extCtxRef === void 0 ? void 0 : extCtxRef.workspaceState.update(key, all));
                        }
                    }
                }
                catch (e) {
                    warn("placementPreview persist fel:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
                }
                return;
            }
            // ── Spara placement per nod och TRIGGA backend-jobb direkt vid Accept.
            if ((msg === null || msg === void 0 ? void 0 : msg.type) === "placementAccepted" && (msg === null || msg === void 0 ? void 0 : msg.payload)) {
                try {
                    const persist = vscode.workspace.getConfiguration(SETTINGS_NS).get("persistPlacements", true);
                    if (persist) {
                        let fileKey = msg.fileKey;
                        let nodeId = msg.nodeId;
                        if (!fileKey || !nodeId) {
                            if (activeNodes.size === 1) {
                                const one = [...activeNodes.values()][0];
                                fileKey = one.fileKey;
                                nodeId = one.nodeId;
                            }
                        }
                        if (fileKey && nodeId) {
                            const id = `${fileKey}:${nodeId}`;
                            const key = `${SETTINGS_NS}.placements.v1`;
                            const all = (_e = extCtxRef === null || extCtxRef === void 0 ? void 0 : extCtxRef.workspaceState.get(key)) !== null && _e !== void 0 ? _e : {};
                            all[id] = {
                                ...msg.payload,
                                fileKey,
                                nodeId,
                                savedAt: Date.now(),
                                schema: 1,
                            };
                            await (extCtxRef === null || extCtxRef === void 0 ? void 0 : extCtxRef.workspaceState.update(key, all));
                            log("Placement persisterad per nod", { id });
                        }
                        else {
                            warn("placementAccepted utan fileKey/nodeId och >1 aktiv nod; hoppar över persist");
                        }
                    }
                    // Starta backend-jobbet nu
                    try {
                        const base = vscode.workspace.getConfiguration(SETTINGS_NS).get("backendBaseUrl");
                        if (!base)
                            throw new Error("Saknar backendBaseUrl i inställningarna.");
                        const fileKey = (_f = msg.fileKey) !== null && _f !== void 0 ? _f : ((_g = [...activeNodes.values()][0]) === null || _g === void 0 ? void 0 : _g.fileKey);
                        const nodeId = (_h = msg.nodeId) !== null && _h !== void 0 ? _h : ((_j = [...activeNodes.values()][0]) === null || _j === void 0 ? void 0 : _j.nodeId);
                        if (!fileKey || !nodeId)
                            throw new Error("Saknar fileKey/nodeId för jobbet.");
                        const url = new URL("/figma-hook", base).toString();
                        const resp = await postJson(url, { fileKey, nodeId, placement: msg.payload });
                        const taskId = resp === null || resp === void 0 ? void 0 : resp.task_id;
                        if (!taskId) {
                            vscode.window.showWarningMessage("Backend returnerade inget task_id.");
                            return;
                        }
                        // Informera webview om att jobb startat
                        currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.webview.postMessage({ type: "job-started", taskId, fileKey, nodeId });
                        // Starta polling
                        const statusUrl = new URL(`/task/${encodeURIComponent(taskId)}`, base).toString();
                        const t = setInterval(async () => {
                            try {
                                const s = await fetchStatus(statusUrl);
                                if (!s)
                                    return;
                                if (s.done) {
                                    clearInterval(t);
                                    jobPollers.delete(taskId);
                                    currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.webview.postMessage({
                                        type: "job-finished",
                                        status: s.status,
                                        pr_url: s.pr_url,
                                        error: s.error,
                                    });
                                    if (s.status === "SUCCESS" && s.pr_url) {
                                        vscode.window.showInformationMessage(`PR skapad: ${s.pr_url}`, "Öppna").then((btn) => {
                                            if (btn === "Öppna")
                                                vscode.env.openExternal(vscode.Uri.parse(s.pr_url));
                                        });
                                    }
                                    else if (s.status === "FAILURE") {
                                        vscode.window.showErrorMessage(s.error || "Jobbet misslyckades.");
                                    }
                                }
                            }
                            catch (_a) { }
                        }, 1500);
                        jobPollers.set(taskId, t);
                    }
                    catch (e) {
                        vscode.window.showErrorMessage(`Kunde inte starta jobb: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
                    }
                    // Enkla kontroller
                    const p = msg.payload;
                    const issues = [];
                    if (((_k = p === null || p === void 0 ? void 0 : p.ar) === null || _k === void 0 ? void 0 : _k.deltaPct) > 0.02)
                        issues.push(`AR-avvikelse ${(p.ar.deltaPct * 100).toFixed(1)}%`);
                    if ((p === null || p === void 0 ? void 0 : p.sizePct) < 0.15)
                        issues.push("Overlay < 15% av ytan");
                    const near = (p === null || p === void 0 ? void 0 : p.edges) ? Object.entries(p.edges).filter(([, v]) => v).map(([k]) => k).join(", ") : "";
                    const hint = near ? `Nära kanter: ${near}` : "";
                    if (issues.length)
                        vscode.window.showWarningMessage(`Placement kontrollerad: ${issues.join(" · ")} ${hint}`);
                    else
                        vscode.window.showInformationMessage("Placement mottagen och validerad.");
                }
                catch (e) {
                    errlog("Kunde inte spara placement (workspaceState):", (e === null || e === void 0 ? void 0 : e.message) || String(e));
                }
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "cancelJob" && typeof msg.taskId === "string") {
                try {
                    const base = vscode.workspace.getConfiguration(SETTINGS_NS).get("backendBaseUrl");
                    if (!base)
                        throw new Error("Saknar backendBaseUrl i inställningarna.");
                    const u = new URL(`/task/${encodeURIComponent(msg.taskId)}/cancel`, base).toString();
                    await postJson(u, {}); // POST cancel
                    const t = jobPollers.get(msg.taskId);
                    if (t) {
                        clearInterval(t);
                        jobPollers.delete(msg.taskId);
                    }
                    currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.webview.postMessage({ type: "job-finished", status: "CANCELLED" });
                    vscode.window.showInformationMessage("Jobb avbrutet.");
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Kunde inte avbryta jobb: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
                }
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "acceptCandidate") {
                log("WV bad om acceptCandidate");
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
                    warn("acceptCandidate utan kandidat – ignorerar");
                    return;
                }
                await rememberCandidate(pendingCandidate, extCtxRef !== null && extCtxRef !== void 0 ? extCtxRef : {});
                await startCandidatePreviewWithFallback(pendingCandidate, extCtxRef, { silentUntilReady: true });
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "forgetProject") {
                log("WV bad om forgetProject");
                await forgetRemembered(extCtxRef);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "chooseProject") {
                log("WV bad om chooseProject");
                await showProjectQuickPick(extCtxRef);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "pickFolder") {
                log("WV bad om pickFolder");
                await pickFolderAndStart(extCtxRef);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "openPR" && typeof msg.url === "string") {
                log("Öppnar PR-url via system", { url: msg.url });
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "enterFullView") {
                log("WV bad om enterFullView");
                await enterFullView(currentPanel);
                try {
                    await new Promise(r => setTimeout(r, 60));
                    currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
                }
                catch (_l) { }
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "refreshFigmaImage") {
                log("WV bad om refreshFigmaImage");
                const nodeId = typeof msg.nodeId === "string" ? msg.nodeId : undefined;
                let target;
                if (nodeId) {
                    target = [...activeNodes.values()].find(x => x.nodeId === nodeId);
                }
                else if (activeNodes.size === 1) {
                    target = [...activeNodes.values()][0];
                }
                if (target)
                    await sendFreshFigmaImageUrlToWebview(target, "refresh");
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "chat" && typeof msg.text === "string") {
                log("[chat]", msg.text);
                return;
            }
        });
        currentPanel.webview.html = getWebviewHtml(context, currentPanel.webview);
        log("Webview HTML laddad");
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
        warn("Inget devCmd funnet för kandidat", { dir: redactPath(c.dir) });
        return undefined;
    }
    if (/\bhttp-server\b/i.test(raw)) {
        let patched = raw
            .replace(/\s--port\s+\d+/i, " --port 0")
            .replace(/\s-p\s+\d+/i, " -p 0");
        if (!/(\s--port|\s-p)\s+\d+/i.test(patched))
            patched += " -p 0";
        log("Valt devCmd (http-server)", { cmd: patched });
        return patched;
    }
    const norm = normalizeDevCmdPorts(raw);
    log("Valt devCmd", { raw, normalized: norm });
    return norm;
}
async function findExistingHtml(c) {
    if (c.entryHtml) {
        const found = { relHtml: normalizeRel(c.entryHtml), root: c.dir };
        log("Hittade entryHtml i kandidat", found);
        return found;
    }
    const candidates = [
        "index.html",
        "public/index.html",
        "apps/web/index.html",
        "packages/web/public/index.html",
    ];
    for (const rel of candidates) {
        const p = path.join(c.dir, rel);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            const found = { relHtml: normalizeRel(rel), root: c.dir };
            log("Hittade statisk HTML", found);
            return found;
        }
    }
    log("Ingen statisk HTML hittad", { dir: redactPath(c.dir) });
    return null;
}
function normalizeRel(rel) {
    return rel.replace(/^\.\//, "").replace(/^\/+/, "");
}
async function startOrRespectfulFallback(c, context) {
    const cmd = selectLaunchCommand(c);
    if (cmd) {
        try {
            log("Startar dev-server", { cmd, cwd: redactPath(c.dir) });
            const { externalUrl } = await (0, runner_1.runDevServer)(cmd, c.dir);
            log("Dev-server startad", { externalUrl: safeUrl(externalUrl) });
            if (/\bhttp-server\b/i.test(cmd)) {
                const html = await findExistingHtml(c);
                if (html) {
                    const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
                    const url = base + encodeURI(html.relHtml);
                    log("http-server URL uppräknad mot HTML", { url: safeUrl(url) });
                    return { externalUrl: url, mode: "http", watchRoot: html.root };
                }
                return { externalUrl, mode: "http", watchRoot: c.dir };
            }
            try {
                const ok = await quickCheck(externalUrl);
                if (!ok) {
                    const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
                    if (await quickCheck(base + "index.html")) {
                        const url = base + "index.html";
                        log("Föll tillbaka till index.html", { url: safeUrl(url) });
                        return { externalUrl: url, mode: "dev" };
                    }
                    if (c.entryHtml) {
                        const url = base + encodeURI(normalizeRel(c.entryHtml));
                        log("Föll tillbaka till entryHtml", { url: safeUrl(url) });
                        return { externalUrl: url, mode: "dev" };
                    }
                }
            }
            catch (e) {
                warn("quickCheck-fel ignoreras", e);
            }
            return { externalUrl, mode: "dev" };
        }
        catch (e) {
            errlog("Dev-server start misslyckades:", (e === null || e === void 0 ? void 0 : e.message) || e);
        }
    }
    const html = await findExistingHtml(c);
    if (html) {
        log("Startar inline static server för HTML-root", { root: redactPath(html.root) });
        const { externalUrl } = await (0, runner_1.runInlineStaticServer)(html.root);
        const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
        const url = base + encodeURI(html.relHtml);
        log("Inline static server URL", { url: safeUrl(url) });
        return { externalUrl: url, mode: "inline", watchRoot: html.root };
    }
    const storageDir = await ensureStoragePreview(context);
    log("Startar inline static server (storage preview)", { dir: redactPath(storageDir) });
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
    log("Skapade storage preview-index", { path: redactPath(indexPath) });
    return previewDir;
}
/**
 * Starta kandidatens preview
 */
async function startCandidatePreviewWithFallback(c, context, opts) {
    const panel = ensurePanel(context);
    try {
        await (0, runner_1.stopDevServer)();
        log("Stoppade ev. tidigare dev-server");
    }
    catch (_a) { }
    try {
        await (0, runner_1.stopInlineServer)();
        log("Stoppade ev. tidigare inline-server");
    }
    catch (_b) { }
    stopReloadWatcher();
    const silent = !!(opts === null || opts === void 0 ? void 0 : opts.silentUntilReady);
    let placeholder = null;
    if (!silent) {
        const storageDir = await ensureStoragePreview(context);
        placeholder = await (0, runner_1.runInlineStaticServer)(storageDir);
        lastDevUrl = addBust(placeholder.externalUrl);
        log("Placeholder preview startad", { url: safeUrl(lastDevUrl) });
        panel.webview.postMessage({ type: "devurl", url: lastDevUrl });
    }
    else {
        log("Silent start: väntar med placeholder");
    }
    (async () => {
        try {
            const res = await startOrRespectfulFallback(c, context);
            const busted = addBust(res.externalUrl);
            lastDevUrl = busted;
            log("Postar devurl", { url: safeUrl(busted), mode: res.mode, watchRoot: redactPath(res.watchRoot) });
            panel.webview.postMessage({ type: "devurl", url: busted });
            // ── Ny: verifiera att URL:en svarar, annars öppna projektväljaren
            void verifyDevUrlAndMaybeRechoose(busted, "initial");
            if ((res.mode === "inline" || res.mode === "http") && res.watchRoot) {
                startReloadWatcher(res.watchRoot, res.externalUrl);
            }
            else {
                stopReloadWatcher();
            }
            if (placeholder) {
                try {
                    await placeholder.stop();
                    log("Stoppade placeholder-server");
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
function relToWorkspace(p) {
    var _a, _b;
    const roots = (_b = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a.map(f => f.uri.fsPath)) !== null && _b !== void 0 ? _b : [];
    for (const r of roots) {
        const rel = path.relative(r, p);
        if (!rel.startsWith(".."))
            return rel.replace(/\\/g, "/");
    }
    return p.replace(/\\/g, "/"); // fallback: absolut path
}
function toPickItems(candidates) {
    return candidates.map((c, i) => ({
        label: `Project ${i + 1}`,
        detail: relToWorkspace(c.dir),
        _c: c,
    }));
}
async function showProjectQuickPick(context) {
    const panel = ensurePanel(context);
    panel.reveal(vscode.ViewColumn.One);
    // ── Ny: rescan varje gång
    try {
        lastCandidates = await (0, detector_1.detectProjects)([]);
        log("Detekterade kandidater", { count: lastCandidates.length });
    }
    catch (e) {
        vscode.window.showErrorMessage(`Kunde inte hitta kandidater: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
        errlog("Detektering misslyckades i QuickPick:", (e === null || e === void 0 ? void 0 : e.message) || e);
        return;
    }
    if (!lastCandidates.length) {
        vscode.window.showWarningMessage("Hittade inga kandidater att välja bland.");
        warn("QuickPick: inga kandidater");
        return;
    }
    const chosen = await vscode.window.showQuickPick(toPickItems(lastCandidates), {
        placeHolder: "Välj projekt att förhandsvisa",
        matchOnDescription: false,
        matchOnDetail: true,
        ignoreFocusOut: true,
    });
    if (!chosen) {
        log("QuickPick avbruten");
        return;
    }
    pendingCandidate = chosen._c;
    log("QuickPick val", { dir: redactPath(pendingCandidate.dir) });
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
    if (!uris || !uris.length) {
        log("Folder-pick avbruten");
        return;
    }
    const folderPath = uris[0].fsPath;
    log("Folder vald", { folderPath: redactPath(folderPath) });
    lastUiPhase = "loading";
    panel.webview.postMessage({ type: "ui-phase", phase: "loading" });
    try {
        const candidates = await (0, detector_1.detectProjects)([folderPath]);
        lastCandidates = candidates;
        log("Detekterade kandidater i vald folder", { count: candidates.length });
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
        warn("Kunde inte läsa dist-webview/index.html – använder basic fallback");
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
   POST/GET helpers för backend
   ───────────────────────────────────────────────────────── */
function postJson(url, json, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        try {
            const u = new URL(url);
            const data = Buffer.from(JSON.stringify(json));
            const mod = u.protocol === "https:" ? https : http;
            const req = mod.request({
                method: "POST",
                hostname: u.hostname,
                port: u.port,
                path: (u.pathname || "/") + (u.search || ""),
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": data.byteLength,
                },
                timeout: timeoutMs,
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                res.on("end", () => {
                    var _a;
                    const body = Buffer.concat(chunks).toString("utf8");
                    if (((_a = res.statusCode) !== null && _a !== void 0 ? _a : 500) >= 400)
                        return reject(new Error(`${res.statusCode} ${res.statusMessage}: ${body}`));
                    try {
                        resolve(body ? JSON.parse(body) : {});
                    }
                    catch (_b) {
                        resolve({ raw: body });
                    }
                });
            });
            req.on("timeout", () => { req.destroy(new Error("timeout")); });
            req.on("error", reject);
            req.write(data);
            req.end();
        }
        catch (e) {
            reject(e);
        }
    });
}
async function fetchStatus(url, timeoutMs = 6000) {
    return await new Promise((resolve) => {
        try {
            const u = new URL(url);
            const mod = u.protocol === "https:" ? https : http;
            const req = mod.request({ method: "GET", hostname: u.hostname, port: u.port, path: (u.pathname || "/") + (u.search || ""), timeout: timeoutMs }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                res.on("end", () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                        const raw = String((body === null || body === void 0 ? void 0 : body.status) || "");
                        const mapped = raw === "SUCCESS" ? "SUCCESS" :
                            raw === "FAILURE" ? "FAILURE" :
                                raw === "REVOKED" ? "CANCELLED" :
                                    "PENDING";
                        const done = mapped === "SUCCESS" || mapped === "FAILURE" || mapped === "CANCELLED";
                        resolve({ done, status: mapped, pr_url: body === null || body === void 0 ? void 0 : body.pr_url, error: body === null || body === void 0 ? void 0 : body.error });
                    }
                    catch (_a) {
                        resolve(null);
                    }
                });
            });
            req.on("timeout", () => { req.destroy(); resolve(null); });
            req.on("error", () => resolve(null));
            req.end();
        }
        catch (_a) {
            resolve(null);
        }
    });
}
// Välj nod och skicka placement till backend
async function triggerFigmaHookWithPlacement() {
    var _a, _b;
    if (activeNodes.size === 0) {
        vscode.window.showErrorMessage("Ingen importerad Figma-nod ännu.");
        return;
    }
    // välj nod om flera
    let chosen;
    if (activeNodes.size === 1) {
        chosen = [...activeNodes.values()][0];
    }
    else {
        const picks = [...activeNodes.values()].map((n) => ({
            label: n.nodeId,
            description: n.fileKey,
            _n: n,
        }));
        const sel = await vscode.window.showQuickPick(picks, {
            placeHolder: "Välj Figma-nod att skicka till backend",
            ignoreFocusOut: true,
            matchOnDescription: true,
        });
        if (!sel)
            return;
        chosen = sel._n;
    }
    const base = vscode.workspace.getConfiguration(SETTINGS_NS).get("backendBaseUrl");
    if (!base) {
        vscode.window.showErrorMessage("Saknar backendBaseUrl i inställningarna.");
        return;
    }
    const key = `${SETTINGS_NS}.placements.v1`;
    const id = `${chosen.fileKey}:${chosen.nodeId}`;
    const all = (_a = extCtxRef === null || extCtxRef === void 0 ? void 0 : extCtxRef.workspaceState.get(key)) !== null && _a !== void 0 ? _a : {};
    const placement = all === null || all === void 0 ? void 0 : all[id];
    try {
        const url = new URL("/figma-hook", base).toString();
        const resp = await postJson(url, {
            fileKey: chosen.fileKey,
            nodeId: chosen.nodeId,
            placement,
        });
        vscode.window.showInformationMessage(`Startade jobb ${(_b = resp === null || resp === void 0 ? void 0 : resp.task_id) !== null && _b !== void 0 ? _b : ""} för ${chosen.nodeId}`);
    }
    catch (e) {
        vscode.window.showErrorMessage(`Kunde inte starta jobb: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
    }
}
/* ─────────────────────────────────────────────────────────
   Aktivering
   ───────────────────────────────────────────────────────── */
async function activate(context) {
    extCtxRef = context;
    log("Aktiverar extension …");
    const bundledModelPath = resolveBundledModelPath(context);
    if (bundledModelPath)
        log("Försöker ladda bundlad ML-modell", { modelPath: redactPath(bundledModelPath) });
    else
        log("Ingen bundlad ML-modell hittades (OK för MVP)");
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
        log("Remembered candidate vid aktivering", { present: !!rem, dir: (rem === null || rem === void 0 ? void 0 : rem.dir) && redactPath(rem.dir) });
    })();
    const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
        var _a;
        log("Cmd: scanAndPreview");
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
            log("scanAndPreview kandidater", { count: candidates.length });
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
                log("scanAndPreview val", { choice });
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
        log("Cmd: openPanel");
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
            log("openPanel detekterade kandidater", { count: lastCandidates.length });
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
        log("Cmd: chooseProject");
        await showProjectQuickPick(context);
    });
    const exportCmd = vscode.commands.registerCommand("ai-figma-codegen.exportFrontendDetectorDataset", async () => {
        log("Cmd: exportFrontendDetectorDataset");
        try {
            await (0, exportDataset_1.exportDatasetCommand)();
        }
        catch (e) {
            errlog("ExportDataset fel:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
            vscode.window.showErrorMessage(`ExportDataset misslyckades: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
        }
    });
    const forgetCmd = vscode.commands.registerCommand("ai-figma-codegen.forgetProject", async () => {
        log("Cmd: forgetProject");
        await forgetRemembered(context);
    });
    // ── NYTT: skicka placement till backend (välj nod vid flera)
    const sendPlacementCmd = vscode.commands.registerCommand("ai-figma-codegen.sendPlacement", async () => {
        log("Cmd: sendPlacement");
        await triggerFigmaHookWithPlacement();
    });
    const uriHandler = vscode.window.registerUriHandler({
        handleUri: async (uri) => {
            var _a;
            try {
                const params = new URLSearchParams(uri.query);
                const fileKey = params.get("fileKey") || "";
                const nodeId = params.get("nodeId") || "";
                log("URI handler", { path: uri.path, fileKey, nodeId, qs: (_a = uri.query) === null || _a === void 0 ? void 0 : _a.length });
                if (!fileKey || !nodeId) {
                    vscode.window.showErrorMessage("Saknar fileKey eller nodeId i URI.");
                    return;
                }
                const token = vscode.workspace.getConfiguration(SETTINGS_NS).get("figmaToken") || undefined;
                const panel = ensurePanel(context);
                // Lägg till eller uppdatera nod i minnet
                const n = { fileKey, nodeId, token, figmaToken: token };
                activeNodes.set(nodeKey(fileKey, nodeId), n);
                // Informera webview om ny nod och ladda dess bild
                panel.webview.postMessage({ type: "add-node", ...n });
                panel.reveal(vscode.ViewColumn.One);
                await sendFreshFigmaImageUrlToWebview(n, "init");
                await sendSeedPlacementIfAny(n);
                const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
                const autoStartImport = cfg.get("autoStartOnImport", true);
                log("autoStartOnImport", { autoStartImport });
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
                            log("URI detectProjects", { count: cands.length });
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
                        catch (e) {
                            warn("URI detectProjects error", e);
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
    context.subscriptions.push(scanCmd, openCmd, chooseCmd, exportCmd, uriHandler, forgetCmd, sendPlacementCmd);
    log("Extension aktiverad");
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
    for (const t of jobPollers.values()) {
        try {
            clearInterval(t);
        }
        catch (_a) { }
    }
    jobPollers.clear();
}
//# sourceMappingURL=extension.js.map