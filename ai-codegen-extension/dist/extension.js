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
/* ─────────────────────────────────────────────────────────
   Hjälpare
   ───────────────────────────────────────────────────────── */
/** Snabb HEAD-koll om en extern URL verkligen svarar (200..399). */
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
/** Normalisera dev-kommandon till port 0 (ephemeral) för kända CLIs. */
function normalizeDevCmdPorts(raw) {
    let cmd = raw;
    // next
    if (/\bnext\s+dev\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    // vite
    if (/\bvite(\s+dev)?\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    // astro
    if (/\bastro\s+dev\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    // remix
    if (/\bremix\s+dev\b/.test(cmd) && !/\s(--port|-p)\s+\d+/.test(cmd))
        cmd += " --port 0";
    // solid-start
    if (/\bsolid-start\s+dev\b/.test(cmd) && !/\s(--port|-p)\s+\d+/.test(cmd))
        cmd += " --port 0";
    // nuxt
    if (/\bnuxi\s+dev\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    // webpack dev server
    if (/\bwebpack\s+serve\b/.test(cmd) && !/\s(--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    // storybook
    if (/\bstorybook\b/.test(cmd) && !/\s(-p|--port)\s+\d+/.test(cmd))
        cmd += " --port 0";
    return cmd;
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
                    log("Skickar cached init-payload till webview.");
                    currentPanel.webview.postMessage(lastInitPayload);
                }
                if (lastDevUrl) {
                    log("Skickar cached devurl till webview:", lastDevUrl);
                    currentPanel.webview.postMessage({ type: "devurl", url: lastDevUrl });
                }
                if (pendingCandidate)
                    postCandidateProposal(pendingCandidate);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "acceptCandidate") {
                if (!pendingCandidate) {
                    warn("acceptCandidate utan pendingCandidate – ignorerar.");
                    return;
                }
                await startCandidatePreviewWithFallback(pendingCandidate, context);
                return;
            }
            // 🔹 NYTT: manuell projektväljare från webview
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "chooseProject") {
                await showProjectQuickPick(context);
                return;
            }
            if ((msg === null || msg === void 0 ? void 0 : msg.cmd) === "openPR" && typeof msg.url === "string") {
                log("Öppnar PR i extern webbläsare:", msg.url);
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
        log("Revealar befintlig panel.");
        currentPanel.reveal(vscode.ViewColumn.Two);
    }
    return currentPanel;
}
function postCandidateProposal(c) {
    var _a, _b, _d;
    if (!currentPanel)
        return;
    const label = c.pkgName ? c.pkgName : path.basename(c.dir);
    const launchCmd = selectLaunchCommand(c);
    const description = `${c.framework} • ${(_d = launchCmd !== null && launchCmd !== void 0 ? launchCmd : (_b = (_a = c.runCandidates) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.cmd) !== null && _d !== void 0 ? _d : "auto"}`;
    log("Föreslår kandidat till webview:", { label, description, dir: c.dir, launchCmd });
    currentPanel.webview.postMessage({
        type: "candidate-proposal",
        payload: { label, description, dir: c.dir, launchCmd: launchCmd !== null && launchCmd !== void 0 ? launchCmd : undefined },
    });
}
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
    // Normalisera ev. http-server-kommandon till ephemeral port
    if (/\bhttp-server\b/i.test(raw)) {
        let patched = raw
            .replace(/\s--port\s+\d+/i, " --port 0")
            .replace(/\s-p\s+\d+/i, " -p 0");
        if (!/(\s--port|\s-p)\s+\d+/i.test(patched)) {
            patched += " -p 0";
        }
        log("Launch-kommandot normaliserat (http-server) →", patched);
        return patched;
    }
    const norm = normalizeDevCmdPorts(raw);
    if (norm !== raw)
        log("Port-normaliserat dev-kommando:", norm);
    else
        log("Launch-kommandot valt:", raw);
    return norm;
}
/** Sök bästa befintliga HTML att visa utan skrivning i projektet. */
async function findExistingHtml(c) {
    if (c.entryHtml) {
        log("entryHtml angiven av detector:", c.entryHtml);
        return { relHtml: normalizeRel(c.entryHtml), root: c.dir };
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
            log("Hittade befintlig HTML:", p);
            return { relHtml: normalizeRel(rel), root: c.dir };
        }
    }
    log("Ingen befintlig HTML hittades i:", c.dir);
    return null;
}
function normalizeRel(rel) {
    return rel.replace(/^\.\//, "").replace(/^\/+/, "");
}
/** Försök starta dev-server; om saknas/misslyckas → statisk HTML → storage-preview. */
async function startOrRespectfulFallback(c, context) {
    // 1) Dev-script (med robust fallback om start misslyckas)
    const cmd = selectLaunchCommand(c);
    if (cmd) {
        try {
            log("Försöker starta dev-server:", { cmd, cwd: c.dir });
            const { externalUrl } = await (0, runner_1.runDevServer)(cmd, c.dir);
            // http-server: styr iframen mot faktisk HTML-fil (inte "/")
            if (/\bhttp-server\b/i.test(cmd)) {
                const html = await findExistingHtml(c);
                if (html) {
                    const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
                    const url = base + encodeURI(html.relHtml);
                    log("Dev-server OK (http-server) – dirigerar till:", url);
                    return { externalUrl: url };
                }
                log("Dev-server OK men ingen HTML hittades – använder bas-URL:", externalUrl);
                return { externalUrl };
            }
            // Övriga: om "/" inte svarar men vi vet entryHtml → styra dit
            try {
                const ok = await headExists(externalUrl);
                if (!ok && c.entryHtml) {
                    const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
                    const url = base + encodeURI(normalizeRel(c.entryHtml));
                    log("Bas-URL svarade inte – dirigerar till entryHtml:", url);
                    return { externalUrl: url };
                }
            }
            catch ( /* ignore */_a) { /* ignore */ }
            log("Dev-server OK – använder URL:", externalUrl);
            return { externalUrl };
        }
        catch (e) {
            errlog("Dev-server start misslyckades:", (e === null || e === void 0 ? void 0 : e.message) || e);
            // Fortsätt till HTML/preview-fallback nedan
        }
    }
    // 2) Respektera befintlig HTML via inline statisk server
    const html = await findExistingHtml(c);
    if (html) {
        log("Startar inline statisk server för befintlig HTML:", html);
        const { externalUrl } = await (0, runner_1.runInlineStaticServer)(html.root);
        const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
        return { externalUrl: base + encodeURI(html.relHtml) };
    }
    // 3) Sista utväg: storage-preview via inline-server (icke-invasiv)
    const storageDir = await ensureStoragePreview(context);
    log("Ingen dev-server/HTML – startar inline server för storage-preview:", storageDir);
    const { externalUrl } = await (0, runner_1.runInlineStaticServer)(storageDir);
    return { externalUrl };
}
/** Skapa en minimal *extern* (icke-invasiv) preview i extensionens globalStorage. */
async function ensureStoragePreview(context) {
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
        console.log('[ai-figma-codegen/webview]', 'recv', msg?.type || msg?.cmd || msg);
        if (msg?.type === 'devurl') { iframe.src = msg.url; info.textContent = msg.url; }
        if (msg?.type === 'candidate-proposal' && msg?.payload) {
          const { label, description, dir } = msg.payload;
          pLabel.textContent = label;
          pDesc.textContent = description || '';
          pDir.textContent = dir || '';
          proposal.style.display = 'grid';
        }
      });

      // Berätta för extensionen att vi är redo att ta emot state
      vscode.postMessage({ type: 'ready' });
    </script>
  </body>
</html>`;
        await fsp.writeFile(indexPath, html, "utf8");
        log("Skrev storage index.html:", indexPath);
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
        log("Skrev storage main.js:", mainPath);
    }
    return previewDir;
}
/** Starta kandidatens preview: placeholder via inline-server → byt när redo. */
async function startCandidatePreviewWithFallback(c, context) {
    const panel = ensurePanel(context);
    // 🔹 Städa ev. pågående servrar innan ny start
    try {
        await (0, runner_1.stopDevServer)();
    }
    catch ( /* ignore */_a) { /* ignore */ }
    try {
        await (0, runner_1.stopInlineServer)();
    }
    catch ( /* ignore */_b) { /* ignore */ }
    // 1) Omedelbar placeholder via storage + inline-server
    const storageDir = await ensureStoragePreview(context);
    const placeholder = await (0, runner_1.runInlineStaticServer)(storageDir);
    lastDevUrl = placeholder.externalUrl;
    log("Placeholder inline-server startad:", lastDevUrl);
    panel.webview.postMessage({ type: "devurl", url: placeholder.externalUrl });
    // 2) Starta riktiga previewn och byt när redo
    (async () => {
        try {
            const { externalUrl } = await startOrRespectfulFallback(c, context);
            lastDevUrl = externalUrl;
            log("Primär preview tillgänglig – uppdaterar webview:", externalUrl);
            panel.webview.postMessage({ type: "devurl", url: externalUrl });
            try {
                await placeholder.stop();
                log("Placeholder inline-server stoppad.");
            }
            catch (e) {
                warn("Kunde inte stoppa placeholder-server:", e);
            }
        }
        catch (err) {
            errlog("Primär preview misslyckades, behåller temporär preview:", (err === null || err === void 0 ? void 0 : err.message) || String(err));
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
            log("QuickPick: saknar cache – söker kandidater …");
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
    if (!chosen) {
        log("QuickPick: inget val gjort.");
        return;
    }
    pendingCandidate = chosen._c;
    postCandidateProposal(pendingCandidate);
    await startCandidatePreviewWithFallback(pendingCandidate, context);
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
        log("Läste dist-webview/index.html.");
    }
    catch (e) {
        warn("Saknar dist-webview/index.html – använder fallback HTML.", e);
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
<title>Project Preview (fallback)</title>
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --fg: var(--vscode-foreground);
    --border: color-mix(in srgb, var(--vscode-foreground) 20%, var(--vscode-sideBar-background) 80%);
    --card: var(--vscode-editorWidget-background);
    --muted: color-mix(in srgb, var(--vscode-foreground) 65%, var(--vscode-sideBar-background) 35%);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: color-mix(in srgb, var(--vscode-button-background) 85%, black 15%);
  }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 ui-sans-serif,system-ui; }
  .wrap { padding: 10px; display: grid; gap: 10px; }
  .bar {
    display:flex; align-items:center; gap:8px; padding:8px 10px;
    border:1px solid var(--border); border-radius:10px; background: var(--card);
  }
  .grow { flex:1; min-width:0; }
  .btn {
    appearance:none; border:0; border-radius:8px; padding:6px 10px;
    background: var(--btn-bg); color: var(--btn-fg); cursor:pointer; font: inherit;
  }
  .btn:hover { background: var(--btn-hover); }
  .mini {
    width: 100%; height: 240px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--card);
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
        <div class="url" id="info">Waiting for devurl…</div>
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
    console.log('[ai-figma-codegen/webview]', 'recv', msg?.type || msg?.cmd || msg);
    if (msg?.type === 'devurl') { iframe.src = msg.url; info.textContent = msg.url; }
    if (msg?.type === 'candidate-proposal' && msg?.payload) {
      const { label, description, dir } = msg.payload;
      pLabel.textContent = label;
      pDesc.textContent = description || '';
      pDir.textContent = dir || '';
      proposal.style.display = 'grid';
    }
  });

  // Signalera att webview är redo (så extensionen kan skicka cache)
  window.addEventListener('load', () => vscode.postMessage({ type: 'ready' }));
</script>
</body>
</html>`;
}
/* ─────────────────────────────────────────────────────────
   Aktivering
   ───────────────────────────────────────────────────────── */
