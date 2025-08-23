/* ai-codegen-extension/webview/main.tsx
   --------------------------------------------------------------------------
   React-panel för AI Figma Codegen – polerad, symmetrisk och enterprise-snygg.
   - Kompakt Figma-preview med zoom/lightbox, skeletons och tydliga tillstånd.
   - Toppbar med status, URL, kopiera-länk och manuell projektväljare.
   - Föreslagen kandidat med handlingar (Starta / Välj / Göm).
   - Mini-preview (iframe) med aspect-ratio, header och copy-åtgärd.
   - Chat-fot med sticky placering och tillgängligt tangentbordsflöde.
   - Subtila färger: följer VS Code-temat. Fokusringar och microinteraktioner.
   -------------------------------------------------------------------------- */

/// <reference types="vite/client" />

import React, { useEffect, useMemo, useState, useCallback } from "react";
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

/* Visuell feedback via console + aria-live */
function announce(message: string) {
  console.log(message);
  const region = document.getElementById("sr-live");
  if (region) region.textContent = message;
}

/* ------------------------------------------------------- */
/* 🖼️  Huvudkomponent                                     */
/* ------------------------------------------------------- */
const AiPanel: React.FC = () => {
  /* --- Init ------------------------------------------ */
  const [initReceived, setInitReceived] = useState(false);
  const [figmaInfo, setFigmaInfo] = useState<{
    fileKey: string | null;
    nodeId: string | null;
    token: string | null;
  }>({ fileKey: null, nodeId: null, token: null });

  // Mini-preview URL från extension (dev-servern)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Kandidat-förslag
  const [proposal, setProposal] = useState<CandidateProposal | null>(null);

  // Kopiera-status (för mikrofeedback)
  const [copied, setCopied] = useState(false);

  const queryClientLocal = useQueryClient();

  useEffect(() => {
    const listener = (
      e: MessageEvent<InitMessage | DevUrlMessage | CandidateProposalMessage | any>
    ) => {
      const msg =
        e.data as InitMessage | DevUrlMessage | CandidateProposalMessage | any;
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
    isError: figmaError,
    error: figmaErr,
  } = useFigmaImage(
    figmaInfo.fileKey,
    figmaInfo.nodeId,
    figmaInfo.token,
    effectiveScale
  );

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

  const openZoom = useCallback(() => {
    if (figmaUrl) setZoomed(true);
  }, [figmaUrl]);
  const closeZoom = useCallback(() => setZoomed(false), []);

  /* --- Åtgärder --------------------------------------- */
  const handleCopyUrl = useCallback(async () => {
    if (!previewUrl) return;
    const ok = await copyToClipboard(previewUrl);
    setCopied(ok);
    if (ok) announce("Länk kopierad.");
    setTimeout(() => setCopied(false), 1500);
  }, [previewUrl]);

  const retryFigmaFetch = useCallback(() => {
    queryClientLocal.invalidateQueries({
      queryKey: ["figma-image", figmaInfo.fileKey, figmaInfo.nodeId, effectiveScale],
    });
  }, [queryClientLocal, figmaInfo.fileKey, figmaInfo.nodeId, effectiveScale]);

  /* ----------------------------------------------------- */
  /* Render                                                */
  /* ----------------------------------------------------- */
  const hasToken = !!figmaInfo.token;

  return (
    <div className="panel-root bg-background text-foreground">
      {/* Skärmläsare – aria-live för små bekräftelser */}
      <div id="sr-live" className="sr-only" aria-live="polite" />

      {/* ————— Top-bar: status + snabbåtgärder ————— */}
      <div className="px-4 pt-3">
        <Card className="card-elevated">
          <CardContent className="py-3">
            <div className="flex items-start md:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`status-dot ${previewUrl ? "ok" : "pending"}`}
                    aria-hidden="true"
                  />
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
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  onClick={postChooseProject}
                  aria-label="Välj projekt manuellt"
                  title="Välj projekt manuellt"
                >
                  Välj projekt…
                </Button>
                <Button
                  onClick={handleCopyUrl}
                  disabled={!previewUrl}
                  aria-label="Kopiera förhandsvisningslänk"
                  title={previewUrl ? "Kopiera förhandsvisningslänk" : "Ingen länk ännu"}
                  className={copied ? "btn-positive" : undefined}
                >
                  {copied ? "Kopierad ✓" : "Kopiera länk"}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ————— Figma kompakt preview (centrerad) ————— */}
      <div className="preview-shell">
        <div
          className={`preview-grid ${figmaUrl ? "is-ready" : figmaLoading ? "is-loading" : "is-error"}`}
          role={figmaUrl ? "button" : "img"}
          tabIndex={figmaUrl ? 0 : -1}
          aria-label={figmaUrl ? "Öppna större förhandsvisning" : "Figma-förhandsvisning"}
          onClick={figmaUrl ? openZoom : undefined}
          onKeyDown={(e) => {
            if (!figmaUrl) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openZoom();
            }
          }}
        >
          {/* Skeleton */}
          {figmaLoading && (
            <div className="skeleton" aria-hidden="true" />
          )}

          {/* Fel */}
          {figmaError && (
            <div className="error-state">
              <p className="text-sm mb-2">
                {(figmaErr as Error)?.message ?? "Kunde inte ladda Figma-bilden."}
              </p>
              <div className="flex gap-2">
                <Button onClick={retryFigmaFetch} className="btn-secondary">
                  Försök igen
                </Button>
                <Button onClick={postChooseProject} className="btn-ghost">
                  Välj projekt…
                </Button>
              </div>
            </div>
          )}

          {/* Bild */}
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

      {/* ————— Föreslagen kandidat ————— */}
      {proposal && (
        <div className="px-4">
          <Card className="card-elevated">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2">
                Föreslagen förhandsvisning
                <span className="tag">Kandidat</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="proposal">
                <div className="proposal__text">
                  <b className="block">{proposal.label}</b>
                  <span className="opacity-80 block">{proposal.description}</span>
                  <span className="opacity-60 block mono">{proposal.dir}</span>
                  {proposal.launchCmd && (
                    <span className="opacity-60 block mono mt-1">cmd: {proposal.launchCmd}</span>
                  )}
                </div>
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
                    onClick={postChooseProject}
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
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ————— Mini-preview av projektet (iframe) ————— */}
      {previewUrl && (
        <div className="px-4">
          <div className="mini-preview card-elevated">
            <div className="mini-preview__header">
              <span className="mono truncate">{previewUrl}</span>
              <div className="flex items-center gap-2">
                <Button
                  className="h-7 px-3 text-xs btn-secondary"
                  onClick={handleCopyUrl}
                  aria-label="Kopiera förhandsvisningslänk"
                >
                  Kopiera
                </Button>
              </div>
            </div>
            <div className="mini-preview__frame">
              <iframe
                src={previewUrl}
                title="Project preview"
                className="mini-preview__iframe"
                sandbox="allow-scripts allow-forms allow-same-origin"
              />
            </div>
          </div>
        </div>
      )}

      {/* ————— Lightbox / zoomläge ————— */}
      {zoomed && (
        <div
          className="figma-overlay"
          onClick={closeZoom}
          aria-modal="true"
          role="dialog"
        >
          <div
            className="figma-modal"
            onClick={(e) => e.stopPropagation()}
            role="document"
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
                vscode.postMessage({ cmd: "chat", text: chat.trim() });
                setChat("");
              }
            }}
            aria-label="Meddelande till assistenten"
          />
          <Button
            onClick={() => {
              if (!chat.trim()) return;
              vscode.postMessage({ cmd: "chat", text: chat.trim() });
              setChat("");
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
