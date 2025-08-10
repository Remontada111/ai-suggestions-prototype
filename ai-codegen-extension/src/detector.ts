// src/detector.ts
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

export type Candidate = {
  dir: string;
  manager: "pnpm" | "yarn" | "npm";
  devCmd?: string;
  framework: string;
  confidence: number;
  reason: string[];
  pkgName?: string;
};

const IGNORE_GLOBS = "**/{node_modules,dist,dist-webview,out,.next,.svelte-kit,.output,.git}/**";

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function detectManager(dir: string): Candidate["manager"] {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function hasDep(pkg: any, names: string[]) {
  const d = { ...(pkg.dependencies||{}), ...(pkg.devDependencies||{}) };
  return names.some(n => d[n]);
}

function chooseScript(pkg: any): string | undefined {
  const s = pkg.scripts || {};
  if (s.dev) return "dev";
  if (s.start) return "start";
  if (s.serve) return "serve";
  return undefined;
}

function isUnder(dir: string, excludedRoots: string[]) {
  const norm = path.resolve(dir);
  return excludedRoots.some(root => norm.startsWith(path.resolve(root) + path.sep));
}

export async function detectProjects(excludeAbsDirs: string[] = []): Promise<Candidate[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates: Candidate[] = [];

  for (const f of folders) {
    // 1) package.json-baserade
    const pkgUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(f, "**/package.json"),
      new vscode.RelativePattern(f, IGNORE_GLOBS),
      400
    );

    for (const uri of pkgUris) {
      const dir = path.dirname(uri.fsPath);
      if (isUnder(dir, excludeAbsDirs)) continue;

      const pkg = readJson(uri.fsPath);
      if (!pkg) continue;
      // hoppa över VS Code-extensions (undvik att välja din egen extension)
      if (pkg.engines && pkg.engines.vscode) continue;

      const manager = detectManager(dir);
      const reason: string[] = [];
      let framework = "unknown";
      let confidence = 0;

      if (hasDep(pkg, ["next"])) { framework = "next"; confidence += 6; reason.push("dep: next"); }
      else if (hasDep(pkg, ["vite","@vitejs/plugin-react","@vitejs/plugin-vue"])) { framework = "vite"; confidence += 5; reason.push("dep: vite"); }
      else if (hasDep(pkg, ["react-scripts"])) { framework = "cra"; confidence += 4; reason.push("dep: CRA"); }
      else if (hasDep(pkg, ["astro"])) { framework = "astro"; confidence += 4; reason.push("dep: astro"); }
      else if (hasDep(pkg, ["@sveltejs/kit"])) { framework = "sveltekit"; confidence += 4; reason.push("dep: sveltekit"); }
      else if (hasDep(pkg, ["@angular/core"])) { framework = "angular"; confidence += 4; reason.push("dep: angular"); }

      const script = chooseScript(pkg);
      if (script) { confidence += 2; reason.push(`script: ${script}`); }

      const hasIndexHtml =
        fs.existsSync(path.join(dir, "index.html")) ||
        fs.existsSync(path.join(dir, "public", "index.html"));
      if (hasIndexHtml) { confidence += 1; reason.push("index.html"); }

      const devCmd = script
        ? (manager === "pnpm" ? `pnpm ${script}` : manager === "yarn" ? `yarn ${script}` : `npm run ${script}`)
        : undefined;

      candidates.push({
        dir, manager, devCmd, framework, confidence, reason, pkgName: pkg.name
      });
    }

    // 2) rena statiska mappar
    const htmlUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(f, "**/index.html"),
      new vscode.RelativePattern(f, IGNORE_GLOBS),
      80
    );
    for (const uri of htmlUris) {
      const dir = path.dirname(uri.fsPath);
      if (isUnder(dir, excludeAbsDirs)) continue;
      if (candidates.some(c => c.dir === dir)) continue;
      candidates.push({
        dir, manager: "npm", devCmd: undefined,
        framework: "static", confidence: 3,
        reason: ["index.html (ingen package.json)"]
      });
    }
  }

  candidates.sort((a,b) => b.confidence - a.confidence);
  return candidates;
}
