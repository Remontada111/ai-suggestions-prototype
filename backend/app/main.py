"""AI-driven PR-bot – FastAPI gateway

Tar emot Figma-payload, startar Celery-tasken *integrate_figma_node*
och exponerar en polling-endpoint som lämnar tillbaka PR-URL när arbetet är klart.
"""

from __future__ import annotations

# ── Standard- & tredjepartsbibliotek ───────────────────────────────────────
import os
from typing import TypedDict

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Celery-task
from backend.tasks.codegen import integrate_figma_node

# [NY] Analyze-router (Steg 2 – Analys)
from backend.app.routes import analyze

# ── Ladda miljövariabler ──────────────────────────────────────────────────
load_dotenv(".env", override=True)

GH_TOKEN: str | None = os.getenv("GH_TOKEN")
FIGMA_TOKEN: str | None = os.getenv("FIGMA_TOKEN")
TARGET_REPO: str | None = os.getenv("TARGET_REPO")  # t.ex. "myorg/myrepo"

if not all([GH_TOKEN, FIGMA_TOKEN, TARGET_REPO]):
    raise RuntimeError("GH_TOKEN, FIGMA_TOKEN och TARGET_REPO måste finnas i .env")

# ── FastAPI-instans + CORS ────────────────────────────────────────────────
app = FastAPI(title="AI PR-bot")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # begränsa vid behov i prod
    allow_methods=["*"],
    allow_headers=["*"],
)

# [NY] Inkludera Analyze-routern
app.include_router(analyze.router)

# ── Typ-hjälp ─────────────────────────────────────────────────────────────
class Payload(TypedDict):
    fileKey: str
    nodeId: str


# ── POST /figma-hook ──────────────────────────────────────────────────────
@app.post("/figma-hook")
async def figma_hook(payload: Payload):
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
async def task_status(task_id: str):
    """
    Returnerar Celery-status (PENDING, STARTED, SUCCESS, FAILURE …) och,
    vid SUCCESS, PR-URL från task-resultatet.
    """
    result = integrate_figma_node.AsyncResult(task_id)
    status: str = result.state

    response: dict[str, str] = {"status": status}

    if status == "SUCCESS":
        # Tasken förväntas returnera t.ex. {"pr_url": "..."}
        if isinstance(result.result, dict):
            pr_url = result.result.get("pr_url")
            if pr_url:
                response["pr_url"] = pr_url
    elif status == "FAILURE":
        # Skicka med felmeddelande för enklare felsökning i UI
        response["error"] = str(result.result)

    return response
