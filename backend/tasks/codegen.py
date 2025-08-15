"""Celery-worker: Figma-node ➜ kodpatch eller ny fil ➜ Pull Request

1. Klonar mål-repo (utils.clone_repo)
2. Skannar befintliga komponenter (utils.list_components)
3. Bygger prompt och ber GPT-4o om PATCH eller ny fil
4. Applicerar ändring, commit → push → Pull Request
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, Tuple, cast

import openai
import requests
from celery import Celery
from fastapi import HTTPException

from .patcher import apply_patch
from .utils import clone_repo, create_pr, list_components, unique_branch

# ── Miljö & Celery-konfiguration ──────────────────────────────────────────
BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", BROKER_URL)
openai.api_key = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
if not FIGMA_TOKEN:
    raise RuntimeError("FIGMA_TOKEN saknas i .env – krävs för att hämta design-data.")

app = Celery("codegen", broker=BROKER_URL, backend=RESULT_BACKEND)

# ✅ Exportera en tydligt typad alias som andra moduler kan importera
celery_app: Celery = app

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# ── Hjälpfunktioner ───────────────────────────────────────────────────────
def _fetch_figma_node(file_key: str, node_id: str) -> Dict[str, Any]:
    """Hämtar Figma-JSON för angiven node."""
    url = f"https://api.figma.com/v1/files/{file_key}/nodes?ids={node_id}"
    headers = {"X-Figma-Token": FIGMA_TOKEN}
    resp = requests.get(url, headers=headers, timeout=20)
    if resp.status_code != 200:
        raise HTTPException(
            502, f"Figma-API-fel ({resp.status_code}): {resp.text}"
        )
    return resp.json()


def _build_prompt(figma_json: dict, comp_map: dict[str, Path]) -> str:
    """Konstruerar system-prompten till GPT-4o."""
    overview = (
        "\n".join(f"- {name}: {path.relative_to(Path.cwd())}" for name, path in comp_map.items())
        or "Inga komponenter hittades."
    )
    fig_excerpt = json.dumps(figma_json)[:4000]

    return f"""Du är en senior fullstack-utvecklare.

Detta Next.js-projekt innehåller följande komponenter:
{overview}

Instruktion:
• Om en passande komponent redan finns → returnera en unified diff (patch).
• Annars → returnera första raden som filnamn följt av hela filens innehåll.

Krav: React 19, shadcn/ui, Tailwind 4 syntax. Minimera ändringar – följ projektets stil.

Figma-JSON (trunkerad):
{fig_excerpt}"""


def _parse_gpt_reply(reply: str) -> Tuple[str, str, str]:
    """
    Tolkar GPT-svaret → ('patch'|'file', target_path, payload).
    """
    text = reply.strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("patch").strip()

    if text.startswith("--- ") or text.startswith("diff"):
        # unified diff
        lines = text.splitlines()
        header = next(l for l in lines if l.startswith("--- "))
        filename = header.split(" ", 1)[1].lstrip("ab/")
        return "patch", filename, text

    first_line, *code = text.splitlines()
    if not first_line.endswith((".tsx", ".ts", ".jsx", ".js", ".css")):
        raise ValueError("Ogiltigt filnamn på första raden.")
    return "file", first_line, "\n".join(code)


# ── Celery-tasken ─────────────────────────────────────────────────────────
@app.task(name="integrate_figma_node")
def integrate_figma_node(*, file_key: str, node_id: str) -> Dict[str, str]:
    """
    Asynkron pipeline: hämtar Figma-node, genererar/patchar kod och öppnar PR.

    Returnerar: {"pr_url": "<https://github.com/...>"} för polling-endpointen.
    """
    # 1. Hämta Figma-JSON
    figma_json = _fetch_figma_node(file_key, node_id)
    logger.info("Figma-data hämtad (file=%s, node=%s)", file_key, node_id)

    # 2. Klona repo
    tmp_dir, repo = clone_repo()

    try:
        # 3. Lista befintliga komponenter
        components = list_components(tmp_dir)
        logger.info("Hittade %d komponenter", len(components))

        # 4. Bygg prompt och anropa GPT-4o
        prompt = _build_prompt(figma_json, components)

        logger.info("Skickar prompt till GPT-4o …")
        completion = openai.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[{"role": "system", "content": prompt}],
            temperature=0.2,
        )

        raw_reply = completion.choices[0].message.content
        if raw_reply is None:
            raise HTTPException(500, "GPT-4o returnerade tomt innehåll")

        gpt_reply = cast(str, raw_reply)
        mode, target_rel, payload = _parse_gpt_reply(gpt_reply)

        # 5. Förbered Git-gren
        branch = unique_branch(node_id)
        repo.git.checkout("-b", branch)

        target_path = Path(tmp_dir, target_rel)
        target_path.parent.mkdir(parents=True, exist_ok=True)

        if mode == "patch":
            if not target_path.exists():
                raise HTTPException(
                    500, f"Patchfilen {target_rel} finns inte i repo:t."
                )
            apply_patch(target_path, payload)
            commit_msg = f"chore(ai): patch {target_rel}"
        else:  # 'file'
            target_path.write_text(payload, encoding="utf-8")
            commit_msg = f"feat(ai): add {target_rel}"

        repo.git.add(target_path.as_posix())
        repo.index.commit(commit_msg)

        # 6. Skapa PR
        pr_url = create_pr(
            repo,
            branch=branch,
            title=commit_msg,
            body=f"Automatisk integration för Figma-node {node_id}",
        )
        logger.info("Pull Request skapad: %s", pr_url)

        # 7. Returnera resultat som dict (viktigt för polling-endpointen)
        return {"pr_url": pr_url}

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


__all__ = ["app", "celery_app", "integrate_figma_node"]
