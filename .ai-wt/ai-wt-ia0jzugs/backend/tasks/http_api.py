# backend/tasks/http_api.py
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from celery import current_app as celery_app
from celery.result import AsyncResult


# ─────────────────────────────────────────────────────────
# FastAPI-app + CORS
# ─────────────────────────────────────────────────────────
app = FastAPI(title="AI Figma Codegen Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # VS Code-webview kör som egen origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────
# Request-modeller (Pydantic) — inkommande data valideras
# ─────────────────────────────────────────────────────────
class StreamedFile(BaseModel):
    path: str
    content_b64: str


class AnalyzeManifest(BaseModel):
    # Håll typerna lite breda för kompatibilitet; analyze-tasken gör djupkollen.
    mode: str  # "local_paths" | "streamed_files"
    root_path: str | None = None
    include: list[str] | None = None
    exclude: list[str] | None = None
    files: list[StreamedFile] | None = None
    max_files: int | None = 2000
    max_file_bytes: int | None = 300_000
    ignored_dirs: list[str] | None = None
    profile: str | None = None  # "fast" | "full"


# ─────────────────────────────────────────────────────────
# Svarsmodeller (enkla strängtyper för att undvika Pylance-brus)
# ─────────────────────────────────────────────────────────
class AnalyzeStart(BaseModel):
    task_id: str
    poll_url: str | None = None


class AnalyzeStatus(BaseModel):
    status: str  # "PENDING" | "STARTED" | "RETRY" | "SUCCESS" | "FAILURE"
    project_model: dict[str, Any] | None = None
    error: str | None = None


# ─────────────────────────────────────────────────────────
# Hjälp
# ─────────────────────────────────────────────────────────
def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


# ─────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────
@app.post("/analyze", response_model=AnalyzeStart)
def start_analyze(manifest: AnalyzeManifest) -> dict[str, Any]:
    """
    Starta analysen som Celery-task via task-namnet.
    Vi importerar *inte* analyze_project-symbolen alls — ingen risk för skuggning.
    """
    payload = _drop_none(manifest.model_dump(exclude_none=True))

    # Viktigt: Namnet MÅSTE matcha @shared_task(name=...) i analyze.py
    task_name = "backend.tasks.analyze.analyze_project"

    # Skickar uppdraget till worker
    async_result: AsyncResult = celery_app.send_task(task_name, args=[payload]) # type: ignore
    return {"task_id": async_result.id, "poll_url": f"/analyze/{async_result.id}"}


@app.get("/analyze/{task_id}", response_model=AnalyzeStatus)
def get_analyze_status(task_id: str) -> dict[str, Any]:
    res = AsyncResult(task_id)
    state = (res.state or "PENDING").upper()

    if state in ("PENDING", "STARTED", "RETRY"):
        return {"status": state}

    if state == "SUCCESS":
        # analyze_project returnerar {"project_model": ...} eller direkt modellen
        raw = res.result or {}
        project_model: dict[str, Any] | None = None
        if isinstance(raw, dict) and "project_model" in raw:
            project_model = raw.get("project_model")  # type: ignore[assignment]
        elif isinstance(raw, dict):
            project_model = raw
        return {"status": "SUCCESS", "project_model": project_model}

    if state == "FAILURE":
        err = str(getattr(res, "info", "Unknown error"))
        return {"status": "FAILURE", "error": err}

    # Fallback om Celery ger något annat state
    return {"status": state}


# ─────────────────────────────────────────────────────────
# Hjälpendpoint
# ─────────────────────────────────────────────────────────
@app.get("/health", include_in_schema=False)
def health() -> dict[str, str]:
    return {"status": "ok"}


# Lokalt dev-körläge:
#   uvicorn backend.tasks.http_api:app --host 127.0.0.1 --port 8000 --reload
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.tasks.http_api:app", host="127.0.0.1", port=8000, reload=True)
