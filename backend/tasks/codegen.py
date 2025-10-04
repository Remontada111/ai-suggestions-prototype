# backend/tasks/codegen.py
from __future__ import annotations
"""
Celery-worker: Figma-node → IR → LLM-förslag → (AST-mount + patch/file) → validering → commit → returnera ändringar

Mål för 1:1-matchning:
- Ingen approximation: exakta mått, positioner, färger, skuggor, typografi, ikoner.
- Absolut determinism: strikt schema, låg temp, hård validering.
- Säkra paths och git-flow, korrekt AST-mount vid AI-INJECT-MOUNT:BEGIN/END.
- Ikoner: exakt export/import som SVG ?url och exakt storlek.
- Inga extra texter/ikoner/wrappers. Endast det som finns i Figma-noden.
"""

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple, cast

import requests
from celery import Celery
from dotenv import load_dotenv
from fastapi import HTTPException
from openai import OpenAI  # type: ignore
from openai.types.chat import (
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
)

from .figma_ir import figma_to_ir, collect_icon_nodes
from .schemas import build_codegen_schema
from .utils import clone_repo, list_components, unique_branch

# ─────────────────────────────────────────────────────────
# Miljö & konfiguration
# ─────────────────────────────────────────────────────────

load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=True)

BROKER_URL = (os.getenv("CELERY_BROKER_URL") or "redis://redis:6379/0").strip()
RESULT_BACKEND = (os.getenv("CELERY_RESULT_BACKEND") or BROKER_URL).strip()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or ""
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()

TARGET_COMPONENT_DIR = (
    os.getenv("TARGET_COMPONENT_DIR", "frontendplay/src/components/ai").strip().rstrip("/")
)
ALLOW_PATCH = [
    p.strip().replace("\\", "/")
    for p in (os.getenv("ALLOW_PATCH", "frontendplay/src/main.tsx").split(";"))
    if p.strip()
]

ICON_DIR = os.getenv("ICON_DIR", "frontendplay/src/assets/icons").strip().rstrip("/")

STRICT_ICONS = os.getenv("STRICT_ICONS", "true").lower() in ("1", "true", "yes")

FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
if not FIGMA_TOKEN:
    raise RuntimeError("FIGMA_TOKEN saknas i miljön (.env).")

ENABLE_VISUAL_VALIDATE = (
    os.getenv("ENABLE_VISUAL_VALIDATE", "false").lower() in ("1", "true", "yes")
)

# ─────────────────────────────────────────────────────────
# Celery-app
# ─────────────────────────────────────────────────────────

app = Celery("codegen", broker=BROKER_URL, backend=RESULT_BACKEND)
app.conf.broker_connection_retry_on_startup = True
app.conf.broker_connection_timeout = 3
app.conf.redis_socket_timeout = 3
celery_app: Celery = app

# ─────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────

logger = logging.getLogger(__name__)
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)
logger.setLevel(logging.INFO)

# ─────────────────────────────────────────────────────────
# Hjälpfunktioner (shell, PM, git, IO)
# ─────────────────────────────────────────────────────────

def _run(cmd: List[str], cwd: str | Path | None = None, timeout: int | None = None) -> Tuple[int, str, str]:
    p = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    return p.returncode, p.stdout, p.stderr


def _detect_pm(workdir: Path) -> str:
    """
    Bestäm paketmanager.
    Prioritet: package.json:packageManager → låsfil → npm.
    """
    pkg = workdir / "package.json"
    try:
        if pkg.exists():
            data = json.loads(pkg.read_text(encoding="utf-8"))
            pm_field = str(data.get("packageManager") or "").lower()
            if     pm_field.startswith("npm@"):  return "npm"
            if     pm_field.startswith("pnpm@"): return "pnpm"
            if     pm_field.startswith("yarn@"): return "yarn"
            if     pm_field.startswith("bun@"):  return "bun"
    except Exception:
        pass

    if   (workdir / "package-lock.json").exists(): return "npm"
    if   (workdir / "pnpm-lock.yaml").exists():    return "pnpm"
    if   (workdir / "yarn.lock").exists():         return "yarn"
    if   (workdir / "bun.lockb").exists():         return "bun"
    return "npm"


def _run_install(workdir: Path) -> None:
    """
    Kör install enligt vald PM.
    """
    pm = _detect_pm(workdir)
    tries: List[List[str]] = []

    if pm == "npm":
        if (workdir / "package-lock.json").exists():
            tries.append(["npm", "ci", "--silent"])
        tries.append(["npm", "install", "--silent"])
    elif pm == "pnpm":
        if (workdir / "pnpm-lock.yaml").exists():
            tries.append(["pnpm", "-s", "install", "--frozen-lockfile"])
        tries.append(["pnpm", "-s", "install"])
    elif pm == "yarn":
        tries.append(["yarn", "install", "--immutable"])
        tries.append(["yarn", "install", "--frozen-lockfile"])
        tries.append(["yarn", "install"])
    elif pm == "bun":
        tries.append(["bun", "install"])
    else:
        tries.append(["npm", "install", "--silent"])

    last: Tuple[int, str, str] | None = None
    for cmd in tries:
        rc, out, err = _run(cmd, cwd=workdir)
        if rc == 0:
            return
        last = (rc, out, err)

    msg = (last or (1, "", "okänd install-fail"))[2] or (last or (1, "", "okänd install-fail"))[1]
    raise HTTPException(500, f"Dependency install misslyckades i {workdir}:\n{msg}")


def _git_apply(repo_root: Path, diff_text: str) -> None:
    """Applicera unified diff via git apply (failar på reject)."""
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".patch", encoding="utf-8") as f:
        f.write(diff_text)
        patch_path = f.name
    try:
        rc, out, err = _run(
            ["git", "-C", str(repo_root), "apply", "--reject", "--whitespace=nowarn", patch_path],
            cwd=repo_root,
        )
        if rc != 0:
            raise HTTPException(500, f"git apply misslyckades:\n{err or out}")
    finally:
        try:
            os.unlink(patch_path)
        except Exception:
            pass


def _fetch_figma_node(file_key: str, node_id: str) -> Dict[str, Any]:
    """Hämtar Figma-JSON för angiven node."""
    url = f"https://api.figma.com/v1/files/{file_key}/nodes"
    headers = {"X-Figma-Token": FIGMA_TOKEN}
    try:
        resp = requests.get(url, params={"ids": node_id}, headers=headers, timeout=20)
    except requests.RequestException as e:
        raise HTTPException(502, f"Kunde inte nå Figma-API: {e}") from e

    if resp.status_code != 200:
        raise HTTPException(502, f"Figma-API-fel ({resp.status_code}): {resp.text}")
    try:
        data = resp.json()
    except Exception as e:
        raise HTTPException(502, f"Ogiltigt JSON-svar från Figma: {e}") from e
    return cast(Dict[str, Any], data)


