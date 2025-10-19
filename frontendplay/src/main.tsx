import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import  Menu  from './components/ai/Menu';
import Menua0fa98 from './components/ai/Menu-a0fa98';

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
        <div className="absolute inset-0 w-full h-full pointer-events-none">  <div className="absolute left-[20.8594%] top-[0.0%] w-[16.3281%] h-[100.0%] overflow-hidden pointer-events-auto">    <Menua0fa98 />  </div></div>
        {/* AI-INJECT-MOUNT:END */}</div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
