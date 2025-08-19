# backend/tasks/analyze.py
#
# Projektanalys med två profiler:
#  - "fast": deterministisk, lättviktig uppstartsprofil (ingen tung textsökning)
#  - "full": fördjupad analys (befintlig logik med filskanning, komponenter, @inject, rutter m.m.)
from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from celery import shared_task

# ======== Konstanter / Heuristiker =========

TEXT_EXTS = {
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".css",
    ".scss",
    ".sass",
    ".html",
    ".md",
    ".mjs",
    ".cjs",
}
SRC_DIR_HINTS = {"src", "app", "pages", "components", "public"}

IGNORED_DIRS_DEFAULT = [
    "node_modules",
    "dist",
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
    "dist-webview",
]

CONFIG_NAMES = [
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
]

# --- Regex (används i "full"-profilen) ---

RE_EXPORT_DEFAULT_FN = re.compile(
    r"export\s+default\s+function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)",
    re.MULTILINE,
)
RE_EXPORT_NAMED_FN = re.compile(
    r"export\s+function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)", re.MULTILINE
)
RE_EXPORT_CONST = re.compile(
    r"export\s+(?:default\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*\(([^)]*)\)\s*=>",
    re.MULTILINE,
)
RE_EXPORT_DEFAULT_ARROW = re.compile(
    r"export\s+default\s*\(([^)]*)\)\s*=>", re.MULTILINE
)

RE_JSX_TAG = re.compile(r"<[A-Z][A-Za-z0-9]*(\s|/|>)")
RE_RETURNS_JSX = re.compile(r"return\s*\(\s*<", re.MULTILINE)

RE_TW_CLASSNAME = re.compile(
    r'class(Name)?\s*=\s*["\']([^"\']*(?:bg-|text-|flex|grid|p-|m-|w-|h-|rounded|shadow)[^"\']*)["\']',
    re.IGNORECASE,
)
RE_INJECT_TAG = re.compile(r"@inject:([A-Za-z0-9_\-:./]+)")

RE_ROUTE_IMPORT = re.compile(r"from\s+['\"]react-router(?:-dom)?['\"]")
RE_ROUTE_TAG = re.compile(
    r"<Route\s+[^>]*path\s*=\s*['\"]([^'\"]+)['\"]", re.IGNORECASE
)


# ======== Hjälpfunktioner =========


def _read_text(path: Path, max_bytes: int) -> Tuple[str, bool]:
    try:
        data = path.read_bytes()
    except Exception:
        return ("", False)
    truncated = False
    if len(data) > max_bytes:
        data = data[:max_bytes]
        truncated = True
    try:
        return (data.decode("utf-8", errors="ignore"), truncated)
    except Exception:
        return ("", truncated)


def _detect_manager_and_scripts(
    pkg_json: Dict[str, Any], project_root: Path
) -> Tuple[str, Dict[str, str]]:
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


def _detect_configs(root: Path) -> List[str]:
    hits = []
    for name in CONFIG_NAMES:
        if (root / name).exists():
            hits.append(name)
    return hits


def _deps_from_pkg(pkg_json: Dict[str, Any]) -> Dict[str, Any]:
    deps: Dict[str, Any] = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        v = pkg_json.get(key)
        if isinstance(v, dict):
            deps.update(v)
    return {k.lower(): v for k, v in deps.items()}


def _detect_framework(
    pkg_json: Dict[str, Any], config_hits: List[str], root: Path
) -> str:
    deps_lower = _deps_from_pkg(pkg_json)

    if "next" in deps_lower or any(c.startswith("next.config") for c in config_hits):
        return "next"
    if "@sveltejs/kit" in deps_lower or any(
        c.startswith("svelte.config") for c in config_hits
    ):
        return "sveltekit"
    if "vite" in deps_lower:
        return "vite"
    if (
        "vue" in deps_lower
        or "nuxt" in deps_lower
        or any(c.startswith("nuxt.config") for c in config_hits)
    ):
        return "vue"
    if "@angular/core" in deps_lower or "angular.json" in config_hits:
        return "angular"
    if "remix" in deps_lower or "@remix-run/dev" in deps_lower or any(
        c.startswith("remix.config") for c in config_hits
    ):
        return "remix"
    if "solid-start" in deps_lower or any(
        c.startswith("solid.config") for c in config_hits
    ):
        return "solid"
    if "astro" in deps_lower or any(c.startswith("astro.config") for c in config_hits):
        return "astro"
    if "react" in deps_lower:
        return "react"
    return "unknown"


