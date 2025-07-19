import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/* ai-codegen-extension/webview/main.tsx
   ------------------------------------------------------------
   React-panel för AI Figma Codegen-extensionen
*/
/// <reference types="vite/client" />
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery, } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, } from "@/components/ui/card";
import { Diff } from "unidiff";
import stripAnsi from "strip-ansi";
/* VSC WebView-API */
const vscode = acquireVsCodeApi();
const queryClient = new QueryClient();
/* Hook för att hämta/polla Celery-tasken */
function useTask(taskId) {
    return useQuery({
        enabled: !!taskId,
        queryKey: ["task", taskId],
        queryFn: async () => {
            const r = await fetch(`http://localhost:8000/task/${taskId}`);
            if (!r.ok)
                throw new Error(await r.text());
            return r.json();
        },
        refetchInterval: 1500,
        refetchIntervalInBackground: true,
    });
}
/* ------------------------------------------------------- */
/* 🖼  Huvud-komponenten                                   */
/* ------------------------------------------------------- */
const AiPanel = () => {
    const [taskId, setTaskId] = useState(null);
    const { data, isLoading, isError, error } = useTask(taskId);
    const [chat, setChat] = useState("");
    /* Init-meddelande från extension.ts */
    useEffect(() => {
        function listener(e) {
            var _a;
            if (((_a = e.data) === null || _a === void 0 ? void 0 : _a.type) === "init")
                setTaskId(e.data.taskId);
        }
        window.addEventListener("message", listener);
        return () => window.removeEventListener("message", listener);
    }, []);
    /* ------------- Render ------------- */
    if (!taskId)
        return _jsx("p", { className: "p-4", children: "\u23F3 Initierar panel \u2026" });
    if (isLoading)
        return _jsx("p", { className: "p-4", children: "\u23F3 Startar AI-pipen \u2026" });
    if (isError)
        return (_jsxs("p", { className: "p-4 text-destructive", children: ["Fel: ", error.message] }));
    return (_jsxs("div", { className: "p-4 space-y-4 bg-background text-foreground", children: [_jsxs(Card, { children: [_jsx(CardHeader, { children: _jsx(CardTitle, { children: "Status" }) }), _jsxs(CardContent, { children: [_jsx("p", { className: "mb-2 font-mono", children: data.status }), data.diff && (_jsx("pre", { className: "whitespace-pre-wrap rounded-md bg-muted p-2 text-sm overflow-auto", children: stripAnsi(Diff.colorLines(data.diff)) }))] })] }), data.pr_url && (_jsx(Button, { className: "w-full", onClick: () => vscode.postMessage({ cmd: "openPR", url: data.pr_url }), children: "\uD83D\uDCE6 \u00D6ppna Pull Request" })), _jsxs("div", { className: "flex gap-2", children: [_jsx("input", { type: "text", className: "flex-1 input", placeholder: "Skicka instruktion \u2026", value: chat, onChange: (e) => setChat(e.currentTarget.value) }), _jsx(Button, { onClick: () => {
                            vscode.postMessage({ cmd: "chat", text: chat });
                            setChat("");
                        }, disabled: !chat, children: "Skicka" })] })] }));
};
/* ------------------------------------------------------- */
/* 🚀  Bootstrap                                           */
/* ------------------------------------------------------- */
createRoot(document.getElementById("root")).render(_jsx(QueryClientProvider, { client: queryClient, children: _jsx(AiPanel, {}) }));
//# sourceMappingURL=main.js.map