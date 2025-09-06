# backend/tasks/figma_proxy.py
from io import BytesIO
import os
from typing import Any, Optional, Tuple, Dict, cast

import requests
from requests.exceptions import RequestException
from fastapi import HTTPException
from fastapi.responses import Response
from PIL import Image, ImageCms  # Kräver Pillow; för färghantering krävs lcms2 i OS
import logging

# ── Intent-typ för Pillow/Pylance ───────────────────────────────────────────
_INTENT_PERCEPTUAL: Any
try:
    from PIL.ImageCms import Intent as _Intent  # type: ignore
    _INTENT_PERCEPTUAL = _Intent.PERCEPTUAL
except Exception:
    _INTENT_PERCEPTUAL = getattr(ImageCms, "INTENT_PERCEPTUAL", 0)

# ── Konfiguration via env ───────────────────────────────────────────────────
FIGMA_PAT = os.getenv("FIGMA_TOKEN")               # Personal Access Token
FIGMA_OAUTH = os.getenv("FIGMA_OAUTH_TOKEN")       # OAuth-access token (valfritt)

ASSUME_P3_IF_NO_ICC = os.getenv("ASSUME_P3_IF_NO_ICC", "1") == "1"
P3_ICC_PATH = os.getenv("P3_ICC_PATH", "backend/color/DisplayP3.icc")

# Flatten-policy:
# - AUTO_FLATTEN_WITH_NODE_BG: om PNG har alfa och vi hittar en solid bakgrund på noden via Nodes API => flatten mot den
# - FALLBACK_FLATTEN_BG: hex (#RRGGBB), används om AUTO misslyckas men vi ändå vill undvika vit-blandning
AUTO_FLATTEN_WITH_NODE_BG = os.getenv("AUTO_FLATTEN_WITH_NODE_BG", "1") == "1"
FALLBACK_FLATTEN_BG = os.getenv("FALLBACK_FLATTEN_BG", "")  # t.ex. "#E5E5E5" för Figma-lik canvas

logger = logging.getLogger("figma_proxy")

def _mask_token(t: Optional[str]) -> str:
    if not t:
        return ""
    return (t[:4] + "…") if len(t) > 4 else "…"

# ── Hjälpare ────────────────────────────────────────────────────────────────
def _auth_headers(token_override: Optional[str] = None) -> Dict[str, str]:
    """
    Föredra token från anropet om angiven, annars env (OAuth först, sedan PAT).
    Vi skickar både Authorization och X-Figma-Token för kompatibilitet.
    """
    if token_override:
        logger.info("_auth_headers med override %s", _mask_token(token_override))
        return {
            "Authorization": f"Bearer {token_override}",
            "X-Figma-Token": token_override,
        }
    if FIGMA_OAUTH:
        logger.info("_auth_headers använder FIGMA_OAUTH %s", _mask_token(FIGMA_OAUTH))
        return {"Authorization": f"Bearer {FIGMA_OAUTH}"}
    if FIGMA_PAT:
        logger.info("_auth_headers använder FIGMA_PAT %s", _mask_token(FIGMA_PAT))
        return {"X-Figma-Token": str(FIGMA_PAT)}
    raise HTTPException(500, "Ingen Figma-token konfigurerad (FIGMA_TOKEN eller FIGMA_OAUTH_TOKEN).")

def _parse_hex_rgb(s: str) -> Optional[Tuple[int, int, int]]:
    s = s.strip()
    if not s:
        return None
    if s.startswith("#"):
        s = s[1:]
    if len(s) == 3:
        # #RGB → #RRGGBB
        try:
            r = int(s[0]*2, 16)
            g = int(s[1]*2, 16)
            b = int(s[2]*2, 16)
            return (r, g, b)
        except ValueError:
            return None
    if len(s) == 6:
        try:
            r = int(s[0:2], 16)
            g = int(s[2:4], 16)
            b = int(s[4:6], 16)
            return (r, g, b)
        except ValueError:
            return None
    return None

def _figma_image_url(file_key: str, node_id: str, scale: str, token: Optional[str] = None) -> str:
    """
    Hämtar presignad bild-URL från Figma Images API för given node.
    """
    u = f"https://api.figma.com/v1/images/{file_key}"
    params = {
        "ids": node_id,
        "format": "png",
        "use_absolute_bounds": "true",
        "scale": scale or "2",
    }
    logger.info("Hämtar Figma image-URL för %s/%s", file_key, node_id)
    try:
        r = requests.get(u, headers=_auth_headers(token), params=params, timeout=15)
    except RequestException as e:
        logger.error("figma images nätverksfel: %s", e)
        raise HTTPException(502, f"figma images nätverksfel: {e}")
    if r.status_code != 200:
        logger.error("figma images error %s: %s", r.status_code, r.text)
        raise HTTPException(502, f"figma images error {r.status_code}: {r.text}")

    try:
        j = r.json()
    except ValueError:
        logger.error("figma images svarade inte med giltig JSON")
        raise HTTPException(502, "figma images svarade inte med giltig JSON")

    url = (j.get("images") or {}).get(node_id)
    if not url:
        logger.error("figma images saknar image-url för angiven node")
        raise HTTPException(502, "figma images saknar image-url för angiven node (fel nodeId eller åtkomst).")
    logger.info("Figma image-URL hämtad: %s", url)
    return url

