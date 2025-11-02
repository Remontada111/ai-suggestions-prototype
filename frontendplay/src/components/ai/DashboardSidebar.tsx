```tsx
import React from "react";

const DashboardSidebar: React.FC = () => {
  return (
    <nav
      aria-label="Sidebar Navigation"
      className="flex flex-col w-20 h-full bg-gray-800 text-white"
      style={{ minWidth: 80 }}
    >
      <ul className="flex flex-col gap-2 p-2">
        <li>
          <button
            type="button"
            className="w-full h-12 flex items-center justify-center rounded hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            aria-label="Dashboard"
          >
            {/* Icon placeholder */}
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 12l2-2m0 0l7-7 7 7M13 5v6h6"
              />
            </svg>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="w-full h-12 flex items-center justify-center rounded hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            aria-label="Projects"
          >
            {/* Icon placeholder */}
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 17v-6a2 2 0 012-2h6"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13 7l7 7-7 7"
              />
            </svg>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="w-full h-12 flex items-center justify-center rounded hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            aria-label="Settings"
          >
            {/* Icon placeholder */}
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33h.09a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51h.09a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.09a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
              />
            </svg>
          </button>
        </li>
      </ul>
    </nav>
  );
};

export default DashboardSidebar;
```

frontendplay/src/main.tsx
```diff
@@ -1,12 +1,18 @@
 import React from "react";
 import ReactDOM from "react-dom/client";
 import App from "./App";
+
+import DashboardSidebar from "./components/ai/DashboardSidebar";
 
 ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
   <React.StrictMode>
     <App />
+    {/* AI-INJECT-MOUNT */}
+    <DashboardSidebar />
   </React.StrictMode>
 );
```