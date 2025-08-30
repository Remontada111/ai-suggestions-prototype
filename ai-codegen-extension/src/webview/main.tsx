// webview/main.tsx
// Målsättning (oförändrat):
// 1) Startläge: Endast Figma-designen syns, centrerad i "normal" storlek.
// 2) Klick/drag i Figma: begär Full View, visar projektets preview UNDER Figma-lagret.
// 3) Drag/resize av overlay med låst AR 1280×800, clamping i bildens koordinater.
// 4) Tangentbord: pilar (flytt), Ctrl/Cmd+pilar (resize), Shift=större steg, Space=visa preview, R=reset, F=full view.
// 5) “Välj projekt/folder”-kort, auto-start av föreslagen kandidat, remember via extension.
// 6) Wheel-zoom (Ctrl/Cmd + hjul).
// 7) 🔧 Figma-URL hämtas i extension-backend. Webview sparar den inte, och begär refresh på fel (403/expire).
// 8) 🔧 Robust fullscreen/helskärm: undvik 100vh-glitch; iframen är alltid klick-igenom (pointer-events:none).

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
const OVERLAY_MIN_FACTOR = 0.3; // min overlay-storlek som andel av 1280×800
const CANVAS_MARGIN = 16; // marginaler runt centrerade element

type UiPhase = "default" | "onboarding" | "loading";
type IncomingMsg =
  | { type: "devurl"; url: string }
  | { type: "ui-phase"; phase: UiPhase }
  | { type: "init"; fileKey: string; nodeId: string; token?: string; figmaToken?: string }
  | { type: "figma-image-url"; url: string }
  | { type: "ui-error"; message: string };

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
function withCenterResize(rect: Rect, newW: number, newH: number): Rect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH };
}