def _figma_node_bg_color(file_key: str, node_id: str, token: Optional[str]) -> Optional[Tuple[int, int, int]]:
    """
    Försök läsa ut en "solid" bakgrundsfärg för noden via Nodes API.
    Prioritet:
      1) Frame/Component/Instance: första synliga SOLID fill på noden (tolkas som bakgrund).
      2) Canvas (page) background om noden råkar vara canvas (ovanligt här).
    Returnerar (R, G, B) i 0..255 om hittad, annars None.
    """
    logger.info("Hämtar nodens bakgrundsfärg för %s/%s", file_key, node_id)
    try:
        u = f"https://api.figma.com/v1/files/{file_key}/nodes"
        r = requests.get(u, headers=_auth_headers(token), params={"ids": node_id}, timeout=15)
    except RequestException as e:
        logger.warning("nodes nätverksfel: %s", e)
        return None

    if r.status_code != 200:
        logger.warning("nodes svar %s", r.status_code)
        return None

    try:
        data = r.json()
    except ValueError:
        logger.warning("nodes ogiltig JSON")
        return None

    nodes = (data.get("nodes") or {}).get(node_id) or {}
    doc = nodes.get("document") or {}
    node_type = doc.get("type", "")

    # Hjälpare för Figma färg (0..1) → 0..255
    def _conv(c: Dict[str, Any]) -> Tuple[int, int, int]:
        return (
            int(round(float(c.get("r", 0)) * 255)),
            int(round(float(c.get("g", 0)) * 255)),
            int(round(float(c.get("b", 0)) * 255)),
        )

    # 1) Leta efter SOLID fill i 'fills' om synlig
    fills = doc.get("fills") or []
    for f in fills:
        if not f.get("visible", True):
            continue
        if f.get("type") == "SOLID":
            col = f.get("color")
            if isinstance(col, dict):
                col_conv = _conv(col)
                logger.info("Nodens SOLID bakgrund: %s", col_conv)
                return col_conv

    # 2) Canvas/page background
    if node_type == "CANVAS":
        bgs = doc.get("background") or []
        for bg in bgs:
            if not bg.get("visible", True):
                continue
            if bg.get("type") == "SOLID" and isinstance(bg.get("color"), dict):
                col_conv = _conv(bg["color"])
                logger.info("Canvas bakgrund: %s", col_conv)
                return col_conv

    return None

def _to_srgb_png(src_bytes: bytes) -> Image.Image:
    """
    Laddar PNG och konverterar färgprofil till sRGB, bevarar alfa.
    Returnerar PIL Image (RGBA).
    """
    im = Image.open(BytesIO(src_bytes))
    im.load()

    # Spara alfa separat om den finns
    alpha: Optional[Image.Image] = None
    if im.mode in ("RGBA", "LA"):
        alpha = im.getchannel("A")

    # Basbild i RGB för färgkonvertering
    base = im.convert("RGB")

    dst_profile = ImageCms.createProfile("sRGB")
    src_icc = base.info.get("icc_profile") or im.info.get("icc_profile")

    if src_icc:
        src_prof = ImageCms.ImageCmsProfile(BytesIO(src_icc))
        conv = ImageCms.profileToProfile(
            base,
            src_prof,
            dst_profile,
            outputMode="RGB",
            renderingIntent=_INTENT_PERCEPTUAL,
        )
        base = cast(Image.Image, conv)
    else:
        if ASSUME_P3_IF_NO_ICC and os.path.exists(P3_ICC_PATH):
            with open(P3_ICC_PATH, "rb") as f:
                p3 = f.read()
            p3_prof = ImageCms.ImageCmsProfile(BytesIO(p3))
            conv = ImageCms.profileToProfile(
                base,
                p3_prof,
                dst_profile,
                outputMode="RGB",
                renderingIntent=_INTENT_PERCEPTUAL,
            )
            base = cast(Image.Image, conv)
        # annars antar vi sRGB redan

    # Återinfoga alfa eller skapa RGBA
    if alpha is not None:
        base = Image.merge("RGBA", (*base.split(), alpha))
    else:
        base = base.convert("RGBA")

    return base

