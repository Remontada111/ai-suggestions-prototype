// extension/src/detector.ts
// Extremt robust kandidatdetektering för frontend-projekt.
// - Skannar workspace + “lösa” rötter (+ monorepo: workspaces/lerna/nx)
// - Djup HTML-detektion (index.html i hela trädet, prioriterar rot)
// - Deterministisk poäng-/rangordningsmodell
// - Smart ignorering av buller (node_modules m.fl. – men tar dem som signal om deps)

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import fg from "fast-glob"; // npm i fast-glob
import YAML from "yaml";    // npm i yaml

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

const IGNORE_GLOBS =
  "**/{node_modules,dist,dist-webview,build,out,.next,.svelte-kit,.output,.git,coverage,.venv,venv,__pycache__}/**";

// ──────────────── Enkel modul-lokal cache ────────────────
let _cache: { at: number; list: Candidate[] } | null = null;
const CACHE_TTL_MS = 15000; // 15s känns lagom för upptäcktscache

// ──────────────── Utilities ────────────────
function unique<T>(a: T[]): T[] {
  return Array.from(new Set(a));
}
function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
function detectManager(dir: string): Candidate["manager"] {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
  return "unknown";
}
function hasDep(pkg: any, names: string[]) {
  const d = {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
    ...(pkg?.peerDependencies || {}),
  };
  const lower = new Set(Object.keys(d).map((k) => k.toLowerCase()));
  return names.some((n) => lower.has(n.toLowerCase()));
}
function chooseScript(pkg: any): string | undefined {
  const s = pkg?.scripts || {};
  for (const k of ["dev", "start", "serve", "preview"]) if (s[k]) return k;
  const keys = Object.keys(s);
  const rx =
    /(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack-dev-server|storybook|story|expo|ng\s+serve)\b/i;
  const hit = keys.find((k) => rx.test(String(s[k])));
  return hit;
}
function isUnder(dir: string, excludedRoots: string[]) {
  const norm = path.resolve(dir);
  return excludedRoots.some((root) => norm.startsWith(path.resolve(root) + path.sep));
}

/** Samla potentiella rötter: workspace + öppna filer (även utanför workspace) */
function collectCandidateRoots(): string[] {
  const roots: string[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri.fsPath);
  for (const ed of vscode.window.visibleTextEditors)
    if (ed?.document?.uri?.scheme === "file") roots.push(path.dirname(ed.document.uri.fsPath));
  const active = vscode.window.activeTextEditor;
  if (active?.document?.uri?.scheme === "file") roots.push(path.dirname(active.document.uri.fsPath));
  return unique(roots.map((p) => path.resolve(p)));
}

/** Liten DFS utan VS Code globber – funkar även utanför workspace */
function* walk(dir: string, maxDepth = 5): Generator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  const IGNORE = new Set([
    "node_modules",
    "dist",
    "dist-webview",
    "build",
    "out",
    ".next",
    ".svelte-kit",
    ".output",
    ".git",
    "coverage",
    ".venv",
    "venv",
    "__pycache__",
  ]);
  while (stack.length) {
    const { dir: cur, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
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

/** Hitta djup HTML – prioriterar rot/index.html, annars närmast roten */
async function findAnyHtmlDeep(dir: string): Promise<string | undefined> {
  const ignore = [
    "**/node_modules/**","**/dist/**","**/build/**","**/out/**","**/.next/**",
    "**/.svelte-kit/**","**/.output/**","**/.git/**","**/coverage/**",
    "**/.venv/**","**/venv/**","**/__pycache__/**","**/dist-webview/**",
  ];

  const rootIdx = path.join(dir, "index.html");
  if (fs.existsSync(rootIdx)) return "index.html";

  // Begränsa antal för performance (räcker gott för ranking)
  const hits = await fg(["**/*.html"], { cwd: dir, absolute: false, dot: false, ignore });
  if (!hits.length) return undefined;

  const score = (rel: string) => {
    const norm = rel.replace(/\\/g, "/");
    const isIndex = path.basename(norm).toLowerCase() === "index.html";
    const depth = norm.split("/").length;
    return (isIndex ? 1000 : 0) - depth; // större = bättre
  };

  hits.sort((a, b) => score(b) - score(a));
  return hits[0]!.replace(/\\/g, "/");
}

/** Hitta typiska SPA-entryfiler (snabb, deterministisk) */
function findEntryFile(dir: string): string | undefined {
  const patterns = [
    "src/main.tsx",
    "src/main.ts",
    "src/main.jsx",
    "src/main.js",
    "src/App.tsx",
    "src/App.ts",
    "src/App.jsx",
    "src/App.js",
    "pages/_app.tsx",
    "pages/_app.jsx",
    "app/layout.tsx",
    "app/layout.jsx",
    // vanliga fall utanför src
    "main.tsx",
    "main.ts",
    "main.jsx",
    "main.js",
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
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "svelte.config.js",
    "svelte.config.mjs",
    "svelte.config.ts",
    "nuxt.config.ts",
    "nuxt.config.js",
    "nuxt.config.mjs",
    "remix.config.js",
    "remix.config.mjs",
    "remix.config.ts",
    "solid.config.ts",
    "solid.config.js",
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
    "angular.json",
    "webpack.config.js",
    "webpack.dev.js",
    "webpack.dev.mjs",
    "storybook.config.js",
    "main.ts",
    "main.js",
  ];
  const hits: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) hits.push(n);
  }
  return hits;
}

