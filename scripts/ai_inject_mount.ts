// scripts/ai_inject_mount.ts
/**
 * Instrumented injector for mounting JSX at the AI-INJECT-MOUNT anchor in a TSX entry file.
 *
 * Usage (from repo root):
 *   AI_INJECT_DEBUG=1 node --import tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath> [replace]
 *   # fallback:
 *   AI_INJECT_DEBUG=1 node --loader tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath> [replace]
 *
 * What’s new here:
 * - Verbose DEBUG logs that print EXACT reasons why imports stay or get pruned.
 * - Prunes dead relative imports (file missing). Now robust for CRLF and side-effect imports.
 * - Prunes unused AI component imports (under components/ai) even if file exists.
 * - In replace-mode, prunes all other AI imports except the current one.
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

type ImportInfo = {
  start: number;
  end: number;
  indent: string;
  clause: string;
  spec: string;
  locals: string[];
  usedInJsx: boolean;
  isAi: boolean;
  isRelative: boolean;
  resolvedPath: string | null;
  existsOnDisk: boolean | null;
};

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
  // robust jämförelse oavsett OS och extra whitespace
  return spec.trim().replace(/\\/g, '/');
}

function resolveModuleFile(fromFile: string, importPath: string): string | null {
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

  if (/\bexport\s+default\b/.test(code)) return 'default';

  const namedPatterns = [
    new RegExp(String.raw`\bexport\s+(const|let|var|function|class)\s+${importName}\b`),
    new RegExp(String.raw`\bexport\s*\{[^}]*\b${importName}\b[^}]*\}`),
    new RegExp(String.raw`\bexport\s+type\s+${importName}\b`),
  ];
  if (namedPatterns.some((re) => re.test(code))) return 'named';

  return 'unknown';
}

function hasImportForLocal(code: string, localName: string, importPath: string): boolean {
  const spec = normalizeSpecifier(importPath);
  const reFrom = new RegExp(String.raw`import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\']`, 'g');

  let m: RegExpExecArray | null;
  while ((m = reFrom.exec(code))) {
    const clause = m[1] || '';
    if (new RegExp(String.raw`(^|[,\s])${localName}(\s|,|$)`).test(clause)) return true;
    if (new RegExp(String.raw`\bas\s+${localName}(\s|,|$)`).test(clause)) return true;
  }
  return false;
}

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
    dbg('skip add import: already present', { importName, spec });
  } else {
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

    const newImportLine = (indent = '') =>
      `${indent}import ${chosen === 'named' ? `{ ${importName} }` : importName} from '${spec}';`;
    const newImportDefaultAliasViaNamed = (indent = '') =>
      `${indent}import { default as ${importName} } from '${spec}';`;

    if (imports.length > 0) {
      const indent = imports[0].indent;
      const anyHasDefault = imports.some((im) => /^\s*[A-Za-z_$][\w$]*/.test(im.clause));
      if (chosen === 'default' && anyHasDefault) {
        dbg('add import: default-as alias', { spec, importName });
        code = insertAfterLastImportFrom(code, spec, newImportDefaultAliasViaNamed(indent));
      } else {
        dbg('add import: separate line', { spec, importName, style: chosen });
        code = insertAfterLastImportFrom(code, spec, newImportLine(indent));
      }
    } else {
      dbg('add import: top block', { spec, importName, style: chosen });
      code = insertAfterLastImportTop(code, newImportLine());
    }
  }
  return code;
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
  if (m) {
    dbg('add alias import next to existing', { spec, exportedName, localName, style: chosen });
    return insertAfterLastImportFrom(code, spec, line(m.groups?.indent ?? ''));
  }
  dbg('add alias import at top', { spec, exportedName, localName, style: chosen });
  return insertAfterLastImportTop(code, line());
}

