# backend/tasks/codegen.py
from __future__ import annotations

"""
Celery-worker: Figma-node → IR → kod → (AST-mount) → commit → returnera filinnehåll

Skillnader mot tidigare:
- Hämtar Figma → bygger IR (ingen fri tolkning direkt från modellen)
- Använder OpenAI Structured Outputs (JSON Schema) för strikt svar
- Skapar ny komponentfil under TARGET_COMPONENT_DIR
- Monterar i main.tsx via AST-injektion (inte textdiff)
- Patchar övriga filer via `git apply` om modellen väljer "patch"
- Kör typecheck/lint innan commit
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Tuple, cast

from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=True)

import requests
from fastapi import HTTPException
from celery import Celery

# OpenAI v1 SDK (Structured Outputs)
from openai import OpenAI  # type: ignore

from .figma_ir import figma_to_ir
from .utils import clone_repo, list_components, unique_branch
from .schemas import build_codegen_schema

# ─────────────────────────────────────────────────────────
# Miljö & konfiguration
# ─────────────────────────────────────────────────────────

BROKER_URL = (os.getenv("CELERY_BROKER_URL") or "redis://redis:6379/0").strip()
RESULT_BACKEND = (os.getenv("CELERY_RESULT_BACKEND") or BROKER_URL).strip()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or ""
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()

TARGET_COMPONENT_DIR = os.getenv("TARGET_COMPONENT_DIR", "frontendplay/src/components/ai").strip().rstrip("/")
ALLOW_PATCH = [
    p.strip().replace("\\", "/")
    for p in (os.getenv("ALLOW_PATCH", "frontendplay/src/main.tsx").split(";"))
    if p.strip()
]

FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
if not FIGMA_TOKEN:
    raise RuntimeError("FIGMA_TOKEN saknas i miljön (.env).")

# ─────────────────────────────────────────────────────────
# Celery-app
# ─────────────────────────────────────────────────────────

app = Celery("codegen", broker=BROKER_URL, backend=RESULT_BACKEND)
app.conf.broker_connection_retry_on_startup = False
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
# Hjälpfunktioner
# ─────────────────────────────────────────────────────────

def _run(cmd: list[str], cwd: str | Path) -> Tuple[int, str, str]:
    """Kör ett kommando och returnerar (rc, stdout, stderr)."""
    p = subprocess.run(cmd, cwd=str(cwd), text=True, capture_output=True)
    return p.returncode, p.stdout, p.stderr

def _git_apply(repo_root: Path, diff_text: str) -> None:
    """Applicera unified diff via git apply (failar på reject)."""
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".patch") as f:
        f.write(diff_text)
        patch_path = f.name
    try:
        rc, out, err = _run(["git", "-C", str(repo_root), "apply", "--reject", "--whitespace=nowarn", patch_path], cwd=repo_root)
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
    except Exception as e:  # pragma: no cover
        raise HTTPException(502, f"Ogiltigt JSON-svar från Figma: {e}") from e
    return cast(Dict[str, Any], data)

from openai.types.chat import ChatCompletionSystemMessageParam, ChatCompletionUserMessageParam

def _build_messages(ir: dict, components: dict[str, Path], placement: dict | None) -> list[Any]:
    """System + User med strikt policy. User-innehåll som JSON."""
    try:
        overview = {name: str(path.relative_to(Path.cwd())) for name, path in components.items()}
    except Exception:
        overview = {name: str(path) for name, path in components.items()}

    user_payload = {
        "ir": ir,
        "components": overview,
        "placement": placement or {},
        "constraints": {
            "no_inline_styles": True,
            "framework": "react+vite",
            "tokens_css": "frontendplay/src/styles/tokens.css",
            "mount_anchor": "AI-INJECT-MOUNT",
            "target_component_dir": TARGET_COMPONENT_DIR,
            "allow_patch": ALLOW_PATCH,
        },
    }

    system = (
        "Du är en strikt kodgenerator. Returnera ENDAST JSON som matchar schema. "
        "Inga inline-styles. Använd semantiska element, CSS-modul eller Tailwind, och följ tokens. "
        "Montera komponenten i main.tsx via 'mount' (AST-injektion vid ankaret), wrappa inte <App/>. "
        "Om befintlig komponent kan återanvändas: 'patch' den filen. Annars 'file' i target_component_dir."
    )

    return [
        ChatCompletionSystemMessageParam(role="system", content=system),
        ChatCompletionUserMessageParam(role="user", content=json.dumps(user_payload, ensure_ascii=False)),
    ]

def _ast_inject_mount(repo_root: Path, mount: dict) -> None:
    """
    Kör TS/AST-injektion som säkerställer import + JSX-mount vid AI-INJECT-MOUNT.
    Kräver scripts/ai_inject_mount.ts (ts-morph).
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

    # Node + tsx (eller ts-node) behövs i miljön
    cmd = [
        "node", "--loader", "tsx",
        "scripts/ai_inject_mount.ts",
        str(main_tsx),
        str(import_name),
        str(import_path),
        str(jsx),
    ]
    rc, out, err = _run(cmd, cwd=repo_root)
    if rc != 0:
        raise HTTPException(500, f"AST-injektion misslyckades:\n{err or out}")

def _typecheck_and_lint(repo_root: Path) -> None:
    """Kör typecheck och lint/prettier. Får gärna vara no-op om script saknas."""
    # Typecheck
    rc, out, err = _run(["pnpm", "-s", "typecheck"], cwd=repo_root)
    if rc != 0:
        raise HTTPException(500, f"Typecheck misslyckades:\n{err or out}")

    # Lint fix
    rc, out, err = _run(["pnpm", "-s", "lint:fix"], cwd=repo_root)
    if rc != 0:
        # Låt lint-fel vara mjuka om formatters saknas
        logger.warning("lint:fix returnerade felkod: %s\n%s", rc, err or out)

