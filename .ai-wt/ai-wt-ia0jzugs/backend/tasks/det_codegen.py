# backend/det_codegen.py
# -*- coding: utf-8 -*-
"""
Deterministisk IR→JSX-generator (ersätter LLM-steget).

Mål:
- 1:1 utseende för statiska komponenter (ej interaktivt beteende).
- Enbart IR-fält används (framförallt: tw.list, bg, text.style, bounds, abs, css.boxShadow).
- Ikon-noder renderas som exakt en <img> med importerad SVG (?url), utan absoluta positioner.
- Textnoder: prioritera 'text.content' som EN <div>. Om content saknas men 'text.lines' finns
  → slå ihop med mellanslag till EN <div>.
- TEXT-bredd/höjd: ta bort w-[…px] och h-[…px] från tw.list och ersätt med w-auto och h-auto.
- Inget beroende på externa templatemotorer/LLM. Endast stränggenerering.

Publik API:
    generate_tsx_component(ir: dict, icon_assets: list[dict], comp_name: str) -> (filename: str, code: str)

IR-fält som används:
- node.visible_effective : bool
- node.tw.list           : list[str] (Tailwind-klasser genererade i figma_ir.py)
- node.bg                : {"type":"SOLID"|"GRADIENT","color":"#rrggbb","alpha":float} |
                           {"type":"GRADIENT","css":"linear-gradient(...)"}
- node.text.style        : { fontSize:number, lineHeight:"..px", letterSpacing:"..px"|"..%", fontWeight:int,
                             fontFamily:str, textAlign:"left|center|right|justify", color:"#hex"|rgba(...) }
- node.children          : list[node]
- node.id, node.type, node.name (endast för ikoner och metadata)

Ikon-rendering:
- icon_assets: [{"id":str, "import_path":str|"/src/...svg", "w":int, "h":int}, ...]
- För varje ikon-node vars id finns i icon_assets: importera '?url' och rendera:
    <img src={Var} alt="" aria-hidden="true" width={w} height={h}
         className="inline-block align-middle w-[{w}px] h-[{h}px]" />
- Inga absolute/left/top på <img>. (Valideringen förväntar detta.)

Observera:
- Bakgrunder sätts ENBART via node.bg (inte via fills), i linje med valideringen.
- Klasslistan städas deterministiskt (dubletter bort, konflikt: border vs border-[px], relative vs absolute).
- Textinnehåll renderas som {"`...`"} för att undvika JSX-tolkning av { } och specialtecken.
- Respektera IGNORE_ROOT_FILL=1: root-noden får ingen bg-klass när flaggan är satt.
"""

from __future__ import annotations
from typing import Any, Dict, List, Tuple
import os
import re


# ──────────────────────────────────────────────────────────────────────────────
# Hjälpfunktioner (px, klasshantering, sanering)
# ──────────────────────────────────────────────────────────────────────────────

def _px(v: Any) -> str | None:
    """Konvertera tal till px-sträng (bevarar 2 decimaler om ej heltal)."""
    try:
        f = float(v)
        return f"{int(round(f))}px" if abs(f - round(f)) < 1e-6 else f"{round(f, 2)}px"
    except Exception:
        return None


def _dedup(seq: List[str]) -> List[str]:
    """Ta bort dubbletter med bibehållen ordning."""
    seen: set[str] = set()
    out: List[str] = []
    for s in seq:
        s = s.strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _sanitize_tw(cls: str) -> str:
    """
    Sanera Tailwind-klasssträng:
    - Ta bort 'border' om explicit 'border-[px]' finns.
    - Ta bort 'relative' om 'absolute' finns.
    - Ta bort ogiltiga negativa arbitrary '-[ ... ]'.
    - Komprimera whitespace.
    """
    if re.search(r"\bborder-\[[0-9.]+px\]", cls):
        cls = re.sub(r"(?<!-)\bborder\b", "", cls)
    if re.search(r"\babsolute\b", cls):
        cls = re.sub(r"\brelative\b", "", cls)
    cls = re.sub(r"(^|\s)-\[[^\]]+\]", " ", cls)
    cls = re.sub(r"\s+", " ", cls).strip()
    return cls


# ──────────────────────────────────────────────────────────────────────────────
# Text & typografi
# ──────────────────────────────────────────────────────────────────────────────

