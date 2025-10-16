# backend/codegen.py
from __future__ import annotations
"""
Celery-worker: Figma-node → IR → LLM-förslag → (AST-mount + file) → validering → commit → returnera ändringar

Uppdateringar:
- ENDAST IR-fält används för bakgrund: läs n.bg, aldrig n.fills för bakgrund.
- Validatorn kräver bg-* endast om n.bg finns. Skipper layout-only wrappers.
- Slash-opacity bg-[#hex]/NN stöds i både purge och validering.
- Spärr för palettklasser: alla bg- som inte är bg-[…] blockeras.
- Pre-purge: oönskade bg-* som inte finns i IR strippas innan validering.
- Gradients valideras enbart mot IR (n.bg.css), inte mot Figma-fills.

Övrigt (oförändrat från tidigare variant):
- Endast synlig text (visible_effective=True) byggs till textkrav.
- Tailwind-hints (tw_map) skickas till modellen.
- Tolerant men informativ validering för mått/position.
- Ikonexporten filtrerar bort containers och SVG:er som innehåller <text>/<tspan> eller orimliga mått/aspekt.
- Dims/pos-validering körs mot klippkedja och respekterar effektiv synlighet.
- Validering kräver font-family-klass i JSX enligt Figma (arbitrary value), inkl. korrekt escaping.
- Ikonprompten kräver import av varje ikon och exakt en <img> per ikon, utan absoluta left/top.
- Ikonvalideringen accepterar både absoluta (/src/...) och relativa imports, validerar storlek och exakt en användning, men ignorerar position.
- Sanering tar bort felaktiga left-/top-/absolute-klasser på <img> så ikoner inte hamnar utanför vyn.
- AUTO-FIX: Saknade ikon-importer och <img>-taggar injiceras automatiskt i file_code innan validering.
- Dims/pos-validering hoppar över ikon-subträd (leafs i exporterad ikon kontrolleras inte separat).
- Färgvalidering hoppar över ikon-subträd och är case-/format-tålig (hex och rgba).
- Prettier kör endast lokal bin om den finns, annars lätt fallback-formattering (ingen npx).
- AST-injektion använder endast lokala metoder (node + tsx eller lokal .bin/tsx), ingen npx.
- Figma SVG-hämtning parallelliseras med kortare timeouts.
- GPT-5: hoppa direkt till strikt=False schema, därefter json_object.
- Systemprompten ber modellen att lämna mount.import_path tomt.
- AUTO-FIX: injicera font-['Open_Sans'] på första JSX-wrappern när IR har exakt en fontfamilj.
- Kompaktar ALLA Tailwind arbitrary values (bg-[rgba(0,0,0,0.2)] etc.) så blanks aldrig bryter klasser.
- Förbjuder bakgrunder som inte finns i IR. Stoppar spök-`bg-[#000]` på wrapper-noder.
- Tillåter semitransparent färg via rgba, #rrggbbaa eller slash-opacity.
- Skipper dims/pos-krav för layout-only wrappers (ingen fill/stroke/effects/text).
- Hindrar oönskat `justify-between` om IR inte kräver det.
- Monterar med root-offset-wrapper så komponenten inte “krokar” i appens kant.

GPT-5-kompatibilitet:
- Skicka aldrig 'temperature' till GPT-5-modeller. De accepterar endast default. Robust fallback-kedja:
  gpt-5 → json_schema strict=False → json_object
  övriga → strict=True → strict=False → json_object
"""

import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple, cast

import functools
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from celery import Celery
from dotenv import load_dotenv
from fastapi import HTTPException

from . import figma_ir as FIR
from .det_codegen import generate_tsx_component
from .utils import clone_repo, list_components, unique_branch

# ─────────────────────────────────────────────────────────
# Miljö & konfiguration
# ─────────────────────────────────────────────────────────

load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=True)

BROKER_URL = (os.getenv("CELERY_BROKER_URL") or "redis://redis:6379/0").strip()
RESULT_BACKEND = (os.getenv("CELERY_RESULT_BACKEND") or BROKER_URL).strip()

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

ICON_MIN = int(os.getenv("ICON_MIN", "12"))
ICON_MAX = int(os.getenv("ICON_MAX", "256"))
ICON_AR_MIN = float(os.getenv("ICON_AR_MIN", "0.75"))
ICON_AR_MAX = float(os.getenv("ICON_AR_MAX", "1.33"))

# Respektera IGNORE_ROOT_FILL även i bg-logiken (bakåtkompat)
IGNORE_ROOT_FILL = os.getenv("IGNORE_ROOT_FILL", "0").lower() in ("1", "true", "yes")

FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
if not FIGMA_TOKEN:
    raise RuntimeError("FIGMA_TOKEN saknas i miljön (.env).")

ENABLE_VISUAL_VALIDATE = (
    os.getenv("ENABLE_VISUAL_VALIDATE", "false").lower() in ("1", "true", "yes")
)

CODEGEN_TIMING = os.getenv("CODEGEN_TIMING", "0").lower() in ("1", "true", "yes")

# Endast önskade loggar
LOG_FIGMA_JSON = os.getenv("LOG_FIGMA_JSON", "0").lower() in ("1", "true", "yes")
LOG_FIGMA_IR = os.getenv("LOG_FIGMA_IR", "0").lower() in ("1", "true", "yes")

# NYTT: IR/Prompt jämförelseloggar
LOG_IR_FULL = os.getenv("LOG_IR_FULL", "0").lower() in ("1", "true", "yes")
LOG_IR_COMPARE = os.getenv("LOG_IR_COMPARE", "0").lower() in ("1", "true", "yes")
IR_COMPARE_LIMIT = int(os.getenv("IR_COMPARE_LIMIT", "200") or "200")

# NYTT: BG-debug
LOG_BG_DEBUG = os.getenv("LOG_BG_DEBUG", "0").lower() in ("1", "true", "yes")

# ─────────────────────────────────────────────────────────
# Celery-app
# ─────────────────────────────────────────────────────────

app = Celery("codegen", broker=BROKER_URL, backend=RESULT_BACKEND)
app.conf.broker_connection_retry_on_startup = True
app.conf.broker_connection_timeout = 3
app.conf.redis_socket_timeout = 3
celery_app: Celery = app

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


def _safe_print(tag: str, payload: Any) -> None:
    # Begränsad och säker print
    try:
        print(f"[{tag}]", json.dumps(payload, ensure_ascii=False, default=str), flush=True)
    except Exception:
        try:
            print(f"[{tag}]", str(payload), flush=True)
        except Exception:
            pass


def _dbg_bg(event: str, payload: dict) -> None:
    if LOG_BG_DEBUG:
        _safe_print(f"bg.{event}", payload)


def _fetch_figma_node(file_key: str, node_id: str) -> Dict[str, Any]:
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

    # Endast önskad logg: Figma JSON för efterfrågad nod
    if LOG_FIGMA_JSON:
        try:
            node_doc = ((data or {}).get("nodes", {}).get(node_id, {}) or {}).get("document") or {}
            _safe_print("figma.json", {"node_id": node_id, "document": node_doc})
            _dump_json_file("figma-doc", node_id, node_doc)
        except Exception:
            pass

    return cast(Dict[str, Any], data)


def _safe_join(repo_root: Path, rel: str) -> Path:
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
    candidates: List[Path] = []
    root_pkg = repo_root / "package.json"
    fp_pkg = repo_root / "frontendplay" / "package.json"

    if root_pkg.exists():
        candidates.append(repo_root)
    if fp_pkg.exists():
        candidates.append(fp_pkg.parent)

    if not candidates:
        return

    for workdir in candidates:
        nm = workdir / "node_modules"
        if nm.exists():
            continue
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
# Kodformatering (Prettier)
# ─────────────────────────────────────────────────────────

def _find_project_base(repo_root: Path, hint: Path | None = None) -> Path:
    """
    Hitta närmaste katalog som har package.json. Faller tillbaka till
    repo_root/frontendplay eller repo_root.
    """
    base = hint or repo_root
    while base != base.parent and not (base / "package.json").exists():
        base = base.parent
    if (base / "package.json").exists():
        return base
    fp_pkg = repo_root / "frontendplay" / "package.json"
    return fp_pkg.parent if fp_pkg.exists() else repo_root

def _prettier_bin(base: Path) -> List[str] | None:
    """
    Returnera kommando för lokal prettier om den finns, annars None.
    """
    unix_bin = base / "node_modules" / ".bin" / "prettier"
    win_bin = base / "node_modules" / ".bin" / "prettier.cmd"
    if unix_bin.exists():
        return [str(unix_bin)]
    if win_bin.exists():
        return [str(win_bin)]
    return None

