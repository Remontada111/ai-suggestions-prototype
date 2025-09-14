# backend/tasks/codegen.py
from __future__ import annotations

"""
Celery-worker: Figma-node ➜ kodpatch eller ny fil ➜ Pull Request

Flöde:
1) Hämtar Figma-node (REST)
2) Skannar repo för befintliga komponenter
3) Bygger prompt och ber OpenAI om patch eller ny fil
4) Applicerar ändringar, commit → push → Pull Request
"""

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, Tuple, cast

# Ladda .env tidigt så alla imports får rätt miljö
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=True)

import requests
from fastapi import HTTPException
from celery import Celery

# OpenAI – håll samma API-stil som i projektet i övrigt
import openai  # type: ignore

from .patcher import apply_patch
from .utils import clone_repo, create_pr, list_components, unique_branch

# ─────────────────────────────────────────────────────────
# Miljö & konfiguration
# ─────────────────────────────────────────────────────────

# Broker/Result kan sättas via .env / docker-compose
BROKER_URL = (os.getenv("CELERY_BROKER_URL") or "redis://redis:6379/0").strip()
RESULT_BACKEND = (os.getenv("CELERY_RESULT_BACKEND") or BROKER_URL).strip()

# OpenAI
openai.api_key = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

# Genereringsmål i repo:t
TARGET_COMPONENT_DIR = os.getenv("TARGET_COMPONENT_DIR", "frontendplay/src/components/ai")
# Enda filen vi tillåter patch av (monteringspunkt)
ALLOW_PATCH = [
    p.strip().replace("\\", "/")
    for p in (os.getenv("ALLOW_PATCH", "frontendplay/src/main.tsx").split(";"))
    if p.strip()
]

# Figma
FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
if not FIGMA_TOKEN:
    raise RuntimeError("FIGMA_TOKEN saknas i miljön (.env) – krävs för att hämta Figma-data.")

# ─────────────────────────────────────────────────────────
# Celery-app (fail-fast vid broker-problem)
# ─────────────────────────────────────────────────────────

app = Celery("codegen", broker=BROKER_URL, backend=RESULT_BACKEND)
# Härda så att anslutningsfel yttrar sig direkt (inte 60 s häng)
app.conf.broker_connection_retry_on_startup = False
app.conf.broker_connection_timeout = 3
# Om Redis används är det bra att sätta socket-timeout lågt
app.conf.redis_socket_timeout = 3

# Exportera en tydlig alias som andra moduler importerar
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


def _build_prompt(figma_json: dict, comp_map: dict[str, Path], placement: dict | None) -> str:
    """Bygger system-prompt till OpenAI."""
    try:
        overview = (
            "\n".join(f"- {name}: {path.relative_to(Path.cwd())}" for name, path in comp_map.items())
            or "Inga komponenter hittades."
        )
    except Exception:
        # Om repo körs i tmp-dir utan relation till cwd, fall tillbaka till absoluta vägar
        overview = "\n".join(f"- {name}: {path}" for name, path in comp_map.items()) or "Inga komponenter hittades."

    # Trunka för kompakthet
    fig_excerpt = json.dumps(figma_json, ensure_ascii=False)[:4000]
    placement_excerpt = json.dumps(placement or {}, ensure_ascii=False)[:2000]

    return (
        "Du är en senior frontend-utvecklare.\n\n"
        "Projektöversikt – befintliga komponenter:\n"
        f"{overview}\n\n"
        "Instruktion:\n"
        "• Om en passande komponent redan finns → returnera en unified diff (patch).\n"
        "• Annars → returnera första raden som filnamn följt av hela filens innehåll.\n\n"
        "Krav:\n"
        f"• Nya filer får endast skapas under '{TARGET_COMPONENT_DIR}'.\n"
        "• Patch är ENDAST tillåten på 'frontendplay/src/main.tsx' för att montera komponenten vid kommentaren 'AI-INJECT-MOUNT'.\n"
        "• Använd React 18/19, Vite-miljö, inga Next-specifika APIs.\n"
        "• Minimera ändringar och följ projektets stil.\n\n"
        "Placering från webview (normaliserad till 1280×800):\n"
        f"{placement_excerpt}\n\n"
        "Figma-JSON (trunkerad):\n"
        f"{fig_excerpt}\n"
    )


