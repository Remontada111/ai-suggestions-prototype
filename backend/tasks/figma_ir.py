from __future__ import annotations
"""
Figma → Lossless Render-IR för 1:1-kodgenerering.

Mål:
- Förlustfri, deterministisk och kanonisk beskrivning av nodträdet.
- All geometri root-relativ. Inga magiska viewports eller offsets.
- Effektiva färger (alpha = color.a × paint.opacity) för SOLID/GRADIENT.
- Tailwind-klasser för PX-exakta mått, position, färg, typografi, skuggor m.m.
- Ingen “fallback-pruning”: wrappers som påverkar layout/färg/clip bevaras.
- Ikon-hints för export (små vektorleaves eller typiska containerikoner).
- Kompatibel med existerande pipeline-funktioner: figma_to_ir, filter_visible_ir,
  build_tailwind_map, collect_icon_nodes.
"""

from typing import Any, Dict, List, Optional, Tuple, cast
import math
import os
import re
import json
from copy import deepcopy

# ────────────────────────────────────────────────────────────────────────────
# Konfiguration (konservativa defaults, inga onödiga toggles)
# ────────────────────────────────────────────────────────────────────────────

ICON_MIN   = int(os.getenv("ICON_MIN", "12"))
ICON_MAX   = int(os.getenv("ICON_MAX", "256"))
ICON_AR_MIN = float(os.getenv("ICON_AR_MIN", "0.75"))
ICON_AR_MAX = float(os.getenv("ICON_AR_MAX", "1.33"))

# NYTT: ta bort opaque svart bakgrund på layout-wrappers (barnramar) som inte clippar
LAYOUT_STRIP_OPAQUE_BLACK = os.getenv("LAYOUT_STRIP_OPAQUE_BLACK", "1").lower() in ("1","true","yes")

_MINLOG = os.getenv("FIGMA_IR_MINLOG", "0").lower() in ("1","true","yes")
TRACE_NODES = int(os.getenv("FIGMA_IR_TRACE_NODES", "0") or "0")

def _minlog(evt: str, **kv):
    if _MINLOG:
        try:
            print("[figma_ir]", evt, json.dumps(kv, ensure_ascii=False, default=str))
        except Exception:
            print("[figma_ir]", evt, kv)

# ────────────────────────────────────────────────────────────────────────────
# Hjälpare: robusta getters och typer
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
    return str(s or "")

def _bool(x: Any, default: bool = False) -> bool:
    if isinstance(x, bool): return x
    if x is None: return default
    if x in (0,"0","false","False"): return False
    if x in (1,"1","true","True"):   return True
    return default

_WS = re.compile(r"\s+")
def _canon_text(s: str | None) -> str:
    if not isinstance(s, str): return ""
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    return _WS.sub(" ", s).strip()

_LINE_SPLIT = re.compile(r"(?:\r?\n|[\u2022\u00B7•]+)\s*")
def _canon_text_lines(s: str | None) -> List[str]:
    if not isinstance(s, str): return []
    s = s.replace("\u00A0"," ").replace("\u2007"," ").replace("\u202F"," ")
    parts = [_WS.sub(" ", p).strip() for p in _LINE_SPLIT.split(s)]
    return [p for p in parts if p]

# ────────────────────────────────────────────────────────────────────────────
# Geometri och synlighet
# ────────────────────────────────────────────────────────────────────────────

def _bounds(node: Dict[str, Any]) -> Dict[str, float]:
    # Preferera absoluteRenderBounds om tillgängligt
    bb0 = node.get("absoluteBoundingBox") or {}
    rb0 = node.get("absoluteRenderBounds") or {}
    bb = (rb0 or bb0) or {}
    x = _to_float(_get(bb, "x", node.get("x"))) or 0.0
    y = _to_float(_get(bb, "y", node.get("y"))) or 0.0
    w = _to_float(_get(bb, "width",  node.get("width")))  or 0.0
    h = _to_float(_get(bb, "height", node.get("height"))) or 0.0
    return {"x": cast(float, _round(x,3)), "y": cast(float, _round(y,3)),
            "w": cast(float, _round(w,3)), "h": cast(float, _round(h,3))}

def _rect_intersect(a: Optional[Dict[str, float]],
                    b: Optional[Dict[str, float]]) -> Optional[Dict[str, float]]:
    if not a or not b: return a or b
    x1 = max(a["x"], b["x"]); y1 = max(a["y"], b["y"])
    x2 = min(a["x"] + a["w"], b["x"] + b["w"]); y2 = min(a["y"] + a["h"], b["y"] + b["h"])
    if x2 <= x1 or y2 <= y1: return None
    return {"x": _round(x1,3) or 0.0, "y": _round(y1,3) or 0.0,
            "w": _round(x2-x1,3) or 0.0, "h": _round(y2-y1,3) or 0.0}

def _clips_content(n: Dict[str, Any]) -> bool:
    return _bool(n.get("clipsContent"), False) or _bool(n.get("clips_content"), False)