function findAnchor(code: string): Anchor | null {
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
  const patterns = [
    /\{\/\*\s*AI-INJECT-MOUNT\s*\*\/\}/,
    /\/\/[ \t]*AI-INJECT-MOUNT.*/,
    /\/\*[ \t]*AI-INJECT-MOUNT[ \t]*\*\//,
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
  const open = `\n${indent}<div id="__AI_MOUNT_GRID__" className="flex flex-wrap gap-4 items-start">`;
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

function findGridInsertionIndex(code: string, anchor: AnchorPaired): number {
  const inner = code.slice(anchor.beginEnd, anchor.endStart);
  const openRe = /<div\s+[^>]*id=["']__AI_MOUNT_GRID__["'][^>]*>/i;
  const m = openRe.exec(inner);
  if (!m) fail('Grid open tag not found inside anchor region.');

  let i = m.index + m[0].length;
  let depth = 1;

  while (i < inner.length) {
    const nextOpen = inner.indexOf('<div', i);
    const nextClose = inner.indexOf('</div>', i);

    if (nextClose === -1) fail('Grid closing tag not found inside anchor region.');

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) {
        return anchor.beginEnd + nextClose;
      }
      i = nextClose + 6;
    }
  }
  fail('Unbalanced <div> tags in grid region.');
}

function tileKeyFor(importPath: string, effectiveName: string): string {
  const spec = normalizeSpecifier(importPath);
  const base = spec || effectiveName;
  return `AI-TILE:${base}`;
}

function replaceMarkedTile(
  code: string,
  anchor: AnchorPaired,
  key: string,
  newTileContent: string,
): { code: string; replaced: boolean } {
  const inner = code.slice(anchor.beginEnd, anchor.endStart);
  const open = `{/* ${escapeRegex(key)}:BEGIN */}`;
  const close = `{/* ${escapeRegex(key)}:END */}`;

  const openIdx = inner.indexOf(open);
  if (openIdx === -1) return { code, replaced: false };
  const afterOpen = openIdx + open.length;
  const closeIdx = inner.indexOf(close, afterOpen);
  if (closeIdx === -1) return { code, replaced: false };

  const absOpen = anchor.beginEnd + openIdx;
  const absClose = anchor.beginEnd + closeIdx;

  const updated =
    code.slice(0, absOpen) +
    open +
    newTileContent +
    close +
    code.slice(absClose + close.length);

  return { code: updated, replaced: true };
}

function parseImportLocals(clause: string): string[] {
  const locals: string[] = [];
  const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
  if (def) locals.push(def);
  const named = /\{([^}]*)\}/.exec(clause)?.[1] || '';
  for (const t of named.split(',').map((s) => s.trim()).filter(Boolean)) {
    const alias =
      /as\s+([A-Za-z_$][\w$]*)$/.exec(t)?.[1] ||
      /^([A-Za-z_$][\w$]*)$/.exec(t)?.[1] ||
      null;
    if (alias) locals.push(alias);
  }
  return locals;
}

function snapshotImports(tag: string, code: string, mainFile: string): ImportInfo[] {
  const re = /(^|\n)(?<indent>[ \t]*)import\s+([^;]*?)\s+from\s+['"](?<spec>[^'"]+)['"]\s*;?/g;
  const infos: ImportInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = re.lastIndex;
    const indent = m.groups?.indent ?? '';
    const clause = m[3] || '';
    const spec = m.groups?.spec || '';
    const locals = parseImportLocals(clause);
    const usedInJsx = locals.some((id) => new RegExp(String.raw`<\s*${id}\b|<\/\s*${id}\b`).test(code));
    const isAi =
      spec.includes('/components/ai/') ||
      spec.startsWith('./components/ai/') ||
      spec.startsWith('../components/ai/');
    const isRelative = spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:');
    const resolvedPath = isRelative ? resolveModuleFile(mainFile, spec) : null;
    const existsOnDisk = isRelative ? !!resolvedPath : null;

    infos.push({ start, end, indent, clause, spec, locals, usedInJsx, isAi, isRelative, resolvedPath, existsOnDisk });
  }
  dbg(`IMPORTS:${tag}`, infos.map(i => ({
    spec: i.spec,
    locals: i.locals,
    usedInJsx: i.usedInJsx,
    ai: i.isAi,
    relative: i.isRelative,
    resolved: i.resolvedPath,
    exists: i.existsOnDisk
  })));
  return infos;
}

/**
 * Robust prune: tar bort både "import X from './...'" och "import './...'" när filen saknas.
 * Tål CRLF.
 */
function pruneDeadRelativeImports(code: string, mainFile: string): string {
  const re = /(^|\r?\n)(?<indent>[ \t]*)import\s+(?:([^;]*?)\s+from\s+['"](?<spec>[^'"]+)['"]|['"](?<spec2>[^'"]+)['"])\s*;?/g;
  let out = '';
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = re.lastIndex;
    const rawSpec = m.groups?.spec ?? m.groups?.spec2 ?? '';
    const spec = normalizeSpecifier(rawSpec);
    let drop = false;

    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) {
      const resolved = resolveModuleFile(mainFile, spec);
      if (!resolved) {
        drop = true;
        dbg('PRUNE: dead relative import (file missing)', spec);
      }
    }

    out += code.slice(lastIndex, start);
    if (!drop) out += code.slice(start, end);
    lastIndex = end;
  }
  out += code.slice(lastIndex);
  return out;
}

