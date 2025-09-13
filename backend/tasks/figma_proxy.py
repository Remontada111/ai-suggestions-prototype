# backend/tasks/figma_proxy.py
from io import BytesIO
import os
import logging
import random
from time import perf_counter, sleep
from typing import Any, Optional, Tuple, Dict, cast

import requests
from requests.exceptions import RequestException
from fastapi import HTTPException, APIRouter, Request
from fastapi.responses import Response
from PIL import Image, ImageCms  # Kräver Pillow; för färghantering krävs lcms2 i OS

router = APIRouter()
log = logging.getLogger("ai-figma-codegen/figma-proxy")

# ── Intent-typ för Pillow/Pylance ───────────────────────────────────────────
_INTENT_PERCEPTUAL: Any
try:
    from PIL.ImageCms import Intent as _Intent  # type: ignore
    _INTENT_PERCEPTUAL = _Intent.PERCEPTUAL
except Exception:
    _INTENT_PERCEPTUAL = getattr(ImageCms, "INTENT_PERCEPTUAL", 0)

# ── Konfiguration via env ───────────────────────────────────────────────────
FIGMA_PAT = os.getenv("FIGMA_TOKEN")
FIGMA_OAUTH = os.getenv("FIGMA_OAUTH_TOKEN")

ASSUME_P3_IF_NO_ICC = os.getenv("ASSUME_P3_IF_NO_ICC", "1") == "1"
P3_ICC_PATH = os.getenv("P3_ICC_PATH", "backend/color/DisplayP3.icc")

AUTO_FLATTEN_WITH_NODE_BG = os.getenv("AUTO_FLATTEN_WITH_NODE_BG", "1") == "1"
FALLBACK_FLATTEN_BG = os.getenv("FALLBACK_FLATTEN_BG", "")

# Retries
FIGMA_API_ATTEMPTS = int(os.getenv("FIGMA_API_ATTEMPTS", "3"))          # Images/Nodes API
FIGMA_API_BACKOFF_S = float(os.getenv("FIGMA_API_BACKOFF_S", "0.3"))    # 0.3 → 0.6 → 1.2 …
IMG_FETCH_ATTEMPTS = int(os.getenv("IMG_FETCH_ATTEMPTS", "3"))          # presigned image URL
IMG_FETCH_BACKOFF_S = float(os.getenv("IMG_FETCH_BACKOFF_S", "0.2"))

log.info(
    "Figma proxy init",
    extra={
        "has_PAT": bool(FIGMA_PAT),
        "has_OAUTH": bool(FIGMA_OAUTH),
        "assume_p3": ASSUME_P3_IF_NO_ICC,
        "p3_icc_exists": os.path.exists(P3_ICC_PATH),
        "auto_flatten_node_bg": AUTO_FLATTEN_WITH_NODE_BG,
        "fallback_flatten_bg": bool(FALLBACK_FLATTEN_BG),
        "figma_api_attempts": FIGMA_API_ATTEMPTS,
        "img_fetch_attempts": IMG_FETCH_ATTEMPTS,
    },
)

# ── Hjälpare ────────────────────────────────────────────────────────────────
def _auth_headers(token_override: Optional[str] = None) -> Dict[str, str]:
    """
    Föredra token från anropet om angiven, annars env (OAuth först, sedan PAT).
    Använd rätt header, aldrig båda.
    """
    if token_override:
        if token_override.startswith("figd_"):  # PAT
            return {"X-Figma-Token": token_override}
        return {"Authorization": f"Bearer {token_override}"}  # OAuth

    if FIGMA_OAUTH:
        return {"Authorization": f"Bearer {FIGMA_OAUTH}"}
    if FIGMA_PAT:
        return {"X-Figma-Token": str(FIGMA_PAT)}
    raise HTTPException(500, "Ingen Figma-token konfigurerad (FIGMA_TOKEN eller FIGMA_OAUTH_TOKEN).")

