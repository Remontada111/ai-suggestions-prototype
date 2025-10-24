import React, { useEffect, useState } from "react";
import { analyzeStore, type AnalyzeState, type ProjectModel } from "../state/analyze";

const box: React.CSSProperties = { border: "1px solid rgba(127,127,127,.25)", borderRadius: 12, padding: 12 };
const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "140px 1fr", gap: 8, margin: "4px 0" };
const pill: React.CSSProperties = { display: "inline-block", padding: "2px 8px", border: "1px solid rgba(127,127,127,.3)", borderRadius: 999, fontSize: 12 };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div style={row}><div style={{ opacity: .7 }}>{k}</div><div>{v}</div></div>;
}

export default function ProjectSummary() {
  const [s, setS] = useState<AnalyzeState>({ status: "IDLE" });

  useEffect(() => analyzeStore.subscribe(setS), []);

  if (s.status === "ERROR") {
    return <div style={{ ...box, background: "rgba(255,0,0,.05)" }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Project Summary</div>
      <div style={{ color: "#b00020" }}>Fel: {s.message}</div>
    </div>;
  }

  if (s.status !== "SUCCESS") {
    return <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Project Summary</div>
      <div style={{ opacity: .7 }}>{s.status === "IDLE" ? "Väntar på analys…" : `Analys: ${s.status}`}</div>
    </div>;
  }

  const m: ProjectModel = s.model;

  return <div style={box}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
      <div style={{ fontWeight: 600 }}>Project Summary</div>
      <div style={{ fontSize: 12, opacity: .7 }}>{m.routing.type} • {m.routing.count} routes • {m.components.length} components • {m.injectionPoints.length} injections</div>
    </div>

    <Row k="Manager" v={<span style={pill}>{m.manager}</span>} />
    <Row k="Framework" v={<span style={pill}>{m.framework}</span>} />
    <Row k="Entry (HTML)" v={m.entryPoints.html.length ? m.entryPoints.html.join(", ") : <em>—</em>} />
    <Row k="Entry (main)" v={m.entryPoints.mainFiles.length ? m.entryPoints.mainFiles.join(", ") : <em>—</em>} />
    <Row k="Entry (app)" v={m.entryPoints.appFiles.length ? m.entryPoints.appFiles.join(", ") : <em>—</em>} />
    <Row k="Tailwind" v={m.styling.tailwind.present ? <span style={pill}>Ja {m.styling.tailwind.configPath ? `(${m.styling.tailwind.configPath})` : ""}</span> : <span style={pill}>Nej</span>} />
    <Row k="UI-libs" v={m.styling.uiLibs.length ? m.styling.uiLibs.map((x,i)=><span key={i} style={{...pill, marginRight:6}}>{x}</span>) : <em>—</em>} />

    <div style={{ marginTop: 10, fontWeight: 500 }}>Routing</div>
    {m.routing.count ? (
      <div style={{ maxHeight: 180, overflow: "auto", border: "1px solid rgba(127,127,127,.25)", borderRadius: 8, padding: 8, fontSize: 12 }}>
        {m.routing.routes.slice(0, 100).map((r, i) => <div key={i} style={{ display: "flex", gap: 8 }}>
          <code style={{ minWidth: 120 }}>{r.path}</code><span style={{ opacity: .7 }}>{r.file}</span>
        </div>)}
        {m.routing.routes.length > 100 && <div style={{ opacity: .6 }}>… {m.routing.routes.length - 100} fler</div>}
      </div>
    ) : <div style={{ opacity: .7, marginBottom: 8 }}>Inga rutter upptäckta.</div>}

    <div style={{ marginTop: 10, fontWeight: 500 }}>Injections</div>
    {m.injectionPoints.length ? (
      <div style={{ maxHeight: 140, overflow: "auto", border: "1px solid rgba(127,127,127,.25)", borderRadius: 8, padding: 8, fontSize: 12 }}>
        {m.injectionPoints.map((p, i) => <div key={i} style={{ display: "flex", gap: 8 }}>
          <code style={{ minWidth: 80 }}>@{p.tag}</code><span style={{ opacity: .7 }}>{p.file}:{p.line}</span>
        </div>)}
      </div>
    ) : <div style={{ opacity: .7 }}>Inga @inject:-punkter hittades.</div>}

    {m.warnings?.length ? (
      <div style={{ marginTop: 10, padding: 8, border: "1px solid rgba(255,193,7,.35)", borderRadius: 8, background: "rgba(255,193,7,.08)" }}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Varningar</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>{m.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>
      </div>
    ) : null}
  </div>;
}
