/* ai-codegen-extension/webview/main.tsx
   --------------------------------------------------------------------------
   Prereview med onboarding- & loader-flöde:
   - UI-faser: onboarding → loading → ready.
   - Onboarding visar en central "Choose a folder" (folder-illustration).
   - Loading visar animerad loader.
   - Ready visar ordinarie UI (Figma + prereview) med vit bakgrund och skala.
   -------------------------------------------------------------------------- */

/// <reference types="vite/client" />

import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import "./index.css";

/* -------------------- Typer -------------------- */
interface InitMessage {
  type: "init";
  taskId?: string;
  fileKey: string;
  nodeId: string;
  token?: string;
  figmaToken?: string;
}
interface DevUrlMessage { type: "devurl"; url: string; }
interface CandidateProposal { label: string; description: string; dir: string; launchCmd?: string; }
interface CandidateProposalMessage { type: "candidate-proposal"; payload: CandidateProposal; }
interface UiPhaseMessage { type: "ui-phase"; phase: "onboarding" | "loading" | "default"; }
interface UiErrorMessage { type: "ui-error"; message: string; }

interface FigmaImageApiRes { images: Record<string, string>; err?: string; }

/* ------------------ VS Code API ---------------- */
declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: "ready" });

const queryClient = new QueryClient();