def _effectively_visible(n: Dict[str, Any],
                         inherited_clip: Optional[Dict[str, float]],
                         inherited_visible: bool = True) -> bool:
    if not inherited_visible: return False
    if not _bool(n.get("visible"), True): return False
    op = _to_float(n.get("opacity"))
    if (op or 1.0) <= 0.01: return False
    b = n.get("bounds") or {}
    if inherited_clip is None: return True
    return _rect_intersect(b, inherited_clip) is not None

# ────────────────────────────────────────────────────────────────────────────
# Färger och paints (lossless → både raw och effective)
# ────────────────────────────────────────────────────────────────────────────

def _clamp01(x: float) -> float: return 0.0 if x < 0 else 1.0 if x > 1 else x
def _srgb_to_255(c01: float) -> int: return int(round(_clamp01(c01) * 255))
def _rgba_hex(c: Optional[Dict[str, Any]]) -> Tuple[str, float]:
    c = c or {}
    r01 = _to_float(_get(c, "r", 0.0)) or 0.0
    g01 = _to_float(_get(c, "g", 0.0)) or 0.0
    b01 = _to_float(_get(c, "b", 0.0)) or 0.0
    r = _srgb_to_255(r01); g = _srgb_to_255(g01); b = _srgb_to_255(b01)
    a = _to_float(_get(c, "a", 1.0)) or 1.0
    hex_ = "#{:02x}{:02x}{:02x}".format(r, g, b)
    return hex_, _round(a, 4) or 1.0

def _has_rgb(d: Any) -> bool:
    return isinstance(d, dict) and all(_is_num(d.get(k)) for k in ("r","g","b"))

def _combine_alpha(a_color: float | None, a_paint: float | None) -> float:
    ac = a_color if a_color is not None else 1.0
    ap = a_paint if a_paint is not None else 1.0
    return _round(ac * ap, 4) or 0.0

def _paint_to_fill(paint: Dict[str, Any]) -> Dict[str, Any]:
    t = str(_get(paint, "type", "SOLID") or "SOLID")
    visible = _bool(_get(paint, "visible", True), True)
    o = _to_float(_get(paint, "opacity", 1.0)) or 1.0
    out: Dict[str, Any] = {"type": t, "visible": visible, "alpha": _round(o,4)}

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
            stops.append({"position": _round(pos,4), "color": hex_, "alpha": a})
        out["stops"] = stops
        # enkel vinkelapprox
        h = cast(List[Dict[str, Any]], _get(paint, "gradientHandlePositions", []) or [])
        if isinstance(h, list) and len(h) >= 2 and isinstance(h[0], dict) and isinstance(h[1], dict):
            p0, p1 = h[0], h[1]
            dx = (_to_float(_get(p1,"x",0.0)) or 0.0) - (_to_float(_get(p0,"x",0.0)) or 0.0)
            dy = (_to_float(_get(p1,"y",0.0)) or 0.0) - (_to_float(_get(p0,"y",0.0)) or 0.0)
            ang = math.degrees(math.atan2(dy, dx))
            out["angle_deg"] = _round(ang,2)
        else:
            out["angle_deg"] = 0.0
    elif t == "IMAGE":
        out["scaleMode"] = _get(paint, "scaleMode", "FILL")
        out["imageRef"]  = _get(paint, "imageRef") or _get(paint, "imageHash")
        out["filters"]   = _get(paint, "filters")
        out["transform"] = _get(paint, "imageTransform")
    else:
        out["raw"] = paint
    return out

# Hjälpare för layout-wrappers och opaque svart
def _is_layout_wrapper(n: Dict[str, Any]) -> bool:
    t = str(_get(n, "type", ""))
    has_kids = bool(_get(n, "children"))
    # GROUP kan sakna backgrounds, men inkluderas ofarligt
    return t in ("FRAME", "COMPONENT", "INSTANCE", "GROUP") and has_kids and not _clips_content(n)

def _is_opaque_black_paint(p: Dict[str, Any]) -> bool:
    if str(_get(p, "type")) != "SOLID":
        return False
    hex_, a_col = _rgba_hex(cast(Dict[str, Any], _get(p, "color", {})))
    a = _combine_alpha(a_col, _to_float(_get(p, "opacity")) or 1.0)
    return hex_ == "#000000" and (a or 0) >= 0.999

