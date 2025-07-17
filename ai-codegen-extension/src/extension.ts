/* --------------------------------------------------------------------------
 * VS Code-extension: AI Figma Codegen
 * -------------------------------------------------------------------------- */
import * as vscode from "vscode";
import * as path from "node:path";

/* --------- Konstanter --------- */
const VIEW_TYPE = "aiFigmaCodegen.panel";
const BACKEND_URL = "http://localhost:8000/figma-hook";

/* Håller aktuell panel så vi kan återanvända den */
let currentPanel: vscode.WebviewPanel | undefined;

/* --------------------------------------------------------------------------
 * Hjälpfunktion: starta Celery-tasken och få taskId
 * -------------------------------------------------------------------------- */
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

/* --------------------------------------------------------------------------
 * Skapar eller fokuserar panelen
 * -------------------------------------------------------------------------- */
async function showAiPanel(
  context: vscode.ExtensionContext,
  fileKey: string,
  nodeId: string,
) {
  /* 1. Starta Celery-tasken */
  let taskId = "unknown";
  try {
    taskId = await startTask(fileKey, nodeId);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Kunde inte starta AI-pipen: ${(err as Error).message}`,
    );
    return;
  }

  /* 2. Återanvänd befintlig panel eller skapa ny */
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Two);
  } else {
    currentPanel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "AI Figma Codegen",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    /* Rensa referensen när panelen stängs */
    currentPanel.onDidDispose(
      () => {
        currentPanel = undefined;
      },
      null,
      context.subscriptions,
    );

    /* Lyssna på meddelanden från webviewen */
    currentPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.cmd === "openPR") {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.cmd === "chat") {
        // TODO: skicka msg.text till backend/chat-endpoint vid steg 4
        vscode.window.showInformationMessage(`Chat-instruktion skickad: ${msg.text}`);
      }
    });
  }

  /* 3. Ladda HTML */
  currentPanel.webview.html = getHtml(
    currentPanel.webview,
    context.extensionUri,
  );

  /* 4. Skicka init-data till webviewen */
  currentPanel.webview.postMessage({ type: "init", taskId });
}

/* --------------------------------------------------------------------------
 * HTML-skelett som laddar bundeln från dist-webview/
 * -------------------------------------------------------------------------- */
function getHtml(webview: vscode.Webview, extUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extUri, "dist-webview", "main.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extUri, "dist-webview", "tailwind.css"),
  );

  return /* html */ `<!DOCTYPE html>
<html lang="sv">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               img-src ${webview.cspSource} https:;
               script-src ${webview.cspSource};
               style-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${styleUri}">
    <title>AI Figma Codegen</title>
  </head>
  <body class="bg-background text-foreground">
    <div id="root"></div>
    <script type="module" src="${scriptUri}"></script>
  </body>
</html>`;
}

/* --------------------------------------------------------------------------
 * Extension-livcykel
 * -------------------------------------------------------------------------- */
export function activate(context: vscode.ExtensionContext) {
  /* manuellt testkommando */
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
