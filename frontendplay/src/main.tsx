import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

const VP = { w: 1280, h: 800 };

function App() {
  return (
    <div style={{ padding: 12, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ margin: "0 0 6px 0", fontSize: 18 }}>FrontendPlay</h1>

      <div
        id="preview-root"
        style={{ position: "relative", width: VP.w, height: VP.h, overflow: "hidden" }}
      >
        {/* AI-INJECT-MOUNT:BEGIN */}
        {/* AI-INJECT-MOUNT:END */}
      </div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