/** Extrahera körkandidater */
function buildRunCandidates(
  pkg: any,
  dir: string,
  mgr: Candidate["manager"],
  framework: string,
  configHints: string[]
): { name?: string; cmd: string; source: string }[] {
  const out: { name?: string; cmd: string; source: string }[] = [];
  const s = pkg?.scripts || {};
  for (const [name, val] of Object.entries<string>(s)) {
    const rx =
      /\b(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|ng\s+serve|storybook|expo)\b/i;
    if (rx.test(val)) {
      const prefix =
        mgr === "pnpm" ? "pnpm" : mgr === "yarn" ? "yarn" : mgr === "bun" ? "bun" : "npm run";
      out.push({ name, cmd: `${prefix} ${name}`, source: "package.json" });
    }
  }
  const push = (cmd: string, why: string) => out.push({ cmd, source: why });
  if (configHints.some((x) => x.startsWith("vite.config"))) push("npx -y vite", "vite.config.*");
  if (framework === "next" || configHints.some((x) => x.startsWith("next.config")))
    push("npx -y next dev", framework === "next" ? "dep: next" : "next.config.*");
  if (framework === "sveltekit" || configHints.some((x) => x.startsWith("svelte.config")))
    push("npx -y vite", "sveltekit/svelte.config.*");
  if (framework === "nuxt" || configHints.some((x) => x.startsWith("nuxt.config")))
    push("npx -y nuxi dev", "nuxt.config.*");
  if (framework === "remix" || configHints.some((x) => x.startsWith("remix.config")))
    push("npx -y remix dev", "remix.config.*");
  if (framework === "solid" || configHints.some((x) => x.startsWith("solid.config")))
    push("npx -y solid-start dev", "solid.config.*");
  if (framework === "astro" || configHints.some((x) => x.startsWith("astro.config")))
    push("npx -y astro dev", "astro.config.*");
  if (configHints.includes("angular.json")) push("npx -y ng serve", "angular.json");
  if (configHints.some((x) => x.startsWith("webpack"))) push("npx -y webpack serve", "webpack config");

  // Sista utväg: statisk server
  // (findAnyHtmlDeep sköts i makeCandidateForDir → här räcker det att ha fallback)
  const html = fs.existsSync(path.join(dir, "index.html")) ? "index.html" : undefined;
  if (html) push("npx -y http-server -p 0", `static (${html})`);

  // Unika
  return unique(out.map((j) => JSON.stringify(j))).map((s) => JSON.parse(s));
}

/** Klassificera ramverk */
function detectFramework(pkg: any, configHints: string[]): string {
  const has = (names: string[]) => hasDep(pkg, names);
  if (has(["next"]) || configHints.some((c) => c.startsWith("next.config"))) return "next";
  if (has(["@sveltejs/kit"]) || configHints.some((c) => c.startsWith("svelte.config"))) return "sveltekit";
  if (has(["vite"])) return "vite";
  if (has(["react"])) return "react";
  if (has(["vue", "nuxt"]) || configHints.some((c) => c.startsWith("nuxt.config"))) return "vue";
  if (has(["@angular/core"]) || configHints.includes("angular.json")) return "angular";
  if (has(["remix", "@remix-run/dev"]) || configHints.some((c) => c.startsWith("remix.config"))) return "remix";
  if (has(["solid-start"]) || configHints.some((c) => c.startsWith("solid.config"))) return "solid";
  if (has(["astro"]) || configHints.some((c) => c.startsWith("astro.config"))) return "astro";
  return "unknown";
}

