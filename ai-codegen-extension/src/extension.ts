import * as vscode from "vscode";

const VIEW_TYPE = "aiFigmaCodegen.panel";

/**
 * Håller referens till aktuell panel så vi kan återanvända den
 * (i stället för att försöka hitta den via Tab-API:t).
 */
let currentPanel: vscode.WebviewPanel | undefined;

/**
 * Öppnar (eller fokuserar) sidopanelen och injicerar
 * fileKey + nodeId. HTML-stubben ersätts i steg 3.
 */
function openAiPanel(
  context: vscode.ExtensionContext,
  fileKey: string,
  nodeId: string,
) {
  if (currentPanel) {
    // Panel finns redan: uppdatera UI + fokusera
    currentPanel.webview.html = getHtmlStub(fileKey, nodeId);
    currentPanel.reveal(vscode.ViewColumn.Two);
    return;
  }

  // Skapa ny panel
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "AI Figma Codegen",
    vscode.ViewColumn.Two,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  // Spara referens + städa när stängd
  currentPanel = panel;
  panel.onDidDispose(
    () => {
      currentPanel = undefined;
    },
    null,
    context.subscriptions,
  );

  panel.webview.html = getHtmlStub(fileKey, nodeId);
}

/** Tillfällig HTML-stub – ersätts i steg 3 av riktig React-webview */
function getHtmlStub(fileKey: string, nodeId: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"
  />
  <title>AI Figma Codegen</title>
</head>
<body style="font-family:sans-serif; padding:2rem; line-height:1.4;">
  <h2>🎨 Figma → VS Code</h2>
  <p>fileKey: <code>${fileKey}</code></p>
  <p>nodeId&nbsp;: <code>${nodeId}</code></p>
  <p style="margin-top:2rem; color:#999;">
    (Detta är en temporär panel. React-webview kommer i nästa steg.)
  </p>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
  /** Manuellt test-kommando (utan Figma) */
  const openPanelCmd = vscode.commands.registerCommand(
    "ai-figma-codegen.openPanel",
    () => openAiPanel(context, "demoFileKey", "demoNodeId"),
  );

  /**
   * Tar emot vscode://crnolic.ai-figma-codegen/figma?... URI från Figma-pluginen.
   * Exempel:
   *   vscode://crnolic.ai-figma-codegen/figma?fileKey=ABC123&nodeId=45%3A67
   */
  const uriHandler = vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri) {
      // uri.path kommer ofta med ledande "/" — normalisera
      const path = uri.path.replace(/^\/+/, "");
      if (path === "figma") {
        const qs = new URLSearchParams(uri.query ?? "");
        const fileKey = qs.get("fileKey") || "unknown-file";
        const nodeId = qs.get("nodeId") || "unknown-node";
        openAiPanel(context, fileKey, nodeId);
      } else {
        vscode.window.showWarningMessage(
          `Okänt uri-path '${uri.path}' (förväntade /figma).`,
        );
      }
    },
  });

  context.subscriptions.push(openPanelCmd, uriHandler);
}

export function deactivate() {
  /* inget att städa än */
}
