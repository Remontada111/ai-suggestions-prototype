// ai-codegen-extension/src/features.ts
// Bygger en stabil FeatureVector ovanpå dina heuristiska signaler.
// - Inga beroenden på VS Code-API
// - Säker och snabb; valfri filräkning kan stängas av
// - FEATURE_ORDER är den enda sanningen för fältordning

import * as path from "node:path";
import * as fs from "node:fs";
import fg from "fast-glob";

/** Konfiguration för snabb globbning (matchar din detektor) */
const IGNORE = [
  "**/node_modules/**","**/dist/**","**/build/**","**/out/**","**/.next/**",
  "**/.svelte-kit/**","**/.output/**","**/.git/**","**/coverage/**",
  "**/.venv/**","**/venv/**","**/__pycache__/**","**/dist-webview/**",
];

/** Frontend-/backend-deps (kompakt lista för feature-beräkning) */
const FRONT_DEPS = [
  "react","react-dom","vue","nuxt","next","@angular/core","@sveltejs/kit",
  "vite","remix","@remix-run/dev","solid-start","astro"
];
const BACK_DEPS = ["express","fastify","koa","nestjs"];

/** Hjälp: safe dep-check (case-insensitivt) */
function makeDepSet(pkg: any): Set<string> {
  const d = {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
    ...(pkg?.peerDependencies || {}),
  };
  return new Set(Object.keys(d).map((k) => k.toLowerCase()));
}
function hasAny(depSet: Set<string>, names: string[]): boolean {
  for (const n of names) if (depSet.has(n.toLowerCase())) return true;
  return false;
}

/** Signal-ingångar (från din detektor) */
export type HtmlIntent = {
  score: number;
  hints: string[];            // t.ex. ["html@root","html#app","html@vite","html@likely-harness"]
};
export type DomIntent = {
  score: number;
  hints: string[];            // t.ex. ["dom:react","dom:vue","dom:svelte","dom:#app"]
};

export type BuildFeatureInputs = {
  dir: string;                // kandidatens katalog
  pkg: any | null;            // package.json som objekt (kan vara null)
  configHints: string[];      // t.ex. ["vite.config.ts","next.config.js", ...]
  entryHtml?: string;         // relativ html, t.ex. "index.html" eller "public/index.html"
  entryFile?: string;         // relativ entry-fil, t.ex. "src/main.tsx"
  heuristicBaseScore: number; // resultat från din scoreCandidate (innan html/dom-extras)
  htmlIntent: HtmlIntent;     // från inspectHtmlIntent
  domIntent: DomIntent;       // från inspectEntryDom
};

/** Själva feature-vektorn som matas till ML-modellen */
export type FeatureVector = {
  // binära
  hasDevScript: number;
  hasKnownDevServer: number;
  hasViteConfig: number;
  hasNextConfig: number;
  hasSvelteConfig: number;
  hasNuxtConfig: number;
  hasRemixConfig: number;
  hasSolidConfig: number;
  hasAstroConfig: number;
  hasAngularJson: number;
  hasWebpackConfig: number;

  hasReactDep: number;
  hasVueDep: number;
  hasAngularDep: number;
  hasSvelteKitDep: number;
  hasViteDep: number;
  hasNextDep: number;
  hasNuxtDep: number;
  hasAstroDep: number;
  hasRemixDep: number;
  hasSolidStartDep: number;

  hasNodeModulesWithFrontendDeps: number;
  htmlAtRoot: number;
  htmlAtPublic: number;
  htmlLikelyHarness: number;
  domSignalReact: number;
  domSignalVue: number;
  domSignalSvelte: number;
  domSignalAngular: number;
  domSignalAppDiv: number;
  projectNameIntent: number;
  backendHeavy: number;

  // heltal / skalära
  numConfigHints: number;
  dirDepth: number;
  numHtmlFiles: number;
  numTsxJsxFiles: number;

  heuristicBaseScore: number;
  htmlIntentScore: number;
  domIntentScore: number;
};