def _text_classes(st: Dict[str, Any]) -> List[str]:
    """Typografiklasser från text.style."""
    out: List[str] = []

    fs = st.get("fontSize")
    if isinstance(fs, (int, float)):
        px = _px(fs)
        if px:
            out.append(f"text-[{px}]")

    lh = st.get("lineHeight")
    if isinstance(lh, str) and lh.endswith("px"):
        out.append(f"leading-[{lh}]")

    ls = st.get("letterSpacing")
    if isinstance(ls, str) and ls.strip():
        m = re.match(r"^\s*([+-]?\d+(?:\.\d+)?)\s*px\s*$", ls)
        if m:
            try:
                v = float(m.group(1))
                if abs(v) >= 0.01:
                    out.append(f"tracking-[{ls}]")
            except Exception:
                pass
        else:
            out.append("tracking-normal")

    fw = st.get("fontWeight")
    if isinstance(fw, int) and fw in range(100, 1000, 100):
        out.append(f"font-[{fw}]")

    fam = st.get("fontFamily")
    if isinstance(fam, str) and fam.strip():
        fam_space = fam.strip().replace("\\", "\\\\").replace("'", "\\'")
        out.append(f'font-["{fam_space}"]')

    ta = st.get("textAlign")
    if ta in ("left", "center", "right", "justify"):
        out.append({"left": "text-left", "center": "text-center", "right": "text-right", "justify": "text-justify"}[ta])

    col = st.get("color")
    if isinstance(col, str) and col.strip():
        out.append(f"text-[{col}]")

    # TEXT → tvinga en rad och auto-dims
    out += ["whitespace-nowrap", "w-auto", "h-auto"]

    return out


def _escape_for_jsx_text(s: str) -> str:
    """
    Minimalt säkert för att läggas i en template literal:
    {"`...`"} – escapar backtick och backslash.
    """
    if not isinstance(s, str):
        s = str(s or "")
    s = s.replace("\\", "\\\\").replace("`", "\\`")
    return s


# ──────────────────────────────────────────────────────────────────────────────
# Bakgrund (enbart från node.bg)
# ──────────────────────────────────────────────────────────────────────────────

def _bg_classes(bg: Dict[str, Any] | None) -> List[str]:
    """
    Enbart n.bg används (SOLID/GRADIENT).
    - SOLID: bg-[#hex] eller bg-[rgba(...)]
    - GRADIENT: bg-[linear-gradient(...)]
    """
    if not isinstance(bg, dict):
        return []
    t = (bg.get("type") or "").upper()
    if t == "SOLID" and bg.get("color"):
        a = float(bg.get("alpha", 1) or 1)
        c = str(bg["color"])
        if a >= 0.999:
            return [f"bg-[{c}]"]
        r = int(c[1:3], 16)
        g = int(c[3:5], 16)
        b = int(c[5:7], 16)
        return [f"bg-[rgba({r}, {g}, {b}, {a})]"]
    if t == "GRADIENT" and bg.get("css"):
        css = str(bg["css"])
        return [f"bg-[{css}]"]
    return []


# ──────────────────────────────────────────────────────────────────────────────
# Klasskonstruktion per nod
# ──────────────────────────────────────────────────────────────────────────────

_W_EXP = re.compile(r"^w-\[.+\]$")
_H_EXP = re.compile(r"^h-\[.+\]$")

def _classes_for_node(n: Dict[str, Any], *, is_root: bool, ignore_root_fill: bool) -> str:
    """
    Kombinera:
      - tw.list (figma_ir.py),
      - text.style (för TEXT),
      - bg (enbart via n.bg; hoppa över på root om ignore_root_fill).
    Sanera och deduplicera deterministiskt.
    TEXT: ta bort w-[…px]/h-[…px] från tw.list och ersätt med w-auto/h-auto.
    """
    base = list((n.get("tw") or {}).get("list") or [])

    if n.get("type") == "TEXT":
        # Släng px-exakta dimensioner för TEXT
        base = [t for t in base if not (_W_EXP.match(t) or _H_EXP.match(t))]
        # Lägg till typoklasser inkl. w-auto/h-auto
        base += _text_classes((n.get("text") or {}).get("style") or {})
    else:
        if n.get("type") == "TEXT":  # dödkodskydd
            base += _text_classes((n.get("text") or {}).get("style") or {})

    if not (ignore_root_fill and is_root):
        base += _bg_classes(n.get("bg"))

    # Dedup och strängsanering
    cls = " ".join(_dedup(base))
    return _sanitize_tw(cls)


# ──────────────────────────────────────────────────────────────────────────────
# Ikoner (SVG ?url) – import och <img>
# ──────────────────────────────────────────────────────────────────────────────

