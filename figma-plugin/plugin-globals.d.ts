// plugin-globals.d.ts
declare global {
  interface PluginAPI {
    openURL(url: string): Promise<void>;
  }
}
export {};
