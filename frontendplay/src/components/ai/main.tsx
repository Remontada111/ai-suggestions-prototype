@@
-import React from 'react'
-import ReactDOM from 'react-dom/client'
-import App from './App'
+import React from 'react'
+import ReactDOM from 'react-dom/client'
+import App from './App'
+
+import DashboardSidebarNavigationCommunity from './components/ai/DashboardSidebarNavigationCommunity'
@@
-ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
-  <React.StrictMode>
-    <App />
-  </React.StrictMode>,
-)
+ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
+  <React.StrictMode>
+    <App />
+    {/* AI-INJECT-MOUNT */}
+    <DashboardSidebarNavigationCommunity />
+  </React.StrictMode>,
+)

frontendplay/src/components/ai/DashboardSidebarNavigationCommunity.tsx
@@
+import React from 'react'
+
+const items = [
+  { id: 'dashboard', label: 'Dashboard', icon: (
+    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
+      <path d="M3 12l2-2m0 0l7-7 7 7M13 5v6h6" />
+      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7" />
+    </svg>
+  ) },
+  { id: 'projects', label: 'Projects', icon: (
+    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
+      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
+      <line x1="3" y1="10" x2="21" y2="10" />
+    </svg>
+  ) },
+  { id: 'team', label: 'Team', icon: (
+    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
+      <path d="M17 21v-2a4 4 0 0 0-3-3.87" />
+      <path d="M7 21v-2a4 4 0 0 1 3-3.87" />
+      <circle cx="12" cy="7" r="4" />
+    </svg>
+  ) },
+  { id: 'calendar', label: 'Calendar', icon: (
+    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
+      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
+      <line x1="16" y1="2" x2="16" y2="6" />
+      <line x1="8" y1="2" x2="8" y2="6" />
+      <line x1="3" y1="10" x2="21" y2="10" />
+    </svg>
+  ) },
+  { id: 'documents', label: 'Documents', icon: (
+    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
+      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
+      <polyline points="14 2 14 8 20 8" />
+    </svg>
+  ) },
+  { id: 'reports', label: 'Reports', icon: (
+    <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
+      <line x1="12" y1="20" x2="12" y2="10" />
+      <line x1="18" y1="20" x2="18" y2="4" />
+      <line x1="6" y1="20" x2="6" y2="16" />
+    </svg>
+  ) },
+]
+
+export default function DashboardSidebarNavigationCommunity() {
+  const [activeId, setActiveId] = React.useState('dashboard')
+
+  return (
+    <nav aria-label="Sidebar" className="w-64 bg-gray-800 text-gray-100 flex flex-col h-full">
+      <div className="flex items-center justify-center h-16 border-b border-gray-700">
+        <h1 className="text-lg font-semibold">Community</h1>
+      </div>
+      <ul role="list" className="flex-1 overflow-y-auto py-4 space-y-1">
+        {items.map(({ id, label, icon }) => (
+          <li key={id}>
+            <button
+              type="button"
+              onClick={() => setActiveId(id)}
+              className={`group flex items-center px-4 py-2 text-sm font-medium rounded-md w-full text-left
+                ${activeId === id ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-white'}`}
+            >
+              <span className="mr-3" aria-hidden="true">{icon}</span>
+              {label}
+            </button>
+          </li>
+        ))}
+      </ul>
+    </nav>
+  )
+}
+