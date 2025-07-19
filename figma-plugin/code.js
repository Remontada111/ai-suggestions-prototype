"use strict";
/// <reference types="@figma/plugin-typings" />
const UI_HTML = `
<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:8px;font:12px/1 monospace;background:#fff;color:#000}
  pre{user-select:all;white-space:break-all}
  button{margin-top:6px;padding:4px 8px;font:12px monospace}
</style>
<div>VS Code-länk:</div>
<pre id="uri"></pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('uri').textContent)">Kopiera</button>
<script>
window.onmessage = ({data})=>{
  if(data.pluginMessage?.uri){document.getElementById('uri').textContent=data.pluginMessage.uri}
};
</script>`;
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    /* 1 · UI */
    figma.showUI(UI_HTML, { width: 440, height: 120 });
    /* 2 · Validera urval (minst 1 nod) */
    if (figma.currentPage.selection.length === 0) {
        figma.notify("Välj minst en nod");
        figma.closePlugin();
        return;
    }
    /* 3 · Om flera noder → använd första (snabbfix) */
    // TODO: bygg temporär Frame om du vill stödja multi-select fullt ut.
    const node = figma.currentPage.selection[0];
    /* 4 · Kontrollera fileKey */
    if (!figma.fileKey) {
        figma.notify("Filen är inte synkad till molnet");
        figma.closePlugin();
        return;
    }
    /* 5 · Skicka payload */
    const payload = { fileKey: figma.fileKey, nodeId: node.id };
    try {
        const res = await fetch("http://localhost:8000/figma-hook", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok)
            throw new Error(await res.text());
    }
    catch (err) {
        figma.notify("API-fel: " + err.message);
        figma.closePlugin();
        return;
    }
    /* 6 · Bygg VS Code-URI */
    const uri = `vscode://crnolic.ai-figma-codegen/figma` +
        `?fileKey=${figma.fileKey}&nodeId=${encodeURIComponent(node.id)}`;
    console.log("VSCode-URI:", uri); // syns i konsolen
    figma.ui.postMessage({ uri }); // syns i UI
    figma.notify("⏩ Länk skapad – kopiera i UI");
    /* 7 · Lämna pluginen öppen en stund så man hinner kopiera */
    setTimeout(() => figma.closePlugin(), 15000); // 15 s
}
main();
