/**
 * Robust injector for mounting JSX at the AI-INJECT-MOUNT anchor in a TSX entry file.
 *
 * Usage (from repo root):
 *   node --loader tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath>
 *
 * Behavior:
 * - Ensures an import for <importName> from <importPath> exists (default vs named based on target file if resolvable).
 * - Replaces the AI-INJECT-MOUNT anchor comment with the JSX from <jsxFilePath>, preserving indentation.
 * - Makes minimal, conservative edits. Adds new import lines instead of rewriting existing ones when safer.
 */

import fs from 'node:fs';
import path from 'node:path';

type ImportStyle = 'default' | 'named';

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

function resolveModuleFile(fromFile: string, importPath: string): string | null {
  // Only attempt to resolve relative or absolute filesystem paths.
  if (!importPath.startsWith('.') && !importPath.startsWith('/') && !importPath.startsWith('file:')) {
    return null; // bare specifier (package) — we won't try to resolve
  }
  const basedir = path.dirname(fromFile);
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(basedir, p));

  // If importPath has an extension, try it directly.
  const hasExt = /\.(tsx?|jsx?)$/i.test(importPath);
  if (hasExt) add(importPath);

  // Try with common extensions and index files.
  const bases = hasExt ? [importPath] : [importPath];
  for (const base of bases) {
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      add(base + ext);
    }
    for (const idxExt of ['.tsx', '.ts', '.jsx', '.js']) {
      add(path.join(base, 'index' + idxExt));
    }
  }

  for (const c of candidates) {
    if (fileExists(c)) return c;
  }
  return null;
}

function detectExportStyle(moduleFile: string, importName: string): ImportStyle | 'unknown' {
  if (!moduleFile || !fileExists(moduleFile)) return 'unknown';
  const code = readFileUtf8(moduleFile);

  // Heuristics:
  // - If 'export default' appears, assume default export exists.
  // - Else, if named export of importName appears, prefer named.
  // - Else unknown.
  const hasDefault = /\bexport\s+default\b/.test(code);
  if (hasDefault) return 'default';

  const namedPatterns = [
    new RegExp(String.raw`\bexport\s+(const|let|var|function|class)\s+${importName}\b`),
    new RegExp(String.raw`\bexport\s*\{[^}]*\b${importName}\b[^}]*\}`),
    new RegExp(String.raw`\bexport\s+type\s+${importName}\b`),
  ];
  if (namedPatterns.some((re) => re.test(code))) return 'named';

  return 'unknown';
}

function normalizeSpecifier(spec: string): string {
  // Keep exact path string for matching, but normalize quotes usage when generating.
  return spec.trim();
}

function hasImportFor(code: string, importName: string, importPath: string): boolean {
  const spec = normalizeSpecifier(importPath);
  const reFrom = new RegExp(String.raw`import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\']`, 'g');
  const reBare = new RegExp(String.raw`import\s+["\']${escapeRegex(spec)}["\']`, 'g');

  let m: RegExpExecArray | null;
  while ((m = reFrom.exec(code))) {
    const clause = m[1] || '';
    // Match default or named with importName
    if (new RegExp(String.raw`(^|[,\s])${importName}(\s|,|$)`).test(clause)) return true; // default alias or part of named list
    if (new RegExp(String.raw`\{[^}]*\b${importName}\b[^}]*\}`).test(clause)) return true; // explicitly named
    if (new RegExp(String.raw`\{[^}]*\bdefault\s+as\s+${importName}\b[^}]*\}`).test(clause)) return true; // default as alias
  }
  // Side-effect import doesn't bind a name
  // Not considered as satisfying symbol presence
  void reBare;
  return false;
}

function addOrAmendImport(code: string, chosen: ImportStyle, importName: string, importPath: string): string {
  const spec = normalizeSpecifier(importPath);
  if (hasImportFor(code, importName, spec)) return code; // nothing to do

  // Find any existing import declarations from this specifier
  const importFromRe = new RegExp(String.raw`(^|\n)(?<indent>[\t ]*)import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\'];?`, 'g');
  const imports: { start: number; end: number; indent: string; clause: string }[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = importFromRe.exec(code))) {
    const start = mm.index + (mm[1] ? mm[1].length : 0);
    const end = importFromRe.lastIndex;
    const indent = (mm.groups?.indent ?? '');
    const clause = mm[3] ?? '';
    imports.push({ start, end, indent, clause });
  }

  const newImportLine = (indent = '') =>
    `${indent}import ${chosen === 'default' ? importName : `{ ${importName} }`} from '${spec}';`;
  const newImportDefaultAliasViaNamed = (indent = '') => `${indent}import { default as ${importName} } from '${spec}';`;

  if (imports.length > 0) {
    // If any import-from exists, prefer adding a separate minimal import line to avoid complex rewrites
    // If we need default, but another default alias exists, use `{ default as X }` form.
    // Otherwise, just add the appropriate import line.
    const indent = imports[0].indent;

    // Detect if any of these existing imports already have a default specifier (not our name)
    const anyHasDefault = imports.some((im) => /(^|[,\s])[a-zA-Z_$][\w$]*/.test(im.clause));
    if (chosen === 'default' && anyHasDefault) {
      return insertAfterLastImportFrom(code, spec, newImportDefaultAliasViaNamed(indent));
    }
    return insertAfterLastImportFrom(code, spec, newImportLine(indent));
  }

  // No import-from line for this specifier: insert after the last import at top of file
  return insertAfterLastImportTop(code, newImportLine());
}

