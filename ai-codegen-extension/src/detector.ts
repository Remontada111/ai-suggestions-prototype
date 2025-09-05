// src/detector.ts
// Robust kandidatdetektering för frontend-projekt.
// Nyheter:
// - “Extension-like”-detektion: hård-exkludera bara riktiga VS Code extensions.
// - Runnability-gate: släpp igenom endast mappar som rimligen går att starta (dev-script,
//   känd config/dep eller faktiskt HTML att serva).
// - Intent-medveten HTML-prioritering + DOM-signal (React/Vue/Svelte/Angular).
// - Förbättrade runCandidates: föreslå npx-kommandon även utan scripts vid dep/config.
// - Overrides via frontend.detector.json (forceInclude/forceExclude).
// - ML-krok: bygg feature vector → p(frontend) → kombinera med heuristikscore.

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import fg from "fast-glob";
import YAML from "yaml";

import { buildFeatureVector, type HtmlIntent, type DomIntent } from "./ml/features";
import { predictFrontendProb, combineHeuristicAndML } from "./ml/classifier";

/** Kandidat-projekt vi kan försöka köra/förhandsvisa */
export type Candidate = {
  dir: string;
  manager: "pnpm" | "yarn" | "npm" | "bun" | "unknown";
  devCmd?: string;
  framework: string;
  confidence: number;
  reason: string[];
  pkgName?: string;

  entryHtml?: string; // relativ sökväg till en HTML-fil vi kan serva (om finns)
  entryFile?: string; // t.ex. src/main.tsx
  runCandidates?: { name?: string; cmd: string; source: string }[];
  configHints?: string[];
};

type Overrides = { forceInclude?: string[]; forceExclude?: string[] };

const IGNORE_GLOBS =
  "**/{node_modules,dist,dist-webview,build,out,.next,.svelte-kit,.output,.git,coverage,.venv,venv,__pycache__}/**";

// ──────────────── Enkel modul-lokal cache ────────────────
let _cache: { at: number; list: Candidate[] } | null = null;
const CACHE_TTL_MS = 15000;

// ──────────────── Utilities ────────────────
function unique<T>(a: T[]): T[] { return Array.from(new Set(a)); }
function readJson(file: string): any | null { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function readText(file: string): string | null { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }

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
  for (const k of ["dev", "start", "serve", "preview"]) if (s[k]) return k;
  const keys = Object.keys(s);
  const rx = /(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|storybook|expo|ng\s+serve)\b/i;
  const hit = keys.find(k => rx.test(String(s[k])));
  return hit;
}

function isUnder(dir: string, excludedRoots: string[]) {
  const norm = path.resolve(dir);
  return excludedRoots.some(root => norm.startsWith(path.resolve(root) + path.sep));
}

/** “Extension-like”: engines.vscode + tydlig VS Code-shape */
function isVSCExtensionLike(pkg: any): boolean {
  if (!pkg?.engines?.vscode) return false;
  const hasVsceShape =
    !!pkg?.contributes ||
    !!pkg?.activationEvents ||
    /extension\.(c?m?js|ts)$/i.test(String(pkg?.main || ""));
  return hasVsceShape;
}

/** Samla potentiella rötter: workspace + öppna filer (även utanför workspace) */
function collectCandidateRoots(): string[] {
  const roots: string[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri.fsPath);
  for (const ed of vscode.window.visibleTextEditors)
    if (ed?.document?.uri?.scheme === "file") roots.push(path.dirname(ed.document.uri.fsPath));
  const active = vscode.window.activeTextEditor;
  if (active?.document?.uri?.scheme === "file") roots.push(path.dirname(active.document.uri.fsPath));
  return unique(roots.map(p => path.resolve(p)));
}

/** Liten DFS utan VS Code globber – funkar även utanför workspace */
function* walk(dir: string, maxDepth = 5): Generator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  const IGNORE = new Set(["node_modules","dist","dist-webview","build","out",".next",".svelte-kit",".output",".git","coverage",".venv","venv","__pycache__"]);
  while (stack.length) {
    const { dir: cur, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) yield full;
    }
  }
}

