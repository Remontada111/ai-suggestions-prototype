"""
tasks/utils.py
────────────────────────────────────────────────────────────────────────────
Gemensamma hjälpfunktioner för Celery-workern:

* Läser miljövariabler och räknar ut Git-URL:er
* Klonar mål-repositoriet till en temporär katalog
* Skapar unika branch-namn (ingen “non-fast-forward”-konflikt)
* Öppnar Pull Requests via GitHub REST-API
* Skannar projektet efter befintliga React-komponenter (default-exports)
"""

from __future__ import annotations

import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict, Tuple

import requests
from fastapi import HTTPException
from git import Repo
from git.exc import GitCommandError

#  ──────────────────────────── 1. Miljövariabler ───────────────────────────
GH_TOKEN: str | None = os.getenv("GH_TOKEN")
TARGET_REPO: str | None = os.getenv("TARGET_REPO")          # "user/repo"
BASE_BRANCH: str = os.getenv("BASE_BRANCH", "main")

if not (GH_TOKEN and TARGET_REPO):
    raise RuntimeError(
        "Både GH_TOKEN och TARGET_REPO måste finnas i .env "
        "för att kodgenererings-pipen ska fungera."
    )

REMOTE_URL = f"https://{GH_TOKEN}:x-oauth-basic@github.com/{TARGET_REPO}.git"

#  ──────────────────────────── 2. Git-utility-funktioner ────────────────────
def unique_branch(node_id: str) -> str:
    """
    Returnerar ett garanterat unikt branch-namn.
    Exempel: ai/figma-429-783-20250715T101233
    """
    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    safe_id = node_id.replace(":", "-")
    return f"ai/figma-{safe_id}-{ts}"


def clone_repo() -> Tuple[str, Repo]:
    """
    Klonar `TARGET_REPO` till en temporär katalog (depth=1 för fart).
    Returnerar (temp_dir_path, Repo-objekt).

    Höjer HTTPException(500) om något går fel.
    """
    tmp_dir = tempfile.mkdtemp(prefix="ai-pr-bot-")
    try:
        repo = Repo.clone_from(
            REMOTE_URL,
            tmp_dir,
            branch=BASE_BRANCH,
            depth=1,
            single_branch=True,
        )
        return tmp_dir, repo
    except GitCommandError as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(500, f"Git clone error: {e.stderr or e}") from e


def create_pr(repo: Repo, branch: str, title: str, body: str | None = None) -> str:
    """
    Pushar `branch` (antar att den finns lokalt) och öppnar en Pull Request.
    Returnerar PR-länken.

    ➜ Kallas i slutet av Celery-tasken.
    """
    # 1. Push
    try:
        repo.remote("origin").push(refspec=f"{branch}:{branch}")
    except GitCommandError as e:
        raise HTTPException(500, f"Git push error: {e.stderr or e}") from e

    # 2. PR via GitHub-API
    pr_resp = requests.post(
        f"https://api.github.com/repos/{TARGET_REPO}/pulls",
        headers={
            "Authorization": f"token {GH_TOKEN}",
            "Accept": "application/vnd.github+json",
        },
        json={
            "title": title,
            "head": branch,
            "base": BASE_BRANCH,
            "body": body or "",
        },
        timeout=20,
    )
    if pr_resp.status_code >= 300:
        raise HTTPException(
            502,
            f"GitHub PR error ({pr_resp.status_code}): {pr_resp.text}",
        )
    return pr_resp.json().get("html_url", "")

#  ──────────────────────────── 3. Komponent-scanner ─────────────────────────
#   Vi använder tree-sitter för att hitta default-exporterade React-funktioner.
try:
    from tree_sitter import Language, Parser
except ImportError:  # om användaren inte har behov av analysfunktionen
    Parser = None      # type: ignore

_TS_LIB = Path(__file__).with_suffix(".ts.so")  # tasks/utils.ts.so

from typing import Any

def _ensure_ts_parser() -> Any:
    """
    Bygger (första gången) och cachar en tree-sitter-parser för TSX.
    """
    if Parser is None:
        raise RuntimeError("tree_sitter saknas – installera paketet först.")

    if not _TS_LIB.exists():
        # Build once: nedladdar grammar och kompilera shared object
        from subprocess import check_call

        grammar_repo = (
            "https://github.com/tree-sitter/tree-sitter-typescript.git"
        )
        tmp = Path(tempfile.mkdtemp())
        try:
            check_call(["git", "clone", "--depth", "1", grammar_repo, tmp])
            ts_src = tmp / "tsx"
            from tree_sitter import Language
            Language.build_library(str(_TS_LIB), [str(ts_src)]) # type: ignore
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    ts_lang = Language(str(_TS_LIB), "tsx") # type: ignore
    parser = Parser()
    parser.set_language(ts_lang) # type: ignore
    return parser


def list_components(repo_path: str) -> Dict[str, Path]:
    """
    Går igenom hela repo-trädet och returnerar en dict:

        { "ComponentName": Path("<repo>/src/…/ComponentName.tsx"), ... }

    Vi letar efter:
        export default function ComponentName(
    eller
        const ComponentName = (…) => { … }; export default ComponentName;
    """
    if Parser is None:
        # tree-sitter är valfritt – utan det returnerar vi tom lista.
        return {}

    parser = _ensure_ts_parser()
    components: Dict[str, Path] = {}

    for p in Path(repo_path).rglob("*.tsx"):
        try:
            src = p.read_bytes()
        except (OSError, UnicodeDecodeError):
            continue  # hoppa över binärkod, felkodad fil etc.

        tree = parser.parse(src)
        root = tree.root_node

        # Lättviktig traversal – vi går inte igenom hela AST:t djupare än nödvändigt.
        for node in root.children:
            if node.type == "function_declaration":
                text = src[node.start_byte : node.end_byte].decode("utf-8", "ignore")
                if text.startswith("export default function"):
                    name = (
                        text.split("function", 1)[1]
                        .split("(", 1)[0]
                        .strip()
                    )
                    components[name] = p
            elif node.type == "lexical_declaration":  # const/let …
                text = src[node.start_byte : node.end_byte].decode("utf-8", "ignore")
                if "export default" in text:
                    # Förenklad parse: const Foo = ⇒ hämta första ordet
                    try:
                        left = text.split("const", 1)[1]
                        name = left.split("=", 1)[0].strip()
                        components[name] = p
                    except IndexError:
                        pass
    return components