/** Stabil ordning – använd överallt (träning och inferens) */
export const FEATURE_ORDER: (keyof FeatureVector)[] = [
  "hasDevScript","hasKnownDevServer",
  "hasViteConfig","hasNextConfig","hasSvelteConfig","hasNuxtConfig","hasRemixConfig","hasSolidConfig","hasAstroConfig","hasAngularJson","hasWebpackConfig",
  "hasReactDep","hasVueDep","hasAngularDep","hasSvelteKitDep","hasViteDep","hasNextDep","hasNuxtDep","hasAstroDep","hasRemixDep","hasSolidStartDep",
  "hasNodeModulesWithFrontendDeps","htmlAtRoot","htmlAtPublic","htmlLikelyHarness",
  "domSignalReact","domSignalVue","domSignalSvelte","domSignalAngular","domSignalAppDiv",
  "projectNameIntent","backendHeavy",
  "numConfigHints","dirDepth","numHtmlFiles","numTsxJsxFiles",
  "heuristicBaseScore","htmlIntentScore","domIntentScore",
];

/** Konvertera vektor till array i rätt ordning */
export function toArray(v: FeatureVector): number[] {
  return FEATURE_ORDER.map((k) => Number((v as any)[k] ?? 0));
}

/** Valfria prestanda-inställningar */
export type FeatureBuildOptions = {
  computeCounts?: boolean;    // om true räknar vi html/tsx/jsx (default: true men med cap)
  countCap?: number;          // max antal filer att räkna innan tidigt avbrott (default: 1500)
};

const DEFAULT_OPTS: FeatureBuildOptions = {
  computeCounts: true,
  countCap: 1500,
};

/** Snabb räknare med cap (för att undvika tunga globbar) */
function safeCount(cwd: string, pattern: string | string[], cap: number): number {
  try {
    const it = fg.sync(pattern, { cwd, absolute: false, dot: false, ignore: IGNORE, onlyFiles: true, unique: true });
    return it.length > cap ? cap : it.length;
  } catch {
    return 0;
  }
}

/** Kollar om script innehåller känd dev-server */
function hasKnownDevServerScript(scripts: Record<string, string>): boolean {
  const rx = /\b(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|ng\s+serve|storybook|expo)\b/i;
  return Object.values(scripts || {}).some((v) => rx.test(String(v || "")));
}

