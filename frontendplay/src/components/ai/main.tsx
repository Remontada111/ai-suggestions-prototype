@@
-import React from 'react'
-import ReactDOM from 'react-dom/client'
-import App from './App'
+import React from 'react'
+import ReactDOM from 'react-dom/client'
+import App from './App'
+
+import ChatBar from './webview/ChatBar'
@@
-ReactDOM.createRoot(document.getElementById('root')!).render(
-  <React.StrictMode>
-    <App />
-  </React.StrictMode>,
-)
+ReactDOM.createRoot(document.getElementById('root')!).render(
+  <React.StrictMode>
+    <App />
+    {/* AI-INJECT-MOUNT */}
+    <ChatBar />
+  </React.StrictMode>,
+)