/** Läs workspaces-mönster från package.json */
function readWorkspacesFromPkg(pkg: any): string[] {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (ws && Array.isArray(ws.packages)) return ws.packages;
  return [];
}

/** pnpm-workspace.yaml → patterns */
function parsePnpmWorkspaceYaml(file: string): string[] {
  const txt = readText(file);
  if (!txt) return [];
  try {
    const y = YAML.parse(txt);
    const arr = Array.isArray(y?.packages) ? y.packages : [];
    return arr.filter((s: any) => typeof s === "string");
  } catch {
    return [];
  }
}

/** lerna.json → packages */
function readLernaPackages(root: string): string[] {
  const j = readJson(path.join(root, "lerna.json"));
  const arr = Array.isArray(j?.packages) ? j.packages : [];
  return arr;
}

/** nx.json/workspace.json → project roots */
function readNxProjects(root: string): string[] {
  const nx = readJson(path.join(root, "nx.json")) || readJson(path.join(root, "workspace.json"));
  const projects = nx?.projects;
  const dirs: string[] = [];
  if (projects && typeof projects === "object") {
    for (const [_name, val] of Object.entries<any>(projects)) {
      if (typeof val === "string") dirs.push(val);
      else if (val && typeof val === "object" && typeof val.root === "string") dirs.push(val.root);
    }
  }
  return dirs;
}

