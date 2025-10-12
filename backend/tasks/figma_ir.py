# backend/tasks/figma_ir.py
from __future__ import annotations
"""
Figma → IR (Intermediate Representation) med transitiv synlighet och root-klipp.

Mål:
- Bakgrundsfärg ska komma från noder som inte är TEXT. Ingen falsk svart.
- TEXT-noder får aldrig bakgrund via fallback. De behåller egen textfärg.
- Ikoner och text påverkas inte av BG-fallback.
- BG-fallback använder 'background'/'backgrounds' före 'backgroundColor'. 'backgroundColor' används endast om r/g/b är numeriska.
- BG-fallback är begränsad till container-typer (FRAME/COMPONENT/COMPONENT_SET/INSTANCE/CANVAS); aldrig bara för att noden råkar vara root.
- Respektera paint.opacity på ALLA paints (SOLID och GRADIENT-stops) via multiplicering med färgens egen alpha.
- Minimal logg: sätt FIGMA_IR_MINLOG=1 för korta rader, inkl. resolved BG-hex för root-noden.
"""

from typing import Any, Dict, List, Optional, Tuple, cast
import math
import os
import re
import json
from copy import deepcopy

# ────────────────────────────────────────────────────────────────────────────
# Minimal loggning
# ────────────────────────────────────────────────────────────────────────────

_MINLOG = os.getenv("FIGMA_IR_MINLOG", "0").lower() in ("1", "true", "yes")

def _minlog(evt: str, **kv):
    if _MINLOG:
        try:
            print("[figma_ir]", evt, json.dumps(kv, ensure_ascii=False, default=str))
        except Exception:
            print("[figma_ir]", evt, kv)

# ────────────────────────────────────────────────────────────────────────────
# Miljöflaggor
# ────────────────────────────────────────────────────────────────────────────

FIGMA_COLOR_GAMMA_FIX = os.getenv("FIGMA_COLOR_GAMMA_FIX", "0").lower() in ("1", "true", "yes")
STRICT_VIEWPORT_CLIP = os.getenv("STRICT_VIEWPORT_CLIP", "1").lower() in ("1", "true", "yes")
IGNORE_ROOT_FILL = os.getenv("IGNORE_ROOT_FILL", "0").lower() in ("1", "true", "yes")

ICON_MIN = int(os.getenv("ICON_MIN", "12"))
ICON_MAX = int(os.getenv("ICON_MAX", "256"))
ICON_AR_MIN = float(os.getenv("ICON_AR_MIN", "0.75"))
ICON_AR_MAX = float(os.getenv("ICON_AR_MAX", "1.33"))

# ────────────────────────────────────────────────────────────────────────────
# Allmänna hjälpare
# ────────────────────────────────────────────────────────────────────────────

def _get(d: Dict[str, Any], k: str, default=None):
    v = d.get(k, default)
    return v if v is not None else default

def _to_float(x: Any) -> Optional[float]:
    try:
        return float(x)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None

def _is_num(x: Any) -> bool:
    return _to_float(x) is not None

def _round(x: Any, p: int = 3) -> Optional[float]:
    fx = _to_float(x)
    if fx is None:
        return None
    r = round(fx, p)
    return 0.0 if r == 0 else r

def _px(x: Any) -> Optional[str]:
    fx = _to_float(x)
    if fx is None:
        return None
    return f"{int(round(fx))}px" if abs(fx - round(fx)) < 1e-6 else f"{round(fx, 2)}px"

def _safe_name(s: Optional[str]) -> str:
    if not s:
        return ""
    return str(s)

def _bool(x: Any, default: bool = False) -> bool:
    if isinstance(x, bool):
        return x
    if x is None:
        return default
    if x in (0, "0", "false", "False"):
        return False
    if x in (1, "1", "true", "True"):
        return True
    return default

def _first(xs: List[Any], pred) -> Optional[Any]:
    for x in xs:
        if pred(x):
            return x
    return None

_WS = re.compile(r"\s+")
def _canon_text(s: str | None) -> str:
    if not isinstance(s, str):
        return ""
    s = s.replace("\u00A0", " ").replace("\u2007", " ").replace("\u202F", " ")
    return _WS.sub(" ", s).strip()

_LINE_SPLIT = re.compile(r"(?:\r?\n|[\u2022\u00B7•]+)\s*")
def _canon_text_lines(s: str | None) -> List[str]:
    if not isinstance(s, str):
        return []
    s = s.replace("\u00A0", " ").replace("\u2007", " ").replace("\u202F", " ")
    parts = [_WS.sub(" ", p).strip() for p in _LINE_SPLIT.split(s)]
    return [p for p in parts if p]

# ────────────────────────────────────────────────────────────────────────────
# Geometri, synlighet och klippning
# ────────────────────────────────────────────────────────────────────────────

def _bounds(node: Dict[str, Any]) -> Dict[str, float]:
    use_render = (os.getenv("FIGMA_USE_RENDER_BOUNDS", "false").lower() in ("1", "true", "yes"))
    bb0 = node.get("absoluteBoundingBox") or {}
    rb0 = node.get("absoluteRenderBounds") or {}
    bb = (rb0 if use_render and rb0 else bb0) or {}

    fx = _to_float(_get(bb, "x", node.get("x"))); fy = _to_float(_get(bb, "y", node.get("y")))
    fw = _to_float(_get(bb, "width",  node.get("width"))); fh = _to_float(_get(bb, "height", node.get("height")))
    x = fx if fx is not None else 0.0
    y = fy if fy is not None else 0.0
    w = fw if fw is not None else 0.0
    h = fh if fh is not None else 0.0
    return {"x": cast(float, _round(x, 3)), "y": cast(float, _round(y, 3)),
            "w": cast(float, _round(w, 3)), "h": cast(float, _round(h, 3))}

