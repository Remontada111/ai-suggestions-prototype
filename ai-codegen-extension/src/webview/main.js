
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
/* ai-codegen-extension/webview/main.tsx
   ------------------------------------------------------------
   React-panel för AI Figma Codegen-extensionen
*/
/// <reference types="vite/client" />
const react_1 = require("react");
const client_1 = require("react-dom/client");
const react_query_1 = require("@tanstack/react-query");
const button_1 = require("@/components/ui/button");
const card_1 = require("@/components/ui/card");
const unidiff_1 = require("unidiff");
const strip_ansi_1 = __importDefault(require("strip-ansi"));
/* VSC WebView-API */
const vscode = acquireVsCodeApi();
const queryClient = new react_query_1.QueryClient();
/* Hook för att hämta/polla Celery-tasken */
function useTask(taskId) {
    return (0, react_query_1.useQuery)({
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
    const [taskId, setTaskId] = (0, react_1.useState)(null);
    const { data, isLoading, isError, error } = useTask(taskId);
    const [chat, setChat] = (0, react_1.useState)("");
    /* Init-meddelande från extension.ts */
    (0, react_1.useEffect)(() => {
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
        return (0, jsx_runtime_1.jsx)("p", { className: "p-4", children: "\u23F3 Initierar panel \u2026" });
    if (isLoading)
        return (0, jsx_runtime_1.jsx)("p", { className: "p-4", children: "\u23F3 Startar AI-pipen \u2026" });
    if (isError)
        return ((0, jsx_runtime_1.jsxs)("p", { className: "p-4 text-destructive", children: ["Fel: ", error.message] }));
    return ((0, jsx_runtime_1.jsxs)("div", { className: "p-4 space-y-4 bg-background text-foreground", children: [(0, jsx_runtime_1.jsxs)(card_1.Card, { children: [(0, jsx_runtime_1.jsx)(card_1.CardHeader, { children: (0, jsx_runtime_1.jsx)(card_1.CardTitle, { children: "Status" }) }), (0, jsx_runtime_1.jsxs)(card_1.CardContent, { children: [(0, jsx_runtime_1.jsx)("p", { className: "mb-2 font-mono", children: data.status }), data.diff && ((0, jsx_runtime_1.jsx)("pre", { className: "whitespace-pre-wrap rounded-md bg-muted p-2 text-sm overflow-auto", children: (0, strip_ansi_1.default)(unidiff_1.Diff.colorLines(data.diff)) }))] })] }), data.pr_url && ((0, jsx_runtime_1.jsx)(button_1.Button, { className: "w-full", onClick: () => vscode.postMessage({ cmd: "openPR", url: data.pr_url }), children: "\uD83D\uDCE6 \u00D6ppna Pull Request" })), (0, jsx_runtime_1.jsxs)("div", { className: "flex gap-2", children: [(0, jsx_runtime_1.jsx)("input", { type: "text", className: "flex-1 input", placeholder: "Skicka instruktion \u2026", value: chat, onChange: (e) => setChat(e.currentTarget.value) }), (0, jsx_runtime_1.jsx)(button_1.Button, { onClick: () => {
                            vscode.postMessage({ cmd: "chat", text: chat });
                            setChat("");
                        }, disabled: !chat, children: "Skicka" })] })] }));
};
/* ------------------------------------------------------- */
/* 🚀  Bootstrap                                           */
/* ------------------------------------------------------- */
(0, client_1.createRoot)(document.getElementById("root")).render((0, jsx_runtime_1.jsx)(react_query_1.QueryClientProvider, { client: queryClient, children: (0, jsx_runtime_1.jsx)(AiPanel, {}) }));
//# sourceMappingURL=main.js.map