def _find_entry_points(root: Path) -> Dict[str, Any]:
    html_candidates: List[str] = []
    main_candidates: List[str] = []
    app_candidates: List[str] = []

    # Ignorera tunga/irrelevanta kataloger
    IGNORE = set(IGNORED_DIRS_DEFAULT)

    def should_skip_dir(d: Path) -> bool:
        name = d.name
        return name in IGNORE or name.startswith(".git")

    # 1) Prioritera index.html i rot
    if (root / "index.html").exists():
        html_candidates.append("index.html")

    # 2) Gå igenom trädet grunt → djupt, men hoppa ignore
    for dirpath, dirnames, filenames in os.walk(root):
        # filtrera bort ignoredirs tidigt
        dirnames[:] = [d for d in dirnames if not should_skip_dir(Path(dirpath)/d)]
        rel_dir = Path(dirpath).relative_to(root)

        for fn in filenames:
            p = Path(dirpath) / fn
            suffix = p.suffix.lower()
            rel = str(p.relative_to(root)).replace("\\", "/")

            # HTML
            if suffix == ".html":
                html_candidates.append(rel)

            # Entry mains
            if suffix in {".js",".jsx",".ts",".tsx"}:
                low = rel.lower()
                if any(x in low for x in ["/main.", "/index.", "pages/_app.", "app/layout."]):
                    main_candidates.append(rel)
                if any(x in low for x in ["app/layout.", "pages/_app."]):
                    app_candidates.append(rel)

    # Deduplicate med stabil prioritering:
    def uniq_keep_order(xs: List[str]) -> List[str]:
        seen = set(); out=[]
        for x in xs:
            if x not in seen:
                seen.add(x); out.append(x)
        return out

    # Sortera: index.html i rot först, sedan kortare vägar
    html_candidates = uniq_keep_order(html_candidates)
    html_candidates.sort(key=lambda r: (0 if r.lower()=="index.html" else 1, r.count("/")))

    main_candidates = uniq_keep_order(main_candidates)
    main_candidates.sort(key=lambda r: r.count("/"))

    app_candidates = uniq_keep_order(app_candidates)
    app_candidates.sort(key=lambda r: r.count("/"))

    return {
        "html": html_candidates[:50],
        "mainFiles": [p for p in main_candidates if any(t in p for t in ["main.","index."])][:50],
        "appFiles": app_candidates[:50],
        "next": {"appDir": (root / "app").exists(), "pagesDir": (root / "pages").exists()},
    }


def _detect_styling_full(
    root: Path, pkg_json: Dict[str, Any], files_iter: Iterable[Tuple[str, str]]
) -> Dict[str, Any]:
    # Tailwind via config + deps + lätta indikationer i kod
    tailwind_present = False
    tailwind_config = None
    for cfg in ("tailwind.config.js", "tailwind.config.cjs", "tailwind.config.ts"):
        if (root / cfg).exists():
            tailwind_present = True
            tailwind_config = cfg
            break

    deps = _deps_from_pkg(pkg_json)
    if "tailwindcss" in deps:
        tailwind_present = True

    ui_libs = set()
    known_ui_markers = [
        "@mui/material",
        "@material-ui/core",
        "styled-components",
        "antd",
        "@chakra-ui/react",
        "@radix-ui",
        "shadcn/ui",
        "class-variance-authority",
        "tailwind-merge",
        "lucide-react",
        "@headlessui/react",
    ]
    hit_budget = 0
    for _rel, text in files_iter:
        if hit_budget > 200:
            break
        hit = False
        for marker in known_ui_markers:
            if marker in text:
                ui_libs.add(marker)
                hit = True
        if not tailwind_present and re.search(RE_TW_CLASSNAME, text):
            tailwind_present = True
        if hit:
            hit_budget += 1

    return {"tailwind": {"present": tailwind_present, "configPath": tailwind_config}, "uiLibs": sorted(ui_libs)}


