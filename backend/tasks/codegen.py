# backend/tasks/codegen.py
from __future__ import annotations

"""
Celery-worker: Figma-node → IR → LLM-förslag → (AST-mount + patch/file) → validering → commit → returnera *alla* ändrade filer

Mål:
- Determinism: strikt JSON-schema, låg temperatur, hård validering av svar.
- Robusthet: säkra paths, hantera assets, kör pnpm install vid behov, tolerant lint.
- Korrekt montering: AST-injektion i main.tsx via separat TS-script (ts-morph).
- Multi-file retur: extension kan skriva alla berörda filer, inte bara en.
- (Valfritt) visuell validering: kör Playwright/pixel-diff om testscript finns.

Kräver att följande filer/script finns i repo (läggs till i projektet):
- scripts/ai_inject_mount.ts  (körs med: node --loader tsx scripts/ai_inject_mount.ts <main.tsx> <importName> <importPath> <jsxFilePath>)
"""

import base64
import json
import logging
import os
import re
import shutil
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

from .figma_ir import figma_to_ir
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

FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
if not FIGMA_TOKEN:
    raise RuntimeError("FIGMA_TOKEN saknas i miljön (.env).")

# Valfri visuell validering via Playwright/pixelmatch
ENABLE_VISUAL_VALIDATE = (os.getenv("ENABLE_VISUAL_VALIDATE", "false").lower() in ("1", "true", "yes"))

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
# Hjälpfunktioner (shell, git, IO)
# ─────────────────────────────────────────────────────────


def _run(cmd: List[str], cwd: str | Path | None = None, timeout: int | None = None) -> Tuple[int, str, str]:
    """Kör ett kommando och returnerar (rc, stdout, stderr)."""
    p = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    return p.returncode, p.stdout, p.stderr


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
    except Exception as e:  # pragma: no cover
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
    """Installera beroenden om node_modules saknas eller package.json saknas script."""
    pkg = repo_root / "package.json"
    if not pkg.exists():
        # Många projekt ligger under /frontendplay. Försök där.
        pkg = repo_root / "frontendplay" / "package.json"
        if not pkg.exists():
            logger.info("Hittar ingen package.json – hoppar över pnpm install.")
            return
        workdir = pkg.parent
    else:
        workdir = pkg.parent

    nm = workdir / "node_modules"
    if not nm.exists():
        logger.info("node_modules saknas – kör pnpm install …")
        rc, out, err = _run(["pnpm", "-s", "install", "--frozen-lockfile"], cwd=workdir)
        if rc != 0:
            logger.warning("pnpm install --frozen-lockfile misslyckades, provar utan flagga …\n%s", err or out)
            rc2, out2, err2 = _run(["pnpm", "-s", "install"], cwd=workdir)
            if rc2 != 0:
                raise HTTPException(500, f"pnpm install misslyckades:\n{err2 or out2}")


def _package_scripts(repo_root: Path) -> Dict[str, str]:
    """Läs package.json scripts (för att veta om typecheck/test:visual finns)."""
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


# ─────────────────────────────────────────────────────────
# LLM-prompt
# ─────────────────────────────────────────────────────────


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
            "no_dangerous_html": True,
            "framework": "react+vite",
            "tokens_css": "frontendplay/src/styles/tokens.css",
            "mount_anchor": "AI-INJECT-MOUNT",
            "target_component_dir": TARGET_COMPONENT_DIR,
            "allow_patch": ALLOW_PATCH,
        },
    }

    system = (
        "Du är en strikt kodgenerator. Returnera ENDAST JSON som matchar schema. "
        "Inga inline-styles. Använd semantiska element, CSS-modul eller Tailwind och följ tokens. "
        "Montera komponenten i main.tsx via 'mount' (AST-injektion vid ankaret), wrappa inte <App/>. "
        "Om befintlig komponent kan återanvändas: 'patch' den filen. Annars 'file' i target_component_dir. "
        "Skriv aldrig markdown-triple-backticks i kodfält. Inga absoluta paths eller ../ i import_path."
    )

    return [
        ChatCompletionSystemMessageParam(role="system", content=system),
        ChatCompletionUserMessageParam(role="user", content=json.dumps(user_payload, ensure_ascii=False)),
    ]


