# backend/tasks/utils.py
"""
Gemensamma hjälpfunktioner för Celery-workern:

* Läser miljövariabler och räknar ut Git-URL:er
* Klonar mål-repositoriet till en temporär katalog
* Skapar unika branch-namn
* Öppnar Pull Requests via GitHub REST-API
* Skannar projektet efter befintliga React-komponenter (default-exports)
"""

from __future__ import annotations

import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict, Tuple, Any

import requests
from fastapi import HTTPException
from git import Repo
from git.exc import GitCommandError

# ─────────────────────────── 1) Miljö & Git ───────────────────────────

GH_TOKEN: str | None = os.getenv("GH_TOKEN")
TARGET_REPO: str | None = os.getenv("TARGET_REPO")  # "user/repo"
BASE_BRANCH: str = os.getenv("BASE_BRANCH", "main")

if not (GH_TOKEN and TARGET_REPO):
    raise RuntimeError(
        "Både GH_TOKEN och TARGET_REPO måste finnas i .env "
        "för att kodgenererings-pipen ska fungera."
    )

REMOTE_URL = f"https://x-access-token:{GH_TOKEN}@github.com/{TARGET_REPO}.git"


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
    Klonar `TARGET_REPO` till en temporär katalog (depth=1).
    Returnerar (temp_dir_path, Repo-objekt).
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
    Pushar `branch` och öppnar en Pull Request. Returnerar PR-länken.
    """
    # Push
    try:
        repo.remote("origin").push(refspec=f"{branch}:{branch}")
    except GitCommandError as e:
        raise HTTPException(500, f"Git push error: {e.stderr or e}") from e

    # PR via GitHub-API
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

# ───────────────── 2) Komponent-scanner (förkompilerad TSX) ───────────────

# Använd förkompilerade språk för att slippa runtime-builds (distutils).
try:
    from tree_sitter import Parser
    from tree_sitter_languages import get_language
except Exception:  # ImportError eller annat – gör scannern valfri
    Parser = None            # type: ignore[assignment]
    get_language = None      # type: ignore[assignment]


def _ensure_ts_parser() -> Any:
    """
    Hämtar en Parser inställd på TSX via tree_sitter_languages.
    Ingen kompilering vid körning.
    """
    if Parser is None or get_language is None:
        raise RuntimeError("tree_sitter eller tree_sitter_languages saknas.")
    parser = Parser()
    parser.set_language(get_language("tsx"))
    return parser


def list_components(repo_path: str) -> Dict[str, Path]:
    """
    Går igenom repo-trädet och returnerar en dict:
        { "ComponentName": Path("<repo>/src/.../ComponentName.tsx"), ... }

    Vi letar efter:
      1) `export default function ComponentName(` i filen
      2) `const ComponentName = (…) => ...; export default ComponentName;`
    """
    # Valfri funktionalitet: saknas parser → tom lista
    if Parser is None or get_language is None:
        return {}

    try:
        parser = _ensure_ts_parser()
    except Exception:
        # Robust fallback: ingen komponentlista om parsern inte kan initieras
        return {}

    components: Dict[str, Path] = {}

    for p in Path(repo_path).rglob("*.tsx"):
        try:
            src = p.read_bytes()
        except (OSError, UnicodeDecodeError):
            continue

        # Snabb path: text-scan gör grovfilter, AST bekräftar struktur
        text_utf8 = ""
        try:
            text_utf8 = src.decode("utf-8", "ignore")
        except Exception:
            pass

        if "export default" not in text_utf8:
            # Troligen ingen default-export – hoppa AST-parse för speed
            continue

        try:
            tree = parser.parse(src)
        except Exception:
            # Om tree-sitter misslyckas, gör en enkel textbaserad heuristik
            # för vanliga mönster.
            name = _heuristic_name_from_text(text_utf8)
            if name:
                components[name] = p
            continue

        root = tree.root_node

        # Lättviktig traversal – kolla top-level declarationer
        matched = False
        for node in root.children:
            try:
                if node.type == "function_declaration":
                    segment = src[node.start_byte: node.end_byte].decode("utf-8", "ignore")
                    if segment.startswith("export default function"):
                        name = (
                            segment.split("function", 1)[1]
                            .split("(", 1)[0]
                            .strip()
                        )
                        if name:
                            components[name] = p
                            matched = True
                elif node.type == "lexical_declaration":  # const/let …
                    segment = src[node.start_byte: node.end_byte].decode("utf-8", "ignore")
                    if "export default" in segment and "const " in segment:
                        try:
                            left = segment.split("const", 1)[1]
                            name = left.split("=", 1)[0].strip()
                            if name:
                                components[name] = p
                                matched = True
                        except IndexError:
                            pass
            except Exception:
                # Fortsätt på nästa node vid partiella parse-problem
                continue

        if not matched:
            # Fallback på heuristik om top-level-parse inte hittade något
            name = _heuristic_name_from_text(text_utf8)
            if name:
                components[name] = p

    return components


def _heuristic_name_from_text(text: str) -> str | None:
    """
    Enkel textbaserad heuristik för att extrahera ett sannolikt komponentnamn.
    Används när parsern inte finns eller bommar på en fil.
    """
    try:
        # export default function Foo(
        if "export default function" in text:
            tail = text.split("export default function", 1)[1].lstrip()
            cand = tail.split("(", 1)[0].strip()
            if cand:
                return cand

        # const Foo = (...) => ...; export default Foo
        if "export default" in text and "const " in text:
            left = text.split("const", 1)[1]
            name = left.split("=", 1)[0].strip()
            if name and f"export default {name}" in text:
                return name
    except Exception:
        pass
    return None
