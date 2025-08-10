from __future__ import annotations

# backend/tasks/analyze.py
#
# Celery-task som analyserar ett frontend-projekt och returnerar en project_model.
# Beroenden: endast standardbibliotek + (valfritt/installerat) tree-sitter för framtida utökning.
# Nuvarande implementation använder robusta regex-heuristiker (snabba, inga extra deps).
#
# Viktigt: Återanvänd befintlig Celery-instans.

import os
import json
import base64
import re
from pathlib import Path
from typing import Dict, Any, List, Tuple, Optional, Iterable

from celery import current_app as celery_current_app

try:
    # Primär källa (existerande pipeline)
    from backend.tasks.codegen import celery_app as celery_app  # type: ignore
except Exception:
    try:
        from backend.tasks.codegen import app as celery_app  # type: ignore
    except Exception:  # pragma: no cover
        celery_app = celery_current_app  # fallback

# ======== Konstanter / Heuristiker =========
TEXT_EXTS = {".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".scss", ".sass", ".html", ".md"}
SRC_DIR_HINTS = {"src", "app", "pages", "components"}

# Regexp för komponenter
RE_EXPORT_DEFAULT_FN = re.compile(r"export\s+default\s+function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)", re.MULTILINE)
RE_EXPORT_NAMED_FN   = re.compile(r"export\s+function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)", re.MULTILINE)
RE_EXPORT_CONST      = re.compile(r"export\s+(?:default\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*\(([^)]*)\)\s*=>", re.MULTILINE)
RE_EXPORT_DEFAULT_ARROW = re.compile(r"export\s+default\s*\(([^)]*)\)\s*=>", re.MULTILINE)

RE_JSX_TAG           = re.compile(r"<[A-Z][A-Za-z0-9]*(\s|/|>)")
RE_RETURNS_JSX       = re.compile(r"return\s*\(\s*<", re.MULTILINE)

RE_TW_CLASSNAME      = re.compile(r'class(Name)?\s*=\s*["\']([^"\']*(?:bg-|text-|flex|grid|p-|m-|w-|h-|rounded|shadow)[^"\']*)["\']', re.IGNORECASE)
RE_INJECT_TAG        = re.compile(r"@inject:([A-Za-z0-9_\-:./]+)")

RE_ROUTE_IMPORT      = re.compile(r"from\s+['\"]react-router(?:-dom)?['\"]")
RE_ROUTE_TAG         = re.compile(r"<Route\s+[^>]*path\s*=\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)

IGNORED_DIRS_DEFAULT = [
    "node_modules", "dist", "build", "out", ".next", ".svelte-kit", ".output",
    ".git", "coverage", ".venv", "venv", "__pycache__", "dist-webview",
]

# ======== Hjälpfunktioner =========

def _read_text(path: Path, max_bytes: int) -> Tuple[str, bool]:
    """
    Läser textfil upp till max_bytes. Returnerar (text, was_truncated).
    Binära eller för stora filer ignoreras säkert via felhantering.
    """
    try:
        b = path.read_bytes()
    except Exception:
        return ("", False)
    truncated = False
    if len(b) > max_bytes:
        b = b[:max_bytes]
        truncated = True
    try:
        return (b.decode("utf-8", errors="ignore"), truncated)
    except Exception:
        return ("", truncated)

def _detect_manager_and_scripts(pkg_json: Dict[str, Any], project_root: Path) -> Tuple[str, Dict[str, str]]:
    scripts = pkg_json.get("scripts", {}) if isinstance(pkg_json, dict) else {}
    manager = "unknown"
    if (project_root / "pnpm-lock.yaml").exists():
        manager = "pnpm"
    elif (project_root / "yarn.lock").exists():
        manager = "yarn"
    elif (project_root / "bun.lockb").exists():
        manager = "bun"
    elif (project_root / "package-lock.json").exists():
        manager = "npm"
    return manager, scripts

def _detect_framework(pkg_json: Dict[str, Any]) -> str:
    deps = {}
    for k in ("dependencies", "devDependencies", "peerDependencies"):
        v = pkg_json.get(k)
        if isinstance(v, dict):
            deps.update(v)
    deps_lower = {k.lower(): v for k, v in deps.items()}

    if "next" in deps_lower:
        return "next"
    if "react" in deps_lower:
        return "react"
    if "vite" in deps_lower and "react" in deps_lower:
        return "react"
    if "svelte" in deps_lower or "@sveltejs/kit" in deps_lower:
        return "svelte"
    if "vue" in deps_lower or "nuxt" in deps_lower:
        return "vue"
    return "unknown"

def _find_entry_points(root: Path) -> Dict[str, Any]:
    patterns = [
        "index.html",
        "public/index.html",
        "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
        "src/App.tsx", "src/App.ts", "src/App.jsx", "src/App.js",
        "pages/_app.tsx", "pages/_app.jsx",
        "app/layout.tsx", "app/layout.jsx"
    ]
    found = []
    for p in patterns:
        f = root / p
        if f.exists():
            found.append(p)
    return {
        "html": [p for p in found if p.endswith(".html")],
        "mainFiles": [p for p in found if "/main." in p or p.endswith("main.js") or p.endswith("main.ts") or p.endswith("main.tsx") or p.endswith("main.jsx")],
        "appFiles": [p for p in found if "App." in p or p.endswith("_app.tsx") or p.endswith("_app.jsx") or p.endswith("layout.tsx") or p.endswith("layout.jsx")],
        "next": {
            "appDir": (root / "app").exists(),
            "pagesDir": (root / "pages").exists()
        }
    }

def _detect_styling(root: Path, pkg_json: Dict[str, Any], files_iter: Iterable[Tuple[str, str]]) -> Dict[str, Any]:
    # Tailwind
    tailwind_present = False
    tailwind_config = None
    for cfg in ("tailwind.config.js", "tailwind.config.cjs", "tailwind.config.ts"):
        if (root / cfg).exists():
            tailwind_present = True
            tailwind_config = cfg
            break
    deps = {}
    for k in ("dependencies", "devDependencies"):
        v = pkg_json.get(k)
        if isinstance(v, dict):
            deps.update(v)
    if "tailwindcss" in (k.lower() for k in deps.keys()):
        tailwind_present = True

    # UI-libs primärt via importspår i källor (snabb heuristik) + deps
    ui_libs = set()
    known_ui_markers = [
        "@mui/material", "@material-ui/core", "styled-components",
        "antd", "@chakra-ui/react", "@radix-ui", "shadcn/ui", "class-variance-authority",
        "tailwind-merge", "lucide-react", "@headlessui/react"
    ]
    # Snabb skanning av ett urval av källor
    hit_budget = 0
    for rel, text in files_iter:
        if hit_budget > 200:  # begränsa CPU
            break
        hit = False
        for marker in known_ui_markers:
            if marker in text:
                ui_libs.add(marker)
                hit = True
        if not tailwind_present and RE_TW_CLASSNAME.search(text):
            tailwind_present = True
        if hit:
            hit_budget += 1

    return {
        "tailwind": {"present": tailwind_present, "configPath": tailwind_config},
        "uiLibs": sorted(ui_libs)
    }

def _routeify_next_path(rel: str) -> Optional[str]:
    # Konvertera Next pages/app-fil till route-path
    # Ignorera specialsidor
    if any(seg.startswith("_") for seg in Path(rel).parts):
        return None
    if "/api/" in rel.replace("\\", "/"):
        return None
    p = rel
    p = re.sub(r"\.(tsx|ts|jsx|js)$", "", p)
    p = p.replace("\\", "/")
    p = p.replace("pages", "").replace("app", "")
    if p.endswith("/index"):
        p = p[:-len("/index")]
    p = p or "/"
    # [id] -> :id
    p = re.sub(r"\[([A-Za-z0-9_]+)\]", r":\1", p)
    if not p.startswith("/"):
        p = "/" + p
    return p

def _detect_routing(root: Path, pkg_json: Dict[str, Any], files_map: Dict[str, str]) -> Dict[str, Any]:
    framework = _detect_framework(pkg_json)
    routes: List[Dict[str, str]] = []
    rtype = "none"

    if framework == "next" or (root / "pages").exists() or (root / "app").exists():
        rtype = "next"
        # Indexera pages/ och app/ endast under projektroten
        for base in ("pages", "app"):
            base_dir = root / base
            if base_dir.exists():
                for f in base_dir.rglob("*.*"):
                    if f.is_file() and f.suffix in {".tsx", ".ts", ".jsx", ".js"}:
                        rel = str(f.relative_to(root)).replace("\\", "/")
                        rp = _routeify_next_path(rel)
                        if rp:
                            routes.append({"path": rp, "file": rel, "source": base})
        return {"type": rtype, "routes": routes, "count": len(routes)}

    # React Router — leta efter imports + <Route path="...">
    rr_hits = 0
    for rel, text in files_map.items():
        if RE_ROUTE_IMPORT.search(text):
            rr_hits += 1
    if rr_hits:
        rtype = "react-router"
        for rel, text in files_map.items():
            for m in RE_ROUTE_TAG.finditer(text):
                routes.append({"path": m.group(1), "file": rel, "source": "react-router"})
        # De-dupe
        uniq = {}
        for r in routes:
            key = (r["path"], r["file"])
            uniq[key] = r
        routes = list(uniq.values())
        return {"type": rtype, "routes": routes, "count": len(routes)}

    return {"type": "none", "routes": [], "count": 0}

def _detect_components(files_map: Dict[str, str]) -> List[Dict[str, Any]]:
    comps: List[Dict[str, Any]] = []
    for rel, text in files_map.items():
        # Snabbfilter: har filen JSX?
        if not (RE_JSX_TAG.search(text) or RE_RETURNS_JSX.search(text)):
            continue

        def _mk(name: str, export_type: str, params: str, kind: str) -> Dict[str, Any]:
            has_props = bool(params and (("props" in params) or ("{" in params)))
            # försök plocka ut prop-namn från destrukturering
            prop_names: List[str] = []
            if "{" in params and "}" in params:
                inside = params.split("{", 1)[1].split("}", 1)[0]
                # enkla tokens
                for t in inside.split(","):
                    t = t.strip()
                    if t and ":" not in t and "=" not in t and "..." not in t:
                        prop_names.append(re.sub(r"\s.*$", "", t))
            uses_tw = bool(RE_TW_CLASSNAME.search(text))
            return {
                "name": name,
                "file": rel,
                "export": export_type,
                "kind": kind,
                "hasProps": has_props,
                "propNames": prop_names[:8],
                "usesTailwind": uses_tw,
            }

        # default function
        for m in RE_EXPORT_DEFAULT_FN.finditer(text):
            comps.append(_mk(m.group(1), "default", m.group(2), "function"))

        # named function
        for m in RE_EXPORT_NAMED_FN.finditer(text):
            comps.append(_mk(m.group(1), "named", m.group(2), "function"))

        # const components (default eller named)
        for m in RE_EXPORT_CONST.finditer(text):
            comps.append(_mk(m.group(1), "named", m.group(2), "const"))

        # anonymous default arrow
        for m in RE_EXPORT_DEFAULT_ARROW.finditer(text):
            # använd filnamn som namn
            base = Path(rel).stem
            name = f"{base}DefaultExport"
            comps.append(_mk(name, "default", m.group(1), "const"))
    # De-dupe per (file,name,export)
    seen = set()
    unique: List[Dict[str, Any]] = []
    for c in comps:
        key = (c["file"], c["name"], c["export"])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique

def _find_injection_points(files_map: Dict[str, str]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for rel, text in files_map.items():
        for i, line in enumerate(text.splitlines(), start=1):
            m = RE_INJECT_TAG.search(line)
            if m:
                items.append({"file": rel, "line": i, "tag": m.group(1)})
    return items

def _iter_local_files(root: Path, include: Optional[List[str]], exclude: Optional[List[str]], ignored_dirs: List[str]) -> Iterable[Path]:
    """
    Effektiv och portabel directory-walk med ignore-lista (utan att räkna bort symbolic links).
    """
    ignored = set(ignored_dirs or [])
    for dirpath, dirnames, filenames in os.walk(root):
        # Filtrera bort ignorerade kataloger in-place (för effektivitet)
        dirnames[:] = [d for d in dirnames if d not in ignored and not d.startswith(".git")]
        for fn in filenames:
            yield Path(dirpath) / fn

def _match_globs(path: Path, root: Path, include: Optional[List[str]], exclude: Optional[List[str]]) -> bool:
    from fnmatch import fnmatch
    rel = str(path.relative_to(root)).replace("\\", "/")
    if exclude:
        for g in exclude:
            if fnmatch(rel, g):
                return False
    if include:
        return any(fnmatch(rel, g) for g in include)
    # default: inkludera textfiler och relevanta mappar
    if path.suffix.lower() in TEXT_EXTS:
        return True
    # prioritera källträd
    if any(seg in SRC_DIR_HINTS for seg in Path(rel).parts) and path.suffix.lower() in {".js", ".jsx", ".ts", ".tsx", ".html", ".css"}:
        return True
    return False

def _collect_files_local(manifest: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, Any], List[str]]:
    root = Path(manifest["root_path"]).expanduser().resolve()
    include = manifest.get("include") or None
    exclude = (manifest.get("exclude") or []) + [f"{d}/**" for d in manifest.get("ignored_dirs", IGNORED_DIRS_DEFAULT)]
    max_files = int(manifest.get("max_files", 2000))
    max_file_bytes = int(manifest.get("max_file_bytes", 300_000))

    files_map: Dict[str, str] = {}
    limits = {"maxFileBytes": max_file_bytes, "maxFiles": max_files, "filesScanned": 0, "bytesScanned": 0, "truncated": 0, "ignored": list(set(IGNORED_DIRS_DEFAULT))}
    warnings: List[str] = []

    # package.json läses separat (om finns)
    pkg = {}
    pkg_path = root / "package.json"
    if pkg_path.exists():
        txt, trunc = _read_text(pkg_path, max_file_bytes)
        try:
            pkg = json.loads(txt) if txt else {}
        except Exception:
            warnings.append("Kunde inte parsa package.json")

    count = 0
    for p in _iter_local_files(root, include, exclude, manifest.get("ignored_dirs", IGNORED_DIRS_DEFAULT)):
        if count >= max_files:
            warnings.append(f"Avbröt skanning: nådde max_files={max_files}")
            break
        if not _match_globs(p, root, include, exclude):
            continue
        # hoppa binärer/okända stora filer
        if p.suffix.lower() not in TEXT_EXTS and p.name != "package.json":
            continue
        rel = str(p.relative_to(root)).replace("\\", "/")
        text, truncated = _read_text(p, max_file_bytes)
        if text == "" and p.name != "package.json":
            continue
        files_map[rel] = text
        count += 1
        limits["filesScanned"] = count
        limits["bytesScanned"] += min(max_file_bytes, len(text.encode("utf-8", errors="ignore")))
        if truncated:
            limits["truncated"] += 1

    return files_map, {"pkg": pkg, "root": str(root)}, warnings

def _collect_files_streamed(manifest: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, Any], List[str]]:
    files_map: Dict[str, str] = {}
    max_files = int(manifest.get("max_files", 2000))
    max_file_bytes = int(manifest.get("max_file_bytes", 300_000))
    limits = {"maxFileBytes": max_file_bytes, "maxFiles": max_files, "filesScanned": 0, "bytesScanned": 0, "truncated": 0, "ignored": list(set(IGNORED_DIRS_DEFAULT))}
    warnings: List[str] = []
    root = Path(manifest.get("root_path") or ".").resolve()

    files = manifest.get("files") or []
    if len(files) > max_files:
        files = files[:max_files]
        warnings.append(f"Beskar strömmade filer till max_files={max_files}")

    for f in files:
        rel = f.get("path")
        b64 = f.get("content_b64") or ""
        try:
            raw = base64.b64decode(b64)
        except Exception:
            continue
        if len(raw) > max_file_bytes:
            raw = raw[:max_file_bytes]
            limits["truncated"] += 1
        text = raw.decode("utf-8", errors="ignore")
        files_map[rel] = text
        limits["filesScanned"] += 1
        limits["bytesScanned"] += len(raw)

    # extrahera package.json om närvarande
    pkg = {}
    if "package.json" in files_map:
        try:
            pkg = json.loads(files_map["package.json"])
        except Exception:
            warnings.append("Kunde inte parsa package.json (streamed)")

    return files_map, {"pkg": pkg, "root": str(root)}, warnings

def _to_iterable(files_map: Dict[str, str]) -> Iterable[Tuple[str, str]]:
    for k, v in files_map.items():
        yield k, v

# ======== Celery Task =========

@celery_app.task(name="backend.tasks.analyze.analyze_project", bind=True)
def analyze_project(self, manifest: Dict[str, Any]) -> Dict[str, Any]:
    """
    Kör analys och returnerar {"project_model": {...}}.
    """
    mode = manifest.get("mode")
    max_file_bytes = int(manifest.get("max_file_bytes", 300_000))
    max_files = int(manifest.get("max_files", 2000))

    if mode not in ("local_paths", "streamed_files"):
        raise ValueError("Ogiltigt mode, använd 'local_paths' eller 'streamed_files'")

    if mode == "local_paths":
        files_map, env, warns = _collect_files_local(manifest)
        project_root = Path(env["root"])
        pkg = env.get("pkg") or {}
    else:
        files_map, env, warns = _collect_files_streamed(manifest)
        project_root = Path(env["root"])
        pkg = env.get("pkg") or {}

    # Manager/Framework/Scripts
    manager, scripts = _detect_manager_and_scripts(pkg, project_root)
    framework = _detect_framework(pkg)

    # Entry points
    entry_points = _find_entry_points(project_root)

    # Styling
    styling = _detect_styling(project_root, pkg, _to_iterable(files_map))

    # Routing
    routing = _detect_routing(project_root, pkg, files_map)

    # Komponenter
    # Skanna endast JS/TS(X)
    code_files = {rel: txt for rel, txt in files_map.items() if Path(rel).suffix.lower() in {".js", ".jsx", ".ts", ".tsx"}}
    components = _detect_components(code_files)

    # Injection points
    # Sök i .js/.ts/.tsx/.jsx/.html för att tillåta injektion i HTML också
    inj_files = {rel: txt for rel, txt in files_map.items() if Path(rel).suffix.lower() in {".js", ".jsx", ".ts", ".tsx", ".html"}}
    injection_points = _find_injection_points(inj_files)

    limits = {
        "maxFileBytes": max_file_bytes,
        "maxFiles": max_files,
        "filesScanned": len(files_map),
        "bytesScanned": sum(len(v.encode("utf-8", errors="ignore")) for v in files_map.values()),
        "truncated": 0,  # beräknas redan i collectors men icke-kritiskt att dubbelräkna
        "ignored": IGNORED_DIRS_DEFAULT,
    }

    warnings = warns
    if framework == "unknown":
        warnings.append("Kunde inte med säkerhet fastställa ramverk (antingen saknas react/next i dependencies eller så är projektet ovanligt).")

    project_model: Dict[str, Any] = {
        "manager": manager,
        "framework": framework,
        "scripts": scripts,
        "entryPoints": entry_points,
        "styling": styling,
        "routing": routing,
        "components": components,
        "injectionPoints": injection_points,
        "limits": limits,
        "warnings": warnings,
    }

    return {"project_model": project_model}