/** Bygg FeatureVector från heuristiska signaler */
export function buildFeatureVector(input: BuildFeatureInputs, opts?: FeatureBuildOptions): FeatureVector {
  const o = { ...DEFAULT_OPTS, ...(opts || {}) };
  const dir = input.dir;
  const pkg = input.pkg || {};
  const scripts: Record<string,string> = pkg?.scripts || {};
  const depSet = makeDepSet(pkg);

  // script-flaggor
  const hasDevScript = ["dev","start","serve","preview"].some((k) => !!scripts[k]);
  const hasKnownDevServer = hasKnownDevServerScript(scripts);

  // config-hints (från din detektor)
  const hints = new Set((input.configHints || []).map((s) => s.toLowerCase()));
  const hasViteConfig    = [...hints].some(h => h.startsWith("vite.config"));
  const hasNextConfig    = [...hints].some(h => h.startsWith("next.config"));
  const hasSvelteConfig  = [...hints].some(h => h.startsWith("svelte.config"));
  const hasNuxtConfig    = [...hints].some(h => h.startsWith("nuxt.config"));
  const hasRemixConfig   = [...hints].some(h => h.startsWith("remix.config"));
  const hasSolidConfig   = [...hints].some(h => h.startsWith("solid.config"));
  const hasAstroConfig   = [...hints].some(h => h.startsWith("astro.config"));
  const hasAngularJson   = hints.has("angular.json");
  const hasWebpackConfig = [...hints].some(h => h.startsWith("webpack"));

  // dep-flaggor
  const hasReactDep      = depSet.has("react");
  const hasVueDep        = depSet.has("vue") || depSet.has("nuxt");
  const hasAngularDep    = depSet.has("@angular/core");
  const hasSvelteKitDep  = depSet.has("@sveltejs/kit");
  const hasViteDep       = depSet.has("vite");
  const hasNextDep       = depSet.has("next");
  const hasNuxtDep       = depSet.has("nuxt");
  const hasAstroDep      = depSet.has("astro");
  const hasRemixDep      = depSet.has("remix") || depSet.has("@remix-run/dev");
  const hasSolidStartDep = depSet.has("solid-start");

  // node_modules + front-deps
  const hasNodeModulesWithFrontendDeps =
    fs.existsSync(path.join(dir, "node_modules")) && hasAny(depSet, FRONT_DEPS) ? 1 : 0;

  // HTML-intent
  const entryHtml = (input.entryHtml || "").replace(/\\/g, "/").toLowerCase();
  const htmlAtRoot = entryHtml === "index.html" ? 1 : 0;
  const htmlAtPublic = entryHtml === "public/index.html" ? 1 : 0;

  const htmlHints = new Set((input.htmlIntent?.hints || []).map((s) => s.toLowerCase()));
  // robust sätt: använd hinten om den finns, annars heuristik baserad på pathen
  const likelyHarnessFromHint = htmlHints.has("html@likely-harness");
  const likelyHarnessFromPath = /(\/|^)(src|test|tests|__tests__|example|examples|demo|demos|tools|scripts)\/index\.html$/i.test(entryHtml);
  const htmlLikelyHarness = (likelyHarnessFromHint || likelyHarnessFromPath) ? 1 : 0;

  // DOM-intent
  const domHints = new Set((input.domIntent?.hints || []).map((s) => s.toLowerCase()));
  const domSignalReact   = domHints.has("dom:react") ? 1 : 0;
  const domSignalVue     = domHints.has("dom:vue") || domHints.has("dom:vue2") ? 1 : 0;
  const domSignalSvelte  = domHints.has("dom:svelte") ? 1 : 0;
  const domSignalAngular = domHints.has("dom:angular") ? 1 : 0;
  const domSignalAppDiv  = domHints.has("dom:#app") ? 1 : 0;

  // namnintent
  const base = path.basename(dir).toLowerCase();
  const projectNameIntent = /(^|[-_/])(frontend|web|client|app)([-_/]|$)/i.test(base) ? 1 : 0;

  // backend-tyngd
  const backendHeavy = (hasAny(depSet, BACK_DEPS) && !hasAny(depSet, FRONT_DEPS)) ? 1 : 0;

  // räkna konfigurer och djup
  const numConfigHints = input.configHints?.length || 0;
  const dirDepth = path.resolve(dir).split(path.sep).length;

  // valfria filräkningar (capsade)
  let numHtmlFiles = 0;
  let numTsxJsxFiles = 0;
  if (o.computeCounts) {
    numHtmlFiles = safeCount(dir, "**/*.html", o.countCap!);
    numTsxJsxFiles = safeCount(dir, ["**/*.tsx","**/*.jsx"], o.countCap!);
  }

  const fv: FeatureVector = {
    // scripts/konfig
    hasDevScript: hasDevScript ? 1 : 0,
    hasKnownDevServer: hasKnownDevServer ? 1 : 0,
    hasViteConfig: hasViteConfig ? 1 : 0,
    hasNextConfig: hasNextConfig ? 1 : 0,
    hasSvelteConfig: hasSvelteConfig ? 1 : 0,
    hasNuxtConfig: hasNuxtConfig ? 1 : 0,
    hasRemixConfig: hasRemixConfig ? 1 : 0,
    hasSolidConfig: hasSolidConfig ? 1 : 0,
    hasAstroConfig: hasAstroConfig ? 1 : 0,
    hasAngularJson: hasAngularJson ? 1 : 0,
    hasWebpackConfig: hasWebpackConfig ? 1 : 0,

    // deps
    hasReactDep: hasReactDep ? 1 : 0,
    hasVueDep: hasVueDep ? 1 : 0,
    hasAngularDep: hasAngularDep ? 1 : 0,
    hasSvelteKitDep: hasSvelteKitDep ? 1 : 0,
    hasViteDep: hasViteDep ? 1 : 0,
    hasNextDep: hasNextDep ? 1 : 0,
    hasNuxtDep: hasNuxtDep ? 1 : 0,
    hasAstroDep: hasAstroDep ? 1 : 0,
    hasRemixDep: hasRemixDep ? 1 : 0,
    hasSolidStartDep: hasSolidStartDep ? 1 : 0,

    // miljö / html / dom / namn
    hasNodeModulesWithFrontendDeps,
    htmlAtRoot,
    htmlAtPublic,
    htmlLikelyHarness,
    domSignalReact,
    domSignalVue,
    domSignalSvelte,
    domSignalAngular,
    domSignalAppDiv,
    projectNameIntent,
    backendHeavy,

    // räkne-/skalärfeatures
    numConfigHints,
    dirDepth,
    numHtmlFiles,
    numTsxJsxFiles,

    // heuristik-scorer
    heuristicBaseScore: input.heuristicBaseScore ?? 0,
    htmlIntentScore: input.htmlIntent?.score ?? 0,
    domIntentScore: input.domIntent?.score ?? 0,
  };

  return fv;
}
