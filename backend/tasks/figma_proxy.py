# backend/tasks/figma_proxy.py
from io import BytesIO
import os
from typing import Any, Optional, cast

import requests
from requests.exceptions import RequestException
from fastapi import HTTPException
from fastapi.responses import Response
from PIL import Image, ImageCms  # kräver Pillow; för färghantering krävs lcms2 i OS

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


def _auth_headers() -> dict:
    """
    Föredra OAuth Bearer om satt, annars PAT via X-Figma-Token.
    """
    if FIGMA_OAUTH:
        return {"Authorization": f"Bearer {FIGMA_OAUTH}"}
    if FIGMA_PAT:
        return {"X-Figma-Token": str(FIGMA_PAT)}
    raise HTTPException(500, "Ingen Figma-token konfigurerad (FIGMA_TOKEN eller FIGMA_OAUTH_TOKEN).")


def _figma_image_url(file_key: str, node_id: str, scale: str) -> str:
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
    try:
        r = requests.get(u, headers=_auth_headers(), params=params, timeout=15)
    except RequestException as e:
        raise HTTPException(502, f"figma images nätverksfel: {e}")
    if r.status_code != 200:
        # Vid t.ex. 403/404: lyft upp feltexten för felsökning
        raise HTTPException(502, f"figma images error {r.status_code}: {r.text}")

    try:
        j = r.json()
    except ValueError:
        raise HTTPException(502, "figma images svarade inte med giltig JSON")

    url = (j.get("images") or {}).get(node_id)
    if not url:
        # Figma returnerar null om ingen bild kunde genereras (fel id/åtkomst)
        raise HTTPException(502, "figma images saknar image-url för angiven node (fel nodeId eller åtkomst).")
    return url


def _to_srgb_png(src_bytes: bytes) -> bytes:
    """
    Laddar PNG, konverterar färgprofil till sRGB, bevarar alfa, och returnerar komprimerad PNG.
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

    out = BytesIO()
    base.save(out, format="PNG", optimize=True, compress_level=9)
    return out.getvalue()


# Denna funktion registreras som route i backend.app.main:
# app.add_api_route("/api/figma-image", figma_image_handler, methods=["GET"])
def figma_image(fileKey: str, nodeId: str, scale: str = "2"):
    # Säkerställ att vi har någon form av token
    _ = _auth_headers()  # kommer kasta 500 om saknas

    url = _figma_image_url(fileKey, nodeId, scale)

    try:
        r = requests.get(url, timeout=30)
    except RequestException as e:
        raise HTTPException(502, f"image fetch nätverksfel: {e}")

    if r.status_code != 200:
        raise HTTPException(502, f"image fetch error {r.status_code}")

    try:
        out = _to_srgb_png(r.content)
    except Exception as e:
        raise HTTPException(500, f"convert error: {e}")

    headers = {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    return Response(content=out, headers=headers)