/** Intent-medveten HTML-sökning – prioriterar rot/public och nedvärderar src/tests/examples */
async function findAnyHtmlDeep(dir: string): Promise<string | undefined> {
  const ignore = [
    "**/node_modules/**","**/dist/**","**/build/**","**/out/**","**/.next/**",
    "**/.svelte-kit/**","**/.output/**","**/.git/**","**/coverage/**",
    "**/.venv/**","**/venv/**","**/__pycache__/**","**/dist-webview/**",
  ];

  const rootIdx = path.join(dir, "index.html");
  if (fs.existsSync(rootIdx)) return "index.html";

  const hits = await fg(["**/*.html"], { cwd: dir, absolute: false, dot: false, ignore });
  if (!hits.length) return undefined;

  const PENALIZE = /(\/|^)(src|test|tests|__tests__|example|examples|demo|demos|tools|scripts)(\/|$)/i;

  const score = (rel: string) => {
    const norm = rel.replace(/\\/g, "/");
    const base = path.basename(norm).toLowerCase();
    const isIndex = base === "index.html";
    const depth = norm.split("/").length;
    let s = (isIndex ? 1000 : 0) - depth;
    if (norm === "public/index.html") s += 25;
    if (PENALIZE.test(norm)) s -= 50;
    return s;
  };

  hits.sort((a, b) => score(b) - score(a));
  return hits[0]!.replace(/\\/g, "/");
}

/** Hitta typiska SPA-entryfiler (snabb, deterministisk) */
function findEntryFile(dir: string): string | undefined {
  const patterns = [
    "src/main.tsx","src/main.ts","src/main.jsx","src/main.js",
    "src/App.tsx","src/App.ts","src/App.jsx","src/App.js",
    "pages/_app.tsx","pages/_app.jsx","app/layout.tsx","app/layout.jsx",
    "main.tsx","main.ts","main.jsx","main.js",
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
    "vite.config.ts","vite.config.js","vite.config.mjs","vite.config.cjs",
    "next.config.js","next.config.mjs","next.config.ts",
    "svelte.config.js","svelte.config.mjs","svelte.config.ts",
    "nuxt.config.ts","nuxt.config.js","nuxt.config.mjs",
    "remix.config.js","remix.config.mjs","remix.config.ts",
    "solid.config.ts","solid.config.js",
    "astro.config.mjs","astro.config.ts","astro.config.js",
    "angular.json",
    "webpack.config.js","webpack.dev.js","webpack.dev.mjs",
    "storybook.config.js",
  ];
  const hits: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) hits.push(n);
  }
  return hits;
}