def _safe_join(repo_root: Path, rel: str) -> Path:
    """Förhindra path-escape. Returnerar absolut path under repo_root."""
    p = (repo_root / rel).resolve()
    root = repo_root.resolve()
    if not str(p).startswith(str(root)):
        raise HTTPException(400, f"Otillåten sökväg: {rel}")
    return p


def _read_rel(repo_root: Path, rel: str) -> Dict[str, str]:
    p = _safe_join(repo_root, rel)
    if not p.exists():
        raise HTTPException(500, f"Fil saknas: {rel}")
    return {"path": rel.replace("\\", "/"), "content": p.read_text(encoding="utf-8")}


def _ensure_node_modules(repo_root: Path) -> None:
    """
    Installera beroenden där package.json finns (root och/eller frontendplay).
    """
    candidates: List[Path] = []
    root_pkg = repo_root / "package.json"
    fp_pkg = repo_root / "frontendplay" / "package.json"

    if root_pkg.exists():
        candidates.append(repo_root)
    if fp_pkg.exists():
        candidates.append(fp_pkg.parent)

    if not candidates:
        logger.info("Hittar ingen package.json – hoppar över install.")
        return

    for workdir in candidates:
        nm = workdir / "node_modules"
        if nm.exists():
            continue
        logger.info("node_modules saknas – kör install i %s …", workdir)
        _run_install(workdir)


def _package_scripts(repo_root: Path) -> Dict[str, str]:
    for base in (repo_root, repo_root / "frontendplay"):
        pkg = base / "package.json"
        if pkg.exists():
            try:
                data = json.loads(pkg.read_text(encoding="utf-8"))
                return cast(Dict[str, str], (data.get("scripts") or {}))
            except Exception:
                return {}
    return {}


def _has_script(repo_root: Path, name: str) -> bool:
    scripts = _package_scripts(repo_root)
    return name in scripts and isinstance(scripts[name], str) and len(scripts[name]) > 0


def _run_pm_script(base: Path, script: str, extra_args: List[str] | None = None) -> Tuple[int, str, str]:
    extra_args = extra_args or []
    pm = _detect_pm(base)
    if pm == "npm":
        return _run(["npm", "run", script, "--silent", "--", *extra_args], cwd=base)
    if pm == "pnpm":
        return _run(["pnpm", "-s", script, *extra_args], cwd=base)
    if pm == "yarn":
        return _run(["yarn", "script", script, *extra_args], cwd=base) if os.name == "nt" else _run(["yarn", script, *extra_args], cwd=base)
    if pm == "bun":
        return _run(["bun", "run", script, *extra_args], cwd=base)
    return _run(["npm", "run", script, "--silent", "--", *extra_args], cwd=base)

# ─────────────────────────────────────────────────────────
# Geometrihjälp
# ─────────────────────────────────────────────────────────

def _rect_intersect(a: Dict[str, float] | None, b: Dict[str, float] | None) -> Dict[str, float] | None:
    if not a or not b:
        return a or b
    x1 = max(a["x"], b["x"]); y1 = max(a["y"], b["y"])
    x2 = min(a["x"] + a["w"], b["x"] + b["w"]); y2 = min(a["y"] + a["h"], b["y"] + b["h"])
    if x2 <= x1 or y2 <= y1:
        return None
    return {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}

# ─────────────────────────────────────────────────────────
# Ikon-export (SVG) via Figma Images API
# ─────────────────────────────────────────────────────────

