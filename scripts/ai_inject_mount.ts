// scripts/ai_inject_mount.ts
/**
 * Robust injector for mounting JSX at the AI-INJECT-MOUNT anchor in a TSX entry file.
 *
 * Usage (from repo root):
 *   node --import tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath> [append]
 *   # fallback on older Node (may warn on Node ≥20):
 *   node --loader tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath> [append]
 *
 * Behavior:
 * - Ensures an import for <importName> from <importPath> exists (default vs named based on target file if resolvable).
 * - Never deletes previous imports. If the identifier is already used from another specifier, a unique alias is created.
 * - Replaces AI-INJECT-MOUNT with an idempotent BEGIN/END region and injects JSX.
 * - In "append" mode, new JSX is appended as a new tile in a grid so previous tiles remain visible.
 * - If no grid exists inside the anchor, a grid wrapper is created automatically.
 * - Minimal edits. Adds a separate import line when safer than rewriting.
 *
 * Debug:
 *   Set AI_INJECT_DEBUG=1 to print trace logs.
 *   Set AI_INJECT_APPEND=1 to force append mode.
 */

import fs from 'node:fs';
import path from 'node:path';

type ImportStyle = 'default' | 'named';
type AnchorSingle = { kind: 'single'; start: number; end: number; indent: string };
type AnchorPaired = {
  kind: 'paired';
  beginStart: number;
  beginEnd: number;
  endStart: number;
  endEnd: number;
  indent: string;
};
type Anchor = AnchorSingle | AnchorPaired;

const DEBUG = process.env.AI_INJECT_DEBUG === '1';
const dbg = (...a: any[]) => {
  if (DEBUG) console.log('[ai_inject_mount:dbg]', ...a);
};

function fail(msg: string, code = 1): never {
  console.error(`[ai_inject_mount] ${msg}`);
  process.exit(code);
}

function readFileUtf8(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e: any) {
    fail(`Cannot read file: ${p}\n${e?.message || e}`);
  }
}

function writeFileUtf8(p: string, data: string): void {
  try {
    fs.writeFileSync(p, data, 'utf8');
  } catch (e: any) {
    fail(`Cannot write file: ${p}\n${e?.message || e}`);
  }
}

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSpecifier(spec: string): string {
  return spec.trim();
}

function resolveModuleFile(fromFile: string, importPath: string): string | null {
  // Only resolve relative/absolute/file: paths. Leave bare specifiers alone.
  if (!importPath.startsWith('.') && !importPath.startsWith('/') && !importPath.startsWith('file:')) {
    return null;
  }
  const basedir = path.dirname(fromFile);
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(basedir, p));

  const hasExt = /\.(tsx?|jsx?)$/i.test(importPath);
  if (hasExt) add(importPath);

  const bases = [importPath];
  for (const base of bases) {
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) add(base + ext);
    for (const idxExt of ['.tsx', '.ts', '.jsx', '.js']) add(path.join(base, 'index' + idxExt));
  }

  for (const c of candidates) {
    if (fileExists(c)) return c;
  }
  return null;
}

function detectExportStyle(moduleFile: string, importName: string): ImportStyle | 'unknown' {
  if (!moduleFile || !fileExists(moduleFile)) return 'unknown';
  const code = readFileUtf8(moduleFile);

  // Default export?
  if (/\bexport\s+default\b/.test(code)) return 'default';

  // Named export with same symbol?
  const namedPatterns = [
    new RegExp(String.raw`\bexport\s+(const|let|var|function|class)\s+${importName}\b`),
    new RegExp(String.raw`\bexport\s*\{[^}]*\b${importName}\b[^}]*\}`),
    new RegExp(String.raw`\bexport\s+type\s+${importName}\b`),
  ];
  if (namedPatterns.some((re) => re.test(code))) return 'named';

  return 'unknown';
}

