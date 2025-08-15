// extension/src/extension.ts
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { detectProjects, Candidate } from "./detector";
import { runDevServer, stopDevServer, runInlineStaticServer } from "./runner";
import { runProjectAnalysis, buildDefaultLocalManifest } from "./analyzeClient";

let currentPanel: vscode.WebviewPanel | undefined;

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

/* ─────────────────────────────────────────────────────────
   Panel och meddelandehantering
   ───────────────────────────────────────────────────────── */
function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (!currentPanel) {
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
      currentPanel = undefined;
      lastDevUrl = null;
      lastInitPayload = null;
      pendingCandidate = null;
      // Stäng ev. aktiv dev-server när panelen stängs
      stopDevServer().catch(() => {});
    });

    currentPanel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg?.type === "ready") {
        if (lastInitPayload) currentPanel!.webview.postMessage(lastInitPayload);
        if (lastDevUrl) currentPanel!.webview.postMessage({ type: "devurl", url: lastDevUrl });
        if (pendingCandidate) postCandidateProposal(pendingCandidate);
        return;
      }

      if (msg?.cmd === "acceptCandidate") {
        if (!pendingCandidate) return;
        await startCandidatePreviewWithFallback(pendingCandidate, context);
        return;
      }

      if (msg?.cmd === "openPR" && typeof msg.url === "string") {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      }

      if (msg?.cmd === "chat" && typeof msg.text === "string") {
        console.log("[ai-figma-codegen/chat]", msg.text);
        return;
      }
    });

    currentPanel.webview.html = getWebviewHtml(context, currentPanel.webview);
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
  if (!raw) return undefined;

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
async function findExistingHtml(c: Candidate): Promise<{ relHtml: string; root: string } | null> {
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

function normalizeRel(rel: string): string {
  return rel.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Försök starta dev-server; om saknas → serva befintlig HTML; annars sista utväg: extern minimal preview. */
async function startOrRespectfulFallback(c: Candidate, context: vscode.ExtensionContext): Promise<{ externalUrl: string }> {
  // 1) Dev-script
  const cmd = selectLaunchCommand(c);
  if (cmd) {
    const { externalUrl } = await runDevServer(cmd, c.dir);
    return { externalUrl };
  }

  // 2) Respektera befintlig HTML (ingen skrivning i projektet)
  const html = await findExistingHtml(c);
  if (html) {
    // Kör http-server i projektroten och länka direkt till HTML:en (alltid ledig port)
    const { externalUrl } = await runDevServer(`npx -y http-server -p 0`, html.root);
    const base = externalUrl.endsWith("/") ? externalUrl : externalUrl + "/";
    return { externalUrl: base + encodeURI(html.relHtml) };
  }

  // 3) Sista utväg: skapa minimal preview i extensionens storage (inte i projektet)
  const storageDir = await ensureStoragePreview(context);
  const { externalUrl } = await runDevServer(`npx -y http-server -p 0`, storageDir);
  return { externalUrl };
}

/** Skapa en minimal *extern* (icke-invasiv) preview i extensionens globalStorage.
 *  Endast index.html + main.js, inga .json eller projektfiler. */
async function ensureStoragePreview(context: vscode.ExtensionContext): Promise<string> {
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
async function startCandidatePreviewWithFallback(c: Candidate, context: vscode.ExtensionContext) {
  const panel = currentPanel!;
  // 0) Visa omedelbar placeholder
  const storageDir = await ensureStoragePreview(context);
  const placeholder = await runInlineStaticServer(storageDir);
  lastDevUrl = placeholder.externalUrl;
  panel.webview.postMessage({ type: "devurl", url: placeholder.externalUrl });

  // 1) Starta riktiga previewn i bakgrunden (ingen await före första paint)
  (async () => {
    try {
      const { externalUrl } = await startOrRespectfulFallback(c, context);
      lastDevUrl = externalUrl;
      panel.webview.postMessage({ type: "devurl", url: externalUrl });
      // stäng placeholdern när vi bytt
      await placeholder.stop();

      runProjectAnalysis(panel, buildDefaultLocalManifest(c.dir)).catch((err) => {
        vscode.window.showWarningMessage(`Analysmisslyckande: ${err?.message || String(err)}`);
      });
    } catch (err: any) {
      vscode.window.showWarningMessage(
        `Primär preview misslyckades, behåller temporär preview: ${err?.message || String(err)}`
      );
      // placeholdern får ligga kvar
    }
  })();
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
export async function activate(context: vscode.ExtensionContext) {
  const scanCmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
    try {
      const candidates = await detectProjects([]);
      if (!candidates.length) {
        vscode.window.showWarningMessage("Hittade inga kandidater (körbara frontend-projekt eller statiska mappar).");
        return;
      }
      const panel = ensurePanel(context);
      pendingCandidate = candidates[0];
      postCandidateProposal(pendingCandidate);
      panel.reveal(vscode.ViewColumn.Two);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Scan & Preview misslyckades: ${err.message}`);
    }
  });

  const openCmd = vscode.commands.registerCommand("ai-figma-codegen.openPanel", async () => {
    const panel = ensurePanel(context);
    if (!pendingCandidate) {
      const candidates = await detectProjects([]);
      if (candidates.length) {
        pendingCandidate = candidates[0];
        postCandidateProposal(pendingCandidate);
      }
    }
    panel.reveal(vscode.ViewColumn.Two);
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
          vscode.workspace.getConfiguration("aiFigmaCodegen").get<string>("figmaToken") || undefined;

        const panel = ensurePanel(context);
        lastInitPayload = { type: "init", fileKey, nodeId, token, figmaToken: token };
        panel.webview.postMessage(lastInitPayload);

        const candidates = await detectProjects([]);
        if (candidates.length) {
          pendingCandidate = candidates[0];
          postCandidateProposal(pendingCandidate);
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`URI-öppning misslyckades: ${e?.message || String(e)}`);
      }
    },
  });

  context.subscriptions.push(scanCmd, openCmd, uriHandler);
}

export async function deactivate() {
  // Stäng ev. aktiv dev-server när extensionen avaktiveras
  try { await stopDevServer(); } catch { /* ignore */ }
}
