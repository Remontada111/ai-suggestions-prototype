// webview/main.tsx
// Mål:
// - 1280×800 stage som skalas i panelen.
// - Stöd för flera Figma-noder samtidigt.
// - Välj en nod → flytta/resize med mus, hjul och tangentbord.
// - Papperskorg visas för vald nod. Efter borttagning visas Undo tills återställd.
// - Figma-bild hämtas via extension per nod och renderas ovanför devUrl-iframe.
// - Accept låser interaktion och visar central loader, döljer project preview.

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
import ChatBar from "./ChatBar";
import { getVsCodeApi } from "./vscodeApi";
import { Trash2, RotateCcw } from "lucide-react";
import Loader from "./Loader";

const vscode = getVsCodeApi();

// ─────────────────────────────────────────────────────────
// Konstanter / utils
// ─────────────────────────────────────────────────────────
const PROJECT_BASE = { w: 1280, h: 800 };
const PREVIEW_MIN_SCALE = 0.3;
const PREVIEW_MAX_SCALE = Number.POSITIVE_INFINITY;
const CANVAS_MARGIN = 16;
const BOTTOM_GAP = 16;

type UiPhase = "default" | "onboarding" | "loading";
type NodeId = string; // `${fileKey}:${nodeId}`

type IncomingMsg =
  | { type: "devurl"; url: string }
  | { type: "ui-phase"; phase: UiPhase }
  | { type: "add-node"; fileKey: string; nodeId: string; token?: string; figmaToken?: string }
  | { type: "figma-image-url"; fileKey: string; nodeId: string; url: string }
  | { type: "seed-placement"; fileKey: string; nodeId: string; payload: any }
  | { type: "ui-error"; message: string }
  | { type: "job-started"; taskId: string; fileKey: string; nodeId: string }
  | { type: "job-finished"; status: "SUCCESS" | "FAILURE" | "CANCELLED"; pr_url?: string; error?: string };

type Vec2 = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type StageRect = Rect;

type NodeState = {
  fileKey: string;
  nodeId: string;
  imgSrc: string | null;
  imgN: { w: number; h: number } | null;
  rect: StageRect | null;
  deleted: boolean;
};