function pruneUnusedAiComponentImports(code: string): string {
  const re = /(^|\n)(?<indent>[ \t]*)import\s+([^;]*?)\s+from\s+['"](?<spec>[^'"]+)['"]\s*;?/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = re.lastIndex;
    const clause = m[3] || '';
    const spec = m.groups?.spec || '';
    const isAi =
      spec.includes('/components/ai/') ||
      spec.startsWith('./components/ai/') ||
      spec.startsWith('../components/ai/');

    let drop = false;
    if (isAi) {
      const locals = parseImportLocals(clause);
      const used = locals.some((id) => new RegExp(String.raw`<\s*${id}\b|<\/\s*${id}\b`).test(code));
      if (!used) {
        drop = true;
        dbg('PRUNE: unused AI component import', { spec, locals });
      } else {
        dbg('KEEP: AI import is used in JSX', { spec, locals });
      }
    }

    out += code.slice(last, start);
    if (!drop) out += code.slice(start, end);
    last = end;
  }
  out += code.slice(last);
  return out;
}

function pruneAiImportsExcept(code: string, keepSpec: string): string {
  const keep = normalizeSpecifier(keepSpec);
  const re = /(^|\r?\n)(?<indent>[ \t]*)import\s+([^;]*?)\s+from\s+['"](?<spec>[^'"]+)['"]\s*;?/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = re.lastIndex;
    const spec = normalizeSpecifier(m.groups?.spec || '');
    const isAi =
      spec.includes('/components/ai/') ||
      spec.startsWith('./components/ai/') ||
      spec.startsWith('../components/ai/');
    const drop = isAi && spec !== keep;

    out += code.slice(last, start);
    if (!drop) out += code.slice(start, end);
    else dbg('PRUNE: AI import (except keep)', { spec, keep });
    last = end;
  }
  out += code.slice(last);
  return out;
}