function readGitignore(root: string): string[] {
  const txt = readText(path.join(root, ".gitignore"));
  if (!txt) return [];
  return txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Enumerera paketmappar i ett (potentiellt) monorepo via workspaces/lerna/nx. */
async function enumerateWorkspacePackageDirs(root: string): Promise<string[]> {
  const pkg = readJson(path.join(root, "package.json")) || {};
  const ws = readWorkspacesFromPkg(pkg);
  const pnpm = parsePnpmWorkspaceYaml(path.join(root, "pnpm-workspace.yaml"));
  const lerna = readLernaPackages(root);
  const nx = readNxProjects(root);

  const patterns = [...ws, ...pnpm, ...lerna]
    .map((p) => p.replace(/\\/g, "/"))
    .map((p) => (p.endsWith("/") ? p : p + "/"))
    .map((p) => p + "package.json");

  const ignore = [
    "**/node_modules/**",
    "**/dist/**",
    "**/dist-webview/**",
    "**/build/**",
    "**/out/**",
    "**/.next/**",
    "**/.svelte-kit/**",
    "**/.output/**",
    "**/.git/**",
    "**/coverage/**",
    "**/.venv/**",
    "**/venv/**",
    "**/__pycache__/**",
  ];
  ignore.push(...readGitignore(root));

  const files = patterns.length ? await fg(patterns, { cwd: root, absolute: true, dot: false, ignore }) : [];

  const fromPatterns = files.map((f) => path.dirname(f));
  const fromNx = nx.map((d) => path.resolve(root, d));

  return Array.from(new Set([...fromPatterns, ...fromNx]));
}

/** Poängsätt kandidat (deterministisk ranking) */
function scoreCandidate(
  dir: string,
  pkg: any,
  configHints: string[],
  entryHtml?: string,
  entryFile?: string
): { score: number; reasons: string[] } {
  let s = 0; const reasons: string[] = [];
  const scripts = pkg?.scripts || {};
  const deps = { ...(pkg?.dependencies||{}), ...(pkg?.devDependencies||{}), ...(pkg?.peerDependencies||{}) };
  const has = (...names: string[]) => names.some(n => Object.prototype.hasOwnProperty.call(deps, n));
  const base = path.basename(dir).toLowerCase();

  if (pkg?.engines?.vscode) return { score: -9999, reasons: ["vscode-extension"] };

  const devKey = ["dev","start","serve","preview"].find(k => scripts[k]);
  if (devKey) { s += 8; reasons.push(`script:${devKey}`); }
  if (devKey && /\b(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|ng\s+serve|storybook|expo)\b/i.test(String(scripts[devKey]))) {
    s += 3; reasons.push("script:known-devserver");
  }

  if (configHints.length) { s += Math.min(6, configHints.length * 3); reasons.push(...configHints.map(c => `config:${c}`)); }

  if (has("next","@sveltejs/kit","vue","nuxt","@angular/core","remix","solid-start","astro") || has("react") || has("vite")) {
    s += 6; reasons.push("deps:frontend");
  }

  if (fs.existsSync(path.join(dir, "node_modules")) && (has("react","vue","nuxt","next","@angular/core","@sveltejs/kit","vite","astro","remix","solid-start"))) {
    s += 4; reasons.push("node_modules+frontenddeps");
  }

  if (entryHtml) {
    const norm = entryHtml.toLowerCase();
    if (norm === "index.html") { s += 6; reasons.push("entry:index.html@root"); }
    else { s += 3; reasons.push(`entryHtml:${entryHtml}`); }
  }
  if (entryFile) { s += 2; reasons.push(`entryFile:${entryFile}`); }

  if (/(^|[-_/])(frontend|web|client|app)([-_/]|$)/i.test(base)) { s += 2; reasons.push("name:intent"); }

  if ((has("express","fastify","koa","nestjs")) && !(has("react","vue","nuxt","next","@angular/core","@sveltejs/kit","vite","astro","remix","solid-start"))) {
    s -= 4; reasons.push("backend-heavy");
  }

  const depth = path.resolve(dir).split(path.sep).length;
  if (depth > 6) { s -= 1; reasons.push("deep-path"); }

  if (s <= 0 && !entryHtml && !devKey && !configHints.length) return { score: -9999, reasons: ["no-signals"] };
  return { score: s, reasons };
}

/** Bygg en kandidat för en rotkatalog (ASYNC p.g.a. djup HTML-sök) */
async function makeCandidateForDir(dir: string, excludeAbsDirs: string[]): Promise<Candidate | null> {
  if (isUnder(dir, excludeAbsDirs)) return null;
  const pkgPath = path.join(dir, "package.json");
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;
  if (pkg?.engines?.vscode) return null;

  const manager = detectManager(dir);
  const configHints = detectConfigs(dir);
  const framework = detectFramework(pkg, configHints);

  const scriptKey = chooseScript(pkg);
  const devCmd =
    scriptKey ? (manager === "pnpm" ? `pnpm ${scriptKey}` :
                 manager === "yarn" ? `yarn ${scriptKey}` :
                 manager === "bun"  ? `bun ${scriptKey}`  : `npm run ${scriptKey}`)
              : undefined;

  const entryHtml = await findAnyHtmlDeep(dir);
  const entryFile = findEntryFile(dir);

  const { score, reasons } = scoreCandidate(dir, pkg, configHints, entryHtml, entryFile);
  if (score <= -9999) return null;

  const cand: Candidate = {
    dir,
    manager,
    devCmd,
    framework,
    confidence: score,
    reason: reasons,
    pkgName: pkg?.name,
    entryHtml,
    entryFile,
    runCandidates: buildRunCandidates(pkg, dir, manager, framework, configHints),
    configHints,
  };
  return cand;
}

/** Comparator med tie-breakers för stabil rangordning */
function cmp(a: Candidate, b: Candidate) {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const aRoot = (a.entryHtml?.toLowerCase() === "index.html") ? 1 : 0;
  const bRoot = (b.entryHtml?.toLowerCase() === "index.html") ? 1 : 0;
  if (bRoot !== aRoot) return bRoot - aRoot;
  const aDev = a.devCmd ? 1 : 0, bDev = b.devCmd ? 1 : 0;
  if (bDev !== aDev) return bDev - aDev;
  const intent = (s: string) => /(^|[-_/])(frontend|web|client|app)([-_/]|$)/i.test(path.basename(s)) ? 1 : 0;
  const ai = intent(a.dir), bi = intent(b.dir);
  if (bi !== ai) return bi - ai;
  const depth = (s: string) => path.resolve(s).split(path.sep).length;
  const ad = depth(a.dir), bd = depth(b.dir);
  if (ad !== bd) return ad - bd; // grundare vinner
  try { return fs.statSync(b.dir).mtimeMs - fs.statSync(a.dir).mtimeMs; } catch { return 0; }
}

/** Detektera kandidater i en “lös” rot (även utanför workspace) */
async function detectInLooseDir(root: string, excludeAbsDirs: string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  // 1) Monorepo-uppräkning
  try {
    const wsDirs = await enumerateWorkspacePackageDirs(root);
    const promises = wsDirs.map(async (dir) => {
      if (seen.has(dir)) return;
      const cand = await makeCandidateForDir(dir, excludeAbsDirs);
      if (cand) { out.push(cand); seen.add(dir); }
    });
    await Promise.all(promises);
  } catch {
    /* ignore */
  }

  // 2) Fallback: snabb DFS – ta dir för varje fil
  for (const file of walk(root, 5)) {
    const dir = path.dirname(file);
    if (seen.has(dir)) continue;
    const cand = await makeCandidateForDir(dir, excludeAbsDirs);
    if (cand) {
      out.push(cand);
      seen.add(dir);
    }
  }

  if (!seen.has(root)) {
    const rootCand = await makeCandidateForDir(root, excludeAbsDirs);
    if (rootCand) out.push(rootCand);
  }

  out.sort(cmp);
  return out;
}

/** Detektera kandidater i workspace-mappar via monorepo-mönster + VS Code globbing (snabbt) */
async function detectInWorkspaceFolder(
  f: vscode.WorkspaceFolder,
  excludeAbsDirs: string[]
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  // A) Monorepo-workspaces först
  try {
    const wsDirs = await enumerateWorkspacePackageDirs(f.uri.fsPath);
    const promises = wsDirs.map(async (dir) => {
      if (seen.has(dir)) return;
      const cand = await makeCandidateForDir(dir, excludeAbsDirs);
      if (cand) { candidates.push(cand); seen.add(dir); }
    });
    await Promise.all(promises);
  } catch {
    /* ignore */
  }

  // B) package.json via VS Code globbing
  const pkgUris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(f, "**/package.json"),
    new vscode.RelativePattern(f, IGNORE_GLOBS),
    1200
  );
  for (const uri of pkgUris) {
    const dir = path.dirname(uri.fsPath);
    if (seen.has(dir)) continue;
    const cand = await makeCandidateForDir(dir, excludeAbsDirs);
    if (cand) {
      candidates.push(cand);
      seen.add(dir);
    }
  }

  // C) HTML-fallback för rena statiska projekt
  const htmlUris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(f, "**/*.html"),
    new vscode.RelativePattern(f, IGNORE_GLOBS),
    300
  );
  for (const uri of htmlUris) {
    const dir = path.dirname(uri.fsPath);
    if (seen.has(dir)) continue;
    const cand = await makeCandidateForDir(dir, excludeAbsDirs);
    if (cand) {
      candidates.push(cand);
      seen.add(dir);
    }
  }

  // De-dupe per dir
  const uniq = new Map<string, Candidate>();
  for (const c of candidates) if (!uniq.has(c.dir)) uniq.set(c.dir, c);
  return Array.from(uniq.values()).sort(cmp);
}

