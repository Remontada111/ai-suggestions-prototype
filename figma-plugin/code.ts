/// <reference types="@figma/plugin-typings" />

/**
 *  Typ-patch: `figma.openURL()` finns i runtime-API:t
 *  men saknas ännu i många @figma/plugin-typings-versioner.
 */
declare global {
  interface PluginAPI {
    /** Öppnar en URL via operativsystemet (endast Desktop-appen). */
    openURL(url: string): Promise<void>;
  }
}

// ------------------------------------------------------------
//  Main-funktion som körs direkt
// ------------------------------------------------------------
async function main() {
  // 1) Visa ett minimalt (osynligt) UI – krävs av Figma-API:t
  figma.showUI(
    `<style>html,body{margin:0;padding:0}</style><div id="stub"></div>`,
    { width: 240, height: 120 },
  );

  // 2) Kontrollera att en FRAME är vald
  const [node] = figma.currentPage.selection;
  if (!node || node.type !== "FRAME") {
    figma.notify("Välj en Frame först");
    figma.closePlugin();
    return;
  }

  // 3) Hämta fileKey (finns bara i privata plug-ins)
  const { fileKey } = figma;
  if (!fileKey) {
    figma.notify("fileKey saknas – är plug-inen privat & filen synkad?");
    figma.closePlugin();
    return;
  }

  // ----------------------------------------------------------
  // 4) Skicka payloaden till FastAPI-gatewayn
  const payload = { fileKey, nodeId: node.id };
  console.log("▶︎ Payload →", payload);

  try {
    const res = await fetch("http://localhost:8000/figma-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());

    figma.notify("Startade AI-pipeline – öppnar VS Code …");
  } catch (err) {
    figma.notify("Fel: " + (err as Error).message);
    console.error(err);
    figma.closePlugin();
    return;
  }

  // ----------------------------------------------------------
  // 5) Öppna VS Code-panelen via custom URI-schema
  const uri =
    `vscode://crnolic.ai-figma-codegen/figma` +
    `?fileKey=${fileKey}&nodeId=${encodeURIComponent(node.id)}`;

  try {
    await figma.openURL(uri);             // Fungerar i Desktop-appen
  } catch {
    // Fallback om typ-patch saknas i vissa miljöer
    figma.notify(`Öppna länken manuellt i VS Code:\n${uri}`);
  }

  figma.closePlugin();
}

main();

/** Gör filen till ett ES-modul-scope så global-augmentation tillåts. */
export {};
