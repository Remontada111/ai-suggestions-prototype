import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import Menu834b90 from './components/ai/Menu-834b90';






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
        <div id="__AI_MOUNT_GRID__" className="flex flex-wrap gap-4 items-start">
        
        <> {/* AI-TILE:./components/ai/Menu-834b90:BEGIN */}
        <div className="relative w-[1280px] h-[800px] overflow-hidden rounded-md ring-1 ring-black/10 bg-white">
        <div className="absolute inset-0 w-full h-full pointer-events-none">  <div className="absolute left-[37.1875%] top-[0.0%] w-[6.3281%] h-[100.0%] overflow-hidden pointer-events-auto">    <Menu834b90 />  </div></div>
        </div> {/* AI-TILE:./components/ai/Menu-834b90:END */}</></div>
        {/* AI-INJECT-MOUNT:END */}</div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