/** Extrahera körkandidater (även utan scripts via dep/config) */
function buildRunCandidates(
  pkg: any,
  dir: string,
  mgr: Candidate["manager"],
  framework: string,
  configHints: string[]
): { name?: string; cmd: string; source: string }[] {
  const out: { name?: string; cmd: string; source: string }[] = [];
  const s = pkg?.scripts || {};
  const runPrefix =
    mgr === "pnpm" ? "pnpm" : mgr === "yarn" ? "yarn" : mgr === "bun" ? "bun" : "npm run";

  // Scripts som liknar dev-servers
  for (const [name, val] of Object.entries<string>(s)) {
    const rx = /\b(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|ng\s+serve|storybook|expo)\b/i;
    if (rx.test(val) || /^(dev|start|serve|preview)$/i.test(name)) {
      out.push({ name, cmd: `${runPrefix} ${name}`, source: "package.json" });
    }
  }

  const push = (cmd: string, why: string) => out.push({ cmd, source: why });

  // Från configHints
  if (configHints.some(x => x.startsWith("vite.config"))) push("npx -y vite", "vite.config.*");
  if (framework === "next" || configHints.some(x => x.startsWith("next.config"))) push("npx -y next dev", framework === "next" ? "dep:next" : "next.config.*");
  if (framework === "sveltekit" || configHints.some(x => x.startsWith("svelte.config"))) push("npx -y vite", "sveltekit/svelte.config.*");
  if (framework === "nuxt" || configHints.some(x => x.startsWith("nuxt.config"))) push("npx -y nuxi dev", "nuxt.config.*");
  if (framework === "remix" || configHints.some(x => x.startsWith("remix.config"))) push("npx -y remix dev", "remix.config.*");
  if (framework === "solid" || configHints.some(x => x.startsWith("solid.config"))) push("npx -y solid-start dev", "solid.config.*");
  if (framework === "astro" || configHints.some(x => x.startsWith("astro.config"))) push("npx -y astro dev", "astro.config.*");
  if (configHints.includes("angular.json")) push("npx -y ng serve", "angular.json");
  if (configHints.some(x => x.startsWith("webpack"))) push("npx -y webpack serve", "webpack config");

  // Från dependencies även om config saknas
  const dep = (names: string[]) => hasDep(pkg, names);
  if (dep(["vite"])) push("npx -y vite", "dep:vite");
  if (dep(["next"])) push("npx -y next dev", "dep:next");
  if (dep(["@sveltejs/kit"])) push("npx -y vite", "dep:sveltekit");
  if (dep(["nuxt"])) push("npx -y nuxi dev", "dep:nuxt");
  if (dep(["remix","@remix-run/dev"])) push("npx -y remix dev", "dep:remix");
  if (dep(["solid-start"])) push("npx -y solid-start dev", "dep:solid-start");
  if (dep(["astro"])) push("npx -y astro dev", "dep:astro");
  if (dep(["@angular/cli"])) push("npx -y ng serve", "dep:@angular/cli");
  if (dep(["webpack-dev-server","webpack"])) push("npx -y webpack serve", "dep:webpack");
  if (dep(["storybook","@storybook/react","@storybook/vue","@storybook/svelte"])) push("npx -y storybook dev -p 0", "dep:storybook");

  // Sista utväg: statisk server om index.html i roten
  const html = fs.existsSync(path.join(dir, "index.html")) ? "index.html" : undefined;
  if (html) push("npx -y http-server -p 0", `static (${html})`);

  // Unika
  return unique(out.map(j => JSON.stringify(j))).map(s => JSON.parse(s));
}

/** Klassificera ramverk */
function detectFramework(pkg: any, configHints: string[]): string {
  const has = (names: string[]) => hasDep(pkg, names);
  if (has(["next"]) || configHints.some(c => c.startsWith("next.config"))) return "next";
  if (has(["@sveltejs/kit"]) || configHints.some(c => c.startsWith("svelte.config"))) return "sveltekit";
  if (has(["vite"])) return "vite";
  if (has(["react"])) return "react";
  if (has(["vue","nuxt"]) || configHints.some(c => c.startsWith("nuxt.config"))) return "vue";
  if (has(["@angular/core"]) || configHints.includes("angular.json")) return "angular";
  if (has(["remix","@remix-run/dev"]) || configHints.some(c => c.startsWith("remix.config"))) return "remix";
  if (has(["solid-start"]) || configHints.some(c => c.startsWith("solid.config"))) return "solid";
  if (has(["astro"]) || configHints.some(c => c.startsWith("astro.config"))) return "astro";
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
  } catch { return []; }
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
  return txt.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

