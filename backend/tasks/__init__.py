"""Init-logik för Celery-paketet *tasks*.

• Laddar automatiskt projektets .env så att utils/codegen får
  GH_TOKEN, FIGMA_TOKEN, TARGET_REPO m.fl. även när Celery
  startas fristående.
"""

from pathlib import Path
from dotenv import load_dotenv, find_dotenv

# Leta upp .env uppåt i katalogträdet, annars försök i repo-roten
_env_path = find_dotenv(usecwd=True)
if not _env_path:
    # Om .env inte hittas, anta att den finns i projektroten (två steg upp från denna fil)
    _env_path = Path(__file__).resolve().parent.parent / ".env"

load_dotenv(_env_path, override=True)
