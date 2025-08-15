// extension/src/detector.ts
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

/** Kandidat-projekt vi kan försöka köra/förhandsvisa */
export type Candidate = {
  dir: string;
  manager: "pnpm" | "yarn" | "npm" | "bun" | "unknown";
  devCmd?: string; // valt primärt kommando att köra
  framework: string;
  confidence: number;
  reason: string[];
  pkgName?: string;

  // Ledtrådar för att kunna starta/visa något även utan dev-script
  entryHtml?: string; // relativ sökväg till en HTML-fil vi kan serva (om finns)
  entryFile?: string; // t.ex. src/main.tsx (för heuristik)
  runCandidates?: { name?: string; cmd: string; source: string }[];
  configHints?: string[];
};

const IGNORE_GLOBS = "**/{node_modules,dist,dist-webview,build,out,.next,.svelte-kit,.output,.git,coverage,.venv,venv,__pycache__}/**";

function unique<T>(a: T[]): T[] { return Array.from(new Set(a)); }
function readJson(file: string): any | null { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function detectManager(dir: string): Candidate["manager"] {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
  return "unknown";
}

function hasDep(pkg: any, names: string[]) {
  const d = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}), ...(pkg?.peerDependencies || {}) };
  const lower = new Set(Object.keys(d).map(k => k.toLowerCase()));
  return names.some(n => lower.has(n.toLowerCase()));
}

function chooseScript(pkg: any): string | undefined {
  const s = pkg?.scripts || {};
  // Preferensordning
  for (const k of ["dev", "start", "serve", "preview"]) if (s[k]) return k;
  // Heuristik: valfri script-key som kör kända dev-servrar
  const keys = Object.keys(s);
  const rx = /(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack-dev-server|story|storybook|expo|ng\s+serve)\b/i;
  const hit = keys.find(k => rx.test(String(s[k])));
  return hit;
}

function isUnder(dir: string, excludedRoots: string[]) {
  const norm = path.resolve(dir);
  return excludedRoots.some(root => norm.startsWith(path.resolve(root) + path.sep));
}

/** Samla potentiella rötter: workspace + öppna filer (även utanför workspace) */
function collectCandidateRoots(): string[] {
  const roots: string[] = [];
  for (const f of (vscode.workspace.workspaceFolders ?? [])) roots.push(f.uri.fsPath);
  for (const ed of vscode.window.visibleTextEditors)
    if (ed?.document?.uri?.scheme === "file") roots.push(path.dirname(ed.document.uri.fsPath));
  const active = vscode.window.activeTextEditor;
  if (active?.document?.uri?.scheme === "file") roots.push(path.dirname(active.document.uri.fsPath));
  return unique(roots.map(p => path.resolve(p)));
}

/** Liten DFS utan VS Code globber – funkar även utanför workspace */
function* walk(dir: string, maxDepth = 3): Generator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  const IGNORE = new Set(["node_modules", "dist", "dist-webview", "build", "out", ".next", ".svelte-kit", ".output", ".git", "coverage", ".venv", "venv", "__pycache__"]);
  while (stack.length) {
    const { dir: cur, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        yield full;
      }
    }
  }
}

/** Hitta första "bra" HTML under dir */
function findAnyHtml(dir: string): string | undefined {
  const prefers = ["index.html", "public/index.html"];
  for (const rel of prefers) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return rel.replace(/\\/g, "/");
  }
  // Annars: första *.html under några välkända mappar
  const searchDirs = [dir, path.join(dir, "public"), path.join(dir, "app"), path.join(dir, "src")];
  for (const base of searchDirs) {
    try {
      const list = fs.readdirSync(base, { withFileTypes: true });
      for (const e of list) {
        if (e.isFile() && e.name.toLowerCase().endsWith(".html")) {
          const rel = path.relative(dir, path.join(base, e.name));
          return rel.replace(/\\/g, "/");
        }
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

/** Hitta typiska SPA-entryfiler */
function findEntryFile(dir: string): string | undefined {
  const patterns = [
    "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
    "src/App.tsx", "src/App.ts", "src/App.jsx", "src/App.js",
    "pages/_app.tsx", "pages/_app.jsx",
    "app/layout.tsx", "app/layout.jsx",
  ];
  for (const rel of patterns) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return rel.replace(/\\/g, "/");
  }
  return undefined;
}

/** Upptäck konfigurationsfiler som indikerar frontend */
function detectConfigs(dir: string): string[] {
  const names = [
    "vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs",
    "next.config.js", "next.config.mjs", "next.config.ts",
    "svelte.config.js", "svelte.config.mjs", "svelte.config.ts",
    "nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs",
    "remix.config.js", "remix.config.mjs", "remix.config.ts",
    "solid.config.ts", "solid.config.js",
    "astro.config.mjs", "astro.config.ts", "astro.config.js",
    "angular.json", "webpack.config.js", "webpack.dev.js", "webpack.dev.mjs",
    "storybook.config.js", "main.ts", "main.js" // storybook main.*
  ];
  const hits: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) hits.push(n);
  }
  return hits;
}

