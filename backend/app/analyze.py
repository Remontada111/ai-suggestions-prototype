from __future__ import annotations

# backend/app/analyze.py

from typing import List, Literal, Optional, Dict, Any, cast

from pydantic import BaseModel, Field, model_validator
from fastapi import APIRouter, HTTPException, Request
from celery import Celery
from celery import current_app as celery_current_app
from celery.result import AsyncResult

# För att återanvända befintlig Celery-app utan att röra existerande filer:
# Försök importera en namngiven instans från pipeline, annars fall tillbaka till current_app.
try:
    from backend.tasks.codegen import celery_app as imported_celery_app  # typ: Celery
except Exception:  # pragma: no cover - defensiv fallback
    try:
        from backend.tasks.codegen import app as imported_celery_app  # typ: Celery
    except Exception:  # pragma: no cover
        imported_celery_app = celery_current_app  # sista utväg

# Hjälp Pylance förstå typen tydligt
celery_app: Celery = cast(Celery, imported_celery_app)

router = APIRouter(prefix="/analyze", tags=["analyze"])

# ==== Scheman ====

Mode = Literal["local_paths", "streamed_files"]

DEFAULT_IGNORED_DIRS = [
    "node_modules", "dist", "build", "out", ".next", ".svelte-kit", ".output",
    ".git", "coverage", ".venv", "venv", "__pycache__", "dist-webview",
]

class StreamedFile(BaseModel):
    path: str = Field(..., description="Relativ sökväg från projektroten")
    content_b64: str = Field(..., description="Bas64-kodat filinnehåll")

class AnalyzeManifest(BaseModel):
    mode: Mode
    root_path: Optional[str] = Field(None, description="Projektrot för local_paths")
    include: Optional[List[str]] = Field(default=None, description="Globmönster att inkludera")
    exclude: Optional[List[str]] = Field(default=None, description="Globmönster att exkludera")
    files: Optional[List[StreamedFile]] = None

    max_files: int = Field(default=2000, ge=1, le=20000)
    max_file_bytes: int = Field(default=300_000, ge=1000, le=5_000_000)

    ignored_dirs: List[str] = Field(default_factory=lambda: DEFAULT_IGNORED_DIRS.copy())

    @model_validator(mode="after")
    def _validate_mode_fields(self) -> "AnalyzeManifest":
        if self.mode == "local_paths" and not self.root_path:
            raise ValueError("root_path krävs för mode=local_paths")
        if self.mode == "streamed_files":
            if not self.files or len(self.files) == 0:
                raise ValueError("files krävs och får inte vara tom för mode=streamed_files")
        return self

class AnalyzeStartResponse(BaseModel):
    task_id: str
    # Fix B: backend returnerar en absolut poll-URL som extensionen kan använda direkt.
    poll_url: Optional[str] = None

class AnalyzeStatusResponse(BaseModel):
    status: str
    project_model: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

# ==== Endpoints ====

@router.post("", response_model=AnalyzeStartResponse)
def start_analysis(manifest: AnalyzeManifest, request: Request):
    """
    Startar asynkron projektanalys. Returnerar Celery task_id och absolut poll_url.
    """
    try:
        task = celery_app.send_task(
            "backend.tasks.analyze.analyze_project",
            args=[manifest.model_dump()]  # pydantic v2
        )
    except Exception as e:  # pragma: no cover - robust felhantering
        raise HTTPException(status_code=500, detail=f"Kunde inte queue:a analyze_task: {e}")

    # Bygg absolut URL till status-endpointen så frontend slipper gissa.
    poll_url = request.url_for("get_analysis", task_id=task.id)
    return AnalyzeStartResponse(task_id=task.id, poll_url=str(poll_url))

@router.get("/{task_id}", response_model=AnalyzeStatusResponse)
def get_analysis(task_id: str):
    """
    Hämtar status samt resultat (om klart).
    """
    try:
        res: AsyncResult = AsyncResult(task_id, app=celery_app)
    except Exception as e:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"Kunde inte läsa task-status: {e}")

    state = res.state
    if state == "PENDING":
        return AnalyzeStatusResponse(status="PENDING")
    if state in ("STARTED", "RETRY"):
        return AnalyzeStatusResponse(status=state)
    if state == "FAILURE":
        # res.result kan vara exception-objekt
        err_str = str(res.result) if res.result else "Okänt fel"
        return AnalyzeStatusResponse(status="FAILURE", error=err_str)
    if state == "SUCCESS":
        data = res.result or {}
        return AnalyzeStatusResponse(status="SUCCESS", project_model=data.get("project_model"))
    # Okända tillstånd
    return AnalyzeStatusResponse(status=state)
