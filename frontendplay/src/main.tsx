import React from "react";
import { createRoot } from "react-dom/client";
import './index.css';
import { Menu } from './components/ai/Menu';

function App() {
  return (
    <div style={{ padding: 12, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ margin: "0 0 6px 0", fontSize: 18 }}>FrontendPlay</h1>
      <h2 style={{ margin: "0 0 12px 0", fontSize: 14, color: "#666" }}>
        A playground for frontend experiments
      </h2>
      {/* AI-INJECT-MOUNT:BEGIN */}
      <Menu />
      {/* AI-INJECT-MOUNT:END */}{/* AI-INJECT-MOUNT:END */}{/* AI-INJECT-MOUNT:END */}
    </div>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
