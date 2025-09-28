// scripts/ai_inject_mount.ts
/**
 * Robust injector for mounting JSX at the AI-INJECT-MOUNT anchor in a TSX entry file.
 *
 * Usage (from repo root):
 *   node --import tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath>
 *   # fallback on older Node (may warn on Node ≥20):
 *   node --loader tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath>
 *
 * Behavior:
 * - Ensures an import for <importName> from <importPath> exists (default vs named based on target file if resolvable).
 * - Removes conflicting imports of the same symbol from other specifiers.
 * - Replaces AI-INJECT-MOUNT with an idempotent BEGIN/END region and injects JSX inside it, preserving indentation.
 * - Minimal edits. Adds a separate import line when safer than rewriting.
 *
 * Debug:
 *   Set AI_INJECT_DEBUG=1 to print trace logs.
 */

import fs from 'node:fs';
import path from 'node:path';

type ImportStyle = 'default' | 'named';

const DEBUG = process.env.AI_INJECT_DEBUG === '1';
const dbg = (...a: any[]) => { if (DEBUG) console.log('[ai_inject_mount:dbg]', ...a); };

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

function hasImportFor(code: string, importName: string, importPath: string): boolean {
  const spec = normalizeSpecifier(importPath);
  const reFrom = new RegExp(String.raw`import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\']`, 'g');

  let m: RegExpExecArray | null;
  while ((m = reFrom.exec(code))) {
    const clause = m[1] || '';
    // default or alias presence
    if (new RegExp(String.raw`(^|[,\s])${importName}(\s|,|$)`).test(clause)) return true;
    // named presence
    if (new RegExp(String.raw`\{[^}]*\b${importName}\b[^}]*\}`).test(clause)) return true;
    // default as alias presence
    if (new RegExp(String.raw`\{[^}]*\bdefault\s+as\s+${importName}\b[^}]*\}`).test(clause)) return true;
  }
  return false;
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

/**
 * Remove any imports of `importName` that come from a different specifier than `goodSpec`.
 * If an import line becomes empty after removal, drop the line.
 * Keep `import type { ... }` lines intact.
 */
function removeConflictingImports(code: string, importName: string, goodSpec: string): string {
  const re = new RegExp(
    String.raw`(^|\n)(?<indent>[ \t]*)import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"];?`,
    'g',
  );
  type Hit = { start: number; end: number; indent: string; clause: string; spec: string };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = re.lastIndex;
    const indent = m.groups?.indent ?? '';
    const clause = m[3] ?? '';
    const spec = m[4] ?? '';
    hits.push({ start, end, indent, clause, spec });
  }

  let out = code;
  for (let i = hits.length - 1; i >= 0; i--) {
    const { start, end, indent, clause, spec } = hits[i];

    // Skip the good spec
    if (normalizeSpecifier(spec) === normalizeSpecifier(goodSpec)) continue;
    // Skip type-only imports
    if (/^\s*type\b/.test(clause)) continue;

    // Does this clause import our symbol at all?
    const mentions =
      new RegExp(String.raw`(^|[,\s])${importName}(\s|,|$)`).test(clause) ||
      new RegExp(String.raw`\{[^}]*\b${importName}\b[^}]*\}`).test(clause) ||
      new RegExp(String.raw`\{[^}]*\bdefault\s+as\s+${importName}\b[^}]*\}`).test(clause);

    if (!mentions) continue;

    // Decompose clause into default and named parts
    const namedMatch = /\{([^}]*)\}/.exec(clause);
    const namedInside = namedMatch ? namedMatch[1] : '';
    const defaultMatch = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    const defaultName = defaultMatch ? defaultMatch[1] : '';

    let keepDefault = defaultName.length > 0 && defaultName !== importName;
    let keptNamed: string[] = [];

    if (namedInside) {
      const rawTokens = namedInside.split(',').map((s) => s.trim()).filter(Boolean);
      for (const t of rawTokens) {
        // tokens can be: Foo | Foo as Bar | default as X
        const isDefaultAlias = new RegExp(String.raw`^default\s+as\s+${importName}$`).test(t);
        const isExact = new RegExp(String.raw`^${importName}$`).test(t);
        const isAliasedFrom = new RegExp(String.raw`^${importName}\s+as\s+[A-Za-z_$][\w$]*$`).test(t);
        if (isDefaultAlias || isExact || isAliasedFrom) continue;
        keptNamed.push(t);
      }
    }

    // Rebuild clause
    let newClause = '';
    if (keepDefault && keptNamed.length > 0) newClause = `${defaultName}, { ${keptNamed.join(', ')} }`;
    else if (keepDefault) newClause = defaultName;
    else if (keptNamed.length > 0) newClause = `{ ${keptNamed.join(', ')} }`;
    else newClause = '';

    if (newClause === '') {
      // Drop the whole line
      out = out.slice(0, start) + out.slice(end);
    } else {
      const rebuilt = `${indent}import ${newClause} from '${spec}';`;
      out = out.slice(0, start) + rebuilt + out.slice(end);
    }
  }

  return out;
}