def _normalize_target_for_file_mode(target_rel: str) -> str:
    """För nya filer: tvinga in i TARGET_COMPONENT_DIR och behåll endast filnamn."""
    try:
        name = Path(target_rel).name
    except Exception:
        name = "GeneratedComponent.tsx"
    return (Path(TARGET_COMPONENT_DIR) / name).as_posix()

# ─────────────────────────────────────────────────────────
# Celery-task
# ─────────────────────────────────────────────────────────

@app.task(name="backend.tasks.codegen.integrate_figma_node")
def integrate_figma_node(*, file_key: str, node_id: str, placement: Dict[str, Any] | None = None) -> Dict[str, str]:
    """
    Returnerar: {"content": "<file contents>", "path": "<relativ/sökväg>"}.
    Notera: Vi ändrar ev. flera filer i temp-repot (t.ex. main.tsx via AST),
    men vi returnerar endast *en* fil (ny/patchad) för direkt-applicering i editor.
    """
    logger.info("Integrationsstart: file_key=%s node_id=%s", file_key, node_id)

    # 1) Figma → IR
    figma_json = _fetch_figma_node(file_key, node_id)
    ir = figma_to_ir(figma_json, node_id)
    logger.info("IR byggd.")

    # 2) Klona repo till temp
    tmp_dir, repo = clone_repo()
    tmp_root = Path(tmp_dir)
    logger.info("Repo klonat till %s", tmp_root)

    # 3) Skanna komponenter (för översikt till modellen)
    components = list_components(str(tmp_root))
    logger.info("Hittade %d komponent(er).", len(components))

    # 4) OpenAI: strikt JSON enligt schema
    schema = build_codegen_schema(TARGET_COMPONENT_DIR, ALLOW_PATCH)
    client = OpenAI(api_key=OPENAI_API_KEY)

    messages = _build_messages(ir, components, placement)
    logger.info("Skickar prompt till OpenAI (%s) …", OPENAI_MODEL)
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=messages,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "Codegen", "schema": schema, "strict": True},
        },
        temperature=0.2,
    )

    raw = resp.choices[0].message.content or "{}"
    try:
        out = json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"Modellen returnerade ogiltig JSON: {e}")

    mode = out.get("mode")
    target_rel = cast(str, out.get("target_path") or "")
    mount = out.get("mount") or {}
    file_code = out.get("file_code") or ""
    unified_diff = out.get("unified_diff") or ""

    if not mode or not target_rel:
        raise HTTPException(500, "Saknar 'mode' eller 'target_path' i modelsvaret.")

    # 5) Git branch
    branch = unique_branch(node_id)
    repo.git.checkout("-b", branch)

    # 6) Tillämpa ändring
    #    - file: skriv fil under TARGET_COMPONENT_DIR
    #    - patch: git apply, men om målet är main.tsx → ignorera diff och använd AST-injektion
    returned_path: str
    if mode == "file":
        target_rel = _normalize_target_for_file_mode(target_rel)
        target_path = tmp_root / target_rel
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if not file_code:
            raise HTTPException(500, "file_code saknas för mode='file'.")
        target_path.write_text(file_code, encoding="utf-8")
        returned_path = target_rel

    elif mode == "patch":
        norm = target_rel.replace("\\", "/")
        if norm not in ALLOW_PATCH:
            raise HTTPException(400, f"Patch ej tillåten för {norm}. Tillåtna: {ALLOW_PATCH}")
        # Om modellen försöker patcha main.tsx: ignorera diff och låt AST-injektion hantera mount.
        if norm.endswith("main.tsx"):
            logger.info("Ignorerar diff mot main.tsx; använder AST-injektion för montering.")
            returned_path = norm  # vi returnerar main.tsx-innehåll efter AST för editor-apply
        else:
            if not unified_diff:
                raise HTTPException(500, "unified_diff saknas för mode='patch'.")
            _git_apply(tmp_root, unified_diff)
            returned_path = norm
    else:
        raise HTTPException(500, f"Okänt mode: {mode}")

    # 7) AST-injektion för mount (alltid)
    _ast_inject_mount(tmp_root, mount)

    # 8) Typecheck + lint
    _typecheck_and_lint(tmp_root)

    # 9) Commit
    #    Stage både target-filen och main.tsx om den ändrats.
    repo.git.add("--all")
    commit_msg = (
        f"feat(ai): add {returned_path}" if mode == "file" else f"chore(ai): patch {returned_path}"
    )
    repo.index.commit(commit_msg)
    logger.info("Commit klar: %s", commit_msg)

    # 10) Läs ut filinnehåll som ska skickas tillbaka till extension
    #     Om vi valde att returnera main.tsx, läs den. Annars läs målfilen.
    out_path = tmp_root / returned_path
    if not out_path.exists():
        # Om modellen skapade fil + vi samtidigt returnerar main.tsx
        # kan returned_path peka på main.tsx. Då finns den.
        raise HTTPException(500, f"Returnfil saknas: {returned_path}")

    content = out_path.read_text(encoding="utf-8")
    logger.info("Code changes ready for direct apply: %s", returned_path)
    return {"content": content, "path": returned_path}

# Registrera ev. analyze-tasks
try:
    from . import analyze as _register_analyze  # noqa: F401
except Exception as e:  # pragma: no cover
    logging.getLogger(__name__).warning("Kunde inte importera analyze-tasks: %s", e)

__all__ = ["app", "celery_app", "integrate_figma_node"]
