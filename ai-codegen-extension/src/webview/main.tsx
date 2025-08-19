/* ai-codegen-extension/webview/main.tsx 
   --------------------------------------------------------------------------
   React-panel för AI Figma Codegen – kompakt preview, centrerad, lightbox-
   toggle med mörknad bakgrund och stäng-kryss. Hög DPI även i zoomläge.
   + Mini-preview av användarens dev-server under Figma-kortet.
   + Project Summary från backend-analys (via postMessage).
   + Kandidat-förslag med “Acceptera förhandsvisning”.
   + 🔹 NYTT: Manuell projektväljare via “Välj projekt…” (cmd: chooseProject)
   + 🔹 NYTT: Top-bar med status + snabbåtgärder.
   -------------------------------------------------------------------------- */

/// <reference types="vite/client" />

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import "./index.css";

/* ------------------------------------------------------- */
/* 🛠  Typer                                               */
/* ------------------------------------------------------- */
interface InitMessage {
  type: "init";
  taskId?: string;
  fileKey: string;
  nodeId: string;
  token?: string;
  figmaToken?: string;
}

interface DevUrlMessage {
  type: "devurl";
  url: string;
}

interface CandidateProposal {
  label: string;
  description: string;
  dir: string;
  launchCmd?: string;
}

interface CandidateProposalMessage {
  type: "candidate-proposal";
  payload: CandidateProposal;
}

interface FigmaImageApiRes {
  images: Record<string, string>;
  err?: string;
}

/* ------------------------------------------------------- */
/* 🌐  VS Code WebView-API                                 */
/* ------------------------------------------------------- */
declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

/* Handshake: tala om att webview är redo att ta emot init-data */
vscode.postMessage({ type: "ready" });

const queryClient = new QueryClient();
console.log("🛠 main.tsx loaded – vscode API acquired");

