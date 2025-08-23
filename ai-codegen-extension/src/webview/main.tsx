/* ai-codegen-extension/webview/main.tsx 
   --------------------------------------------------------------------------
   Minimal UI:
   - Endast Figma-design överst och projektets prereview (iframe) underst.
   - Ingen statustext, ingen URI-text, inga zoom-/skala-kontroller.
   - Iframen är alltid skalad till 67%.
   - Behåll "Välj projekt…" och "Kopiera länk"-knapparna.
   - Behåll "Skicka instruktioner"-knappen (chat-funktionen).
   - Onboarding- och Loader-faser orörda.
   -------------------------------------------------------------------------- */

/// <reference types="vite/client" />

import React, {
  useEffect,
  useMemo,
  useState,
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
  scaleForApi: number
) {
  return useQuery<string>({
    enabled: !!fileKey && !!nodeId && !!token && !!scaleForApi,
    queryKey: ["figma-image", fileKey, nodeId, scaleForApi],
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
    retry: 1,
    queryFn: async () => {
      const capped = Math.max(1, Math.min(4, Math.round(scaleForApi)));
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
  // skärmläsare (osynligt för UI)
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

/* ----------------- Onboarding UI ---------------- */
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
  const [phase, setPhase] = useState<Phase>("ready");
  const [initReceived, setInitReceived] = useState(false);
  const [figmaInfo, setFigmaInfo] = useState<{ fileKey: string | null; nodeId: string | null; token: string | null; }>({ fileKey: null, nodeId: null, token: null });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const queryClientLocal = useQueryClient();

  useEffect(() => {
    const listener = (e: MessageEvent<InitMessage | DevUrlMessage | UiPhaseMessage | UiErrorMessage | any>) => {
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

  // Figma-bild (intern API-skala för hög DPI, ej UI-zoom)
  const figmaApiScale = useMemo(() => Math.max(2, Math.min(4, Math.ceil(window.devicePixelRatio * 2))), []);
  const { data: figmaUrl, isLoading: figmaLoading, isError: figmaError } = useFigmaImage(
    figmaInfo.fileKey, figmaInfo.nodeId, figmaInfo.token, figmaApiScale
  );

  // Växla från loader → ready
  useEffect(() => {
    if (phase !== "loading") return;
    const devReady = !!previewUrl;
    const figmaNeeded = initReceived && !!figmaInfo.token;
    const figmaReady = !figmaNeeded || (!!figmaUrl && !figmaLoading && !figmaError);
    if (devReady && figmaReady) setPhase("ready");
  }, [phase, previewUrl, initReceived, figmaInfo.token, figmaUrl, figmaLoading, figmaError]);

  // Fast iframe-skala 67%
  const FIXED_SCALE = 0.67;
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

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

  // Chat
  const [chat, setChat] = useState("");

  /* ---------------- Render ---------------- */

  if (phase === "onboarding") {
    return (
      <div className="panel-root bg-background text-foreground">
        <div id="sr-live" className="sr-only" aria-live="polite" />
        <Onboarding onPick={() => vscode.postMessage({ cmd: "pickFolder" })} />
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="panel-root bg-background text-foreground">
        <div id="sr-live" className="sr-only" aria-live="polite" />
        <Loader />
      </div>
    );
  }

  // Ready
  return (
    <div className="panel-root bg-background text-foreground">
      <div id="sr-live" className="sr-only" aria-live="polite" />

      {/* Minimala topp-actions (inga texter/status/URI) */}
      <div className="px-4 pt-3 flex items-center justify-end gap-2">
        <Button onClick={() => vscode.postMessage({ cmd: "chooseProject" })}>
          Välj projekt…
        </Button>
        <Button
          onClick={async () => {
            if (!previewUrl) return;
            const ok = await copyToClipboard(previewUrl);
            if (ok) announce("Länk kopierad.");
          }}
          disabled={!previewUrl}
          aria-label="Kopiera förhandsvisningslänk"
        >
          Kopiera länk
        </Button>
      </div>

      {/* Figma (ingen text/overlay/hint) */}
      <div className="preview-shell">
        <div className={`preview-grid ${figmaUrl ? "is-ready" : figmaLoading ? "is-loading" : "is-error"}`}>
          {figmaLoading && <div className="skeleton" aria-hidden="true" />}
          {figmaUrl && !figmaLoading && !figmaError && (
            <img
              src={figmaUrl}
              alt=""
              className="figma-img"
              loading="lazy"
              decoding="async"
              fetchPriority="high"
              draggable={false}
            />
          )}
          {/* Vid fel: visa inget textinnehåll */}
        </div>
      </div>

      {/* Projektets preview (vit bakgrund, fast skala 67%) */}
      {previewUrl && (
        <div className="px-4">
          <div className="mini-preview card-elevated">
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
                  width: containerSize.w > 0 ? `${containerSize.w / FIXED_SCALE}px` : "100%",
                  height: containerSize.h > 0 ? `${containerSize.h / FIXED_SCALE}px` : "100%",
                  transform: `scale(${FIXED_SCALE})`,
                  transformOrigin: "top left",
                  display: "block",
                  border: "0",
                  backgroundColor: "#fff",
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Chat: behåll endast knapptexten "Skicka instruktioner" */}
      <div className="chatbar">
        <div className="chatbar__inner">
          <input
            type="text"
            className="flex-1 input"
            placeholder=""
            value={chat}
            onChange={(e) => setChat(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && chat.trim()) {
                vscode.postMessage({ cmd: "chat", text: chat.trim() }); setChat("");
              }
            }}
            aria-label="Instruktioner"
          />
          <Button
            onClick={() => {
              if (!chat.trim()) return;
              vscode.postMessage({ cmd: "chat", text: chat.trim() }); setChat("");
            }}
            disabled={!chat.trim()}
          >
            Skicka instruktioner
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
