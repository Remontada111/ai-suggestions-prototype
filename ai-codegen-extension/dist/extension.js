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
const detector_1 = require("./detector");
const runner_1 = require("./runner");
const analyzeClient_1 = require("./analyzeClient");
let currentPanel;
let lastInitPayload = null;
let lastDevUrl = null;
let pendingCandidate = null;
/* ─────────────────────────────────────────────────────────
   Panel och meddelandehantering
   ───────────────────────────────────────────────────────── */
function ensurePanel(context) {
    if (!currentPanel) {
        currentPanel = vscode.window.createWebviewPanel("aiFigmaCodegen.panel", "🎯 Project Preview", vscode.ViewColumn.Two, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))],
        });
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
            lastDevUrl = null;
            lastInitPayload = null;
            pendingCandidate = null;
            // Stäng ev. aktiv dev-server när panelen stängs
            (0, runner_1.stopDevServer)().catch(() => { });
        });
        currentPanel.webview.onDidReceiveMessage(async (msg) => {
            if ((msg === null || msg === void 0 ? void 0 : msg.type) === "ready") {
                if (lastInitPayload)
                    currentPanel.webview.postMessage(lastInitPayload);
                if (lastDevUrl)
                    currentPanel.webview.postMessage({ type: "devurl", url: lastDevUrl });
                if (pendingCandidate)
                    postCandidateProposal(pendingCandidate);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "acceptCandidate") {
                if (!pendingCandidate)
                    return;
                await startCandidatePreviewWithFallback(pendingCandidate, context);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "openPR" && typeof msg.url === "string") {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "chat" && typeof msg.text === "string") {
                console.log("[ai-figma-codegen/chat]", msg.text);
                return;
            }
        });
        currentPanel.webview.html = getWebviewHtml(context, currentPanel.webview);
    }
    else {
        currentPanel.reveal(vscode.ViewColumn.Two);
    }
    return currentPanel;
}
function postCandidateProposal(c) {
    var _a, _b, _c;
    if (!currentPanel)
        return;
    const label = c.pkgName ? c.pkgName : path.basename(c.dir);
    const launchCmd = selectLaunchCommand(c);
    const description = `${c.framework} • ${(_c = launchCmd !== null && launchCmd !== void 0 ? launchCmd : (_b = (_a = c.runCandidates) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.cmd) !== null && _c !== void 0 ? _c : "auto"}`;
    currentPanel.webview.postMessage({
        type: "candidate-proposal",
        payload: { label, description, dir: c.dir, launchCmd: launchCmd !== null && launchCmd !== void 0 ? launchCmd : undefined },
    });
}
/* ─────────────────────────────────────────────────────────
   Upptäckt & uppstart
   ───────────────────────────────────────────────────────── */
