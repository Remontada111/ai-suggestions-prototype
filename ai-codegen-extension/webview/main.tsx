/* ai-codegen-extension/webview/main.tsx
   ------------------------------------------------------------
   React-panel för AI Figma Codegen-extensionen
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
/* 🛠  Typer och hjälp-funktioner                           */
/* ------------------------------------------------------- */
interface TaskRes {
  status: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  pr_url?: string;
  diff?: string;
}

/* VSC WebView-API */
const vscode = acquireVsCodeApi();
const queryClient = new QueryClient();

/* Hook för att hämta/polla Celery-tasken */
function useTask(taskId: string | null) {
  return useQuery<TaskRes>({
    enabled: !!taskId,
    queryKey: ["task", taskId],
    queryFn: async () => {
      const r = await fetch(`http://localhost:8000/task/${taskId}`);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
  });
}

/* ------------------------------------------------------- */
/* 🖼  Huvud-komponenten                                   */
/* ------------------------------------------------------- */
const AiPanel: React.FC = () => {
  const [taskId, setTaskId] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useTask(taskId);
  const [chat, setChat] = useState("");

  /* Init-meddelande från extension.ts */
  useEffect(() => {
    function listener(e: MessageEvent) {
      if (e.data?.type === "init") setTaskId(e.data.taskId);
    }
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  /* ------------- Render ------------- */
  if (!taskId) return <p className="p-4">⏳ Initierar panel …</p>;
  if (isLoading) return <p className="p-4">⏳ Startar AI-pipen …</p>;
  if (isError) return (
    <p className="p-4 text-destructive">
      Fel: {(error as Error).message}
    </p>
  );

  return (
    <div className="p-4 space-y-4 bg-background text-foreground">
      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-2 font-mono">{data!.status}</p>

          {data!.diff && (
            <pre
              className="whitespace-pre-wrap rounded-md bg-muted p-2 text-sm overflow-auto"
            >
              {stripAnsi(Diff.colorLines(data!.diff))}
            </pre>
          )}
        </CardContent>
      </Card>

      {data!.pr_url && (
        <Button
          className="w-full"
          onClick={() =>
            vscode.postMessage({ cmd: "openPR", url: data!.pr_url })
          }
        >
          📦 Öppna Pull Request
        </Button>
      )}

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
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AiPanel />
  </QueryClientProvider>,
);



