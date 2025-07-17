/* —— VS Code WebView API —— */
interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}
declare function acquireVsCodeApi(): VSCodeAPI;

/* —— unidiff —— */
declare module "unidiff" {
  export const Diff: {
    colorLines(diff: string): string;
    parsePatch(patch: string): unknown;
  };
}

/* —— strip-ansi —— */
declare module "strip-ansi" {
  export default function stripAnsi(str: string): string;
}