function addOrAmendImport(code: string, chosen: ImportStyle, importName: string, importPath: string): string {
  const spec = normalizeSpecifier(importPath);
  if (hasImportFor(code, importName, spec)) {
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
    `${indent}import ${chosen === 'default' ? importName : `{ ${importName} }`} from '${spec}';`;
  const newImportDefaultAliasViaNamed = (indent = '') =>
    `${indent}import { default as ${importName} } from '${spec}';`;

  if (imports.length > 0) {
    const indent = imports[0].indent;
    const anyHasDefault = imports.some((im) => /(^|[,\s])[A-Za-z_$][\w$]*/.test(im.clause));
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

type AnchorSingle = { kind: 'single'; start: number; end: number; indent: string };
type AnchorPaired = { kind: 'paired'; beginStart: number; beginEnd: number; endStart: number; endEnd: number; indent: string };
type Anchor = AnchorSingle | AnchorPaired;

function findAnchor(code: string): Anchor | null {
  // Prefer paired region: {/* AI-INJECT-MOUNT:BEGIN */} ... {/* AI-INJECT-MOUNT:END */}
  const reBegin = /\{\/\*\s*AI-INJECT-MOUNT:BEGIN\s*\*\/\}/;
  const reEnd   = /\{\/\*\s*AI-INJECT-MOUNT:END\s*\*\/\}/;
  const mb = reBegin.exec(code);
  if (mb) {
    reEnd.lastIndex = mb.index + mb[0].length;
    const me = reEnd.exec(code);
    if (me && me.index > mb.index) {
      const lineStart = code.lastIndexOf('\n', mb.index) + 1;
      const indent = (/^(\s*)/.exec(code.slice(lineStart, mb.index))?.[1]) ?? '';
      return { kind: 'paired', beginStart: mb.index, beginEnd: mb.index + mb[0].length, endStart: me.index, endEnd: me.index + me[0].length, indent };
    }
  }

  // Fallback: single anchor comment (JSX, line, or block)
  const patterns = [
    /\{\/\*\s*AI-INJECT-MOUNT\s*\*\/\}/, // JSX comment node
    /\/\/[ \t]*AI-INJECT-MOUNT.*/,       // line comment
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

function main(): void {
  const [, , mainFileArg, importNameArg, importPathArg, jsxFileArg] = process.argv;
  if (!mainFileArg || !importNameArg || !importPathArg || !jsxFileArg) {
    fail('Usage: node --import tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath>');
  }

  const mainFile = path.resolve(process.cwd(), mainFileArg);
  const importName = importNameArg.trim();
  const importPath = importPathArg.trim();
  const jsxFile = path.resolve(process.cwd(), jsxFileArg);

  dbg('argv', { mainFile, importName, importPath, jsxFile });

  if (!fileExists(mainFile)) fail(`main file does not exist: ${mainFile}`);
  if (!fileExists(jsxFile)) fail(`jsx temp file does not exist: ${jsxFile}`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(importName)) fail(`importName must be a PascalCase identifier: ${importName}`);

  const originalCode = readFileUtf8(mainFile);
  const jsxRaw = readFileUtf8(jsxFile);
  const jsx = jsxRaw.trim();
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

  // 1) Remove conflicting imports of the same identifier from other specifiers
  let nextCode = removeConflictingImports(originalCode, importName, normalizeSpecifier(importPath));

  // 2) Ensure desired import exists
  nextCode = addOrAmendImport(nextCode, chosen, importName, importPath);

  // 3) Anchor handling: prefer paired region, else upgrade single anchor to paired
  const anchor = findAnchor(nextCode);
  dbg('anchor', anchor);
  if (!anchor) fail('Could not find AI-INJECT-MOUNT anchor or BEGIN/END markers in main file.');

  const BEGIN = '{/* AI-INJECT-MOUNT:BEGIN */}';
  const END   = '{/* AI-INJECT-MOUNT:END */}';

  const jsxIndented = indentMultilineJsx(jsx, (anchor as any).indent);

  if (anchor.kind === 'paired') {
    // Replace only inner content to keep markers. Idempotent.
    const before = nextCode.slice(0, anchor.beginEnd);
    const after  = nextCode.slice(anchor.endStart);
    const inner  = `\n${anchor.indent}${jsxIndented}\n${anchor.indent}`;
    const newCode = before + inner + nextCode.slice(anchor.endStart, anchor.endEnd) + after;

    if (newCode === nextCode) {
      console.log('[ai_inject_mount] No changes needed.');
      process.exit(0);
    }
    nextCode = newCode;
  } else {
    // Single anchor → replace with paired markers + JSX inside.
    const before = nextCode.slice(0, anchor.start);
    const after  = nextCode.slice(anchor.end);
    const block  = `${BEGIN}\n${anchor.indent}${jsxIndented}\n${anchor.indent}${END}`;
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
