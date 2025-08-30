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
// ⬇️ ML: ladda ev. modell
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
                // ⚙️ inkludera querystring så dev-servrar med paths funkar
                path: (u.pathname || "/") + (u.search || ""),
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
   Kom-ihåg valt projekt + Maximal visningsyta
   ───────────────────────────────────────────────────────── */
const STORAGE_KEYS = { remembered: "aiFigmaCodegen.rememberedProject.v1" };
const SETTINGS_NS = "aiFigmaCodegen";
const STORAGE_KEYS_UI = { askedFullView: "ui.askedFullView.v1" };
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
    catch ( /* ignore */_b) { /* ignore */ }
    return null;
}
/** Gör webviewen så stor som möjligt inom VS Code (utan OS-helskärm). */
async function enterFullView(panel) {
    try {
        await vscode.commands.executeCommand("workbench.action.editorLayoutSingle");
    }
    catch (_a) { }
    try {
        await vscode.commands.executeCommand("workbench.action.closePanel");
    }
    catch (_b) { }
    try {
        await vscode.commands.executeCommand("workbench.action.closeSidebar");
    }
    catch (_d) { }
    try {
        panel === null || panel === void 0 ? void 0 : panel.reveal(vscode.ViewColumn.One, false);
    }
    catch (_e) { }
}
/** Auto-”full view”; OS-helskärm (F11) om aktiverat i settings. */
async function tryAutoFullView(panel, context) {
    var _a;
    const cfg = vscode.workspace.getConfiguration(SETTINGS_NS);
    const autoFull = cfg.get("autoFullView", true);
    const useZen = cfg.get("autoZenMode", false);
    const useWinFS = cfg.get("autoWindowFullScreen", true); // ⬅️ ny
    const asked = context.globalState.get(STORAGE_KEYS_UI.askedFullView, false);
    // Engångsfråga om autoFullView inte är explicit satt av användaren
    if (!asked && ((_a = cfg.inspect("autoFullView")) === null || _a === void 0 ? void 0 : _a.globalValue) === undefined) {
        await context.globalState.update(STORAGE_KEYS_UI.askedFullView, true);
        const yes = "Ja, kör Full View";
        const no = "Inte nu";
        const pick = await vscode.window.showInformationMessage("Vill du öppna förhandsvisningen i Full View-läge framöver?", yes, no);
        try {
            await cfg.update("autoFullView", pick === yes, vscode.ConfigurationTarget.Global);
        }
        catch ( /* ignore */_b) { /* ignore */ }
    }
    const finalAutoFull = vscode.workspace.getConfiguration(SETTINGS_NS).get("autoFullView", true);
    if (finalAutoFull || autoFull)
        await enterFullView(panel);
    // 🚀 Riktig helskärm (F11) istället för att förlita oss på Zen Mode
    if (useWinFS) {
        try {
            await vscode.commands.executeCommand("workbench.action.toggleFullScreen");
            // liten paus + ping till webview för reflow
            await new Promise((r) => setTimeout(r, 120));
            panel === null || panel === void 0 ? void 0 : panel.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
        }
        catch (_d) { }
    }
    // Zen Mode (opt-in). Kan lämnas avstängt p.g.a. kända fullscreen-quirks på Windows.
    if (useZen) {
        try {
            await vscode.commands.executeCommand("workbench.action.toggleZenMode");
            await new Promise((r) => setTimeout(r, 120));
            panel === null || panel === void 0 ? void 0 : panel.webview.postMessage({ type: "ui-phase", phase: lastUiPhase });
        }
        catch (_e) { }
    }
}
function buildFigmaImagesEndpoint(fileKey, nodeId) {
    const base = "https://api.figma.com/v1/images";
    const params = new URLSearchParams({
        ids: nodeId,
        format: "png",
        use_absolute_bounds: "true",
        scale: "1",
    });
    return `${base}/${encodeURIComponent(fileKey)}?${params.toString()}`;
}
async function fetchJson(url, headers) {
    return await new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            method: "GET",
            hostname: u.hostname,
            path: u.pathname + u.search,
            headers,
        }, (res) => {
            const chunks = [];
            res.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
            res.on("end", () => {
                const status = res.statusCode || 0;
                let body = null;
                try {
                    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                }
                catch (_a) {
                    body = null;
                }
                resolve({ status, body });
            });
        });
        req.on("error", (e) => reject(e));
        req.end();
    });
}
async function resolveFigmaImageUrlBackend(fileKey, nodeId, token) {
    var _a, _b, _d, _e, _f, _g, _h, _j;
    if (!fileKey || !nodeId || !token) {
        return { ok: false, status: 0, message: "Saknar fileKey/nodeId/token" };
    }
    const endpoint = buildFigmaImagesEndpoint(fileKey, nodeId);
    // Försök först med Authorization: Bearer
    let r = await fetchJson(endpoint, { Authorization: `Bearer ${token}` });
    if (r.status >= 200 && r.status < 300) {
        const url = (_b = (_a = r.body) === null || _a === void 0 ? void 0 : _a.images) === null || _b === void 0 ? void 0 : _b[nodeId];
        if (typeof url === "string" && url.length)
            return { ok: true, url };
    }
    else if (r.status === 401 || r.status === 403) {
        // Fallback: X-FIGMA-TOKEN
        r = await fetchJson(endpoint, { "X-FIGMA-TOKEN": token });
        if (r.status >= 200 && r.status < 300) {
            const url = (_e = (_d = r.body) === null || _d === void 0 ? void 0 : _d.images) === null || _e === void 0 ? void 0 : _e[nodeId];
            if (typeof url === "string" && url.length)
                return { ok: true, url };
        }
        const msg = ((_f = r.body) === null || _f === void 0 ? void 0 : _f.err) || "Åtkomst nekad. Kontrollera token/scope/filåtkomst.";
        return { ok: false, status: 403, message: String(msg) };
    }
    // Om vi kom hit utan URL men utan 401/403 → retry med exponentiell backoff
    let delay = 300;
    for (let i = 0; i < 4; i++) {
        await new Promise((res) => setTimeout(res, delay));
        delay *= 2;
        const try1 = await fetchJson(endpoint, { Authorization: `Bearer ${token}` });
        if (try1.status >= 200 && try1.status < 300) {
            const url = (_h = (_g = try1.body) === null || _g === void 0 ? void 0 : _g.images) === null || _h === void 0 ? void 0 : _h[nodeId];
            if (typeof url === "string" && url.length)
                return { ok: true, url };
        }
    }
    const msg = ((_j = r.body) === null || _j === void 0 ? void 0 : _j.err) || "Kunde inte hämta Figma-bild-URL.";
    return { ok: false, status: r.status || 500, message: String(msg) };
}
async function sendFreshFigmaImageUrlToWebview(source) {
    if (!currentPanel || !lastInitPayload)
        return;
    const { fileKey, nodeId } = lastInitPayload;
    // Token: prefer payload token, annars från settings
    const token = lastInitPayload.figmaToken ||
        lastInitPayload.token ||
        vscode.workspace.getConfiguration(SETTINGS_NS).get("figmaToken") ||
        undefined;
    const res = await resolveFigmaImageUrlBackend(fileKey, nodeId, token);
    if (res.ok) {
        currentPanel.webview.postMessage({ type: "figma-image-url", url: res.url });
        // ✅ Garantera att onboard/loading inte täcker figma-bilden
        lastUiPhase = "default";
        currentPanel.webview.postMessage({ type: "ui-phase", phase: "default" });
        log(`Figma-image-url (${source}) skickad.`);
    }
    else {
        errlog(`Figma URL misslyckades (${source}):`, res.status, res.message);
        // Skicka ett UI-fel till webview (om den väljer att visa det)
        currentPanel.webview.postMessage({
            type: "ui-error",
            message: `Figma-bild kunde inte hämtas (${res.status}). ${res.message}`,
        });
    }
}
/* ─────────────────────────────────────────────────────────
   Panel och meddelandehantering
   ───────────────────────────────────────────────────────── */