def _format_tsx(repo_root: Path, target_path: Path) -> None:
    """
    Kör Prettier på target_path om lokal bin finns. Misslyckas inte pipeline om Prettier saknas
    eller returnerar fel. Fallback: radbryter mellan taggar.
    """
    base = _find_project_base(repo_root, hint=target_path.parent)
    cmd = _prettier_bin(base)
    if cmd is not None:
        try:
            rc, out, err = _run([*cmd, "--parser", "babel-ts", "--write", str(target_path)], cwd=base)
            if rc == 0:
                return
        except Exception:
            pass
    # Fallback-formattering: bryt mellan '><' för bättre diffbarhet
    try:
        code = target_path.read_text(encoding="utf-8")
        code2 = re.sub(r'><', '>\n<', code)
        if code2 != code:
            target_path.write_text(code2, encoding="utf-8")
    except Exception:
        pass

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

def _next_clip_ir(n: Dict[str, Any], clip: Dict[str, float] | None) -> Dict[str, float] | None:
    return _rect_intersect(clip, n.get("bounds")) if n.get("clips_content") else clip

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

    def _fetch_one(session: requests.Session, nid: str, presigned_url: str) -> Tuple[str, str]:
        resp = session.get(presigned_url, timeout=5)
        resp.raise_for_status()
        return nid, resp.text

    with requests.Session() as s, ThreadPoolExecutor(max_workers=8) as ex:
        futs = []
        for nid, presigned in images.items():
            if presigned:
                futs.append(ex.submit(functools.partial(_fetch_one, s, str(nid), presigned)))
        for f in as_completed(futs):
            try:
                nid, svg_text = f.result()
                if svg_text:
                    out[nid] = svg_text
            except Exception:
                # Ignorera enskilda fel
                pass

    return out

# ─────────────────────────────────────────────────────────
# Text-extraktion ur IR (ENBART visible_effective)
# ─────────────────────────────────────────────────────────

_WS = re.compile(r"\s+")
def _canon_text(s: str | None) -> str:
    if not isinstance(s, str):
        return ""
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    return _WS.sub(" ", s).strip()

def _norm_key(s: str) -> str:
    if not isinstance(s, str):
        return ""
    s = s.replace("\u2026", "...")
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    s = _WS.sub(" ", s).strip()
    return s.casefold()

_LINE_SPLIT = re.compile(r"(?:\r?\n|[\u2022\u00B7•]+)\s*")
def _canon_text_lines(s: str | None) -> list[str]:
    if not isinstance(s, str):
        return []
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    parts = [_WS.sub(" ", p).strip() for p in _LINE_SPLIT.split(s)]
    return [p for p in parts if p]

def _effectively_visible_ir(n: Dict[str, Any], clip: Dict[str, float] | None) -> bool:
    if isinstance(n.get("visible_effective"), bool):
        return bool(n["visible_effective"])
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

# === A) Textinsamling enligt krav ========================

def _collect_visible_texts(n: Dict[str, Any], out: List[str]) -> None:
    if n.get("type") == "TEXT" and bool(n.get("visible_effective", True)):
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
        _collect_visible_texts(ch, out)

def _required_texts(ir: Dict[str, Any]) -> List[str]:
    acc: List[str] = []
    _collect_visible_texts(ir["root"], acc)
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
# SVG-säkerhet / ikonfiltrering
# ─────────────────────────────────────────────────────────

_SVG_HAS_TEXT_RE = re.compile(r"<\s*(?:text|tspan|textPath)\b", re.IGNORECASE)
_SVG_FONT_RE = re.compile(r"\bfont-(?:family|size|weight)\s*:", re.IGNORECASE)

def _svg_has_text(svg: str) -> bool:
    if not isinstance(svg, str):
        return False
    if _SVG_HAS_TEXT_RE.search(svg):
        return True
    if _SVG_FONT_RE.search(svg):
        return True
    return False

def _aspect_ok(w: float, h: float) -> bool:
    if w <= 0 or h <= 0:
        return False
    r = float(w) / float(h)
    return ICON_AR_MIN <= r <= ICON_AR_MAX

def _icon_size_ok(w: float, h: float) -> bool:
    iw, ih = int(round(w or 0)), int(round(h or 0))
    return (ICON_MIN <= iw <= ICON_MAX) and (ICON_MIN <= ih <= ICON_MAX) and _aspect_ok(iw, ih)

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

# Hjälpfunktion som tidigare låg inline i tasken
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

_MARKER_BEGIN = r"\{\s*/\*\s*AI-INJECT-MOUNT:BEGIN\s*\*/\s*\}"
_MARKER_END   = r"\{\s*/\*\s*AI-INJECT-MOUNT:END\s*\*/\s*\}"

def _normalize_mount_markers(src: str) -> str:
    src2 = re.sub(rf"(?:{_MARKER_BEGIN}\s*){{2,}}", "{/* AI-INJECT-MOUNT:BEGIN */}", src)
    src2 = re.sub(rf"(?:{_MARKER_END}\s*){{2,}}",   "{/* AI-INJECT-MOUNT:END */}",   src2)
    return src2

def _ensure_anchor_in_main(main_tsx: Path) -> None:
    src = main_tsx.read_text(encoding="utf-8")
    if _has_pair_markers(src):
        ns = _normalize_mount_markers(src)
        if ns != src:
            main_tsx.write_text(ns, encoding="utf-8")
        return

    if _ANCHOR_SINGLE in src:
        new_src = _replace_single_with_pair(src)
        new_src = _normalize_mount_markers(new_src)
        main_tsx.write_text(new_src, encoding="utf-8")
        return

    m = re.search(r"</React\.StrictMode>", src)
    if m:
        insert = "    " + _ANCHOR_JSX_BEGIN + "\n" + "    " + _ANCHOR_JSX_END + "\n"
        src = src[:m.start()] + insert + src[m.start():]
        src = _normalize_mount_markers(src)
        main_tsx.write_text(src, encoding="utf-8")
        return

    m = re.search(r"render\(\s*(<App\s*/>)\s*\)", src)
    if m:
        inner = m.group(1)
        frag = f"<>{inner} {_ANCHOR_JSX_BEGIN} {_ANCHOR_JSX_END}</>"
        src = src[:m.start()] + "render(" + frag + ")" + src[m.end():]
        src = _normalize_mount_markers(src)
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
    src = _normalize_mount_markers(src)
    main_tsx.write_text(src, encoding="utf-8")