function main(): void {
  const [, , mainFileArg, importNameArg, importPathArg, jsxFileArg] = process.argv;
  const modeArg = (process.argv[6] || '').toLowerCase();

  const REPLACE_REQUESTED = modeArg === 'replace' && process.env.AI_INJECT_APPEND !== '1';
  const APPEND = !REPLACE_REQUESTED;

  if (!mainFileArg || !importNameArg || !importPathArg || !jsxFileArg) {
    fail(
      'Usage: node --import tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath> [replace]',
    );
  }

  const mainFile = path.resolve(process.cwd(), mainFileArg);
  const importName = importNameArg.trim();
  const importPath = importPathArg.trim();
  const jsxFile = path.resolve(process.cwd(), jsxFileArg);

  console.log('[ai_inject_mount] START', {
    mainFile,
    importName,
    importPath,
    jsxFile,
    APPEND,
    REPLACE_REQUESTED,
    AI_INJECT_APPEND: process.env.AI_INJECT_APPEND ?? undefined,
    DEBUG,
  });

  if (!fileExists(mainFile)) fail(`main file does not exist: ${mainFile}`);
  if (!fileExists(jsxFile)) fail(`jsx temp file does not exist: ${jsxFile}`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(importName)) fail(`importName must be a PascalCase identifier: ${importName}`);

  // Load and pre-prune
  let originalCode = readFileUtf8(mainFile);
  snapshotImports('BEFORE', originalCode, mainFile);

  // alltid: ta bort döda och oanvända AI-imports oavsett mode
  originalCode = pruneDeadRelativeImports(originalCode, mainFile);
  originalCode = pruneUnusedAiComponentImports(originalCode);

  snapshotImports('AFTER_PRE_PRUNE', originalCode, mainFile);

  let jsx = readFileUtf8(jsxFile).trim();
  if (!jsx) fail('jsx is empty');

  const resolvedModule = resolveModuleFile(mainFile, importPath);
  dbg('resolvedModule', resolvedModule);

  if (resolvedModule && path.resolve(resolvedModule) === path.resolve(mainFile)) {
    fail('Refusing to import component from main.tsx');
  }

  const styleDetected = detectExportStyle(resolvedModule || '', importName);
  console.log('[ai_inject_mount] export style', { styleDetected });

  let nextCode = originalCode;

  // Name collisions
  const taken = listImportedIdents(nextCode);
  let effectiveName = importName;
  if (!hasImportForLocal(nextCode, importName, importPath) && taken.has(importName)) {
    effectiveName = pickUnique(importName, taken);
    jsx = rewriteJsxIdent(jsx, importName, effectiveName);
    console.log('[ai_inject_mount] alias due to taken ident', { importName, effectiveName });
  } else if (hasIdentFromOtherSpec(nextCode, importName, importPath)) {
    effectiveName = pickUnique(importName, taken);
    jsx = rewriteJsxIdent(jsx, importName, effectiveName);
    console.log('[ai_inject_mount] alias due to other spec', { importName, effectiveName });
  }

  // Ensure import
  const chosen: ImportStyle = styleDetected === 'named' ? 'named' : 'default';
  if (effectiveName === importName) {
    nextCode = addOrAmendImport(nextCode, chosen, importName, importPath);
  } else {
    nextCode = addImportWithAlias(nextCode, chosen, importName, effectiveName, importPath);
  }

  // Anchor + grid
  let anchor = findAnchor(nextCode);
  console.log('[ai_inject_mount] anchor', anchor ? { kind: anchor.kind } : null);
  if (!anchor) fail('Could not find AI-INJECT-MOUNT anchor or BEGIN/END markers in main file.');

  const jsxIndented = indentMultilineJsx(jsx, (anchor as any).indent);

  if (anchor.kind === 'paired') {
    if (!hasGrid(nextCode, anchor.beginEnd, anchor.endStart)) {
      console.log('[ai_inject_mount] wrap with grid');
      const res = wrapInnerWithGrid(nextCode, anchor);
      nextCode = res.code;
      anchor = res.anchor;
    }

    const key = tileKeyFor(importPath, effectiveName);
    const tileContent = makeTile(jsxIndented, anchor.indent);
    if (APPEND) {
      const replaced = replaceMarkedTile(nextCode, anchor, key, tileContent);
      console.log('[ai_inject_mount] tile action', replaced.replaced ? 'update-existing' : 'append-new', { key });
      if (replaced.replaced) {
        nextCode = replaced.code;
      } else {
        const insertAt = findGridInsertionIndex(nextCode, anchor);
        nextCode =
          nextCode.slice(0, insertAt) +
          `\n${anchor.indent}<> {/* ${key}:BEGIN */}${tileContent} {/* ${key}:END */}</>` +
          nextCode.slice(insertAt);
      }
    } else {
      console.log('[ai_inject_mount] replace mode single tile', { key });
      const open = `\n${anchor.indent}<div id="__AI_MOUNT_GRID__" className="flex flex-wrap gap-4 items-start">`;
      const close = `\n${anchor.indent}</div>\n${anchor.indent}`;
      const single = open + tileContent + close;
      nextCode = nextCode.slice(0, anchor.beginEnd) + single + nextCode.slice(anchor.endStart);
    }
  } else {
    const before = nextCode.slice(0, anchor.start);
    const after = nextCode.slice(anchor.end);
    const key = tileKeyFor(importPath, effectiveName);
    console.log('[ai_inject_mount] upgrade single anchor → paired grid', { key });
    const tileContent = makeTile(jsxIndented, anchor.indent);
    const block =
      `{/* AI-INJECT-MOUNT:BEGIN */}\n${anchor.indent}<div id="__AI_MOUNT_GRID__" className="flex flex-wrap gap-4 items-start">` +
      `\n${anchor.indent}<> {/* ${key}:BEGIN */}${tileContent} {/* ${key}:END */}</>` +
      `\n${anchor.indent}</div>\n${anchor.indent}{/* AI-INJECT-MOUNT:END */}`;
    nextCode = before + block + after;
  }

  // Final pruning
  nextCode = pruneDeadRelativeImports(nextCode, mainFile);
  nextCode = pruneUnusedAiComponentImports(nextCode);
  if (REPLACE_REQUESTED) {
    nextCode = pruneAiImportsExcept(nextCode, importPath);
  }

  snapshotImports('AFTER_FINAL', nextCode, mainFile);

  if (nextCode === originalCode) {
    console.log('[ai_inject_mount] No changes needed.');
    process.exit(0);
  }

  writeFileUtf8(mainFile, nextCode);
  console.log('[ai_inject_mount] Injection complete.');
}

main();