def _parse_hex_rgb(s: str) -> Optional[Tuple[int, int, int]]:
    s = s.strip()
    if not s:
        return None
    if s.startswith("#"):
        s = s[1:]
    if len(s) == 3:
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

def _should_retry_status(status: int) -> bool:
    # Retry på 429 + 5xx. Inte på 4xx i övrigt.
    return status == 429 or (500 <= status < 600)

def _sleep_backoff(base: float, attempt: int) -> None:
    # Exponentiell backoff med lite jitter
    t = base * (2 ** (attempt - 1))
    jitter = t * 0.25 * (random.random() - 0.5)  # ±12.5%
    sleep(max(0.0, t + jitter))

def _get_with_retries(
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    params: Optional[Dict[str, str]] = None,
    timeout: float = 15.0,
    attempts: int = 3,
    backoff_s: float = 0.3,
) -> requests.Response:
    last_exc: Optional[Exception] = None
    for i in range(1, max(1, attempts) + 1):
        try:
            r = requests.get(url, headers=headers, params=params, timeout=timeout)
            if _should_retry_status(r.status_code) and i < attempts:
                _sleep_backoff(backoff_s, i)
                continue
            return r
        except RequestException as e:
            last_exc = e
            if i < attempts:
                _sleep_backoff(backoff_s, i)
                continue
            break
    if last_exc:
        raise last_exc
    # Om vi kommer hit har vi svar men med status som inte blev returnerad ovan
    return r  # type: ignore[UnboundLocalVariable]

def _figma_image_url(file_key: str, node_id: str, scale: str, token: Optional[str] = None) -> str:
    """
    Hämtar presignad bild-URL från Figma Images API för given node.
    Retries på nätverksfel och 429/5xx.
    """
    u = f"https://api.figma.com/v1/images/{file_key}"
    params = {
        "ids": node_id,
        "format": "png",
        "use_absolute_bounds": "true",
        "scale": scale or "2",
    }
    t0 = perf_counter()
    try:
        r = _get_with_retries(
            u,
            headers=_auth_headers(token),
            params=params,
            timeout=15.0,
            attempts=FIGMA_API_ATTEMPTS,
            backoff_s=FIGMA_API_BACKOFF_S,
        )
    except RequestException as e:
        log.error("Images API network error", exc_info=True)
        raise HTTPException(502, f"figma images nätverksfel: {e}")
    dt = (perf_counter() - t0) * 1000
    log.info("Images API response", extra={"status": r.status_code, "ms": round(dt, 1)})

    if r.status_code != 200:
        text_preview = ""
        try:
            text_preview = r.text[:300]
        except Exception:
            pass
        raise HTTPException(502, f"figma images error {r.status_code}: {text_preview}")

    try:
        j = r.json()
    except ValueError:
        raise HTTPException(502, "figma images svarade inte med giltig JSON")

    url = (j.get("images") or {}).get(node_id)
    if not url:
        raise HTTPException(502, "figma images saknar image-url för angiven node (fel nodeId eller åtkomst).")

    return url