function insertAfterLastImportFrom(code: string, spec: string, lineToInsert: string): string {
  const re = new RegExp(String.raw`(^|\n)(?<indent>[\t ]*)import\s+([^;]*?)\s+from\s+["\']${escapeRegex(spec)}["\'];?`, 'g');
  let lastIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    lastIdx = re.lastIndex;
  }
  if (lastIdx === -1) return insertAfterLastImportTop(code, lineToInsert);
  return code.slice(0, lastIdx) + `\n` + lineToInsert + code.slice(lastIdx);
}

function insertAfterLastImportTop(code: string, lineToInsert: string): string {
  const importBlockRe = /^(?:[ \t]*import\b[^;]*;[ \t]*\r?\n)+/m;
  const m = importBlockRe.exec(code);
  if (m) {
    const insertPos = m.index + m[0].length;
    const needsNL = m[0].length > 0 && !m[0].endsWith('\n\n');
    const nl = needsNL ? '' : '';
    return code.slice(0, insertPos) + (m[0].endsWith('\n') ? '' : '\n') + lineToInsert + '\n' + code.slice(insertPos);
  }
  // No imports found — insert at beginning
  return lineToInsert + '\n' + code;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAnchorRange(code: string): { start: number; end: number; indent: string } | null {
  // Support variants within JSX: {/* AI-INJECT-MOUNT */}, // AI-INJECT-MOUNT, /* AI-INJECT-MOUNT */
  const patterns = [
    /\{\/\*\s*AI-INJECT-MOUNT\s*\*\/\}/, // JSX comment node
    /\/\/\s*AI-INJECT-MOUNT.*/, // line comment
    /\/\*\s*AI-INJECT-MOUNT\s*\*\//, // block comment
  ];
  for (const re of patterns) {
    const m = re.exec(code);
    if (m) {
      // Determine indentation from line start
      const lineStart = code.lastIndexOf('\n', m.index) + 1;
      const line = code.slice(lineStart, m.index);
      const indentMatch = /^(\s*)/.exec(line);
      const indent = indentMatch ? indentMatch[1] : '';
      return { start: m.index, end: m.index + m[0].length, indent };
    }
  }
  return null;
}

function indentMultilineJsx(jsx: string, baseIndent: string): string {
  const lines = jsx.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 1) return lines[0].trim();
  const trimmed = lines.map((l) => l.trimEnd());
  // Preserve relative indentation inside the JSX by detecting minimal leading spaces among non-empty lines
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
  const [,, mainFileArg, importNameArg, importPathArg, jsxFileArg] = process.argv;
  if (!mainFileArg || !importNameArg || !importPathArg || !jsxFileArg) {
    fail('Usage: node --loader tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath>');
  }

  const mainFile = path.resolve(process.cwd(), mainFileArg);
  const importName = importNameArg.trim();
  const importPath = importPathArg.trim();
  const jsxFile = path.resolve(process.cwd(), jsxFileArg);

  if (!fileExists(mainFile)) fail(`main file does not exist: ${mainFile}`);
  if (!fileExists(jsxFile)) fail(`jsx temp file does not exist: ${jsxFile}`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(importName)) fail(`importName must be a PascalCase identifier: ${importName}`);

  const originalCode = readFileUtf8(mainFile);
  const jsxRaw = readFileUtf8(jsxFile);
  const jsx = jsxRaw.trim();
  if (!jsx) fail('jsx is empty');

  // Ensure import
  const resolvedModule = resolveModuleFile(mainFile, importPath);
  const styleDetected = detectExportStyle(resolvedModule || '', importName);
  const chosen: ImportStyle = styleDetected === 'named' ? 'named' : 'default';
  let nextCode = addOrAmendImport(originalCode, chosen, importName, importPath);

  // Replace anchor with JSX, preserving indentation
  const anchor = findAnchorRange(nextCode);
  if (!anchor) {
    fail('Could not find AI-INJECT-MOUNT anchor in main file.');
  }
  const jsxIndented = indentMultilineJsx(jsx, anchor.indent);
  nextCode = nextCode.slice(0, anchor.start) + jsxIndented + nextCode.slice(anchor.end);

  if (nextCode === originalCode) {
    console.log('[ai_inject_mount] No changes needed.');
    process.exit(0);
  }

  writeFileUtf8(mainFile, nextCode);
  console.log('[ai_inject_mount] Injection complete.');
}

main();

