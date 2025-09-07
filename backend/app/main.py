# backend/app/main.py
from __future__ import annotations

"""
FastAPI-gateway för AI-botten + Figma-proxy.

Kör:
    uvicorn backend.app.main:app --reload
"""

import logging
import os
from pathlib import Path
from typing import TypedDict, Optional, Dict, Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

# ── Ladda .env TIDIGT ─────────────────────────────────────────────────────
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

# ── Importer som kräver att paketstrukturen stämmer ───────────────────────
# Viktigt: kör Uvicorn som: uvicorn backend.app.main:app --reload
from backend.tasks.codegen import integrate_figma_node  # noqa: E402

# Figma-proxy (sRGB). Återanvänd handler-funktionen som route.
from backend.tasks.figma_proxy import figma_image as figma_image_handler  # noqa: E402

# Analyzer-router (måste finnas som backend/app/analyze.py med "router")
try:
  from .analyze import router as analyze_router  # noqa: E402
except Exception as e:
  raise RuntimeError(
    "Kunde inte importera analyze-routern från backend.app.analyze.\n"
    "Kontrollera att 'backend/__init__.py' och 'backend/app/__init__.py' finns (kan vara tomma)\n"
    "och att backend/app/analyze.py exponerar 'router'."
  ) from e

# ── Logging ───────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ai-pr-bot")

# ── FastAPI + CORS ────────────────────────────────────────────────────────
app = FastAPI(title="AI PR-bot")
app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],      # begränsa i prod
  allow_methods=["*"],
  allow_headers=["*"],
)

# Inkludera analyzern (routern definierar sina paths)
app.include_router(analyze_router)

# Registrera Figma-proxy-endpointen så URL blir /api/figma-image
app.add_api_route("/api/figma-image", figma_image_handler, methods=["GET", "HEAD"], name="figma_image")

# Preflight (CORS-mellanvaran svarar också, men detta gör 204 utan kropp)
@app.options("/api/figma-image")
def _figma_image_options() -> Response:
  return Response(status_code=204)

# ── Typer ─────────────────────────────────────────────────────────────────
class Payload(TypedDict, total=False):
  fileKey: str
  nodeId: str
  placement: Dict[str, Any]

# ── Healthcheck ───────────────────────────────────────────────────────────
@app.get("/healthz")
async def healthz() -> Dict[str, str]:
  return {"status": "ok"}

# ── POST /figma-hook ──────────────────────────────────────────────────────
# Tar nu även emot "placement" från webview för bättre kontext i jobbet.
@app.post("/figma-hook")
async def figma_hook(payload: Payload) -> Dict[str, Any]:
  file_key = payload.get("fileKey")
  node_id = payload.get("nodeId")
  if not (file_key and node_id):
    raise HTTPException(400, "Både fileKey och nodeId krävs")

  placement = payload.get("placement")  # kan vara None
  # integrate_figma_node förväntas acceptera placement=...
  task = integrate_figma_node.delay(file_key=file_key, node_id=node_id, placement=placement)
  return {"task_id": task.id}

# ── GET /task/{task_id} ───────────────────────────────────────────────────
@app.get("/task/{task_id}")
async def task_status(task_id: str) -> Dict[str, Any]:
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

# ── Logga alla rutter vid uppstart (hjälper felsöka 404) ──────────────────
@app.on_event("startup")
async def _log_routes() -> None:  # pragma: no cover
  try:
    lines = []
    for r in app.router.routes:
      methods = ",".join(sorted(getattr(r, "methods", []) or []))
      path = getattr(r, "path", "")
      name = getattr(r, "name", "")
      lines.append(f"{methods:15s} {path:40s} → {name}")
    logger.info("Registrerade rutter:\n" + "\n".join(lines))
  except Exception as e:
    logger.warning("Kunde inte lista rutter: %s", e)