def _detect_styling_fast(root: Path, pkg_json: Dict[str, Any]) -> Dict[str, Any]:
    # Endast deterministiska källor: config + dependencies (ingen kodskanning)
    tailwind_present = False
    tailwind_config = None
    for cfg in ("tailwind.config.js", "tailwind.config.cjs", "tailwind.config.ts"):
        if (root / cfg).exists():
            tailwind_present = True
            tailwind_config = cfg
            break
    deps = _deps_from_pkg(pkg_json)
    if "tailwindcss" in deps:
        tailwind_present = True

    # UI-libs enbart via deps
    ui_markers = [
        "@mui/material",
        "@material-ui/core",
        "styled-components",
        "antd",
        "@chakra-ui/react",
        "@radix-ui",
        "shadcn/ui",
        "class-variance-authority",
        "tailwind-merge",
        "lucide-react",
        "@headlessui/react",
    ]
    ui_libs = [m for m in ui_markers if m.lower() in deps]

    return {"tailwind": {"present": tailwind_present, "configPath": tailwind_config}, "uiLibs": sorted(ui_libs)}


def _routeify_next_path(rel: str) -> Optional[str]:
    if any(seg.startswith("_") for seg in Path(rel).parts):
        return None
    if "/api/" in rel.replace("\\", "/"):
        return None
    p = re.sub(r"\.(tsx|ts|jsx|js)$", "", rel)
    p = p.replace("\\", "/")
    p = p.replace("pages", "").replace("app", "")
    if p.endswith("/index"):
        p = p[: -len("/index")]
    p = p or "/"
    p = re.sub(r"\[([A-Za-z0-9_]+)\]", r":\1", p)
    if not p.startswith("/"):
        p = "/" + p
    return p


def _detect_routing_full(
    root: Path, pkg_json: Dict[str, Any], files_map: Dict[str, str]
) -> Dict[str, Any]:
    framework = _detect_framework(pkg_json, _detect_configs(root), root)
    routes: List[Dict[str, str]] = []
    rtype = "none"

    # Next filsystemsrouting
    if framework == "next" or (root / "pages").exists() or (root / "app").exists():
        rtype = "next"
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

    # react-router
    rr_hits = 0
    for _rel, text in files_map.items():
        if RE_ROUTE_IMPORT.search(text):
            rr_hits += 1
    if rr_hits:
        rtype = "react-router"
        for rel, text in files_map.items():
            for m in RE_ROUTE_TAG.finditer(text):
                routes.append({"path": m.group(1), "file": rel, "source": "react-router"})
        uniq = {}
        for r in routes:
            uniq[(r["path"], r["file"])] = r
        routes = list(uniq.values())
        return {"type": rtype, "routes": routes, "count": len(routes)}

    return {"type": "none", "routes": [], "count": 0}


def _detect_routing_fast(root: Path) -> Dict[str, Any]:
    # Endast strukturindikatorer (inga textsökningar)
    if (root / "pages").exists() or (root / "app").exists():
        return {"type": "next", "routes": [], "count": 0}
    return {"type": "none", "routes": [], "count": 0}


