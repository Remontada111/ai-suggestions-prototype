/* --------------------------------------------------------------------------
 * VS Code-extension: AI Figma Codegen – v3 (förenklad och robust)
 * -------------------------------------------------------------------------- */
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
console.log("🔌 Extension activate laddas");

/* -------- Konstanter -------- */
const VIEW_TYPE   = "aiFigmaCodegen.panel";
const BACKEND_URL = "http://localhost:8000/figma-hook";
const FIGMA_TOKEN = process.env.AI_FIGMA_TOKEN;
console.log("🔑 FIGMA_TOKEN:", FIGMA_TOKEN ? "[redigerat]" : "saknas!");

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * Läser in `dist-webview/index.html` och rewritar
 * alla lokala asset-länkar till webview-URIs.
 */
function getWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): string {
  const distDir  = path.join(context.extensionPath, "dist-webview");
  const htmlPath = path.join(distDir, "index.html");
  let html       = fs.readFileSync(htmlPath, "utf8");

  // Ersätt varje src/href som inte är absolut URL mot webview URI
  html = html.replace(/(src|href)="([^"]+)"/g, (_m, attr, value) => {
    if (/^(https?:)?\/\//.test(value)) {
      // Låt externa länkar vara som de är
      return `${attr}="${value}"`;
    }
    // Ta bort inledande "/" eller "./"
    const cleaned = value.replace(/^\/+/, "").replace(/^\.\//, "");
    const assetOnDisk = vscode.Uri.file(path.join(distDir, cleaned));
    const webviewUri  = webview.asWebviewUri(assetOnDisk);
    return `${attr}="${webviewUri}"`;
  });

  // Lägg på en CSP som tillåter scripts och inline-styles från webview-cspSource
  const cspSource = webview.cspSource;
  html = html.replace(
    "<head>",
    `<head>
      <meta http-equiv="Content-Security-Policy"
            content="default-src 'none';
                     img-src https: data:;
                     style-src 'unsafe-inline' ${cspSource};
                     script-src ${cspSource};">`
  );

  return html;
}

async function startTask(fileKey: string, nodeId: string): Promise<string> {
  console.log("🚀 startTask: initierar backend med", { fileKey, nodeId });
  const res = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileKey, nodeId }),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("❌ startTask: backend error", res.status, txt);
    throw new Error(`Backend error ${res.status}: ${txt}`);
  }
  const { task_id } = (await res.json()) as { task_id: string };
  console.log("✅ startTask: fick task_id", task_id);
  return task_id;
}

async function showPanel(
  context: vscode.ExtensionContext,
  fileKey: string,
  nodeId: string
) {
  console.log("🔍 showPanel: uppstart för", { fileKey, nodeId });

  // 1) Starta AI-pipen (backend task)
  let taskId: string;
  try {
    taskId = await startTask(fileKey, nodeId);
  } catch (err) {
    vscode.window.showErrorMessage(`AI‑pipen startade ej: ${(err as Error).message}`);
    return;
  }

  // 2) Skapa eller återanvänd webviewpanel
  if (!currentPanel) {
    console.log("🆕 showPanel: skapar ny WebviewPanel");
    currentPanel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "🎨 Figma → VS Code",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, "dist-webview"))
        ]
      }
    );
    currentPanel.onDidDispose(() => (currentPanel = undefined));
  } else {
    console.log("🔄 showPanel: återanvänder befintlig panel");
    currentPanel.reveal(vscode.ViewColumn.Two);
  }

  // 3) Injicera HTML + bundlade assets (alltid, även vid återanvändning)
  currentPanel.webview.html = getWebviewHtml(context, currentPanel.webview);

  // 4) Lyssna på meddelanden från webview
  currentPanel.webview.onDidReceiveMessage((msg) => {
    console.log("📩 Meddelande från webview:", msg);
    if (msg.cmd === "openPR") {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }
    if (msg.cmd === "chat") {
      vscode.window.showInformationMessage(`Chat: ${msg.text}`);
    }
  });

  // 5) Skicka init-meddelande med token, fileKey, nodeId och taskId
  currentPanel.webview.postMessage({
    type:   "init",
    fileKey,
    nodeId,
    taskId,
    token: FIGMA_TOKEN
  });
}

export function activate(context: vscode.ExtensionContext) {
  console.log("🔌 activate: registrerar kommandon och URI-handler");
  context.subscriptions.push(
    vscode.commands.registerCommand("ai-figma-codegen.openPanel", () => {
      showPanel(context, "demoFileKey", "demoNodeId");
    })
  );
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        console.log("🌐 URI mottagen:", uri.toString());
        const params = new URLSearchParams(uri.query);
        const fileKey = params.get("fileKey") || "";
        const nodeId  = params.get("nodeId")  || "";
        if (!fileKey || !nodeId) {
          vscode.window.showErrorMessage("URI saknar fileKey eller nodeId");
          return;
        }
        await showPanel(context, fileKey, nodeId);
      }
    })
  );
  console.log("✅ activate: klar");
}

export function deactivate() {
  console.log("🔌 deactivate: extension stängs ner");
}