/** Checks whether a given local identifier is already imported from a specifier. */
function hasImportForLocal(code: string, localName: string, importPath: string): boolean {
  const spec = normalizeSpecifier(importPath);
  const reFrom = new RegExp(String.raw`import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\']`, 'g');

  let m: RegExpExecArray | null;
  while ((m = reFrom.exec(code))) {
    const clause = m[1] || '';
    // default presence using the local binding
    if (new RegExp(String.raw`(^|[,\s])${localName}(\s|,|$)`).test(clause)) return true;
    // named alias presence
    if (new RegExp(String.raw`\bas\s+${localName}(\s|,|$)`).test(clause)) return true;
  }
  return false;
}

/** Checks whether an identifier is imported from a different specifier than goodSpec. */
function hasIdentFromOtherSpec(code: string, ident: string, goodSpec: string): boolean {
  const re = new RegExp(String.raw`(^|\n)import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"];?`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const clause = m[2] || '';
    const spec = normalizeSpecifier(m[3] || '');
    const mentions =
      new RegExp(String.raw`(^|[,\s])${ident}(\s|,|$)`).test(clause) ||
      new RegExp(String.raw`\{[^}]*\b${ident}\b[^}]*\}`).test(clause) ||
      new RegExp(String.raw`\{[^}]*\bdefault\s+as\s+${ident}\b[^}]*\}`).test(clause);
    if (mentions && spec !== normalizeSpecifier(goodSpec)) return true;
  }
  return false;
}

/** Returns all locally bound identifiers from import clauses. */
function listImportedIdents(code: string): Set<string> {
  const ids = new Set<string>();
  const re = /(^|\n)import\s+([^;]*?)\s+from\s+['"][^'"]+['"];?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const clause = m[2] || '';
    const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
    if (def) ids.add(def);
    const named = /\{([^}]*)\}/.exec(clause)?.[1] || '';
    for (const t of named.split(',').map((s) => s.trim()).filter(Boolean)) {
      const alias =
        /as\s+([A-Za-z_$][\w$]*)$/.exec(t)?.[1] ||
        /^([A-Za-z_$][\w$]*)$/.exec(t)?.[1] ||
        null;
      if (alias) ids.add(alias);
    }
  }
  return ids;
}

function pickUnique(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function rewriteJsxIdent(jsx: string, from: string, to: string): string {
  if (from === to) return jsx;
  const open = new RegExp(`(<\\s*)${from}(\\b)`, 'g');
  const close = new RegExp(`(<\\/\\s*)${from}(\\b)`, 'g');
  return jsx.replace(open, `$1${to}$2`).replace(close, `$1${to}$2`);
}

function insertAfterLastImportFrom(code: string, spec: string, lineToInsert: string): string {
  const re = new RegExp(
    String.raw`(^|\n)(?<indent>[\t ]*)import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\'];?`,
    'g',
  );
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) lastIdx = re.lastIndex;
  if (lastIdx === -1) return insertAfterLastImportTop(code, lineToInsert);
  return code.slice(0, lastIdx) + `\n` + lineToInsert + code.slice(lastIdx);
}

function insertAfterLastImportTop(code: string, lineToInsert: string): string {
  // all import lines at top are matched including type-only and side-effect imports
  const importBlockRe = /^(?:[ \t]*import\b[^;]*;[ \t]*\r?\n)+/m;
  const m = importBlockRe.exec(code);
  if (m) {
    const insertPos = m.index + m[0].length;
    const needsFinalNL = m[0].endsWith('\n') ? '' : '\n';
    return code.slice(0, insertPos) + needsFinalNL + lineToInsert + '\n' + code.slice(insertPos);
  }
  return lineToInsert + '\n' + code;
}