def _fetch_svgs(file_key: str, ids: List[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not ids:
        return out

    url = f"https://api.figma.com/v1/images/{file_key}"
    headers = {"X-Figma-Token": FIGMA_TOKEN}
    try:
        r = requests.get(
            url,
            params={"ids": ",".join(ids), "format": "svg", "use_absolute_bounds": "true"},
            headers=headers,
            timeout=20,
        )
        r.raise_for_status()
        images = (r.json() or {}).get("images", {}) or {}
    except requests.RequestException as e:
        raise HTTPException(502, f"Figma Images API error: {e}")

    for nid, presigned in images.items():
        if not presigned:
            continue
        try:
            svg_resp = requests.get(presigned, timeout=20)
            svg_resp.raise_for_status()
            svg_text = svg_resp.text
            out[str(nid)] = svg_text
        except requests.RequestException as e:
            logger.warning("Misslyckades hämta SVG för %s: %s", nid, e)
    return out

# ─────────────────────────────────────────────────────────
# Text-extraktion ur IR (synliga noder) + normalisering
# ─────────────────────────────────────────────────────────

_WS = re.compile(r"\s+")
def _canon_text(s: str | None) -> str:
    if not isinstance(s, str):
        return ""
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    return _WS.sub(" ", s).strip()

# Nyckel för robust jämförelse: case-insensitive + ellipsis/nbsp-normalisering
def _norm_key(s: str) -> str:
    if not isinstance(s, str):
        return ""
    s = s.replace("\u2026", "...")  # … → ...
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    s = _WS.sub(" ", s).strip()
    return s.casefold()

# Splitta på radbrytningar och vanliga bullets
_LINE_SPLIT = re.compile(r"(?:\r?\n|[\u2022\u00B7•]+)\s*")
def _canon_text_lines(s: str | None) -> list[str]:
    if not isinstance(s, str):
        return []
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    parts = [_WS.sub(" ", p).strip() for p in _LINE_SPLIT.split(s)]
    return [p for p in parts if p]

def _effectively_visible_ir(n: Dict[str, Any], clip: Dict[str, float] | None) -> bool:
    if not n.get("visible", True):
        return False
    try:
        if float(n.get("opacity", 1) or 1) <= 0.01:
            return False
    except Exception:
        pass
    b = n.get("bounds")
    if clip is None or not isinstance(b, dict):
        return True
    return _rect_intersect(clip, b) is not None

def _next_clip_ir(n: Dict[str, Any], clip: Dict[str, float] | None) -> Dict[str, float] | None:
    if n.get("clips_content"):
        b = n.get("bounds")
        if isinstance(b, dict):
            return _rect_intersect(clip, b) if clip else b
    return clip

def _collect_visible_texts(n: Dict[str, Any], out: List[str], clip: Dict[str, float] | None) -> None:
    if not _effectively_visible_ir(n, clip):
        return
    next_clip = _next_clip_ir(n, clip)

    if n.get("type") == "TEXT":
        tnode = (n.get("text") or {})
        lines = tnode.get("lines") or []
        if lines:
            out.extend([_canon_text(x) for x in lines if x])
        else:
            t = _canon_text(tnode.get("content") or "")
            if t:
                out.append(t)
            else:
                nm = _canon_text(n.get("name") or "")
                if nm:
                    out.append(nm)

    for ch in n.get("children", []) or []:
        _collect_visible_texts(ch, out, next_clip)

def _required_texts(ir: Dict[str, Any]) -> List[str]:
    acc: List[str] = []
    root = ir["root"]
    _collect_visible_texts(root, acc, None)
    seen: set[str] = set()
    out: List[str] = []
    for s in acc:
        cs = _canon_text(s)
        if 0 < len(cs) <= 80:
            k = _norm_key(cs)
            if k not in seen:
                seen.add(k)
                out.append(cs)
    return out

# ─────────────────────────────────────────────────────────
# LLM-prompt
# ─────────────────────────────────────────────────────────

def _build_messages(
    ir: dict,
    components: dict[str, Path],
    placement: dict | None,
    icon_assets: List[Dict[str, Any]],
) -> list[Any]:
    try:
        overview = {name: str(path.relative_to(Path.cwd())) for name, path in components.items()}
    except Exception:
        overview = {name: str(path) for name, path in components.items()}

    user_payload = {
        "ir": ir,
        "components": overview,
        "placement": placement or {},
        "icon_assets": icon_assets,  # [{id,name,import_path,fs_path,w,h}]
        "required_texts": _required_texts(ir),
        "constraints": {
            "framework": "react+vite",
            "mount_anchor": "AI-INJECT-MOUNT",
            "target_component_dir": TARGET_COMPONENT_DIR,
            "allow_patch": ALLOW_PATCH,
            "no_inline_styles": True,
            "no_dangerous_html": True,
        },
    }

    system = (
        "Du genererar en enda React-komponentfil som återger Figma-noden 1:1. "
        "Inga extra texter, inga extra ikoner, inga wrappers utöver vad som krävs för exakt layout. "
        "Inga inline-styles, ingen farlig HTML, inga design-tokens; använd Tailwind med godtyckliga värden. "
        "ALLA visuella värden ska uttryckas explicit som Tailwind arbitrary utilities: "
        "bredd/height/left/top/gap/padding som w-[NNpx]/h-[NNpx]/left-[NNpx]/top-[NNpx]/gap-[NNpx]/pt-[..] osv, "
        "fontstorlek text-[NNpx], line-height leading-[NNpx], letter-spacing tracking-[NNpx] eller procent, "
        "färger text-[#RRGGBB] eller text-[rgba(...)] och bg-[#RRGGBB]/bg-[rgba(...)] eller bg-[linear-gradient(...)], "
        "skuggor shadow-[offsets blur spread rgba], hörn rounded-[NNpx] eller per-hörn, border border-[NNpx] och border-[#RRGGBB]. "
        "Ikoner: importera EXAKT de givna 'icon_assets' som URL med '?url' och rendera <img src={...} alt='' aria-hidden='true' "
        "width={w} height={h} className='inline-block align-middle'/> exakt en gång per ikon. Ändra aldrig SVG-innehåll. "
        "Teman: lägg inte till tema-switchar eller text som 'Light mode'. "
        "JSX får endast innehålla texterna i 'required_texts' ordagrant. "
        "För TEXT-noder: om 'text.lines' finns ska varje rad renderas separat (t.ex. text + <br/> eller separata spans); "
        "slå aldrig ihop flera rader till en enda sträng. "
        "Rendera barn i stigande 'z' (barnens index). "
        "Skapa/uppdatera alltid en komponentfil (mode='file') i target_component_dir och montera via 'mount'; patch av main.tsx är förbjudet. "
        "Skriv aldrig ``` i något fält."
    )

    return [
        ChatCompletionSystemMessageParam(role="system", content=system),
        ChatCompletionUserMessageParam(role="user", content=json.dumps(user_payload, ensure_ascii=False)),
    ]

# ─────────────────────────────────────────────────────────
# Hjälpare för relativ import till main.tsx
# ─────────────────────────────────────────────────────────

_ANCHOR_SINGLE = "AI-INJECT-MOUNT"
_ANCHOR_BEGIN = "AI-INJECT-MOUNT:BEGIN"
_ANCHOR_END = "AI-INJECT-MOUNT:END"
_ANCHOR_JSX = "{/* AI-INJECT-MOUNT */}"
_ANCHOR_JSX_BEGIN = "{/* AI-INJECT-MOUNT:BEGIN */}"
_ANCHOR_JSX_END = "{/* AI-INJECT-MOUNT:END */}"

def _rel_import_from_main(main_tsx: Path, target_file: Path) -> str:
    rel = os.path.relpath(target_file.with_suffix(""), main_tsx.parent).replace("\\", "/")
    if not rel.startswith("."):
        rel = "./" + rel
    return rel

# ─────────────────────────────────────────────────────────
# AST-injektion (main.tsx) och säkert ankare
# ─────────────────────────────────────────────────────────

def _has_pair_markers(src: str) -> bool:
    b = re.search(r"\{\s*/\*\s*AI-INJECT-MOUNT:BEGIN\s*\*/\s*\}", src)
    e = re.search(r"\{\s*/\*\s*AI-INJECT-MOUNT:END\s*\*/\s*\}", src)
    return bool(b and e and e.start() > b.start())

def _replace_single_with_pair(src: str) -> str:
    patterns = [
        r"\{/\*\s*AI-INJECT-MOUNT\s*\*/\}",
        r"//[ \t]*AI-INJECT-MOUNT.*",
        r"/\*[ \t]*AI-INJECT-MOUNT[ \t]*\*/",
    ]
    for pat in patterns:
        m = re.search(pat, src)
        if not m:
            continue
        line_start = src.rfind("\n", 0, m.start()) + 1
        indent_match = re.match(r"[ \t]*", src[line_start:m.start()])
        indent = indent_match.group(0) if indent_match else ""
        replacement = f"{_ANCHOR_JSX_BEGIN}\n{indent}{_ANCHOR_JSX_END}"
        return src[:m.start()] + replacement + src[m.end():]
    return src

def _ensure_anchor_in_main(main_tsx: Path) -> None:
    src = main_tsx.read_text(encoding="utf-8")

    if _has_pair_markers(src):
        return

    if _ANCHOR_SINGLE in src:
        new_src = _replace_single_with_pair(src)
        main_tsx.write_text(new_src, encoding="utf-8")
        return

    m = re.search(r"</React\.StrictMode>", src)
    if m:
        insert = "    " + _ANCHOR_JSX_BEGIN + "\n" + "    " + _ANCHOR_JSX_END + "\n"
        src = src[:m.start()] + insert + src[m.start():]
        main_tsx.write_text(src, encoding="utf-8")
        return

    m = re.search(r"render\(\s*(<App\s*/>)\s*\)", src)
    if m:
        inner = m.group(1)
        frag = f"<>{inner} {_ANCHOR_JSX_BEGIN} {_ANCHOR_JSX_END}</>"
        src = src[:m.start()] + "render(" + frag + ")" + src[m.end():]
        main_tsx.write_text(src, encoding="utf-8")
        return

    if _ANCHOR_BEGIN not in src and _ANCHOR_END not in src:
        src += (
            "\n\n// Auto-added safe mount wrapper\n"
            "function __AiMountSafe__() { return (<>\n"
            f"  {_ANCHOR_JSX_BEGIN}\n"
            f"  {_ANCHOR_JSX_END}\n"
            "</>); }\n"
        )
    main_tsx.write_text(src, encoding="utf-8")

def _ast_inject_mount(repo_root: Path, mount: dict) -> None:
    """
    Kör TS/AST-injektion som säkerställer import + JSX-mount vid AI-INJECT-MOUNT:BEGIN/END.
    """
    main_tsx = next(
        (Path(repo_root, p) for p in ALLOW_PATCH if p.endswith("main.tsx")),
        Path(repo_root, "frontendplay/src/main.tsx"),
    )
    if not main_tsx.exists():
        raise HTTPException(500, f"Hittar inte main.tsx: {main_tsx}")

    import_name = mount.get("import_name")
    import_path = mount.get("import_path")
    jsx = mount.get("jsx")
    if not (import_name and import_path and jsx):
        raise HTTPException(500, "Mount-objektet saknar obligatoriska fält.")

    _ensure_anchor_in_main(main_tsx)

    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".jsx.txt", encoding="utf-8") as tmp:
        tmp.write(_sanitize_tailwind_conflicts(str(jsx)))
        jsx_file_path = tmp.name

    try:
        base = main_tsx.parent
        while base != base.parent and not (base / "package.json").exists():
            base = base.parent
        if not (base / "package.json").exists():
            fp_pkg = repo_root / "frontendplay" / "package.json"
            base = fp_pkg.parent if fp_pkg.exists() else repo_root

        script_path = repo_root / "scripts" / "ai_inject_mount.ts"
        if not script_path.exists():
            raise HTTPException(500, f"Saknar scripts/ai_inject_mount.ts: {script_path}")

        logger.info("AST-inject start main=%s import_name=%s import_path=%s", main_tsx, import_name, import_path)

        cmd1 = [
            "node", "--import", "tsx",
            str(script_path), str(main_tsx), str(import_name), str(import_path), str(jsx_file_path),
        ]
        rc, out, err = _run(cmd1, cwd=base)
        logger.info("node --import tsx rc=%s\nstdout:\n%s\nstderr:\n%s", rc, (out or "").strip(), (err or "").strip())
        if rc == 0:
            return

        cmd1b = [
            "node", "--loader", "tsx",
            str(script_path), str(main_tsx), str(import_name), str(import_path), str(jsx_file_path),
        ]
        rc1b, out1b, err1b = _run(cmd1b, cwd=base)
        logger.info("node --loader tsx rc=%s\nstdout:\n%s\nstderr:\n%s", rc1b, (out1b or "").strip(), (err1b or "").strip())
        if rc1b == 0:
            return

        cmd2 = ["npx", "tsx", str(script_path), str(main_tsx), str(import_name), str(import_path), str(jsx_file_path)]
        rc2, out2, err2 = _run(cmd2, cwd=base)
        logger.info("npx tsx rc=%s\nstdout:\n%s\nstderr:\n%s", rc2, (out2 or "").strip(), (err2 or "").strip())

        if rc2 != 0:
            raise HTTPException(
                500,
                "AST-injektion misslyckades:\n"
                f"{' '.join(cmd1)}\n{err or out}\n\n"
                f"{' '.join(cmd1b)}\n{err1b or out1b}\n\n"
                f"{' '.join(cmd2)}\n{err2 or out2}"
            )
    finally:
        try:
            os.unlink(jsx_file_path)
        except Exception:
            pass

# ─────────────────────────────────────────────────────────
# Typecheck/lint/visual
# ─────────────────────────────────────────────────────────

def _typecheck_and_lint(repo_root: Path) -> None:
    base = repo_root
    if not (base / "package.json").exists() and (repo_root / "frontendplay" / "package.json").exists():
        base = repo_root / "frontendplay"

    if _has_script(base, "typecheck"):
        rc, out, err = _run_pm_script(base, "typecheck")
        if rc != 0:
            raise HTTPException(500, f"Typecheck misslyckades:\n{err or out}")
    else:
        logger.info("Hoppar över typecheck (script saknas).")

    if _has_script(base, "lint:fix"):
        rc, out, err = _run_pm_script(base, "lint:fix")
        if rc != 0:
            logger.warning("lint:fix returnerade felkod: %s\n%s", rc, err or out)
    else:
        logger.info("Hoppar över lint:fix (script saknas).")

def _visual_validate(repo_root: Path) -> Dict[str, Any] | None:
    if not ENABLE_VISUAL_VALIDATE:
        return None

    base = repo_root
    if not (base / "package.json").exists() and (repo_root / "frontendplay" / "package.json").exists():
        base = repo_root / "frontendplay"

    if not _has_script(base, "test:visual"):
        logger.info("Hoppar över visuell validering (test:visual saknas).")
        return None

    logger.info("Kör visuell validering …")
    rc, out, err = _run_pm_script(base, "test:visual", ["--reporter=line"])
    if rc != 0:
        raise HTTPException(500, f"Visuell validering misslyckades:\n{err or out}")

    return {"status": "ok"}

# ─────────────────────────────────────────────────────────
# Modellsvaret: validering och normalisering
# ─────────────────────────────────────────────────────────

_TRIPLE_BACKTICKS = re.compile(r"```")
_CLS_RE = re.compile(r'className\s*=\s*(?P<q>"|\')(?P<val>.*?)(?P=q)', re.DOTALL)
_TEXT_NODE = re.compile(r">\s*([^<>{}][^<>{}]*)\s*<")

def _px(x: Any | None) -> str | None:
    if x is None:
        return None
    try:
        fx = float(x)
        if abs(fx - round(fx)) < 1e-6:
            return f"{int(round(fx))}px"
        return f"{round(fx,2)}px"
    except Exception:
        return None

def _bool(x: Any, default=False) -> bool:
    if isinstance(x, bool):
        return x
    if x in (0, "0", "false", "False", None):
        return False
    if x in (1, "1", "true", "True"):
        return True
    return default

def _sanitize_tailwind_conflicts(src: str) -> str:
    """Ta bort typiska Tailwind-konflikter och normalisera whitespace i className."""
    def fix(m: re.Match) -> str:
        q = m.group("q")
        cls = m.group("val")

        if re.search(r'\bborder-\[[0-9.]+px\]', cls):
            cls = re.sub(r'(?<!-)\bborder\b', '', cls)

        if re.search(r'\babsolute\b', cls):
            cls = re.sub(r'\brelative\b', '', cls)

        # Rensa bort ogiltiga Tailwind-arbitrary som börjar med bindestreck
        cls = re.sub(r'(^|\s)-\[[^\]]+\]', ' ', cls)

        cls = re.sub(r'\s+', ' ', cls).strip()
        return f'className={q}{cls}{q}'

    return _CLS_RE.sub(fix, src)

# ── Textsanering: ta bort oönskade textnoder och SVG-metadata ──────────────

_SVG_META = re.compile(r"<\s*(title|desc)\b[^>]*>.*?<\s*/\s*\1\s*>", re.IGNORECASE | re.DOTALL)
_TEXT_NODE_BETWEEN = re.compile(r">\s*([^<>{}][^<>{}]*)\s*<", re.DOTALL)

def _strip_svg_meta(src: str) -> str:
    return _SVG_META.sub("", src)

def _purge_unexpected_text_nodes(src: str, allowed: List[str]) -> str:
    allowed_norm = {_norm_key(a) for a in allowed}
    def repl(m: re.Match) -> str:
        txt = _canon_text(m.group(1)).replace("\u2026","...")
        return m.group(0) if _norm_key(txt) in allowed_norm else m.group(0).replace(m.group(1), "")
    return _TEXT_NODE_BETWEEN.sub(repl, src)

def _extract_jsx_text(src: str) -> List[str]:
    parts: List[str] = []
    for m in _TEXT_NODE.finditer(src):
        raw = m.group(1)
        parts.extend(_canon_text_lines(raw))  # radvis
    # Filtrera bort “kodlika” tokens
    parts = [p for p in parts if not re.fullmatch(r"[A-Za-z0-9@_./\-]+", p)]
    # Normalisera ellipsis/nbsp i själva värdet som rapporteras vidare
    return [_canon_text(p).replace("\u2026", "...") for p in parts if 0 < len(p) <= 80]

def _assert_no_extra_texts(ir: Dict[str, Any], file_code: str) -> None:
    exp_raw = _required_texts(ir)
    exp = {_norm_key(t) for t in exp_raw}
    found_raw = _extract_jsx_text(file_code)
    found_norm = {_norm_key(t) for t in found_raw}
    extra = [t for t in found_raw if _norm_key(t) not in exp]
    # Tillåt tomma “Search…” placeholders att ignoreras om de inte finns i IR
    extra = [t for t in extra if _norm_key(t) not in exp]
    if extra:
        raise HTTPException(500, "Extra texter i JSX: " + ", ".join(extra[:12]))

def _assert_text_coverage(ir: Dict[str, Any], file_code: str) -> None:
    exp_raw = _required_texts(ir)
    exp = {_norm_key(t) for t in exp_raw}
    found_raw = _extract_jsx_text(file_code)
    found = {_norm_key(t) for t in found_raw}
    missing = [t for t in exp_raw if _norm_key(t) not in found]
    if missing:
        raise HTTPException(500, "Saknade textnoder i genererad kod: " + ", ".join(missing[:15]))

# Ytterligare 1:1-asserts

def _gather_classes(file_code: str) -> str:
    return " ".join(m.group("val") for m in _CLS_RE.finditer(file_code))

def _assert_dims_positions(ir: Dict[str, Any], file_code: str) -> None:
    """Kräv explicita w-/h- och left-/top- klasser där tillämpligt."""
    classes = _gather_classes(file_code)

    def need(px, key):
        s = _px(px)
        return f"{key}-[{s}]" if s else None

    def rec(n: Dict[str,Any]):
        if not n.get("visible", True):
            return
        b = n.get("bounds") or {}
        if b:
            for tok in filter(None, [need(b.get("w"), "w"), need(b.get("h"), "h")]):
                if tok and tok not in classes:
                    raise HTTPException(500, f"Saknar klass {tok}")
        if n.get("abs"):
            for tok in filter(None, [need(b.get("x"), "left"), need(b.get("y"), "top")]):
                if tok and tok not in classes:
                    raise HTTPException(500, f"Saknar klass {tok}")
        for ch in n.get("children") or []:
            rec(ch)
    rec(ir["root"])

def _hex_to_rgba_str(hex_col: str, a: float) -> str:
    r = int(hex_col[1:3],16); g = int(hex_col[3:5],16); b = int(hex_col[5:7],16)
    return f"rgba({r}, {g}, {b}, {a})"

def _assert_colors_shadows_and_gradients(ir: Dict[str, Any], file_code: str) -> None:
    """Kräv explicita text-/bg-färger och skuggor, samt gradientklass där gradient används."""
    classes = _gather_classes(file_code)

    def rec(n: Dict[str,Any]):
        fills = n.get("fills") or []
        # Första synliga fill
        for f in fills:
            if _bool(f.get("visible", True), True):
                t = str(f.get("type") or "")
                if t == "SOLID":
                    col = f.get("color"); a = float(f.get("alpha",1) or 1)
                    if not col:
                        break
                    want = None
                    if n.get("type") == "TEXT":
                        want = f"text-[{col}]" if a>=0.999 else f"text-[{_hex_to_rgba_str(col,a)}]"
                    else:
                        want = f"bg-[{col}]" if a>=0.999 else f"bg-[{_hex_to_rgba_str(col,a)}]"
                    if want and want not in classes:
                        raise HTTPException(500, f"Saknar färgklass {want}")
                    break
                if t.startswith("GRADIENT_"):
                    if "bg-[linear-gradient(" not in classes:
                        raise HTTPException(500, "Saknar gradientklass bg-[linear-gradient(...)]")
                    break
        # Skugga
        css = n.get("css") or {}
        if css.get("boxShadow"):
            want = f"shadow-[{css['boxShadow']}]"
            if want not in classes:
                raise HTTPException(500, f"Saknar skuggklass {want}")
        # Nästa
        for ch in n.get("children") or []:
            rec(ch)
    rec(ir["root"])

def _assert_typography(ir: Dict[str, Any], file_code: str) -> None:
    """Kräv text-[NNpx], optional leading-[NNpx], optional tracking-[...], tolerera font-weight."""
    classes = _gather_classes(file_code)

    def weight_ok(weight: int) -> List[str]:
        map_std = {
            100:"font-thin",200:"font-extralight",300:"font-light",400:"font-normal",
            500:"font-medium",600:"font-semibold",700:"font-bold",800:"font-extrabold",900:"font-black"
        }
        cand = [map_std.get(weight,""), f"font-[{weight}]", f"font-{weight}"]
        return [c for c in cand if c]

    def rec(n: Dict[str,Any]):
        if n.get("type") == "TEXT":
            st = (n.get("text") or {}).get("style") or {}
            fs = st.get("fontSize")
            if isinstance(fs, (int, float)):
                want = f"text-[{_px(fs)}]"
                if want not in classes:
                    raise HTTPException(500, f"Saknar fontstorleksklass {want}")
            lh = st.get("lineHeight")
            if isinstance(lh, str) and lh.endswith("px"):
                want = f"leading-[{lh}]"
                if want not in classes:
                    raise HTTPException(500, f"Saknar line-height klass {want}")
            ls = st.get("letterSpacing")
            if isinstance(ls, str) and len(ls) > 0:  # 'Npx' eller 'N%'
                want = f"tracking-[{ls}]"
                if want not in classes:
                    raise HTTPException(500, f"Saknar letter-spacing klass {want}")
            fw = st.get("fontWeight")
            if isinstance(fw, int) and fw in range(100, 1000, 100):
                if not any(w in classes for w in weight_ok(fw)):
                    raise HTTPException(500, f"Saknar font-weight klass för {fw}")
        for ch in n.get("children") or []:
            rec(ch)
    rec(ir["root"])

# ─────────────────────────────────────────────────────────
# Ikon-krav: typer, filnamn och validering
# ─────────────────────────────────────────────────────────

def _ensure_svg_types(repo_root: Path) -> str | None:
    rel = "frontendplay/src/types/svg.d.ts"
    p = _safe_join(repo_root, rel)
    if p.exists():
        return None
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "declare module '*.svg' { const src: string; export default src }\n"
        "declare module '*.svg?url' { const src: string; export default src }\n",
        encoding="utf-8",
    )
    return rel

