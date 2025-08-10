import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { detectProjects, Candidate } from "./detector";
import { runDevServer } from "./runner";

// [NY] – analyspipeline
import { runProjectAnalysis, buildDefaultLocalManifest } from "./analyzeClient";

let currentPanel: vscode.WebviewPanel | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerCommand("ai-figma-codegen.scanAndPreview", async () => {
    try {
      // Exkludera extensionens egen mapp så den inte föreslås som kandidat
      const exclude = [context.extensionPath];
      const candidates = await detectProjects(exclude);

      if (!candidates.length) {
        vscode.window.showWarningMessage("Hittade inga kandidater (dev/start/serve eller index.html).");
        return;
      }

      const items = candidates.slice(0, 12).map((c) => ({
        label: c.pkgName ? `${c.pkgName}` : path.basename(c.dir),
        description: `${c.framework} • ${c.devCmd ?? "static/ephemeral"}`,
        detail: `${c.dir}`,
        candidate: c,
      }));

      const pick =
        items.length === 1
          ? items[0]
          : await vscode.window.showQuickPick(items, { placeHolder: "Välj projekt att förhandsvisa" });
      if (!pick) return;

      // Bekräfta körning om vi har ett dev-kommando
      if (pick.candidate.devCmd) {
        const ok = await vscode.window.showInformationMessage(
          `Starta dev-server:\n${pick.candidate.devCmd}\ni\n${pick.detail}?`,
          { modal: true },
          "Starta"
        );
        if (ok !== "Starta") return;
      }

      // Starta dev-server eller gå till fallback
      const { externalUrl } = await startOrFallback(pick.candidate);

      // Öppna/återanvänd webview
      if (!currentPanel) {
        currentPanel = vscode.window.createWebviewPanel(
          "aiFigmaCodegen.panel",
          "🎯 Project Preview",
          vscode.ViewColumn.Two,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            // Viktigt: tillåt lastning av filer från dist-webview
            localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))],
          }
        );
        currentPanel.onDidDispose(() => (currentPanel = undefined));
      } else {
        currentPanel.reveal(vscode.ViewColumn.Two);
      }

      // Ladda din byggda webview (dist-webview/index.html) och injicera CSP
      currentPanel.webview.html = getWebviewHtml(context, currentPanel.webview);

      // Skicka dev-URL till webview (din React-webview lyssnar på window.message)
      currentPanel.webview.postMessage({ type: "devurl", url: externalUrl });

      // [NY] Starta analysen för vald projektrot (local_paths-läge)
      // Skickar status/resultat till webview via postMessage (analysis/*)
      runProjectAnalysis(currentPanel, buildDefaultLocalManifest(pick.candidate.dir)).catch((err) => {
        vscode.window.showWarningMessage(`Analysmisslyckande: ${err?.message || String(err)}`);
      });

      vscode.window.showInformationMessage(`Preview igång: ${externalUrl}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Scan & Preview misslyckades: ${err.message}`);
    }
  });

  context.subscriptions.push(cmd);
}

export function deactivate() {}

/** Försök starta dev-server; om devCmd saknas – försök ephemeral Vite eller static server */
async function startOrFallback(c: Candidate): Promise<{ externalUrl: string }> {
  // 1) dev-script
  if (c.devCmd) {
    const { externalUrl } = await runDevServer(c.devCmd, c.dir);
    return { externalUrl };
  }

  // 2) Ephemeral Vite om index.html verkar använda ES-moduler
  const indexPath = fs.existsSync(path.join(c.dir, "index.html"))
    ? path.join(c.dir, "index.html")
    : path.join(c.dir, "public", "index.html");

  let usesModules = false;
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, "utf8");
    usesModules =
      /type\s*=\s*["']module["']/.test(html) || /<script[^>]+src="\/?src\//.test(html);
  }

  if (usesModules) {
    // Kräver vite via npx (hämtas automatiskt om ej lokalt installerat)
    const { externalUrl } = await runDevServer(`npx -y vite`, c.dir);
    return { externalUrl };
  }

  // 3) Enkel static server (dev-läge). Alternativ: "python -m http.server 5500"
  const { externalUrl } = await runDevServer(`npx -y http-server -p 5500`, c.dir);
  return { externalUrl };
}

/** Läs dist-webview/index.html, reskriv asset-URL:er och injicera CSP för iframe (localhost) */
function getWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): string {
  const distDir = path.join(context.extensionPath, "dist-webview");
  const htmlPath = path.join(distDir, "index.html");

  let html = "";
  try {
    html = fs.readFileSync(htmlPath, "utf8");
  } catch (e) {
    // Fallback – minimal HTML om build saknas
    return basicFallbackHtml(webview);
  }

  // Reskriv lokala src/href till webview-resurser
  html = html.replace(/(src|href)="([^"]+)"/g, (_m, attr, value) => {
    // Hoppa över absoluta URL:er (http/https), data: och inlined anchors
    if (/^(https?:)?\/\//.test(value) || value.startsWith("data:") || value.startsWith("#")) {
      return `${attr}="${value}"`;
    }
    const cleaned = value.replace(/^\/+/, "").replace(/^\.\//, "");
    const onDisk = vscode.Uri.file(path.join(distDir, cleaned));
    const asWebview = webview.asWebviewUri(onDisk);
    return `${attr}="${asWebview}"`;
  });

  // Injektera CSP så webview tillåter iframes samt anslutningar till backend
  const cspSource = webview.cspSource;
  html = html.replace(
    "<head>",
    `<head>
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src https: data:;
  style-src 'unsafe-inline' ${cspSource};
  script-src ${cspSource};
  connect-src ${cspSource} http://localhost:* https://api.figma.com http://localhost:8000;
  frame-src http://localhost:* https://*;
">
`
  );

  return html;
}

/** Minimal fallback HTML om dist-webview saknas vid utveckling */
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
  connect-src ${cspSource} http://localhost:* https://api.figma.com http://localhost:8000;
  frame-src http://localhost:* https://*;">
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