def _detect_run_candidates(
    scripts: Dict[str, str],
    manager: str,
    framework: str,
    config_hits: List[str],
    root: Path,
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []

    def pref() -> str:
        if manager == "pnpm":
            return "pnpm"
        if manager == "yarn":
            return "yarn"
        if manager == "bun":
            return "bun"
        return "npm run"

    for name, val in (scripts or {}).items():
        if re.search(
            r"\b(next|vite|nuxt|svelte-kit|remix|solid-start|astro|webpack(-dev-server)?|ng\s+serve|storybook|expo)\b",
            val,
            re.I,
        ):
            out.append({"script": name, "cmd": f"{pref()} {name}", "source": "package.json"})

    def push(cmd: str, why: str) -> None:
        out.append({"cmd": cmd, "source": why})

    if any(c.startswith("vite.config") for c in config_hits):
        push("npx -y vite", "vite.config.*")
    if framework == "next" or any(c.startswith("next.config") for c in config_hits):
        push("npx -y next dev", "next")
    if framework == "sveltekit" or any(c.startswith("svelte.config") for c in config_hits):
        push("npx -y vite", "sveltekit")
    if framework == "nuxt" or any(c.startswith("nuxt.config") for c in config_hits):
        push("npx -y nuxi dev", "nuxt")
    if framework == "remix" or any(c.startswith("remix.config") for c in config_hits):
        push("npx -y remix dev", "remix")
    if framework == "solid" or any(c.startswith("solid.config") for c in config_hits):
        push("npx -y solid-start dev", "solid-start")
    if framework == "astro" or any(c.startswith("astro.config") for c in config_hits):
        push("npx -y astro dev", "astro")
    if "angular.json" in config_hits:
        push("npx -y ng serve", "angular.json")

    if any(c.startswith("webpack") for c in config_hits):
        push("npx -y webpack serve", "webpack config")

    entry = _find_entry_points(root)
    if entry.get("html"):
        # Statisk server möjlig
        push("npx -y http-server -p 0", f"static ({entry['html'][0]})")

    # Unika
    seen = set()
    uniq: List[Dict[str, Any]] = []
    for it in out:
        k = json.dumps(it, sort_keys=True)
        if k not in seen:
            seen.add(k)
            uniq.append(it)
    return uniq


def _parse_env_ports(root: Path, max_bytes: int) -> List[Dict[str, Any]]:
    ports: List[Dict[str, Any]] = []
    for name in [".env", ".env.local", ".env.development", ".env.dev", ".envrc"]:
        fp = root / name
        if fp.exists():
            text, _ = _read_text(fp, max_bytes)
            for m in re.finditer(
                r"^(PORT|VITE_PORT|STORYBOOK_PORT)\s*=\s*(\d{2,5})\b",
                text,
                re.MULTILINE,
            ):
                ports.append({"key": m.group(1), "port": int(m.group(2)), "file": str(fp.name)})
    return ports


def _iter_local_files(
    root: Path, include: Optional[List[str]], exclude: Optional[List[str]], ignored_dirs: List[str]
) -> Iterable[Path]:
    ignored = set(ignored_dirs or [])
    for dirpath, dirnames, filenames in os.walk(root):
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

    if path.suffix.lower() in TEXT_EXTS:
        return True
    parts = Path(rel).parts
    if any(seg in SRC_DIR_HINTS for seg in parts) and path.suffix.lower() in {
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".html",
        ".css",
    }:
        return True
    return False


def _collect_files_local(manifest: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, Any], List[str]]:
    root = Path(manifest["root_path"]).expanduser().resolve()
    include = manifest.get("include") or None
    exclude = (manifest.get("exclude") or []) + [
        f"{d}/**" for d in manifest.get("ignored_dirs", IGNORED_DIRS_DEFAULT)
    ]
    max_files = int(manifest.get("max_files", 2000))
    max_file_bytes = int(manifest.get("max_file_bytes", 300_000))

    files_map: Dict[str, str] = {}
    warnings: List[str] = []

    pkg: Dict[str, Any] = {}
    pkg_path = root / "package.json"
    if pkg_path.exists():
        txt, _ = _read_text(pkg_path, max_file_bytes)
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
        if p.suffix.lower() not in TEXT_EXTS and p.name != "package.json":
            continue
        rel = str(p.relative_to(root)).replace("\\", "/")
        text, _ = _read_text(p, max_file_bytes)
        if text == "" and p.name != "package.json":
            continue
        files_map[rel] = text
        count += 1

    return files_map, {"pkg": pkg, "root": str(root)}, warnings


def _collect_files_streamed(manifest: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, Any], List[str]]:
    files_map: Dict[str, str] = {}
    max_files = int(manifest.get("max_files", 2000))
    max_file_bytes = int(manifest.get("max_file_bytes", 300_000))
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
        text = raw.decode("utf-8", errors="ignore")
        files_map[rel] = text

    pkg: Dict[str, Any] = {}
    if "package.json" in files_map:
        try:
            pkg = json.loads(files_map["package.json"])
        except Exception:
            warnings.append("Kunde inte parsa package.json (streamed)")

    return files_map, {"pkg": pkg, "root": str(root)}, warnings


