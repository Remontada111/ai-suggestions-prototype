// webview/main.tsx
// Interaktiv visning enligt önskemål:
// 1) Initialt visas endast Figma-designen (övre lager).
// 2) När användaren klickar/draggar på designen visas projektets preview UNDER (nedre lager),
//    med Figma-lagret semitransparent så man kan placera genom att dra/släppa.
// 3) Robust resize/drag med låst aspect (1280×800), min/max-gränser, och clamping i bildens koordinater.
// 4) Stöd för Figma-token via både Authorization: Bearer (OAuth) och X-FIGMA-TOKEN (PAT).
// 5) Skickar placementAccepted på släpp.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

declare function acquireVsCodeApi(): {
  postMessage: (msg: any) => void;
  getState: () => any;
  setState: (state: any) => void;
};
const vscode = acquireVsCodeApi();

// ─────────────────────────────────────────────────────────
// Konstanter / utils
// ─────────────────────────────────────────────────────────
const PROJECT_BASE = { w: 1280, h: 800 };
const PREVIEW_MIN_SCALE = 0.3;
const PREVIEW_MAX_SCALE = 1.0;
const OVERLAY_MIN_FACTOR = PREVIEW_MIN_SCALE;
const FIGMA_FETCH_MAX_RETRIES = 6;

 type UiPhase = "default" | "onboarding" | "loading";
 type IncomingMsg =
  | { type: "devurl"; url: string }
  | { type: "ui-phase"; phase: UiPhase }
  | { type: "init"; fileKey: string; nodeId: string; token?: string; figmaToken?: string }
  | { type: "figma-image-url"; url: string };

 type Vec2 = { x: number; y: number };
 type Rect = { x: number; y: number; w: number; h: number };

 function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
 }
 function round(n: number) {
  return Math.round(n);
 }
 function arFit(width: number, height: number, targetAR: number) {
  const ar = width / height;
  if (Math.abs(ar - targetAR) < 1e-6) return { w: width, h: height };
  if (ar > targetAR) return { w: width, h: width / targetAR };
  return { w: height * targetAR, h: height };
 }

// ─────────────────────────────────────────────────────────
// Figma: hämta renditions-URL (prova Bearer → X-FIGMA-TOKEN)
// ─────────────────────────────────────────────────────────
async function resolveFigmaRenditionUrl(
  fileKey: string,
  nodeId: string,
  token?: string
): Promise<{ url: string | null; error?: { status: number; message: string } }> {
  if (!fileKey || !nodeId || !token) {
    return { url: null, error: { status: 0, message: "Saknar fileKey/nodeId/token" } };
  }

  const base = "https://api.figma.com/v1/images";
  const params = new URLSearchParams({
    ids: nodeId,
    format: "png",
    use_absolute_bounds: "true",
    scale: "1",
  });
  const endpoint = `${base}/${encodeURIComponent(fileKey)}?${params.toString()}`;

  async function tryOnce(headers: Record<string, string>) {
    const res = await fetch(endpoint, { headers });
    let body: any = null;
    try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  }

  let attempt = 0;
  while (attempt < FIGMA_FETCH_MAX_RETRIES) {
    attempt++;
    const r1 = await tryOnce({ Authorization: `Bearer ${token}` });
    if (r1.ok) {
      const u = r1.body?.images?.[nodeId] || null;
      if (u) return { url: u };
    } else if (r1.status === 401 || r1.status === 403) {
      const r2 = await tryOnce({ "X-FIGMA-TOKEN": token });
      if (r2.ok) {
        const u = r2.body?.images?.[nodeId] || null;
        if (u) return { url: u };
      }
      const msg = r2.body?.err || r1.body?.err || "Åtkomst nekad. Kontrollera token/scope/filåtkomst.";
      return { url: null, error: { status: 403, message: String(msg) } };
    }
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }

  return { url: null, error: { status: 500, message: "Kunde inte hämta Figma-bild efter flera försök." } };
}