// ─────────────────────────────────────────────────────────
// UI: “Välj projekt/folder”-kort
// ─────────────────────────────────────────────────────────
function ChooseProjectCard(props: { visible: boolean; compact?: boolean; busy?: boolean }) {
  const { visible, compact, busy } = props;
  if (!visible) return null;

  const onChooseProject = () => vscode.postMessage({ cmd: "chooseProject" });
  const onPickFolder   = () => vscode.postMessage({ cmd: "pickFolder" });
  const onStartTop     = () => vscode.postMessage({ cmd: "acceptCandidate" });
  const onForget       = () => vscode.postMessage({ cmd: "forgetProject" });

  return (
    <div
      style={{
        position: "absolute",
        inset: compact ? "auto 8px 8px auto" : 0,
        display: "grid",
        placeItems: compact ? "end" : "center",
        zIndex: 30,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          width: compact ? 280 : 360,
          height: compact ? 160 : 200,
          padding: 12,
          borderRadius: 16,
          background: "linear-gradient(135deg, #6dd5ed, #2193b0)",
          boxShadow: "0 15px 30px rgba(0,0,0,.25)",
          position: "relative",
          color: "white",
          overflow: "hidden",
        }}
      >
        <style>{`
          .fp-container { --transition: 350ms; --folder-W: 120px; --folder-H: 80px; }
          .fp-folder { position: absolute; top: -20px; left: calc(50% - 60px); animation: fp-float 2.5s infinite ease-in-out; transition: transform var(--transition) ease; }
          .fp-container:hover .fp-folder { transform: scale(1.05); }
          .fp-front, .fp-back { position: absolute; transform-origin: bottom center; transition: transform var(--transition); }
          .fp-back::before, .fp-back::after {
            content: ""; display: block; background: white; opacity: .5; width: var(--folder-W); height: var(--folder-H);
            position: absolute; transform-origin: bottom center; border-radius: 15px; transition: transform 350ms; z-index: 0;
          }
          .fp-container:hover .fp-back::before { transform: rotateX(-5deg) skewX(5deg); }
          .fp-container:hover .fp-back::after  { transform: rotateX(-15deg) skewX(12deg); }
          .fp-container:hover .fp-front { transform: rotateX(-40deg) skewX(15deg); }
          .fp-tip { background: linear-gradient(135deg, #ff9a56, #ff6f56); width: 80px; height: 20px; border-radius: 12px 12px 0 0; position: absolute; top: -10px; z-index: 2; box-shadow: 0 5px 15px rgba(0,0,0,.2); }
          .fp-cover { background: linear-gradient(135deg, #ffe563, #ffc663); width: var(--folder-W); height: var(--folder-H); border-radius: 10px; box-shadow: 0 15px 30px rgba(0,0,0,.3); }
          .fp-cta { display:flex; gap:8px; position:absolute; bottom:12px; left:12px; right:12px; }
          .fp-btn {
            flex:1; padding:10px 12px; border-radius:10px; border:none; cursor:pointer; color:#123; font-weight:600;
            background: rgba(255,255,255,.9); transition: transform .12s ease, background .2s ease;
          }
          .fp-btn:hover { transform: translateY(-1px); background: #fff; }
          .fp-sub { position:absolute; bottom: 48px; left: 12px; right: 12px; font-size: 12px; opacity: .9 }
          .fp-ghost { position:absolute; inset:0; border-radius:16px; border:1px dashed rgba(255,255,255,.35) }
          @keyframes fp-float { 0%{transform:translateY(0)} 50%{transform:translateY(-14px)} 100%{transform:translateY(0)} }
        `}</style>

        <div className="fp-ghost" />
        <div className="fp-container">
          <div className="fp-folder">
            <div className="fp-front">
              <div className="fp-tip" />
              <div className="fp-cover" />
            </div>
            <div className="fp-back fp-cover" />
          </div>
        </div>

        <div className="fp-sub">
          {busy ? "Startar förhandsvisning…" : "Välj ett projekt att förhandsvisa (jag minns valet)."}
        </div>
        <div className="fp-cta">
          <button className="fp-btn" onClick={onChooseProject}>Välj projekt…</button>
          <button className="fp-btn" onClick={onPickFolder}>Välj folder…</button>
        </div>

        {compact && (
          <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
            <button className="fp-btn" style={{ padding: "6px 8px" }} onClick={onStartTop}>Starta föreslagen</button>
            <button className="fp-btn" style={{ padding: "6px 8px" }} onClick={onForget}>Glöm</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────
function App() {
  // UI-phase, devurl, preview-reveal, fel
  const [phase, setPhase] = useState<UiPhase>("default");
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [figmaErr, setFigmaErr] = useState<string | null>(null);

  // Panelmått
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // Figma-bild + overlay
  const [figmaSrc, setFigmaSrc] = useState<string | null>(null);
  const [figmaN, setFigmaN] = useState<{ w: number; h: number } | null>(null);
  const figmaImgRef = useRef<HTMLImageElement | null>(null);
  const [overlay, setOverlay] = useState<Rect | null>(null);

  // För att undvika oändliga refresh-loopar
  const refreshAttempts = useRef(0);

  // Interaktion
  const dragState = useRef<{
    mode: "move" | "nw" | "ne" | "se" | "sw" | null;
    startPt: Vec2;
    startRect: Rect;
  } | null>(null);
  const fullViewRequested = useRef(false);
  const spacePreviewHeld = useRef(false);

  // Persist (vscode webview) – OBS: spara INTE figmaSrc (flyktig)!
  useEffect(() => {
    const st = vscode.getState?.() || {};
    if (st.overlay) setOverlay(st.overlay);
    if (st.showPreview) setShowPreview(!!st.showPreview);
    if (st.fullViewRequested) fullViewRequested.current = true;
  }, []);
  const persistState = useCallback(
    (extra?: Record<string, any>) => {
      const current = { overlay, showPreview, fullViewRequested: fullViewRequested.current, ...extra };
      try { vscode.setState?.(current); } catch {}
    },
    [overlay, showPreview]
  );

  // Följ editorstorlek (både bredd och höjd)
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (!e) return;
      setContainerW(Math.max(0, e.contentRect.width  - CANVAS_MARGIN * 2));
      setContainerH(Math.max(0, e.contentRect.height - CANVAS_MARGIN * 2));
    });
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, []);

  // Meddelanden från extension
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const msg = ev.data as IncomingMsg;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "devurl") { setDevUrl(msg.url); return; }
      if (msg.type === "ui-phase") { setPhase(msg.phase); return; }

      if (msg.type === "figma-image-url" && typeof msg.url === "string") {
        setFigmaSrc(msg.url);
        setFigmaErr(null);
        refreshAttempts.current = 0;
        return;
      }

      if (msg.type === "ui-error") {
        setFigmaErr(msg.message || "Okänt fel vid hämtning av Figma-bild.");
        setFigmaSrc(null);
        return;
      }

      // init med fileKey/nodeId/token hanteras i extension; här räcker det
      // att vi tar emot ev. ui-phase, samt senare "figma-image-url".
      if (msg.type === "init") {
        // Nollställ tidigare bild/fel tills backend skickar ny URL
        setFigmaSrc(null);
        setFigmaErr(null);
        refreshAttempts.current = 0;
        return;
      }
    }
    window.addEventListener("message", onMsg);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Initiera overlay när Figma-bilden laddas (i bildens naturliga koordinater)
  const onFigmaLoad = useCallback(() => {
    const el = figmaImgRef.current;
    if (!el) return;
    const natural = { w: el.naturalWidth || el.width, h: el.naturalHeight || el.height };
    setFigmaN(natural);

    // Default-overlay: centrera och anpassa till 1280×800 inom bilden (men aldrig större än bilden)
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
    persistState({ overlay: rect });
  }, [persistState]);

  const onFigmaError = useCallback(() => {
    // Vanligaste orsaken: signerad URL har gått ut → be backenden om ny
    if (refreshAttempts.current < 3) {
      refreshAttempts.current += 1;
      setFigmaErr("Förlorad åtkomst till Figma-bilden (troligen utgången URL). Försöker igen…");
      vscode.postMessage({ cmd: "refreshFigmaImage" });
    } else {
      setFigmaErr("Kunde inte ladda Figma-bilden efter flera försök. Kontrollera token/åtkomst.");
    }
  }, []);

  // ─────────────────────────────────────────────────────────
  // Geometri: Projektstage (1280×800) och Figma-display (centrerad, “normal” storlek)
  // ─────────────────────────────────────────────────────────
  const stageDims = useMemo(() => {
    const s = Math.min(containerW / PROJECT_BASE.w, containerH / PROJECT_BASE.h);
    const scale = clamp(s, PREVIEW_MIN_SCALE, PREVIEW_MAX_SCALE);
    const w = round(PROJECT_BASE.w * scale);
    const h = round(PROJECT_BASE.h * scale);
    const left = round((containerW - w) / 2);
    const top  = round((containerH - h) / 2);
    return { w, h, left, top, scale };
  }, [containerW, containerH]);

  // Figma-display: visa i “normal” storlek (ingen uppskalning över naturlig storlek).
  const figmaDisplay = useMemo(() => {
    if (!figmaN) return null;
    const maxW = Math.max(0, containerW);
    const maxH = Math.max(0, containerH);
    if (maxW === 0 || maxH === 0) return null;

    const scale = Math.min(1, maxW / figmaN.w, maxH / figmaN.h); // aldrig > 1
    const w = round(figmaN.w * scale);
    const h = round(figmaN.h * scale);
    const left = round((containerW - w) / 2);
    const top  = round((containerH - h) / 2);
    return { w, h, left, top, scale };
  }, [figmaN, containerW, containerH]);

  const imageDisplayScale = figmaDisplay?.scale ?? 1;

  // Overlaygränser i bildens koordinater
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
    const sized = arFit(w, h, overlayLimits.ar);
    return {
      w: clamp(sized.w, overlayLimits.minW, overlayLimits.maxW),
      h: clamp(sized.h, overlayLimits.minH, overlayLimits.maxH),
    };
  }

  // ─────────────────────────────────────────────────────────
  // Interaktion
  // ─────────────────────────────────────────────────────────
  const figmaWrapRef = useRef<HTMLDivElement | null>(null);

  const toImageCoords = useCallback((clientX: number, clientY: number): Vec2 => {
    const wrap = figmaWrapRef.current;
    if (!wrap || imageDisplayScale === 0) return { x: 0, y: 0 };
    const b = wrap.getBoundingClientRect();
    const x = (clientX - b.left) / imageDisplayScale;
    const y = (clientY - b.top) / imageDisplayScale;
    return { x, y };
  }, [imageDisplayScale]);

  const requestFullViewIfNeeded = useCallback(() => {
    if (!fullViewRequested.current) {
      vscode.postMessage({ cmd: "enterFullView" });
      fullViewRequested.current = true;
      persistState();
    }
  }, [persistState]);

  const beginInteraction = useCallback((e?: React.PointerEvent) => {
    requestFullViewIfNeeded();
    setShowPreview(true);
    persistState({ showPreview: true });
    if (e) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    document.body.classList.add("dragging");
  }, [requestFullViewIfNeeded, persistState]);

  const endInteraction = useCallback(() => {
    dragState.current = null;
    document.body.classList.remove("dragging");
    if (!spacePreviewHeld.current) {
      setTimeout(() => { setShowPreview(false); persistState({ showPreview: false }); }, 120);
    }
  }, [persistState]);

  const startMove = useCallback((e: React.PointerEvent) => {
    if (!overlay) return;
    beginInteraction(e);
    dragState.current = { mode: "move", startPt: toImageCoords(e.clientX, e.clientY), startRect: { ...overlay } };
  }, [overlay, beginInteraction, toImageCoords]);

  const startResize = (mode: "nw" | "ne" | "se" | "sw") => (e: React.PointerEvent) => {
    if (!overlay) return;
    beginInteraction(e);
    dragState.current = { mode, startPt: toImageCoords(e.clientX, e.clientY), startRect: { ...overlay } };
  };

  // RAF-throttle för flytt/resize
  const moveQueued = useRef<PointerEvent | null>(null);
  const rafTick = useRef<number | null>(null);
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current || !overlay || !figmaN) return;
    moveQueued.current = (e.nativeEvent as PointerEvent) || null;
    if (rafTick.current == null) {
      rafTick.current = requestAnimationFrame(() => {
        const ev = moveQueued.current;
        rafTick.current = null; moveQueued.current = null;
        if (!ev) return;
        const st = dragState.current; if (!st) return;

        const pt = toImageCoords(ev.clientX, ev.clientY);
        const dx = pt.x - st.startPt.x;
        const dy = pt.y - st.startPt.y;

        if (st.mode === "move") {
          const next = clampRectToImage({ ...st.startRect, x: st.startRect.x + dx, y: st.startRect.y + dy });
          setOverlay(next); persistState({ overlay: next }); return;
        }

        const ar = PROJECT_BASE.w / PROJECT_BASE.h;
        let { x, y, w, h } = st.startRect;
        if (st.mode === "nw") {
          let newW = st.startRect.w - dx; let newH = st.startRect.h - dy;
          ({ w: newW, h: newH } = clampSizeToLimits(newW, newH));
          const fitted = arFit(newW, newH, ar); w = fitted.w; h = fitted.h;
          x = st.startRect.x + (st.startRect.w - w); y = st.startRect.y + (st.startRect.h - h);
        } else if (st.mode === "ne") {
          let newW = st.startRect.w + dx; let newH = st.startRect.h - dy;
          ({ w: newW, h: newH } = clampSizeToLimits(newW, newH));
          const fitted = arFit(newW, newH, ar); w = fitted.w; h = fitted.h;
          x = st.startRect.x; y = st.startRect.y + (st.startRect.h - h);
        } else if (st.mode === "se") {
          let newW = st.startRect.w + dx; let newH = st.startRect.h + dy;
          ({ w: newW, h: newH } = clampSizeToLimits(newW, newH));
          const fitted = arFit(newW, newH, ar); w = fitted.w; h = fitted.h;
          x = st.startRect.x; y = st.startRect.y;
        } else if (st.mode === "sw") {
          let newW = st.startRect.w - dx; let newH = st.startRect.h + dy;
          ({ w: newW, h: newH } = clampSizeToLimits(newW, newH));
          const fitted = arFit(newW, newH, ar); w = fitted.w; h = fitted.h;
          x = st.startRect.x + (st.startRect.w - w); y = st.startRect.y;
        }
        const next = clampRectToImage({ x, y, w, h });
        setOverlay(next); persistState({ overlay: next });
      });
    }
  }, [overlay, figmaN, toImageCoords, persistState]);

  const onPointerUp = useCallback(() => {
    if (!overlay || !figmaN) return;
    endInteraction();
    const scale = { sx: PROJECT_BASE.w / overlay.w, sy: PROJECT_BASE.h / overlay.h };
    vscode.postMessage({
      type: "placementAccepted",
      payload: { imageNatural: { ...figmaN }, overlay, projectBase: { ...PROJECT_BASE }, scale, ts: Date.now(), source: "webview/main.tsx" },
    });
  }, [overlay, figmaN, endInteraction]);

  // Klick på bilden visar bara preview & begär full view (startar inte drag)
  const onImagePointerDown = useCallback(() => {
    requestFullViewIfNeeded();
    setShowPreview(true);
    persistState({ showPreview: true });
    // ✅ Be om val endast i ren onboarding-läge där ingen Figma-URL finns
    if (!devUrl && !figmaSrc && phase === "onboarding") vscode.postMessage({ cmd: "chooseProject" });
  }, [requestFullViewIfNeeded, persistState, devUrl, figmaSrc, phase]);

  // Tangentbord
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!overlay || !figmaN) return;

      if (e.code === "Space" && !e.repeat) {
        spacePreviewHeld.current = true; setShowPreview(true); persistState({ showPreview: true }); e.preventDefault(); return;
      }

      const step = e.shiftKey ? 10 : 1;
      let changed = false;
      let next: Rect = { ...overlay };
      const isMeta = e.ctrlKey || e.metaKey;

      // Move
      if (!isMeta) {
        if (e.key === "ArrowLeft")  { next.x -= step; changed = true; }
        if (e.key === "ArrowRight") { next.x += step; changed = true; }
        if (e.key === "ArrowUp")    { next.y -= step; changed = true; }
        if (e.key === "ArrowDown")  { next.y += step; changed = true; }
      }

      // Resize (Ctrl/Cmd + pilar)
      if (isMeta) {
        const ar = PROJECT_BASE.w / PROJECT_BASE.h;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          const factor = 1 + (e.shiftKey ? 0.05 : 0.02);
          const newW = next.w * factor; const newH = newW / ar;
          const sized = clampSizeToLimits(newW, newH);
          next = withCenterResize(next, sized.w, sized.h); changed = true;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          const factor = 1 - (e.shiftKey ? 0.05 : 0.02);
          const newW = next.w * factor; const newH = newW / ar;
          const sized = clampSizeToLimits(newW, newH);
          next = withCenterResize(next, sized.w, sized.h); changed = true;
        }
      }

      if (e.key === "r" || e.key === "R") {
        // reset till max som får plats i bilden m. korrekt AR
        const ar = PROJECT_BASE.w / PROJECT_BASE.h;
        const maxW = Math.min(figmaN.w, PROJECT_BASE.w);
        const maxH = Math.min(figmaN.h, PROJECT_BASE.h);
        const sized = arFit(maxW, maxH, ar);
        const w = round(Math.min(sized.w, maxW));
        const h = round(Math.min(sized.h, maxH));
        next = { w, h, x: round((figmaN.w - w) / 2), y: round((figmaN.h - h) / 2) };
        changed = true;
      }
      if (e.key === "f" || e.key === "F") vscode.postMessage({ cmd: "enterFullView" });

      if (changed) {
        next = clampRectToImage(next);
        setOverlay(next); persistState({ overlay: next });
        setShowPreview(true); persistState({ showPreview: true });
        e.preventDefault();
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        spacePreviewHeld.current = false; setShowPreview(false); persistState({ showPreview: false }); e.preventDefault();
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
      window.removeEventListener("keyup", onKeyUp, { capture: true } as any);
    };
  }, [overlay, figmaN, persistState]);

  // Ctrl/Cmd + hjul = zoom overlay runt centrum
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!overlay) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const ar = PROJECT_BASE.w / PROJECT_BASE.h;
    const factor = e.deltaY > 0 ? 0.98 : 1.02;
    const newW = overlay.w * factor; const newH = newW / ar;
    const sized = clampSizeToLimits(newW, newH);
    let next = withCenterResize(overlay, sized.w, sized.h);
    next = clampRectToImage(next);
    setOverlay(next); persistState({ overlay: next });
    setShowPreview(true); persistState({ showPreview: true });
  }, [overlay, persistState]);

  // 🔒 Auto-trigger: endast i onboarding, och bara om ingen Figma-URL finns
  const [requestedProjectOnce, setRequestedProjectOnce] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!requestedProjectOnce && !devUrl && !figmaSrc && phase === "onboarding") {
        vscode.postMessage({ cmd: "acceptCandidate" });
        setTimeout(() => { if (!devUrl && !figmaSrc && phase === "onboarding") vscode.postMessage({ cmd: "chooseProject" }); }, 400);
        setRequestedProjectOnce(true);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [devUrl, figmaSrc, phase, requestedProjectOnce]);

  // ─────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────
  // ✅ Visa aldrig kortet när vi har Figma-bild; endast i ren onboarding
  const showChooseCard = !devUrl && !figmaSrc && phase === "onboarding";

  return (
    // ⬇️ Undvik 100vh-glitch i fullscreen: täck viewport med fixed+inset
    <div
      ref={rootRef}
      className="panel-root"
      style={{ position: "fixed", inset: 0, padding: CANVAS_MARGIN }}
    >
      {/* UNDERLAGER: projektets preview (centrerad 1280×800-scalad stage) */}
      <div
        style={{
          position: "absolute",
          left: stageDims.left + CANVAS_MARGIN,
          top: stageDims.top + CANVAS_MARGIN,
          width: stageDims.w,
          height: stageDims.h,
          zIndex: 5,
          visibility: showPreview && devUrl && phase === "default" ? "visible" : "hidden",
        }}
      >
        {(!devUrl || phase !== "default") && <div className="skeleton" aria-hidden="true" style={{ width: "100%", height: "100%", borderRadius: 12 }} />}
        {devUrl && (
          <iframe
            title="preview"
            src={devUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
            style={{
              width: "100%",
              height: "100%",
              border: "1px solid var(--border)",
              borderRadius: 12,
              // 🔒 Viktigt: låt overlay alltid få events (stabilt på Windows fullscreen)
              pointerEvents: "none",
              position: "relative",
              zIndex: 0,
              background: "var(--vscode-editor-background)",
            }}
          />
        )}
      </div>

      {/* ÖVERLAGER: Figma-display (centrerad, normal storlek) + overlay */}
      <div
        style={{
          position: "absolute",
          inset: CANVAS_MARGIN,
          zIndex: 20,
          display: "grid",
          placeItems: "center",
        }}
        onWheel={onWheel}
      >
        {/* Project chooser – endast i onboarding-läge utan bild/url */}
        <ChooseProjectCard visible={showChooseCard} compact={!!devUrl && phase === "default"} busy={phase === "loading"} />

        {/* Fel eller laddning */}
        {figmaErr && (
          <div
            style={{
              maxWidth: Math.min(560, containerW),
              minHeight: 160,
              display: "grid",
              alignItems: "center",
              justifyItems: "center",
              border: "1px dashed var(--border)",
              borderRadius: 12,
              padding: 16,
              background: "var(--vscode-editorWidget-background)",
            }}
          >
            <div className="text-foreground" style={{ lineHeight: 1.4 }}>
              <strong>Figma-bild kunde inte hämtas.</strong>
              <div style={{ marginTop: 8 }}>{figmaErr}</div>
              <div style={{ marginTop: 12 }}>
                <button
                  className="fp-btn"
                  onClick={() => { refreshAttempts.current = 0; setFigmaErr("Försöker hämta ny bild-URL…"); vscode.postMessage({ cmd: "refreshFigmaImage" }); }}
                >
                  Försök igen
                </button>
              </div>
            </div>
          </div>
        )}

        {!figmaErr && figmaSrc && figmaDisplay && (
          <div
            ref={figmaWrapRef}
            style={{
              position: "absolute",
              left: figmaDisplay.left + CANVAS_MARGIN,
              top: figmaDisplay.top + CANVAS_MARGIN,
              width: figmaDisplay.w,
              height: figmaDisplay.h,
            }}
          >
            <img
              ref={figmaImgRef}
              src={figmaSrc}
              alt="Figma node"
              className="figma-img"
              draggable={false}
              onLoad={onFigmaLoad}
              onError={onFigmaError}             // 🔧 begär refresh från backend på fel (403/expire)
              onPointerDown={onImagePointerDown} // klick = visa preview + begär full view (men inte drag)
              style={{
                width: "100%",
                height: "100%",
                display: "block",
                userSelect: "none",
                pointerEvents: "auto",
                transition: "opacity 120ms ease",
                opacity: showPreview ? 0.95 : 1, // 🔧 undvik mix-blend (orsakar svart i vissa fullscreen-lägen)
                transform: "translateZ(0)",
                willChange: "transform, opacity",
              }}
            />

            {/* Overlay/markeringsruta */}
            {overlay && (
              <div
                className="overlay-box"
                role="region"
                aria-label="Placering"
                onPointerDown={(e) => { e.preventDefault(); startMove(e); }}
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
                  borderRadius: 10,
                  boxShadow: "0 0 0 2px rgba(0,0,0,.06), 0 2px 10px rgba(0,0,0,.25)",
                  background: "transparent",
                  cursor: "move",
                }}
              >
                <div
                  style={{
                    position: "absolute", inset: 6,
                    border: "1px dashed color-mix(in srgb, var(--accent) 60%, transparent)",
                    borderRadius: 8, pointerEvents: "none",
                  }}
                />
                {(["nw", "ne", "se", "sw"] as const).map((pos) => {
                  const size = 14;
                  const base = {
                    position: "absolute" as const, width: size, height: size,
                    background: "var(--accent)", borderRadius: 999, boxShadow: "0 1px 4px rgba(0,0,0,.35)",
                  };
                  const styleMap: Record<typeof pos, React.CSSProperties> = {
                    nw: { ...base, left: -size / 2, top: -size / 2, cursor: "nwse-resize" },
                    ne: { ...base, right: -size / 2, top: -size / 2, cursor: "nesw-resize" },
                    se: { ...base, right: -size / 2, bottom: -size / 2, cursor: "nwse-resize" },
                    sw: { ...base, left: -size / 2, bottom: -size / 2, cursor: "nesw-resize" },
                  };
                  return (
                    <div
                      key={pos}
                      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); startResize(pos)(e); }}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={onPointerUp}
                      style={styleMap[pos]}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!figmaErr && !figmaSrc && (
          <div
            style={{
              minHeight: 120,
              display: "grid",
              placeItems: "center",
              border: "1px dashed var(--border)",
              borderRadius: 12,
              padding: 12,
              background: "var(--vscode-editorWidget-background)",
            }}
          >
            <div className="text-foreground" style={{ opacity: 0.85 }}>
              {phase === "onboarding" ? "Öppna via Figma-URI för att ladda en nod." : "Laddar Figma-bild…"}
            </div>
          </div>
        )}
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