# ─────────────────────────────────────────────────────────
# AST-injektion (main.tsx)
# ─────────────────────────────────────────────────────────


def _ast_inject_mount(repo_root: Path, mount: dict) -> None:
    """
    Kör TS/AST-injektion som säkerställer import + JSX-mount vid AI-INJECT-MOUNT.
    Använder absolut path till tsx-loader så Node slipper resolva paketnamnet.
    """
    # Lokalisera main.tsx
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

    # Skriv JSX till tempfil (robust mot specialtecken)
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".jsx.txt", encoding="utf-8") as tmp:
        tmp.write(str(jsx))
        jsx_file_path = tmp.name

    try:
        # Hitta var package.json finns (repo-root eller frontendplay/)
        base = repo_root
        if not (base / "package.json").exists() and (repo_root / "frontendplay" / "package.json").exists():
            base = repo_root / "frontendplay"

        # Absolut path till tsx-loader
        tsx_loader = base / "node_modules" / "tsx" / "dist" / "loader.js"
        if not tsx_loader.exists():
            raise HTTPException(
                500,
                f"tsx saknas i {base}. Installera med: pnpm -C {base} add -D tsx",
            )

        script_path = repo_root / "scripts" / "ai_inject_mount.ts"
        if not script_path.exists():
            raise HTTPException(500, f"Saknar scripts/ai_inject_mount.ts: {script_path}")

        tsx_loader = "tsx"


        cmd = [
        "node",
        "--loader",
        str(tsx_loader),           # absolut loader, inte bara 'tsx'
            str(script_path),
            str(main_tsx),
            str(import_name),
            str(import_path),
            str(jsx_file_path),
        ]
        rc, out, err = _run(cmd, cwd=repo_root)
        if rc != 0:
            raise HTTPException(500, f"AST-injektion misslyckades:\n{err or out}")
    finally:
        try:
            os.unlink(jsx_file_path)
        except Exception:
            pass


# ─────────────────────────────────────────────────────────
# Typecheck/lint/visual
# ─────────────────────────────────────────────────────────


def _typecheck_and_lint(repo_root: Path) -> None:
    """Kör pnpm typecheck + lint:fix om scripts finns. Typecheck är hård, lint mjuk."""
    base = repo_root
    if not (base / "package.json").exists() and (repo_root / "frontendplay" / "package.json").exists():
        base = repo_root / "frontendplay"

    # typecheck
    if _has_script(repo_root, "typecheck"):
        rc, out, err = _run(["pnpm", "-s", "typecheck"], cwd=base)
        if rc != 0:
            raise HTTPException(500, f"Typecheck misslyckades:\n{err or out}")
    else:
        logger.info("Hoppar över typecheck (script saknas).")

    # lint fix
    if _has_script(repo_root, "lint:fix"):
        rc, out, err = _run(["pnpm", "-s", "lint:fix"], cwd=base)
        if rc != 0:
            logger.warning("lint:fix returnerade felkod: %s\n%s", rc, err or out)
    else:
        logger.info("Hoppar över lint:fix (script saknas).")


def _visual_validate(repo_root: Path) -> Dict[str, Any] | None:
    """
    (Valfri) visuell validering via Playwright. Kör endast om script finns och env tillåter.
    Returnerar sammanfattning eller None.
    """
    if not ENABLE_VISUAL_VALIDATE:
        return None

    base = repo_root
    if not (base / "package.json").exists() and (repo_root / "frontendplay" / "package.json").exists():
        base = repo_root / "frontendplay"

    if not _has_script(repo_root, "test:visual"):
        logger.info("Hoppar över visuell validering (test:visual saknas).")
        return None

    logger.info("Kör visuell validering …")
    rc, out, err = _run(["pnpm", "-s", "test:visual", "--reporter=line"], cwd=base)
    if rc != 0:
        # Returnera detaljer som del av felet
        raise HTTPException(500, f"Visuell validering misslyckades:\n{err or out}")

    # Om testerna i sig producerar metriker kan de läsas här (ex. från en JSON-artifact).
    return {"status": "ok"}