/** Intern scanning utan exkludering, används för att fylla cachen. */
async function scanAllProjectsUnfiltered(): Promise<Candidate[]> {
  const roots = collectCandidateRoots();
  const candidates: Candidate[] = [];

  // A) Workspace-mappar
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(...(await detectInWorkspaceFolder(f, [])));
  }

  // B) “Lösa” rötter (utanför workspace)
  for (const r of roots) {
    const covered = (vscode.workspace.workspaceFolders ?? []).some((w) => r.startsWith(w.uri.fsPath + path.sep));
    if (!covered) candidates.push(...(await detectInLooseDir(r, [])));
  }

  // C) Om tomt → fråga användaren (en gång) – detta inkluderas också i cache
  if (!candidates.length) {
    const pick = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: "Välj en mapp att skanna efter körbara frontend-projekt",
    });
    if (pick?.[0]) candidates.push(...(await detectInLooseDir(pick[0].fsPath, [])));
  }

  // De-dupe och sortera
  const uniq = new Map<string, Candidate>();
  for (const c of candidates) if (!uniq.has(c.dir)) uniq.set(c.dir, c);
  return Array.from(uniq.values()).sort(cmp);
}

/** Publik API: detektera projekt. Använder cache med kort TTL. */
export async function detectProjects(excludeAbsDirs: string[] = []): Promise<Candidate[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_TTL_MS) {
    // Filtrera cache enligt excludeAbsDirs
    const filtered = _cache.list.filter((c) => !isUnder(c.dir, excludeAbsDirs));
    return filtered.slice().sort(cmp);
    }

  const list = await scanAllProjectsUnfiltered();
  _cache = { at: Date.now(), list };

  const filtered = list.filter((c) => !isUnder(c.dir, excludeAbsDirs));
  return filtered.slice().sort(cmp);
}