def _collect_minimal_local(manifest: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, Any], List[str]]:
    """
    Minimal deterministisk insamling för 'fast'-profilen:
    - Läs endast package.json (om den finns)
    - Ingen bred källskanning
    """
    root = Path(manifest["root_path"]).expanduser().resolve()
    max_file_bytes = int(manifest.get("max_file_bytes", 300_000))

    files_map: Dict[str, str] = {}
    warnings: List[str] = []

    pkg: Dict[str, Any] = {}
    pkg_path = root / "package.json"
    if pkg_path.exists():
        txt, _ = _read_text(pkg_path, max_file_bytes)
        try:
            pkg = json.loads(txt) if txt else {}
        except Exception:
            warnings.append("Kunde inte parsa package.json")

        # Lägg även in package.json i files_map för ev. konsumenter
        files_map["package.json"] = txt

    return files_map, {"pkg": pkg, "root": str(root)}, warnings


def _collect_minimal_streamed(manifest: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, Any], List[str]]:
    """
    Minimal deterministisk insamling för 'fast'-profilen (streamat läge):
    - Läs endast package.json om den skickats
    """
    files_map: Dict[str, str] = {}
    warnings: List[str] = []
    root = Path(manifest.get("root_path") or ".").resolve()

    pkg: Dict[str, Any] = {}
    files = manifest.get("files") or []
    for f in files:
        if f.get("path") == "package.json":
            b64 = f.get("content_b64") or ""
            try:
                raw = base64.b64decode(b64)
                txt = raw.decode("utf-8", errors="ignore")
                files_map["package.json"] = txt
                pkg = json.loads(txt) if txt else {}
            except Exception:
                warnings.append("Kunde inte parsa package.json (streamed/minimal)")
            break

    return files_map, {"pkg": pkg, "root": str(root)}, warnings


def _to_iterable(files_map: Dict[str, str]) -> Iterable[Tuple[str, str]]:
    for k, v in files_map.items():
        yield k, v


# ======== Celery Task =========