# ─────────────────────────────────────────────────────────
# Modellsvaret: validering och normalisering
# ─────────────────────────────────────────────────────────


_TRIPLE_BACKTICKS = re.compile(r"```")


def _normalize_target_for_file_mode(target_rel: str, import_name: str | None = None) -> str:
    """För nya filer: tvinga in i TARGET_COMPONENT_DIR och använd ett säkert filnamn."""
    name = "GeneratedComponent.tsx"
    try:
        n = Path(target_rel).name
        if n:
            name = n
    except Exception:
        pass

    # Valfri snyggning: om import_name finns, skapa PascalCase.tsx
    if import_name and not name.lower().endswith((".tsx", ".ts", ".jsx", ".js", ".css")):
        name = f"{import_name}.tsx"

    return (Path(TARGET_COMPONENT_DIR) / name).as_posix()


def _validate_and_sanitize_model_output(out: Dict[str, Any]) -> Dict[str, Any]:
    mode = out.get("mode")
    if mode not in ("file", "patch"):
        raise HTTPException(500, f"Okänt mode: {mode}")

    # Förbjud markdown fences i kod/diff
    for key in ("file_code", "unified_diff", "mount"):
        v = out.get(key)
        if isinstance(v, str) and _TRIPLE_BACKTICKS.search(v):
            raise HTTPException(500, f"Ogiltigt innehåll i '{key}': innehåller ```")

    # Mount-fält
    mount = out.get("mount") or {}
    for req in ("anchor", "import_name", "import_path", "jsx"):
        if not mount.get(req):
            raise HTTPException(500, f"Mount saknar '{req}'")
    # Spärra farliga paths
    imp: str = str(mount["import_path"])
    if imp.startswith("/") or ".." in imp:
        raise HTTPException(400, "import_path är ogiltig (absolut path eller '..').")

    return out


