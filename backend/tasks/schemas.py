# backend/tasks/schemas.py
from __future__ import annotations
import re

def build_codegen_schema(target_component_dir: str, allow_patch: list[str]) -> dict:
    esc_dir = re.escape(target_component_dir.rstrip("/")).replace("/", r"\/")
    allowed_union = "|".join(re.escape(p).replace("/", r"\/") for p in allow_patch) or r"(?!x)x"

    target_path_pattern = rf"^(?:{esc_dir}/[^/]+\.(?:tsx|ts|jsx|js|css)|(?:{allowed_union}))$"

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Codegen",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "mode": {"type": "string", "enum": ["patch", "file"]},
            "target_path": {"type": "string", "pattern": target_path_pattern},
            # Gör båda obligatoriska men tillåt tom sträng; Python avgör sen.
            "file_code": {
                "type": "string",
                # förhindra ```-block var som helst men tillåt tom sträng (ECMAScript-kompatibel)
                "pattern": r"^(?:$|(?:[^`]|`(?!``))*)$"
            },
            "unified_diff": {
                "type": "string",
                # tillåt tom sträng eller giltig unified diff (utan (?s), ECMAScript-kompatibel)
                "pattern": r"^(?:$|(?:---\s|diff\s)[\s\S]*)$"
            },
            "mount": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "anchor": {"type": "string", "const": "AI-INJECT-MOUNT"},
                    "import_name": {"type": "string", "pattern": "^[A-Z][A-Za-z0-9]*$"},
                    "import_path": {"type": "string", "minLength": 1},
                    "jsx": {"type": "string", "minLength": 3}
                },
                "required": ["anchor", "import_name", "import_path", "jsx"]
            }
        },
        # IMPORTANT: alla keys i properties måste listas här i strict-läget
        "required": ["mode", "target_path", "file_code", "unified_diff", "mount"],
    }