/* ------------- Figma data-hook ----------------- */
function useFigmaImage(
  fileKey: string | null,
  nodeId: string | null,
  token: string | null,
  scale: number
) {
  return useQuery<string>({
    enabled: !!fileKey && !!nodeId && !!token && !!scale,
    queryKey: ["figma-image", fileKey, nodeId, scale],
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
    queryFn: async () => {
      const capped = Math.max(1, Math.min(4, Math.round(scale)));
      const url = `https://api.figma.com/v1/images/${encodeURIComponent(
        fileKey!
      )}?ids=${encodeURIComponent(
        nodeId!
      )}&format=png&scale=${capped}&use_absolute_bounds=true`;

      const res = await fetch(url, { headers: { "X-Figma-Token": token! } });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Figma API ${res.status}: ${t}`);
      }
      const data = (await res.json()) as FigmaImageApiRes;
      const img = data.images[nodeId!];
      if (!img) throw new Error(data.err ?? "Ingen bild returnerad");
      return img;
    },
  });
}

/* ----------------- Hjälpare -------------------- */
const announce = (m: string) => {
  console.log(m);
  const el = document.getElementById("sr-live");
  if (el) el.textContent = m;
};
const copyToClipboard = async (text: string) => {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); return true;
  }
};

/* ----------------- Onboarding UI ----------------
   (portad från given styled-components till ren CSS) */
const Onboarding: React.FC<{ onPick: () => void }> = ({ onPick }) => {
  return (
    <div className="ob-shell">
      <div className="ob-card">
        <div className="ob-folder">
          <div className="front-side">
            <div className="tip" />
            <div className="cover" />
          </div>
          <div className="back-side cover" />
        </div>
        <button className="ob-button" onClick={onPick} aria-label="Choose a folder">
          Choose a folder
        </button>
      </div>

      {/* Inlined CSS för onboarding */}
      <style>{`
        .ob-shell {
          min-height: 70vh;
          display: grid;
          place-items: center;
          padding: 24px;
        }
        .ob-card {
          --transition: 350ms;
          --folder-W: 120px;
          --folder-H: 80px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          padding: 10px;
          background: linear-gradient(135deg, #6dd5ed, #2193b0);
          border-radius: 15px;
          box-shadow: 0 15px 30px rgba(0,0,0,.2);
          height: calc(var(--folder-H) * 1.7);
          width: min(420px, 90%);
          position: relative;
        }
        .ob-folder {
          position: absolute;
          top: -20px;
          left: calc(50% - 60px);
          animation: ob-float 2.5s infinite ease-in-out;
          transition: transform var(--transition) ease;
        }
        .ob-folder:hover { transform: scale(1.05); }
        .ob-folder .front-side, .ob-folder .back-side {
          position: absolute; transition: transform var(--transition); transform-origin: bottom center;
        }
        .ob-card:hover .front-side { transform: rotateX(-40deg) skewX(15deg); }
        .ob-folder .back-side::before, .ob-folder .back-side::after {
          content: ""; display: block; background-color: white; opacity: .5;
          width: var(--folder-W); height: var(--folder-H); position: absolute;
          transform-origin: bottom center; border-radius: 15px; transition: transform 350ms; z-index: 0;
        }
        .ob-card:hover .back-side::before { transform: rotateX(-5deg) skewX(5deg); }
        .ob-card:hover .back-side::after  { transform: rotateX(-15deg) skewX(12deg); }
        .ob-folder .front-side { z-index: 1; }
        .ob-folder .tip {
          background: linear-gradient(135deg, #ff9a56, #ff6f56);
          width: 80px; height: 20px; border-radius: 12px 12px 0 0;
          box-shadow: 0 5px 15px rgba(0,0,0,.2);
          position: absolute; top: -10px; z-index: 2;
        }
        .ob-folder .cover {
          background: linear-gradient(135deg, #ffe563, #ffc663);
          width: var(--folder-W); height: var(--folder-H);
          box-shadow: 0 15px 30px rgba(0,0,0,.3);
          border-radius: 10px;
        }
        .ob-button {
          font-size: 1.1em; color: #fff; text-align: center;
          background: rgba(255,255,255,.2);
          border: none; border-radius: 10px; cursor: pointer;
          transition: background var(--transition) ease;
          width: 100%; padding: 10px 35px; position: relative;
        }
        .ob-button:hover { background: rgba(255,255,255,.4); }

        @keyframes ob-float {
          0% { transform: translateY(0) }
          50% { transform: translateY(-20px) }
          100% { transform: translateY(0) }
        }
      `}</style>
    </div>
  );
};

/* ----------------- Loader UI -------------------- */
const Loader: React.FC = () => {
  return (
    <div className="ld-shell">
      <div className="ld-card">
        <div className="ld-loader">
          <p>loading</p>
          <div className="ld-words">
            <span className="ld-word">buttons</span>
            <span className="ld-word">forms</span>
            <span className="ld-word">switches</span>
            <span className="ld-word">cards</span>
            <span className="ld-word">buttons</span>
          </div>
        </div>
      </div>

      <style>{`
        .ld-shell { min-height: 70vh; display: grid; place-items: center; }
        .ld-card { --bg-color: #111; background-color: var(--bg-color); padding: 1rem 2rem; border-radius: 1.25rem; }
        .ld-loader {
          color: rgb(124,124,124); font-family: "Poppins", system-ui, sans-serif; font-weight: 500; font-size: 25px;
          box-sizing: content-box; height: 40px; padding: 10px 10px; display: flex; border-radius: 8px;
        }
        .ld-words { overflow: hidden; position: relative; }
        .ld-words::after {
          content: ""; position: absolute; inset: 0;
          background: linear-gradient(var(--bg-color) 10%, transparent 30%, transparent 70%, var(--bg-color) 90%);
          z-index: 20;
        }
        .ld-word { display: block; height: 100%; padding-left: 6px; color: #956afa; animation: ld-spin 4s infinite; }
        @keyframes ld-spin {
          10% { transform: translateY(-102%); }
          25% { transform: translateY(-100%); }
          35% { transform: translateY(-202%); }
          50% { transform: translateY(-200%); }
          60% { transform: translateY(-302%); }
          75% { transform: translateY(-300%); }
          85% { transform: translateY(-402%); }
          100% { transform: translateY(-400%); }
        }
      `}</style>
    </div>
  );
};

/* ----------------- Huvudkomponent ---------------- */
type Phase = "onboarding" | "loading" | "ready";

const AiPanel: React.FC = () => {
  const [phase, setPhase] = useState<Phase>("ready"); // default för icke-URI-flöden
  const [initReceived, setInitReceived] = useState(false);
  const [figmaInfo, setFigmaInfo] = useState<{ fileKey: string | null; nodeId: string | null; token: string | null; }>({ fileKey: null, nodeId: null, token: null });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [proposal, setProposal] = useState<CandidateProposal | null>(null);
  const [copied, setCopied] = useState(false);
  const queryClientLocal = useQueryClient();

  useEffect(() => {
    const listener = (e: MessageEvent<InitMessage | DevUrlMessage | CandidateProposalMessage | UiPhaseMessage | UiErrorMessage | any>) => {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;

      if ((msg as InitMessage).type === "init") {
        const m = msg as InitMessage;
        const tok = m.token ?? m.figmaToken ?? null;
        setInitReceived(true);
        setFigmaInfo({ fileKey: m.fileKey, nodeId: m.nodeId, token: tok });
        return;
      }
      if ((msg as DevUrlMessage).type === "devurl") {
        const m = msg as DevUrlMessage;
        if (typeof m.url === "string") setPreviewUrl(m.url);
        return;
      }
      if ((msg as CandidateProposalMessage).type === "candidate-proposal") {
        const m = msg as CandidateProposalMessage;
        if (m?.payload) setProposal(m.payload);
        return;
      }
      if ((msg as UiPhaseMessage).type === "ui-phase") {
        const p = (msg as UiPhaseMessage).phase;
        if (p === "onboarding") setPhase("onboarding");
        else if (p === "loading") setPhase("loading");
        else setPhase("ready");
        return;
      }
      if ((msg as UiErrorMessage).type === "ui-error") {
        setPhase("onboarding");
        alert((msg as UiErrorMessage).message || "Kunde inte starta projektet.");
        return;
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  /* --- Zoom/scale för Figma-minipreview (oförändrat) --- */
  const [zoomed, setZoomed] = useState(false);
  const baseScale = useMemo(() => Math.max(2, Math.min(4, Math.ceil(window.devicePixelRatio * 2))), []);
  const effectiveScale = zoomed ? 4 : baseScale;

  const { data: figmaUrl, isLoading: figmaLoading, isError: figmaError, error: figmaErr } = useFigmaImage(
    figmaInfo.fileKey, figmaInfo.nodeId, figmaInfo.token, effectiveScale
  );

  /* --- Ready-villkor: devurl + (om vi har init) figmaUrl --- */
  useEffect(() => {
    if (phase !== "loading") return;
    const devReady = !!previewUrl;
    const figmaNeeded = initReceived && !!figmaInfo.token;
    const figmaReady = !figmaNeeded || (!!figmaUrl && !figmaLoading && !figmaError);
    if (devReady && figmaReady) setPhase("ready");
  }, [phase, previewUrl, initReceived, figmaInfo.token, figmaUrl, figmaLoading, figmaError]);

  /* --- Chat --- */
  const [chat, setChat] = useState("");

  /* --- Skalenlig iframe — samma som tidigare leverans --- */
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const [{ mode: zoomMode, manual: manualScale }, setZoomState] = useState(() => {
    try {
      const m = (localStorage.getItem("aiPreview.zoom") as "fit" | "manual") || "fit";
      const s = parseFloat(localStorage.getItem("aiPreview.manualScale") || "0.67") || 0.67;
      return { mode: m, manual: Math.min(1, Math.max(0.25, s)) };
    } catch { return { mode: "fit" as const, manual: 0.67 }; }
  });
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [scale, setScale] = useState<number>(1);

  useEffect(() => {
    const el = previewFrameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      setContainerSize({ w: Math.max(0, cr.width), h: Math.max(0, cr.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const referenceWidth = 1280;
    if (zoomMode === "fit") {
      const s = containerSize.w > 0 ? Math.min(1, Math.max(0.25, containerSize.w / referenceWidth)) : 1;
      setScale(s);
    } else {
      setScale(Math.min(1, Math.max(0.25, manualScale)));
    }
  }, [zoomMode, manualScale, containerSize.w]);

  const setMode = useCallback((m: "fit" | "manual") => {
    setZoomState((prev) => {
      const next = { mode: m, manual: prev.manual };
      try { localStorage.setItem("aiPreview.zoom", next.mode); localStorage.setItem("aiPreview.manualScale", String(next.manual)); } catch {}
      return next;
    });
  }, []);
  const setManual = useCallback((v: number) => {
    setZoomState(() => {
      const next = { mode: "manual" as const, manual: Math.min(1, Math.max(0.25, v)) };
      try { localStorage.setItem("aiPreview.zoom", next.mode); localStorage.setItem("aiPreview.manualScale", String(next.manual)); } catch {}
      return next;
    });
  }, []);

  const zoomLabel = (s: number) => `${Math.round(s * 100)}%`;

  /* ---------------- Render ---------------- */
  const hasToken = !!figmaInfo.token;

  // Onboarding-fas
  if (phase === "onboarding") {
    return (
      <div className="panel-root bg-background text-foreground">
        <div id="sr-live" className="sr-only" aria-live="polite" />
        <Onboarding onPick={() => vscode.postMessage({ cmd: "pickFolder" })} />
      </div>
    );
  }

  // Loading-fas
  if (phase === "loading") {
    return (
      <div className="panel-root bg-background text-foreground">
        <div id="sr-live" className="sr-only" aria-live="polite" />
        <Loader />
      </div>
    );
  }

  // Ready-fas (ordinarie UI)
  return (
    <div className="panel-root bg-background text-foreground">
      <div id="sr-live" className="sr-only" aria-live="polite" />

      {/* Top-bar */}
      <div className="px-4 pt-3">
        <Card className="card-elevated">
          <CardContent className="py-3">
            <div className="flex items-start md:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`status-dot ${previewUrl ? "ok" : "pending"}`} aria-hidden="true" />
                  <span className="text-xs opacity-80">
                    {previewUrl ? "Förhandsvisning aktiv" : "Väntar på dev-serverns URL"}
                  </span>
                </div>
                <div className="text-xs break-all mono truncate-multiline">
                  {previewUrl ?? "Ingen URL tillgänglig ännu …"}
                </div>
                {initReceived && !hasToken && (
                  <p className="mt-2 text-[11px] text-destructive">
                    ⚠️ Ingen Figma-token – ställ in <em>aiFigmaCodegen.figmaToken</em> i Inställningar.
                  </p>
                )}
              </div>

              {/* Zoom-kontroller */}
              <div className="flex items-center gap-2 shrink-0">
                <div className="flex items-center gap-1">
                  <Button
                    className={`h-7 px-3 text-xs ${zoomMode === "fit" ? "" : "btn-secondary"}`}
                    onClick={() => setMode("fit")}
                    title="Passa bredd"
                    aria-label="Passa bredd"
                  >
                    Passa bredd
                  </Button>
                  <select
                    aria-label="Zoomnivå"
                    title="Zoomnivå"
                    className="h-7 text-xs px-2 rounded-md border border-border bg-background"
                    value={zoomMode === "fit" ? "fit" : String(manualScale)}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v === "fit") setMode("fit");
                      else setManual(parseFloat(v));
                    }}
                  >
                    <option value="fit">Passa bredd</option>
                    <option value="1">100%</option>
                    <option value="0.8">80%</option>
                    <option value="0.67">67%</option>
                    <option value="0.5">50%</option>
                  </select>
                  <span className="text-[11px] opacity-70 tabular-nums ml-1">
                    {zoomMode === "fit" ? "Auto" : zoomLabel(scale)}
                  </span>
                </div>

                <Button onClick={() => vscode.postMessage({ cmd: "chooseProject" })}>Välj projekt…</Button>
                <Button
                  onClick={async () => {
                    if (!previewUrl) return;
                    const ok = await copyToClipboard(previewUrl);
                    if (ok) { announce("Länk kopierad."); }
                  }}
                  disabled={!previewUrl}
                  aria-label="Kopiera förhandsvisningslänk"
                  title={previewUrl ? "Kopiera förhandsvisningslänk" : "Ingen länk ännu"}
                >
                  Kopiera länk
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Figma kompakt preview (oförändrat från tidigare) */}
      <div className="preview-shell">
        <div
          className={`preview-grid ${figmaUrl ? "is-ready" : figmaLoading ? "is-loading" : "is-error"}`}
          role={figmaUrl ? "button" : "img"}
          tabIndex={figmaUrl ? 0 : -1}
          aria-label={figmaUrl ? "Öppna större förhandsvisning" : "Figma-förhandsvisning"}
          onClick={figmaUrl ? () => setZoomed(true) : undefined}
          onKeyDown={(e) => {
            if (figmaUrl && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault(); setZoomed(true);
            }
          }}
        >
          {figmaLoading && <div className="skeleton" aria-hidden="true" />}
          {figmaError && (
            <div className="error-state">
              <p className="text-sm mb-2">
                {(figmaErr as Error)?.message ?? "Kunde inte ladda Figma-bilden."}
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={() => queryClientLocal.invalidateQueries({
                    queryKey: ["figma-image", figmaInfo.fileKey, figmaInfo.nodeId, effectiveScale],
                  })}
                  className="btn-secondary"
                >
                  Försök igen
                </Button>
                <Button onClick={() => vscode.postMessage({ cmd: "chooseProject" })} className="btn-ghost">
                  Välj projekt…
                </Button>
              </div>
            </div>
          )}
          {figmaUrl && !figmaLoading && !figmaError && (
            <>
              <img
                src={figmaUrl}
                alt="Vald Figma-nod"
                className="figma-img figma-clickable"
                loading="lazy"
                decoding="async"
                fetchPriority="high"
                draggable={false}
              />
              <div className="zoom-hint" aria-hidden="true">Klicka för att zooma</div>
            </>
          )}
        </div>
      </div>

      {/* Mini-preview (vit bakgrund + skala) */}
      {previewUrl && (
        <div className="px-4">
          <div className="mini-preview card-elevated">
            <div className="mini-preview__header">
              <span className="mono truncate">{previewUrl}</span>
              <div className="flex items-center gap-2">
                <Button
                  className="h-7 px-3 text-xs btn-secondary"
                  onClick={async () => {
                    if (!previewUrl) return;
                    const ok = await copyToClipboard(previewUrl);
                    if (ok) announce("Länk kopierad.");
                  }}
                  aria-label="Kopiera förhandsvisningslänk"
                >
                  Kopiera
                </Button>
              </div>
            </div>

            <div
              ref={previewFrameRef}
              className="mini-preview__frame"
              style={{ backgroundColor: "#fff", overflow: "hidden", position: "relative" }}
            >
              <iframe
                src={previewUrl}
                title="Project preview"
                className="mini-preview__iframe"
                sandbox="allow-scripts allow-forms allow-same-origin"
                style={{
                  width: containerSize.w > 0 && scale > 0 ? `${containerSize.w / scale}px` : "100%",
                  height: containerSize.h > 0 && scale > 0 ? `${containerSize.h / scale}px` : "100%",
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  display: "block",
                  border: "0",
                  backgroundColor: "#fff",
                }}
              />
            </div>

            <div className="px-3 py-2 text-[11px] opacity-70 border-t border-border">
              Zoom:&nbsp;{zoomMode === "fit" ? "Passa bredd (auto)" : zoomLabel(scale)}
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {zoomed && (
        <div className="figma-overlay" onClick={() => setZoomed(false)} aria-modal="true" role="dialog">
          <div className="figma-modal" onClick={(e) => e.stopPropagation()} role="document">
            <button className="figma-close" aria-label="Stäng förhandsvisning" onClick={() => setZoomed(false)}>×</button>
            {figmaUrl && <img src={figmaUrl} alt="Figma-nod (förstorad)" className="figma-modal-img" draggable={false} />}
          </div>
        </div>
      )}

      {/* Chat */}
      <div className="chatbar">
        <div className="chatbar__inner">
          <input
            type="text"
            className="flex-1 input"
            placeholder="Skicka instruktion …"
            value={chat}
            onChange={(e) => setChat(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && chat.trim()) {
                vscode.postMessage({ cmd: "chat", text: chat.trim() }); setChat("");
              }
            }}
            aria-label="Meddelande till assistenten"
          />
          <Button
            onClick={() => {
              if (!chat.trim()) return;
              vscode.postMessage({ cmd: "chat", text: chat.trim() }); setChat("");
            }}
            disabled={!chat.trim()}
          >
            Skicka
          </Button>
        </div>
      </div>
    </div>
  );
};

/* ---------------- Bootstrap ------------------- */
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <QueryClientProvider client={queryClient}>
      <AiPanel />
    </QueryClientProvider>
  );
} else {
  console.error("Hittade inte #root i webview HTML.");
}