def _write_assets_if_any(repo_root: Path, out: Dict[str, Any]) -> List[str]:
    """
    Skriv ev. assets som modellen bifogat: [{path, b64}]
    Returnerar lista över relativa paths som skapats.
    """
    created: List[str] = []
    assets = out.get("assets") or []
    if not isinstance(assets, list):
        return created

    for a in assets:
        try:
            rel = str(a.get("path", "")).replace("\\", "/")
            b64 = str(a.get("b64", ""))
            if not rel or not b64:
                continue
            if rel.startswith("/") or ".." in rel:
                raise HTTPException(400, f"Otillåten asset-sökväg: {rel}")
            # Skriv
            p = _safe_join(repo_root, rel)
            p.parent.mkdir(parents=True, exist_ok=True)
            data = base64.b64decode(b64)
            p.write_bytes(data)
            created.append(rel)
        except Exception as e:
            raise HTTPException(500, f"Kunde inte skriva asset '{a}': {e}")
    return created


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
      "changes": [{"path": "<rel>", "content": "<utf8>"}, ...],
      "path": "<bakåtkompatibel enkel-path>",
      "content": "<bakåtkompatibelt innehåll>",
      "diff_summary": {...}  # valfri
    }
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

    # 3) pnpm install vid behov
    _ensure_node_modules(tmp_root)

    # 4) Skanna komponenter (för översikt till modellen)
    components = list_components(str(tmp_root))
    logger.info("Hittade %d komponent(er).", len(components))

    # 5) OpenAI: strikt JSON enligt schema
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
        temperature=0,
        top_p=1,
    )

    raw = resp.choices[0].message.content or "{}"
    try:
        out = json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"Modellen returnerade ogiltig JSON: {e}")

    # 6) Validera och normalisera modelsvaret
    out = _validate_and_sanitize_model_output(out)

    mode = out.get("mode")
    target_rel = cast(str, out.get("target_path") or "")
    mount = out.get("mount") or {}
    file_code = out.get("file_code") or ""
    unified_diff = out.get("unified_diff") or ""

    if not mode or not target_rel:
        raise HTTPException(500, "Saknar 'mode' eller 'target_path' i modelsvaret.")

    # 7) Git branch
    branch = unique_branch(node_id)
    repo.git.checkout("-b", branch)

    # 8) Tillämpa ändring
    changes: List[Dict[str, str]] = []
    returned_primary_path: str

    if mode == "file":
        # Normalisera target till komponentkatalogen
        target_rel = _normalize_target_for_file_mode(target_rel, mount.get("import_name"))
        target_path = _safe_join(tmp_root, target_rel)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if not isinstance(file_code, str) or not file_code.strip():
            raise HTTPException(500, "file_code saknas för mode='file'.")
        target_path.write_text(file_code, encoding="utf-8")
        returned_primary_path = target_rel

        # Ev. assets från modellen
        created_assets = _write_assets_if_any(tmp_root, out)
        logger.info("Skrev %d asset(s).", len(created_assets))

    elif mode == "patch":
        norm = target_rel.replace("\\", "/")
        if norm not in ALLOW_PATCH:
            raise HTTPException(400, f"Patch ej tillåten för {norm}. Tillåtna: {ALLOW_PATCH}")

        if norm.endswith("main.tsx"):
            logger.info("Ignorerar diff mot main.tsx; använder AST-injektion för montering.")
            returned_primary_path = norm  # vi kommer läsa ut denna efter AST-steg
        else:
            if not unified_diff or not isinstance(unified_diff, str):
                raise HTTPException(500, "unified_diff saknas för mode='patch'.")
            _git_apply(tmp_root, unified_diff)
            returned_primary_path = norm
    else:
        raise HTTPException(500, f"Okänt mode: {mode}")

    # 9) AST-injektion för mount (alltid)
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
        # Låt felet bubbla upp (blockerande)
        raise
    except Exception as e:
        logger.warning("Visuell validering kastade oväntat undantag: %s", e)

    # 12) Git add + commit (stage alla ändringar)
    repo.git.add("--all")
    commit_msg = (
        f"feat(ai): add {returned_primary_path}" if mode == "file" else f"chore(ai): patch {returned_primary_path}"
    )
    repo.index.commit(commit_msg)
    logger.info("Commit klar: %s", commit_msg)

    # 13) Läs ut ALLA relevanta filer att returnera till extension
    changed_paths: List[str] = []

    # a) primärfilen
    changed_paths.append(returned_primary_path)

    # b) main.tsx om ändrad eller om mount alltid påverkar den
    main_candidates = [p for p in ALLOW_PATCH if p.endswith("main.tsx")]
    main_rel = main_candidates[0] if main_candidates else "frontendplay/src/main.tsx"
    main_path = _safe_join(tmp_root, main_rel)
    if main_path.exists():
        changed_paths.append(main_rel)

    # c) ev. komponentfil vid patch av annan fil? (om modellen patchade en komponent och mount pekar dit)
    if mode == "patch" and returned_primary_path != main_rel and returned_primary_path not in changed_paths:
        changed_paths.append(returned_primary_path)

    # d) ev. assets som skrevs
    assets = out.get("assets") or []
    for a in assets if isinstance(assets, list) else []:
        rel = str(a.get("path", "")).replace("\\", "/")
        if rel:
            changed_paths.append(rel)

    # Deduplicera och läs
    uniq_paths = []
    seen = set()
    for p in changed_paths:
        if p not in seen:
            uniq_paths.append(p)
            seen.add(p)

    for rel in uniq_paths:
        try:
            changes.append(_read_rel(tmp_root, rel))
        except HTTPException:
            # Om någon asset/fil inte finns, hoppa över tyst (kan ha filtrerats)
            logger.warning("Kunde inte läsa ut '%s' – hoppar över i changes.", rel)

    if not changes:
        # Sista försvar: returnera i alla fall primärfilen
        changes.append(_read_rel(tmp_root, returned_primary_path))

    # Bakåtkompatibelt fält (path/content) för äldre extension
    primary = next((c for c in changes if c["path"] == returned_primary_path), changes[0])

    logger.info("Code changes ready for direct apply: %s fil(er).", len(changes))
    result: Dict[str, Any] = {
        "status": "SUCCESS",
        "changes": changes,
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