def _figma_node_bg_color(file_key: str, node_id: str, token: Optional[str]) -> Optional[Tuple[int, int, int]]:
    """
    Försök läsa ut en "solid" bakgrundsfärg för noden via Nodes API.
    Retries på nätverksfel och 429/5xx.
    """
    try:
        u = f"https://api.figma.com/v1/files/{file_key}/nodes"
        t0 = perf_counter()
        r = _get_with_retries(
            u,
            headers=_auth_headers(token),
            params={"ids": node_id},
            timeout=15.0,
            attempts=FIGMA_API_ATTEMPTS,
            backoff_s=FIGMA_API_BACKOFF_S,
        )
        dt = (perf_counter() - t0) * 1000
    except RequestException:
        log.debug("Nodes API network error, ignoring", exc_info=True)
        return None

    log.info("Nodes API response", extra={"status": r.status_code, "ms": round(dt, 1)})
    if r.status_code != 200:
        return None

    try:
        data = r.json()
    except ValueError:
        return None

    nodes = (data.get("nodes") or {}).get(node_id) or {}
    doc = nodes.get("document") or {}
    node_type = doc.get("type", "")

    def _conv(c: Dict[str, Any]) -> Tuple[int, int, int]:
        return (
            int(round(float(c.get("r", 0)) * 255)),
            int(round(float(c.get("g", 0)) * 255)),
            int(round(float(c.get("b", 0)) * 255)),
        )

    fills = doc.get("fills") or []
    for f in fills:
        if not f.get("visible", True):
            continue
        if f.get("type") == "SOLID":
            col = f.get("color")
            if isinstance(col, dict):
                rgb = _conv(col)
                log.info("Node BG from SOLID fill", extra={"rgb": rgb})
                return rgb

    if node_type == "CANVAS":
        bgs = doc.get("background") or []
        for bg in bgs:
            if not bg.get("visible", True):
                continue
            if bg.get("type") == "SOLID" and isinstance(bg.get("color"), dict):
                rgb = _conv(bg["color"])
                log.info("Node BG from CANVAS background", extra={"rgb": rgb})
                return rgb

    log.debug("No BG color found on node")
    return None

def _to_srgb_png(src_bytes: bytes) -> Image.Image:
    """
    Laddar PNG och konverterar färgprofil till sRGB, bevarar alfa.
    Returnerar PIL Image (RGBA).
    """
    im = Image.open(BytesIO(src_bytes))
    im.load()
    log.debug("Opened image", extra={"mode": im.mode, "size": im.size})

    alpha: Optional[Image.Image] = None
    if im.mode in ("RGBA", "LA"):
        alpha = im.getchannel("A")
        log.debug("Alpha channel present")

    base = im.convert("RGB")
    dst_profile = ImageCms.createProfile("sRGB")
    src_icc = base.info.get("icc_profile") or im.info.get("icc_profile")

    try:
        if src_icc:
            log.info("Converting with embedded ICC → sRGB", extra={"icc_bytes": len(src_icc)})
            src_prof = ImageCms.ImageCmsProfile(BytesIO(src_icc))
            conv = ImageCms.profileToProfile(
                base, src_prof, dst_profile, outputMode="RGB", renderingIntent=_INTENT_PERCEPTUAL
            )
            base = cast(Image.Image, conv)
        else:
            if ASSUME_P3_IF_NO_ICC and os.path.exists(P3_ICC_PATH):
                log.info("No ICC. Assuming Display P3 → sRGB", extra={"p3_icc": P3_ICC_PATH})
                with open(P3_ICC_PATH, "rb") as f:
                    p3 = f.read()
                p3_prof = ImageCms.ImageCmsProfile(BytesIO(p3))
                conv = ImageCms.profileToProfile(
                    base, p3_prof, dst_profile, outputMode="RGB", renderingIntent=_INTENT_PERCEPTUAL
                )
                base = cast(Image.Image, conv)
            else:
                log.info("No ICC. Assuming already sRGB")
    except Exception:
        log.exception("ICC conversion failed; falling back to RGB")
        base = base.convert("RGB")

    if alpha is not None:
        base = Image.merge("RGBA", (*base.split(), alpha))
    else:
        base = base.convert("RGBA")

    log.debug("Image in RGBA", extra={"mode": base.mode, "size": base.size})
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
        log.debug("No alpha channel → no flatten")
        return img_rgba

    extrema = alpha.getextrema()
    if not extrema:
        log.debug("Alpha extrema missing → no flatten")
        return img_rgba

    if extrema[0] == 255 and extrema[1] == 255:
        log.debug("Fully opaque → no flatten")
        return img_rgba

    if bg_rgb is None:
        log.info("Transparent but no BG provided → no flatten")
        return img_rgba

    log.info("Flattening over BG", extra={"bg": bg_rgb, "alpha_extrema": extrema})
    background = Image.new("RGBA", img_rgba.size, (bg_rgb[0], bg_rgb[1], bg_rgb[2], 255))
    background.paste(img_rgba, (0, 0), mask=alpha)
    return background