/* ------------------------------------------------------- */
/* 🔗 Hook: Hämta Figma-bild (med skalfaktor)              */
/* ------------------------------------------------------- */
function useFigmaImage(
  fileKey: string | null,
  nodeId:  string | null,
  token:   string | null,
  scale:   number
) {
  return useQuery<string>({
    enabled: !!fileKey && !!nodeId && !!token && !!scale,
    queryKey: ["figma-image", fileKey, nodeId, scale],
    staleTime: 1000 * 60 * 60,
    gcTime:    1000 * 60 * 60 * 24,
    retry: 1,
    queryFn: async () => {
      const capped = Math.max(1, Math.min(4, Math.round(scale)));
      const url = `https://api.figma.com/v1/images/${encodeURIComponent(fileKey!)}?ids=${encodeURIComponent(nodeId!)}&format=png&scale=${capped}&use_absolute_bounds=true`;

      const res = await fetch(url, { headers: { "X-Figma-Token": token! } });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Figma API ${res.status}: ${t}`);
      }
      const data = (await res.json()) as FigmaImageApiRes;
      const img  = data.images[nodeId!];
      if (!img) throw new Error(data.err ?? "Ingen bild returnerad");
      return img;
    },
  });
}

/* ------------------------------------------------------- */
/* 🧩 Småhjälpare                                          */
/* ------------------------------------------------------- */
function postChooseProject() {
  vscode.postMessage({ cmd: "chooseProject" });
}

function postAcceptCandidate() {
  vscode.postMessage({ cmd: "acceptCandidate" });
}

async function copyToClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- */
/* 🖼️  Huvudkomponent                                     */
/* ------------------------------------------------------- */
const AiPanel: React.FC = () => {
  /* --- Init ------------------------------------------ */
  const [initReceived, setInitReceived] = useState(false);
  const [figmaInfo, setFigmaInfo]       = useState<{
    fileKey: string | null;
    nodeId:  string | null;
    token:   string | null;
  }>({ fileKey: null, nodeId: null, token: null });

  // Mini-preview URL från extension (dev-servern)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Kandidat-förslag
  const [proposal, setProposal] = useState<CandidateProposal | null>(null);

  useEffect(() => {
    const listener = (e: MessageEvent<InitMessage | DevUrlMessage | CandidateProposalMessage | any>) => {
      const msg = e.data as InitMessage | DevUrlMessage | CandidateProposalMessage | any;
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

      // analysis/*-meddelanden hanteras av ProjectSummary via sin egen store
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  /* --- Zoomläge / lightbox ---------------------------- */
  const [zoomed, setZoomed] = useState(false);

  // Bas-skalning för preview (kompakt): minst 2×, max 4×
  const baseScale = useMemo(
    () => Math.max(2, Math.min(4, Math.ceil(window.devicePixelRatio * 2))),
    []
  );
  // I zoomläge hämtar vi alltid 4× för bästa skärpa
  const effectiveScale = zoomed ? 4 : baseScale;

  /* --- Datahooks -------------------------------------- */
  const {
    data: figmaUrl,
    isLoading: figmaLoading,
    isError:   figmaError,
    error:     figmaErr,
  } = useFigmaImage(figmaInfo.fileKey, figmaInfo.nodeId, figmaInfo.token, effectiveScale);

  /* --- Chat ------------------------------------------- */
  const [chat, setChat] = useState("");

  /* --- Lightbox UX: ESC, scroll lock, backdrop click --- */
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden"; // lås scroll
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      html.style.overflow = prevOverflow;
    };
  }, [zoomed]);

  const openZoom  = useCallback(() => { if (figmaUrl) setZoomed(true); }, [figmaUrl]);
  const closeZoom = useCallback(() => setZoomed(false), []);

  /* ----------------------------------------------------- */
  /* Render                                                */
  /* ----------------------------------------------------- */
  return (
    <div className="panel-root bg-background text-foreground">
      {/* ————— Top-bar: status + snabbåtgärder ————— */}
      <div className="px-4 pt-3">
        <Card>
          <CardContent className="py-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-xs opacity-70">Förhandsvisning</div>
                <div className="text-xs break-all">
                  {previewUrl ?? "Väntar på URL …"}
                </div>
              </div>
              <Button
                onClick={() => postChooseProject()}
                aria-label="Välj projekt manuellt"
                title="Välj projekt manuellt"
              >
                Välj projekt…
              </Button>
              {previewUrl && (
                <Button
                  onClick={async () => {
                    const ok = await copyToClipboard(previewUrl);
                    if (ok) {
                      // enkel visuell feedback
                      console.log("Kopierad:", previewUrl);
                    }
                  }}
                  aria-label="Kopiera förhandsvisningslänk"
                  title="Kopiera förhandsvisningslänk"
                >
                  Kopiera länk
                </Button>
              )}
            </div>
            {initReceived && !figmaInfo.token && (
              <p className="mt-2 text-[11px] text-destructive">
                ⚠️ Ingen Figma-token – ställ in <em>aiFigmaCodegen.figmaToken</em> i Inställningar.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ————— Figma kompakt preview (centrerad) ————— */}
      <div className="preview-shell">
        <div
          className={`preview-grid ${figmaUrl ? "is-ready" : "is-loading"}`}
          role={figmaUrl ? "button" : "img"}
          tabIndex={figmaUrl ? 0 : -1}
          aria-label="Öppna större förhandsvisning"
          onClick={figmaUrl ? openZoom : undefined}
          onKeyDown={(e) => {
            if (!figmaUrl) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openZoom();
            }
          }}
        >
          {figmaLoading && <p className="text-sm opacity-70">Laddar …</p>}
          {figmaError && (
            <p className="text-destructive text-sm">
              {(figmaErr as Error).message}
            </p>
          )}
          {figmaUrl && (
            <img
              src={figmaUrl}
              alt="Vald Figma-nod"
              className="figma-img figma-clickable"
              loading="lazy"
              decoding="async"
              fetchPriority="high"
              draggable={false}
            />
          )}
        </div>
      </div>

      {/* ————— Föreslagen kandidat (Acceptera / Välj projekt…) ————— */}
      {proposal && (
        <div className="px-4 mt-3">
          <Card>
            <CardHeader>
              <CardTitle>Föreslagen förhandsvisning</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm mb-2">
                <b className="block">{proposal.label}</b>
                <span className="opacity-80 block">{proposal.description}</span>
                <span className="opacity-60 block">{proposal.dir}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    postAcceptCandidate();
                    setProposal(null); // dölj rutan när vi startar
                  }}
                >
                  Starta förhandsvisning
                </Button>
                <Button
                  className="btn-secondary"
                  onClick={() => postChooseProject()}
                >
                  Välj projekt…
                </Button>
                <Button
                  className="btn-ghost"
                  onClick={() => setProposal(null)}
                >
                  Göm
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ————— Mini-preview av projektet (iframe) ————— */}
      {previewUrl && (
        <div
          className="mt-3 mx-auto w-full max-w-[340px] rounded-xl overflow-hidden"
          style={{
            background: "var(--vscode-editorWidget-background)",
            border: "1px solid var(--border)",
          }}
        >
          <iframe
            src={previewUrl}
            title="Project preview"
            className="block w-full h-[240px] border-0"
            sandbox="allow-scripts allow-forms allow-same-origin"
          />
          <div className="flex items-center justify-between px-2 py-1">
            <p className="text-xs opacity-70 break-all mr-2">{previewUrl}</p>
            <Button
              className="h-6 px-2 text-xs"
              onClick={async () => {
                if (!previewUrl) return;
                const ok = await copyToClipboard(previewUrl);
                if (ok) console.log("Kopierad:", previewUrl);
              }}
            >
              Kopiera
            </Button>
          </div>
        </div>
      )}

      {/* ————— Lightbox / zoomläge ————— */}
      {zoomed && (
        <div className="figma-overlay" onClick={closeZoom} aria-modal="true" role="dialog">
          <div
            className="figma-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="figma-close"
              aria-label="Stäng förhandsvisning"
              onClick={closeZoom}
            >
              ×
            </button>
            {figmaUrl && (
              <img
                src={figmaUrl}
                alt="Figma-nod (förstorad)"
                className="figma-modal-img"
                draggable={false}
              />
            )}
          </div>
        </div>
      )}

      {/* ————— Chat ————— */}
      <div className="flex gap-2 px-4 py-3">
        <input
          type="text"
          className="flex-1 input"
          placeholder="Skicka instruktion …"
          value={chat}
          onChange={(e) => setChat(e.currentTarget.value)}
        />
        <Button
          onClick={() => {
            vscode.postMessage({ cmd: "chat", text: chat });
            setChat("");
          }}
          disabled={!chat}
        >
          Skicka
        </Button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------- */
/* 🚀  Bootstrap                                           */
/* ------------------------------------------------------- */
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
