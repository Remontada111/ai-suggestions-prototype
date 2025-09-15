```tsx
import React from "react";

export function DashboardSidebar() {
  return (
    <nav
      aria-label="Sidebar Navigation"
      className="flex flex-col w-20 h-full bg-gray-800 text-gray-100"
    >
      <ul className="flex flex-col gap-2 p-2">
        <li>
          <a
            href="#dashboard"
            className="block p-3 rounded hover:bg-gray-700 focus:bg-gray-700 focus:outline-none"
          >
            Dashboard
          </a>
        </li>
        <li>
          <a
            href="#projects"
            className="block p-3 rounded hover:bg-gray-700 focus:bg-gray-700 focus:outline-none"
          >
            Projects
          </a>
        </li>
        <li>
          <a
            href="#settings"
            className="block p-3 rounded hover:bg-gray-700 focus:bg-gray-700 focus:outline-none"
          >
            Settings
          </a>
        </li>
      </ul>
    </nav>
  );
}
```

--- frontendplay/src/main.tsx
```diff
@@
-import React from "react";
-import ReactDOM from "react-dom/client";
-import App from "./App";
+import React from "react";
+import ReactDOM from "react-dom/client";
+import App from "./App";
+import { DashboardSidebar } from "./components/ai/DashboardSidebar";
 
-ReactDOM.createRoot(document.getElementById("root")!).render(
-  <React.StrictMode>
-    <App />
-  </React.StrictMode>
-);
+ReactDOM.createRoot(document.getElementById("root")!).render(
+  <React.StrictMode>
+    <App />
+    {/* AI-INJECT-MOUNT */}
+    <DashboardSidebar />
+  </React.StrictMode>
+);
```