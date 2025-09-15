```tsx
import React from "react";

const DashboardSidebar: React.FC = () => {
  return (
    <nav
      aria-label="Dashboard Sidebar Navigation"
      className="flex flex-col w-20 h-full bg-gray-800 text-white"
    >
      <ul className="flex flex-col gap-2 p-2">
        <li>
          <button
            type="button"
            className="w-full h-12 flex items-center justify-center rounded hover:bg-gray-700"
            aria-label="Home"
          >
            🏠
          </button>
        </li>
        <li>
          <button
            type="button"
            className="w-full h-12 flex items-center justify-center rounded hover:bg-gray-700"
            aria-label="Projects"
          >
            📁
          </button>
        </li>
        <li>
          <button
            type="button"
            className="w-full h-12 flex items-center justify-center rounded hover:bg-gray-700"
            aria-label="Settings"
          >
            ⚙️
          </button>
        </li>
      </ul>
    </nav>
  );
};

export default DashboardSidebar;
```

---  
frontendplay/src/main.tsx
```diff
@@
 import React from "react";
 import ReactDOM from "react-dom/client";
-import App from "./App";
+import App from "./App";
+
+import DashboardSidebar from "./components/ai/DashboardSidebar";
 
 const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
 root.render(
   <React.StrictMode>
-    <App />
+    <App />
+    {/* AI-INJECT-MOUNT */}
+    <DashboardSidebar />
   </React.StrictMode>
 );
```