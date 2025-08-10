from __future__ import annotations

# backend/app/routes/analyze.py
from typing import List, Literal, Optional, Dict, Any
from pydantic import BaseModel, Field, root_validator, validator
from fastapi import APIRouter, HTTPException
from celery.result import AsyncResult

# För att återanvända befintlig Celery-app utan att röra existerande filer:
# Vi försöker först importera en namngiven instans från er pipeline, annars faller vi tillbaka till current_app.
from celery import current_app as celery_current_app

try:
    # Vanlig konvention i liknande repo:n
    from backend.tasks.codegen import celery_app as celery_app  # type: ignore
except Exception:  # pragma: no cover - defensiv fallback
    try:
        from backend.tasks.codegen import app as celery_app  # type: ignore
    except Exception:  # pragma: no cover
        celery_app = celery_current_app  # sista utväg

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

    @root_validator
    def _validate_mode_fields(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        mode = values.get("mode")
        root_path = values.get("root_path")
        files = values.get("files")
        if mode == "local_paths" and not root_path:
            raise ValueError("root_path krävs för mode=local_paths")
        if mode == "streamed_files":
            if not files or len(files) == 0:
                raise ValueError("files krävs och får inte vara tom för mode=streamed_files")
        return values

class AnalyzeStartResponse(BaseModel):
    task_id: str

class AnalyzeStatusResponse(BaseModel):
    status: str
    project_model: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

# ==== Endpoints ====

@router.post("", response_model=AnalyzeStartResponse)
def start_analysis(manifest: AnalyzeManifest):
    """
    Startar asynkron projektanalys. Returnerar Celery task_id.
    """
    try:
        task = celery_app.send_task("backend.tasks.analyze.analyze_project", args=[manifest.dict()])
    except Exception as e:  # pragma: no cover - robust felhantering
        raise HTTPException(status_code=500, detail=f"Kunde inte queue:a analyze_task: {e}")
    return AnalyzeStartResponse(task_id=task.id)

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
