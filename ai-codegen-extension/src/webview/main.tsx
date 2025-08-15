/* ai-codegen-extension/webview/main.tsx 
   --------------------------------------------------------------------------
   React-panel för AI Figma Codegen – kompakt preview, centrerad, lightbox-
   toggle med mörknad bakgrund och stäng-kryss. Hög DPI även i zoomläge.
   + Mini-preview av användarens dev-server under Figma-kortet.
   + [NY] Project Summary från backend-analys.
   + [NY] Kandidat-förslag med “Acceptera förhandsvisning”.
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
import { Diff } from "unidiff";
import stripAnsi from "strip-ansi";
import "./index.css";

// [NY] – Project Summary UI
import ProjectSummary from "./components/ProjectSummary";

/* ------------------------------------------------------- */
/* 🛠  Typer                                               */
/* ------------------------------------------------------- */
interface InitMessage {
  type: "init";
  taskId?: string;
  fileKey: string;
  nodeId: string;
  token?: string;       // nyckeln kan saknas → optional
  figmaToken?: string;  // bakåtkompatibelt namn
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

interface TaskRes {
  status: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  pr_url?: string;
  diff?: string;
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
  scale:   number            // ← styr exportskala (2–4)
) {
  return useQuery<string>({
    enabled: !!fileKey && !!nodeId && !!token && !!scale,
    queryKey: ["figma-image", fileKey, nodeId, scale],
    staleTime: 1000 * 60 * 60,        // 1 h
    gcTime:    1000 * 60 * 60 * 24,   // 24 h
    retry: 1,
    queryFn: async () => {
      const capped = Math.max(1, Math.min(4, Math.round(scale)));
      const url = `https://api.figma.com/v1/images/${fileKey}?ids=${nodeId}&format=png&scale=${capped}&use_absolute_bounds=true`;

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
/*  Hook: Polla Celery-task                                */
/* ------------------------------------------------------- */
function useTask(taskId: string | null) {
  return useQuery<TaskRes>({
    enabled: !!taskId,
    queryKey: ["task", taskId],
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
    queryFn: async () => {
      const r = await fetch(`http://localhost:8000/task/${taskId}`);
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text);
      }
      return (await r.json()) as TaskRes;
    },
  });
}

/* ------------------------------------------------------- */
/* 🖼️  Huvudkomponent                                     */
/* ------------------------------------------------------- */
const AiPanel: React.FC = () => {
  /* --- Init ------------------------------------------ */
  const [initReceived, setInitReceived] = useState(false);
  const [taskId, setTaskId]             = useState<string | null>(null);
  const [figmaInfo, setFigmaInfo]       = useState<{
    fileKey: string | null;
    nodeId:  string | null;
    token:   string | null;
  }>({ fileKey: null, nodeId: null, token: null });

  // Mini-preview URL från extension (dev-servern)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // [NY] Kandidat-förslag
  const [proposal, setProposal] = useState<CandidateProposal | null>(null);

  useEffect(() => {
    const listener = (e: MessageEvent<InitMessage | DevUrlMessage | CandidateProposalMessage | any>) => {
      const msg = e.data as InitMessage | DevUrlMessage | CandidateProposalMessage | any;
      if (!msg || typeof msg !== "object") return;

      if ((msg as InitMessage).type === "init") {
        const m = msg as InitMessage;
        const tok = m.token ?? m.figmaToken ?? null;
        setInitReceived(true);
        setTaskId(m.taskId ?? null);
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

  const {
    data: taskData,
    isLoading: taskLoading,
    isError:   taskError,
    error:     taskErr,
  } = useTask(taskId);

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
      {/* ————— Figma kompakt preview (centrerad, högt upp) ————— */}
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
          {initReceived && !figmaInfo.token && (
            <p className="text-destructive text-sm">⚠️ Ingen Figma-token – kontrollera inställningen.</p>
          )}

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

      {/* ————— [NY] Föreslagen kandidat (Acceptera) ————— */}
      {proposal && (
        <div className="px-4 mt-3">
          <Card>
            <CardHeader>
              <CardTitle>Föreslagen förhandsvisning</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm mb-2">
                <b>{proposal.label}</b><br />
                <span className="opacity-80">{proposal.description}</span><br />
                <span className="opacity-60">{proposal.dir}</span>
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    vscode.postMessage({ cmd: "acceptCandidate" });
                    setProposal(null); // dölj rutan när vi startar
                  }}
                >
                  Starta förhandsvisning
                </Button>
                <Button
                  className="btn-secondary"
                  onClick={() => setProposal(null)}
                >
                  Avbryt
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ————— Mini-preview av hela projektet (iframe) ————— */}
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
          <p className="px-2 py-1 text-xs opacity-70 break-all">{previewUrl}</p>
        </div>
      )}

      {/* ————— [NY] Project Summary (analysresultat) ————— */}
      <div className="px-4 mt-3">
        <ProjectSummary />
      </div>

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

      {/* ————— Resten av panelen (status + chat) ————— */}
      {!taskId ? (
        <p className="px-4">⏳ Initierar panel …</p>
      ) : taskLoading ? (
        <p className="px-4">⏳ Startar AI-pipen …</p>
      ) : taskError ? (
        <p className="px-4 text-destructive">{(taskErr as Error).message}</p>
      ) : (
        <>
          <Card className="mt-3 mx-4">
            <CardHeader><CardTitle>Status</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-2 font-mono">{taskData!.status}</p>
              {taskData!.diff && (
                <pre className="whitespace-pre-wrap rounded-md bg-muted p-2 text-sm overflow-auto">
                  {stripAnsi(Diff.colorLines(taskData!.diff))}
                </pre>
              )}
            </CardContent>
          </Card>

          {taskData!.pr_url && (
            <div className="px-4">
              <Button
                className="w-full mt-2"
                onClick={() => vscode.postMessage({ cmd: "openPR", url: taskData!.pr_url })}
              >
                📦 Öppna Pull Request
              </Button>
            </div>
          )}
        </>
      )}

      {/* Chat */}
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
