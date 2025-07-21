/* --------------------------------------------------------------------------
 * VS Code-extension: AI Figma Codegen
 * -------------------------------------------------------------------------- */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as url from "node:url";
import * as dotenv from "dotenv";
dotenv.config(); // läser .env vid uppstart

/* -------- Konstanter -------- */
const VIEW_TYPE = "aiFigmaCodegen.panel";
const BACKEND_URL = "http://localhost:8000/figma-hook";
const FIGMA_TOKEN = process.env.AI_FIGMA_TOKEN; // token från .env

let currentPanel: vscode.WebviewPanel | undefined;

/* -------------------------------------------------------------------------- */
/* 1. Starta Celery-task i backend                                           */
/* -------------------------------------------------------------------------- */
async function startTask(fileKey: string, nodeId: string): Promise<string> {
  const res = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileKey, nodeId }),
  });
  if (!res.ok) {
    throw new Error(`Backend error ${res.status}: ${await res.text()}`);
  }
  const { task_id } = (await res.json()) as { task_id: string };
  return task_id;
}

/* -------------------------------------------------------------------------- */
/* 2. Hämta PNG-preview från Figma                                            */
/* -------------------------------------------------------------------------- */
async function getPreviewUrl(
  fileKey: string,
  nodeId: string,
): Promise<string | undefined> {
  if (!FIGMA_TOKEN) return undefined;

  const api =
    `https://api.figma.com/v1/images/${fileKey}` +
    `?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`;

  try {
    const res = await fetch(api, { headers: { "X-Figma-Token": FIGMA_TOKEN } });
    const json = (await res.json()) as { images?: Record<string, string> };
    return json.images?.[nodeId];
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Skapa eller fokusera sidopanelen                                        */
/* -------------------------------------------------------------------------- */
async function showAiPanel(
  context: vscode.ExtensionContext,
  fileKey: string,
  nodeId: string,
) {
  /* 3.1 starta Celery-tasken */
  let taskId = "unknown";
  try {
    taskId = await startTask(fileKey, nodeId);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Kunde inte starta AI-pipen: ${(err as Error).message}`,
    );
    return;
  }

  /* 3.2 hämta Figma-preview (kan vara undefined) */
  const previewUrl = await getPreviewUrl(fileKey, nodeId);

  /* 3.3 skapa/fokusera panel */
  if (!currentPanel) {
    currentPanel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "AI Figma Codegen",
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    currentPanel.onDidDispose(
      () => (currentPanel = undefined),
      null,
      context.subscriptions,
    );

    /* ta emot meddelanden från webview (chat/öppna PR …) */
    currentPanel.webview.onDidReceiveMessage((msg) => {
      if (msg.cmd === "openPR") {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.cmd === "chat") {
        vscode.window.showInformationMessage(
          `Chat-instruktion skickad: ${msg.text}`,
        );
      }
    });
  } else {
    currentPanel.reveal(vscode.ViewColumn.Two);
  }

  /* 3.4 ladda HTML */
  currentPanel.webview.html = getHtml(
    currentPanel.webview,
    context.extensionUri,
    previewUrl,
    fileKey,
    nodeId,
  );

  /* 3.5 skicka init-data */
  currentPanel.webview.postMessage({ type: "init", taskId });
}

/* -------------------------------------------------------------------------- */
/* 4. Bygg webview-HTML (enkel PNG-preview)                                   */
/* -------------------------------------------------------------------------- */
function getHtml(
  webview: vscode.Webview,
  extUri: vscode.Uri,
  imageUrl: string | undefined,
  fileKey: string,
  nodeId: string,
): string {
  return /* html */ `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 img-src https: data:;
                 style-src 'unsafe-inline';
                 script-src 'unsafe-inline';">
  <style>
    body{margin:0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;height:100%}
    .hdr{padding:12px 16px;border-bottom:1px solid #eee;font-size:13px}
    .pvw{flex:1;display:flex;align-items:center;justify-content:center}
    img{max-width:90%;max-height:90%;border:1px solid #ccc;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.05)}
  </style>
</head>
<body>
  <div class="hdr">
    <strong>fileKey:</strong> ${fileKey}&nbsp;&nbsp;
    <strong>nodeId:</strong> ${nodeId}
  </div>
  <div class="pvw">
    ${
      imageUrl
        ? `<img src="${imageUrl}" />`
        : "<p style='color:#e5534b'>Ingen förhandsvisning (token saknas eller fetch-fel).</p>"
    }
  </div>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* 5. Extension-livscykel                                                     */
/* -------------------------------------------------------------------------- */
export function activate(context: vscode.ExtensionContext) {
  /* testkommando */
  context.subscriptions.push(
    vscode.commands.registerCommand("ai-figma-codegen.openPanel", () =>
      showAiPanel(context, "demoFileKey", "demoNodeId"),
    ),
  );

  /* URI-handler från Figma-pluginen */
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        const pathPart = uri.path.replace(/^\/+/, "");
        if (pathPart !== "figma") {
          vscode.window.showWarningMessage(`Okänt uri-path '${uri.path}'.`);
          return;
        }
        const qs = new URLSearchParams(uri.query);
        const fileKey = qs.get("fileKey") ?? "unknown-file";
        const nodeId = qs.get("nodeId") ?? "unknown-node";
        await showAiPanel(context, fileKey, nodeId);
      },
    }),
  );
}

export function deactivate() {
  /* inget särskilt */
}
