# backend/tasks/schemas.py
from __future__ import annotations

def build_codegen_schema(target_component_dir: str, allow_patch: list[str]) -> dict:
    esc_dir = target_component_dir.rstrip("/").replace("/", r"\/")
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Codegen",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "mode": {"type": "string", "enum": ["patch", "file"]},
            "target_path": {"type": "string"},
            "file_code": {"type": "string", "minLength": 1},
            "unified_diff": {"type": "string", "minLength": 1},
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
        "required": ["mode", "target_path", "mount"],
        "allOf": [
            {
                "if": {"properties": {"mode": {"const": "file"}}},
                "then": {
                    "required": ["file_code"],
                    "properties": {
                        "target_path": {
                            "type": "string",
                            "pattern": fr"^{esc_dir}/[^/]+\.(tsx|ts|jsx|js|css)$"
                        }
                    }
                }
            },
            {
                "if": {"properties": {"mode": {"const": "patch"}}},
                "then": {
                    "required": ["unified_diff"],
                    "properties": {
                        "target_path": {"type": "string", "enum": allow_patch},
                        "unified_diff": {"type": "string", "pattern": r"(?s)(^---\s|^diff\s)"}
                    }
                }
            }
        ]
    }
