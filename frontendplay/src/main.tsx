import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import  Menu  from './components/ai/Menu';

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
        <div className="fixed inset-0 z-[2147483647] pointer-events-none">  <div className="absolute left-0 top-0 w-[1280px] h-[800px]">    <div className="absolute left-[491px] top-[2px] w-[243px] h-[713px] overflow-hidden pointer-events-auto">      <Menu />    </div>  </div></div>
        {/* AI-INJECT-MOUNT:END */}</div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
