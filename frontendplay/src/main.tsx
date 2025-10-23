import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";






const VP = { w: 1280, h: 800 };

function App() {
  return (
    <div style={{ padding: 12, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ margin: "0 0 6px 0", fontSize: 18 }}>FrontendPlay</h1>
      <h2 style={{ margin: "0 0 12px 0", fontSize: 14, color: "#666" }}>
        A playground for frontend experiments
      </h2>

      <div
        id="preview-root"
        style={{
          position: "relative",
          width: VP.w,
          height: VP.h,
          overflow: "hidden",
        }}
      >
        {/* Lägg din iframe/devUrl-overlay här om du vill */}
          {/* AI-INJECT-MOUNT:BEGIN */}
        {/* AI-INJECT-MOUNT:END */}</div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