def _ast_inject_mount(repo_root: Path, mount: dict) -> None:
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

        # Först: Node med tsx ESM-import
        cmd1 = [
            "node", "--import", "tsx",
            str(script_path), str(main_tsx), str(import_name), str(import_path), str(jsx_file_path),
        ]
        rc, out, err = _run(cmd1, cwd=base)
        if rc == 0:
            s = main_tsx.read_text(encoding="utf-8")
            ns = _normalize_mount_markers(s)
            if ns != s:
                main_tsx.write_text(ns, encoding="utf-8")
            return

        # Andra: Node med --loader tsx
        cmd1b = [
            "node", "--loader", "tsx",
            str(script_path), str(main_tsx), str(import_name), str(import_path), str(jsx_file_path),
        ]
        rc1b, out1b, err1b = _run(cmd1b, cwd=base)
        if rc1b == 0:
            s = main_tsx.read_text(encoding="utf-8")
            ns = _normalize_mount_markers(s)
            if ns != s:
                main_tsx.write_text(ns, encoding="utf-8")
            return

        # Tredje: Lokal .bin/tsx om den finns (ingen npx)
        local_tsx = base / "node_modules" / ".bin" / ("tsx.cmd" if os.name == "nt" else "tsx")
        if local_tsx.exists():
            cmd2 = [str(local_tsx), str(script_path), str(main_tsx), str(import_name), str(import_path), str(jsx_file_path)]
            rc2, out2, err2 = _run(cmd2, cwd=base)
            if rc2 == 0:
                s = main_tsx.read_text(encoding="utf-8")
                ns = _normalize_mount_markers(s)
                if ns != s:
                    main_tsx.write_text(ns, encoding="utf-8")
                return
            else:
                raise HTTPException(
                    500,
                    "AST-injektion misslyckades:\n"
                    f"{' '.join(cmd1)}\n{err or out}\n\n"
                    f"{' '.join(cmd1b)}\n{err1b or out1b}\n\n"
                    f"{' '.join(cmd2)}\n{err2 or out2}"
                )
        else:
            raise HTTPException(
                500,
                "AST-injektion misslyckades och lokal tsx saknas:\n"
                f"{' '.join(cmd1)}\n{err or out}\n\n"
                f"{' '.join(cmd1b)}\n{err1b or out1b}\n"
                "Installera 'tsx' i devDependencies eller lägg till script."
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
    if _has_script(base, "lint:fix"):
        rc, out, err = _run_pm_script(base, "lint:fix")
        if rc != 0:
            pass

def _visual_validate(repo_root: Path) -> Dict[str, Any] | None:
    if not ENABLE_VISUAL_VALIDATE:
        return None

    base = repo_root
    if not (base / "package.json").exists() and (repo_root / "frontendplay" / "package.json").exists():
        base = repo_root / "frontendplay"

    if not _has_script(base, "test:visual"):
        return None

    rc, out, err = _run_pm_script(base, "test:visual", ["--reporter=line"])
    if rc != 0:
        raise HTTPException(500, f"Visuell validering misslyckades:\n{err or out}")
    return {"status": "ok"}

# ─────────────────────────────────────────────────────────
# Modellsvaret: validering och normalisering
# ─────────────────────────────────────────────────────────

_TRIPLE_BACKTICKS = re.compile(r"```")
_CLS_RE = re.compile(r'className\s*=\s*(?P<q>"|\')(?P<val>.*?)(?P=q)', re.DOTALL)

_TEXT_NODE_ANY = re.compile(
    r">\s*(?:\{\s*(?:`([^`]+)`|\"([^\"]+)\"|'([^']+)')\s*\}|([^<>{}][^<>{}]*))\s*<",
    re.DOTALL,
)
_TEXT_NODE_ANY_BETWEEN = _TEXT_NODE_ANY

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
    if x is None:
        return default
    if x in (0, "0", "false", "False"):
        return False
    if x in (1, "1", "true", "True"):
        return True
    return default

def _sanitize_tailwind_conflicts(src: str) -> str:
    def fix(m: re.Match) -> str:
        q = m.group("q")
        cls = m.group("val")

        if re.search(r'\bborder-\[[0-9.]+px\]', cls):
            cls = re.sub(r'(?<!-)\bborder\b', '', cls)

        if re.search(r'\babsolute\b', cls):
            cls = re.sub(r'\brelative\b', '', cls)

        cls = re.sub(r'(^|\s)-\[[^\]]+\]', ' ', cls)
        cls = re.sub(r'\s+', ' ', cls).strip()
        return f'className={q}{cls}{q}'

    return _CLS_RE.sub(fix, src)

# Kompaktar alla Tailwind arbitrary values: bg-[rgba(0,0,0,0.2)] etc.
_ARB_WITH_PREFIX = re.compile(r'(?P<prefix>\b[a-zA-Z-]+)-\[(?P<inner>[^\]]+)\](?P<suf>/[0-9]{1,3})?')
def _compact_arbitrary_values(src: str) -> str:
    def repl(m: re.Match) -> str:
        prefix = m.group('prefix')
        inner  = m.group('inner')
        suf    = m.group('suf') or ''
        if prefix == 'font':
            # behåll blanks i font-namn
            cleaned = inner.replace('% ', '%')
            return f'{prefix}-[{cleaned}]{suf}'
        # komprimera för övriga arbitrary-klasser
        inner2 = re.sub(r'\s+', '', inner).replace('% ', '%')
        return f'{prefix}-[{inner2}]{suf}'
    return _ARB_WITH_PREFIX.sub(repl, src)


# === AUTO-FIX: font-family injektion på första wrappern ===

def _fonts_in_ir(ir: Dict[str, Any]) -> set[str]:
    fams: set[str] = set()
    def rec(n: Dict[str, Any]):
        if n.get("type") == "TEXT":
            st = (n.get("text") or {}).get("style") or {}
            fam = st.get("fontFamily")
            if isinstance(fam, str) and fam.strip():
                fams.add(fam.strip())
        for c in n.get("children") or []:
            rec(c)
    rec(ir["root"])
    return fams

def _autofix_font_family(ir: Dict[str, Any], file_code: str) -> str:
    fams = _fonts_in_ir(ir)
    # Only auto-fix when exactly one font-family exists in the IR
    if not fams or len(fams) != 1:
        return file_code
    fam = next(iter(fams))
    # behåll blanks så fonten matchar den laddade webfonten
    fam_space = fam.replace("\\","\\\\").replace("'","\\'")
    def repl(m: re.Match) -> str:
        q = m.group("q"); val = m.group("val") or ""
        if "font-[" in val:
            return m.group(0)
        inner_q = '"' if q == "'" else "'"
        new_val = (val + " " + f"font-[{inner_q}{fam_space}{inner_q}]").strip()
        return f'className={q}{new_val}{q}'
    return _CLS_RE.sub(repl, file_code, count=1)



# Endast för <img>: ta bort left-/top-/absolute så ikoner inte placeras utanför vyn
_IMG_WITH_CLASS = re.compile(
    r'(<img\b[^>]*\bclassName\s*=\s*)(?P<q>"|\')(?P<cls>.*?)(?P=q)(?P<tail>[^>]*>)',
    re.IGNORECASE | re.DOTALL,
)

def _sanitize_img_positions(src: str) -> str:
    def repl(m: re.Match) -> str:
        q = m.group("q")
        cls = m.group("cls") or ""
        cls = re.sub(r'\bleft-\[[^\]]+\]', '', cls)
        cls = re.sub(r'\btop-\[[^\]]+\]', '', cls)
        cls = re.sub(r'\babsolute\b', '', cls)
        cls = re.sub(r'\brelative\b', '', cls)
        cls = re.sub(r'\s+', ' ', cls).strip()
        return f"{m.group(1)}{q}{cls}{q}{m.group('tail')}"
    return _sanitize_tailwind_conflicts(_IMG_WITH_CLASS.sub(repl, src))

_SVG_META = re.compile(r"<\s*(title|desc)\b[^>]*>.*?<\s*/\s*\1\s*>", re.IGNORECASE | re.DOTALL)

def _strip_svg_meta(src: str) -> str:
    return _SVG_META.sub("", src)

_ATTR_PATTERNS = [
    r'placeholder\s*=\s*"([^"]+)"',
    r"placeholder\s*=\s*'([^']+)'",
    r'placeholder\s*=\s*\{\s*"([^"]+)"\s*\}',
    r"placeholder\s*=\s*\{\s*'([^']+)'\s*\}",
    r'aria-label\s*=\s*"([^"]+)"',
    r"aria-label\s*=\s*'([^']+)'",
    r'aria-label\s*=\s*\{\s*"([^"]+)"\s*\}',
    r"aria-label\s*=\s*\{\s*'([^']+)" r"'\s*\}",
    r'title\s*=\s*"([^"]+)"',
    r"title\s*=\s*'([^']+)'",
    r'title\s*=\s*\{\s*"([^"]+)"\s*\}',
    r"title\s*=\s*\{\s*'([^']+)'\s*\}",
    r'alt\s*=\s*"([^"]+)"',
    r"alt\s*=\s*'([^']+)'",
    r'alt\s*=\s*\{\s*"([^"]+)"\s*\}',
]

def _extract_attr_texts(src: str) -> List[str]:
    out: List[str] = []
    for pat in _ATTR_PATTERNS:
        for m in re.finditer(pat, src, flags=re.IGNORECASE | re.DOTALL):
            val = m.group(1)
            out.extend(_canon_text_lines(val))
    return [_canon_text(p).replace("\u2026", "...") for p in out if p]

def _purge_unexpected_text_nodes(src: str, allowed: List[str]) -> str:
    allowed_norm = {_norm_key(a) for a in allowed}
    def repl(m: re.Match) -> str:
        txt = ""
        for g in m.groups():
            if g is not None:
                txt = _canon_text(g).replace("\u2026","...")
                break
        if _norm_key(txt) in allowed_norm:
            return m.group(0)
        return "><"
    return _TEXT_NODE_ANY_BETWEEN.sub(repl, src)

def _extract_jsx_text(src: str) -> List[str]:
    parts: List[str] = []
    for m in _TEXT_NODE_ANY.finditer(src):
        for g in m.groups():
            if g is not None:
                parts.extend(_canon_text_lines(g))
                break
    return [_canon_text(p).replace("\u2026", "...") for p in parts if p]

def _assert_no_extra_texts(ir: Dict[str, Any], file_code: str) -> None:
    exp_raw = _required_texts(ir)
    exp = {_norm_key(t) for t in exp_raw}
    found_raw = _extract_jsx_text(file_code)
    extra = [t for t in found_raw if _norm_key(t) not in exp]
    if extra:
        raise HTTPException(500, "Extra texter i JSX: " + ", ".join(extra[:12]))

def _assert_text_coverage(ir: Dict[str, Any], file_code: str) -> None:
    exp_raw = _required_texts(ir)
    found_raw = _extract_jsx_text(file_code) + _extract_attr_texts(file_code)
    found = {_norm_key(t) for t in found_raw}
    missing = [t for t in exp_raw if _norm_key(t) not in found]
    if missing:
        raise HTTPException(500, "Saknade textnoder i genererad kod: " + ", ".join(missing[:15]))

def _gather_classes(file_code: str) -> str:
    return " ".join(m.group("val") for m in _CLS_RE.finditer(file_code))

# === C) Dimensions/positions-validering ==================

def _px_s(x: Any | None) -> str | None:
    if x is None: return None
    try:
        fx = float(x)
        return f"{int(round(fx))}px" if abs(fx - round(fx)) < 1e-6 else f"{round(fx,2)}px"
    except Exception:
        return None

def _is_layout_only(n: Dict[str, Any]) -> bool:
    """
    True om noden inte bidrar visuellt: ingen fill/stroke/effect/text och ingen clipping.
    Används för att undvika krav på w/h/pos som skapar “tomma block” i DOM.
    """
    if n.get("type") == "TEXT":
        return False
    if n.get("clips_content"):
        return False
    if (n.get("text") or {}).get("content") or (n.get("text") or {}).get("lines"):
        return False
    if any(_ for _ in (n.get("effects") or [])):
        return False
    fills = n.get("fills") or []  # används endast för att bedöma visuellt bidrag, ej färg
    def _has_visual_fill(f: Dict[str,Any]) -> bool:
        t = str(f.get("type") or "")
        if t == "SOLID":
            return bool(f.get("color")) and float(f.get("alpha",1) or 1) > 0.001
        if t.startswith("GRADIENT_"):
            return bool(f.get("stops"))
        if t == "IMAGE":
            return bool(f.get("imageRef"))
        return False
    has_visual_fill = any(_has_visual_fill(f) for f in fills)
    has_stroke = bool(n.get("strokes"))
    # Om ny IR tillhandahåller n.bg, behandla det som visuellt
    if not has_visual_fill and not has_stroke:
        if isinstance(n.get("bg"), dict):
            return False
    return not has_visual_fill and not has_stroke

def _assert_dims_positions(ir: Dict[str, Any], file_code: str, icon_asset_ids: set[str] | None = None) -> None:
    """
    Validerar att noder som faktiskt renderas i JSX har motsvarande Tailwind-klasser.
    Ikon-subträd som exporteras som en enda <img> hoppas över.
    Skipper även layout-only wrappers.
    """
    classes = _gather_classes(file_code)
    icon_asset_ids = set(icon_asset_ids or set())

    def _any(tokens: List[str]) -> bool:
        return any(tok in classes for tok in tokens if tok)

    def _need_w(px: Any | None) -> List[str]:
        s = _px_s(px)
        return [] if not s else [f"w-[{s}]", f"min-w-[{s}]", f"max-w-[{s}]", f"basis-[{s}]"]

    def _need_h(px: Any | None) -> List[str]:
        s = _px_s(px)
        return [] if not s else [f"h-[{s}]", f"min-h-[{s}]", f"max-h-[{s}]"]

    def _need_left(px: Any | None) -> List[str]:
        s = _px_s(px)
        return [] if not s else [f"left-[{s}]"]

    def _need_top(px: Any | None) -> List[str]:
        s = _px_s(px)
        return [] if not s else [f"top-[{s}]"]

    def rec(n: Dict[str,Any], clip: Dict[str, float] | None, skip: bool = False):
        # Hoppa över ikon-subträdet
        if skip or (n.get("id") in icon_asset_ids):
            next_clip = _next_clip_ir(n, clip)
            for ch in n.get("children") or []:
                rec(ch, next_clip, True)
            return

        if not bool(n.get("visible_effective", True)):
            return
        if not _effectively_visible_ir(n, clip):
            return

        # Layout-only wrapper → ingen dims/pos-tvingning
        if _is_layout_only(n):
            next_clip = _next_clip_ir(n, clip)
            for ch in n.get("children") or []:
                rec(ch, next_clip, False)
            return

        b = n.get("bounds") or {}
        nid = n.get("id"); nname = n.get("name"); ntype = n.get("type")

        w_tokens = _need_w(b.get("w"))
        # TEXT-noder får använda auto i stället för px-bredd
        if n.get("type") == "TEXT":
            w_tokens = w_tokens + ["w-auto"]
        if w_tokens and not _any(w_tokens):
            raise HTTPException(
                500,
                f"Saknar breddklass {w_tokens[0]} (alternativ: {', '.join(w_tokens)}) "
                f"för node id={nid} name={nname} type={ntype} bounds={b}"
            )
        h_tokens = _need_h(b.get("h"))
        # TEXT-noder får använda auto i stället för px-höjd
        if n.get("type") == "TEXT":
            h_tokens = h_tokens + ["h-auto"]
        if h_tokens and not _any(h_tokens):
            raise HTTPException(
                500,
                f"Saknar höjdklass {h_tokens[0]} (alternativ: {', '.join(h_tokens)}) "
                f"för node id={nid} name={nname} type={ntype} bounds={b}"
            )

        if n.get("abs"):
            l_tokens = _need_left(b.get("x"))
            if l_tokens and not _any(l_tokens):
                raise HTTPException(
                    500,
                    f"Saknar positionsklass {l_tokens[0]} för node id={nid} name={nname} type={ntype} bounds={b}"
                )
            t_tokens = _need_top(b.get("y"))
            if t_tokens and not _any(t_tokens):
                raise HTTPException(
                    500,
                    f"Saknar positionsklass {t_tokens[0]} för node id={nid} name={nname} type={ntype} bounds={b}"
                )

        next_clip = _next_clip_ir(n, clip)
        for ch in n.get("children") or []:
            rec(ch, next_clip)

    root = cast(Dict[str, Any], ir.get("root") or {})
    root_clip = cast(Dict[str, float] | None, (root.get("debug") or {}).get("rootClip") or root.get("bounds"))
    rec(root, root_clip, False)

# ─────────────────────────────────────────────────────────
# Färger, skuggor, gradients (BG via IR n.bg)
# ─────────────────────────────────────────────────────────

def _hex_to_rgba_str(hex_col: str, a: float) -> str:
    r = int(hex_col[1:3],16); g = int(hex_col[3:5],16); b = int(hex_col[5:7],16)
    return f"rgba({r}, {g}, {b}, {a})"

def _rgba_triplet_from_hex(c_hex: str) -> Tuple[int,int,int]:
    c = c_hex.lstrip("#")
    return int(c[0:2],16), int(c[2:4],16), int(c[4:6],16)

def _bg_obj(n: Dict[str, Any]) -> Dict[str, Any] | None:
    bg = n.get("bg")
    if isinstance(bg, dict):
        return bg
    return None

def _has_token(blob_tokens: set[str], tok: str) -> bool:
    return tok.lower() in blob_tokens

def _has_sub(blob_text: str, s: str) -> bool:
    return s.lower() in blob_text

def _assert_colors_shadows_and_gradients(
    ir: Dict[str, Any],
    file_code: str,
    icon_asset_ids: set[str] | None = None,
) -> None:
    """
    BG-validering:
    - Använd endast n.bg (SOLID/GRADIENT). Kräv bg-* endast när n.bg finns.
    - Skippa layout-only wrappers och ikon-subträd.
    - Root-bg ignoreras när IGNORE_ROOT_FILL=1 för bakåtkompat.
    Textfärg:
    - För TEXT använder vi text.style.color om den finns (hex eller rgba).
    Skuggor:
    - Samma som tidigare via n.css.boxShadow.
    """
    icon_asset_ids = set(icon_asset_ids or set())

    class_attrs = [m.group("val") or "" for m in _CLS_RE.finditer(file_code)]
    class_blob_text = " ".join(class_attrs).lower()
    class_blob_tokens: set[str] = set()
    for s in class_attrs:
        for t in s.split():
            tt = t.strip().lower()
            if tt:
                class_blob_tokens.add(tt)

    # debug: lista ett urval av klasser som valideras mot
    _dbg_bg("class-scan", {"sample_classes": list(class_blob_tokens)[:40]})

    def _has_alpha_variants_bg(col_hex: str, a: float) -> bool:
        r,g,b = _rgba_triplet_from_hex(col_hex)
        # rgba variant
        if _has_sub(class_blob_text, f"bg-[rgba({r},{g},{b},"):
            return True
        # hex8 variant
        aa = f"{int(round(a*255)):02x}"
        if _has_sub(class_blob_text, f"bg-[#" + col_hex.lower().lstrip("#") + aa + "]"):
            return True
        # slash opacity variant (tolerera valfritt /NN)
        if _has_sub(class_blob_text, f"bg-[#" + col_hex.lower().lstrip("#") + "]/"):
            return True
        return False

    def _assert_text_color(n: Dict[str, Any]) -> None:
        if n.get("type") != "TEXT":
            return
        st = (n.get("text") or {}).get("style") or {}
        col = st.get("color")
        if not isinstance(col, str) or not col.strip():
            return
        want = f"text-[{col}]".lower()
        if col.strip().startswith("#"):
            if not _has_token(class_blob_tokens, want):
                raise HTTPException(500, f"Saknar textfärgklass {want}")
        else:
            # rgba(...) prefixmatch
            if not _has_sub(class_blob_text, "text-[rgba("):
                raise HTTPException(500, "Saknar semitransparent textfärgklass text-[rgba(...)]")

    def rec(n: Dict[str,Any], clip: Dict[str, float] | None):
        if n.get("id") in icon_asset_ids:
            return
        if not _effectively_visible_ir(n, clip):
            return

        # debug: per-nod bg som kontrolleras
        if isinstance(n.get("bg"), dict):
            _dbg_bg("check", {
                "id": n.get("id"),
                "name": n.get("name"),
                "type": n.get("type"),
                "bg": n.get("bg"),
            })

        # TEXT-färg via text.style.color
        _assert_text_color(n)

        # Ignorera root-bg om flaggad
        if not (IGNORE_ROOT_FILL and n.get("is_root")):
            # BG via IR
            if not _is_layout_only(n):
                bg = _bg_obj(n)
                if bg:
                    t = str((bg.get("type") or "")).upper()
                    if t == "SOLID":
                        col = bg.get("color")
                        a = float(bg.get("alpha", 1) or 1)
                        if isinstance(col, str) and col.startswith("#") and len(col) >= 7:
                            if a >= 0.999:
                                want = f"bg-[{col.lower()}]"
                                if not _has_token(class_blob_tokens, want):
                                    nid = n.get("id"); nname = n.get("name"); ntype = n.get("type"); b = n.get("bounds")
                                    raise HTTPException(500, f"Saknar bakgrundsklass {want} för node id={nid} name={nname!r} type={ntype} bounds={b}")
                            else:
                                if not _has_alpha_variants_bg(col, a):
                                    nid = n.get("id"); nname = n.get("name"); ntype = n.get("type"); b = n.get("bounds")
                                    raise HTTPException(500, f"Saknar semitransparent bakgrundsklass (rgba, #rrggbbaa eller /opacity) för node id={nid} name={nname!r} type={ntype} bounds={b}")
                    elif t == "GRADIENT":
                        css = str(bg.get("css") or "")
                        # Kräv endast när IR säger gradient
                        if css.startswith("linear-gradient("):
                            if not _has_sub(class_blob_text, "bg-[linear-gradient("):
                                nid = n.get("id"); nname = n.get("name"); ntype = n.get("type"); b = n.get("bounds")
                                raise HTTPException(500, f"Saknar gradientklass bg-[linear-gradient(...)] för node id={nid} name={nname!r} type={ntype} bounds={b}")

        css = n.get("css") or {}
        if css.get("boxShadow"):
            want = f"shadow-[{css['boxShadow']}]".lower()
            if want not in class_blob_tokens and not _has_sub(class_blob_text, "shadow-["):
                raise HTTPException(500, f"Saknar skuggklass {want}")

        next_clip = _next_clip_ir(n, clip)
        for ch in n.get("children") or []:
            rec(ch, next_clip)

    rec(ir["root"], None)

# ─────────────────────────────────────────────────────────
# Bakgrunder: only-from-IR kontroll och purge
# ─────────────────────────────────────────────────────────

# Fångar bg-[ … ] med valfri frivillig slash-opacity efteråt, t.ex. bg-[#000]/20
_BG_TOKEN = re.compile(r'\bbg-\[(?P<inner>[^\]]+)\](?P<suffix>/[0-9]{1,3})?')

def _expected_bg_set(ir: Dict[str,Any]) -> set[str]:
    """
    Returnerar tillåtna BG-patterns från IR. Vi använder prefixmatch för
    rgba(…) och linear-gradient(…). För hex lägger vi både #hex och #hex/ (för slash-opacity).
    Root kan ignoreras via IGNORE_ROOT_FILL.
    """
    exp: set[str] = set()
    def rec(n: Dict[str,Any]):
        if not bool(n.get("visible_effective", True)):
            return
        bg = n.get("bg")
        if IGNORE_ROOT_FILL and n.get("is_root"):
            bg = None
        if not _is_layout_only(n) and isinstance(bg, dict):
            t = str(bg.get("type") or "").upper()
            if t == "SOLID":
                col = bg.get("color"); a = float(bg.get("alpha",1) or 1)
                if isinstance(col, str) and col.startswith("#") and len(col) >= 7:
                    hexlow = col.lower()
                    if a >= 0.999:
                        exp.add(hexlow)        # exakt match: bg-[#hex]
                    else:
                        # Tillåt tre sätt
                        r,g,b = _rgba_triplet_from_hex(hexlow)
                        exp.add(f"rgba({r},{g},{b},")  # prefix
                        exp.add(hexlow + "/")          # prefix för slash-opacity
                        aa = f"{int(round(a*255)):02x}"
                        exp.add(hexlow + aa)           # #rrggbbaa
            elif t == "GRADIENT":
                css = str(bg.get("css") or "")
                if css.startswith("linear-gradient("):
                    exp.add("linear-gradient(")  # prefix
        for ch in n.get("children") or []:
            rec(ch)
    rec(ir["root"])
    return exp

def _purge_unexpected_backgrounds(ir: Dict[str,Any], file_code: str) -> str:
    """
    Tar bort alla bg-* klasser som inte är i IR. Palettklasser tas alltid bort.
    Behåller endast bg-[…] som matchar förväntat set/prefix.
    """
    allowed = _expected_bg_set(ir)

    def keep_arbitrary(inner: str, suffix: str | None) -> bool:
        raw = (inner or "").strip().lower().replace(" ", "")
        suf = (suffix or "").strip().lower()
        # rgba prefix
        if raw.startswith("rgba("):
            return any(raw.startswith(a) for a in allowed if a.startswith("rgba("))
        # linear-gradient prefix
        if raw.startswith("linear-gradient("):
            return any(a == "linear-gradient(" for a in allowed)
        # hex or hex8 or slash opacity
        if raw.startswith("#"):
            # exact hex (no suffix)
            if suf == "":
                return raw in allowed
            # slash-opacity
            if suf.startswith("/"):
                return (raw + "/") in allowed
        # hex8 form: inner already contains #rrggbbaa
        if raw.startswith("#") and len(raw) in (9, 13):  # tolerate #rrggbbaa or #rrggbbaa..extras
            return any(raw.startswith(a) for a in allowed if a.startswith("#") and len(a) >= 9)
        return False

    def repl_class(m: re.Match) -> str:
        q = m.group("q")
        cls = m.group("val") or ""
        tokens = cls.split()
        kept: List[str] = []
        removed: List[str] = []
        for t in tokens:
            tl = t.strip()
            if not tl:
                continue
            if tl.startswith("bg-"):
                # Palettklass? dvs inte bg-[…] → släng
                if not tl.startswith("bg-["):
                    removed.append(tl); continue
                # bg-[…] ev /NN
                m2 = _BG_TOKEN.match(tl)
                if not m2:
                    removed.append(tl); continue
                inner = (m2.group("inner") or "").replace(" ", "")
                suffix = m2.group("suffix")
                if keep_arbitrary(inner, suffix):
                    kept.append(tl)
                else:
                    removed.append(tl); continue
            else:
                kept.append(tl)
        new_val = " ".join(kept)
        if removed:
            _dbg_bg("purge", {"removed": removed, "kept": kept})
        return f'className={q}{new_val}{q}'

    return _CLS_RE.sub(repl_class, file_code)

def _assert_only_expected_backgrounds(ir: Dict[str,Any], file_code: str) -> None:
    """
    Säkerställ:
    1) Inga palettklasser bg-* utan bg-[…].
    2) Alla bg-[…] finns i IR:s tillåtna uppsättning/prefix.
    3) Slash-opacity valideras (bg-[#hex]/NN).
    """
    allowed = _expected_bg_set(ir)
    _dbg_bg("allowed", {"allowed": sorted(list(allowed))[:60]})

    bad: list[str] = []
    class_attrs = [m.group("val") or "" for m in _CLS_RE.finditer(file_code)]

    # 1) Palettklasser
    for s in class_attrs:
        for tok in s.split():
            if tok.startswith("bg-") and not tok.startswith("bg-["):
                bad.append(tok)

    # 2) Arbitrary kontroller
    for s in class_attrs:
        for m in _BG_TOKEN.finditer(s):
            inner = (m.group("inner") or "").strip().lower().replace(" ", "")
            suffix = (m.group("suffix") or "").strip().lower()
            ok = False
            if inner.startswith("rgba("):
                ok = any(inner.startswith(a) for a in allowed if a.startswith("rgba("))
            elif inner.startswith("linear-gradient("):
                ok = any(a == "linear-gradient(" for a in allowed)
            elif inner.startswith("#"):
                if suffix == "":
                    ok = inner in allowed or any(inner.startswith(a) for a in allowed if len(a) >= 9 and a.startswith("#"))
                else:
                    ok = (inner + "/") in allowed
            if not ok:
                bad.append(f"bg-[{inner}]{suffix}")

    if bad:
        raise HTTPException(500, "Otillåtna bakgrunder i JSX: " + ", ".join(sorted(set(bad))[:20]))

# ─────────────────────────────────────────────────────────
# Typografi (inkl. krav på font-family)
# ─────────────────────────────────────────────────────────

def _assert_typography(ir: Dict[str, Any], file_code: str) -> None:
    classes = _gather_classes(file_code)

    def weight_ok(weight: int) -> List[str]:
        map_std = {
            100:"font-thin",200:"font-extralight",300:"font-light",400:"font-normal",
            500:"font-medium",600:"font-semibold",700:"font-bold",800:"font-extrabold",900:"font-black"
        }
        cand = [map_std.get(weight,""), f"font-[{weight}]", f"font-{weight}"]
        return [c for c in cand if c]

    def _escape_font_name(s: str) -> str:
        return s.replace("\\","\\\\").replace("'","\\'").replace("]","\\]")

    def _have_any(candidates: List[str]) -> bool:
        return any(c in classes for c in candidates if c)

    def rec(n: Dict[str,Any], clip: Dict[str, float] | None):
        if not _effectively_visible_ir(n, clip):
            return
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

            # FIX: tolerera nära-noll och acceptera tracking-normal
            ls = st.get("letterSpacing")
            if isinstance(ls, str) and ls.strip():
                m = re.match(r"^\s*([+-]?\d+(?:\.\d+)?)\s*px\s*$", ls)
                if m:
                    try:
                        ls_val = float(m.group(1))
                    except ValueError:
                        ls_val = None
                else:
                    ls_val = None

                if ls_val is not None and abs(ls_val) < 0.01:
                    pass
                else:
                    want_candidates = [f"tracking-[{ls}]", "tracking-normal"]
                    if not any(w in classes for w in want_candidates):
                        raise HTTPException(500, f"Saknar letter-spacing klass {want_candidates[0]}")

            fw = st.get("fontWeight")
            if isinstance(fw, int) and fw in range(100, 1000, 100):
                if not _have_any(weight_ok(fw)):
                    raise HTTPException(500, f"Saknar font-weight klass för {fw}")

            fam = st.get("fontFamily")
            if isinstance(fam, str) and fam.strip():
                fam_trim = fam.strip()
                fam_space = _escape_font_name(fam_trim)
                fam_us = _escape_font_name(fam_trim.replace(" ", "_"))
                want_candidates = [
                    f"font-['{fam_space}']",
                    f'font-["{fam_space}"]',
                    f"font-['{fam_us}']",
                    f'font-["{fam_us}"]',
                ]
                if not _have_any(want_candidates):
                    raise HTTPException(500, f"Saknar font-family klass för '{fam_trim}'")

        next_clip = _next_clip_ir(n, clip)
        for ch in n.get("children") or []:
            rec(ch, next_clip)

    rec(ir["root"], None)

# ─────────────────────────────────────────────────────────
# Ikon-utilities och validering
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

# Import- och <img>-regexar
_IMG_IMPORT = re.compile(r"import\s+(\w+)\s+from\s+['\"]([^'\"]+\.svg(?:\?url)?)['\"]")
_IMG_TAG = re.compile(r"<img\b[^>]*?>", re.IGNORECASE | re.DOTALL)
_SRC_VAR = re.compile(r"src=\{(\w+)\}", re.IGNORECASE | re.DOTALL)
_NUM_IN_ATTR = re.compile(
    r"(width|height)\s*=\s*(?:\{\s*([0-9]+)\s*\}|['\"]\s*([0-9]+)\s*['\"])",
    re.IGNORECASE | re.DOTALL,
)
_CLS_IN_TAG = re.compile(
    r'className\s*=\s*(?:"([^"]+)"|\'([^\']+)\')',
    re.IGNORECASE | re.DOTALL,
)

def _same_path(u: str, exp: str) -> bool:
    u0 = u.split("?")[0].replace("\\", "/")
    e0 = exp.split("?")[0].replace("\\", "/")
    tail = e0.split("/src/", 1)[-1]
    return u0.endswith(e0) or u0.endswith(tail) or u0.endswith("./" + tail) or u0.endswith("/" + tail)

def _import_var_from_path(p: str, used: set[str]) -> str:
    base = Path(p.split("?")[0]).stem
    parts = re.split(r"[^A-Za-z0-9]+", base)
    name = "".join(s[:1].upper() + s[1:] for s in parts if s)
    if not name:
        name = "Icon"
    if not re.match(r"[A-Za-z_]", name[0]):
        name = "_" + name
    orig = name
    i = 2
    while name in used:
        name = f"{orig}{i}"
        i += 1
    return name

def _autofix_missing_icons(file_code: str, icon_assets: List[Dict[str, Any]]) -> str:
    """
    Lägger automatiskt till saknade SVG-importer och <img>-taggar för alla förväntade ikoner.
    - Importer placeras efter sista import-raden.
    - <img>-taggar injiceras innan sista stängande taggen i return(...) JSX.
    """
    if not icon_assets or not isinstance(file_code, str) or not file_code.strip():
        return file_code

    # Befintliga imports och användningar
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
    expected = list(icon_assets)

    # Hitta saknade
    missing_assets: List[Dict[str, Any]] = []
    for ia in expected:
        p = ia["import_path"]
        if not any(_same_path(s, p) for s in used_paths):
            missing_assets.append(ia)

    if not missing_assets:
        return file_code

    # Bygg import-rader
    existing_import_vars = set(imports.keys())
    new_import_lines: List[str] = []
    new_img_snippets: List[str] = []

    for ia in missing_assets:
        p = str(ia["import_path"])
        if not p.lower().endswith(".svg") and not p.lower().endswith(".svg?url"):
            continue
        # säkerställ ?url
        imp_path = p if p.endswith("?url") else (p + "?url")
        var = _import_var_from_path(p, existing_import_vars)
        existing_import_vars.add(var)

        w = int(round(float(ia.get("w") or 0)))
        h = int(round(float(ia.get("h") or 0)))
        if w <= 0 or h <= 0:
            w = max(ICON_MIN, 24)
            h = max(ICON_MIN, 24)

        new_import_lines.append(f"import {var} from '{imp_path}';")
        new_img_snippets.append(
            f'<img src={{ {var} }} alt="" aria-hidden="true" width={{ {w} }} height={{ {h} }} '
            f'className="inline-block align-middle w-[{w}px] h-[{h}px]" />'
        )

    # Injicera importerna efter sista import
    insert_pos = 0
    import_iter = re.finditer(r"^(?:import\s.+?;)\s*$", file_code, flags=re.MULTILINE)
    for m in import_iter:
        insert_pos = m.end()
    if new_import_lines:
        prefix = file_code[:insert_pos]
        suffix = file_code[insert_pos:]
        add = ("\n" if not prefix.endswith("\n") else "") + "\n".join(new_import_lines) + "\n"
        file_code = prefix + add + suffix

    # Hitta return(...) och sista stängande tagg däri
    ret = re.search(r"return\s*\(", file_code)
    if ret:
        start = ret.end()
        end = file_code.find(");", start)
        if end == -1:
            end = len(file_code)
        jsx_region = file_code[start:end]
        # sista stängande tagg
        last_close = None
        for m in re.finditer(r"</[^>]+>", jsx_region):
            last_close = m
        if last_close:
            ins = start + last_close.start()
            indent_line_start = file_code.rfind("\n", 0, ins) + 1
            indent_match = re.match(r"[ \t]*", file_code[indent_line_start:ins]) if indent_line_start >= 0 else None
            indent = indent_match.group(0) if indent_match else ""
            imgs_text = "".join(f"\n{indent}{s}" for s in new_img_snippets)
            file_code = file_code[:ins] + imgs_text + file_code[ins:]
        else:
            imgs_text = "".join("\n  " + s for s in new_img_snippets)
            file_code = file_code[:end] + imgs_text + file_code[end:]

    file_code = _sanitize_img_positions(file_code)
    return file_code

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
        if not any(_same_path(p, e) for e in expected):
            unexpected_paths.append(p)

    for ia in icon_assets:
        p = ia["import_path"]
        if p in seen_expected:
            continue
        seen_expected.add(p)

        ok = any(_same_path(s, p) for s in used_paths)
        if not ok:
            missing.append(p)
            continue

        count = sum(1 for s in used_paths if _same_path(s, p))
        if count != 1:
            duplicates.append(f"{p} användningar: {count}")

        w_target = int(round(float(ia.get("w") or 0)))
        h_target = int(round(float(ia.get("h") or 0)))
        vars_for_path = [v for v, path in imports.items() if _same_path(path, p)]

        good = any(size_by_var.get(v, (None, None)) == (w_target, h_target) for v in vars_for_path)
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

# ─────────────────────────────────────────────────────────
# Extra layout-guard
# ─────────────────────────────────────────────────────────

def _assert_layout_justify(ir: Dict[str,Any], file_code: str) -> None:
    want = (ir["root"].get("layout") or {}).get("justify_content")
    blob = _gather_classes(file_code)
    if want != "space-between" and "justify-between" in blob:
        raise HTTPException(500, "Modellen använde justify-between trots att IR inte kräver det.")

# ─────────────────────────────────────────────────────────
# Hjälp: IR-logg-summering (endast om LOG_FIGMA_IR=1)
# ─────────────────────────────────────────────────────────

def _ir_root_summary(ir: Dict[str, Any]) -> Dict[str, Any]:
    def _cnt(n: Dict[str, Any]) -> int:
        return 1 + sum(_cnt(c) for c in n.get("children") or [])
    root = ir.get("root") or {}
    return {
        "meta": ir.get("meta"),
        "root": {
            "id": root.get("id"),
            "type": root.get("type"),
            "name": root.get("name"),
            "bounds": root.get("bounds"),
            "bg": root.get("bg"),
            "children_total": _cnt(root),
        },
    }

# ─────────────────────────────────────────────────────────
# NYTT: JSON-dumps och IR↔Figma jämförelsehjälpare
# ─────────────────────────────────────────────────────────

def _dump_json_file(tag: str, node_id: str, payload: Any) -> str:
    """Skriv JSON till temp och returnera sökvägen. Fail-tolerant."""
    try:
        ts = int(time.time())
        p = Path(tempfile.gettempdir()) / f"{tag}-{node_id}-{ts}.json"
        p.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        _safe_print(tag, {"node_id": node_id, "path": str(p)})
        return str(p)
    except Exception as e:
        _safe_print("dump.error", {"tag": tag, "err": str(e)})
        return ""

def _dump_text_file(tag: str, node_id: str, text: str) -> str:
    """Skriv text/TSX till temp och returnera sökvägen. Fail-tolerant."""
    try:
        ts = int(time.time())
        p = Path(tempfile.gettempdir()) / f"{tag}-{node_id}-{ts}.tsx"
        p.write_text(text, encoding="utf-8")
        _safe_print(tag, {"node_id": node_id, "path": str(p), "len": len(text)})
        return str(p)
    except Exception as e:
        _safe_print("dump.error", {"tag": tag, "err": str(e)})
        return ""

def _flat_figma(n: Dict[str, Any], out: Dict[str, Any]) -> None:
    bb = (n.get("absoluteRenderBounds") or n.get("absoluteBoundingBox") or {}) or {}
    out[str(n.get("id") or "")] = {
        "id": n.get("id"), "type": n.get("type"), "name": n.get("name"),
        "visible": n.get("visible", True), "clipsContent": n.get("clipsContent", False),
        "opacity": n.get("opacity", 1),
        "bounds": {"x": bb.get("x"), "y": bb.get("y"), "w": bb.get("width"), "h": bb.get("height")},
        "fills_len": len(n.get("fills") or []), "background_len": len(n.get("background") or n.get("backgrounds") or []),
        "bgc": bool(n.get("backgroundColor")), "strokes_len": len(n.get("strokes") or []),
        "effects_len": len(n.get("effects") or []),
        "text": (n.get("type") == "TEXT"), "chars_len": len((n.get("characters") or "")),
    }
    for c in n.get("children") or []:
        _flat_figma(c, out)

def _flat_ir(n: Dict[str, Any], out: Dict[str, Any]) -> None:
    node_id = str(n.get("id") or "")
    out[node_id] = {
        "id": n.get("id"), "type": n.get("type"), "name": n.get("name"),
        "visible_effective": n.get("visible_effective", True), "clips_content": n.get("clips_content", False),
        "opacity": n.get("opacity", 1), "bounds": n.get("bounds"),
        "bg": (n.get("bg") or {}).get("type"), "fills_len": len(n.get("fills") or []),
        "strokes_len": len(n.get("strokes") or []), "effects_len": len(n.get("effects") or []),
        "text": (n.get("type") == "TEXT"), "lines_len": len(((n.get("text") or {}).get("lines")) or []),
    }
    for c in n.get("children") or []:
        _flat_ir(c, out)

def _cmp_bounds(a: Dict[str, Any] | None, b: Dict[str, Any] | None) -> Dict[str, Any]:
    if not a or not b: return {"dx": None, "dy": None, "dw": None, "dh": None}
    return {
        "dx": (b.get("x") or 0) - (a.get("x") or 0),
        "dy": (b.get("y") or 0) - (a.get("y") or 0),
        "dw": (b.get("w") or 0) - (a.get("w") or 0),
        "dh": (b.get("h") or 0) - (a.get("h") or 0),
    }

def _compare_figma_vs_ir(figma_doc: Dict[str, Any], ir_visible: Dict[str, Any], limit: int = 200) -> Dict[str, Any]:
    f_map: Dict[str, Any] = {}; _flat_figma(figma_doc, f_map)
    i_map: Dict[str, Any] = {}; _flat_ir(ir_visible["root"], i_map)

    f_ids = [k for k in f_map.keys() if k]
    i_ids = [k for k in i_map.keys() if k]
    kept = [k for k in f_ids if k in i_map]
    dropped = [k for k in f_ids if k not in i_map]
    added = [k for k in i_ids if k not in f_map]

    per_node = {}
    for nid in kept[:limit]:
        per_node[nid] = {
            "figma": f_map[nid],
            "ir": i_map[nid],
            "delta": {
                "bounds_px": _cmp_bounds(
                    {"x": f_map[nid]["bounds"]["x"], "y": f_map[nid]["bounds"]["y"], "w": f_map[nid]["bounds"]["w"], "h": f_map[nid]["bounds"]["h"]},
                    i_map[nid]["bounds"],
                ),
                "opacity_diff": (i_map[nid]["opacity"] or 0) - (f_map[nid]["opacity"] or 0),
                "visible_to_effective": {"figma_visible": f_map[nid]["visible"], "ir_effective": i_map[nid]["visible_effective"]},
                "fills_len_diff": (i_map[nid]["fills_len"] or 0) - (f_map[nid]["fills_len"] or 0),
                "effects_len_diff": (i_map[nid]["effects_len"] or 0) - (f_map[nid]["effects_len"] or 0),
                "strokes_len_diff": (i_map[nid]["strokes_len"] or 0) - (f_map[nid]["strokes_len"] or 0),
                "text_lines_vs_chars": {"lines": i_map[nid]["lines_len"], "chars": f_map[nid]["chars_len"]},
                "bg_kind": i_map[nid]["bg"],
            },
        }

    return {
        "counts": {
            "figma_nodes": len(f_ids),
            "ir_nodes": len(i_ids),
            "kept": len(kept),
            "dropped": len(dropped),
            "added": len(added),
            "kept_ratio": round(len(kept) / max(1, len(f_ids)), 3),
        },
        "dropped_ids_sample": dropped[:limit],
        "added_ids_sample": added[:limit],
        "per_node_sample": per_node,
    }

# ─────────────────────────────────────────────────────────
# Celery-task
# ─────────────────────────────────────────────────────────

@app.task(name="backend.tasks.codegen.integrate_figma_node")
def integrate_figma_node(
    *, file_key: str, node_id: str, placement: Dict[str, Any] | None = None
) -> Dict[str, Any]:
    t0 = time.time()
    figma_json = _fetch_figma_node(file_key, node_id)
    t1 = time.time()

    ir_full = FIR.figma_to_ir(figma_json, node_id)
    ir = FIR.filter_visible_ir(ir_full) if hasattr(FIR, "filter_visible_ir") else ir_full

    # Endast önskad logg: vad figma_ir.py producerade
    if LOG_FIGMA_IR:
        try:
            _safe_print("figma_ir.output", _ir_root_summary(ir_full))
        except Exception:
            pass

    # NYTT: dumpa IR och jämförelse (valfritt via flaggor)
    try:
        if LOG_IR_FULL:
            _dump_json_file("ir-full", node_id, ir_full)
            _dump_json_file("ir-visible", node_id, ir)
        if LOG_IR_COMPARE:
            node_doc = ((figma_json or {}).get("nodes", {}).get(node_id, {}) or {}).get("document") or {}
            if node_doc:
                report = _compare_figma_vs_ir(node_doc, ir, IR_COMPARE_LIMIT)
                _dump_json_file("ir-compare", node_id, report)
                _safe_print("ir.compare.summary", {
                    "node_id": node_id,
                    **report["counts"],
                    "dropped_sample": report.get("dropped_ids_sample", [])[:10],
                    "added_sample": report.get("added_ids_sample", [])[:10],
                })
    except Exception as _e:
        _safe_print("ir.compare.error", {"err": str(_e)})

    t2 = time.time()

    # Samla ikon-noder och filtrera bort orimliga/text-bärande SVG
    raw_icon_nodes = FIR.collect_icon_nodes(ir["root"])

    icon_nodes: List[Dict[str, Any]] = []
    for ic in raw_icon_nodes:
        b = ic.get("bounds") or {}
        w = float(b.get("w") or 0)
        h = float(b.get("h") or 0)
        if _icon_size_ok(w, h):
            icon_nodes.append(ic)

    svg_by_id = _fetch_svgs(file_key, [x["id"] for x in icon_nodes])
    svg_by_id = {nid: svg for nid, svg in svg_by_id.items() if svg and not _svg_has_text(svg)}
    t3 = time.time()

    icon_assets: List[Dict[str, Any]] = []

    tmp_dir, repo = clone_repo()
    tmp_root = Path(tmp_dir)

    # Skriv ut SVG:er till repo och bygg import_path
    for ic in icon_nodes:
        nid = ic["id"]
        svg = svg_by_id.get(nid)
        if not svg:
            continue
        b = ic.get("bounds") or {}
        w = float(b.get("w") or 0)
        h = float(b.get("h") or 0)
        if not _icon_size_ok(w, h):
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
            "w": int(round(w)),
            "h": int(round(h)),
        })

    created_svg_types_rel = _ensure_svg_types(tmp_root)

    _ensure_node_modules(tmp_root)

    # Tillgängliga komponenter i reposet om det behövs för framtida logik
    _ = list_components(str(tmp_root))

    # === Deterministisk generering (ingen LLM) ===
    comp_name = _derive_import_name(ir["root"].get("name") or "FigmaNode")
    target_rel = (Path(TARGET_COMPONENT_DIR) / f"{comp_name}.tsx").as_posix()
    _gen_filename, file_code = generate_tsx_component(ir, icon_assets, comp_name)

    # Sätt upp mount som tidigare, import_path härleds senare relativt main.tsx
    mount = {"anchor": _ANCHOR_SINGLE, "import_name": comp_name}
    # Dummy 'out' för kompatibilitet längre ner (assets mm.)
    out: Dict[str, Any] = {}

    branch = unique_branch(node_id)
    repo.git.checkout("-b", branch)

    name = Path(target_rel).name or f"{mount['import_name']}.tsx"
    target_rel = (Path(TARGET_COMPONENT_DIR) / name).as_posix()

    target_path = _safe_join(tmp_root, target_rel)
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Rensa otillåten text
    file_code = _purge_unexpected_text_nodes(str(file_code), _required_texts(ir))
    # Auto-fixa saknade ikoner
    file_code = _autofix_missing_icons(file_code, icon_assets)
    # Sanera <img>-positionering innan validering
    file_code = _sanitize_img_positions(file_code)
    # Kompaktar arbitrary (tar bort blanks i bg-[rgba(...)] etc.)
    file_code = _compact_arbitrary_values(file_code)

    # Debug: snapshot före purge
    if LOG_BG_DEBUG:
        _dbg_bg("before_purge_snapshot", {"len": len(file_code)})
        _dump_text_file("bg-before-purge", node_id, str(file_code))

    # Purge oönskade bg-* innan validering (IR-källsanning)
    file_code = _purge_unexpected_backgrounds(ir, file_code)

    # Debug: snapshot efter purge
    if LOG_BG_DEBUG:
        _dbg_bg("after_purge_snapshot", {"len": len(file_code)})
        _dump_text_file("bg-after-purge", node_id, str(file_code))

    # AUTO-FIX font-family på första wrappern om IR har exakt en fontfamilj
    file_code = _autofix_font_family(ir, file_code)

    # Valideringar (kör på oformatterad sträng)
    _assert_icons_used(str(file_code), icon_assets)
    _assert_text_coverage(ir, str(file_code))
    _assert_no_extra_texts(ir, str(file_code))
    icon_ids = {ia["id"] for ia in icon_assets}
    _assert_dims_positions(ir, str(file_code), icon_ids)
    _assert_colors_shadows_and_gradients(ir, str(file_code), icon_ids)
    _assert_only_expected_backgrounds(ir, str(file_code))
    _assert_layout_justify(ir, str(file_code))
    _assert_typography(ir, str(file_code))

    # Skriv fil och formatera med Prettier för tydlig struktur
    cleaned = _sanitize_tailwind_conflicts(_compact_arbitrary_values(file_code))
    target_path.write_text(cleaned, encoding="utf-8")
    _format_tsx(tmp_root, target_path)

    returned_primary_path = target_rel

    # Relativ import till main.tsx och AST-injektion
    main_candidates = [p for p in ALLOW_PATCH if p.endswith("main.tsx")]
    main_rel = main_candidates[0] if main_candidates else "frontendplay/src/main.tsx"
    main_abs = _safe_join(tmp_root, main_rel)
    mount["import_path"] = _rel_import_from_main(main_abs, target_path)

    # Injicera endast komponenten utan wrapper för att undvika osynlig nod
    mount["jsx"] = f"<{mount['import_name']} />"

    _ast_inject_mount(tmp_root, mount)

    _typecheck_and_lint(tmp_root)

    try:
        _ = _visual_validate(tmp_root)
    except HTTPException:
        raise
    except Exception:
        pass

    repo.git.add("--all")
    commit_msg = f"feat(ai): add {returned_primary_path}"
    repo.index.commit(commit_msg)

    changed_paths: List[str] = []
    changed_paths.append(returned_primary_path)
    if main_abs.exists():
        changed_paths.append(main_rel)

    # (ingen extra asset-hantering i deterministisk generator ännu)
    assets: List[Dict[str, Any]] = []

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
            pass

    if not final_changes:
        final_changes.append(_read_rel(tmp_root, returned_primary_path))

    primary = next((c for c in final_changes if c["path"] == returned_primary_path), final_changes[0])

    result: Dict[str, Any] = {
        "status": "SUCCESS",
        "changes": final_changes,
        "path": primary["path"],
        "content": primary["content"],
    }
    return result


try:
    from . import analyze as _register_analyze  # noqa: F401
except Exception:
    pass

__all__ = ["app", "celery_app", "integrate_figma_node"]