def _effective_fills(doc_node: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Best-effort “faktiskt använda” fills enligt Figma:
    - Om `fills` finns och har någon synlig paint → använd dessa.
    - Annars, begränsa `background`/`backgrounds` och `backgroundColor` till riktiga containers
      (FRAME/COMPONENT) som clippar. Detta undviker oavsiktliga wrapper-bakgrunder.
    - För layout-wrappers filtreras opaque svart (#000, α≈1) bort.
    """
    # 1) Direkta fills vinner alltid
    fills_list = [p for p in (_get(doc_node,"fills",[]) or []) if _bool(_get(p,"visible",True),True)]
    if fills_list:
        return [_paint_to_fill(p) for p in fills_list]

    # 2) Begränsad användning av backgrounds
    bgs = _get(doc_node, "background") or _get(doc_node, "backgrounds")
    node_type = str(_get(doc_node, "type", ""))
    clips = _clips_content(doc_node)

    if isinstance(bgs, list) and bgs and node_type in ("FRAME", "COMPONENT") and clips:
        vis = [p for p in bgs if _bool(_get(p,"visible",True),True)]
        if LAYOUT_STRIP_OPAQUE_BLACK and _is_layout_wrapper(doc_node):
            vis = [p for p in vis if not _is_opaque_black_paint(p)]
        if vis:
            return [_paint_to_fill(p) for p in vis]

    # 3) backgroundColor som sista utväg, samma begränsning
    bgc = _get(doc_node, "backgroundColor")
    if clips and node_type in ("FRAME", "COMPONENT") and _has_rgb(bgc):
        hex_, a = _rgba_hex(cast(Dict[str, Any], bgc))
        if LAYOUT_STRIP_OPAQUE_BLACK and _is_layout_wrapper(doc_node) and hex_ == "#000000" and (a or 0) >= 0.999:
            return []
        return [{"type":"SOLID","visible":True,"alpha":a,"color":hex_}]

    return []

# NYTT: IR.bg från effective fills
def _bg_from_effective_fills(fills: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    Härled en enda bakgrund från effective fills:
    - Första synliga SOLID med alpha > 0.001 → SOLID {color, alpha}
    - Första GRADIENT_* → GRADIENT {css, angle_deg}
    """
    for f in fills or []:
        if not _bool(f.get("visible", True), True):
            continue
        t = str(f.get("type") or "")
        if t == "SOLID" and f.get("color"):
            a = _to_float(f.get("alpha")) or 1.0
            if a > 0.001:
                return {"type": "SOLID", "color": f["color"], "alpha": _round(a, 4)}
        if t.startswith("GRADIENT_") and (f.get("stops") or []):
            ang = _to_float(f.get("angle_deg")) or 0.0
            parts: List[str] = []
            for s in f.get("stops", []):
                c = str(s.get("color") or "#000000")
                a = _to_float(s.get("alpha")) or 1.0
                pos = int(round((_to_float(s.get("position")) or 0.0) * 100))
                if a >= 0.999:
                    parts.append(f"{c} {pos}%")
                else:
                    r = int(c[1:3],16); g = int(c[3:5],16); b = int(c[5:7],16)
                    parts.append(f"rgba({r}, {g}, {b}, {a}) {pos}%")
            css = f"linear-gradient({_round(ang,2)}deg,{','.join(parts)})"
            return {"type": "GRADIENT", "css": css, "angle_deg": _round(ang, 2)}
    return None

# ────────────────────────────────────────────────────────────────────────────
# Stroke, corner radius, effects
# ────────────────────────────────────────────────────────────────────────────

def _stroke_to_ir(node: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], str]:
    strokes: List[Dict[str, Any]] = []
    for s in (_get(node,"strokes",[]) or []):
        if not _bool(_get(s,"visible",True), True): continue
        if _get(s,"type") == "SOLID":
            color = _get(s, "color", {}) or {}
            hex_, a = _rgba_hex(cast(Optional[Dict[str, Any]], color))
            weight = _to_float(_get(node, "strokeWeight", 1.0)) or 1.0
            strokes.append({"type":"SOLID","color":hex_,"alpha":_round(a,4),"weight":_round(weight,3)})
        else:
            strokes.append({"type":_get(s,"type"), "raw": s})
    align = str(_get(node,"strokeAlign","CENTER") or "CENTER")
    return strokes, align

def _radius_to_ir(node: Dict[str, Any]) -> Dict[str, float]:
    cr = _get(node, "cornerRadius")
    if _is_num(cr):
        r = _to_float(cr) or 0.0
        return {"tl": r, "tr": r, "br": r, "bl": r}
    rcr = _get(node, "rectangleCornerRadii")
    if isinstance(rcr, list) and len(rcr) >= 4:
        return {"tl":_to_float(rcr[0]) or 0.0, "tr":_to_float(rcr[1]) or 0.0,
                "br":_to_float(rcr[2]) or 0.0, "bl":_to_float(rcr[3]) or 0.0}
    return {"tl": _to_float(_get(node,"topLeftRadius",0)) or 0.0,
            "tr": _to_float(_get(node,"topRightRadius",0)) or 0.0,
            "br": _to_float(_get(node,"bottomRightRadius",0)) or 0.0,
            "bl": _to_float(_get(node,"bottomLeftRadius",0)) or 0.0}

def _effects_to_ir(node: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for ef in (_get(node,"effects",[]) or []):
        if not _bool(_get(ef,"visible",True), True): continue
        t = _get(ef, "type")
        if t in ("DROP_SHADOW", "INNER_SHADOW"):
            col = _get(ef, "color", {})
            hex_, a = _rgba_hex(cast(Optional[Dict[str, Any]], col))
            off: Dict[str, Any] = cast(Dict[str, Any], _get(ef,"offset",{}) or {})
            out.append({
                "type": t,
                "offset": {"x": _round(_get(off,"x",0.0),3), "y": _round(_get(off,"y",0.0),3)},
                "radius": _round(_get(ef,"radius",0.0),3),
                "spread": _round(_get(ef,"spread",0.0),3),
                "color": hex_, "alpha": _round(a,4),
                "blendMode": _get(ef, "blendMode")
            })
        elif t in ("LAYER_BLUR", "BACKGROUND_BLUR"):
            out.append({"type": t, "radius": _round(_get(ef,"radius",0.0),3)})
        else:
            out.append({"type": t, "raw": ef})
    return out

# ────────────────────────────────────────────────────────────────────────────
# Layout och constraints
# ────────────────────────────────────────────────────────────────────────────

def _align_map_primary(v: str) -> str:
    return {"MIN":"flex-start","CENTER":"center","MAX":"flex-end","SPACE_BETWEEN":"space-between"}.get(v or "MIN","flex-start")

def _align_map_counter(v: str) -> str:
    return {"MIN":"flex-start","CENTER":"center","MAX":"flex-end","BASELINE":"baseline","STRETCH":"stretch"}.get(v or "MIN","flex-start")

def _overflow_from_node(node: Dict[str, Any]) -> str:
    return "hidden" if _bool(_get(node,"clipsContent"), False) else "visible"

def _layout_to_ir(node: Dict[str, Any]) -> Dict[str, Any]:
    mode = _get(node,"layoutMode","NONE")
    gap = _to_float(_get(node,"itemSpacing",0.0)) or 0.0
    pad = {"t":_to_float(_get(node,"paddingTop",0.0)) or 0.0,
           "r":_to_float(_get(node,"paddingRight",0.0)) or 0.0,
           "b":_to_float(_get(node,"paddingBottom",0.0)) or 0.0,
           "l":_to_float(_get(node,"paddingLeft",0.0)) or 0.0}
    wrap = _get(node,"layoutWrap") == "WRAP"
    primary = str(_get(node,"primaryAxisSizingMode","FIXED") or "FIXED")
    counter = str(_get(node,"counterAxisSizingMode","FIXED") or "FIXED")
    align_primary = _align_map_primary(str(_get(node,"primaryAxisAlignItems","MIN") or "MIN"))
    align_counter = _align_map_counter(str(_get(node,"counterAxisAlignItems","MIN") or "MIN"))
    return {"mode": mode, "gap": gap, "padding": pad, "wrap": wrap,
            "sizing":{"primary":primary,"counter":counter},
            "align_items": align_counter, "justify_content": align_primary}

def _constraints(node: Dict[str, Any]) -> Dict[str, str]:
    c = _get(node,"constraints",{}) or {}
    return {"horizontal": str(_get(c,"horizontal","LEFT") or "LEFT"),
            "vertical":   str(_get(c,"vertical","TOP") or "TOP")}

def _is_absolute(node: Dict[str, Any]) -> bool:
    return _get(node, "layoutPositioning") == "ABSOLUTE"

# ────────────────────────────────────────────────────────────────────────────
# Text
# ────────────────────────────────────────────────────────────────────────────

def _text_ir(node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if _get(node,"type") != "TEXT": return None
    raw_chars = _get(node,"characters","") or ""
    content = _canon_text(raw_chars)
    lines = _canon_text_lines(raw_chars)

    st = node.get("style",{}) or {}

    lh_px = st.get("lineHeightPx")
    line_height = _px(lh_px) if lh_px is not None and _is_num(lh_px) else None

    letter_spacing = st.get("letterSpacing")
    if isinstance(letter_spacing,(int,float)):
        ls = f"{_round(letter_spacing,2)}px"
    elif isinstance(letter_spacing,dict) and "value" in letter_spacing:
        v = _to_float(letter_spacing.get("value")) or 0.0
        unit = str(letter_spacing.get("unit","PERCENT"))
        ls = f"{_round(v,2)}%" if unit == "PERCENT" else f"{_round(v,2)}px"
    else:
        ls = None

    align = {"LEFT":"left","CENTER":"center","RIGHT":"right","JUSTIFIED":"justify"}.get(str(st.get("textAlignHorizontal") or ""), None)

    deco = st.get("textDecoration")
    if   deco == "UNDERLINE":      text_decoration = "underline"
    elif deco == "STRIKETHROUGH":  text_decoration = "line-through"
    else:                          text_decoration = None

    tf = st.get("textCase")
    text_transform = {"UPPER":"uppercase","LOWER":"lowercase","TITLE":"capitalize"}.get(str(tf), None)

    weight = st.get("fontWeight")
    if weight is None:
        style_name = (st.get("fontName") or {}).get("style","").lower()
        if   "bold"   in style_name: weight = 700
        elif "semi"   in style_name: weight = 600
        elif "medium" in style_name: weight = 500
        else: weight = 400

    # Textfärg: första synliga SOLID med sammanslagen alpha
    color_val: Optional[str] = None
    fills_any = node.get("fills") or []
    if isinstance(fills_any, list):
        for p in fills_any:
            if isinstance(p, dict) and p.get("type")=="SOLID" and _bool(p.get("visible",True), True):
                hex_, a_col = _rgba_hex(cast(Dict[str, Any], p.get("color", {})))
                a_paint = _to_float(p.get("opacity")) or 1.0
                a = _combine_alpha(a_col, a_paint)
                if a >= 0.999:
                    color_val = hex_
                else:
                    r = int(hex_[1:3],16); g = int(hex_[3:5],16); b = int(hex_[5:7],16)
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
# Tailwind-syntes (deterministisk)
# ────────────────────────────────────────────────────────────────────────────

def _tw_required_for_node(n: Dict[str, Any]) -> List[str]:
    tw: List[str] = []

    # Geometri
    b = n.get("bounds_rel") or n.get("bounds") or {}
    if _is_num(b.get("w")): tw.append(f"w-[{_px(b.get('w'))}]")
    if _is_num(b.get("h")): tw.append(f"h-[{_px(b.get('h'))}]")

    if _bool(n.get("abs"), False):
        tw.append("absolute")
        if _is_num(b.get("x")): tw.append(f"left-[{_px(b.get('x'))}]")
        if _is_num(b.get("y")): tw.append(f"top-[{_px(b.get('y'))}]")
    else:
        tw.append("relative")

    # Overflow/clip
    if n.get("overflow") in ("hidden","clip"):
        tw.append("overflow-hidden")

    # Layout-hints (auto layout → flex)
    lay = cast(Dict[str, Any], n.get("layout") or {})
    if lay.get("mode") in ("HORIZONTAL","VERTICAL"):
        tw.append("flex")
        tw.append("flex-row" if lay["mode"]=="HORIZONTAL" else "flex-col")
        gap = lay.get("gap",0)
        if _is_num(gap) and (gap or 0) > 0: tw.append(f"gap-[{_px(gap)}]")
        pad = cast(Dict[str, Any], lay.get("padding") or {})
        for k,twk in (("t","pt"),("r","pr"),("b","pb"),("l","pl")):
            pv = _to_float(pad.get(k)) or 0.0
            if pv: tw.append(f"{twk}-[{_px(pv)}]")
        if lay.get("align_items"):
            m = {"flex-start":"items-start","center":"items-center",
                 "flex-end":"items-end","stretch":"items-stretch","baseline":"items-baseline"}
            v = m.get(lay["align_items"]);  tw.append(v) if v else None
        if lay.get("justify_content"):
            m = {"flex-start":"justify-start","center":"justify-center","flex-end":"justify-end","space-between":"justify-between"}
            v = m.get(lay["justify_content"]); tw.append(v) if v else None
        if _bool(lay.get("wrap"), False): tw.append("flex-wrap")

    # Fills → text-färg för TEXT, annars bg från IR.bg
    if n.get("type") == "TEXT":
        st = (n.get("text") or {}).get("style") or {}
        col = st.get("color")
        if col:
            if col.startswith("rgba("): tw.append(f"text-[{col}]")
            else:                       tw.append(f"text-[{col}]")
    else:
        bg = n.get("bg")
        if isinstance(bg, dict):
            t = str(bg.get("type") or "")
            if t == "SOLID" and bg.get("color"):
                a = _to_float(bg.get("alpha")) or 1.0
                if a >= 0.999:
                    tw.append(f"bg-[{bg['color']}]")
                else:
                    c = bg["color"]; r=int(c[1:3],16); g=int(c[3:5],16); b_=int(c[5:7],16)
                    tw.append(f"bg-[rgba({r}, {g}, {b_}, {a})]")
            elif t == "GRADIENT" and (bg.get("css")):
                tw.append(f"bg-[{bg['css']}]")

    # Border
    strokes = n.get("strokes") or []
    if strokes:
        s0 = strokes[0]
        if s0.get("type")=="SOLID" and s0.get("color"):
            w = s0.get("weight")
            if _is_num(w): tw.append(f"border-[{_px(w)}]")
            else:          tw.append("border")
            tw.append(f"border-[{s0['color']}]")

    # Corner radius
    r = n.get("radius") or {}
    tl,tr,br,bl = r.get("tl",0), r.get("tr",0), r.get("br",0), r.get("bl",0)
    if any([tl,tr,br,bl]):
        if tl==tr==br==bl:
            tw.append(f"rounded-[{_px(tl)}]")
        else:
            if tl: tw.append(f"rounded-tl-[{_px(tl)}]")
            if tr: tw.append(f"rounded-tr-[{_px(tr)}]")
            if br: tw.append(f"rounded-br-[{_px(br)}]")
            if bl: tw.append(f"rounded-bl-[{_px(bl)}]")

    # Shadows
    css = n.get("css") or {}
    if css.get("boxShadow"):
        tw.append(f"shadow-[{css['boxShadow']}]")

    # Opacity
    if _is_num(n.get("opacity")) and (_to_float(n.get("opacity")) or 1.0) < 1:
        tw.append(f"opacity-[{_to_float(n.get('opacity')) or 1.0}]")

    # Rotation
    rot = n.get("rotation")
    if _is_num(rot) and abs((_to_float(rot) or 0.0)) > 0.001:
        tw.append(f"rotate-[{_round((_to_float(rot) or 0.0),2)}deg]")

    # z-index
    if _is_num(n.get("z")):
        tw.append(f"z-[{int(_to_float(n.get('z')) or 0)}]")

    # Normalisering
    seen: set[str] = set()
    out: List[str] = []
    for t in tw:
        if t and t not in seen:
            seen.add(t); out.append(t)

    if "absolute" in out and "relative" in out:
        out = [t for t in out if t != "relative"]

    # border + border-[Xpx] → behåll explicit bredd
    has_explicit_border_w = any(t.startswith("border-[") and t.endswith("px]") for t in out)
    if has_explicit_border_w and "border" in out:
        out = [t for t in out if t != "border"]

    return out

# ────────────────────────────────────────────────────────────────────────────
# Ikon-hints
# ────────────────────────────────────────────────────────────────────────────

_ICON_TYPES = {"VECTOR","BOOLEAN_OPERATION","ELLIPSE","RECTANGLE","LINE","REGULAR_POLYGON","STAR"}
_CONTAINERS = {"GROUP","INSTANCE","COMPONENT","COMPONENT_SET","FRAME"}

def _slug(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "icon"

def _aspect_ok(w: float, h: float) -> bool:
    if w <= 0 or h <= 0: return False
    r = w / h
    return ICON_AR_MIN <= r <= ICON_AR_MAX

def _has_text_desc(n: Dict[str, Any]) -> bool:
    if (n.get("type") == "TEXT") and bool(n.get("visible_effective", True)): return True
    for ch in n.get("children") or []:
        if _has_text_desc(ch): return True
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

    # dominant färg (fill eller stroke)
    hex_col = None; alpha = 1.0
    fills = node.get("fills") or []
    for p in fills:
        if p.get("type")=="SOLID" and _bool(p.get("visible",True), True) and p.get("color"):
            hex_col = p["color"]; alpha = float(p.get("alpha",1.0) or 1.0); break
    if not hex_col:
        for s in node.get("strokes") or []:
            if s.get("type")=="SOLID" and _bool(s.get("visible",True), True) and s.get("color"):
                hex_col = s["color"]; alpha = float(s.get("alpha",1.0) or 1.0); break

    tintable = bool(is_icon and hex_col)

    return {
        "is_icon": is_icon,
        "name": name,
        "name_slug": _slug(name),
        "type": t,
        "bounds": b,
        "dominant_color": hex_col,
        "dominant_alpha": alpha,
        "tintable": tintable,
        "rotation": _round(_get(node,"rotation",0.0),3),
    }

# ────────────────────────────────────────────────────────────────────────────
# CSS sammanställning (för skugga mm., används till TW)
# ────────────────────────────────────────────────────────────────────────────

def _css_from_node(n: Dict[str, Any]) -> Dict[str, Any]:
    css: Dict[str, Any] = {}

    # Box-shadow från effects
    shadows: List[str] = []
    for ef in (n.get("effects") or []):
        if ef.get("type") in ("DROP_SHADOW","INNER_SHADOW"):
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

    return css

# ────────────────────────────────────────────────────────────────────────────
# Traversering till IR
# ────────────────────────────────────────────────────────────────────────────

def _node_to_ir(doc_node: Dict[str, Any], *,
                root_origin: Tuple[float,float],
                inherited_clip: Optional[Dict[str, float]],
                inherited_visible: bool,
                _z: int,
                _is_root: bool) -> Dict[str, Any]:
    bounds_abs = _bounds(doc_node)
    rx, ry = root_origin
    bounds_rel = {
        "x": cast(float, _round(bounds_abs["x"] - rx, 3)),
        "y": cast(float, _round(bounds_abs["y"] - ry, 3)),
        "w": bounds_abs["w"], "h": bounds_abs["h"]
    }

    own_visible = _bool(doc_node.get("visible"), True)
    opacity = _round(_get(doc_node,"opacity",1.0),4) or 1.0
    clips_here = _clips_content(doc_node)
    next_clip = _rect_intersect(inherited_clip, bounds_abs) if clips_here else inherited_clip

    prelim = {"visible": own_visible, "opacity": opacity, "bounds": bounds_abs}
    eff_visible = _effectively_visible(prelim, inherited_clip, inherited_visible)

    fills_eff = _effective_fills(doc_node)
    bg_eff = _bg_from_effective_fills(fills_eff)
    strokes, stroke_align = _stroke_to_ir(doc_node)
    radius = _radius_to_ir(doc_node)
    effects = _effects_to_ir(doc_node)
    text = _text_ir(doc_node)
    abspos = _is_absolute(doc_node)
    l = _layout_to_ir(doc_node)
    cons = _constraints(doc_node)
    ov = _overflow_from_node(doc_node)
    rot = _round(_get(doc_node,"rotation",0.0),3)

    ir: Dict[str, Any] = {
        "id": _safe_name(doc_node.get("id")),
        "name": _safe_name(doc_node.get("name")),
        "type": _safe_name(doc_node.get("type")),
        "visible": own_visible,
        "visible_effective": bool(eff_visible),
        "abs": abspos,
        "bounds": bounds_abs,
        "bounds_rel": bounds_rel,
        "layout": l,
        "constraints": cons,
        "fills": fills_eff,
        "bg": bg_eff,                     # ← explicit bakgrund från begränsade backgrounds
        "strokes": strokes,
        "stroke_alignment": stroke_align if strokes else "NONE",
        "radius": radius,
        "effects": effects,
        "opacity": opacity,
        "blend_mode": doc_node.get("blendMode"),
        "clips_content": clips_here,
        "overflow": ov,
        "text": text,
        "rotation": rot,
        "z": _z,
        "children": [],
        "is_root": _is_root,
        "paints_raw": {
            "fills": _get(doc_node,"fills",[]),
            "background": _get(doc_node,"background"),
            "backgrounds": _get(doc_node,"backgrounds"),
            "backgroundColor": _get(doc_node,"backgroundColor"),
        },
    }

    # CSS & TW
    ir["css"] = _css_from_node(ir)
    tw_classes = _tw_required_for_node(ir)
    ir["tw"]  = {"classes": " ".join(tw_classes), "list": tw_classes}

    # Ikon-hint
    try:
        ih = _icon_hint({"bounds": bounds_abs, **ir})
        ir["icon"] = ih
    except Exception:
        ir["icon"] = {"is_icon": False}

    # Barn i z-ordning (originalordning)
    for i, ch in enumerate(doc_node.get("children") or []):
        ir["children"].append(
            _node_to_ir(ch, root_origin=root_origin, inherited_clip=next_clip,
                        inherited_visible=eff_visible, _z=i, _is_root=False)
        )

    # Mini-logg för root BG
    if _is_root:
        bg_desc = "none"
        if isinstance(bg_eff, dict):
            t = str(bg_eff.get("type") or "")
            if t == "SOLID" and (bg_eff.get("alpha") or 0) > 0.001 and bg_eff.get("color"):
                bg_desc = bg_eff.get("color")
            elif t == "GRADIENT":
                bg_desc = "gradient"
        else:
            for f in (fills_eff or []):
                if not _bool(f.get("visible",True), True): continue
                t = str(f.get("type") or "")
                if t == "SOLID" and f.get("color") and (_to_float(f.get("alpha")) or 1.0) > 0.001:
                    bg_desc = f.get("color"); break
                if t.startswith("GRADIENT_") and (f.get("stops") or []):
                    bg_desc = "gradient"; break
        _minlog("bg.root.summary", resolved=bg_desc)

    # Per-nod trace
    if TRACE_NODES:
        try:
            _minlog(
                "ir.node",
                id=ir["id"],
                type=ir["type"],
                bounds_abs=bounds_abs,
                bounds_rel=bounds_rel,
                visible_effective=bool(eff_visible),
                bg=ir["bg"],
                text=(ir["text"] or {}).get("style") if ir.get("text") else None,
                strokes=len(strokes),
                effects=len(effects),
                layout=ir["layout"],
                abs=ir["abs"]
            )
        except Exception:
            pass

    # NYTT: sista skydd – inga oavsiktliga bg på wrappers som inte clippar och saknar fills
    if not clips_here and not fills_eff and ir.get("bg") and ir["type"] in ("GROUP", "INSTANCE"):
        ir["bg"] = None

    return ir

# ────────────────────────────────────────────────────────────────────────────
# Publikt API
# ────────────────────────────────────────────────────────────────────────────

def figma_to_ir(figma_json: Dict[str, Any], node_id: str) -> Dict[str, Any]:
    """Lossless IR: viewport = root-bounds, koordinater är root-relativa, ingen destruktiv pruning."""
    # Hämta document för node_id
    nodes = (figma_json.get("nodes") or {})
    doc: Optional[Dict[str, Any]] = None
    if node_id in nodes and "document" in nodes[node_id]:
        doc = nodes[node_id]["document"]
    else:
        for v in nodes.values():
            if "document" in v:
                doc = v["document"]; break
    if doc is None:
        raise ValueError("Kunde inte hitta 'document' i nodes-payloaden.")

    root_bounds = _bounds(doc)

    # NYTT: startlogg
    _minlog("ir.build.start", node_id=node_id, root_bounds=root_bounds)

    clip = dict(root_bounds)  # viewport = root-bounds
    _minlog("clip.config", strict=False, clip=clip)

    root_origin = (root_bounds["x"], root_bounds["y"])
    root_ir = _node_to_ir(doc, root_origin=root_origin, inherited_clip=clip,
                          inherited_visible=True, _z=0, _is_root=True)

    # Stabil z/order
    def _reindex(n: Dict[str, Any]):
        for i,ch in enumerate(n.get("children") or []):
            ch["z"] = i
            by = int(round((ch.get("bounds",{}).get("y") or 0)))
            bx = int(round((ch.get("bounds",{}).get("x") or 0)))
            ch["order"] = i
            ch["order_key"] = [by, bx, i]
            _reindex(ch)
    _reindex(root_ir)

    meta = {
        "nodeId": node_id,
        "viewport": {"w": int(round(root_bounds["w"])), "h": int(round(root_bounds["h"]))},
        "mountOffset": {"x": 0, "y": 0},
        "schemaVersion": 5,
        "producedBy": "figma_ir.py(lossless)"
    }
    out = {"meta": meta, "root": root_ir}

    # NYTT: slutlogg
    try:
        _minlog("ir.build.done", meta=meta, totals={"nodes": len(json.dumps(root_ir))})
    except Exception:
        pass

    return out

def filter_visible_ir(ir_full: Dict[str, Any]) -> Dict[str, Any]:
    """
    Försiktig filtrering: ta bort endast noder som är *bevisligen* osynliga och saknar barns-inverkan.
    Behåll wrappers som bär fill/stroke/effect/clip eller har synliga barn.
    """
    def contributes(n: Dict[str, Any]) -> bool:
        if bool(n.get("visible_effective", True)) and (
            (n.get("type")=="TEXT" and (n.get("text") or {}).get("content")) or
            (n.get("fills")) or (n.get("effects")) or (n.get("strokes")) or
            _clips_content(n)
        ):
            return True
        return False

    def prune(n: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        kids: List[Dict[str, Any]] = []
        for ch in n.get("children") or []:
            p = prune(ch)
            if p is not None:
                kids.append(p)

        eff = bool(n.get("visible_effective", True))
        keep = eff or len(kids) > 0 or contributes(n)
        if not keep:
            return None

        nn = deepcopy(n)
        nn["children"] = kids
        return nn

    root_in = ir_full["root"]
    root_out = prune(root_in) or deepcopy(root_in)

    # reindex
    def _reindex(n: Dict[str, Any]):
        for i,ch in enumerate(n.get("children") or []):
            ch["z"] = i
            by = int(round((ch.get("bounds",{}).get("y") or 0)))
            bx = int(round((ch.get("bounds",{}).get("x") or 0)))
            ch["order"] = i
            ch["order_key"] = [by, bx, i]
            _reindex(ch)
    _reindex(root_out)

    return {"meta": ir_full["meta"], "root": root_out}

# ────────────────────────────────────────────────────────────────────────────
# Hjälp-API som pipeline förväntar sig
# ────────────────────────────────────────────────────────────────────────────

def build_tailwind_map(ir_node: Dict[str, Any]) -> Dict[str, str]:
    tw_map: Dict[str, str] = {}
    def rec(n: Dict[str, Any]):
        nid = n.get("id") or ""
        tw = (n.get("tw") or {}).get("classes", "")
        tw_map[nid] = tw
        for ch in n.get("children", []):
            rec(ch)
    rec(ir_node)
    return tw_map

def build_css_map(ir_node: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
    css_map: Dict[str, Dict[str, str]] = {}
    def rec(n: Dict[str, Any]):
        nid = n.get("id") or ""
        raw = n.get("css", {}) or {}
        css_map[nid] = {k: str(v) for k,v in raw.items()}
        for ch in n.get("children", []):
            rec(ch)
    rec(ir_node)
    return css_map

def collect_image_refs(ir_node: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    def rec(n: Dict[str, Any]):
        if not bool(n.get("visible_effective", True)): return
        for f in n.get("fills", []):
            if f.get("type")=="IMAGE" and f.get("imageRef"):
                out.append(f.get("imageRef"))
        for ch in n.get("children", []):
            rec(ch)
    rec(ir_node)
    seen = set(); uniq: List[str] = []
    for r in out:
        if r not in seen:
            seen.add(r); uniq.append(r)
    return uniq

def collect_icon_nodes(ir_node: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Synliga ikon-noder i IR-trädet utan dubbletter.
    - Leaf-ikon: node.icon.is_icon == True och visible_effective == True.
    - Container-ikon: 1–8 synliga vektor-leaves, typiska mått och aspekt, ingen text.
    """
    out: List[Dict[str, Any]] = []

    def _visible(n: Dict[str, Any]) -> bool:
        return bool(n.get("visible_effective", True))

    def _gather_vector_leaves(n: Dict[str, Any], acc: List[Dict[str, Any]], depth: int = 0, max_depth: int = 5):
        if depth > max_depth: return
        if not _visible(n): return
        t = n.get("type")
        ch = n.get("children") or []
        if t in _ICON_TYPES and not ch:
            b = n.get("bounds") or {}
            if isinstance(b, dict) and (b.get("w",0)*b.get("h",0)) >= 4:
                acc.append(n); return
        for c in ch: _gather_vector_leaves(c, acc, depth+1, max_depth)

    def rec(n: Dict[str, Any]):
        if not _visible(n): return
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
                _aspect_ok(w, h) and not _has_text_desc(n) and (w*h) >= 4):
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
                _aspect_ok(w, h) and not _has_text_desc(n) and (w*h) >= 4):
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
