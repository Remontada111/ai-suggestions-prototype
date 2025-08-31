// webview/main.tsx
// Målsättning:
// - Laptop-UI (projekt-preview) i fast 1280×800-stage som skalas för att passa panelen.
// - Figma-preview är ett flyttbart och resizbart fönster OVANFÖR laptop-UI.
// - Endast Figma-fönstret kan justeras. AR låst till 1280×800.
// - Tangentbord: pilar (flytt), Ctrl/Cmd+pilar (resize), Shift=större steg, Space=visa overlay, R=reset, F=full view.
// - Wheel-zoom: Ctrl/Cmd + hjul = resize overlay runt centrum.
// - Figma-URL hämtas via extension. Webview sparar ej token/URL. Refresh på fel.

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
const OVERLAY_MIN_FACTOR = 0.3; // min overlay-storlek relativt 1280×800
const CANVAS_MARGIN = 16; // panelpadding

type UiPhase = "default" | "onboarding" | "loading";
type IncomingMsg =
  | { type: "devurl"; url: string }
  | { type: "ui-phase"; phase: UiPhase }
  | { type: "init"; fileKey: string; nodeId: string; token?: string; figmaToken?: string }
  | { type: "figma-image-url"; url: string }
  | { type: "ui-error"; message: string };

type Vec2 = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function round(n: number) { return Math.round(n); }
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
  // UI-phase, devurl, figma, overlay
  const [phase, setPhase] = useState<UiPhase>("default");
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const [figmaErr, setFigmaErr] = useState<string | null>(null);
  const [figmaSrc, setFigmaSrc] = useState<string | null>(null);
  const [figmaN, setFigmaN] = useState<{ w: number; h: number } | null>(null);

  // Endast för att spegla “visa overlay under interaktion”
  const [showOverlay, setShowOverlay] = useState(false);

  // Stage (panelmått)
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);

  // Overlay i projektets koordinater (1280×800)
  type StageRect = { x: number; y: number; w: number; h: number };
  const [overlayStage, setOverlayStage] = useState<StageRect | null>(null);

  // För att undvika refresh-loopar
  const refreshAttempts = useRef(0);

  // Interaktion
  const dragState = useRef<{
    mode: "move" | "nw" | "ne" | "se" | "sw" | null;
    startPt: Vec2;    // klientpx
    startRect: StageRect;
  } | null>(null);
  const spaceHeld = useRef(false);
  const fullViewRequested = useRef(false);

  // Persist
  useEffect(() => {
    const st = vscode.getState?.() || {};
    if (st.overlayStage) setOverlayStage(st.overlayStage);
    if (st.showOverlay) setShowOverlay(!!st.showOverlay);
    if (st.fullViewRequested) fullViewRequested.current = true;
  }, []);
  const persistState = useCallback((extra?: Record<string, any>) => {
    const current = {
      overlayStage,
      showOverlay,
      fullViewRequested: fullViewRequested.current,
      ...extra,
    };
    try { vscode.setState?.(current); } catch {}
  }, [overlayStage, showOverlay]);

  // Följ editorstorlek
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
  const sentReadyRef = useRef(false);
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const msg = ev.data as IncomingMsg;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "devurl") {
        setDevUrl(msg.url);
        return;
      }
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

      if (msg.type === "init") {
        setFigmaSrc(null);
        setFigmaErr(null);
        refreshAttempts.current = 0;
        return;
      }
    }
    window.addEventListener("message", onMsg);

    if (!sentReadyRef.current) {
      vscode.postMessage({ type: "ready" });
      sentReadyRef.current = true;
    }
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Stage-dimensioner (laptop-UI)
  const stageDims = useMemo(() => {
    const s = Math.min(containerW / PROJECT_BASE.w, containerH / PROJECT_BASE.h);
    const scale = clamp(s, PREVIEW_MIN_SCALE, PREVIEW_MAX_SCALE);
    const w = round(PROJECT_BASE.w * scale);
    const h = round(PROJECT_BASE.h * scale);
    const left = round((containerW - w) / 2);
    const top  = round((containerH - h) / 2);
    return { w, h, left, top, scale };
  }, [containerW, containerH]);

  // Initiera overlay när Figma laddas (80% av stage, centrerat)
  const onFigmaLoad = useCallback((ev: React.SyntheticEvent<HTMLImageElement>) => {
    const el = ev.currentTarget;
    const natural = { w: el.naturalWidth || el.width, h: el.naturalHeight || el.height };
    setFigmaN(natural);

    if (!overlayStage) {
      const margin = 0.1;
      const w = round(PROJECT_BASE.w * (1 - margin * 2));
      const h = round(PROJECT_BASE.h * (1 - margin * 2));
      const x = round((PROJECT_BASE.w - w) / 2);
      const y = round((PROJECT_BASE.h - h) / 2);
      const rect: StageRect = { x, y, w, h };
      setOverlayStage(rect);
      setShowOverlay(true);
      persistState({ overlayStage: rect, showOverlay: true });
    }
  }, [overlayStage, persistState]);

  const onFigmaError = useCallback(() => {
    if (refreshAttempts.current < 3) {
      refreshAttempts.current += 1;
      setFigmaErr("Förlorad åtkomst till Figma-bilden (troligen utgången URL). Försöker igen…");
      vscode.postMessage({ cmd: "refreshFigmaImage" });
    } else {
      setFigmaErr("Kunde inte ladda Figma-bilden efter flera försök. Kontrollera token/åtkomst.");
    }
  }, []);

  // Hjälpare för overlay-clamp i stage-koordinater
  const minOverlay = useMemo(() => ({
    w: PROJECT_BASE.w * OVERLAY_MIN_FACTOR,
    h: PROJECT_BASE.h * OVERLAY_MIN_FACTOR,
  }), []);
  const ar = useMemo(() => PROJECT_BASE.w / PROJECT_BASE.h, []);

  function clampOverlayToStage(r: StageRect): StageRect {
    let x = clamp(r.x, 0, PROJECT_BASE.w - r.w);
    let y = clamp(r.y, 0, PROJECT_BASE.h - r.h);
    let w = clamp(r.w, minOverlay.w, PROJECT_BASE.w);
    let h = clamp(r.h, minOverlay.h, PROJECT_BASE.h);
    // håll AR
    const fitted = arFit(w, h, ar);
    w = fitted.w; h = fitted.h;
    x = clamp(x, 0, PROJECT_BASE.w - w);
    y = clamp(y, 0, PROJECT_BASE.h - h);
    return { x: round(x), y: round(y), w: round(w), h: round(h) };
  }

  // Begär full view en gång
  const requestFullViewIfNeeded = useCallback(() => {
    if (!fullViewRequested.current) {
      vscode.postMessage({ cmd: "enterFullView" });
      fullViewRequested.current = true;
      persistState();
    }
  }, [persistState]);

  // Interaktion start/slut
  const beginInteraction = useCallback((e?: React.PointerEvent) => {
    requestFullViewIfNeeded();
    setShowOverlay(true);
    persistState({ showOverlay: true });
    if (e) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    document.body.classList.add("dragging");
    const end = () => {
      dragState.current = null;
      document.body.classList.remove("dragging");
      if (!spaceHeld.current) {
        setTimeout(() => { setShowOverlay(false); persistState({ showOverlay: false }); }, 120);
      }
      // Sänd placement till extension
      if (overlayStage && figmaN) {
        vscode.postMessage({
          type: "placementAccepted",
          payload: {
            projectBase: { ...PROJECT_BASE },
            overlayStage: { ...overlayStage }, // exakt pos och size i 1280×800
            imageNatural: { ...figmaN },
            ts: Date.now(),
            source: "webview/main.tsx",
          },
        });
      }
    };
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }, [overlayStage, figmaN, persistState, requestFullViewIfNeeded]);

  // Flytt
  const onOverlayPointerDown = useCallback((e: React.PointerEvent) => {
    if (!overlayStage) return;
    beginInteraction(e);
    dragState.current = {
      mode: "move",
      startPt: { x: e.clientX, y: e.clientY },
      startRect: { ...overlayStage },
    };
  }, [overlayStage, beginInteraction]);

  const onOverlayPointerMove = useCallback((e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st || !overlayStage) return;
    const dxPx = e.clientX - st.startPt.x;
    const dyPx = e.clientY - st.startPt.y;
    const dx = dxPx / stageDims.scale;
    const dy = dyPx / stageDims.scale;

    if (st.mode === "move") {
      const next = clampOverlayToStage({
        ...st.startRect,
        x: st.startRect.x + dx,
        y: st.startRect.y + dy,
      });
      setOverlayStage(next);
      persistState({ overlayStage: next });
    } else {
      // resize
      let { x, y, w, h } = st.startRect;
      if (st.mode === "nw") {
        let newW = st.startRect.w - dx; let newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }); w = fitted.w; h = fitted.h;
        x = st.startRect.x + (st.startRect.w - w);
        y = st.startRect.y + (st.startRect.h - h);
      } else if (st.mode === "ne") {
        let newW = st.startRect.w + dx; let newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }); w = fitted.w; h = fitted.h;
        x = st.startRect.x;
        y = st.startRect.y + (st.startRect.h - h);
      } else if (st.mode === "se") {
        let newW = st.startRect.w + dx; let newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }); w = fitted.w; h = fitted.h;
        x = st.startRect.x; y = st.startRect.y;
      } else if (st.mode === "sw") {
        let newW = st.startRect.w - dx; let newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }); w = fitted.w; h = fitted.h;
        x = st.startRect.x + (st.startRect.w - w);
        y = st.startRect.y;
      }
      const next = clampOverlayToStage({ x, y, w, h });
      setOverlayStage(next);
      persistState({ overlayStage: next });
    }
  }, [overlayStage, stageDims.scale, ar, persistState]);

  // Resize-handle start
  const startResize = (mode: "nw" | "ne" | "se" | "sw") => (e: React.PointerEvent) => {
    if (!overlayStage) return;
    e.stopPropagation();
    beginInteraction(e);
    dragState.current = {
      mode,
      startPt: { x: e.clientX, y: e.clientY },
      startRect: { ...overlayStage },
    };
  };

  // Wheel = resize runt centrum
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!overlayStage) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.98 : 1.02;
    const newW = overlayStage.w * factor;
    const newH = newW / ar;
    const sized = clampOverlayToStage(withCenterResize(overlayStage, newW, newH));
    setOverlayStage(sized);
    persistState({ overlayStage: sized, showOverlay: true });
    setShowOverlay(true);
  }, [overlayStage, ar, persistState]);

  // Tangentbord
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!overlayStage) return;

      if (e.code === "Space" && !e.repeat) {
        spaceHeld.current = true;
        setShowOverlay(true);
        persistState({ showOverlay: true });
        e.preventDefault();
        return;
      }

      const step = e.shiftKey ? 10 : 1;
      let changed = false;
      let next: StageRect = { ...overlayStage };
      const isMeta = e.ctrlKey || e.metaKey;

      if (!isMeta) {
        if (e.key === "ArrowLeft")  { next.x -= step; changed = true; }
        if (e.key === "ArrowRight") { next.x += step; changed = true; }
        if (e.key === "ArrowUp")    { next.y -= step; changed = true; }
        if (e.key === "ArrowDown")  { next.y += step; changed = true; }
      } else {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          const factor = 1 + (e.shiftKey ? 0.05 : 0.02);
          const newW = next.w * factor; const newH = newW / ar;
          next = withCenterResize(next, newW, newH); changed = true;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          const factor = 1 - (e.shiftKey ? 0.05 : 0.02);
          const newW = next.w * factor; const newH = newW / ar;
          next = withCenterResize(next, newW, newH); changed = true;
        }
      }

      if (e.key === "r" || e.key === "R") {
        const sized = arFit(PROJECT_BASE.w, PROJECT_BASE.h, ar);
        const w = round(Math.min(sized.w, PROJECT_BASE.w));
        const h = round(Math.min(sized.h, PROJECT_BASE.h));
        next = { w, h, x: round((PROJECT_BASE.w - w) / 2), y: round((PROJECT_BASE.h - h) / 2) };
        changed = true;
      }
      if (e.key === "f" || e.key === "F") vscode.postMessage({ cmd: "enterFullView" });

      if (changed) {
        next = clampOverlayToStage(next);
        setOverlayStage(next);
        persistState({ overlayStage: next });
        setShowOverlay(true);
        e.preventDefault();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        spaceHeld.current = false;
        setShowOverlay(false);
        persistState({ showOverlay: false });
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
      window.removeEventListener("keyup", onKeyUp, { capture: true } as any);
    };
  }, [overlayStage, ar, persistState]);

  // Auto-onboarding triggers
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

  const showChooseCard = !devUrl && !figmaSrc && phase === "onboarding";

  return (
    <div
      ref={rootRef}
      className="panel-root"
      style={{ position: "fixed", inset: 0, padding: CANVAS_MARGIN }}
      onWheel={onWheel}
    >
     {/* Laptop-UI */}
<div
  className="laptop-shell"
  style={{
    position: "absolute",
    left: stageDims.left + CANVAS_MARGIN,
    top:  stageDims.top  + CANVAS_MARGIN,
    width: stageDims.w,            // klippruta
    height: stageDims.h,
    zIndex: 5,
    visibility: devUrl ? "visible" : "hidden",
    overflow: "hidden",
  }}
>
  {(!devUrl || phase !== "default") && (
    <div className="skeleton" aria-hidden="true" style={{ width: "100%", height: "100%", borderRadius: 12 }} />
  )}

  {devUrl && (
    <div
      style={{
        position: "absolute",
        left: 0, top: 0,
        width: PROJECT_BASE.w,
        height: PROJECT_BASE.h,
        transform: `scale(${stageDims.scale})`,
        transformOrigin: "top left",
      }}
    >
      <iframe
        title="preview"
        src={devUrl}
        sandbox="allow-scripts allow-forms allow-same-origin"
        style={{
          width: PROJECT_BASE.w,
          height: PROJECT_BASE.h,
          border: 0,
          pointerEvents: "none",
          background: "#fff",
          display: "block",
        }}
      />
    </div>
  )}
</div>

      {/* ÖVERLAGER: Onboarding-kort */}
      <ChooseProjectCard visible={showChooseCard} compact={!!devUrl && phase === "default"} busy={phase === "loading"} />

      {/* Figma-fönster ovanpå laptop-UI */}
      {figmaErr && (
        <div
          style={{
            position: "absolute",
            left: CANVAS_MARGIN,
            right: CANVAS_MARGIN,
            top: CANVAS_MARGIN,
            display: "grid",
            placeItems: "center",
            zIndex: 20,
          }}
        >
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
        </div>
      )}

      {figmaSrc && overlayStage && (
        <div
          // Placera i stage-koordinater
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onOverlayPointerMove}
          onPointerUp={() => {}}
          onPointerCancel={() => {}}
          style={{
            position: "absolute",
            left: stageDims.left + CANVAS_MARGIN + round(overlayStage.x * stageDims.scale),
            top:  stageDims.top  + CANVAS_MARGIN + round(overlayStage.y * stageDims.scale),
            width:  round(overlayStage.w * stageDims.scale),
            height: round(overlayStage.h * stageDims.scale),
            zIndex: 20,
            border: "2px solid var(--accent)",
            borderRadius: 10,
            boxShadow: "0 0 0 2px rgba(0,0,0,.06), 0 2px 10px rgba(0,0,0,.25)",
            background: "#fff",
            cursor: "move",
            display: "grid",
          }}
        >
          {/* Bilden fyller fönstret; Figma-node renderas som preview */}
          <img
            src={figmaSrc}
            alt="Figma node"
            draggable={false}
            onLoad={onFigmaLoad}
            onError={onFigmaError}
            style={{
              width: "100%",
              height: "100%",
              display: "block",
              objectFit: "cover",
              userSelect: "none",
              pointerEvents: "none",
            }}
          />

          {/* Inner dotted to aid alignment, endast när overlay visas */}
          {showOverlay && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 6,
                border: "1px dashed color-mix(in srgb, var(--accent) 60%, transparent)",
                borderRadius: 8,
                pointerEvents: "none",
              }}
            />
          )}

          {/* Hörn-handtag */}
          {(["nw", "ne", "se", "sw"] as const).map((pos) => {
            const size = 14;
            const base: React.CSSProperties = {
              position: "absolute",
              width: size, height: size,
              background: "var(--accent)",
              borderRadius: 999,
              boxShadow: "0 1px 4px rgba(0,0,0,.35)",
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
                onPointerDown={startResize(pos)}
                onPointerMove={onOverlayPointerMove}
                style={styleMap[pos]}
              />
            );
          })}
        </div>
      )}

      {/* Placeholder om Figma inte är laddad men vi inte är i fel eller onboarding */}
      {!figmaErr && !figmaSrc && phase !== "onboarding" && (
        <div
          style={{
            position: "absolute",
            left: CANVAS_MARGIN, right: CANVAS_MARGIN, top: CANVAS_MARGIN,
            display: "grid", placeItems: "center", zIndex: 10,
          }}
        >
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
              Laddar Figma-bild…
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Montera appen
const rootEl = document.getElementById("root");
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(<App />);
}