def _build_icon_map(icon_assets: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    id -> {path:'...svg?url', w:int, h:int}
    """
    out: Dict[str, Dict[str, Any]] = {}
    for ia in icon_assets or []:
        nid = str(ia.get("id", "") or "")
        if not nid:
            continue
        p = ia.get("import_path") or ia.get("fs_path")
        if not p:
            continue
        path = str(p)
        if not path.lower().endswith(".svg") and not path.lower().endswith(".svg?url"):
            continue  # endast SVG
        if not path.endswith("?url"):
            path = f"{path}?url"
        try:
            w = int(round(float(ia.get("w") or 0)))
            h = int(round(float(ia.get("h") or 0)))
        except Exception:
            w = 0
            h = 0
        out[nid] = {"path": path, "w": max(w, 0), "h": max(h, 0)}
    return out


def _make_import_var(path: str, used: set[str]) -> str:
    """
    Generera deterministiskt import-variabelnamn från filnamn.
    Unikt inom filen (Icon, Icon2, ...).
    """
    base = re.sub(r"[^A-Za-z0-9]", " ", path.split("?")[0].split("/")[-1].split(".")[0]).title().replace(" ", "") or "Icon"
    if not re.match(r"[A-Za-z_]", base[0]):
        base = "_" + base
    name = base
    i = 2
    while name in used:
        name = f"{base}{i}"
        i += 1
    used.add(name)
    return name


# ──────────────────────────────────────────────────────────────────────────────
# Traversering & emission
# ──────────────────────────────────────────────────────────────────────────────

def _is_visible(n: Dict[str, Any]) -> bool:
    v = n.get("visible_effective")
    return bool(True if v is None else v)


def _emit_node(
    n: Dict[str, Any],
    lines: List[str],
    icon_map: Dict[str, Dict[str, Any]],
    import_vars: Dict[str, str],
    used_names: set[str],
    depth: int,
    *,
    is_root: bool,
    ignore_root_fill: bool,
) -> None:
    """Skriv JSX för en nod + dess barn (rekursivt)."""
    if not _is_visible(n):
        return

    indent = "  " + "  " * depth
    nid = str(n.get("id", "") or "")

    # Ikon-node → exakt en <img>, inga barn
    if nid and nid in icon_map:
        meta = icon_map[nid]
        path = meta["path"]
        w = int(meta.get("w") or 0)
        h = int(meta.get("h") or 0)

        # Tilldela/återanvänd import-variabel
        var = None
        for k, v in import_vars.items():
            if v == path:
                var = k
                break
        if var is None:
            var = _make_import_var(path, used_names)
            import_vars[var] = path

        w = max(w, 1)  # säkerställ >0 (validering kräver >0)
        h = max(h, 1)

        lines.append(
            f"{indent}<img src={{{var}}} alt='' aria-hidden='true' width={{{w}}} height={{{h}}} "
            f"className='inline-block align-middle w-[{w}px] h-[{h}px]' />"
        )
        return

    # TEXT: rendera som EN nod. content först. annars lines sammanfogade.
    if n.get("type") == "TEXT":
        cls = _classes_for_node(n, is_root=is_root, ignore_root_fill=ignore_root_fill)
        t = n.get("text") or {}
        content = t.get("content")
        rows = t.get("lines") or []

        if isinstance(content, str) and content.strip():
            s = _escape_for_jsx_text(content)
            lines.append(f"{indent}<div className='{cls}'>{{`{s}`}}</div>")
            return

        if isinstance(rows, list) and rows:
            joined = " ".join(_escape_for_jsx_text(str(s or "")) for s in rows)
            if joined.strip():
                lines.append(f"{indent}<div className='{cls}'>{{`{joined}`}}</div>")
                return
        # Om ingen text – falla igenom till tom wrapper (kan bära layout/bakgrund)

    # Övriga noder: div + barn i ordning
    cls = _classes_for_node(n, is_root=is_root, ignore_root_fill=ignore_root_fill)
    lines.append(f"{indent}<div className='{cls}'>")
    for ch in (n.get("children") or []):
        _emit_node(
            ch,
            lines,
            icon_map,
            import_vars,
            used_names,
            depth + 1,
            is_root=False,
            ignore_root_fill=ignore_root_fill,
        )
    lines.append(f"{indent}</div>")


# ──────────────────────────────────────────────────────────────────────────────
# Publik API
# ──────────────────────────────────────────────────────────────────────────────

def generate_tsx_component(
    ir: Dict[str, Any],
    icon_assets: List[Dict[str, Any]] | None,
    comp_name: str,
) -> Tuple[str, str]:
    """
    Generera TSX-komponent från IR + ikonlista.
    Returnerar (filnamn, innehåll).
    """
    if not isinstance(ir, dict) or "root" not in ir:
        raise ValueError("Ogiltigt IR: saknar 'root'.")

    icon_map = _build_icon_map(icon_assets or [])
    used_names: set[str] = set()
    import_vars: Dict[str, str] = {}  # var -> path

    body_lines: List[str] = []
    ignore_root_fill = (os.getenv("IGNORE_ROOT_FILL") == "1")

    # Root wrappern börjar på depth=2 för snygg indentering med return (  ... )
    _emit_node(
        ir["root"],
        body_lines,
        icon_map,
        import_vars,
        used_names,
        depth=2,
        is_root=True,
        ignore_root_fill=ignore_root_fill,
    )

    # Bygg imports (stabil ordning)
    import_lines = [f"import {var} from '{path}';" for var, path in sorted(import_vars.items(), key=lambda x: x[0])]

    # Slutlig fil
    header = [
        "/* auto-generated: deterministic IR→JSX (no LLM) */",
        "import React from 'react';",
        *import_lines,
        "",
        f"export default function {comp_name}() {{",
        "  return (",
    ]
    footer = [
        "  );",
        "}",
        "",
    ]

    code = "\n".join(header + body_lines + footer)
    filename = f"{comp_name}.tsx"
    return filename, code


__all__ = ["generate_tsx_component"]