function selectLaunchCommand(c) {
    var _a, _b, _c;
    const raw = (_a = c.devCmd) !== null && _a !== void 0 ? _a : (_c = (_b = c.runCandidates) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.cmd;
    if (!raw)
        return undefined;
    // Normalisera http-server → tvinga ephemeral port (-p 0 / --port 0)
    if (/\bhttp-server\b/i.test(raw)) {
        let patched = raw
            .replace(/\s--port\s+\d+/i, " --port 0")
            .replace(/\s-p\s+\d+/i, " -p 0");
        if (!/(\s--port|\s-p)\s+\d+/i.test(patched)) {
            patched += " -p 0";
        }
        return patched;
    }
    return raw;
}
/** Sök bästa befintliga HTML att visa, utan att skapa nya filer i projektet. */
async function findExistingHtml(c) {
    // 1) Detektorns entryHtml om finns
    if (c.entryHtml) {
        return { relHtml: normalizeRel(c.entryHtml), root: c.dir };
    }
    // 2) Vanliga konventioner
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
/** Försök starta dev-server; om saknas → serva befintlig HTML; annars sista utväg: extern minimal preview. */
async function startOrRespectfulFallback(c, context) {
    // 1) Dev-script
    const cmd = selectLaunchCommand(c);
    if (cmd) {
        const { externalUrl } = await (0, runner_1.runDevServer)(cmd, c.dir);
        return { externalUrl };
    }
    // 2) Respektera befintlig HTML (ingen skrivning i projektet)
    const html = await findExistingHtml(c);
    if (html) {
        // Kör http-server i projektroten och länka direkt till HTML:en (alltid ledig port)
        const { externalUrl } = await (0, runner_1.runDevServer)(`npx -y http-server -p 0`, html.root);
        const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
        return { externalUrl: base + encodeURI(html.relHtml) };
    }
    // 3) Sista utväg: skapa minimal preview i extensionens storage (inte i projektet)
    const storageDir = await ensureStoragePreview(context);
    const { externalUrl } = await (0, runner_1.runDevServer)(`npx -y http-server -p 0`, storageDir);
    return { externalUrl };
}
/** Skapa en minimal *extern* (icke-invasiv) preview i extensionens globalStorage.
 *  Endast index.html + main.js, inga .json eller projektfiler. */
async function ensureStoragePreview(context) {
    const root = context.globalStorageUri.fsPath; // t.ex. ~/.config/.../GlobalStorage/<publisher>.<name>/
    const previewDir = path.join(root, "ai-figma-preview"); // separerad namespace i storage
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
  </head>
  <body>
    <div id="app">🚀 AI Preview – minimal yta</div>
    <script type="module" src="./main.js"></script>
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
/** Starta kandidatens preview med respektfull fallback (ingen skrivning i projektet om det går att undvika). */
async function startCandidatePreviewWithFallback(c, context) {
    const panel = currentPanel;
    // Stäng ev. tidigare server innan ny start (extra säkerhet)
    try {
        await (0, runner_1.stopDevServer)();
    }
    catch (_a) { }
    try {
        const { externalUrl } = await startOrRespectfulFallback(c, context);
        lastDevUrl = externalUrl;
        panel.webview.postMessage({ type: "devurl", url: externalUrl });
        (0, analyzeClient_1.runProjectAnalysis)(panel, (0, analyzeClient_1.buildDefaultLocalManifest)(c.dir)).catch((err) => {
            vscode.window.showWarningMessage(`Analysmisslyckande: ${(err === null || err === void 0 ? void 0 : err.message) || String(err)}`);
        });
        return;
    }
    catch (err) {
        vscode.window.showWarningMessage(`Primär preview misslyckades, försöker minimal temporär preview: ${(err === null || err === void 0 ? void 0 : err.message) || String(err)}`);
    }
    try {
        const storageDir = await ensureStoragePreview(context);
        const { externalUrl } = await (0, runner_1.runDevServer)(`npx -y http-server -p 0`, storageDir);
        lastDevUrl = externalUrl;
        panel.webview.postMessage({ type: "devurl", url: externalUrl });
        (0, analyzeClient_1.runProjectAnalysis)(panel, (0, analyzeClient_1.buildDefaultLocalManifest)(c.dir)).catch((err) => {
            vscode.window.showWarningMessage(`Analysmisslyckande: ${(err === null || err === void 0 ? void 0 : err.message) || String(err)}`);
        });
    }
    catch (e) {
        vscode.window.showErrorMessage(`Kunde inte starta ens temporär preview: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
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
    html = html.replace(/(src|href)="([^"]+)"/g, (_m, attr, value) => {
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
<title>Project Preview (fallback)</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --border: color-mix(in srgb, var(--vscode-foreground) 20%, var(--vscode-sideBar-background) 80%);
    --card: var(--vscode-editorWidget-background);
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 ui-sans-serif,system-ui; }
  .wrap { padding: 10px; }
  .mini {
    margin: 6px auto 0;
    width: 100%;
    max-width: 340px;
    height: 240px;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--card);
  }
  iframe { display:block; width:100%; height:100%; border:0; }
  .url { margin-top: 6px; opacity:.8; word-break: break-all; }
  .panel { margin-top: 12px; padding: 8px; border: 1px solid var(--border); border-radius: 10px; }
  .muted { opacity: .75; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="mini"><iframe id="preview" sandbox="allow-scripts allow-forms allow-same-origin"></iframe></div>
    <div class="url" id="info">Waiting for devurl…</div>
    <div class="panel" id="analysis">Waiting for analysis…</div>
  </div>
<script>
  const iframe = document.getElementById('preview');
  const info = document.getElementById('info');
  const analysis = document.getElementById('analysis');
  function renderStatus(s){ analysis.textContent = 'Analys: ' + (s?.status || s); }
  function renderError(msg){ analysis.innerHTML = '<span class="muted">Fel:</span> ' + (msg||'Okänt fel'); }
  function renderResult(model){
    analysis.innerHTML = '';
    const h = document.createElement('div'); h.innerHTML = '<b>Project Summary</b>';
    const p = document.createElement('pre'); p.style.whiteSpace='pre-wrap'; p.textContent = JSON.stringify({
      manager:model.manager, framework:model.framework,
      entryPoints:model.entryPoints, routing:model.routing, components:model.components?.length, injections:model.injectionPoints?.length
    }, null, 2);
    analysis.appendChild(h); analysis.appendChild(p);
  }
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg?.type === 'devurl') { iframe.src = msg.url; info.textContent = msg.url; }
    if (msg?.type === 'analysis/status') { renderStatus(msg.payload); }
    if (msg?.type === 'analysis/error') { renderError(msg.payload); }
    if (msg?.type === 'analysis/result') { renderResult(msg.payload); }
  });
</script>
</body>
</html>`;
}
/* ─────────────────────────────────────────────────────────
   Aktivering
   ───────────────────────────────────────────────────────── */
async function activate(context) {
    const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
        try {
            const candidates = await (0, detector_1.detectProjects)([]);
            if (!candidates.length) {
                vscode.window.showWarningMessage("Hittade inga kandidater (körbara frontend-projekt eller statiska mappar).");
                return;
            }
            const panel = ensurePanel(context);
            pendingCandidate = candidates[0];
            postCandidateProposal(pendingCandidate);
            panel.reveal(vscode.ViewColumn.Two);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Scan & Preview misslyckades: ${err.message}`);
        }
    });
    const openCmd = vscode.commands.registerCommand("ai-figma-codegen.openPanel", async () => {
        const panel = ensurePanel(context);
        if (!pendingCandidate) {
            const candidates = await (0, detector_1.detectProjects)([]);
            if (candidates.length) {
                pendingCandidate = candidates[0];
                postCandidateProposal(pendingCandidate);
            }
        }
        panel.reveal(vscode.ViewColumn.Two);
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
                const token = vscode.workspace.getConfiguration("aiFigmaCodegen").get("figmaToken") || undefined;
                const panel = ensurePanel(context);
                lastInitPayload = { type: "init", fileKey, nodeId, token, figmaToken: token };
                panel.webview.postMessage(lastInitPayload);
                const candidates = await (0, detector_1.detectProjects)([]);
                if (candidates.length) {
                    pendingCandidate = candidates[0];
                    postCandidateProposal(pendingCandidate);
                }
            }
            catch (e) {
                vscode.window.showErrorMessage(`URI-öppning misslyckades: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
            }
        },
    });
    context.subscriptions.push(scanCmd, openCmd, uriHandler);
}
async function deactivate() {
    // Stäng ev. aktiv dev-server när extensionen avaktiveras
    try {
        await (0, runner_1.stopDevServer)();
    }
    catch ( /* ignore */_a) { /* ignore */ }
}
//# sourceMappingURL=extension.js.map