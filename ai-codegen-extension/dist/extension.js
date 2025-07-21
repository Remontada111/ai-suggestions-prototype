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
/* --------------------------------------------------------------------------
 * VS Code-extension: AI Figma Codegen
 * -------------------------------------------------------------------------- */
const vscode = __importStar(require("vscode"));
/* --------- Konstanter --------- */
const VIEW_TYPE = "aiFigmaCodegen.panel";
const BACKEND_URL = "http://localhost:8000/figma-hook";
/* Håller aktuell panel så vi kan återanvända den */
let currentPanel;
/* --------------------------------------------------------------------------
 * Hjälpfunktion: starta Celery-tasken och få taskId
 * -------------------------------------------------------------------------- */
async function startTask(fileKey, nodeId) {
    const res = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileKey, nodeId }),
    });
    if (!res.ok) {
        throw new Error(`Backend error ${res.status}: ${await res.text()}`);
    }
    const { task_id } = (await res.json());
    return task_id;
}
/* --------------------------------------------------------------------------
 * Skapar eller fokuserar panelen
 * -------------------------------------------------------------------------- */
async function showAiPanel(context, fileKey, nodeId) {
    /* 1. Starta Celery-tasken */
    let taskId = "unknown";
    try {
        taskId = await startTask(fileKey, nodeId);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Kunde inte starta AI-pipen: ${err.message}`);
        return;
    }
    /* 2. Återanvänd befintlig panel eller skapa ny */
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Two);
    }
    else {
        currentPanel = vscode.window.createWebviewPanel(VIEW_TYPE, "AI Figma Codegen", vscode.ViewColumn.Two, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        /* Rensa referensen när panelen stängs */
        currentPanel.onDidDispose(() => {
            currentPanel = undefined;
        }, null, context.subscriptions);
        /* Lyssna på meddelanden från webviewen */
        currentPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.cmd === "openPR") {
                vscode.env.openExternal(vscode.Uri.parse(msg.url));
            }
            else if (msg.cmd === "chat") {
                // TODO: skicka msg.text till backend/chat-endpoint vid steg 4
                vscode.window.showInformationMessage(`Chat-instruktion skickad: ${msg.text}`);
            }
        });
    }
    /* 3. Ladda HTML */
    currentPanel.webview.html = getHtml(currentPanel.webview, context.extensionUri);
    /* 4. Skicka init-data till webviewen */
    currentPanel.webview.postMessage({ type: "init", taskId });
}
/* --------------------------------------------------------------------------
 * HTML-skelett som laddar bundeln från dist-webview/
 * -------------------------------------------------------------------------- */
function getHtml(webview, extUri) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "dist-webview", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "dist-webview", "tailwind.css"));
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
function activate(context) {
    /* manuellt testkommando */
    context.subscriptions.push(vscode.commands.registerCommand("ai-figma-codegen.openPanel", () => showAiPanel(context, "demoFileKey", "demoNodeId")));
    /* URI-handler från Figma-pluginen */
    context.subscriptions.push(vscode.window.registerUriHandler({
        async handleUri(uri) {
            var _a, _b;
            const pathPart = uri.path.replace(/^\/+/, "");
            if (pathPart !== "figma") {
                vscode.window.showWarningMessage(`Okänt uri-path '${uri.path}'.`);
                return;
            }
            const qs = new URLSearchParams(uri.query);
            const fileKey = (_a = qs.get("fileKey")) !== null && _a !== void 0 ? _a : "unknown-file";
            const nodeId = (_b = qs.get("nodeId")) !== null && _b !== void 0 ? _b : "unknown-node";
            await showAiPanel(context, fileKey, nodeId);
        },
    }));
}
function deactivate() {
    /* inget särskilt */
}
//# sourceMappingURL=extension.js.map