// ─────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────
function App() {
  // UI-phase, devurl, preview-reveal, fel
  const [phase, setPhase] = useState<UiPhase>("default");
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false); // ← initialt false (endast Figma syns)
  const [figmaErr, setFigmaErr] = useState<string | null>(null);

  // Skalning baserat på tillgänglig höjd
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [containerH, setContainerH] = useState<number>(0);
  const previewScale = useMemo(() => {
    if (!containerH) return PREVIEW_MIN_SCALE;
    const s = containerH / PROJECT_BASE.h;
    return clamp(s, PREVIEW_MIN_SCALE, PREVIEW_MAX_SCALE);
  }, [containerH]);

  // Figma-bild + overlay i bildens koordinater
  const [figmaSrc, setFigmaSrc] = useState<string | null>(null);
  const [figmaN, setFigmaN] = useState<{ w: number; h: number } | null>(null);
  const figmaImgRef = useRef<HTMLImageElement | null>(null);
  const [overlay, setOverlay] = useState<Rect | null>(null);

  // Drag/resize-state
  const dragState = useRef<{
    mode: "move" | "nw" | "ne" | "se" | "sw" | null;
    startPt: Vec2;
    startRect: Rect;
  } | null>(null);

  // Följ editorhöjden
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (!e) return;
      const h = e.contentRect.height;
      setContainerH(h - 16);
    });
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, []);

  // Meddelanden från extension
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const msg = ev.data as IncomingMsg;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "devurl") {
        setDevUrl(msg.url);
        return;
      }
      if (msg.type === "ui-phase") {
        setPhase(msg.phase);
        return;
      }
      if (msg.type === "figma-image-url" && typeof msg.url === "string") {
        setFigmaSrc(msg.url);
        setFigmaErr(null);
        return;
      }
      if (msg.type === "init") {
        (async () => {
          const { url, error } = await resolveFigmaRenditionUrl(
            msg.fileKey,
            msg.nodeId,
            msg.figmaToken || msg.token
          );
          if (url) {
            setFigmaSrc(url);
            setFigmaErr(null);
          } else {
            setFigmaSrc(null);
            const hint =
              error?.status === 401 || error?.status === 403
                ? "Åtkomst nekad (401/403). Säkerställ token/scope/filåtkomst."
                : error?.message || "Okänt fel vid hämtning av Figma-bild.";
            setFigmaErr(hint);
            console.error("[Figma images] error", error);
          }
        })();
        return;
      }
    }
    window.addEventListener("message", onMsg);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // När Figma-lagret laddats → initiera overlay
  const onFigmaLoad = useCallback(() => {
    const el = figmaImgRef.current;
    if (!el) return;
    const natural = { w: el.naturalWidth || el.width, h: el.naturalHeight || el.height };
    setFigmaN(natural);

    const maxW = Math.min(natural.w, PROJECT_BASE.w);
    const maxH = Math.min(natural.h, PROJECT_BASE.h);
    const ar = PROJECT_BASE.w / PROJECT_BASE.h;
    const sized = arFit(maxW, maxH, ar);
    const w = Math.min(sized.w, maxW);
    const h = Math.min(sized.h, maxH);

    const rect: Rect = {
      w: round(w),
      h: round(h),
      x: round((natural.w - w) / 2),
      y: round((natural.h - h) / 2),
    };
    setOverlay(rect);
  }, []);

  // Koordinater & skalor
  const stageH = useMemo(() => round(PROJECT_BASE.h * previewScale), [previewScale]);
  const stageW = useMemo(() => round(PROJECT_BASE.w * previewScale), [previewScale]);
  const imageDisplayScale = useMemo(() => {
    if (!figmaN || figmaN.h === 0) return 1;
    return stageH / figmaN.h;
  }, [figmaN, stageH]);

  const imageDisplayW = useMemo(
    () => (figmaN ? round(figmaN.w * imageDisplayScale) : 0),
    [figmaN, imageDisplayScale]
  );

  const overlayLimits = useMemo(() => {
    if (!figmaN) return null;
    const minW = Math.min(figmaN.w, PROJECT_BASE.w * OVERLAY_MIN_FACTOR);
    const minH = Math.min(figmaN.h, PROJECT_BASE.h * OVERLAY_MIN_FACTOR);
    const maxW = Math.min(figmaN.w, PROJECT_BASE.w);
    const maxH = Math.min(figmaN.h, PROJECT_BASE.h);
    const ar = PROJECT_BASE.w / PROJECT_BASE.h;
    return { minW, minH, maxW, maxH, ar };
  }, [figmaN]);

  function clampRectToImage(r: Rect): Rect {
    if (!figmaN) return r;
    const x = clamp(r.x, 0, figmaN.w - r.w);
    const y = clamp(r.y, 0, figmaN.h - r.h);
    return { ...r, x, y };
  }
  function clampSizeToLimits(w: number, h: number): { w: number; h: number } {
    if (!overlayLimits) return { w, h };
    const W = clamp(w, overlayLimits.minW, overlayLimits.maxW);
    const H = clamp(h, overlayLimits.minH, overlayLimits.maxH);
    const sized = arFit(W, H, overlayLimits.ar);
    return {
      w: clamp(sized.w, overlayLimits.minW, overlayLimits.maxW),
      h: clamp(sized.h, overlayLimits.minH, overlayLimits.maxH),
    };
  }

  // Drag/resize
  const figmaWrapRef = useRef<HTMLDivElement | null>(null);

  const toImageCoords = useCallback(
    (clientX: number, clientY: number): Vec2 => {
      const wrap = figmaWrapRef.current;
      if (!wrap || imageDisplayScale === 0) return { x: 0, y: 0 };
      const b = wrap.getBoundingClientRect();
      const x = (clientX - b.left) / imageDisplayScale;
      const y = (clientY - b.top) / imageDisplayScale;
      return { x, y };
    },
    [imageDisplayScale]
  );

  const startMove = useCallback(
    (e: React.PointerEvent) => {
      if (!overlay) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      document.body.classList.add("dragging");
      setShowPreview(true); // ← visa preview under när man börjar interagera
      dragState.current = {
        mode: "move",
        startPt: toImageCoords(e.clientX, e.clientY),
        startRect: { ...overlay },
      };
    },
    [overlay, toImageCoords]
  );

  const startResize = useCallback(
    (mode: "nw" | "ne" | "se" | "sw") =>
      (e: React.PointerEvent) => {
        if (!overlay) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        document.body.classList.add("dragging");
        setShowPreview(true); // ← visa preview under
        dragState.current = {
          mode,
          startPt: toImageCoords(e.clientX, e.clientY),
          startRect: { ...overlay },
        };
      },
    [overlay, toImageCoords]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState.current || !overlay || !figmaN) return;
      const st = dragState.current;
      const pt = toImageCoords(e.clientX, e.clientY);
      const dx = pt.x - st.startPt.x;
      const dy = pt.y - st.startPt.y;

      if (st.mode === "move") {
        const next = clampRectToImage({
          ...st.startRect,
          x: st.startRect.x + dx,
          y: st.startRect.y + dy,
        });
        setOverlay(next);
        return;
      }

      const ar = PROJECT_BASE.w / PROJECT_BASE.h;
      let { x, y, w, h } = st.startRect;

      if (st.mode === "nw") {
        let newW = st.startRect.w - dx;
        let newH = st.startRect.h - dy;
        ({ w: newW, h: newH } = clampSizeToLimits(arFit(newW, newH, ar).w, arFit(newW, newH, ar).h));
        x = st.startRect.x + (st.startRect.w - newW);
        y = st.startRect.y + (st.startRect.h - newH);
        w = newW; h = newH;
      } else if (st.mode === "ne") {
        let newW = st.startRect.w + dx;
        let newH = st.startRect.h - dy;
        ({ w: newW, h: newH } = clampSizeToLimits(arFit(newW, newH, ar).w, arFit(newW, newH, ar).h));
        x = st.startRect.x;
        y = st.startRect.y + (st.startRect.h - newH);
        w = newW; h = newH;
      } else if (st.mode === "se") {
        let newW = st.startRect.w + dx;
        let newH = st.startRect.h + dy;
        ({ w: newW, h: newH } = clampSizeToLimits(arFit(newW, newH, ar).w, arFit(newW, newH, ar).h));
        x = st.startRect.x; y = st.startRect.y;
        w = newW; h = newH;
      } else if (st.mode === "sw") {
        let newW = st.startRect.w - dx;
        let newH = st.startRect.h + dy;
        ({ w: newW, h: newH } = clampSizeToLimits(arFit(newW, newH, ar).w, arFit(newW, newH, ar).h));
        x = st.startRect.x + (st.startRect.w - newW);
        y = st.startRect.y;
        w = newW; h = newH;
      }

      const next = clampRectToImage({ x, y, w, h });
      setOverlay(next);
    },
    [overlay, figmaN, toImageCoords]
  );

  const onPointerUp = useCallback(() => {
    if (!dragState.current || !overlay || !figmaN) return;
    dragState.current = null;
    document.body.classList.remove("dragging");

    // Dölj preview efter interaktion ("reveal on interact")
    setTimeout(() => setShowPreview(false), 100);

    const scale = { sx: PROJECT_BASE.w / overlay.w, sy: PROJECT_BASE.h / overlay.h };
    vscode.postMessage({
      type: "placementAccepted",
      payload: {
        imageNatural: { ...figmaN },
        overlay,
        projectBase: { ...PROJECT_BASE },
        scale,
        ts: Date.now(),
        source: "webview/main.tsx",
      },
    });
  }, [overlay, figmaN]);

  // Render

  return (
    <div ref={rootRef} className="panel-root px-4 pt-3" style={{ height: "100vh" }}>
      {/* En enda scen: preview underst (osynlig tills interaktion), Figma ovanpå */}
      <div
        className="stage"
        style={{
          position: "relative",
          width: stageW,
          height: stageH,
        }}
      >
        {/* UNDERLAGER: projektets preview */}
        <div
          className="laptop-shell"
          style={{
            position: "absolute",
            inset: 0,
            // visa bara under interaktion
            visibility: showPreview && devUrl && phase === "default" ? "visible" : "hidden",
          }}
        >
          {(!devUrl || phase !== "default") && <div className="skeleton" aria-hidden="true" />}
          {devUrl && (
            <iframe
              title="preview"
              src={devUrl}
              className="mini-preview__iframe"
              style={{ pointerEvents: dragState.current ? "none" : "auto" }}
            />)
          }
        </div>

        {/* ÖVERLAGER: Figma-bilden + overlay/handles */}
        <div
          ref={figmaWrapRef}
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            alignItems: "start",
          }}
        >
          {figmaErr && (
            <div
              style={{
                height: stageH,
                display: "grid",
                alignItems: "center",
                justifyItems: "center",
                border: "1px dashed var(--border)",
                borderRadius: 12,
                padding: 16,
              }}
            >
              <div className="text-foreground" style={{ maxWidth: 560, lineHeight: 1.4 }}>
                <strong>Figma-bild kunde inte hämtas.</strong>
                <div style={{ marginTop: 8 }}>{figmaErr}</div>
              </div>
            </div>
          )}

          {!figmaErr && figmaSrc && (
            <div style={{ position: "relative", width: stageW, height: stageH }}>
              <img
                ref={figmaImgRef}
                src={figmaSrc}
                alt="Figma node"
                className="figma-img"
                draggable={false}
                onLoad={onFigmaLoad}
                onPointerDown={() => setShowPreview(true)} // klick visar preview under
                style={{
                  width: "100%",
                  height: "100%",
                  display: "block",
                  userSelect: "none",
                  pointerEvents: "auto",
                  transition: "opacity 120ms ease",
                  // gör Figma-lagret lätt transparent under interaktion så preview syns tydligt
                  opacity: showPreview ? 0.8 : 1,
                }}
              />

              {/* Overlay/markeringsruta i visade px */}
              {overlay && (
                <div
                  className="overlay-box"
                  role="region"
                  aria-label="Placering"
                  onPointerDown={startMove}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  style={{
                    position: "absolute",
                    left: round(overlay.x * imageDisplayScale),
                    top: round(overlay.y * imageDisplayScale),
                    width: round(overlay.w * imageDisplayScale),
                    height: round(overlay.h * imageDisplayScale),
                    border: "2px solid var(--accent)",
                    borderRadius: 8,
                    boxShadow: "0 0 0 2px rgba(0,0,0,.06), 0 1px 6px rgba(0,0,0,.2)",
                    background: "transparent",
                    cursor: "move",
                  }}
                >
                  {/* Resize-handles */}
                  <div className="resize-handle handle-nw" onPointerDown={startResize("nw")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
                  <div className="resize-handle handle-ne" onPointerDown={startResize("ne")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
                  <div className="resize-handle handle-se" onPointerDown={startResize("se")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
                  <div className="resize-handle handle-sw" onPointerDown={startResize("sw")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
                </div>
              )}
            </div>
          )}

          {!figmaErr && !figmaSrc && (
            <div
              style={{
                height: stageH,
                display: "grid",
                placeItems: "center",
                border: "1px dashed var(--border)",
                borderRadius: 12,
                padding: 12,
              }}
            >
              <div className="text-foreground" style={{ opacity: 0.8 }}>
                {phase === "onboarding" ? "Öppna via Figma-URI för att ladda en nod." : "Laddar Figma-bild…"}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Montera appen
const rootEl = document.getElementById("root");
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(<App />);
}
