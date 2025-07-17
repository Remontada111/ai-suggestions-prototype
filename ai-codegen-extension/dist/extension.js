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
const vscode = __importStar(require("vscode"));
const VIEW_TYPE = "aiFigmaCodegen.panel";
/**
 * Håller referens till aktuell panel så vi kan återanvända den
 * (i stället för att försöka hitta den via Tab-API:t).
 */
let currentPanel;
/**
 * Öppnar (eller fokuserar) sidopanelen och injicerar
 * fileKey + nodeId. HTML-stubben ersätts i steg 3.
 */
function openAiPanel(context, fileKey, nodeId) {
    if (currentPanel) {
        // Panel finns redan: uppdatera UI + fokusera
        currentPanel.webview.html = getHtmlStub(fileKey, nodeId);
        currentPanel.reveal(vscode.ViewColumn.Two);
        return;
    }
    // Skapa ny panel
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "AI Figma Codegen", vscode.ViewColumn.Two, {
        enableScripts: true,
        retainContextWhenHidden: true,
    });
    // Spara referens + städa när stängd
    currentPanel = panel;
    panel.onDidDispose(() => {
        currentPanel = undefined;
    }, null, context.subscriptions);
    panel.webview.html = getHtmlStub(fileKey, nodeId);
}
/** Tillfällig HTML-stub – ersätts i steg 3 av riktig React-webview */
function getHtmlStub(fileKey, nodeId) {
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
function activate(context) {
    /** Manuellt test-kommando (utan Figma) */
    const openPanelCmd = vscode.commands.registerCommand("ai-figma-codegen.openPanel", () => openAiPanel(context, "demoFileKey", "demoNodeId"));
    /**
     * Tar emot vscode://crnolic.ai-figma-codegen/figma?... URI från Figma-pluginen.
     * Exempel:
     *   vscode://crnolic.ai-figma-codegen/figma?fileKey=ABC123&nodeId=45%3A67
     */
    const uriHandler = vscode.window.registerUriHandler({
        handleUri(uri) {
            // uri.path kommer ofta med ledande "/" — normalisera
            const path = uri.path.replace(/^\/+/, "");
            if (path === "figma") {
                const qs = new URLSearchParams(uri.query ?? "");
                const fileKey = qs.get("fileKey") || "unknown-file";
                const nodeId = qs.get("nodeId") || "unknown-node";
                openAiPanel(context, fileKey, nodeId);
            }
            else {
                vscode.window.showWarningMessage(`Okänt uri-path '${uri.path}' (förväntade /figma).`);
            }
        },
    });
    context.subscriptions.push(openPanelCmd, uriHandler);
}
function deactivate() {
    /* inget att städa än */
}
//# sourceMappingURL=extension.js.map