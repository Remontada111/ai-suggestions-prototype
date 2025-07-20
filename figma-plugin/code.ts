/// <reference types="@figma/plugin-typings" />

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Definiera UI: vi skickar med preloader + knapp för fallback
const UI_HTML = `
<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin:0; padding:8px; font:12px/1 monospace;
               background:#fff; color:#000; }
  pre { user-select:all; white-space:break-spaces; }
  button { margin-top:6px; padding:4px 8px; font:12px monospace; }
  #successMsg { color:green; margin-bottom:8px; }
</style>

<div id="successMsg"></div>
<div>VS Code-länk:</div>
<pre id="uri">Laddar...</pre>
<button id="copyBtn">Kopiera URI</button>
<button id="openBtn" style="margin-left:8px">Öppna i VS Code</button>

<script>
  // Kopiera URI till clipboard
  document.getElementById('copyBtn').onclick = () => {
    const text = document.getElementById('uri').textContent;
    navigator.clipboard.writeText(text);
  };

  // Öppna URI med window.open
  document.getElementById('openBtn').onclick = () => {
    const uri = document.getElementById('uri').textContent;
    window.open(uri, '_blank');
  };

  // Ta emot URI från plugin-koden
  window.onmessage = ({ data }) => {
    const uri = data.pluginMessage?.uri;
    if (!uri) return;

    // Visa URI i gränssnittet
    document.getElementById('uri').textContent = uri;

    // Försök öppna direkt
    try {
      window.open(uri, '_blank');
      document.getElementById('successMsg').textContent = '✅ VS Code öppnas…';
      // Stäng plugin efter några sekunder
      setTimeout(() => parent.postMessage({ pluginMessage: { close: true } }, '*'), 2000);
    } catch (e) {
      document.getElementById('successMsg').textContent =
        '❌ Automatisk öppning misslyckades. Klicka på knappen ovan.';
    }
  };
</script>
`;

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // 1 · Visa vår UI (inbäddad HTML)
  figma.showUI(UI_HTML, { width: 440, height: 160 });

  // 2 · Validera att något är markerat
  if (figma.currentPage.selection.length === 0) {
    figma.notify('Välj minst en nod först');
    figma.closePlugin();
    return;
  }

  // 3 · Plocka ut första noden
  const node = figma.currentPage.selection[0];

  // 4 · Kontrollera att filen ligger i molnet
  if (!figma.fileKey) {
    figma.notify('Filen är inte synkad till molnet');
    figma.closePlugin();
    return;
  }

  // 5 · Bygg VS Code-URI
  const uri = 
    `vscode://crnolic.ai-figma-codegen/figma?` +
    `fileKey=${figma.fileKey}` +
    `&nodeId=${encodeURIComponent(node.id)}`;

  console.log('VSCode-URI:', uri);

  // 6 · Skicka payload till lokal companion-app (valfritt)
  fetch('http://localhost:8000/figma-hook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileKey: figma.fileKey, nodeId: node.id })
  }).catch(err => console.warn('API-fel:', err));

  // 7 · Skicka URI till UI
  figma.ui.postMessage({ uri });
  figma.notify('Förbereder VS Code…');

  // 8 · Lyssna efter stängningsmeddelande från UI
  figma.ui.onmessage = msg => {
    if (msg.close) figma.closePlugin();
  };
}

main();