def _flatten_if_needed(img_rgba: Image.Image, bg_rgb: Optional[Tuple[int, int, int]]) -> Image.Image:
    """
    Flatten:ar mot angiven bakgrundsfärg om bilden innehåller någon transparens.
    Om bg_rgb är None → ingen flatten.
    """
    if img_rgba.mode != "RGBA":
        img_rgba = img_rgba.convert("RGBA")

    alpha = img_rgba.getchannel("A")
    if alpha is None:
        return img_rgba

    # Kontrollera om någon pixel är <255 (dvs. genomskinlig/semitransparent)
    extrema = alpha.getextrema()
    if not extrema:
        return img_rgba
    if extrema[0] == 255 and extrema[1] == 255:
        # helt opak redan
        return img_rgba

    if bg_rgb is None:
        return img_rgba  # policy: endast flatten om bakgrund finns

    background = Image.new("RGBA", img_rgba.size, (bg_rgb[0], bg_rgb[1], bg_rgb[2], 255))
    background.paste(img_rgba, (0, 0), mask=alpha)
    return background

def _image_bytes(img: Image.Image) -> bytes:
    out = BytesIO()
    # PNG blir opak om vi har flatten:at; annars behåller vi RGBA
    img.save(out, format="PNG", optimize=True, compress_level=9)
    return out.getvalue()

# ── Publik route-funktion ───────────────────────────────────────────────────
# app.add_api_route("/api/figma-image", figma_image, methods=["GET"])
def figma_image(
    fileKey: str,
    nodeId: str,
    scale: str = "2",
    token: Optional[str] = None,
    # Valfria overrides via query:
    #   flatten= "0"/"1"  -> tvinga av/på flatten
    #   bg= "#RRGGBB"     -> tvinga bakgrundsfärg
    flatten: Optional[str] = None,
    bg: Optional[str] = None,
):
    logger.info(
        "figma_image start fileKey=%s nodeId=%s scale=%s token=%s",
        fileKey,
        nodeId,
        scale,
        _mask_token(token),
    )
    # Säkerställ att vi har någon form av token
    _ = _auth_headers(token)  # kastar 500 om saknas

    # 1) Hämta bild-URL för node
    logger.info("Steg 1: hämta image-URL")
    url = _figma_image_url(fileKey, nodeId, scale, token)

    # 2) Ladda bildbytes
    logger.info("Steg 2: hämta bildbytes från %s", url)
    try:
        r = requests.get(url, timeout=30)
    except RequestException as e:
        logger.error("image fetch nätverksfel: %s", e)
        raise HTTPException(502, f"image fetch nätverksfel: {e}")

    if r.status_code != 200:
        logger.error("image fetch error %s", r.status_code)
        raise HTTPException(502, f"image fetch error {r.status_code}")

    # 3) Konvertera till sRGB + RGBA
    logger.info("Steg 3: konverterar till sRGB")
    try:
        img = _to_srgb_png(r.content)
    except Exception as e:
        logger.error("convert error: %s", e)
        raise HTTPException(500, f"convert error: {e}")

    # 4) Bestäm flatten-policy
    logger.info("Steg 4: bestämmer flatten-policy")
    #    a) Om query 'bg' finns → använd den
    #    b) Annars om AUTO_FLATTEN_WITH_NODE_BG → försök hämta nodens bakgrund via Nodes API
    #    c) Annars env FALLBACK_FLATTEN_BG
    forced_bg = _parse_hex_rgb(bg) if bg else None
    node_bg: Optional[Tuple[int, int, int]] = None
    if forced_bg is not None:
        selected_bg = forced_bg
    else:
        selected_bg = None
        if AUTO_FLATTEN_WITH_NODE_BG:
            node_bg = _figma_node_bg_color(fileKey, nodeId, token)
            if node_bg is not None:
                selected_bg = node_bg
        if selected_bg is None and FALLBACK_FLATTEN_BG:
            fb = _parse_hex_rgb(FALLBACK_FLATTEN_BG)
            if fb is not None:
                selected_bg = fb

    # Tolka explicit flatten-override
    # - flatten="1" → flatten även om ingen bg hittades? (endast om vi också har bg från bg/FALLBACK)
    # - flatten="0" → aldrig flatten
    if flatten == "0":
        selected_bg = None  # hedrar explicit "ingen flatten"
    logger.info("Bakgrundsval: forced=%s node_bg=%s selected=%s", forced_bg, node_bg, selected_bg)

    # 5) Flatten om nödvändigt (dvs. om PNG har alfa <255 någonstans) och vi har en bakgrund
    logger.info("Steg 5: flatten om nödvändigt, bg=%s", selected_bg)
    img = _flatten_if_needed(img, selected_bg)

    # 6) Svara med PNG-bytes
    logger.info("Steg 6: svarar med PNG %dx%d", img.width, img.height)
    headers = {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    return Response(content=_image_bytes(img), headers=headers)
