import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import Menufc7725 from './components/ai/Menu-fc7725';











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
        {/* AI-INJECT-MOUNT:BEGIN */}
        <div id="__AI_MOUNT_GRID__" className="flex flex-wrap gap-4 items-start">
        
        <> </>
        <> {/* AI-TILE:./components/ai/Menu-fc7725:BEGIN */}
        <div className="relative w-[1280px] h-[800px] overflow-hidden rounded-md ring-1 ring-black/10 bg-white">
        <Menufc7725 />
        </div> {/* AI-TILE:./components/ai/Menu-fc7725:END */}</>
        <> </>
        <> </>
        <> </>
        <> </></div>
        {/* AI-INJECT-MOUNT:END */}</div>
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