function idOf(f: string, n: string): NodeId { return `${f}:${n}`; }
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
function normRect(r: Rect, base = PROJECT_BASE) {
  return { x: r.x / base.w, y: r.y / base.h, w: r.w / base.w, h: r.h / base.h };
}
function nearEdges(n: { x: number; y: number; w: number; h: number }, tol = 0.02) {
  const right = n.x + n.w, bottom = n.y + n.h;
  return { left: n.x < tol, right: 1 - right < tol, top: n.y < tol, bottom: 1 - bottom < tol };
}
// Snabb pixel-scan för att hitta icke-transparent innehåll (kräver CORS på bild-URL)
function computeContentBoundsPx(img: HTMLImageElement): { x: number; y: number; w: number; h: number } | null {
  try {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const alphaT = 8;
    let L = w, R = -1, T = h, B = -1;
    const stride = Math.max(1, Math.floor(Math.min(w, h) / 400));
    for (let y = 0; y < h; y += stride) {
      const rowOff = y * w * 4;
      for (let x = 0; x < w; x += stride) {
        const a = data[rowOff + x * 4 + 3];
        if (a > alphaT) {
          if (x < L) L = x;
          if (x > R) R = x;
          if (y < T) T = y;
          if (y > B) B = y;
        }
      }
    }
    if (R < 0) return null;
    return { x: L, y: T, w: R - L + 1, h: B - T + 1 };
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────
// UI: “Pick project”-kort
// ─────────────────────────────────────────────────────────
function ChooseProjectCard(props: { visible: boolean; compact?: boolean; busy?: boolean }) {
  const { visible, compact, busy } = props;
  if (!visible) return null;

  const onPickProject = () => vscode.postMessage({ cmd: "pickFolder" });

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
          width: compact ? 300 : 380,
          height: compact ? 170 : 220,
          padding: 14,
          borderRadius: 16,
          background: "linear-gradient(135deg, #6dd5ed, #2193b0)",
          boxShadow: "0 15px 30px rgba(0,0,0,.25)",
          position: "relative",
          color: "white",
          overflow: "hidden",
        }}
      >
        <style>{`
          .pp-wrap { position: absolute; inset: 0; display: grid; place-items: center; }
          .pp-folder { position: relative; width: 150px; height: 110px; transform-origin: 50% 80%; transition: transform .28s ease; }
          .pp-folder .body { position:absolute; inset:0; border-radius:14px; background: linear-gradient(135deg,#ffe563,#ffc663); box-shadow: 0 10px 25px rgba(0,0,0,.25); }
          .pp-folder .lid { position:absolute; left:18px; top:-14px; width:94px; height:26px; border-radius:12px 12px 0 0; background: linear-gradient(135deg,#ff9a56,#ff6f56); box-shadow: 0 6px 14px rgba(0,0,0,.2); transform-origin: 12px 26px; transition: transform .28s ease; }
          .pp-card:hover .pp-folder { transform: translateY(-2px) scale(1.02); }
          .pp-card:hover .lid { transform: rotate(-12deg); }
          .pp-cta { position:absolute; left:14px; right:14px; bottom:14px; display:flex; gap:10px; align-items:center; justify-content:center; }
          .pp-btn { appearance:none; border:none; cursor:pointer; padding:12px 14px; border-radius:10px; font-weight:700; color:#123; background: rgba(255,255,255,.94); box-shadow: 0 4px 10px rgba(0,0,0,.18); transition: transform .12s ease, background .2s ease, box-shadow .2s ease; }
          .pp-btn:hover { transform: translateY(-1px); background:#fff; box-shadow: 0 6px 16px rgba(0,0,0,.22); }
          .pp-sub { position:absolute; left:14px; right:14px; bottom:64px; font-size:12px; opacity:.95; text-align:center; }
        `}</style>

        <div className="pp-card" style={{ position: "absolute", inset: 0 }}>
          <div className="pp-wrap" aria-hidden>
            <div className="pp-folder">
              <div className="body" />
              <div className="lid" />
            </div>
          </div>
        </div>

        <div className="pp-sub">
          {busy ? "Startar förhandsvisning…" : "Välj ett projekt att förhandsvisa. Ditt val sparas."}
        </div>
        <div className="pp-cta">
          <button className="pp-btn" onClick={onPickProject}>Pick project</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────
function App() {
  const [phase, setPhase] = useState<UiPhase>("default");
  const [devUrl, setDevUrl] = useState<string | null>(null);
  const [figmaErr, setFigmaErr] = useState<string | null>(null);

  const [nodes, setNodes] = useState<Record<NodeId, NodeState>>({});
  const [selectedId, setSelectedId] = useState<NodeId | null>(null);
  const [deletedStack, setDeletedStack] = useState<NodeId[]>([]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const imgRefs = useRef<Record<NodeId, HTMLImageElement | null>>({ });
  const selectedRef = useRef<NodeId | null>(null);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  const [chatH, setChatH] = useState(0);

  const [showOverlay, setShowOverlay] = useState(false);
  const spaceHeld = useRef(false);
  const fullViewRequested = useRef(false);
  const refreshAttempts = useRef<Record<NodeId, number>>({});

  // Seeds som kom före naturliga mått
  const pendingSeeds = useRef<Record<NodeId, any>>({});

  // Jobbstatus
  const [job, setJob] = useState<{ status: "idle" | "running" | "done" | "error"; taskId?: string }>({ status: "idle" });

  // editorstorlek: reservera plats för chatten
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[entries.length - 1];
      if (!e) return;
      const w = Math.max(0, e.contentRect.width - CANVAS_MARGIN * 2);
      const hRaw = Math.max(0, e.contentRect.height - CANVAS_MARGIN * 2);
      const reserved = chatH > 0 ? chatH + BOTTOM_GAP : 96;
      const h = Math.max(0, hRaw - reserved);
      setContainerW(w);
      setContainerH(h);
    });
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, [chatH]);

  // inkommande meddelanden
  const sentReadyRef = useRef(false);

  const current = selectedId ? nodes[selectedId] || null : null;
  const currentAR = useMemo(() => {
    if (!current?.imgN) return PROJECT_BASE.w / PROJECT_BASE.h;
    const ar = current.imgN.w / current.imgN.h;
    return ar > 0 ? ar : PROJECT_BASE.w / PROJECT_BASE.h;
  }, [current?.imgN]);

  // För global "Accept": välj första giltiga nod om ingen vald
  const firstEligibleId = useMemo(() => {
    if (selectedId) {
      const ns = nodes[selectedId];
      if (ns && ns.rect && ns.imgN && !ns.deleted) return selectedId;
    }
    for (const [id, ns] of Object.entries(nodes)) {
      if (ns && ns.rect && ns.imgN && !ns.deleted) return id as NodeId;
    }
    return null;
  }, [selectedId, nodes]);
  const canAccept = !!firstEligibleId && job.status !== "running";

  const clampOverlayToStage = useCallback((r: Rect, ar: number) => {
    const minW = PROJECT_BASE.w * 0.15;
    let w = clamp(r.w, minW, PROJECT_BASE.w);
    let h = w / ar;
    if (h > PROJECT_BASE.h) { h = PROJECT_BASE.h; w = h * ar; }
    let x = clamp(r.x, 0, PROJECT_BASE.w - w);
    let y = clamp(r.y, 0, PROJECT_BASE.h - h);
    return { x: round(x), y: round(y), w: round(w), h: round(h) };
  }, []);

  const requestFullViewIfNeeded = useCallback(() => {
    if (!fullViewRequested.current) {
      vscode.postMessage({ cmd: "enterFullView" });
      fullViewRequested.current = true;
    }
  }, []);

  // persist bara små UI-flaggor
  const persistState = useCallback((extra?: Record<string, any>) => {
    const currentState = {
      showOverlay,
      fullViewRequested: fullViewRequested.current,
      selectedId,
      ...extra,
    };
    try { vscode.setState?.(currentState); } catch {}
  }, [showOverlay, selectedId]);

  // Återställ små UI-flaggor
  useEffect(() => {
    const st = vscode.getState?.() || {};
    if (st.showOverlay) setShowOverlay(!!st.showOverlay);
    if (st.fullViewRequested) fullViewRequested.current = true;
    if (typeof st.selectedId === "string") setSelectedId(st.selectedId);
  }, []);

  // stage-dimensioner
  const stageDims = useMemo(() => {
    const s = Math.min(containerW / PROJECT_BASE.w, containerH / PROJECT_BASE.h);
    const scale = clamp(s, PREVIEW_MIN_SCALE, PREVIEW_MAX_SCALE);
    const w = round(PROJECT_BASE.w * scale);
    const h = round(PROJECT_BASE.h * scale);
    const left = round((containerW - w) / 2);
    const top = round((containerH - h) / 2);
    return { w, h, left, top, scale };
  }, [containerW, containerH]);

  // Auto-onboarding accept
  const [requestedProjectOnce, setRequestedProjectOnce] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!requestedProjectOnce && !devUrl && phase === "onboarding") {
        vscode.postMessage({ cmd: "acceptCandidate" });
        setRequestedProjectOnce(true);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [devUrl, phase, requestedProjectOnce]);

  // Meddelanden
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const msg = ev.data as IncomingMsg;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "devurl") { setDevUrl(msg.url); return; }

      if (msg.type === "ui-phase") {
        setPhase(msg.phase);
        if (msg.phase === "onboarding") {
          setDevUrl(null);
          setFigmaErr(null);
          setNodes({});
          setSelectedId(null);
          setShowOverlay(false);
          setDeletedStack([]); // nollställ historik
          persistState({ showOverlay: false, selectedId: null });
        }
        return;
      }

      if (msg.type === "add-node") {
        const id = idOf(msg.fileKey, msg.nodeId);
        setNodes(s => s[id] ? s : ({
          ...s,
          [id]: {
            fileKey: msg.fileKey,
            nodeId: msg.nodeId,
            imgSrc: null,
            imgN: null,
            rect: null,
            deleted: false,
          }
        }));
        setSelectedId(id);
        return;
      }

      if (msg.type === "figma-image-url") {
        const id = idOf(msg.fileKey, msg.nodeId);
        setNodes(s => ({
          ...s,
          [id]: { ...(s[id] || { fileKey: msg.fileKey, nodeId: msg.nodeId, imgN: null, rect: null, deleted: false }), imgSrc: msg.url }
        }));
        setFigmaErr(null);
        return;
      }

      if (msg.type === "seed-placement" && msg.payload) {
        const id = idOf(msg.fileKey, msg.nodeId);
        pendingSeeds.current[id] = msg.payload;
        // Om naturliga mått redan finns så applicera direkt
        setNodes(s => {
          const ns = s[id];
          if (!ns?.imgN) return s;
          const p = pendingSeeds.current[id];
          if (!p?.overlayStage) return s;
          let rect = { ...p.overlayStage };
          // Justera mot aktuell bild-AR
          const ar = ns.imgN.w / ns.imgN.h;
          rect = withCenterResize(rect, rect.w, rect.w / ar);
          const clamped = clampOverlayToStage(rect, ar);
          delete pendingSeeds.current[id];
          return { ...s, [id]: { ...ns, rect: clamped } };
        });
        return;
      }

      if (msg.type === "ui-error") { setFigmaErr(msg.message || "Okänt fel."); return; }

      if (msg.type === "job-started") {
        setJob({ status: "running", taskId: msg.taskId });
        setPhase("loading"); // försäkran
        return;
      }

      if (msg.type === "job-finished") {
        if (msg.status === "SUCCESS") {
          setJob({ status: "done" });
        } else if (msg.status === "CANCELLED") {
          setJob({ status: "idle" });
        } else {
          setJob({ status: "error" });
        }
        // Återgå till preview
        setPhase("default");
        return;
      }
    }

    window.addEventListener("message", onMsg);
    if (!sentReadyRef.current) {
      vscode.postMessage({ type: "ready" });
      sentReadyRef.current = true;
    }
    return () => window.removeEventListener("message", onMsg);
  }, [clampOverlayToStage, persistState]);

  // Auto-återställ jobbstatus från done/error → idle
  useEffect(() => {
    if (job.status === "done" || job.status === "error") {
      const t = setTimeout(() => setJob({ status: "idle" }), 1800);
      return () => clearTimeout(t);
    }
  }, [job.status]);

  // Bild onload per nod
  const onLoadFor = useCallback((id: NodeId) => (ev: React.SyntheticEvent<HTMLImageElement>) => {
    const el = ev.currentTarget;
    const natural = { w: el.naturalWidth || el.width, h: el.naturalHeight || el.height };
    setNodes(s => {
      const ns = s[id]; if (!ns) return s;
      let rect = ns.rect;
      if (!rect) {
        const availW = PROJECT_BASE.w * 0.9;
        const availH = PROJECT_BASE.h * 0.9;
        const ar = natural.w / natural.h;
        const fitted = arFit(availW, availH, ar);
        const w = round(Math.min(fitted.w, PROJECT_BASE.w));
        const h = round(Math.min(fitted.h, PROJECT_BASE.h));
        rect = { x: round((PROJECT_BASE.w - w) / 2), y: round((PROJECT_BASE.h - h) / 2), w, h };
      }
      return { ...s, [id]: { ...ns, imgN: natural, rect } };
    });

    // Seed som väntat
    const p = pendingSeeds.current[id];
    if (p?.overlayStage) {
      setNodes(s => {
        const ns = s[id]; if (!ns?.imgN) return s;
        let rect = { ...p.overlayStage };
        const ar = ns.imgN.w / ns.imgN.h;
        rect = withCenterResize(rect, rect.w, rect.w / ar);
        const clamped = clampOverlayToStage(rect, ar);
        delete pendingSeeds.current[id];
        return { ...s, [id]: { ...ns, rect: clamped } };
      });
    }
  }, [clampOverlayToStage]);

  const onErrorFor = useCallback((id: NodeId) => () => {
    const att = (refreshAttempts.current[id] || 0) + 1;
    refreshAttempts.current[id] = att;
    if (att <= 3) {
      const delay = 500 * Math.pow(2, att - 1);
      setFigmaErr(`Kunde inte ladda bild (${att}/3)…`);
      setTimeout(() => {
        const ns = nodes[id];
        if (ns) vscode.postMessage({ cmd: "refreshFigmaImage", nodeId: ns.nodeId });
      }, delay);
    } else {
      setFigmaErr("Kunde inte ladda Figma-bilden efter flera försök.");
    }
  }, [nodes]);

  // Klick utanför överlays → avmarkera
  useEffect(() => {
    function onGlobalPointerDown(e: PointerEvent) {
      const el = e.target as Element | null;
      const keep = !!el?.closest?.('[data-overlay="1"],[data-keep-selection="1"]');
      if (!keep) {
        setSelectedId(null);
        setShowOverlay(false);
        persistState({ showOverlay: false, selectedId: null });
      }
    }
    window.addEventListener("pointerdown", onGlobalPointerDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onGlobalPointerDown, { capture: true } as any);
  }, [persistState]);

  // Drag/resize-state
  const dragState = useRef<{
    id: NodeId;
    mode: "move" | "nw" | "ne" | "se" | "sw" | null;
    startPt: Vec2;
    startRect: StageRect;
  } | null>(null);

  const beginInteraction = useCallback((id: NodeId, e?: React.PointerEvent) => {
    requestFullViewIfNeeded();
    setSelectedId(id);
    setShowOverlay(true);
    persistState({ showOverlay: true, selectedId: id });
    if (e) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    document.body.classList.add("dragging");

    const end = () => {
      dragState.current = null;
      document.body.classList.remove("dragging");
      if (!spaceHeld.current && !selectedRef.current) {
        setTimeout(() => { setShowOverlay(false); persistState({ showOverlay: false }); }, 80);
      }

      const ns = selectedRef.current ? nodes[selectedRef.current] : null;
      if (!ns || !ns.rect || !ns.imgN || ns.deleted) return;

      const imgEl = selectedRef.current ? imgRefs.current[selectedRef.current] : null;
      const contentPx = imgEl ? computeContentBoundsPx(imgEl) : null;

      const arImg = ns.imgN.w / ns.imgN.h;
      const arOverlay = ns.rect.w / ns.rect.h;
      const arDeltaPct = Math.abs(arOverlay - arImg) / arImg;

      const norm = normRect(ns.rect);
      const edges = nearEdges(norm);
      const center = { x: norm.x + norm.w / 2, y: norm.y + norm.h / 2 };
      const sizePct = norm.w * norm.h;

      let contentInProject: Rect | null = null;
      if (contentPx) {
        const sx = ns.imgN.w / ns.rect.w;
        const sy = ns.imgN.h / ns.rect.h;
        contentInProject = {
          x: ns.rect.x + contentPx.x / sx,
          y: ns.rect.y + contentPx.y / sy,
          w: contentPx.w / sx,
          h: contentPx.h / sy,
        };
      }

      const payload = {
        projectBase: { ...PROJECT_BASE },
        overlayStage: { ...ns.rect },
        imageNatural: { ...ns.imgN },
        norm, center, sizePct,
        ar: { image: arImg, overlay: arOverlay, deltaPct: arDeltaPct },
        edges,
        content: contentPx ? {
          px: contentPx,
          project: contentInProject!,
          norm: contentInProject ? normRect(contentInProject) : null,
        } : null,
        ts: Date.now(),
        source: "webview/main.tsx",
      };
      // Endast preview under drag/resize – inget jobb triggas.
      vscode.postMessage({ type: "placementPreview", fileKey: ns.fileKey, nodeId: ns.nodeId, payload });
    };

    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  }, [nodes, persistState, requestFullViewIfNeeded]);

  // Flytt/resize-handlers
  const onOverlayPointerDown = useCallback((id: NodeId) => (e: React.PointerEvent) => {
    if (job.status === "running") return;
    const ns = nodes[id];
    if (!ns?.rect || ns.deleted) return;
    beginInteraction(id, e);
    dragState.current = { id, mode: "move", startPt: { x: e.clientX, y: e.clientY }, startRect: { ...ns.rect } };
  }, [nodes, beginInteraction, job.status]);

  const onOverlayPointerMove = useCallback((e: React.PointerEvent) => {
    if (job.status === "running") return;
    const st = dragState.current;
    if (!st) return;
    const ns = nodes[st.id];
    if (!ns?.rect || !ns.imgN || ns.deleted) return;

    const dxPx = e.clientX - st.startPt.x;
    const dyPx = e.clientY - st.startPt.y;
    const dx = dxPx / stageDims.scale;
    const dy = dyPx / stageDims.scale;

    const ar = ns.imgN.w / ns.imgN.h;

    if (st.mode === "move") {
      const next = clampOverlayToStage(
        { ...st.startRect, x: st.startRect.x + dx, y: st.startRect.y + dy },
        ar
      );
      setNodes(s => ({ ...s, [st.id]: { ...ns, rect: next } }));
    } else {
      let { x, y, w, h } = st.startRect;
      if (st.mode === "nw") {
        const newW = st.startRect.w - dx; const newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }, ar); w = fitted.w; h = fitted.h;
        x = st.startRect.x + (st.startRect.w - w);
        y = st.startRect.y + (st.startRect.h - h);
      } else if (st.mode === "ne") {
        const newW = st.startRect.w + dx; const newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }, ar); w = fitted.w; h = fitted.h;
        x = st.startRect.x;
        y = st.startRect.y + (st.startRect.h - h);
      } else if (st.mode === "se") {
        const newW = st.startRect.w + dx; const newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }, ar); w = fitted.w; h = fitted.h;
      } else if (st.mode === "sw") {
        const newW = st.startRect.w - dx; const newH = newW / ar;
        const fitted = clampOverlayToStage({ x, y, w: newW, h: newH }, ar); w = fitted.w; h = fitted.h;
        x = st.startRect.x + (st.startRect.w - w);
      }
      const next = clampOverlayToStage({ x, y, w, h }, ar);
      setNodes(s => ({ ...s, [st.id]: { ...ns, rect: next } }));
    }
  }, [nodes, stageDims.scale, clampOverlayToStage, job.status]);

  const startResize = useCallback((id: NodeId, mode: "nw" | "ne" | "se" | "sw") =>
    (e: React.PointerEvent) => {
      if (job.status === "running") return;
      const ns = nodes[id];
      if (!ns?.rect || ns.deleted) return;
      e.stopPropagation();
      beginInteraction(id, e);
      dragState.current = { id, mode, startPt: { x: e.clientX, y: e.clientY }, startRect: { ...ns.rect } };
    }, [nodes, beginInteraction, job.status]);

  // wheel = resize runt centrum
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (job.status === "running") return;
    const id = selectedId; if (!id) return;
    const ns = nodes[id]; if (!ns?.rect || !ns.imgN || ns.deleted) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.98 : 1.02;
    const ar = ns.imgN.w / ns.imgN.h;
    const newW = ns.rect.w * factor;
    const newH = newW / ar;
    const sized = clampOverlayToStage(withCenterResize(ns.rect, newW, newH), ar);
    setNodes(s => ({ ...s, [id]: { ...ns, rect: sized } }));
    setShowOverlay(true);
    persistState({ showOverlay: true });
  }, [nodes, selectedId, clampOverlayToStage, persistState, job.status]);

  // tangentbord när valt
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (job.status === "running") { e.preventDefault(); return; }
      const id = selectedId; if (!id) return;
      const ns = nodes[id]; if (!ns?.rect || !ns.imgN || ns.deleted) return;

      if (e.code === "Space" && !e.repeat) {
        spaceHeld.current = true;
        setShowOverlay(true);
        persistState({ showOverlay: true });
        e.preventDefault();
        return;
      }

      const step = e.shiftKey ? 10 : 1;
      let changed = false;
      let next: Rect = { ...ns.rect };
      const isMeta = e.ctrlKey || e.metaKey;
      const ar = ns.imgN.w / ns.imgN.h;

      if (!isMeta) {
        if (e.key === "ArrowLeft")  { next.x -= step; changed = true; }
        if (e.key === "ArrowRight") { next.x += step; changed = true; }
        if (e.key === "ArrowUp")    { next.y -= step; changed = true; }
        if (e.key === "ArrowDown")  { next.y += step; changed = true; }
      } else {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          const f = 1 + (e.shiftKey ? 0.05 : 0.02);
          next = withCenterResize(next, next.w * f, next.w * f / ar); changed = true;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          const f = 1 - (e.shiftKey ? 0.05 : 0.02);
          next = withCenterResize(next, next.w * f, next.w * f / ar); changed = true;
        }
      }

      if (e.key === "r" || e.key === "R") {
        const fitted = arFit(PROJECT_BASE.w, PROJECT_BASE.h, ar);
        const w = round(Math.min(fitted.w, PROJECT_BASE.w));
        const h = round(Math.min(fitted.h, PROJECT_BASE.h));
        next = { w, h, x: round((PROJECT_BASE.w - w) / 2), y: round((PROJECT_BASE.h - h) / 2) };
        changed = true;
      }
      if (e.key === "f" || e.key === "F") {
        vscode.postMessage({ cmd: "enterFullView" });
      }

      if (changed) {
        next = clampOverlayToStage(next, ar);
        setNodes(s => ({ ...s, [id]: { ...ns, rect: next } }));
        setShowOverlay(true);
        e.preventDefault();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (job.status === "running") { e.preventDefault(); return; }
      if (e.code === "Space") {
        spaceHeld.current = false;
        if (!selectedRef.current) {
          setShowOverlay(false);
          persistState({ showOverlay: false });
        }
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true } as any);
      window.removeEventListener("keyup", onKeyUp, { capture: true } as any);
    };
  }, [nodes, selectedId, clampOverlayToStage, persistState, job.status]);

  // Delete/Undo
  const handleDelete = useCallback(() => {
    if (job.status === "running") return;
    const id = selectedId; if (!id) return;
    const ns = nodes[id]; if (!ns?.rect || ns.deleted) return;
    setNodes(s => ({ ...s, [id]: { ...ns, deleted: true } }));
    setDeletedStack(stk => [id, ...stk]); // push LIFO
    setShowOverlay(false);
    persistState({ showOverlay: false });
  }, [nodes, selectedId, persistState, job.status]);

  // Undo endast för vald nod
  const handleUndoSelected = useCallback(() => {
    if (job.status === "running") return;
    const id = selectedId; if (!id) return;
    setNodes(s => {
      const ns = s[id]; if (!ns) return s;
      return { ...s, [id]: { ...ns, deleted: false } };
    });
    setDeletedStack(stk => stk.filter(x => x !== id));
  }, [selectedId, job.status]);

  // Global LIFO-undo
  const handleUndoTop = useCallback(() => {
    if (job.status === "running") return;
    setDeletedStack(stk => {
      if (!stk.length) return stk;
      const [restoreId, ...rest] = stk;
      setNodes(s => {
        const ns = s[restoreId]; if (!ns) return s;
        return { ...s, [restoreId]: { ...ns, deleted: false } };
      });
      setSelectedId(restoreId);
      setShowOverlay(true);
      persistState({ showOverlay: true, selectedId: restoreId });
      return rest;
    });
  }, [persistState, job.status]);

  // Global ACCEPT – döljer preview och visar central loader
  const handleAccept = useCallback(() => {
    const id = firstEligibleId; if (!id) return;
    const ns = nodes[id]; if (!ns?.rect || !ns.imgN || ns.deleted) return;

    const imgEl = imgRefs.current[id] || null;
    const contentPx = imgEl ? computeContentBoundsPx(imgEl) : null;

    const arImg = ns.imgN.w / ns.imgN.h;
    const arOverlay = ns.rect.w / ns.rect.h;
    const arDeltaPct = Math.abs(arOverlay - arImg) / arImg;

    const norm = normRect(ns.rect);
    const edges = nearEdges(norm);
    const center = { x: norm.x + norm.w / 2, y: norm.y + norm.h / 2 };
    const sizePct = norm.w * norm.h;

    let contentInProject: Rect | null = null;
    if (contentPx) {
      const sx = ns.imgN.w / ns.rect.w;
      const sy = ns.imgN.h / ns.rect.h;
      contentInProject = {
        x: ns.rect.x + contentPx.x / sx,
        y: ns.rect.y + contentPx.y / sy,
        w: contentPx.w / sx,
        h: contentPx.h / sy,
      };
    }

    const payload = {
      projectBase: { ...PROJECT_BASE },
      overlayStage: { ...ns.rect },
      imageNatural: { ...ns.imgN },
      norm, center, sizePct,
      ar: { image: arImg, overlay: arOverlay, deltaPct: arDeltaPct },
      edges,
      content: contentPx ? {
        px: contentPx,
        project: contentInProject!,
        norm: contentInProject ? normRect(contentInProject) : null,
      } : null,
      ts: Date.now(),
      source: "webview/main.tsx",
    };

    setJob({ status: "running" });
    setPhase("loading"); // döljer preview direkt
    vscode.postMessage({ type: "placementAccepted", fileKey: ns.fileKey, nodeId: ns.nodeId, payload });
  }, [firstEligibleId, nodes]);

  // Beräkna pixelpositioner för vald overlay (ankra knappar)
  const rootPadding = (!devUrl) ? CANVAS_MARGIN : 0;
  const selRectPx = useMemo(() => {
    if (!selectedId) return null;
    const ns = nodes[selectedId];
    if (!ns?.rect) return null;
    const s = stageDims.scale;
    const r = ns.rect;
    return {
      left: stageDims.left + rootPadding + r.x * s,
      top:  stageDims.top  + rootPadding + r.y * s,
      w:    r.w * s,
      h:    r.h * s,
    };
  }, [selectedId, nodes, stageDims, rootPadding]);

  // Flagga om preview ska visas
  const showPreview = phase !== "loading" && !!devUrl;

  return (
    <div
      ref={rootRef}
      className="panel-root"
      style={{ position: "fixed", inset: 0, padding: rootPadding }}
      onWheel={onWheel}
    >
      {/* Laptop-UI: visas endast när inte loading */}
      {showPreview && (
        <div
          className="laptop-shell"
          style={{
            position: "absolute",
            left: stageDims.left + rootPadding,
            top: stageDims.top + rootPadding,
            width: stageDims.w,
            height: stageDims.h,
            zIndex: 5,
            overflow: "hidden",
            borderRadius: 12,
          }}
        >
          {phase !== "default" && (
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
                key={devUrl}
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

          {/* Overlays för alla noder */}
          <div
            style={{
              position: "absolute",
              left: 0, top: 0,
              width: PROJECT_BASE.w,
              height: PROJECT_BASE.h,
              transform: `scale(${stageDims.scale})`,
              transformOrigin: "top left",
              pointerEvents: "none",
            }}
          >
            {Object.entries(nodes).map(([id, ns]) => {
              if (!ns.imgSrc || !ns.rect || ns.deleted) return null;
              const isSelected = selectedId === id;
              const rect = ns.rect;
              return (
                <div
                  key={id}
                  data-overlay="1"
                  onPointerDown={onOverlayPointerDown(id)}
                  onPointerMove={onOverlayPointerMove}
                  style={{
                    position: "absolute",
                    left: round(rect.x),
                    top: round(rect.y),
                    width: round(rect.w),
                    height: round(rect.h),
                    zIndex: isSelected ? 30 : 20,
                    cursor: job.status === "running" ? "default" : "move",
                    background: "transparent",
                    borderRadius: 10,
                    boxShadow: isSelected ? "0 0 0 2px rgba(0,0,0,.06), 0 2px 10px rgba(0,0,0,.25)" : "none",
                    overflow: "visible",
                    pointerEvents: "auto",
                    opacity: job.status === "running" && isSelected ? 0.95 : 1,
                  }}
                >
                  <div style={{ position: "absolute", inset: 0, borderRadius: 10, overflow: "hidden" }}>
                    <img
                      ref={(el) => { imgRefs.current[id] = el; }}
                      src={ns.imgSrc}
                      alt="Figma node"
                      crossOrigin="anonymous"
                      draggable={false}
                      onLoad={onLoadFor(id)}
                      onError={onErrorFor(id)}
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "block",
                        objectFit: "contain",
                        userSelect: "none",
                        pointerEvents: "none",
                        filter: job.status === "running" && isSelected ? "grayscale(0.2)" : "none",
                      }}
                    />
                    {showOverlay && isSelected && job.status !== "running" && (
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
                  </div>

                  {/* Hörnhandtag */}
                  {showOverlay && isSelected && job.status !== "running" && (
                    <>
                      {(["nw", "ne", "se", "sw"] as const).map((pos) => {
                        const size = 16;
                        const base: React.CSSProperties = {
                          position: "absolute",
                          width: size, height: size,
                          background: "var(--accent)",
                          borderRadius: 999,
                          boxShadow: "0 1px 4px rgba(0,0,0,.35)",
                          pointerEvents: "auto",
                        };
                        const styleMap: Record<typeof pos, React.CSSProperties> = {
                          nw: { ...base, left: 0, top: 0, transform: "translate(-50%,-50%)", cursor: "nwse-resize" },
                          ne: { ...base, right: 0, top: 0, transform: "translate(50%,-50%)", cursor: "nesw-resize" },
                          se: { ...base, right: 0, bottom: 0, transform: "translate(50%,50%)", cursor: "nwse-resize" },
                          sw: { ...base, left: 0, bottom: 0, transform: "translate(-50%,50%)", cursor: "nesw-resize" },
                        };
                        return (
                          <div
                            key={pos}
                            onPointerDown={startResize(id, pos)}
                            onPointerMove={onOverlayPointerMove}
                            style={styleMap[pos]}
                          />
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Dolda probes för de noder som saknar imgN */}
          {Object.entries(nodes).map(([id, ns]) => {
            if (!ns.imgSrc || ns.imgN) return null;
            return (
              <img
                key={`probe-${id}`}
                src={ns.imgSrc}
                alt=""
                crossOrigin="anonymous"
                onLoad={onLoadFor(id)}
                onError={onErrorFor(id)}
                style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
              />
            );
          })}
        </div>
      )}

      {/* Central loader under kodgenerering: döljer preview */}
      {phase === "loading" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 200,
            display: "grid",
            placeItems: "center",
            background: "var(--vscode-sideBar-background)"
          }}
        >
          <div style={{ display: "grid", justifyItems: "center", gap: 12 }}>
            <Loader />
            <button
              onClick={() => job.taskId && vscode.postMessage({ cmd: "cancelJob", taskId: job.taskId })}
              disabled={!job.taskId}
              style={{
                padding: "6px 12px",
                border: "1px solid var(--border)",
                borderRadius: 999,
                background: "var(--vscode-editorWidget-background)",
                color: "var(--foreground)"
              }}
              title="Avbryt jobb"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Onboarding-kort */}
      <ChooseProjectCard visible={phase === "onboarding" && !devUrl} compact={!!devUrl && phase === "default"} busy={phase === "loading"} />

      {/* Figma-fel */}
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
                  className="pp-btn"
                  onClick={() => {
                    setFigmaErr("Försöker hämta ny bild-URL…");
                    const id = selectedId;
                    if (id) {
                      const ns = nodes[id];
                      if (ns) vscode.postMessage({ cmd: "refreshFigmaImage", nodeId: ns.nodeId });
                    }
                  }}
                >
                  Försök igen
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Placeholder */}
      {!figmaErr && phase !== "onboarding" && Object.values(nodes).every(n => !n.imgSrc) && (
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
              Laddar Figma-bilder…
            </div>
          </div>
        </div>
      )}

      {/* Chat längst ned. Rapporterar höjd för att reservera yta. */}
      <ChatBar
        onSend={(text) => vscode.postMessage({ cmd: "chat", text })}
        onStop={() => vscode.postMessage({ cmd: "stopChat" })}
        busy={false}
        disabled={false}
        placeholder="Skriv ett meddelande…"
        onHeightChange={setChatH}
      />

      {/* Actions */}
      {phase === "default" && devUrl && (
        <>
          <style>{`
            .fx-btn { position:absolute; height:32px; border-radius:999px; border:1px solid var(--border);
              background: var(--vscode-editorWidget-background); display:grid; place-items:center; cursor:pointer;
              padding: 0 12px; box-shadow: 0 4px 10px rgba(0,0,0,.15); }
            .fx-btn[disabled] { opacity:.7; cursor:default }
          `}</style>

          {/* Per-nod action: Trash för vald icke-raderad nod */}
          {selectedId && selRectPx && nodes[selectedId] && !nodes[selectedId].deleted && (
            <button
              data-keep-selection="1"
              onPointerDownCapture={(e) => e.stopPropagation()}
              aria-label="Ta bort Figma-nod"
              onClick={handleDelete}
              style={{
                position: "absolute",
                left: Math.round(selRectPx.left + selRectPx.w - 20),
                top:  Math.round(selRectPx.top  + selRectPx.h + 8),
                width: 32, height: 32, borderRadius: 999,
                border: "1px solid var(--border)",
                background: "var(--vscode-editorWidget-background)",
                display: "grid", placeItems: "center",
                zIndex: 60, cursor: "pointer",
                boxShadow: "0 4px 10px rgba(0,0,0,.15)",
              }}
              title="Ta bort (dölj) vald Figma-nod"
            >
              <Trash2 size={18} />
            </button>
          )}

          {/* Per-nod action: Undo för vald raderad nod */}
          {selectedId && selRectPx && nodes[selectedId] && nodes[selectedId].deleted && (
            <button
              data-keep-selection="1"
              onPointerDownCapture={(e) => e.stopPropagation()}
              aria-label="Ångra borttagning"
              onClick={handleUndoSelected}
              style={{
                position: "absolute",
                left: Math.round(selRectPx.left + selRectPx.w - 20),
                top:  Math.round(selRectPx.top  + selRectPx.h + 8),
                width: 32, height: 32, borderRadius: 999,
                border: "1px solid var(--border)",
                background: "var(--vscode-editorWidget-background)",
                display: "grid", placeItems: "center",
                zIndex: 60, cursor: "pointer",
                boxShadow: "0 4px 10px rgba(0,0,0,.15)",
              }}
              title="Ångra borttagning"
            >
              <RotateCcw size={18} />
            </button>
          )}

          {/* Global multi-stegs Undo (LIFO). Dölj när en icke-raderad nod är vald. */}
          {deletedStack.length > 0 && !(selectedId && nodes[selectedId] && !nodes[selectedId].deleted) && (
            <button
              data-keep-selection="1"
              onPointerDownCapture={(e) => e.stopPropagation()}
              aria-label="Ångra senast borttagna"
              onClick={handleUndoTop}
              className="fx-btn"
              style={{
                left: Math.round(stageDims.left + rootPadding + stageDims.w - 36),
                top:  Math.round(stageDims.top  + rootPadding + stageDims.h + 8),
                width: 36, zIndex: 55,
              }}
              title={`Ångra (${deletedStack.length})`}
            >
              <RotateCcw size={18} />
            </button>
          )}

          {/* Accept */}
          <button
            data-keep-selection="1"
            onPointerDownCapture={(e) => e.stopPropagation()}
            aria-label={canAccept ? "Acceptera placement" : "Ingen nod att acceptera"}
            onClick={handleAccept}
            disabled={!canAccept}
            className="fx-accept-btn fx-btn"
            style={{
              left: Math.round(stageDims.left + rootPadding + stageDims.w - 140),
              top:  Math.round(stageDims.top  + rootPadding + stageDims.h + 8),
              zIndex: 60,
            }}
            title={canAccept ? "Accept" : "Ingen aktiv nod"}
          >
            Accept
          </button>
        </>
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