def _icon_filename(name_slug: str, node_id: str) -> str:
    h = hashlib.sha1(node_id.encode("utf-8")).hexdigest()[:6]
    safe = re.sub(r"[^a-z0-9\-]+", "-", (name_slug or "icon").lower()).strip("-") or "icon"
    return f"{safe}-{h}.svg"

_IMG_IMPORT = re.compile(r"import\s+(\w+)\s+from\s+['\"]([^'\"]+\.svg(?:\?url)?)['\"]")
_IMG_TAG = re.compile(r"<img\b[^>]*?>", re.IGNORECASE | re.DOTALL)
_SRC_VAR = re.compile(r"src=\{(\w+)\}", re.IGNORECASE | re.DOTALL)
_NUM_IN_ATTR = re.compile(
    r"(width|height)\s*=\s*(?:\{\s*([0-9]+)\s*\}|['\"]\s*([0-9]+)\s*['\"])",
    re.IGNORECASE | re.DOTALL,
)

def _assert_icons_used(file_code: str, icon_assets: List[Dict[str, Any]]) -> None:
    if not icon_assets:
        return

    imports = {m.group(1): m.group(2) for m in _IMG_IMPORT.finditer(file_code)}
    used_vars: set[str] = set()
    size_by_var: Dict[str, Tuple[int | None, int | None]] = {}

    for tag in _IMG_TAG.findall(file_code):
        m = _SRC_VAR.search(tag)
        if not m:
            continue
        var = m.group(1)
        used_vars.add(var)
        w = h = None
        for attr, n1, n2 in _NUM_IN_ATTR.findall(tag):
            val = int(n1 or n2) if (n1 or n2) else None
            if   attr.lower() == "width":  w = val
            elif attr.lower() == "height": h = val
        size_by_var[var] = (w, h)

    used_paths = [imports[v] for v in used_vars if v in imports]
    all_svg_import_paths = [p for p in imports.values() if p.lower().endswith(".svg") or p.lower().endswith(".svg?url")]

    missing: List[str] = []
    duplicates: List[str] = []
    size_issues: List[str] = []
    unexpected_paths: List[str] = []
    seen_expected: set[str] = set()

    expected = {ia["import_path"] for ia in icon_assets}

    for p in all_svg_import_paths:
        if not any(p.endswith(e) or p.endswith(e + "?url") for e in expected):
            unexpected_paths.append(p)

    for ia in icon_assets:
        p = ia["import_path"]
        if p in seen_expected:
            continue
        seen_expected.add(p)

        ok = any(s.endswith(p) or s.endswith(p + "?url") for s in used_paths)
        if not ok:
            missing.append(p)
            continue

        count = sum(1 for s in used_paths if s.endswith(p) or s.endswith(p + "?url"))
        if count != 1:
            duplicates.append(f"{p} användningar: {count}")

        w_target = int(round(float(ia.get("w") or 0)))
        h_target = int(round(float(ia.get("h") or 0)))
        vars_for_path = [v for v, path in imports.items() if path.endswith(p) or path.endswith(p + "?url")]
        good = False
        for v in vars_for_path:
            w, h = size_by_var.get(v, (None, None))
            if w == w_target and h == h_target:
                good = True
                break
        if not good:
            size_issues.append(f"{p} ska vara {w_target}x{h_target}px")

    if missing or size_issues or duplicates or unexpected_paths:
        problems = []
        if missing:
            problems.append("saknar import+<img> för: " + ", ".join(missing))
        if duplicates:
            problems.append("måste användas exakt 1 gång: " + "; ".join(duplicates))
        if size_issues:
            problems.append("fel storlek: " + "; ".join(size_issues))
        if unexpected_paths:
            problems.append("otillåtna ikoner: " + ", ".join(sorted(set(unexpected_paths))))
        msg = "Ikonvalidering: " + " | ".join(problems)
        if STRICT_ICONS:
            raise HTTPException(500, msg)
        logger.warning(msg)