@shared_task(name="backend.tasks.analyze.analyze_project", bind=True)
def analyze_project(self, manifest: Dict[str, Any]) -> Dict[str, Any]:
    """
    Analys med profiler:
      - manifest.profile: "fast" | "full" (default: "full")
      - manifest.mode: "local_paths" | "streamed_files"
    """
    mode = manifest.get("mode")
    if mode not in ("local_paths", "streamed_files"):
        raise ValueError("Ogiltigt mode, använd 'local_paths' eller 'streamed_files'")

    profile = (manifest.get("profile") or "full").lower()
    max_file_bytes = int(manifest.get("max_file_bytes", 300_000))
    max_files = int(manifest.get("max_files", 2000))

    # --- Insamling ---
    if profile == "fast":
        if mode == "local_paths":
            files_map, env, warns = _collect_minimal_local(manifest)
        else:
            files_map, env, warns = _collect_minimal_streamed(manifest)
    else:
        if mode == "local_paths":
            files_map, env, warns = _collect_files_local(manifest)
        else:
            files_map, env, warns = _collect_files_streamed(manifest)

    project_root = Path(env["root"])
    pkg = env.get("pkg") or {}

    # --- Gemensamma lätta detektioner ---
    manager, scripts = _detect_manager_and_scripts(pkg, project_root)
    config_hits = _detect_configs(project_root)
    framework = _detect_framework(pkg, config_hits, project_root)
    entry_points = _find_entry_points(project_root)

    # --- Profil: FAST ---
    if profile == "fast":
        styling = _detect_styling_fast(project_root, pkg)
        routing = _detect_routing_fast(project_root)
        run_candidates = _detect_run_candidates(
            scripts, manager, framework, config_hits, project_root
        )
        env_ports = _parse_env_ports(project_root, max_file_bytes)
        preferred_html = entry_points["html"][0] if entry_points.get("html") else None

        limits = {
            "profile": "fast",
            "maxFileBytes": max_file_bytes,
            "maxFiles": max_files,
            "filesScanned": len(files_map),
            "bytesScanned": sum(
                len(v.encode("utf-8", errors="ignore")) for v in files_map.values()
            ),
            "truncated": 0,
            "ignored": IGNORED_DIRS_DEFAULT,
        }

        warnings = list(warns)

        project_model: Dict[str, Any] = {
            "manager": manager,
            "framework": framework,
            "scripts": scripts,
            "entryPoints": entry_points,
            "styling": styling,
            "routing": routing,
            # Hoppar över tunga delar i fast-profilen:
            "components": [],
            "injectionPoints": [],
            "limits": limits,
            "warnings": warnings,
            "runHints": {
                "candidates": run_candidates,
                "ports": env_ports,
                "configs": config_hits,
                "preferredHtml": preferred_html,
            },
        }
        return {"project_model": project_model}

    # --- Profil: FULL (befintlig logik) ---
    styling = _detect_styling_full(project_root, pkg, _to_iterable(files_map))
    routing = _detect_routing_full(project_root, pkg, files_map)

    # Komponentdetektering
    code_files = {
        rel: txt
        for rel, txt in files_map.items()
        if Path(rel).suffix.lower() in {".js", ".jsx", ".ts", ".tsx"}
    }
    components: List[Dict[str, Any]] = []
    for rel, text in code_files.items():
        if not (RE_JSX_TAG.search(text) or RE_RETURNS_JSX.search(text)):
            continue

        def _mk(name: str, export_type: str, params: str, kind: str) -> Dict[str, Any]:
            has_props = bool(params and (("props" in params) or ("{" in params)))
            prop_names: List[str] = []
            if "{" in params and "}" in params:
                inside = params.split("{", 1)[1].split("}", 1)[0]
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

        for m in RE_EXPORT_DEFAULT_FN.finditer(text):
            components.append(_mk(m.group(1), "default", m.group(2), "function"))
        for m in RE_EXPORT_NAMED_FN.finditer(text):
            components.append(_mk(m.group(1), "named", m.group(2), "function"))
        for m in RE_EXPORT_CONST.finditer(text):
            components.append(_mk(m.group(1), "named", m.group(2), "const"))
        for m in RE_EXPORT_DEFAULT_ARROW.finditer(text):
            base = Path(rel).stem
            name = f"{base}DefaultExport"
            components.append(_mk(name, "default", m.group(1), "const"))

    seen = set()
    unique_components: List[Dict[str, Any]] = []
    for c in components:
        key = (c["file"], c["name"], c["export"])
        if key not in seen:
            seen.add(key)
            unique_components.append(c)

    # @inject
    inj_files = {
        rel: txt
        for rel, txt in files_map.items()
        if Path(rel).suffix.lower() in {".js", ".jsx", ".ts", ".tsx", ".html"}
    }
    injection_points: List[Dict[str, Any]] = []
    for rel, text in inj_files.items():
        for i, line in enumerate(text.splitlines(), start=1):
            m = RE_INJECT_TAG.search(line)
            if m:
                injection_points.append({"file": rel, "line": i, "tag": m.group(1)})

    limits = {
        "profile": "full",
        "maxFileBytes": max_file_bytes,
        "maxFiles": max_files,
        "filesScanned": len(files_map),
        "bytesScanned": sum(
            len(v.encode("utf-8", errors="ignore")) for v in files_map.values()
        ),
        "truncated": 0,
        "ignored": IGNORED_DIRS_DEFAULT,
    }

    warnings = list(warns)
    if framework == "unknown":
        warnings.append(
            "Kunde inte med säkerhet fastställa ramverk (ovanligt projekt eller saknade deps/config)."
        )

    run_candidates = _detect_run_candidates(
        scripts, manager, framework, config_hits, project_root
    )
    env_ports = _parse_env_ports(project_root, max_file_bytes)
    preferred_html = entry_points["html"][0] if entry_points.get("html") else None

    project_model: Dict[str, Any] = {
        "manager": manager,
        "framework": framework,
        "scripts": scripts,
        "entryPoints": entry_points,
        "styling": styling,
        "routing": routing,
        "components": unique_components,
        "injectionPoints": injection_points,
        "limits": limits,
        "warnings": warnings,
        "runHints": {
            "candidates": run_candidates,
            "ports": env_ports,
            "configs": config_hits,
            "preferredHtml": preferred_html,
        },
    }

    return {"project_model": project_model}