def _image_bytes(img: Image.Image) -> bytes:
    out = BytesIO()
    img.save(out, format="PNG", optimize=True, compress_level=9)
    data = out.getvalue()
    log.debug("Encoded PNG bytes", extra={"bytes": len(data)})
    return data

# ── HTTP-svarshjälpare (CORS) ───────────────────────────────────────────────
def _cors_headers(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    base = {
        "Access-Control-Allow-Origin": "*",              # viktig för canvas + crossOrigin="anonymous"
        "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        # OBS: sätt inte Access-Control-Allow-Credentials när du använder anonymous
    }
    return {**base, **(extra or {})}

# ── Publika routes ──────────────────────────────────────────────────────────
@router.options("/api/figma-image")
def figma_image_options() -> Response:
    return Response(status_code=204, headers=_cors_headers())

@router.get("/api/figma-image")
def figma_image(
    request: Request,
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
    t_total = perf_counter()
    log.info(
        "Request /api/figma-image",
        extra={
            "fileKey": fileKey,
            "nodeId": nodeId,
            "scale": scale,
            "has_token": bool(token),
            "flatten": flatten,
            "bg_override": bg,
            "method": request.method,
        },
    )

    # Säkerställ att vi har någon form av token
    _ = _auth_headers(token)  # kastar 500 om saknas

    # 1) Hämta bild-URL för node (med retries)
    url = _figma_image_url(fileKey, nodeId, scale, token)

    # 2) Ladda bildbytes (med retries)
    try:
        t0 = perf_counter()
        r = _get_with_retries(
            url,
            timeout=30.0,
            attempts=IMG_FETCH_ATTEMPTS,
            backoff_s=IMG_FETCH_BACKOFF_S,
        )
        dt = (perf_counter() - t0) * 1000
        content_len = 0
        try:
            content_len = int(r.headers.get("content-length", "0") or 0)
        except Exception:
            pass
        log.info(
            "Fetch presigned image",
            extra={"status": r.status_code, "content_len": content_len, "ms": round(dt, 1)},
        )
    except RequestException as e:
        log.error("Presigned image fetch error", exc_info=True)
        raise HTTPException(502, f"image fetch nätverksfel: {e}")

    if r.status_code != 200:
        raise HTTPException(502, f"image fetch error {r.status_code}")

    # 3) Konvertera till sRGB + RGBA
    try:
        t0 = perf_counter()
        img = _to_srgb_png(r.content)
        log.info("Converted to sRGB RGBA", extra={"ms": round((perf_counter() - t0) * 1000, 1), "size": img.size})
    except Exception as e:
        log.exception("Convert error")
        raise HTTPException(500, f"convert error: {e}")

    # 4) Bestäm flatten-policy
    forced_bg = _parse_hex_rgb(bg) if bg else None
    node_bg: Optional[Tuple[int, int, int]] = None

    if forced_bg is not None:
        selected_bg = forced_bg
        log.info("BG override via query", extra={"bg": forced_bg})
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
                log.info("BG from FALLBACK env", extra={"bg": fb})

    # Tolka explicit flatten-override
    if flatten == "0":
        log.info("Flatten override OFF")
        selected_bg = None
    elif flatten == "1" and selected_bg is None:
        log.info("Flatten override ON but no BG set; will NOT flatten without BG")

    # 5) Flatten om nödvändigt
    t0 = perf_counter()
    img = _flatten_if_needed(img, selected_bg)
    log.info("Flatten step done", extra={"ms": round((perf_counter() - t0) * 1000, 1), "bg_used": bool(selected_bg)})

    # 6) Svara med PNG-bytes + CORS
    body = _image_bytes(img)
    headers = _cors_headers(
        {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=31536000, immutable",
        }
    )

    log.info("Responding PNG", extra={"bytes": len(body), "total_ms": round((perf_counter() - t_total) * 1000, 1)})
    return Response(content=body, headers=headers)