# ─────────────────────────────────────────────────────────
# Celery-task
# ─────────────────────────────────────────────────────────

@app.task(name="backend.tasks.codegen.integrate_figma_node")
def integrate_figma_node(
    *, file_key: str, node_id: str, placement: Dict[str, Any] | None = None
) -> Dict[str, Any]:
    """
    Returnerar: {
      "status": "SUCCESS",
      "changes": [{"path": "<rel>", "content": "<utf8>"} , ...],
      "path": "<primär-fil>",
      "content": "<innehåll>",
      "diff_summary": {...}  # valfri
    }
    """
    logger.info("Integrationsstart: file_key=%s node_id=%s", file_key, node_id)

    # 1) Figma → IR
    figma_json = _fetch_figma_node(file_key, node_id)
    ir = figma_to_ir(figma_json, node_id)
    logger.info("IR byggd.")

    # 1.5) Ikon-detektion + export
    icon_nodes = collect_icon_nodes(ir["root"])
    svg_by_id = _fetch_svgs(file_key, [x["id"] for x in icon_nodes])
    icon_assets: List[Dict[str, Any]] = []
    logger.info("Ikoner: %d.", len(icon_nodes))

    # 2) Klona repo
    tmp_dir, repo = clone_repo()
    tmp_root = Path(tmp_dir)
    logger.info("Repo klonat till %s", tmp_root)

    # 2.1) Skriv SVG-ikoner
    for ic in icon_nodes:
        nid = ic["id"]
        svg = svg_by_id.get(nid)
        if not svg:
            continue
        fname = _icon_filename(ic["name_slug"], nid)
        disk_rel = f"{ICON_DIR}/{fname}".replace("\\", "/")
        abs_path = _safe_join(tmp_root, disk_rel)
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(svg, encoding="utf-8")

        vite_spec = disk_rel
        parts = vite_spec.split("/src/", 1)
        if len(parts) == 2:
            vite_spec = "/src/" + parts[1]

        icon_assets.append({
            "id": nid,
            "name": ic.get("name") or ic["name_slug"],
            "import_path": vite_spec,
            "fs_path": disk_rel,
            "w": ic["bounds"]["w"],
            "h": ic["bounds"]["h"],
        })

    # 2.2) TS-typer för SVG
    created_svg_types_rel = _ensure_svg_types(tmp_root)

    # 3) Beroenden
    _ensure_node_modules(tmp_root)

    # 4) Komponentöversikt
    components = list_components(str(tmp_root))
    logger.info("Hittade %d komponent(er).", len(components))

    # 5) OpenAI: strikt JSON enligt schema
    schema = build_codegen_schema(TARGET_COMPONENT_DIR, ALLOW_PATCH)
    client = OpenAI(api_key=OPENAI_API_KEY)

    messages = _build_messages(ir, components, placement, icon_assets)
    logger.info("Skickar prompt till OpenAI (%s) …", OPENAI_MODEL)
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=messages,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "Codegen", "schema": schema, "strict": True},
        },
        temperature=0,
        top_p=1,
    )

    raw = resp.choices[0].message.content or "{}"
    try:
        out = json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"Modellen returnerade ogiltig JSON: {e}")

    # 6) Validera/normalisera modelsvaret
    mode = out.get("mode")
    if mode not in ("file", "patch"):
        raise HTTPException(500, f"Okänt mode: {mode}")
    for key in ("file_code", "unified_diff", "mount"):
        v = out.get(key)
        if isinstance(v, str) and _TRIPLE_BACKTICKS.search(v):
            raise HTTPException(500, f"Ogiltigt innehåll i '{key}': innehåller ```")

    mount = out.get("mount") or {}
    mount.setdefault("anchor", _ANCHOR_SINGLE)

    # import_name
    def _derive_import_name(source: str | None) -> str:
        base = (source or "GeneratedComponent")
        try:
            base = Path(base).name
        except Exception:
            pass
        base = base.split(".")[0]
        parts = re.split(r"[^A-Za-z0-9]+", base)
        name = "".join(p[:1].upper() + p[1:] for p in parts if p)
        if not name:
            name = "GeneratedComponent"
        if not re.match(r"[A-Za-z_]", name[0]):
            name = "_" + name
        return name

    if not mount.get("import_name"):
        cand = mount.get("import_path") or out.get("target_path") or "GeneratedComponent"
        mount["import_name"] = _derive_import_name(str(cand))

    # import_path
    imp_raw = (mount.get("import_path") or "").strip().replace("\\", "/")
    if not imp_raw:
        tmp_rel = (Path(TARGET_COMPONENT_DIR) / f"{mount['import_name']}.tsx").as_posix()
        imp_raw = Path(tmp_rel).with_suffix("").as_posix()
    if imp_raw.endswith((".tsx", ".ts", ".jsx", ".js")):
        imp_raw = imp_raw.rsplit(".", 1)[0]
    if imp_raw.startswith("/") or ".." in imp_raw:
        raise HTTPException(400, "import_path är ogiltig (absolut path eller '..').")
    if not imp_raw.startswith("."):
        imp_raw = "./" + imp_raw
    mount["import_path"] = imp_raw

    if not mount.get("jsx"):
        mount["jsx"] = f"<{mount['import_name']} />"

    out["mount"] = mount

    target_rel = cast(str, out.get("target_path") or "")
    if not mode or not target_rel:
        raise HTTPException(500, "Saknar 'mode' eller 'target_path' i modelsvaret.")

    # 7) Git branch
    branch = unique_branch(node_id)
    repo.git.checkout("-b", branch)

    # 8) Tillämpa ändring + hård validering (1:1)
    returned_primary_path: str
    target_path: Path | None = None

    if mode == "file":
        # normalisera placering
        name = Path(target_rel).name or f"{mount['import_name']}.tsx"
        target_rel = (Path(TARGET_COMPONENT_DIR) / name).as_posix()

        target_path = _safe_join(tmp_root, target_rel)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        file_code = out.get("file_code")
        if not isinstance(file_code, str) or not file_code.strip():
            raise HTTPException(500, "file_code saknas för mode='file'.")

        # Sanera före validering: ta bort <title>/<desc> och oönskad fri text
        file_code = _strip_svg_meta(str(file_code))
        file_code = _purge_unexpected_text_nodes(str(file_code), _required_texts(ir))

        # Hård validering
        _assert_icons_used(str(file_code), icon_assets)
        _assert_text_coverage(ir, str(file_code))
        _assert_no_extra_texts(ir, str(file_code))
        _assert_dims_positions(ir, str(file_code))
        _assert_colors_shadows_and_gradients(ir, str(file_code))
        _assert_typography(ir, str(file_code))

        # Skriv
        target_path.write_text(_sanitize_tailwind_conflicts(file_code), encoding="utf-8")
        returned_primary_path = target_rel

    elif mode == "patch":
        norm = target_rel.replace("\\", "/")

        if norm.endswith("main.tsx"):
            raise HTTPException(400, "Patch av main.tsx är förbjudet. Använd mode='file' med 'file_code'.")

        if norm not in ALLOW_PATCH:
            raise HTTPException(400, f"Patch ej tillåten för {norm}. Tillåtna: {ALLOW_PATCH}")

        unified_diff = out.get("unified_diff")
        if not unified_diff or not isinstance(unified_diff, str):
            raise HTTPException(500, "unified_diff saknas för mode='patch'.")
        _git_apply(tmp_root, unified_diff)
        returned_primary_path = norm

        if returned_primary_path.endswith((".tsx", ".jsx", ".js", ".ts")):
            patched_path = _safe_join(tmp_root, returned_primary_path)
            if patched_path.exists():
                code_now = patched_path.read_text(encoding="utf-8")
                # Sanera före validering
                code_now = _strip_svg_meta(code_now)
                code_now = _purge_unexpected_text_nodes(code_now, _required_texts(ir))
                _assert_icons_used(code_now, icon_assets)
                _assert_text_coverage(ir, code_now)
                _assert_no_extra_texts(ir, code_now)
                _assert_dims_positions(ir, code_now)
                _assert_colors_shadows_and_gradients(ir, code_now)
                _assert_typography(ir, code_now)
    else:
        raise HTTPException(500, f"Okänt mode: {mode}")

    # 8.5) Korrigera import_path relativt main.tsx
    main_candidates = [p for p in ALLOW_PATCH if p.endswith("main.tsx")]
    main_rel = main_candidates[0] if main_candidates else "frontendplay/src/main.tsx"
    main_abs = _safe_join(tmp_root, main_rel)

    logger.info("Mount before norm: %s", dict(mount))
    try:
        if mode == "file" and target_path is not None:
            mount["import_path"] = _rel_import_from_main(main_abs, target_path)
        elif mode == "patch":
            maybe_target = str(mount.get("import_path", "")).strip()
            if maybe_target:
                guess_name = Path(maybe_target).name
                if guess_name.endswith((".tsx", ".ts", ".jsx", ".js")):
                    guess_name = guess_name.rsplit(".", 1)[0]
                comp_guess_rel = (Path(TARGET_COMPONENT_DIR) / f"{guess_name}.tsx").as_posix()
                comp_guess_abs = _safe_join(tmp_root, comp_guess_rel)
                if comp_guess_abs.exists():
                    mount["import_path"] = _rel_import_from_main(main_abs, comp_guess_abs)
                else:
                    mount["import_path"] = str(mount["import_path"])
            else:
                mount["import_path"] = str(mount.get("import_path"))
    except Exception as e:
        logger.warning("Kunde inte normalisera import_path: %s", e)

    imp = str(mount.get("import_path") or "").strip().replace("\\", "/")
    bad_specs = {"main", "./main", "frontendplay/src/main", "./frontendplay/src/main"}
    if imp in bad_specs or imp.endswith("/main"):
        if mode == "file" and target_path is not None:
            mount["import_path"] = _rel_import_from_main(main_abs, target_path)
        else:
            safe_rel = (Path(TARGET_COMPONENT_DIR) / f"{mount['import_name']}.tsx").as_posix()
            safe_abs = _safe_join(tmp_root, safe_rel)
            safe_abs.parent.mkdir(parents=True, exist_ok=True)
            if not safe_abs.exists():
                safe_abs.write_text(f"export default function {mount['import_name']}(){{return null;}}\n", encoding="utf-8")
            mount["import_path"] = _rel_import_from_main(main_abs, safe_abs)
            if 'returned_primary_path' in locals() and returned_primary_path == main_rel:
                returned_primary_path = safe_rel

    logger.info("Mount after  norm: %s (main_rel=%s)", dict(mount), main_rel)

    # 9) AST-injektion
    if not mount.get("jsx"):
        mount["jsx"] = f"<{mount['import_name']} />"
    _ast_inject_mount(tmp_root, mount)

    # 10) Typecheck + lint
    _typecheck_and_lint(tmp_root)

    # 11) (Valfritt) visuell validering
    diff_summary = None
    try:
        vis = _visual_validate(tmp_root)
        if vis:
            diff_summary = vis
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Visuell validering kastade oväntat undantag: %s", e)

    # 12) Git add + commit
    repo.git.add("--all")
    commit_msg = f"feat(ai): add {returned_primary_path}" if mode == "file" else f"chore(ai): patch {returned_primary_path}"
    repo.index.commit(commit_msg)
    logger.info("Commit klar: %s", commit_msg)

    # 13) Läs ut ALLA relevanta filer
    changed_paths: List[str] = []
    changed_paths.append(returned_primary_path)
    if main_abs.exists():
        changed_paths.append(main_rel)

    assets = out.get("assets") or []
    for a in assets if isinstance(assets, list) else []:
        rel = str(a.get("path", "")).replace("\\", "/")
        if rel:
            changed_paths.append(rel)

    for ia in icon_assets:
        changed_paths.append(ia.get("fs_path") or ia["import_path"])

    if created_svg_types_rel:
        changed_paths.append(created_svg_types_rel)

    uniq_paths: List[str] = []
    seen = set()
    for p in changed_paths:
        if p not in seen:
            uniq_paths.append(p)
            seen.add(p)

    final_changes: List[Dict[str, str]] = []
    for rel in uniq_paths:
        try:
            final_changes.append(_read_rel(tmp_root, rel))
        except HTTPException:
            logger.warning("Kunde inte läsa ut '%s' – hoppar över i changes.", rel)

    if not final_changes:
        final_changes.append(_read_rel(tmp_root, returned_primary_path))

    primary = next((c for c in final_changes if c["path"] == returned_primary_path), final_changes[0])

    logger.info("Returning %d change(s): %s", len(final_changes), [c["path"] for c in final_changes])
    result: Dict[str, Any] = {
        "status": "SUCCESS",
        "changes": final_changes,
        "path": primary["path"],
        "content": primary["content"],
    }
    if diff_summary:
        result["diff_summary"] = diff_summary
    return result


# Registrera ev. analyze-tasks
try:
    from . import analyze as _register_analyze  # noqa: F401
except Exception as e:  # pragma: no cover
    logging.getLogger(__name__).warning("Kunde inte importera analyze-tasks: %s", e)

__all__ = ["app", "celery_app", "integrate_figma_node"]