function addOrAmendImport(code: string, chosen: ImportStyle, importName: string, importPath: string): string {
  const spec = normalizeSpecifier(importPath);
  if (hasImportForLocal(code, importName, spec)) {
    dbg('import already present for', importName, 'from', spec);
    return code;
  }

  // Find existing import-from lines for this specifier
  const importFromRe = new RegExp(
    String.raw`(^|\n)(?<indent>[\t ]*)import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\'];?`,
    'g',
  );
  const imports: { start: number; end: number; indent: string; clause: string }[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = importFromRe.exec(code))) {
    const start = mm.index + (mm[1] ? mm[1].length : 0);
    const end = importFromRe.lastIndex;
    const indent = mm.groups?.indent ?? '';
    const clause = mm[3] ?? '';
    imports.push({ start, end, indent, clause });
  }
  dbg('existing imports from spec', spec, imports.length);

  const newImportLine = (indent = '') =>
    `${indent}import ${chosen === 'named' ? `{ ${importName} }` : importName} from '${spec}';`;
  const newImportDefaultAliasViaNamed = (indent = '') =>
    `${indent}import { default as ${importName} } from '${spec}';`;

  if (imports.length > 0) {
    const indent = imports[0].indent;
    const anyHasDefault = imports.some((im) => /^\s*[A-Za-z_$][\w$]*/.test(im.clause));
    if (chosen === 'default' && anyHasDefault) {
      dbg('adding default-as alias import');
      return insertAfterLastImportFrom(code, spec, newImportDefaultAliasViaNamed(indent));
    }
    dbg('adding separate import line next to existing import-from');
    return insertAfterLastImportFrom(code, spec, newImportLine(indent));
  }

  dbg('inserting import at top block');
  return insertAfterLastImportTop(code, newImportLine());
}

function addImportWithAlias(
  code: string,
  chosen: ImportStyle,
  exportedName: string,
  localName: string,
  importPath: string,
): string {
  const spec = normalizeSpecifier(importPath);
  if (hasImportForLocal(code, localName, spec)) return code;

  const line = (indent = '') =>
    chosen === 'named'
      ? `${indent}import { ${exportedName} as ${localName} } from '${spec}';`
      : `${indent}import { default as ${localName} } from '${spec}';`;

  const re = new RegExp(
    String.raw`(^|\n)(?<indent>[\t ]*)import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\'];?`,
    'g',
  );
  const m = re.exec(code);
  if (m) return insertAfterLastImportFrom(code, spec, line(m.groups?.indent ?? ''));
  return insertAfterLastImportTop(code, line());
}

function findAnchor(code: string): Anchor | null {
  // Prefer paired region: {/* AI-INJECT-MOUNT:BEGIN */} ... {/* AI-INJECT-MOUNT:END */}
  const reBegin = /\{\/\*\s*AI-INJECT-MOUNT:BEGIN\s*\*\/\}/;
  const reEnd = /\{\/\*\s*AI-INJECT-MOUNT:END\s*\*\/\}/;
  const mb = reBegin.exec(code);
  if (mb) {
    reEnd.lastIndex = mb.index + mb[0].length;
    const me = reEnd.exec(code);
    if (me && me.index > mb.index) {
      const lineStart = code.lastIndexOf('\n', mb.index) + 1;
      const indent = (/^(\s*)/.exec(code.slice(lineStart, mb.index))?.[1]) ?? '';
      return {
        kind: 'paired',
        beginStart: mb.index,
        beginEnd: mb.index + mb[0].length,
        endStart: me.index,
        endEnd: me.index + me[0].length,
        indent,
      };
    }
  }

  // Fallback: single anchor comment (JSX, line, or block)
  const patterns = [
    /\{\/\*\s*AI-INJECT-MOUNT\s*\*\/\}/, // JSX comment node
    /\/\/[ \t]*AI-INJECT-MOUNT.*/, // line comment
    /\/\*[ \t]*AI-INJECT-MOUNT[ \t]*\*\//, // block comment
  ];
  for (const re of patterns) {
    const m = re.exec(code);
    if (m) {
      const lineStart = code.lastIndexOf('\n', m.index) + 1;
      const indent = (/^(\s*)/.exec(code.slice(lineStart, m.index))?.[1]) ?? '';
      return { kind: 'single', start: m.index, end: m.index + m[0].length, indent };
    }
  }
  return null;
}

function indentMultilineJsx(jsx: string, baseIndent: string): string {
  const lines = jsx.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 1) return lines[0].trim();

  const trimmed = lines.map((l) => l.trimEnd());
  const nonEmpty = trimmed.filter((l) => l.trim().length > 0);

  let minLead = Infinity;
  for (const l of nonEmpty) {
    const m = /^(\s*)/.exec(l);
    const lead = m ? m[1].length : 0;
    minLead = Math.min(minLead, lead);
  }
  const normalized = trimmed.map((l) => (l.length === 0 ? '' : l.slice(Math.min(minLead, l.length))));
  const indented = normalized.map((l, i) => (i === 0 ? l.trim() : baseIndent + l));
  return indented.join('\n');
}