def _rect_intersect(a: Optional[Dict[str, float]],
                    b: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
    if not a or not b:
        return a or b
    x1 = max(a["x"], b["x"]); y1 = max(a["y"], b["y"])
    x2 = min(a["x"] + a["w"], b["x"] + b["w"]); y2 = min(a["y"] + a["h"], b["y"] + b["h"])
    if x2 <= x1 or y2 <= y1:
        return None
    return {"x": _round(x1, 3) or 0.0, "y": _round(y1, 3) or 0.0,
            "w": _round(x2 - x1, 3) or 0.0, "h": _round(y2 - y1, 3) or 0.0}

def _effectively_visible(n: Dict[str, Any],
                         inherited_clip: Optional[Dict[str, float]],
                         inherited_visible: bool = True) -> bool:
    if not inherited_visible:
        return False
    if not _bool(n.get("visible"), True):
        return False
    op = _to_float(n.get("opacity"))
    if (op or 1.0) <= 0.01:
        return False
    b = n.get("bounds") or {}
    if inherited_clip is None:
        return True
    return _rect_intersect(b, inherited_clip) is not None

def _clips_content(n: Dict[str, Any]) -> bool:
    return _bool(n.get("clipsContent"), False) or _bool(n.get("clips_content"), False)

def _next_clip(n: Dict[str, Any], parent_clip: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
    if _clips_content(n):
        new_clip = _rect_intersect(parent_clip, n.get("bounds"))
        return new_clip
    return parent_clip

# ────────────────────────────────────────────────────────────────────────────
# Färg och paints
# ────────────────────────────────────────────────────────────────────────────

def _clamp01(x: float) -> float: return 0.0 if x < 0 else 1.0 if x > 1 else x
def _srgb_to_255(c01: float) -> int: return int(round(_clamp01(c01) * 255))
def _linear_to_srgb(c: float) -> float:
    return (1.055 * (c ** (1/2.4)) - 0.055) if c > 0.0031308 else (12.92 * c)

def _rgba_hex(c: Optional[Dict[str, Any]]) -> Tuple[str, float]:
    c = c or {}
    r01 = _to_float(_get(c, "r", 0.0)) or 0.0
    g01 = _to_float(_get(c, "g", 0.0)) or 0.0
    b01 = _to_float(_get(c, "b", 0.0)) or 0.0
    if FIGMA_COLOR_GAMMA_FIX:
        r01, g01, b01 = _linear_to_srgb(r01), _linear_to_srgb(g01), _linear_to_srgb(b01)
    r = _srgb_to_255(r01); g = _srgb_to_255(g01); b = _srgb_to_255(b01)
    a = _to_float(_get(c, "a", 1.0)) or 1.0
    hex_ = "#{:02x}{:02x}{:02x}".format(r, g, b)
    return hex_, _round(a, 4) or 1.0

def _has_rgb(d: Any) -> bool:
    return isinstance(d, dict) and all(_is_num(d.get(k)) for k in ("r", "g", "b"))

def _combine_alpha(a_color: float | None, a_paint: float | None) -> float:
    ac = a_color if a_color is not None else 1.0
    ap = a_paint if a_paint is not None else 1.0
    return _round(ac * ap, 4) or 0.0

def _paint_to_fill(paint: Dict[str, Any]) -> Dict[str, Any]:
    """
    Konvertera Figma-paint → enkel fill.
    Respekterar paint.opacity (multipliceras med färgens alpha).
    Sätter inte färg om SOLID saknar numerisk 'color'.
    """
    t = str(_get(paint, "type", "SOLID") or "SOLID")
    visible = _bool(_get(paint, "visible", True), True)
    o = _to_float(_get(paint, "opacity", 1.0)) or 1.0  # paint.opacity
    out: Dict[str, Any] = {"type": t, "visible": visible, "alpha": _round(o, 4)}

    if t == "SOLID":
        color = paint.get("color")
        if _has_rgb(color):
            hex_, a_col = _rgba_hex(cast(Dict[str, Any], color))
            a = _combine_alpha(a_col, o)
            out.update({"color": hex_, "alpha": a})
    elif t.startswith("GRADIENT_"):
        stops: List[Dict[str, Any]] = []
        for st in cast(List[Dict[str, Any]], _get(paint, "gradientStops", []) or []):
            col = cast(Optional[Dict[str, Any]], _get(st, "color", {}))
            hex_, a_col = _rgba_hex(col)
            pos = _to_float(_get(st, "position", 0.0)) or 0.0
            a = _combine_alpha(a_col, o)
            stops.append({"position": _round(pos, 4), "color": hex_, "alpha": a})
        out["stops"] = stops
        h = cast(List[Dict[str, Any]], _get(paint, "gradientHandlePositions", []) or [])
        if isinstance(h, list) and len(h) >= 2 and isinstance(h[0], dict) and isinstance(h[1], dict):
            p0, p1 = h[0], h[1]
            dx = (_to_float(_get(p1, "x", 0.0)) or 0.0) - (_to_float(_get(p0, "x", 0.0)) or 0.0)
            dy = (_to_float(_get(p1, "y", 0.0)) or 0.0) - (_to_float(_get(p0, "y", 0.0)) or 0.0)
            ang = math.degrees(math.atan2(dy, dx))
            out["angle_deg"] = _round(ang, 2)
        else:
            out["angle_deg"] = 0.0
    elif t == "IMAGE":
        out["scaleMode"] = _get(paint, "scaleMode", "FILL")
        out["imageRef"]   = _get(paint, "imageRef") or _get(paint, "imageHash")
        out["filters"]    = _get(paint, "filters")
        out["transform"]  = _get(paint, "imageTransform")
    else:
        out["raw"] = paint
    return out

# ────────────────────────────────────────────────────────────────────────────
# Stroke, corner radius, effects
# ────────────────────────────────────────────────────────────────────────────

def _stroke_to_ir(node: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    strokes: List[Dict[str, Any]] = []
    for s in (_get(node, "strokes", []) or []):
        if not _bool(_get(s, "visible", True), True):
            continue
        if _get(s, "type") == "SOLID":
            color = _get(s, "color", {}) or {}
            hex_, a = _rgba_hex(cast(Optional[Dict[str, Any]], color))
            weight = _to_float(_get(node, "strokeWeight", 1.0)) or 1.0
            strokes.append({"type": "SOLID", "color": hex_, "alpha": a, "weight": _round(weight, 3)})
        else:
            strokes.append({"type": _get(s, "type"), "raw": s})
    align = str(_get(node, "strokeAlign", "CENTER") or "CENTER")
    return strokes, align

def _radius_to_ir(node: Dict[str, Any]) -> Dict[str, float]:
    cr = _get(node, "cornerRadius")
    if _is_num(cr):
        r = _to_float(cr) or 0.0
        return {"tl": r, "tr": r, "br": r, "bl": r}
    rcr = _get(node, "rectangleCornerRadii")
    if isinstance(rcr, list) and len(rcr) >= 4:
        return {
            "tl": _to_float(rcr[0]) or 0.0, "tr": _to_float(rcr[1]) or 0.0,
            "br": _to_float(rcr[2]) or 0.0, "bl": _to_float(rcr[3]) or 0.0,
        }
    return {
        "tl": _to_float(_get(node, "topLeftRadius", 0)) or 0.0,
        "tr": _to_float(_get(node, "topRightRadius", 0)) or 0.0,
        "br": _to_float(_get(node, "bottomRightRadius", 0)) or 0.0,
        "bl": _to_float(_get(node, "bottomLeftRadius", 0)) or 0.0,
    }

def _effects_to_ir(node: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for ef in (_get(node, "effects", []) or []):
        if not _bool(_get(ef, "visible", True), True):
            continue
        t = _get(ef, "type")
        if t in ("DROP_SHADOW", "INNER_SHADOW"):
            col = _get(ef, "color", {})
            hex_, a = _rgba_hex(cast(Optional[Dict[str, Any]], col))
            off: Dict[str, Any] = cast(Dict[str, Any], _get(ef, "offset", {}) or {})
            out.append({
                "type": t,
                "offset": {"x": _round(_get(off, "x", 0.0), 3),
                           "y": _round(_get(off, "y", 0.0), 3)},
                "radius": _round(_get(ef, "radius", 0.0), 3),
                "spread": _round(_get(ef, "spread", 0.0), 3),
                "color": hex_, "alpha": a,
                "blendMode": _get(ef, "blendMode")
            })
        elif t in ("LAYER_BLUR", "BACKGROUND_BLUR"):
            out.append({"type": t, "radius": _round(_get(ef, "radius", 0.0), 3)})
        else:
            out.append({"type": t, "raw": ef})
    return out

# ────────────────────────────────────────────────────────────────────────────
# Layout och constraints
# ────────────────────────────────────────────────────────────────────────────

def _align_map_primary(v: str) -> str:
    return {"MIN": "flex-start", "CENTER": "center", "MAX": "flex-end", "SPACE_BETWEEN": "space-between"}.get(v or "MIN", "flex-start")

def _align_map_counter(v: str) -> str:
    return {"MIN": "flex-start", "CENTER": "center", "MAX": "flex-end", "BASELINE": "baseline", "STRETCH": "stretch"}.get(v or "MIN", "flex-start")

def _overflow_from_node(node: Dict[str, Any]) -> str:
    return "hidden" if _bool(_get(node, "clipsContent"), False) else "visible"

def _layout_to_ir(node: Dict[str, Any]) -> Dict[str, Any]:
    mode = _get(node, "layoutMode", "NONE")
    gap = _to_float(_get(node, "itemSpacing", 0.0)) or 0.0
    pad = {
        "t": _to_float(_get(node, "paddingTop", 0.0)) or 0.0,
        "r": _to_float(_get(node, "paddingRight", 0.0)) or 0.0,
        "b": _to_float(_get(node, "paddingBottom", 0.0)) or 0.0,
        "l": _to_float(_get(node, "paddingLeft", 0.0)) or 0.0,
    }
    wrap = _get(node, "layoutWrap") == "WRAP"
    primary = str(_get(node, "primaryAxisSizingMode", "FIXED") or "FIXED")
    counter = str(_get(node, "counterAxisSizingMode", "FIXED") or "FIXED")
    align_primary = _align_map_primary(str(_get(node, "primaryAxisAlignItems", "MIN") or "MIN"))
    align_counter = _align_map_counter(str(_get(node, "counterAxisAlignItems", "MIN") or "MIN"))
    return {"mode": mode, "gap": gap, "padding": pad, "wrap": wrap,
            "sizing": {"primary": primary, "counter": counter},
            "align_items": align_counter, "justify_content": align_primary}

def _constraints(node: Dict[str, Any]) -> Dict[str, str]:
    c = _get(node, "constraints", {}) or {}
    return {"horizontal": str(_get(c, "horizontal", "LEFT") or "LEFT"),
            "vertical": str(_get(c, "vertical", "TOP") or "TOP")}

def _is_absolute(node: Dict[str, Any]) -> bool:
    return _get(node, "layoutPositioning") == "ABSOLUTE"

# ────────────────────────────────────────────────────────────────────────────
# Text
# ────────────────────────────────────────────────────────────────────────────

def _text_ir(node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if _get(node, "type") != "TEXT":
        return None
    raw_chars = _get(node, "characters", "") or ""
    content = _canon_text(raw_chars)
    lines = _canon_text_lines(raw_chars)

    st = node.get("style", {}) or {}

    lh_px = st.get("lineHeightPx")
    line_height = _px(lh_px) if lh_px is not None and _is_num(lh_px) else None

    letter_spacing = st.get("letterSpacing")
    if isinstance(letter_spacing, (int, float)):
        ls = f"{_round(letter_spacing, 2)}px"
    elif isinstance(letter_spacing, dict) and "value" in letter_spacing:
        v_raw = letter_spacing.get("value")
        v = _to_float(v_raw) or 0.0
        unit = str(letter_spacing.get("unit", "PERCENT"))
        ls = f"{_round(v,2)}%" if unit == "PERCENT" else f"{_round(v,2)}px"
    else:
        ls = None

    align = {"LEFT": "left", "CENTER": "center", "RIGHT": "right", "JUSTIFIED": "justify"}.get(str(st.get("textAlignHorizontal") or ""), None)

    deco = st.get("textDecoration")
    if deco == "UNDERLINE":
        text_decoration = "underline"
    elif deco == "STRIKETHROUGH":
        text_decoration = "line-through"
    else:
        text_decoration = None

    tf = st.get("textCase")
    text_transform = {"UPPER": "uppercase", "LOWER": "lowercase", "TITLE": "capitalize"}.get(str(tf), None)

    weight = st.get("fontWeight")
    if weight is None:
        style_name = (st.get("fontName") or {}).get("style", "").lower()
        if "bold" in style_name: weight = 700
        elif "semi" in style_name: weight = 600
        elif "medium" in style_name: weight = 500
        else: weight = 400

    # Textfärg: ta första synliga SOLID och kombinera color.a × paint.opacity
    color_val: Optional[str] = None
    fills_any = node.get("fills") or []
    if isinstance(fills_any, list):
        for p in fills_any:
            if isinstance(p, dict) and p.get("type") == "SOLID" and _bool(p.get("visible", True), True):
                hex_, a_col = _rgba_hex(cast(Optional[Dict[str, Any]], p.get("color", {})))
                a_paint = _to_float(p.get("opacity")) or 1.0
                a = _combine_alpha(a_col, a_paint)
                if a >= 0.999:
                    color_val = hex_
                else:
                    r = int(hex_[1:3], 16); g = int(hex_[3:5], 16); b = int(hex_[5:7], 16)
                    color_val = f"rgba({r}, {g}, {b}, {a})"
                break

    return {
        "content": content,
        "lines": lines,
        "style": {
            "fontFamily": st.get("fontFamily") or (st.get("fontName") or {}).get("family"),
            "fontSize": st.get("fontSize"),
            "fontWeight": weight,
            "lineHeight": line_height,
            "letterSpacing": ls,
            "textAlign": align,
            "textDecoration": text_decoration,
            "textTransform": text_transform,
            "color": color_val,
        }
    }

# ────────────────────────────────────────────────────────────────────────────
# CSS-syntes
# ────────────────────────────────────────────────────────────────────────────

def _css_from_node_base(n: Dict[str, Any]) -> Dict[str, Any]:
    css: Dict[str, Any] = {}

    # TEXT-färg
    if n.get("type") == "TEXT":
        tfills = n.get("fills") or []
        for f in tfills:
            if f.get("type") == "SOLID" and _bool(f.get("visible", True), True):
                if IGNORE_ROOT_FILL and n.get("is_root"):
                    break
                a = _to_float(f.get("alpha")) or 1.0
                col = f.get("color")
                if col:
                    if a >= 0.999:
                        css["color"] = col
                    else:
                        r = int(col[1:3], 16); g = int(col[3:5], 16); b = int(col[5:7], 16)
                        css["color"] = f"rgba({r}, {g}, {b}, {a})"
                    _minlog("css.text.color", id=n.get("id"), name=n.get("name"), value=css["color"])
                    break

    b_bounds: Dict[str, Any] = cast(Dict[str, Any], _get(n, "bounds", {}) or {})
    if _is_num(b_bounds.get("w")): css["width"]  = _px(b_bounds.get("w"))
    if _is_num(b_bounds.get("h")): css["height"] = _px(b_bounds.get("h"))

    if _bool(n.get("abs"), False):
        css["position"] = "absolute"
        if _is_num(b_bounds.get("x")): css["left"] = _px(b_bounds.get("x"))
        if _is_num(b_bounds.get("y")): css["top"]  = _px(b_bounds.get("y"))
    else:
        css["position"] = "relative"

    ov = _get(n, "overflow", "visible")
    if ov in ("hidden", "clip"): css["overflow"] = "hidden"

    # BG endast för icke-TEXT och icke-ikon
    is_icon = bool((n.get("icon") or {}).get("is_icon"))
    if n.get("type") != "TEXT" and not is_icon:
        fills: List[Dict[str, Any]] = list(n.get("fills") or [])
        for f in fills:
            if not _bool(f.get("visible", True), True):
                continue
            if IGNORE_ROOT_FILL and n.get("is_root"):
                break
            t = str(f.get("type") or "")
            if t == "SOLID":
                a = _to_float(f.get("alpha")) or 1.0
                col = f.get("color")
                if col:
                    if a >= 0.999:
                        css["backgroundColor"] = col
                    else:
                        r = int(col[1:3], 16); g = int(col[3:5], 16); b = int(col[5:7], 16)
                        css["backgroundColor"] = f"rgba({r}, {g}, {b}, {a})"
                    _minlog("css.bg.color", id=n.get("id"), name=n.get("name"), value=css["backgroundColor"])
                    break
            elif t.startswith("GRADIENT_"):
                stops: List[Dict[str, Any]] = list(f.get("stops") or [])
                angle = _to_float(f.get("angle_deg")) or 0.0
                if stops:
                    parts: List[str] = []
                    for s in stops:
                        c = str(s.get("color") or "#000000")
                        a = _to_float(s.get("alpha")) or 1.0
                        pos = _to_float(s.get("position")) or 0.0
                        parts.append(
                            f"rgba({int(c[1:3],16)}, {int(c[3:5],16)}, {int(c[5:7],16)}, {a}) {int(pos*100)}%"
                            if a < 1.0 else
                            f"{c} {int(pos*100)}%"
                        )
                    css["backgroundImage"] = f"linear-gradient({angle}deg, {', '.join(parts)})"
                    _minlog("css.bg.gradient", id=n.get("id"), name=n.get("name"), value=css["backgroundImage"])
                break
            elif t == "IMAGE":
                css.setdefault("--bg-image-ref", f.get("imageRef") or "")
                css.setdefault("--bg-image-scaleMode", f.get("scaleMode") or "FILL")
                break

    strokes = n.get("strokes", [])
    if strokes:
        s0 = strokes[0]
        if s0.get("type") == "SOLID" and s0.get("weight"):
            bw = s0["weight"]
            col = s0.get("color", "#000000")
            a = _to_float(s0.get("alpha")) or 1.0
            if a < 1.0:
                css["border"] = f"{_px(bw)} solid rgba({int(col[1:3],16)}, {int(col[3:5],16)}, {int(col[5:7],16)}, {a})"
            else:
                css["border"] = f"{_px(bw)} solid {col}"
            align = n.get("stroke_alignment", "CENTER")
            if align == "OUTSIDE":
                css.setdefault("outline", f"{_px(bw)} solid {col}")

    r = n.get("radius", {})
    if r:
        tl,tr,br,bl = r.get("tl",0), r.get("tr",0), r.get("br",0), r.get("bl",0)
        if tl==tr==br==bl:
            if tl: css["borderRadius"] = _px(tl)
        else:
            css["borderTopLeftRadius"]     = _px(tl)
            css["borderTopRightRadius"]    = _px(tr)
            css["borderBottomRightRadius"] = _px(br)
            css["borderBottomLeftRadius"]  = _px(bl)

    shadows: List[str] = []
    for ef in (n.get("effects") or []):
        if ef.get("type") in ("DROP_SHADOW", "INNER_SHADOW"):
            off = ef.get("offset") or {}
            dx, dy = _px(off.get("x")), _px(off.get("y"))
            blur = _px(ef.get("radius"))
            spread = _px(ef.get("spread") or 0)
            col = str(ef.get("color") or "#000000")
            a = _to_float(ef.get("alpha")) or 1.0
            rgba = f"rgba({int(col[1:3],16)}, {int(col[3:5],16)}, {int(col[5:7],16)}, {a})"
            inset = " inset" if ef["type"]=="INNER_SHADOW" else ""
            shadows.append(f"{dx} {dy} {blur} {spread} {rgba}{inset}")
    if shadows:
        css["boxShadow"] = ", ".join(shadows)
        _minlog("css.shadow", id=n.get("id"), name=n.get("name"), value=css["boxShadow"])

    if _is_num(n.get("opacity")) and (_to_float(n.get("opacity")) or 1.0) < 1:
        css["opacity"] = _to_float(n.get("opacity")) or 1.0

    rot = n.get("rotation")
    if _is_num(rot) and abs((_to_float(rot) or 0.0)) > 0.001:
        css["transform"] = f"rotate({_round(_to_float(rot) or 0.0,2)}deg)"

    lay = cast(Dict[str, Any], n.get("layout") or {})
    if lay.get("mode") in ("HORIZONTAL","VERTICAL"):
        css["display"] = "flex"
        css["flexDirection"] = "row" if lay["mode"]=="HORIZONTAL" else "column"
        if _is_num(lay.get("gap")) and (lay.get("gap") or 0) > 0:
            css["gap"] = _px(lay.get("gap"))
        pad = cast(Dict[str, Any], lay.get("padding") or {})
        pcss: List[str] = []
        for k in ("t","r","b","l"):
            pcss.append(_px(pad.get(k, 0)) or "0px")
        if any(v not in ("0px", None) for v in pcss):
            css["padding"] = " ".join(pcss)
        if lay.get("align_items"): css["alignItems"] = lay["align_items"]
        if lay.get("justify_content"): css["justifyContent"] = lay["justify_content"]
        if _bool(lay.get("wrap"), False):
            css["flexWrap"] = "wrap"

    if _is_num(n.get("z")):
        css["zIndex"] = int(_to_float(n.get("z")) or 0)

    return css

# ────────────────────────────────────────────────────────────────────────────
# Tailwind-hints
# ────────────────────────────────────────────────────────────────────────────

def _tailwind_hints(n: Dict[str, Any]) -> Dict[str, Any]:
    tw: List[str] = []

    lay = cast(Dict[str, Any], n.get("layout") or {})
    if lay.get("mode") in ("HORIZONTAL","VERTICAL"):
        tw.append("flex")
        tw.append("flex-row" if lay["mode"]=="HORIZONTAL" else "flex-col")
        gap = lay.get("gap", 0)
        if _is_num(gap) and (gap or 0) > 0:
            tw.append(f"gap-[{_px(gap)}]")
        pad = cast(Dict[str, Any], lay.get("padding") or {})
        if any((_to_float(pad.get(k, 0)) or 0) != 0 for k in ("t","r","b","l")):
            t,r,b,l = pad.get("t",0), pad.get("r",0), pad.get("b",0), pad.get("l",0)
            tw.extend([f"pt-[{_px(t)}]", f"pr-[{_px(r)}]", f"pb-[{_px(b)}]", f"pl-[{_px(l)}]"])
        if lay.get("align_items"):
            m = {"flex-start":"items-start","center":"items-center",
                 "flex-end":"items-end","stretch":"items-stretch","baseline":"items-baseline"}
            v = m.get(lay["align_items"])
            if v: tw.append(v)
        if lay.get("justify_content"):
            m = {"flex-start":"justify-start","center":"justify-center","flex-end":"justify-end","space-between":"justify-between"}
            v = m.get(lay["justify_content"])
            if v: tw.append(v)

    b = n.get("bounds") or {}
    if _is_num(b.get("w")): tw.append(f"w-[{_px(b.get('w'))}]")
    if _is_num(b.get("h")): tw.append(f"h-[{_px(b.get('h'))}]")

    if _bool(n.get("abs"), False):
        tw.append("absolute")
        if _is_num(b.get("x")): tw.append(f"left-[{_px(b.get('x'))}]")
        if _is_num(b.get("y")): tw.append(f"top-[{_px(b.get('y'))}]")
    else:
        tw.append("relative")

    fills = n.get("fills") or []
    # BG-hints endast för icke-TEXT
    if n.get("type") != "TEXT":
        s0 = _first(fills, lambda f: f.get("type")=="SOLID" and _bool(f.get("visible",True),True) and f.get("color"))
        if s0:
            col = s0["color"]; a = _to_float(s0.get("alpha")) or 1.0
            if a >= 0.999: tw.append(f"bg-[{col}]")
            else:
                r = int(col[1:3],16); g = int(col[3:5],16); b_ = int(col[5:7],16)
                tw.append(f"bg-[rgba({r}, {g}, {b_}, {a})]")
        g0 = _first(fills, lambda f: str(f.get("type","")).startswith("GRADIENT_") and _bool(f.get("visible",True),True))
        if g0 and g0.get("stops"):
            parts: List[str] = []
            for s in g0["stops"]:
                c = str(s.get("color") or "#000000"); a = _to_float(s.get("alpha")) or 1.0; pos = _to_float(s.get("position")) or 0.0
                parts.append(f"rgba({int(c[1:3],16)}, {int(c[3:5],16)}, {int(c[5:7],16)}, {a}) {int(pos*100)}%" if a < 1 else f"{c} {int(pos*100)}%")
            ang = _to_float(g0.get("angle_deg")) or 0.0
            tw.append(f"bg-[linear-gradient({ang}deg,{','.join(parts)})]")

    # TEXT-färg-hints endast för TEXT
    if n.get("type") == "TEXT":
        s0 = _first(fills, lambda f: f.get("type")=="SOLID" and _bool(f.get("visible",True),True) and f.get("color"))
        if s0:
            col = s0["color"]; a = _to_float(s0["alpha"]) or 1.0
            if a >= 0.999: tw.append(f"text-[{col}]")
            else:
                r = int(col[1:3],16); g = int(col[3:5],16); b_ = int(col[5:7],16)
                tw.append(f"text-[rgba({r}, {g}, {b_}, {a})]")

    strokes = n.get("strokes") or []
    if strokes:
        s = strokes[0]
        if s.get("type") == "SOLID" and s.get("color"):
            w = s.get("weight")
            if _is_num(w): tw.append(f"border-[{_px(w)}]")
            else: tw.append("border")
            tw.append(f"border-[{s['color']}]")

    r = n.get("radius") or {}
    if any(v for v in r.values()):
        tl,tr,br,bl = r.get("tl",0), r.get("tr",0), r.get("br",0), r.get("bl",0)
        if tl==tr==br==bl:
            tw.append(f"rounded-[{_px(tl)}]")
        else:
            if tl: tw.append(f"rounded-tl-[{_px(tl)}]")
            if tr: tw.append(f"rounded-tr-[{_px(tr)}]")
            if br: tw.append(f"rounded-br-[{_px(br)}]")
            if bl: tw.append(f"rounded-bl-[{_px(bl)}]")

    if n.get("overflow") in ("hidden","clip"): tw.append("overflow-hidden")

    if _is_num(n.get("opacity")) and (_to_float(n.get("opacity")) or 1.0) < 1:
        tw.append(f"opacity-[{_to_float(n.get('opacity')) or 1.0}]")

    if n.get("type") == "TEXT":
        st = (n.get("text") or {}).get("style") or {}
        lines = (n.get("text") or {}).get("lines") or []
        if isinstance(lines, list) and len(lines) >= 2:
            tw.append("whitespace-pre-wrap")
        if st.get("textAlign"):
            tw.append({"left":"text-left","center":"text-center","right":"text-right","justify":"text-justify"}[st["textAlign"]])

        if st.get("fontSize") is not None:
            px_fs = _px(st.get("fontSize"))
            if px_fs: tw.append(f"text-[{px_fs}]")

        w = st.get("fontWeight")
        if isinstance(w, int):
            tw.append(f"font-[{w}]")

        if st.get("lineHeight"): tw.append(f"leading-[{st['lineHeight']}]")
        if st.get("letterSpacing"): tw.append(f"tracking-[{st['letterSpacing']}]")

        if st.get("textDecoration") == "underline": tw.append("underline")
        if st.get("textDecoration") == "line-through": tw.append("line-through")
        if st.get("textTransform") == "uppercase": tw.append("uppercase")
        if st.get("textTransform") == "lowercase": tw.append("lowercase")
        if st.get("textTransform") == "capitalize": tw.append("capitalize")

        fam_raw = str(st.get("fontFamily", "")).strip()
        if fam_raw:
            safe = (fam_raw.replace("\\", "\\\\").replace("'", "\\'").replace("]", "\\]"))
            safe_us = safe.replace(" ", "_")
            tw.append(f"font-['{safe_us}']")

    css = n.get("css") or {}
    if isinstance(css, dict) and css.get("boxShadow"):
        tw.append(f"shadow-[{css['boxShadow']}]")

    rot = n.get("rotation")
    if _is_num(rot) and abs((_to_float(rot) or 0.0)) > 0.001:
        tw.append(f"rotate-[{_round(_to_float(rot) or 0.0,2)}deg]")

    if _is_num(n.get("z")):
        tw.append(f"z-[{int(_to_float(n.get('z')) or 0)}]")

    seen: set[str] = set()
    clean: List[str] = []
    for t in tw:
        if t and t not in seen:
            seen.add(t); clean.append(t)

    if "absolute" in clean and "relative" in clean:
        clean = [t for t in clean if t != "relative"]

    has_explicit_width = any(t.startswith("border-[") and t.endswith("px]") for t in clean)
    if has_explicit_width and "border" in clean:
        clean = [t for t in clean if t != "border"]

    return {"classes": " ".join(clean)}

# ────────────────────────────────────────────────────────────────────────────
# Ikon-detektion
# ────────────────────────────────────────────────────────────────────────────

_ICON_TYPES = {
    "VECTOR", "BOOLEAN_OPERATION", "ELLIPSE", "RECTANGLE",
    "LINE", "REGULAR_POLYGON", "STAR",
}
_CONTAINERS = {"GROUP","INSTANCE","COMPONENT","COMPONENT_SET","FRAME"}

def _slug(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "icon"

def _is_iconish_name(name: str) -> bool:
    s = (name or "").lower()
    return any(t in s for t in ("icon", "ic/", "ico/", "glyph", "symbol"))

def _single_visible_solid_fill(node: Dict[str, Any]) -> Tuple[Optional[str], Optional[float]]:
    fills = node.get("fills") or []
    solids = [p for p in fills if isinstance(p, dict) and p.get("type")=="SOLID" and _bool(p.get("visible",True), True)]
    if len(solids) == 1:
        hex_, a = _rgba_hex(cast(Optional[Dict[str, Any]], solids[0].get("color", {})))
        return hex_, a
    return None, None

def _aspect_ok(w: float, h: float) -> bool:
    if w <= 0 or h <= 0:
        return False
    r = w / h
    return ICON_AR_MIN <= r <= ICON_AR_MAX

def _has_text_desc(n: Dict[str, Any]) -> bool:
    if (n.get("type") == "TEXT") and bool(n.get("visible_effective", True)):
        return True
    for ch in n.get("children") or []:
        if _has_text_desc(ch):
            return True
    return False

def _icon_hint(node: Dict[str, Any]) -> Dict[str, Any]:
    b = node.get("bounds") or {}
    name = _safe_name(node.get("name"))
    t = _safe_name(node.get("type"))
    has_children = bool(node.get("children"))
    w, h = b.get("w") or 0.0, b.get("h") or 0.0

    type_ok = t in _ICON_TYPES
    size_typical = (ICON_MIN <= int(round(w)) <= ICON_MAX and
                    ICON_MIN <= int(round(h)) <= ICON_MAX and
                    _aspect_ok(w, h))
    child_ok = not has_children

    is_icon = bool(type_ok and child_ok and size_typical and w > 0 and h > 0)

    hex_col, alpha = _single_visible_solid_fill(node)
    if not hex_col:
        strokes = node.get("strokes") or []
        s0 = _first(strokes, lambda s: s.get("type")=="SOLID" and _bool(s.get("visible",True), True))
        if s0:
            hex_col, alpha = _rgba_hex(cast(Optional[Dict[str, Any]], (s0.get("color") or {})))

    tintable = is_icon and bool(hex_col)

    return {
        "is_icon": is_icon,
        "name": name,
        "name_slug": _slug(name),
        "type": t,
        "bounds": b,
        "dominant_color": hex_col,
        "dominant_alpha": alpha if alpha is not None else 1.0,
        "tintable": tintable,
        "rotation": _round(_get(node, "rotation", 0.0), 3),
    }

# ────────────────────────────────────────────────────────────────────────────
# Traversering och IR-byggnad med transitiv synlighet
# ────────────────────────────────────────────────────────────────────────────

def _node_to_ir(doc_node: Dict[str, Any], *,
                _z: int = 0,
                inherited_clip: Optional[Dict[str, float]] = None,
                inherited_visible: bool = True,
                _is_root: bool = False) -> Dict[str, Any]:
    bounds = _bounds(doc_node)

    own_visible = _bool(doc_node.get("visible"), True)
    opacity = _round(_get(doc_node, "opacity", 1.0), 4) or 1.0
    clips_here = _bool(doc_node.get("clipsContent"), False)
    next_clip = _rect_intersect(inherited_clip, bounds) if clips_here else inherited_clip

    prelim = {"visible": own_visible, "opacity": opacity, "bounds": bounds}
    eff_visible = _effectively_visible(prelim, inherited_clip, inherited_visible)

    # Ikon-hint TIDIGT, behövs för BG-fallback-beslut
    icon_hint = _icon_hint({"bounds": bounds, **doc_node})
    is_icon = bool(icon_hint.get("is_icon"))

    fills = [_paint_to_fill(p) for p in (doc_node.get("fills") or []) if _bool(_get(p, "visible", True), True)]

    # BG-fallback: endast för container-typer; aldrig på ikoner.
    used_bg_fallback = False
    bg = doc_node.get("backgroundColor")
    node_type = str(doc_node.get("type") or "")
    ALLOW_BG_FALLBACK_TYPES = {"FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "CANVAS"}
    allow_bg_fallback = (node_type in ALLOW_BG_FALLBACK_TYPES) and not is_icon

    def _needs_bg_fallback(fills_list: List[Dict[str, Any]]) -> bool:
        if not fills_list:
            return True
        f0 = next((f for f in fills_list if _bool(f.get("visible", True), True)), None)
        if f0 is None:
            return True
        if f0.get("type") == "SOLID" and not f0.get("color"):
            return True
        return False

    if allow_bg_fallback and _needs_bg_fallback(fills):
        # 1) Preferera 'background'/'backgrounds'
        bg_paints = _get(doc_node, "background") or _get(doc_node, "backgrounds")
        if isinstance(bg_paints, list) and bg_paints:
            bgfills = [_paint_to_fill(p) for p in bg_paints if _bool(_get(p, "visible", True), True)]
            if bgfills:
                fills = bgfills
                used_bg_fallback = True
                if _is_root and bgfills[0].get("type") == "SOLID" and bgfills[0].get("color"):
                    _minlog("bg.resolved.root", color=bgfills[0]["color"], alpha=_to_float(bgfills[0].get("alpha")) or 1.0)
        # 2) Annars 'backgroundColor' om r/g/b är numeriska och nodtypen tillåts
        if not used_bg_fallback and _has_rgb(bg) and (node_type in ALLOW_BG_FALLBACK_TYPES):
            hex_, a = _rgba_hex(bg)
            # backgroundColor saknar separat paint.opacity, så använd bara dess alpha direkt
            fills = [{"type": "SOLID", "visible": True, "alpha": a, "color": hex_}]
            used_bg_fallback = True
            if _is_root:
                _minlog("bg.resolved.root", color=hex_, alpha=a)

    # Logga raw backgroundColor endast om r/g/b är numeriska
    if _has_rgb(bg):
        hx, a = _rgba_hex(bg)
        _minlog("node.backgroundColor", id=_safe_name(doc_node.get("id")),
                name=_safe_name(doc_node.get("name")), type=node_type, hex=hx, alpha=a)

    strokes, stroke_align = _stroke_to_ir(doc_node)
    radius = _radius_to_ir(doc_node)
    effects = _effects_to_ir(doc_node)
    text = _text_ir({"bounds": bounds, **doc_node})
    abspos = _is_absolute(doc_node)
    l = _layout_to_ir(doc_node)
    cons = _constraints(doc_node)
    ov = _overflow_from_node(doc_node)
    rot = _round(_get(doc_node, "rotation", 0.0), 3)

    ir: Dict[str, Any] = {
        "id": _safe_name(doc_node.get("id")),
        "name": _safe_name(doc_node.get("name")),
        "type": _safe_name(doc_node.get("type")),
        "visible": own_visible,
        "visible_effective": bool(eff_visible),
        "abs": abspos,
        "bounds": bounds,
        "layout": l,
        "constraints": cons,
        "fills": fills,
        "strokes": strokes,
        "stroke_alignment": stroke_align if strokes else "NONE",
        "radius": radius,
        "effects": effects,
        "opacity": opacity,
        "blend_mode": doc_node.get("blendMode"),
        "clips_content": clips_here,
        "overflow": ov,
        "text": text,
        "icon": icon_hint,
        "rotation": rot,
        "z": _z,
        "children": [],
        "is_root": _is_root,
    }

    # Logga första synliga fill som faktiskt används
    fv = None
    for f in (fills or []):
        if _bool(f.get("visible", True), True):
            fv = f
            break
    if fv:
        payload = {
            "id": ir["id"], "name": ir["name"], "type": ir["type"],
            "is_root": _is_root, "used_bg_fallback": used_bg_fallback
        }
        t = str(fv.get("type") or "")
        if t == "SOLID":
            payload.update({"kind": "SOLID", "hex": fv.get("color"), "alpha": fv.get("alpha")})
        elif t.startswith("GRADIENT_"):
            payload.update({"kind": "GRADIENT", "stops": fv.get("stops"), "angle": fv.get("angle_deg")})
        elif t == "IMAGE":
            payload.update({"kind": "IMAGE", "ref": fv.get("imageRef"), "mode": fv.get("scaleMode")})
        else:
            payload.update({"kind": t})
        _minlog("fill.node", **payload)
        if _is_root and t == "SOLID" and fv.get("color"):
            _minlog("bg.root.color", color=fv.get("color"), alpha=_to_float(fv.get("alpha")) or 1.0)

    by = int(round((ir["bounds"].get("y") or 0)))
    bx = int(round((ir["bounds"].get("x") or 0)))
    ir["order"] = _z
    ir["order_key"] = [by, bx, _z]

    css = _css_from_node_base(ir)
    ir["css"] = css
    ir["tw"]  = _tailwind_hints(ir)

    for i, ch in enumerate(doc_node.get("children") or []):
        ir["children"].append(_node_to_ir(ch, _z=i, inherited_clip=next_clip, inherited_visible=eff_visible, _is_root=False))

    return ir

def _extract_document_from_nodes_payload(payload: Dict[str, Any], node_id: str) -> Dict[str, Any]:
    nodes = (payload.get("nodes") or {})
    if node_id in nodes and "document" in nodes[node_id]:
        return nodes[node_id]["document"]
    for v in nodes.values():
        if "document" in v:
            return v["document"]
    raise ValueError("Kunde inte hitta 'document' i nodes-payloaden.")

# ────────────────────────────────────────────────────────────────────────────
# Publikt API: Figma → IR samt synlighets-pruning
# ────────────────────────────────────────────────────────────────────────────

def figma_to_ir(figma_json: Dict[str, Any], node_id: str, *, viewport: Tuple[int,int]=(1280,800)) -> Dict[str, Any]:
    """
    STRICT_VIEWPORT_CLIP=1 → klipp till viewport med origo i rootens x/y, annars till root-bounds.
    """
    doc = _extract_document_from_nodes_payload(figma_json, node_id)
    root_bounds = _bounds(doc)

    if STRICT_VIEWPORT_CLIP:
        clip = {"x": root_bounds["x"], "y": root_bounds["y"], "w": float(viewport[0]), "h": float(viewport[1])}
    else:
        clip = root_bounds

    _minlog("clip.config", strict=STRICT_VIEWPORT_CLIP, clip=clip)

    root_ir = _node_to_ir(doc, _z=0, inherited_clip=clip, inherited_visible=True, _is_root=True)
    root_ir.setdefault("debug", {})
    root_ir["debug"]["isRoot"] = True
    root_ir["debug"]["rootClip"] = clip
    root_ir["debug"]["STRICT_VIEWPORT_CLIP"] = STRICT_VIEWPORT_CLIP

    # Logga resolved BG för root (solid/gradient/none) endast om alpha > 0
    bg = "none"
    for f in (root_ir.get("fills") or []):
        if not _bool(f.get("visible", True), True):
            continue
        t = str(f.get("type") or "")
        if t == "SOLID" and f.get("color") and (_to_float(f.get("alpha")) or 1.0) > 0.001:
            bg = f.get("color")
            break
        if t.startswith("GRADIENT_") and (f.get("stops") or []):
            bg = "gradient"
            break
    _minlog("bg.root.summary", resolved=bg)

    meta = {
        "nodeId": node_id,
        "viewport": {"w": viewport[0], "h": viewport[1]},
        "schemaVersion": 4,
        "producedBy": "figma_ir.py"
    }
    return {"meta": meta, "root": root_ir}

def _reindex_order(n: Dict[str, Any]) -> None:
    for i, ch in enumerate(n.get("children") or []):
        ch["z"] = i
        by = int(round((ch.get("bounds", {}).get("y") or 0)))
        bx = int(round((ch.get("bounds", {}).get("x") or 0)))
        ch["order"] = i
        ch["order_key"] = [by, bx, i]
        _reindex_order(ch)

def filter_visible_ir(ir_full: Dict[str, Any]) -> Dict[str, Any]:
    """
    Endast effektivt synliga noder. Behåll containers om de har synliga barn.
    """
    def prune(n: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        kids: List[Dict[str, Any]] = []
        for ch in n.get("children") or []:
            p = prune(ch)
            if p is not None:
                kids.append(p)

        eff = bool(n.get("visible_effective", True))
        keep = eff or len(kids) > 0
        if not keep:
            return None

        nn = deepcopy(n)
        nn["children"] = kids
        return nn

    root_in = ir_full["root"]
    root_out = prune(root_in) or deepcopy(root_in)
    _reindex_order(root_out)
    return {"meta": ir_full["meta"], "root": root_out}

# ────────────────────────────────────────────────────────────────────────────
# Hjälp: bildreferenser, CSS/TW-map
# ────────────────────────────────────────────────────────────────────────────

def collect_image_refs(ir_node: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    def rec(n: Dict[str, Any], _clip_unused: Optional[Dict[str,float]]):
        if not bool(n.get("visible_effective", True)):
            return
        for f in n.get("fills", []):
            if f.get("type")=="IMAGE":
                ref = f.get("imageRef")
                if ref:
                    out.append(ref)
        for ch in n.get("children", []):
            rec(ch, None)
    rec(ir_node, None)
    seen = set()
    uniq: List[str] = []
    for r in out:
        if r not in seen:
            seen.add(r); uniq.append(r)
    return uniq

def build_css_map(ir_node: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
    css_map: Dict[str, Dict[str, str]] = {}
    def rec(n: Dict[str, Any]):
        nid = n.get("id") or ""
        raw = n.get("css", {}) or {}
        css_map[nid] = {k: str(v) for k, v in raw.items()}
        for ch in n.get("children", []):
            rec(ch)
    rec(ir_node)
    return css_map

def build_tailwind_map(ir_node: Dict[str, Any]) -> Dict[str, str]:
    tw_map: Dict[str, str] = {}
    def rec(n: Dict[str, Any]):
        nid = n.get("id") or ""
        tw_map[nid] = (n.get("tw") or {}).get("classes", "")
        for ch in n.get("children", []):
            rec(ch)
    rec(ir_node)
    return tw_map

# ────────────────────────────────────────────────────────────────────────────
# Ikon-noder
# ────────────────────────────────────────────────────────────────────────────

def collect_icon_nodes(ir_node: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Synliga ikon-noder i IR-trädet utan dubbletter.
    - Leaf-ikon: node.icon.is_icon == True och visible_effective == True.
    - Container-ikon: 1–8 synliga vektor-leaves, storlek inom ICON_MIN..ICON_MAX,
      aspekt inom [ICON_AR_MIN..ICON_AR_MAX], inga text-descendants.
    - INSTANCE-fallback: inga leaves men typiska ikonmått + aspektkvot + ingen text.
    """
    out: List[Dict[str, Any]] = []

    def _visible(n: Dict[str, Any]) -> bool:
        return bool(n.get("visible_effective", True))

    def _gather_vector_leaves(n: Dict[str, Any], acc: List[Dict[str, Any]], depth: int = 0, max_depth: int = 5):
        if depth > max_depth:
            return
        if not _visible(n):
            return
        t = n.get("type")
        ch = n.get("children") or []
        if t in _ICON_TYPES and not ch:
            b = n.get("bounds") or {}
            if isinstance(b, dict) and (b.get("w",0)*b.get("h",0)) >= 4:
                acc.append(n)
            return
        for c in ch:
            _gather_vector_leaves(c, acc, depth+1, max_depth)

    def rec(n: Dict[str, Any]):
        if not _visible(n):
            return
        t = (n.get("type") or "")

        ic = (n.get("icon") or {})
        if ic.get("is_icon"):
            b = ic.get("bounds") or n.get("bounds")
            if isinstance(b, dict) and (b.get("w",0)*b.get("h",0)) >= 4:
                out.append({
                    "id": n.get("id"),
                    "name": ic.get("name") or n.get("name"),
                    "name_slug": ic.get("name_slug"),
                    "bounds": b,
                    "tintable": bool(ic.get("tintable")),
                    "color": ic.get("dominant_color"),
                    "alpha": ic.get("dominant_alpha", 1.0),
                })
            return

        if t in _CONTAINERS:
            leaves: List[Dict[str, Any]] = []
            _gather_vector_leaves(n, leaves)
            nb = (n.get("bounds") or {})
            w = int(round(nb.get("w", 0) or 0)); h = int(round(nb.get("h", 0) or 0))
            if (1 <= len(leaves) <= 8 and
                ICON_MIN <= w <= ICON_MAX and ICON_MIN <= h <= ICON_MAX and
                _aspect_ok(w, h) and
                not _has_text_desc(n) and
                (w*h) >= 4):
                out.append({
                    "id": n.get("id"),
                    "name": n.get("name"),
                    "name_slug": _slug(n.get("name") or "icon"),
                    "bounds": nb,
                    "tintable": True,
                    "color": None,
                    "alpha": 1.0,
                })
                return

            if (t == "INSTANCE" and len(leaves) == 0 and
                ICON_MIN <= w <= ICON_MAX and ICON_MIN <= h <= ICON_MAX and
                _aspect_ok(w, h) and
                not _has_text_desc(n) and
                (w*h) >= 4):
                out.append({
                    "id": n.get("id"),
                    "name": n.get("name"),
                    "name_slug": _slug(n.get("name") or "icon"),
                    "bounds": nb,
                    "tintable": True,
                    "color": None,
                    "alpha": 1.0,
                })
                return

        for ch in n.get("children") or []:
            rec(ch)

    rec(ir_node)

    uniq: Dict[str, Dict[str, Any]] = {}
    for x in out:
        if x["id"] and x["id"] not in uniq:
            uniq[x["id"]] = x
    return list(uniq.values())

# ────────────────────────────────────────────────────────────────────────────
# CLI-test
# ────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":  # pragma: no cover
    import json as _json, sys
    if len(sys.argv) < 3:
        print("Använd: python -m backend.tasks.figma_ir <nodes.json> <node_id>")
        sys.exit(1)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        payload = _json.load(f)
    nid = sys.argv[2]
    ir_full = figma_to_ir(payload, nid)
    ir = filter_visible_ir(ir_full)
    print(_json.dumps(ir, ensure_ascii=False, indent=2))

__all__ = [
    "figma_to_ir",
    "filter_visible_ir",
    "collect_image_refs",
    "build_css_map",
    "build_tailwind_map",
    "collect_icon_nodes",
]