/** Extrahera körkandidater */
function buildRunCandidates(pkg: any, dir: string, mgr: Candidate["manager"], framework: string, configHints: string[]): { name?: string; cmd: string; source: string }[] {
  const out: { name?: string; cmd: string; source: string }[] = [];
  const s = pkg?.scripts || {};
  for (const [name, val] of Object.entries<string>(s)) {
    const rx = /\b(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|ng\s+serve|storybook|expo)\b/i;
    if (rx.test(val)) {
      const prefix = mgr === "pnpm" ? "pnpm" : mgr === "yarn" ? "yarn" : mgr === "bun" ? "bun" : "npm run";
      out.push({ name, cmd: `${prefix} ${name}`, source: "package.json" });
    }
  }
  // Fallbacks från config/deps
  const push = (cmd: string, why: string) => out.push({ cmd, source: why });
  if (configHints.some(x => x.startsWith("vite.config"))) push("npx -y vite", "vite.config.*");
  if (framework === "next" || configHints.some(x => x.startsWith("next.config"))) push("npx -y next dev", framework === "next" ? "dep: next" : "next.config.*");
  if (framework === "sveltekit" || configHints.some(x => x.startsWith("svelte.config"))) push("npx -y vite", "sveltekit/svelte.config.*");
  if (framework === "nuxt" || configHints.some(x => x.startsWith("nuxt.config"))) push("npx -y nuxi dev", "nuxt.config.*");
  if (framework === "remix" || configHints.some(x => x.startsWith("remix.config"))) push("npx -y remix dev", "remix.config.*");
  if (framework === "solid" || configHints.some(x => x.startsWith("solid.config"))) push("npx -y solid-start dev", "solid.config.*");
  if (framework === "astro" || configHints.some(x => x.startsWith("astro.config"))) push("npx -y astro dev", "astro.config.*");
  if (configHints.includes("angular.json")) push("npx -y ng serve", "angular.json");
  if (configHints.some(x => x.startsWith("webpack"))) push("npx -y webpack serve", "webpack config");
  if (configHints.some(x => x === "storybook.config.js" || x === "main.ts" || x === "main.js")) push("npx -y storybook dev -p 6006", "storybook config");

  // Sista utväg: statisk server
  const html = findAnyHtml(dir);
  if (html) push("npx -y http-server -p 5500", `static (${html})`);
  return unique(out.map(j => JSON.stringify(j))).map(s => JSON.parse(s));
}

/** Klassificera ramverk */
function detectFramework(pkg: any, configHints: string[]): string {
  const has = (names: string[]) => hasDep(pkg, names);
  if (has(["next"]) || configHints.some(c => c.startsWith("next.config"))) return "next";
  if (has(["@sveltejs/kit"]) || configHints.some(c => c.startsWith("svelte.config"))) return "sveltekit";
  if (has(["vite"])) return "vite";
  if (has(["react"])) return "react";
  if (has(["vue", "nuxt"]) || configHints.some(c => c.startsWith("nuxt.config"))) return "vue";
  if (has(["@angular/core"]) || configHints.includes("angular.json")) return "angular";
  if (has(["remix", "@remix-run/dev"]) || configHints.some(c => c.startsWith("remix.config"))) return "remix";
  if (has(["solid-start"]) || configHints.some(c => c.startsWith("solid.config"))) return "solid";
  if (has(["astro"]) || configHints.some(c => c.startsWith("astro.config"))) return "astro";
  return "unknown";
}

