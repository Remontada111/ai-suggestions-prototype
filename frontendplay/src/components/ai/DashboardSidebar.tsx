```tsx
import React from "react";

interface DashboardSidebarProps {
  items: { id: string; label: string; icon?: React.ReactNode; onClick?: () => void }[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export function DashboardSidebar({ items, selectedId, onSelect }: DashboardSidebarProps) {
  return (
    <nav className="dashboard-sidebar bg-gray-800 text-white w-64 h-full flex flex-col">
      <ul className="flex flex-col gap-1 p-2">
        {items.map(({ id, label, icon, onClick }) => {
          const selected = id === selectedId;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => {
                  onClick?.();
                  onSelect?.(id);
                }}
                className={`flex items-center gap-2 w-full px-3 py-2 rounded-md text-left hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  selected ? "bg-indigo-600" : ""
                }`}
              >
                {icon && <span className="icon">{icon}</span>}
                <span>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
```

frontendplay/src/main.tsx
```diff
@@ -1,10 +1,16 @@
 import React from "react";
 import ReactDOM from "react-dom/client";
-import App from "./App";
+import App from "./App";
+import { DashboardSidebar } from "./components/ai/DashboardSidebar";
+
+const sidebarItems = [
+  { id: "home", label: "Home" },
+  { id: "projects", label: "Projects" },
+  { id: "settings", label: "Settings" },
+];
 
 const root = ReactDOM.createRoot(document.getElementById("root")!);
 root.render(
-  <React.StrictMode>
-    <App />
-  </React.StrictMode>
+  <React.StrictMode>
+    {/* AI-INJECT-MOUNT */}
+    <div className="app-with-sidebar flex h-full">
+      <DashboardSidebar items={sidebarItems} />
+      <div className="flex-1">
+        <App />
+      </div>
+    </div>
+  </React.StrictMode>
 );
```