/** AST-lös, snabb HTML-intent-inspektion */
function inspectHtmlIntent(dir: string, relHtml: string): HtmlIntent {
  const hints: string[] = [];
  let score = 0;
  const htmlPath = path.join(dir, relHtml);
  const html = readText(htmlPath) ?? "";

  const normRel = relHtml.replace(/\\/g, "/");
  if (normRel === "index.html") { score += 6; hints.push("html@root"); }
  if (normRel === "public/index.html") { score += 5; hints.push("html@public"); }
  if (/(^|\/)(src|test|tests|examples?|demos?|tools|scripts)\/index\.html$/i.test(normRel)) {
    score -= 6; hints.push("html@likely-harness");
  }

  if (/\bid=["']app["']\b/i.test(html)) { score += 2; hints.push("html#app"); }
  if (/\b\/@vite\/client\b/.test(html)) { score += 4; hints.push("html@vite"); }

  const m = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>/i);
  if (m?.[1]) {
    const srcRaw = m[1];
    const src = srcRaw.replace(/^\.\//, "");
    hints.push(`html:script=${src}`);
    if (/\.(jsx?|tsx?)$/i.test(src)) score += 2;
    if (/\.ts$/i.test(src)) { score -= 2; hints.push("ts-in-html"); }
    const p = path.join(dir, src);
    if (fs.existsSync(p)) { hints.push("entry:from-html"); score += 1; }
    return { score, hints };
  }
  return { score, hints };
}

/** Snabb DOM-signal i entry-filen */
function inspectEntryDom(dir: string, relEntry?: string): DomIntent {
  if (!relEntry) return { score: 0, hints: [] };
  const p = path.join(dir, relEntry);
  const code = readText(p) ?? "";
  let score = 0; const hints: string[] = [];
  const tests: Array<[RegExp, string, number]> = [
    [/document\.getElementById\s*\(\s*["']app["']\s*\)/i, "dom:#app", 2],
    [/ReactDOM\.(createRoot|render)\s*\(/, "dom:react", 3],
    [/\bcreateApp\s*\(.*\)\.mount\s*\(/i, "dom:vue", 3],
    [/\bnew\s+Vue\s*\(.*\)\s*\.\$mount\s*\(/i, "dom:vue2", 2],
    [/\bnew\s+App\s*\(\s*{[^}]*target\s*:/i, "dom:svelte", 3],
    [/\bangular\.bootstrap\b/i, "dom:angular", 2],
  ];
  for (const [rx, tag, pts] of tests) if (rx.test(code)) { score += pts; hints.push(tag); }
  return { score, hints };
}

/** Läs overrides i repo-rot (frivilligt) */
function readOverrides(root: string): Overrides {
  const j = readJson(path.join(root, "frontend.detector.json"));
  return (j && typeof j === "object") ? (j as Overrides) : {};
}

/** Hjälp: matcha override mot ett kandidatdir */
function overrideMatches(root: string, candDir: string, tag: string): boolean {
  const rel = path.relative(root, candDir).replace(/\\/g, "/");
  const normTag = tag.replace(/^[.\/]+/, "");
  return (
    rel === normTag ||
    rel.startsWith(normTag + "/") ||
    path.basename(candDir) === normTag ||
    path.resolve(root, normTag) === path.resolve(candDir)
  );
}

/** Poängsätt kandidat (deterministisk ranking, baspoäng) */
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

  // Tung minus om “felmärkt” frontend med engines.vscode men inte VS Code-shape
  if (pkg?.engines?.vscode && !isVSCExtensionLike(pkg)) { s -= 100; reasons.push("vscode-engines-without-extension-shape"); }

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

  // Backend-tyngd utan frontend
  if ((has("express","fastify","koa","nestjs")) && !(has("react","vue","nuxt","next","@angular/core","@sveltejs/kit","vite","astro","remix","solid-start"))) {
    s -= 4; reasons.push("backend-heavy");
  }

  // Särskild nedviktning för typiska VS Code webview-mappar
  const normDir = dir.replace(/\\/g, "/").toLowerCase();
  if (/\/extension\/src\/webview(\/|$)/.test(normDir) || /\/src\/webview(\/|$)/.test(normDir)) {
    s -= 20; reasons.push("penalty:webview-folder");
  }

  const depth = path.resolve(dir).split(path.sep).length;
  if (depth > 6) { s -= 1; reasons.push("deep-path"); }

  if (s <= 0 && !entryHtml && !devKey && !configHints.length) return { score: -9999, reasons: ["no-signals"] };
  return { score: s, reasons };
}

/** Runnability-gate: kan vi realistiskt starta eller serva detta? */
function isRunnable(dir: string, pkg: any, configHints: string[], entryHtml?: string): boolean {
  const hasScript = !!chooseScript(pkg);
  const hasHtml = !!entryHtml || fs.existsSync(path.join(dir,"index.html")) || fs.existsSync(path.join(dir,"public","index.html"));
  const hasKnownConfig = configHints.length > 0;
  const hasKnownDep = hasDep(pkg, ["vite","next","nuxt","@sveltejs/kit","astro","remix","solid-start","@angular/cli","webpack","webpack-dev-server","storybook"]);
  return hasScript || hasHtml || hasKnownConfig || hasKnownDep;
}

/** Bygg en kandidat för en rotkatalog (ASYNC p.g.a. djup HTML-sök) */
async function makeCandidateForDir(dir: string, excludeAbsDirs: string[]): Promise<Candidate | null> {
  if (isUnder(dir, excludeAbsDirs)) return null;

  const pkgPath = path.join(dir, "package.json");
  const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

  // Hård-exkludera bara riktiga VS Code extensions
  if (pkg && isVSCExtensionLike(pkg)) return null;

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
  const entryFileDetected = findEntryFile(dir);

  // Gate: om inga rimliga startmöjligheter → ge upp tidigt
  if (!isRunnable(dir, pkg, configHints, entryHtml)) return null;

  // Intent från HTML + DOM
  const htmlIntent = entryHtml ? inspectHtmlIntent(dir, entryHtml) : { score: 0, hints: [] as string[] };
  const domIntent = inspectEntryDom(dir, entryFileDetected);

  // Baspoäng
  const base = scoreCandidate(dir, pkg, configHints, entryHtml, entryFileDetected);
  if (base.score <= -9999) return null;

  // Extra heuristikpoäng (HTML/DOM)
  let heuristicFinal = base.score + htmlIntent.score + domIntent.score;

  // ML: bygg features och kombinera
  const fv = buildFeatureVector({
    dir,
    pkg,
    configHints,
    entryHtml,
    entryFile: entryFileDetected,
    heuristicBaseScore: base.score,
    htmlIntent,
    domIntent,
  });

  const mlProb = predictFrontendProb(fv); // null om ingen modell
  if (mlProb != null) heuristicFinal = combineHeuristicAndML(heuristicFinal, mlProb, { weight: 10 });

  const reasons = [...base.reasons, ...htmlIntent.hints, ...domIntent.hints];
  if (mlProb != null) reasons.push(`ml:p=${mlProb.toFixed(3)}`);

  const cand: Candidate = {
    dir,
    manager,
    devCmd,
    framework,
    confidence: heuristicFinal,
    reason: reasons,
    pkgName: pkg?.name,
    entryHtml,
    entryFile: entryFileDetected,
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
  // Grundare vinner
  const depth = (s: string) => path.resolve(s).split(path.sep).length;
  const ad = depth(a.dir), bd = depth(b.dir);
  if (ad !== bd) return ad - bd;
  try { return fs.statSync(b.dir).mtimeMs - fs.statSync(a.dir).mtimeMs; } catch { return 0; }
}

/** Enumerera paketmappar i ett (potentiellt) monorepo via workspaces/lerna/nx. */
async function enumerateWorkspacePackageDirs(root: string): Promise<string[]> {
  const pkg = readJson(path.join(root, "package.json")) || {};
  const ws = readWorkspacesFromPkg(pkg);
  const pnpm = parsePnpmWorkspaceYaml(path.join(root, "pnpm-workspace.yaml"));
  const lerna = readLernaPackages(root);
  const nx = readNxProjects(root);

  const patterns = [...ws, ...pnpm, ...lerna]
    .map(p => p.replace(/\\/g, "/"))
    .map(p => (p.endsWith("/") ? p : p + "/"))
    .map(p => p + "package.json");

  const ignore = [
    "**/node_modules/**","**/dist/**","**/dist-webview/**","**/build/**","**/out/**",
    "**/.next/**","**/.svelte-kit/**","**/.output/**","**/.git/**","**/coverage/**",
    "**/.venv/**","**/venv/**","**/__pycache__/**",
  ];
  ignore.push(...readGitignore(root));

  const files = patterns.length ? await fg(patterns, { cwd: root, absolute: true, dot: false, ignore }) : [];
  const fromPatterns = files.map(f => path.dirname(f));
  const fromNx = nx.map(d => path.resolve(root, d));
  return Array.from(new Set([...fromPatterns, ...fromNx]));
}

/** Detektera kandidater i en “lös” rot (även utanför workspace) */
async function detectInLooseDir(root: string, excludeAbsDirs: string[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const overrides = readOverrides(root);

  // 1) Monorepo-uppräkning
  try {
    const wsDirs = await enumerateWorkspacePackageDirs(root);
    const promises = wsDirs.map(async (dir) => {
      if (seen.has(dir)) return;
      const cand = await makeCandidateForDir(dir, excludeAbsDirs);
      if (cand) { out.push(cand); seen.add(dir); }
    });
    await Promise.all(promises);
  } catch { /* ignore */ }

  // 2) Fallback: snabb DFS – ta dir för varje fil
  for (const file of walk(root, 5)) {
    const dir = path.dirname(file);
    if (seen.has(dir)) continue;
    const cand = await makeCandidateForDir(dir, excludeAbsDirs);
    if (cand) { out.push(cand); seen.add(dir); }
  }

  if (!seen.has(root)) {
    const rootCand = await makeCandidateForDir(root, excludeAbsDirs);
    if (rootCand) out.push(rootCand);
  }

  // Overrides
  let list = out;
  if (overrides.forceExclude?.length) {
    list = list.filter(c => !overrides.forceExclude!.some(tag => overrideMatches(root, c.dir, tag)));
  }
  if (overrides.forceInclude?.length) {
    list = list.map(c => {
      const hit = overrides.forceInclude!.some(tag => overrideMatches(root, c.dir, tag));
      return hit ? { ...c, confidence: c.confidence + 100, reason: [...c.reason, "override:forceInclude"] } : c;
    });
  }

  list.sort(cmp);
  return list;
}

/** Detektera kandidater i workspace-mappar via monorepo-mönster + VS Code globbing (snabbt) */
async function detectInWorkspaceFolder(
  f: vscode.WorkspaceFolder,
  excludeAbsDirs: string[]
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const root = f.uri.fsPath;
  const overrides = readOverrides(root);

  // A) Monorepo-workspaces först
  try {
    const wsDirs = await enumerateWorkspacePackageDirs(root);
    const promises = wsDirs.map(async (dir) => {
      if (seen.has(dir)) return;
      const cand = await makeCandidateForDir(dir, excludeAbsDirs);
      if (cand) { candidates.push(cand); seen.add(dir); }
    });
    await Promise.all(promises);
  } catch { /* ignore */ }

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
    if (cand) { candidates.push(cand); seen.add(dir); }
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
    if (cand) { candidates.push(cand); seen.add(dir); }
  }

  // De-dupe per dir
  let list = Array.from(new Map<string, Candidate>(candidates.map(c => [c.dir, c])).values());

  // Overrides
  if (overrides.forceExclude?.length) {
    list = list.filter(c => !overrides.forceExclude!.some(tag => overrideMatches(root, c.dir, tag)));
  }
  if (overrides.forceInclude?.length) {
    list = list.map(c => {
      const hit = overrides.forceInclude!.some(tag => overrideMatches(root, c.dir, tag));
      return hit ? { ...c, confidence: c.confidence + 100, reason: [...c.reason, "override:forceInclude"] } : c;
    });
  }

  return list.sort(cmp);
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
    const filtered = _cache.list.filter(c => !isUnder(c.dir, excludeAbsDirs));
    return filtered.slice().sort(cmp);
  }

  const list = await scanAllProjectsUnfiltered();
  _cache = { at: Date.now(), list };

  const filtered = list.filter(c => !isUnder(c.dir, excludeAbsDirs));
  return filtered.slice().sort(cmp);
}