/** Bygg en kandidat för en rotkatalog */
function makeCandidateForDir(dir: string, excludeAbsDirs: string[]): Candidate | null {
  if (isUnder(dir, excludeAbsDirs)) return null;
  const pkgPath = path.join(dir, "package.json");
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

  // hoppa över VS Code-extensions (engines.vscode)
  if (pkg?.engines?.vscode) return null;

  const manager = detectManager(dir);
  const configHints = detectConfigs(dir);
  const framework = detectFramework(pkg, configHints);

  const reason: string[] = [];
  let confidence = 0;

  if (pkg) {
    reason.push("package.json");
    confidence += 2;
  }
  if (framework !== "unknown") { reason.push(`framework: ${framework}`); confidence += 4; }
  if (configHints.length) { reason.push(...configHints.map(c => `config:${c}`)); confidence += Math.min(3, configHints.length); }

  const scriptKey = chooseScript(pkg);
  let devCmd: string | undefined = undefined;
  if (scriptKey) {
    devCmd = manager === "pnpm" ? `pnpm ${scriptKey}` : manager === "yarn" ? `yarn ${scriptKey}` : manager === "bun" ? `bun ${scriptKey}` : `npm run ${scriptKey}`;
    reason.push(`script:${scriptKey}`);
    confidence += 3;
  }

  const entryHtml = findAnyHtml(dir);
  const entryFile = findEntryFile(dir);
  if (entryHtml) { reason.push(`html:${entryHtml}`); confidence += 1; }
  if (entryFile) { reason.push(`entry:${entryFile}`); confidence += 1; }

  const runCandidates = buildRunCandidates(pkg, dir, manager, framework, configHints);

  // Om inget av ovan – men vi hittar någon html/esm i src → ge låg confidence
  if (!pkg && !entryHtml) {
    // leta efter "ESM feeling"
    const srcDir = path.join(dir, "src");
    if (fs.existsSync(srcDir)) {
      confidence += 1;
      reason.push("src/ finns");
    }
  }

  const cand: Candidate = {
    dir, manager, devCmd, framework, confidence, reason, pkgName: pkg?.name,
    entryHtml, entryFile, runCandidates, configHints
  };
  return cand;
}

/** Detektera kandidater i en “lös” rot (även utanför workspace) */
function detectInLooseDir(root: string, excludeAbsDirs: string[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  // Titta upp till 3 nivåer ner, hitta kataloger som innehåller package.json eller html/config
  for (const file of walk(root, 3)) {
    const dir = path.dirname(file);
    if (seen.has(dir)) continue;
    const cand = makeCandidateForDir(dir, excludeAbsDirs);
    if (cand) {
      out.push(cand);
      seen.add(dir);
    }
  }

  // Om roten själv inte fångats (t.ex. tom), prova göra kandidat för just roten
  if (!seen.has(root)) {
    const rootCand = makeCandidateForDir(root, excludeAbsDirs);
    if (rootCand) out.push(rootCand);
  }

  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

/** Detektera kandidater i workspace-mappar via VS Code globbing (snabbt) */
async function detectInWorkspaceFolder(f: vscode.WorkspaceFolder, excludeAbsDirs: string[]): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  // package.json
  const pkgUris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(f, "**/package.json"),
    new vscode.RelativePattern(f, IGNORE_GLOBS),
    800
  );
  for (const uri of pkgUris) {
    const dir = path.dirname(uri.fsPath);
    const cand = makeCandidateForDir(dir, excludeAbsDirs);
    if (cand) candidates.push(cand);
  }

  // Om inget package.json – titta efter konfig/HTML i översta nivåerna
  const htmlUris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(f, "**/*.html"),
    new vscode.RelativePattern(f, IGNORE_GLOBS),
    200
  );
  for (const uri of htmlUris) {
    const dir = path.dirname(uri.fsPath);
    const cand = makeCandidateForDir(dir, excludeAbsDirs);
    if (cand) candidates.push(cand);
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  // De-dupe per dir
  const uniq = new Map<string, Candidate>();
  for (const c of candidates) if (!uniq.has(c.dir)) uniq.set(c.dir, c);
  return Array.from(uniq.values());
}

/** Publik API */
export async function detectProjects(excludeAbsDirs: string[] = []): Promise<Candidate[]> {
  const roots = collectCandidateRoots();
  const candidates: Candidate[] = [];

  // A) Workspace-mappar
  for (const f of (vscode.workspace.workspaceFolders ?? [])) {
    candidates.push(...await detectInWorkspaceFolder(f, excludeAbsDirs));
  }

  // B) “Lösa” rötter (utanför workspace)
  for (const r of roots) {
    const covered = (vscode.workspace.workspaceFolders ?? []).some(w => r.startsWith(w.uri.fsPath + path.sep));
    if (!covered) candidates.push(...detectInLooseDir(r, excludeAbsDirs));
  }

  // C) Om tomt → be användaren välja en mapp och skanna den
  if (!candidates.length) {
    const pick = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Välj en mapp att skanna efter körbara frontend-projekt",
    });
    if (pick?.[0]) candidates.push(...detectInLooseDir(pick[0].fsPath, excludeAbsDirs));
  }

  // De-dupe och sortera
  const uniq = new Map<string, Candidate>();
  for (const c of candidates) if (!uniq.has(c.dir)) uniq.set(c.dir, c);
  return Array.from(uniq.values()).sort((a, b) => b.confidence - a.confidence);
}