function ensurePanel(context) {
    if (!currentPanel) {
        log("Skapar ny Webview-panel …");
        currentPanel = vscode.window.createWebviewPanel("aiFigmaCodegen.panel", "🎯 Project Preview", vscode.ViewColumn.One, // ✅ alltid kolumn 1
        {
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
                if (lastInitPayload) {
                    currentPanel.webview.postMessage(lastInitPayload);
                    // Skicka också färsk Figma-image-url direkt vid ready
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
            // 🔹 Placering accepterad från webview (redo för ML/lagring)
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
            // ✅ Starta föreslagen kandidat även om pendingCandidate saknas; minns valet
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
            // ✅ Stöd för “Glöm” från webview
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
                // extra ping för stabil layout
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
/** Minimal temporär preview i globalStorage */
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
 * Starta kandidatens preview (silent placeholder tills verklig URL finns)
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
    // Spara valet som globalt standardprojekt
    await rememberCandidate(pendingCandidate, context);
    // Maximal visningsyta + start
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
        // Spara valet som globalt standardprojekt
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
   Webview HTML + CSP (fallback om dist saknas)
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
    statusItem.tooltip = "Välj standardprojekt för förhandsvisning";
    statusItem.command = "ai-figma-codegen.chooseProject";
    statusItem.show();
    context.subscriptions.push(statusItem);
    // Uppdatera statusbar baserat på ihågkommet projekt (om finns)
    (async () => {
        const rem = await tryGetRememberedCandidate(context);
        updateStatusBar(rem);
    })();
    const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
        var _a;
        try {
            // Försök först med ihågkommet projekt
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
        // AUTO: om vi har ett ihågkommet projekt – starta direkt
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
        // Annars: försök hitta kandidater och ev. starta
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
    // 🔹 Glöm sparat projekt
    const forgetCmd = vscode.commands.registerCommand("ai-figma-codegen.forgetProject", async () => {
        await forgetRemembered(context);
    });
    // 🔹 URI-handler (Figma import) – autostarta globalt ihågkommet projekt; annars detektera+spara+starta
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
                // Skicka direkt en färsk bild-URL till webviewen (och ställ fas till default)
                await sendFreshFigmaImageUrlToWebview("init");
                // Global autostart: oavsett vilken Figma-fil som öppnas
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
                        // ✅ Felsäkert: hitta bästa kandidat, spara och starta
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
                    // Autostart avstängd → onboarding (Figma-bild syns ändå tack vare webview-logik)
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