function normalizeForDedupe(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** ───────────────────────────────────────────────────────
 * Grid support: append tiles instead of replacing content
 * Tile size follows 1280x800 viewport used by the app.
 * ─────────────────────────────────────────────────────── */
const GRID_ID = '__AI_MOUNT_GRID__' as const;

function hasGrid(code: string, beginEnd: number, endStart: number): boolean {
  const inner = code.slice(beginEnd, endStart);
  return /\bid=["']__AI_MOUNT_GRID__["']/.test(inner);
}

function makeTile(jsxIndented: string, indent: string): string {
  return (
    `\n${indent}<div className="relative w-[1280px] h-[800px] overflow-hidden rounded-md ring-1 ring-black/10 bg-white">` +
    `\n${indent}${jsxIndented}\n${indent}</div>`
  );
}

function wrapInnerWithGrid(code: string, anchor: AnchorPaired): { code: string; anchor: AnchorPaired } {
  const indent = anchor.indent;
  const existing = code.slice(anchor.beginEnd, anchor.endStart).trim();
  const open = `\n${indent}<div id="${GRID_ID}" className="flex flex-wrap gap-4 items-start">`;
  const close = `\n${indent}</div>\n${indent}`;
  const wrapped =
    open +
    (existing
      ? `\n${indent}<div className="relative w-[1280px] h-[800px] overflow-hidden rounded-md ring-1 ring-black/10 bg-white">\n${indent}${existing}\n${indent}</div>`
      : '') +
    close;
  const next = code.slice(0, anchor.beginEnd) + wrapped + code.slice(anchor.endStart);
  const a2 = findAnchor(next);
  if (!a2 || a2.kind !== 'paired') fail('Failed to re-find anchor after wrapping with grid.');
  return { code: next, anchor: a2 as AnchorPaired };
}

function main(): void {
  const [, , mainFileArg, importNameArg, importPathArg, jsxFileArg] = process.argv;
  const modeArg = (process.argv[6] || '').toLowerCase();
  const APPEND = modeArg === 'append' || process.env.AI_INJECT_APPEND === '1';

  if (!mainFileArg || !importNameArg || !importPathArg || !jsxFileArg) {
    fail(
      'Usage: node --import tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath> [append]',
    );
  }

  const mainFile = path.resolve(process.cwd(), mainFileArg);
  const importName = importNameArg.trim();
  const importPath = importPathArg.trim();
  const jsxFile = path.resolve(process.cwd(), jsxFileArg);

  dbg('argv', { mainFile, importName, importPath, jsxFile, APPEND });

  if (!fileExists(mainFile)) fail(`main file does not exist: ${mainFile}`);
  if (!fileExists(jsxFile)) fail(`jsx temp file does not exist: ${jsxFile}`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(importName)) fail(`importName must be a PascalCase identifier: ${importName}`);

  const originalCode = readFileUtf8(mainFile);
  let jsx = readFileUtf8(jsxFile).trim();
  if (!jsx) fail('jsx is empty');

  const resolvedModule = resolveModuleFile(mainFile, importPath);
  dbg('resolvedModule', resolvedModule);

  // Refuse importing the component from main.tsx
  if (resolvedModule && path.resolve(resolvedModule) === path.resolve(mainFile)) {
    fail('Refusing to import component from main.tsx');
  }

  const styleDetected = detectExportStyle(resolvedModule || '', importName);
  dbg('exportStyle', styleDetected);
  const chosen: ImportStyle = styleDetected === 'named' ? 'named' : 'default';

  // Start with original code
  let nextCode = originalCode;

  // Determine effective local name and alias if the identifier is already taken by another specifier
  const taken = listImportedIdents(nextCode);
  let effectiveName = importName;

  if (!hasImportForLocal(nextCode, importName, importPath) && taken.has(importName)) {
    // 'importName' already bound from some import; pick a free alias and rewrite JSX
    effectiveName = pickUnique(importName, taken);
    jsx = rewriteJsxIdent(jsx, importName, effectiveName);
    dbg('alias due to taken ident', { importName, effectiveName });
  } else if (hasIdentFromOtherSpec(nextCode, importName, importPath)) {
    // Name used by another specifier; alias our new import
    effectiveName = pickUnique(importName, taken);
    jsx = rewriteJsxIdent(jsx, importName, effectiveName);
    dbg('alias due to other spec', { importName, effectiveName });
  }

  // Ensure desired import exists (with alias if needed). Never delete existing imports.
  if (effectiveName === importName) {
    nextCode = addOrAmendImport(nextCode, chosen, importName, importPath);
  } else {
    nextCode = addImportWithAlias(nextCode, chosen, importName, effectiveName, importPath);
  }

  // 3) Anchor handling: prefer paired region, else upgrade single anchor to paired
  let anchor = findAnchor(nextCode);
  dbg('anchor', anchor);
  if (!anchor) fail('Could not find AI-INJECT-MOUNT anchor or BEGIN/END markers in main file.');

  const BEGIN = '{/* AI-INJECT-MOUNT:BEGIN */}';
  const END = '{/* AI-INJECT-MOUNT:END */}';

  const jsxIndented = indentMultilineJsx(jsx, (anchor as any).indent);
  const jsxNorm = normalizeForDedupe(jsxIndented);

  if (anchor.kind === 'paired') {
    // Ensure grid wrapper exists
    if (!hasGrid(nextCode, anchor.beginEnd, anchor.endStart)) {
      const res = wrapInnerWithGrid(nextCode, anchor);
      nextCode = res.code;
      anchor = res.anchor;
    }

    const innerStart = anchor.beginEnd;
    const innerEnd = anchor.endStart;
    const innerRegion = nextCode.slice(innerStart, innerEnd);
    const innerRegionNorm = normalizeForDedupe(innerRegion);
    const tile = makeTile(jsxIndented, anchor.indent);
    const tileNorm = normalizeForDedupe(tile);

    if (APPEND) {
      // Append before grid close if not already present
      if (!innerRegionNorm.includes(tileNorm) && !innerRegionNorm.includes(jsxNorm)) {
        const gridCloseRel = innerRegion.lastIndexOf('</div>');
        if (gridCloseRel < 0) fail('Grid closing tag not found inside anchor region.');
        const gridCloseAbs = innerStart + gridCloseRel;
        nextCode = nextCode.slice(0, gridCloseAbs) + tile + nextCode.slice(gridCloseAbs);
      } else {
        console.log('[ai_inject_mount] No changes needed (duplicate JSX skipped).');
        writeFileUtf8(mainFile, nextCode);
        process.exit(0);
      }
    } else {
      // Replace inner region content with single-tile grid
      const open = `\n${anchor.indent}<div id="${GRID_ID}" className="flex flex-wrap gap-4 items-start">`;
      const close = `\n${anchor.indent}</div>\n${anchor.indent}`;
      const single = open + makeTile(jsxIndented, anchor.indent) + close;
      nextCode = nextCode.slice(0, anchor.beginEnd) + single + nextCode.slice(anchor.endStart);
    }
  } else {
    // Single anchor → paired + grid with one tile
    const before = nextCode.slice(0, anchor.start);
    const after = nextCode.slice(anchor.end);
    const block =
      `${BEGIN}\n${anchor.indent}<div id="${GRID_ID}" className="flex flex-wrap gap-4 items-start">` +
      makeTile(jsxIndented, anchor.indent) +
      `\n${anchor.indent}</div>\n${anchor.indent}${END}`;
    nextCode = before + block + after;
  }

  if (nextCode === originalCode) {
    console.log('[ai_inject_mount] No changes needed.');
    process.exit(0);
  }

  writeFileUtf8(mainFile, nextCode);
  if (DEBUG) console.log('[ai_inject_mount:dbg] write ok');
  console.log('[ai_inject_mount] Injection complete.');
}

main();
