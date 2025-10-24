// webview/vscodeApi.ts
type VsCodeApi = {
  postMessage: (msg: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};

// Deklaration så TypeScript vet att funktionen finns i webview-konteksten
declare function acquireVsCodeApi(): VsCodeApi;

// Cacha instansen på window så vi aldrig anropar acquireVsCodeApi två gånger
declare global {
  interface Window { __vscodeApi?: VsCodeApi }
}

export function getVsCodeApi(): VsCodeApi {
  try {
    if (typeof window !== "undefined") {
      if (window.__vscodeApi) return window.__vscodeApi;
      if (typeof acquireVsCodeApi === "function") {
        window.__vscodeApi = acquireVsCodeApi();
        return window.__vscodeApi;
      }
    }
  } catch {}
  // Fallback för lokal utveckling/SSR-test
  return {
    postMessage() {},
    getState() { return {}; },
    setState() {},
  };
}
