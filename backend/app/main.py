from __future__ import annotations

"""
AI-driven PR-bot – FastAPI gateway

Tar emot Figma-payload, startar Celery-tasken *integrate_figma_node*
och exponerar en polling-endpoint som lämnar tillbaka PR-URL när arbetet är klart.
"""

# ── Standard- & tredjepartsbibliotek ───────────────────────────────────────
import logging
import os
from pathlib import Path
from typing import TypedDict, Optional, Dict, Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# ── Ladda .env TIDIGT (innan imports som läser miljövariabler) ────────────
BACKEND_DIR = Path(__file__).resolve().parents[1]   # .../backend
ENV_PATH = BACKEND_DIR / ".env"
load_dotenv(ENV_PATH, override=True)

GH_TOKEN: Optional[str] = os.getenv("GH_TOKEN")
FIGMA_TOKEN: Optional[str] = os.getenv("FIGMA_TOKEN")
TARGET_REPO: Optional[str] = os.getenv("TARGET_REPO")  # t.ex. "myorg/myrepo"

if not all([GH_TOKEN, FIGMA_TOKEN, TARGET_REPO]):
    raise RuntimeError(
        f"Saknade env-variabler. Förväntade i {ENV_PATH} minst GH_TOKEN, FIGMA_TOKEN, TARGET_REPO."
    )

# ── Nu är env laddad; importera saker som kräver den ──────────────────────
from ..tasks.codegen import integrate_figma_node  # noqa: E402

# Valfri Analyze-router (om backend/app/analyze.py exponerar `router`)
analyze_router = None
try:
    from .analyze import router as _analyze_router  # type: ignore  # noqa: E402
    analyze_router = _analyze_router
except Exception as e:  # pragma: no cover
    logging.getLogger(__name__).warning("Analyze-router kunde inte importeras: %s", e)

# ── Logging ───────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-pr-bot")

# ── FastAPI-instans + CORS ────────────────────────────────────────────────
app = FastAPI(title="AI PR-bot")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # begränsa vid behov i prod
    allow_methods=["*"],
    allow_headers=["*"],
)

# Inkludera Analyze-routern om den fanns
if analyze_router:
    app.include_router(analyze_router, prefix="/analyze", tags=["analyze"])
else:
    logger.info("Startar utan analyze-router (backend/app/analyze.py med `router` saknas eller kunde inte importeras).")

# ── Typ-hjälp ─────────────────────────────────────────────────────────────
class Payload(TypedDict):
    fileKey: str
    nodeId: str

# ── Healthcheck ───────────────────────────────────────────────────────────
@app.get("/healthz")
async def healthz() -> Dict[str, str]:
    return {"status": "ok"}

# ── POST /figma-hook ──────────────────────────────────────────────────────
@app.post("/figma-hook")
async def figma_hook(payload: Payload) -> Dict[str, Any]:
    """
    Initierar Celery-jobbet *integrate_figma_node* och returnerar task-ID
    som frontend kan polla via /task/{id}.
    """
    file_key = payload.get("fileKey")
    node_id = payload.get("nodeId")
    if not (file_key and node_id):
        raise HTTPException(400, "Både fileKey och nodeId krävs")

    task = integrate_figma_node.delay(file_key=file_key, node_id=node_id)
    return {"task_id": task.id}

# ── GET /task/{task_id} ───────────────────────────────────────────────────
@app.get("/task/{task_id}")
async def task_status(task_id: str) -> Dict[str, Any]:
    """
    Returnerar Celery-status (PENDING, STARTED, SUCCESS, FAILURE …) och,
    vid SUCCESS, PR-URL från task-resultatet.
    """
    result = integrate_figma_node.AsyncResult(task_id)
    status: str = result.state

    response: Dict[str, Any] = {"status": status}

    if status == "SUCCESS":
        if isinstance(result.result, dict):
            pr_url = result.result.get("pr_url")
            if pr_url:
                response["pr_url"] = pr_url
    elif status == "FAILURE":
        response["error"] = str(result.result)

    return response
