// src/commands/exportDataset.ts
// Exporterar dataset.jsonl för ML-träning genom att skanna workspace.
// - Bygger features via src/ml/features.ts
// - Sätter konservativa bootstrap-labels (1/0) för första träningsrundan
// - Sparar till ml_artifacts/dataset.jsonl

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import fg from "fast-glob";

import { buildFeatureVector, type HtmlIntent, type DomIntent, toArray } from "../ml/features";

// --- Lokala hjälpare (kopior i miniformat av detektorlogiken för att vara självständig) ---

const IGNORE_GLOBS =
  "**/{node_modules,dist,dist-webview,build,out,.next,.svelte-kit,.output,.git,coverage,.venv,venv,__pycache__}/**";

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function readText(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

// Hitta typiska SPA-entryfiler
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

// Intent-medveten HTML-sökning
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

// HTML-intent (kort)
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
    const src = m[1].replace(/^\.\//, "");
    hints.push(`html:script=${src}`);
    if (/\.(jsx?|tsx?)$/i.test(src)) score += 2;
    if (/\.ts$/i.test(src)) { score -= 2; hints.push("ts-in-html"); }
    const p = path.join(dir, src);
    if (fs.existsSync(p)) { hints.push("entry:from-html"); score += 1; }
  }
  return { score, hints };
}

// DOM-intent (kort)
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
  for (const [rx, tag, pts] of tests) {
    if (rx.test(code)) { score += pts; hints.push(tag); }
  }
  return { score, hints };
}

// En enkel bas-heuristikscore (samma kärna som i detektorn, komprimerad)
function basicHeuristicScore(dir: string, pkg: any, configHints: string[], entryHtml?: string, entryFile?: string) {
  let s = 0;
  const scripts = pkg?.scripts || {};
  const deps = { ...(pkg?.dependencies||{}), ...(pkg?.devDependencies||{}), ...(pkg?.peerDependencies||{}) };
  const has = (...names: string[]) => names.some(n => Object.prototype.hasOwnProperty.call(deps, n));
  const base = path.basename(dir).toLowerCase();

  const devKey = ["dev","start","serve","preview"].find(k => scripts[k]);
  if (devKey) s += 8;
  if (devKey && /\b(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|ng\s+serve|storybook|expo)\b/i.test(String(scripts[devKey]))) s += 3;

  if (configHints.length) s += Math.min(6, configHints.length * 3);
  if (has("next","@sveltejs/kit","vue","nuxt","@angular/core","remix","solid-start","astro") || has("react") || has("vite")) s += 6;

  if (fs.existsSync(path.join(dir, "node_modules")) && (has("react","vue","nuxt","next","@angular/core","@sveltejs/kit","vite","astro","remix","solid-start"))) s += 4;

  if (entryHtml) s += (entryHtml.toLowerCase() === "index.html") ? 6 : 3;
  if (entryFile) s += 2;

  if (/(^|[-_/])(frontend|web|client|app)([-_/]|$)/i.test(base)) s += 2;

  if ((has("express","fastify","koa","nestjs")) && !(has("react","vue","nuxt","next","@angular/core","@sveltejs/kit","vite","astro","remix","solid-start"))) s -= 4;

  const depth = path.resolve(dir).split(path.sep).length;
  if (depth > 6) s -= 1;

  return s;
}

// Upptäck konfigurationsfiler
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
  for (const n of names) if (fs.existsSync(path.join(dir, n))) hits.push(n);
  return hits;
}

// Bootstrap-label (konservativ):
// 1 (frontend)  om (dev-script eller root-index.html) OCH (dom-signal eller configHint eller front-dep) OCH inte likely harness.
// 0 (ej frontend) om backend-heavy signaler + likely harness + avsaknad av dom/config/deps.
// annars: undefined (hoppa över raden).
function bootstrapLabel(dir: string, pkg: any, configHints: string[], htmlIntent: HtmlIntent, domIntent: DomIntent, baseScore: number): 0 | 1 | undefined {
  const scripts = pkg?.scripts || {};
  const deps = { ...(pkg?.dependencies||{}), ...(pkg?.devDependencies||{}), ...(pkg?.peerDependencies||{}) };
  const has = (...names: string[]) => names.some(n => Object.prototype.hasOwnProperty.call(deps, n));

  const hasDevScript = ["dev","start","serve","preview"].some(k => !!scripts[k]);
  const htmlAtRoot = htmlIntent.hints.includes("html@root");
  const frontDep = has("react","vue","nuxt","next","@angular/core","@sveltejs/kit","vite","astro","remix","solid-start");
  const hasConfig = configHints.length > 0;
  const hasDom = domIntent.hints.length > 0;
  const likelyHarness = htmlIntent.hints.includes("html@likely-harness");
  const backendHeavy = (has("express","fastify","koa","nestjs") && !frontDep);

  // positiv
  if ((hasDevScript || htmlAtRoot) && (hasDom || hasConfig || frontDep) && !likelyHarness && baseScore >= 10) {
    return 1;
  }
  // negativ
  if (backendHeavy && likelyHarness && !hasDom && !hasConfig && !frontDep) {
    return 0;
  }
  return undefined;
}

// --- Själva kommandot ---

export async function exportDatasetCommand() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showWarningMessage("Inga workspace-mappar öppna.");
    return;
  }

  const outDir = path.resolve(vscode.workspace.workspaceFolders![0].uri.fsPath, "ml_artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "dataset.jsonl");

  const dirs = new Set<string>();
  for (const f of folders) {
    // Sök package.json
    const pkgUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(f, "**/package.json"),
      new vscode.RelativePattern(f, IGNORE_GLOBS),
      2000
    );
    for (const uri of pkgUris) dirs.add(path.dirname(uri.fsPath));

    // HTML-fallback
    const htmlUris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(f, "**/*.html"),
      new vscode.RelativePattern(f, IGNORE_GLOBS),
      1000
    );
    for (const uri of htmlUris) dirs.add(path.dirname(uri.fsPath));
  }

  let written = 0, skipped = 0;
  const stream = fs.createWriteStream(outPath, { flags: "w", encoding: "utf8" });

  for (const dir of dirs) {
    try {
      const pkgPath = path.join(dir, "package.json");
      const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : null;

      const configHints = detectConfigs(dir);
      const entryHtml = await findAnyHtmlDeep(dir);
      const entryFile = findEntryFile(dir);

      const htmlIntent: HtmlIntent = entryHtml ? inspectHtmlIntent(dir, entryHtml) : { score: 0, hints: [] };
      const domIntent: DomIntent = inspectEntryDom(dir, entryFile);

      const baseScore = basicHeuristicScore(dir, pkg, configHints, entryHtml, entryFile);

      const fv = buildFeatureVector({
        dir, pkg, configHints,
        entryHtml, entryFile,
        heuristicBaseScore: baseScore,
        htmlIntent, domIntent,
      });

      const label = bootstrapLabel(dir, pkg, configHints, htmlIntent, domIntent, baseScore);
      if (label === undefined) { skipped++; continue; }

      const row = {
        features: toArray(fv),
        label,
        meta: { dir },
      };
      stream.write(JSON.stringify(row) + "\n");
      written++;
    } catch (e) {
      // fortsätt även om en katalog fallerar
      console.warn("[exportDataset] fel i", dir, e);
    }
  }

  stream.end();
  vscode.window.showInformationMessage(`Export klar: ${written} rader till ${outPath} (skippade: ${skipped}).`);
}
