# backend/tasks/codegen.py
from __future__ import annotations
"""
Celery-worker: Figma-node → IR → LLM-förslag → (AST-mount + file) → validering → commit → returnera ändringar

Uppdateringar:
- Endast synlig text (visible_effective=True) byggs till textkrav.
- Tailwind-hints (tw_map) skickas till modellen.
- Tolerant men informativ validering för mått/position.
- Ikonexporten filtrerar bort containers och SVG:er som innehåller <text>/<tspan> eller orimliga mått/aspekt.
- Dims/pos-validering körs mot klippkedja och respekterar effektiv synlighet.
- Validering kräver font-family-klass i JSX enligt Figma (arbitrary value), inkl. korrekt escaping.

Nytt i denna version:
- Ikonprompten kräver import av varje ikon och exakt en <img> per ikon, utan absoluta left/top.
- Ikonvalideringen accepterar både absoluta (/src/...) och relativa imports, validerar storlek och exakt en användning, men ignorerar position.
- Sanering tar bort felaktiga left-/top-/absolute-klasser på <img> så ikoner inte hamnar utanför vyn.
- AUTO-FIX: Saknade ikon-importer och <img>-taggar injiceras automatiskt i file_code innan validering.
- Dims/pos-validering hoppar över ikon-subträd (leafs i exporterad ikon kontrolleras inte separat).
- Färgvalidering hoppar över ikon-subträd och är case-/format-tålig (hex och rgba).

Nytt i denna variant:
- Prettier kör endast lokal bin om den finns, annars lätt fallback-formattering (ingen npx).
- AST-injektion använder endast lokala metoder (node + tsx eller lokal .bin/tsx), ingen npx.
- Figma SVG-hämtning parallelliseras med kortare timeouts.
- GPT-5: hoppa direkt till strikt=False schema, därefter json_object.
- Systemprompten ber modellen att lämna mount.import_path tomt.

Felsäkringar för 1:1:
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
from openai import OpenAI  # type: ignore
from openai.types.chat import (
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
)

from . import figma_ir as FIR
from .schemas import build_codegen_schema
from .utils import clone_repo, list_components, unique_branch

# ─────────────────────────────────────────────────────────
# Miljö & konfiguration
# ─────────────────────────────────────────────────────────

load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=True)

BROKER_URL = (os.getenv("CELERY_BROKER_URL") or "redis://redis:6379/0").strip()
RESULT_BACKEND = (os.getenv("CELERY_RESULT_BACKEND") or BROKER_URL).strip()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or ""
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5").strip()
# OBS: GPT-5 accepterar endast default-temperatur. Vi skickar aldrig 'temperature' för gpt-5*.
OPENAI_TEMPERATURE = os.getenv("OPENAI_TEMPERATURE", "").strip()  # används endast för icke-gpt-5

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

# NYTT: respektera IGNORE_ROOT_FILL även i valideringen
IGNORE_ROOT_FILL = os.getenv("IGNORE_ROOT_FILL", "0").lower() in ("1", "true", "yes")

FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
if not FIGMA_TOKEN:
    raise RuntimeError("FIGMA_TOKEN saknas i miljön (.env).")

ENABLE_VISUAL_VALIDATE = (
    os.getenv("ENABLE_VISUAL_VALIDATE", "false").lower() in ("1", "true", "yes")
)

CODEGEN_TIMING = os.getenv("CODEGEN_TIMING", "0").lower() in ("1", "true", "yes")

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
# LLM-prompt
# ─────────────────────────────────────────────────────────

def _build_messages(
    ir: dict,
    components: dict[str, Path],
    placement: dict | None,
    icon_assets: List[Dict[str, Any]],
) -> list[Any]:
    try:
        overview = {name: str(path.relative_to(Path.cwd())) for name, path in components.items() if isinstance(path, Path)}
    except Exception:
        overview = {name: str(path) for name, path in components.items()}

    tw_map = FIR.build_tailwind_map(ir["root"])

    user_payload = {
        "ir": ir,
        "components": overview,
        "placement": placement or {},
        "icon_assets": icon_assets,
        "required_texts": _required_texts(ir),
        "tw_map": tw_map,
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
        "w-[NNpx]/h-[NNpx]/gap-[NNpx]/pt-[..], text-[NNpx], leading-[NNpx], tracking-[..], "
        "färger text-[#RRGGBB]/bg-[#RRGGBB] eller rgba, skuggor shadow-[...], hörn rounded-[..], border-[..]. "
        "IKONER: För VARJE post i 'icon_assets' måste du importera exakt import_path med suffix '?url' "
        "och rendera exakt EN <img> per ikon med: src={ImportVar} alt='' aria-hidden='true' "
        "width={w} height={h} className='inline-block align-middle w-[{w}px] h-[{h}px]'. "
        "Använd inte absoluta left/top för ikoner i flex-rader; ikonen placeras i rätt rad enligt IR-strukturen. "
        "JSX får endast innehålla texterna i 'required_texts' ordagrant. "
        "För TEXT-noder: om 'text.lines' finns ska varje rad renderas separat. "
        "Rendera barn i stigande 'z' (barnens index). "
        "Skapa/uppdatera alltid en komponentfil (mode='file') i target_component_dir och montera via 'mount'; patch är förbjudet. "
        "Sätt inte 'mount.import_path' i svaret; lämna den tom. Sätt endast 'mount.import_name' vid behov. "
        "Formatering: Skriv läsbar JSX, inte minifierad. Bryt return(...) över flera rader, en tagg per rad, korrekt indentering. "
        "Speglas i koden: behåll IR-hierarkin i JSX, så varje IR-node motsvarar ett element. "
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
_ARBITRARY = re.compile(r'(\-[[])([^]]+)([]])')
def _compact_arbitrary_values(src: str) -> str:
    def repl(m: re.Match) -> str:
        inner = m.group(2)
        inner = re.sub(r'\s+', '', inner)
        inner = inner.replace('% ', '%')
        return m.group(1) + inner + m.group(3)
    return _ARBITRARY.sub(repl, src)

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
    return _IMG_WITH_CLASS.sub(repl, src)

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
    r"title\s*=\s*\{\s*'([^']+)" r"'\s*\}",
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
    return [_canon_text(p).replace("\u2026", "...") for p in out if 0 < len(p) <= 80]

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
    return [_canon_text(p).replace("\u2026", "...") for p in parts if 0 < len(p) <= 80]

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
    fills = n.get("fills") or []
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
        if w_tokens and not _any(w_tokens):
            raise HTTPException(
                500,
                f"Saknar breddklass {w_tokens[0]} (alternativ: {', '.join(w_tokens)}) "
                f"för node id={nid} name={nname} type={ntype} bounds={b}"
            )
        h_tokens = _need_h(b.get("h"))
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
            rec(ch, next_clip, False)

    root = cast(Dict[str, Any], ir.get("root") or {})
    root_clip = cast(Dict[str, float] | None, (root.get("debug") or {}).get("rootClip") or root.get("bounds"))
    rec(root, root_clip, False)

# ─────────────────────────────────────────────────────────
# Färger, skuggor, gradients
# ─────────────────────────────────────────────────────────

def _hex_to_rgba_str(hex_col: str, a: float) -> str:
    r = int(hex_col[1:3],16); g = int(hex_col[3:5],16); b = int(hex_col[5:7],16)
    return f"rgba({r}, {g}, {b}, {a})"

def _assert_colors_shadows_and_gradients(
    ir: Dict[str, Any],
    file_code: str,
    icon_asset_ids: set[str] | None = None,
) -> None:
    """
    Färg/skugg/gradient-validering som:
    - Ignorerar ikon-subträd (renderas som <img>).
    - Är case-tålig för hex.
    - Tillåter valfri whitespace i rgba() och matchar via prefix.
    - NYTT: ignorerar fill på root när IGNORE_ROOT_FILL=1.
    - NYTT: accepterar #rrggbbaa samt slash-opacity (bg-[#000]/20) i arbitrary.
    """
    icon_asset_ids = set(icon_asset_ids or set())

    class_attrs = [m.group("val") or "" for m in _CLS_RE.finditer(file_code)]
    class_blob = " ".join(class_attrs).lower()
    class_tokens: set[str] = set()
    for s in class_attrs:
        for t in s.split():
            tt = t.strip().lower()
            if tt:
                class_tokens.add(tt)

    def has_token(tok: str) -> bool:
        return tok.lower() in class_tokens

    def has_sub(s: str) -> bool:
        return s.lower() in class_blob

    def _rgba_triplet(c_hex: str) -> Tuple[int,int,int]:
        c = c_hex.lstrip("#")
        return int(c[0:2],16), int(c[2:4],16), int(c[4:6],16)

    def _has_alpha_variants(col_hex: str, a: float, is_text: bool) -> bool:
        r,g,b = _rgba_triplet(col_hex)
        pref = "text-[" if is_text else "bg-["
        # rgba variant
        if has_sub(f"{pref}rgba({r},{g},{b},"):
            return True
        # hex8 variant
        aa = f"{int(round(a*255)):02x}"
        if has_sub(f"{pref}#{col_hex.lower().lstrip('#')}{aa}]"):
            return True
        # slash opacity variant
        if has_sub(f"{pref}#{col_hex.lower().lstrip('#')}/"):
            return True
        return False

    def rec(n: Dict[str,Any], clip: Dict[str, float] | None):
        if n.get("id") in icon_asset_ids:
            return
        if not _effectively_visible_ir(n, clip):
            return

        # Ignorera root-fill om flaggad
        if not (IGNORE_ROOT_FILL and n.get("is_root")):
            for f in (n.get("fills") or []):
                if _bool(f.get("visible", True), True):
                    t = str(f.get("type") or "")
                    if t == "SOLID":
                        col = f.get("color"); a = float(f.get("alpha",1) or 1)
                        if not col:
                            break
                        if a >= 0.999:
                            want = f"text-[{col}]" if n.get("type") == "TEXT" else f"bg-[{col}]"
                            if not has_token(want):
                                raise HTTPException(500, f"Saknar färgklass {want}")
                        else:
                            is_text = (n.get("type") == "TEXT")
                            if not _has_alpha_variants(col, a, is_text):
                                raise HTTPException(500, "Saknar semitransparent färgklass (rgba, #rrggbbaa eller /opacity)")
                        break
                    if t.startswith("GRADIENT_"):
                        if not has_sub("bg-[linear-gradient("):
                            raise HTTPException(500, "Saknar gradientklass bg-[linear-gradient(...)]")
                        break

        css = n.get("css") or {}
        if css.get("boxShadow"):
            want = f"shadow-[{css['boxShadow']}]".lower()
            if want not in class_tokens and want not in class_blob:
                if not has_sub("shadow-["):
                    raise HTTPException(500, f"Saknar skuggklass {want}")

        next_clip = _next_clip_ir(n, clip)
        for ch in n.get("children") or []:
            rec(ch, next_clip)

    rec(ir["root"], None)

# Förbjud bakgrunder som inte finns i IR
_BG_TOKEN = re.compile(r'\bbg-\[([^\]]+)\]')

def _expected_bg_set(ir: Dict[str,Any]) -> set[str]:
    exp: set[str] = set()
    def rec(n: Dict[str,Any]):
        if n.get("type") != "TEXT":
            for f in n.get("fills") or []:
                if not _bool(f.get("visible",True), True):
                    continue
                t = str(f.get("type") or "")
                if t == "SOLID" and f.get("color") and (float(f.get("alpha",1) or 1) > 0.001):
                    col = str(f["color"]).lower().lstrip("#")
                    a = float(f.get("alpha",1) or 1)
                    if a >= 0.999:
                        exp.add(f"#{col}")
                    else:
                        r,g,b = int(col[0:2],16), int(col[2:4],16), int(col[4:6],16)
                        exp.add(f"rgba({r},{g},{b},")  # prefixmatch
                        aa = f"{int(round(a*255)):02x}"
                        exp.add(f"#{col}{aa}")        # hex8
                        exp.add(f"#{col}/")            # slash-opacity prefix
                elif t.startswith("GRADIENT_"):
                    exp.add("linear-gradient(")        # prefix
        for ch in n.get("children") or []:
            rec(ch)
    rec(ir["root"])
    return exp

def _assert_only_expected_backgrounds(ir: Dict[str,Any], file_code: str) -> None:
    allowed = _expected_bg_set(ir)
    bad: list[str] = []
    for m in _BG_TOKEN.finditer(file_code):
        raw = m.group(1).strip().lower().replace(" ", "")
        ok = any(raw.startswith(a.replace(" ", "")) for a in allowed)
        if not ok:
            bad.append(raw)
    if bad:
        raise HTTPException(500, "Otillåtna bakgrunder i JSX: " + ", ".join(sorted(set(bad))[:12]))

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

            ls = st.get("letterSpacing")
            if isinstance(ls, str) and len(ls) > 0:
                want = f"tracking-[{ls}]"
                if want not in classes:
                    raise HTTPException(500, f"Saknar letter-spacing klass {want}")

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
# GPT-5-säker anropare med fallback
# ─────────────────────────────────────────────────────────

def _supports_temperature(model: str) -> bool:
    # GPT-5-modeller accepterar inte explicit temperatur ≠ default
    return not model.lower().startswith("gpt-5")

def _parse_temperature(s: str) -> float | None:
    try:
        v = float(s)
        return v
    except Exception:
        return None

def _is_invalid_content_err(e: Exception) -> bool:
    t = str(e).lower()
    return ("invalid content" in t) or ("model produced invalid" in t)

def _is_temp_unsupported_err(e: Exception) -> bool:
    t = str(e).lower()
    return ("temperature" in t) and ("unsupported" in t or "only the default" in t)

def _call_codegen(client: OpenAI, model: str, messages: list[Any], schema: dict) -> Any:
    """
    Robust kedja:
      gpt-5: JSON Schema strict=False → json_object
      övriga: strict=True → strict=False → json_object
    Tar hänsyn till GPT-5:s temperaturbegränsning.
    """
    base_kwargs: Dict[str, Any] = {
        "model": model,
        "messages": messages,
    }

    # Lägg endast temperatur för icke-gpt-5 och om användaren faktiskt satt ett värde != 1
    if _supports_temperature(model):
        t = _parse_temperature(OPENAI_TEMPERATURE)
        if t is not None and t != 1.0:
            base_kwargs["temperature"] = t

    # Hjälpare som kan prova en create med automatisk retry om temps är ogiltig
    def _try_create(**kw):
        try:
            return client.chat.completions.create(**kw)
        except Exception as e:
            if _is_temp_unsupported_err(e) and "temperature" in kw:
                kw2 = dict(kw)
                kw2.pop("temperature", None)
                return client.chat.completions.create(**kw2)
            raise

    ml = model.lower()
    if ml.startswith("gpt-5"):
        # 1) strict=False
        try:
            return _try_create(
                **base_kwargs,
                response_format={
                    "type": "json_schema",
                    "json_schema": {"name": "Codegen", "schema": schema, "strict": False},
                },
            )
        except Exception:
            # 2) json_object
            return _try_create(
                **base_kwargs,
                response_format={"type": "json_object"},
            )

    # Icke gpt-5: full kedja
    try:
        return _try_create(
            **base_kwargs,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "Codegen", "schema": schema, "strict": True},
            },
        )
    except Exception as e:
        if not _is_invalid_content_err(e):
            raise

    try:
        return _try_create(
            **base_kwargs,
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "Codegen", "schema": schema, "strict": False},
            },
        )
    except Exception as e:
        if not _is_invalid_content_err(e):
            raise

    return _try_create(
        **base_kwargs,
        response_format={"type": "json_object"},
    )

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

    components = list_components(str(tmp_root))

    schema = build_codegen_schema(TARGET_COMPONENT_DIR, ALLOW_PATCH)
    client = OpenAI(api_key=OPENAI_API_KEY)
    messages = _build_messages(ir, components, placement, icon_assets)

    # GPT-5-säkert anrop med snabbare fallback
    resp = _call_codegen(client, OPENAI_MODEL, messages, schema)
    t4 = time.time()

    raw = resp.choices[0].message.content or "{}"
    try:
        out = json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"Modellen returnerade ogiltig JSON: {e}")

    mode = out.get("mode")
    if mode != "file":
        raise HTTPException(400, "Model must return mode='file'.")
    for key in ("file_code", "unified_diff", "mount"):
        v = out.get(key)
        if isinstance(v, str) and _TRIPLE_BACKTICKS.search(v):
            raise HTTPException(500, f"Ogiltigt innehåll i '{key}': innehåller ```")

    mount = out.get("mount") or {}
    mount.setdefault("anchor", _ANCHOR_SINGLE)
    # Ignorera modellens import_path, pipeline härleder en säker relativ
    mount.pop("import_path", None)

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
        cand = out.get("target_path") or "GeneratedComponent"
        mount["import_name"] = _derive_import_name(str(cand))

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
    if not target_rel:
        raise HTTPException(500, "Saknar 'target_path' i modelsvaret.")

    branch = unique_branch(node_id)
    repo.git.checkout("-b", branch)

    name = Path(target_rel).name or f"{mount['import_name']}.tsx"
    target_rel = (Path(TARGET_COMPONENT_DIR) / name).as_posix()

    target_path = _safe_join(tmp_root, target_rel)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    file_code = out.get("file_code")
    if not isinstance(file_code, str) or not file_code.strip():
        raise HTTPException(500, "file_code saknas för mode='file'.")

    # Rensa otillåten text
    file_code = _purge_unexpected_text_nodes(str(file_code), _required_texts(ir))
    # Auto-fixa saknade ikoner
    file_code = _autofix_missing_icons(file_code, icon_assets)
    # Sanera <img>-positionering innan validering
    file_code = _sanitize_img_positions(file_code)
    # Kompaktar arbitrary (tar bort blanks i bg-[rgba(...)] etc.)
    file_code = _compact_arbitrary_values(file_code)

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

    # Root-offset wrapper för korrekt placering i viewport
    try:
        # Använd rootClip för origo och invertera tecknet så renderingen hamnar i (0,0)
        USE_CLIP = os.getenv("MOUNT_USE_ROOTCLIP", "1").lower() in ("1", "true", "yes")
        vw = int(ir["meta"]["viewport"]["w"])
        vh = int(ir["meta"]["viewport"]["h"])
        base_rect = ((ir.get("root", {}).get("debug") or {}).get("rootClip") if USE_CLIP else ir["root"].get("bounds")) or {}
        cx = int(round(float(base_rect.get("x") or 0)))
        cy = int(round(float(base_rect.get("y") or 0)))
        dx, dy = -cx, -cy

        mount["jsx"] = (
            f"<div className='relative w-[{vw}px] h-[{vh}px] overflow-hidden'>"
            f"<div className='absolute left-[{dx}px] top-[{dy}px]'>"
            f"<{mount['import_name']} />"
            f"</div></div>"
        )
    except Exception:
        if not mount.get("jsx"):
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
            pass

    if not final_changes:
        final_changes.append(_read_rel(tmp_root, returned_primary_path))

    primary = next((c for c in final_changes if c["path"] == returned_primary_path), final_changes[0])

    if CODEGEN_TIMING:
        t5 = time.time()
        print("[codegen_timing]", {
            "figma": round(t1 - t0, 3),
            "ir": round(t2 - t1, 3),
            "svg": round(t3 - t2, 3),
            "model": round(t4 - t3, 3),
            "post": round(t5 - t4, 3),
        })

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
