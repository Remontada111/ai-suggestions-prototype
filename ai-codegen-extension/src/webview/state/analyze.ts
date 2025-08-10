// webview/src/state/analyze.ts
export type ProjectModel = {
  manager: string;
  framework: string;
  scripts: Record<string, string>;
  entryPoints: { html: string[]; mainFiles: string[]; appFiles: string[]; next: { appDir: boolean; pagesDir: boolean } };
  styling: { tailwind: { present: boolean; configPath?: string | null }, uiLibs: string[] };
  routing: { type: string; routes: { path: string; file: string; source: string }[]; count: number };
  components: { name: string; file: string; export: string; kind: string; hasProps: boolean; propNames: string[]; usesTailwind: boolean }[];
  injectionPoints: { file: string; line: number; tag: string }[];
  limits: { maxFileBytes: number; maxFiles: number; filesScanned: number; bytesScanned: number; truncated: number; ignored: string[] };
  warnings: string[];
};

export type AnalyzeState =
  | { status: "IDLE" }
  | { status: "STARTING" | "PENDING" | "STARTED" | "RETRY"; taskId?: string }
  | { status: "SUCCESS"; model: ProjectModel }
  | { status: "ERROR"; message: string };

export function createAnalyzeState() {
  let state: AnalyzeState = { status: "IDLE" };
  let subs: ((s: AnalyzeState) => void)[] = [];

  const set = (s: AnalyzeState) => { state = s; subs.forEach(cb => cb(state)); };
  const get = () => state;
  const subscribe = (cb: (s: AnalyzeState) => void) => { subs.push(cb); cb(state); return () => { subs = subs.filter(x=>x!==cb); }; };

  // Lyssna på extension → webview meddelanden
  window.addEventListener("message", (event) => {
    const { type, payload } = event.data || {};
    if (type === "analysis/status") set({ status: payload?.status || "PENDING", taskId: payload?.taskId });
    else if (type === "analysis/result") set({ status: "SUCCESS", model: payload });
    else if (type === "analysis/error") set({ status: "ERROR", message: String(payload || "Okänt fel") });
  });

  return { subscribe, get };
}

export const analyzeStore = createAnalyzeState();