def _parse_gpt_reply(reply: str) -> Tuple[str, str, str]:
    """
    Tolkar OpenAI-svaret → ('patch'|'file', target_path, payload).
    Accepterar fenced code blocks och raw diff.
    """
    text = reply.strip()

    # Ta bort code fences om de finns
    if text.startswith("```"):
        text = text.strip("`")
        first_nl = text.find("\n")
        if first_nl != -1:
            head = text[:first_nl].strip().lower()
            if head.startswith(("diff", "patch")):
                text = text[first_nl + 1 :].strip()

    # Unified diff?
    if text.startswith("--- ") or text.startswith("diff"):
        lines = text.splitlines()
        header = next((l for l in lines if l.startswith("--- ")), None)
        if not header:
            raise ValueError("Diff ser inte komplett ut (saknar '--- ' header).")
        filename = header.split(" ", 1)[1].lstrip("ab/").strip()
        if not filename:
            raise ValueError("Kunde inte extrahera målfil från diff-header.")
        return "patch", filename, text

    # Annars: anta "ny fil"-format
    first_line, *code = text.splitlines()
    if not first_line.endswith((".tsx", ".ts", ".jsx", ".js", ".css")):
        raise ValueError("Ogiltigt filnamn på första raden – förväntade *.tsx|*.ts|*.jsx|*.js|*.css.")
    target = first_line.strip()
    payload = "\n".join(code)
    return "file", target, payload


# ─────────────────────────────────────────────────────────
# Celery-task
# ─────────────────────────────────────────────────────────

@app.task(name="backend.tasks.codegen.integrate_figma_node")
def integrate_figma_node(*, file_key: str, node_id: str, placement: Dict[str, Any] | None = None) -> Dict[str, str]:
    """
    Asynkron pipeline: hämtar Figma-node, genererar/patchar kod och öppnar PR.

    Returnerar: {"pr_url": "<https://github.com/...>"} för polling-endpointen.
    """
    logger.info("Integrationsstart: file_key=%s node_id=%s", file_key, node_id)

    # 1) Hämta Figma-data
    figma_json = _fetch_figma_node(file_key, node_id)
    logger.info("Figma-data hämtad.")

    # 2) Klona repo till temp
    tmp_dir, repo = clone_repo()
    logger.info("Repo klonat till %s", tmp_dir)

    try:
        # 3) Skanna komponenter
        components = list_components(tmp_dir)
        logger.info("Hittade %d komponent(er).", len(components))

        # 4) Bygg prompt och kalla OpenAI
        prompt = _build_prompt(figma_json, components, placement)
        logger.info("Skickar prompt till OpenAI (%s) …", OPENAI_MODEL)

        completion = openai.chat.completions.create(  # type: ignore[attr-defined]
            model=OPENAI_MODEL,
            messages=[{"role": "system", "content": prompt}],
            temperature=0.2,
        )
        raw_reply = completion.choices[0].message.content
        if raw_reply is None:
            raise HTTPException(500, "OpenAI returnerade tomt innehåll.")
        gpt_reply = cast(str, raw_reply)

        mode, target_rel, payload = _parse_gpt_reply(gpt_reply)
        logger.info("OpenAI-svar parsat: mode=%s target=%s", mode, target_rel)

        # 5) Normalisera målväg / säkerhetsregler
        if mode == "file":
            # Tvinga ny fil in i komponentkatalog
            try:
                suggested = Path(target_rel)
                target_rel = (Path(TARGET_COMPONENT_DIR) / suggested.name).as_posix()
            except Exception:
                target_rel = (Path(TARGET_COMPONENT_DIR) / "GeneratedComponent.tsx").as_posix()
        elif mode == "patch":
            norm = target_rel.replace("\\", "/")
            if norm not in ALLOW_PATCH:
                raise HTTPException(400, f"Patch ej tillåten för {norm}. Tillåtna: {ALLOW_PATCH}")

        # 6) Git-gren
        branch = unique_branch(node_id)
        repo.git.checkout("-b", branch)

        target_path = Path(tmp_dir, target_rel)
        target_path.parent.mkdir(parents=True, exist_ok=True)

        # 7) Applicera ändring
        if mode == "patch":
            if not target_path.exists():
                raise HTTPException(500, f"Patchfilen {target_rel} finns inte i repo:t.")
            apply_patch(target_path, payload)
            commit_msg = f"chore(ai): patch {target_rel}"
        else:
            target_path.write_text(payload, encoding="utf-8")
            commit_msg = f"feat(ai): add {target_rel}"

        repo.git.add(target_path.as_posix())
        repo.index.commit(commit_msg)
        logger.info("Commit klar: %s", commit_msg)

        # 8) Skapa PR
        pr_url = create_pr(
            repo,
            branch=branch,
            title=commit_msg,
            body=f"Automatisk integration för Figma-node {node_id}",
        )
        logger.info("Pull Request skapad: %s", pr_url)

        # 9) Klart – returnera för polling-endpointen
        return {"pr_url": pr_url}

    finally:
        # Alltid städa temp
        shutil.rmtree(tmp_dir, ignore_errors=True)
        logger.info("Städade tempkatalog: %s", tmp_dir)


# Se till att analysetasken registreras när workern startar
try:
    from . import analyze as _register_analyze  # noqa: F401
except Exception as e:  # pragma: no cover
    logging.getLogger(__name__).warning("Kunde inte importera analyze-tasks: %s", e)

__all__ = ["app", "celery_app", "integrate_figma_node"]