async function activate(context) {
    log("Aktiverar extension …");
    // 🔹 Statusrads-knapp för snabb åtkomst till manuell projektväljare
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.text = "$(rocket) Preview";
    statusItem.tooltip = "Välj projekt för förhandsvisning";
    statusItem.command = "ai-figma-codegen.chooseProject";
    statusItem.show();
    context.subscriptions.push(statusItem);
    const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
        var _a;
        try {
            log("scanAndPreview: söker kandidater …");
            const candidates = await (0, detector_1.detectProjects)([]);
            lastCandidates = candidates; // cache
            log("scanAndPreview: hittade kandidater:", (candidates === null || candidates === void 0 ? void 0 : candidates.length) || 0);
            if (!candidates.length) {
                vscode.window.showWarningMessage("Hittade inga kandidater (körbara frontend-projekt eller statiska mappar).");
                return;
            }
            const panel = ensurePanel(context);
            pendingCandidate = candidates[0];
            postCandidateProposal(pendingCandidate);
            panel.reveal(vscode.ViewColumn.Two);
            // Auto-start om ensam kandidat eller mycket hög poäng
            if (candidates.length === 1 || ((_a = pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.confidence) !== null && _a !== void 0 ? _a : 0) >= AUTO_START_SURE_THRESHOLD) {
                log("Auto-startar toppkandidat:", pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.dir);
                await startCandidatePreviewWithFallback(pendingCandidate, context);
            }
            else {
                const pickNow = "Välj projekt…";
                const startTop = "Starta föreslagen";
                const choice = await vscode.window.showInformationMessage("Flera kandidater hittades. Vill du välja manuellt eller starta föreslagen?", pickNow, startTop);
                if (choice === pickNow) {
                    await showProjectQuickPick(context);
                }
                else if (choice === startTop) {
                    await startCandidatePreviewWithFallback(pendingCandidate, context);
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
        log("openPanel: öppnar/hämtar panel …");
        const panel = ensurePanel(context);
        if (!pendingCandidate) {
            const candidates = await (0, detector_1.detectProjects)([]);
            lastCandidates = candidates; // cache
            if (candidates.length) {
                log("openPanel: sätter pendingCandidate från detektor.");
                pendingCandidate = candidates[0];
                postCandidateProposal(pendingCandidate);
                if (candidates.length === 1 || ((_a = pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.confidence) !== null && _a !== void 0 ? _a : 0) >= AUTO_START_SURE_THRESHOLD) {
                    log("Auto-startar toppkandidat (openPanel):", pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.dir);
                    await startCandidatePreviewWithFallback(pendingCandidate, context);
                }
            }
            else {
                warn("openPanel: inga kandidater hittades.");
            }
        }
        panel.reveal(vscode.ViewColumn.Two);
    });
    // 🔹 Kommando – öppna manuell projektväljare
    const chooseCmd = vscode.commands.registerCommand("ai-figma-codegen.chooseProject", async () => {
        await showProjectQuickPick(context);
    });
    const uriHandler = vscode.window.registerUriHandler({
        handleUri: async (uri) => {
            var _a;
            try {
                log("URI-handler:", uri.toString());
                const params = new URLSearchParams(uri.query);
                const fileKey = params.get("fileKey") || "";
                const nodeId = params.get("nodeId") || "";
                log("URI params:", { fileKey, nodeId });
                if (!fileKey || !nodeId) {
                    vscode.window.showErrorMessage("Saknar fileKey eller nodeId i URI.");
                    return;
                }
                const token = vscode.workspace.getConfiguration("aiFigmaCodegen").get("figmaToken") || undefined;
                const panel = ensurePanel(context);
                lastInitPayload = { type: "init", fileKey, nodeId, token, figmaToken: token };
                log("Skickar init-payload till webview.");
                panel.webview.postMessage(lastInitPayload);
                const candidates = await (0, detector_1.detectProjects)([]);
                lastCandidates = candidates; // cache
                log("URI-handler: hittade kandidater:", candidates.length);
                if (candidates.length) {
                    pendingCandidate = candidates[0];
                    postCandidateProposal(pendingCandidate);
                    if (candidates.length === 1 || ((_a = pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.confidence) !== null && _a !== void 0 ? _a : 0) >= AUTO_START_SURE_THRESHOLD) {
                        log("Auto-startar toppkandidat (URI-handler):", pendingCandidate === null || pendingCandidate === void 0 ? void 0 : pendingCandidate.dir);
                        await startCandidatePreviewWithFallback(pendingCandidate, context);
                    }
                }
            }
            catch (e) {
                errlog("URI-öppning misslyckades:", (e === null || e === void 0 ? void 0 : e.message) || String(e));
                vscode.window.showErrorMessage(`URI-öppning misslyckades: ${(e === null || e === void 0 ? void 0 : e.message) || String(e)}`);
            }
        },
    });
    context.subscriptions.push(scanCmd, openCmd, chooseCmd, uriHandler);
    log("Extension aktiverad.");
}
async function deactivate() {
    log("Avaktiverar extension – stänger ev. servrar …");
    try {
        await (0, runner_1.stopDevServer)();
        log("stopDevServer OK.");
    }
    catch (e) {
        warn("stopDevServer fel:", e);
    }
    try {
        await (0, runner_1.stopInlineServer)();
        log("stopInlineServer OK.");
    }
    catch (e) {
        warn("stopInlineServer fel:", e);
    }
}
//# sourceMappingURL=extension.js.map