"""
tasks/patcher.py
────────────────────────────────────────────────────────────────────────────
* Skapar unified-diff-strängar (generate_patch)
* Applicerar en diff på en befintlig fil (apply_patch)

Kräver: unidiff>=0.7
"""

from __future__ import annotations

import difflib
from pathlib import Path
from typing import List

from unidiff import PatchSet, PatchedFile, Hunk

# ────────────────────────── 1. Diff-generator ─────────────────────────────
def generate_patch(original: str, updated: str, filename: str) -> str:
    """
    Returnerar en unified diff-sträng (***.patch***) mellan två kodsträngar.
    `filename` används bara för rubrikerna i diffen.
    """
    diff_iter = difflib.unified_diff(
        original.splitlines(keepends=True),
        updated.splitlines(keepends=True),
        fromfile=f"a/{filename}",
        tofile=f"b/{filename}",
        n=3,
    )
    return "".join(diff_iter)


# ────────────────────────── 2. Diff-applicering ───────────────────────────
def _apply_hunk(src_lines: List[str], hunk: Hunk) -> List[str]:
    """
    Returnerar en NY lista med hunken applicerad.
    Vi bygger resultatet rad för rad utan att använda .text-attributet
    (som saknar type-stubs och ger Pylance-fel).
    """
    out: List[str] = []
    idx = hunk.source_start - 1  # 0-baserat index i originalfilen
    for part in hunk:
        if part.is_context:
            out.extend(src_lines[idx : idx + len(part.value)])
            idx += len(part.value)
        elif part.is_removed:
            idx += len(part.value)  # hoppa över borttagna rader
        elif part.is_added:
            out.extend(part.value)
        else:  # bör aldrig inträffa
            out.extend(part.value)
    # Lägg till resterande rader
    out.extend(src_lines[idx:])
    return out


def apply_patch(file_path: Path, patch_str: str) -> None:
    """
    Läser in `file_path`, applicerar diffen och skriver tillbaka filen.
    Höjer ValueError om patchen inte passar mot aktuell fil.
    """
    src_lines = file_path.read_text(encoding="utf-8").splitlines(keepends=True)
    patch = PatchSet(patch_str)

    if not patch:
        raise ValueError("Tom patch-sträng")

    patched_file: PatchedFile = patch[0]  # unified diff har oftast bara 1 fil

    # Verifiera att patchen matchar rätt filnamn (för säkerhets skull)
    if file_path.name not in {patched_file.source_file.lstrip("ab/"),
                              patched_file.target_file.lstrip("ab/")}:
        raise ValueError("Patchen matchar inte den valda filen")

    new_lines = src_lines
    for hunk in patched_file:
        new_lines = _apply_hunk(new_lines, hunk)

    file_path.write_text("".join(new_lines), encoding="utf-8")
