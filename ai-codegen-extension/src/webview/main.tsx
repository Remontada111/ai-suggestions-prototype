/* ai-codegen-extension/webview/main.tsx
   ------------------------------------------------------------
   React-panel för AI Figma Codegen-extensionen
   * Lägger till "live preview"‑stöd för en vald Figma‑komponent
   * Instrumenterad med console.log för felsökning
*/

/// <reference types="vite/client" />

import React, { useEffect, useState } from "react";
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

/* ------------------------------------------------------- */
/* 🛠  Typer                                               */
/* ------------------------------------------------------- */
interface InitMessage {
  type: "init";
  taskId?: string;
  fileKey: string;
  nodeId: string;
  token: string; // Figma‑PAT, skickas från extension.ts
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
/* 🌐  VS Code WebView‑API                                 */
/* ------------------------------------------------------- */
const vscode = acquireVsCodeApi();
const queryClient = new QueryClient();

/* ------------------------------------------------------- */
/* 🔗 Hook: Hämta Figma‑bild                               */
/* ------------------------------------------------------- */
function useFigmaImage(
  fileKey: string | null,
  nodeId: string | null,
  token: string | null
) {
  return useQuery<string>({
    enabled: !!fileKey && !!nodeId && !!token,
    queryKey: ["figma-image", fileKey, nodeId],
    staleTime: 1000 * 60 * 60,             // 1 h
    gcTime: 1000 * 60 * 60 * 24,           // 24 h
    retry: 1,
    queryFn: async () => {
      console.log("🔍 useFigmaImage: hämtar bild från Figma API", { fileKey, nodeId });
      const url = `https://api.figma.com/v1/images/${fileKey}?ids=${nodeId}&format=png&scale=2`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error("❌ Figma API error:", res.status);
        throw new Error(`Figma API returned ${res.status}`);
      }
      const data = (await res.json()) as FigmaImageApiRes;
      const imgUrl = data.images[nodeId!];
      if (!imgUrl) {
        console.error("❌ Inget image URL returnerades", data.err);
        throw new Error(data.err ?? "No image returned");
      }
      console.log("✅ useFigmaImage: fick URL", imgUrl);
      return imgUrl;
    },
  });
}

/* ------------------------------------------------------- */
/* 🏗  Befintlig hook: Polla Celery‑task                   */
/* ------------------------------------------------------- */
function useTask(taskId: string | null) {
  return useQuery<TaskRes>({
    enabled: !!taskId,
    queryKey: ["task", taskId],
    queryFn: async () => {
      console.log("📡 useTask: pollar backend för taskId", taskId);
      const r = await fetch(`http://localhost:8000/task/${taskId}`);
      if (!r.ok) {
        const text = await r.text();
        console.error("❌ Backend task error:", text);
        throw new Error(text);
      }
      const json = (await r.json()) as TaskRes;
      console.log("✅ useTask: fick status", json.status);
      return json;
    },
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
  });
}

/* ------------------------------------------------------- */
/* 🖼️  Huvudkomponent                                     */
/* ------------------------------------------------------- */
const AiPanel: React.FC = () => {
  console.log("🚀 AiPanel: render start");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [figmaInfo, setFigmaInfo] = useState<{
    fileKey: string | null;
    nodeId: string | null;
    token: string | null;
  }>({ fileKey: null, nodeId: null, token: null });

  /* Init‑lyssnare från extension.ts */
  useEffect(() => {
    console.log("🔌 AiPanel: sätter upp message-listener");
    function listener(e: MessageEvent<InitMessage>) {
      console.log("📨 AiPanel: message mottaget", e.data);
      if (e.data?.type === "init") {
        setTaskId(e.data.taskId ?? null);
        setFigmaInfo({
          fileKey: e.data.fileKey,
          nodeId: e.data.nodeId,
          token: e.data.token,
        });
      }
    }
    window.addEventListener("message", listener);
    return () => {
      console.log("🧹 AiPanel: tar bort message-listener");
      window.removeEventListener("message", listener);
    };
  }, []);

  /* Figma‑bildförhandsvisning */
  const {
    data: figmaUrl,
    isLoading: figmaLoading,
    isError: figmaError,
    error: figmaErr,
  } = useFigmaImage(
    figmaInfo.fileKey,
    figmaInfo.nodeId,
    figmaInfo.token
  );

  /* Task‑pollning */
  const {
    data: taskData,
    isLoading: taskLoading,
    isError: taskError,
    error: taskErr,
  } = useTask(taskId);
  const [chat, setChat] = useState("");

  /* Globala felhanterare */
  useEffect(() => {
    window.addEventListener("error", (e) => {
      console.error("🌋 Uncaught error i webview:", e.error || e.message);
    });
    window.addEventListener("unhandledrejection", (e) => {
      console.error("🌋 Unhandled promise rejection i webview:", e.reason);
    });
  }, []);

  return (
    <div className="p-4 space-y-4 bg-background text-foreground">
      {/* ---------- Figma Preview ---------- */}
      <Card>
        <CardHeader>
          <CardTitle>Figma‑förhandsvisning</CardTitle>
        </CardHeader>
        <CardContent>
          {figmaLoading && <p>Laddar …</p>}
          {figmaError && (
            <p className="text-destructive">{
              (figmaErr as Error).message
            }</p>
          )}
          {figmaUrl && (
            <img
              src={figmaUrl! /* non-null assertion */}
              alt="Vald Figma‑komponent"
              className="w-full rounded-md shadow"
              loading="lazy"
            />
          )}
        </CardContent>
      </Card>

      {/* ---------- AI‑taskstatus ---------- */}
      {!taskId ? (
        <p>⏳ Initierar panel …</p>
      ) : taskLoading ? (
        <p>⏳ Startar AI‑pipen …</p>
      ) : taskError ? (
        <p className="text-destructive">{
          (taskErr as Error).message
        }</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
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
            <Button
              className="w-full"
              onClick={() =>
                vscode.postMessage({ cmd: "openPR", url: taskData!.pr_url })
              }
            >
              📦 Öppna Pull Request
            </Button>
          )}
        </>
      )}

      {/* ---------- Chatfält ---------- */}
      <div className="flex gap-2">
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
console.log("✅ main.tsx: laddar React-root");
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AiPanel />
  </QueryClientProvider>,
);
console.log("✅ main.tsx: React‑root laddad");