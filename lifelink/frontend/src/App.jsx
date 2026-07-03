import React, { useRef, useState, useEffect, useCallback } from "react";
import { socket, login, createEmergency } from "./api.js";
import { project, unproject, W, H } from "./projection.js";

const C = {
  bg: "#0A0E14", panel: "#0E1622", panelHi: "#121C2B", line: "#1D2A3C", lineSoft: "#16222F",
  text: "#DCE6F2", dim: "#8A99AD", faint: "#586A80",
  p1: "#FF3B54", p2: "#FFB020", p3: "#2DD4A8", cyan: "#38D9F5", green: "#35B37E",
  grid: "#101B29", gridMajor: "#152538",
};
const UI = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const SEV = { 1: { key: "P1", label: "Critical", color: C.p1 }, 2: { key: "P2", label: "Urgent", color: C.p2 }, 3: { key: "P3", label: "Stable", color: C.p3 } };
const AMB = { available: { c: C.green, t: "Available" }, enroute: { c: null, t: "En route" }, onscene: { c: C.text, t: "On scene" }, transporting: { c: C.cyan, t: "Transporting" }, offline: { c: C.faint, t: "Offline" } };

const fmt = (s) => { if (s == null || isNaN(s)) return "--:--"; s = Math.max(0, Math.round(s)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const bedsMap = (beds) => { const m = {}; for (const b of beds || []) (m[b.hospital_id] ||= {})[b.tier] = [b.occupied, b.total]; return m; };
const loadOf = (bm, hid) => { const t = bm[hid]; if (!t) return 0; let o = 0, tot = 0; for (const k of ["icu", "er", "ward"]) if (t[k]) { o += t[k][0]; tot += t[k][1]; } return tot ? o / tot : 0; };
const loadColor = (r) => (r >= 0.9 ? C.p1 : r >= 0.7 ? C.p2 : C.green);

export default function App() {
  const [snap, setSnap] = useState({ ambulances: [], emergencies: [], hospitals: [], beds: [], kpi: {} });
  const [log, setLog] = useState([]);
  const [connected, setConnected] = useState(false);
  const [auth, setAuth] = useState(() => { try { return JSON.parse(localStorage.getItem("ll_auth") || "null"); } catch { return null; } });
  const [sev, setSev] = useState(2);
  const [sel, setSel] = useState(null);
  const [, force] = useState(0);

  const snapRef = useRef(snap);
  const posRef = useRef(new Map()); // ambId -> displayed {x,y}, tweened toward server position
  const svgRef = useRef(null);
  snapRef.current = snap;

  // ---- realtime wiring ----
  useEffect(() => {
    const onState = (s) => setSnap(s);
    const onEvent = (e) => setLog((l) => [e, ...l].slice(0, 40));
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("state", onState);
    socket.on("event", onEvent);
    setConnected(socket.connected);
    return () => { socket.off("connect"); socket.off("disconnect"); socket.off("state", onState); socket.off("event", onEvent); };
  }, []);

  // ---- smooth position tween + timer refresh (~30fps) ----
  useEffect(() => {
    let raf, acc = 0, last = performance.now();
    const loop = (now) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const k = 1 - Math.pow(0.0001, dt); // exponential ease
      for (const a of snapRef.current.ambulances) {
        const tgt = project(a.lat, a.lng);
        const cur = posRef.current.get(a.id) || tgt;
        posRef.current.set(a.id, { x: cur.x + (tgt.x - cur.x) * k, y: cur.y + (tgt.y - cur.y) * k });
      }
      acc += dt; if (acc >= 0.033) { acc = 0; force((f) => f + 1); }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const doLogin = async (u, p, setErr) => { try { const r = await login(u, p); const a = { token: r.token, role: r.role, username: r.username }; setAuth(a); localStorage.setItem("ll_auth", JSON.stringify(a)); } catch { setErr("Invalid credentials"); } };
  const logout = () => { setAuth(null); localStorage.removeItem("ll_auth"); };

  const onMapClick = async (ev) => {
    if (!auth || auth.role !== "dispatcher") return;
    const svg = svgRef.current; if (!svg) return;
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM(); if (!m) return;
    const loc = pt.matrixTransform(m.inverse());
    const { lat, lng } = unproject(Math.max(0, Math.min(W, loc.x)), Math.max(0, Math.min(H, loc.y)));
    const types = { 1: "Cardiac arrest", 2: "Chest pain", 3: "Minor injury" };
    try { await createEmergency(auth.token, { severity: sev, type: types[sev], lat: +lat.toFixed(6), lng: +lng.toFixed(6) }); } catch (e) { /* ignore */ }
  };

  const s = snap;
  const bm = bedsMap(s.beds);
  const hospPos = Object.fromEntries((s.hospitals || []).map((h) => [h.id, project(h.lat, h.lng)]));
  const emById = Object.fromEntries((s.emergencies || []).map((e) => [e.id, e]));
  const now = Date.now() / 1000;
  const active = s.emergencies || [];
  const waiting = active.filter((e) => e.status === "pending").length;
  const unitsFree = (s.ambulances || []).filter((a) => a.status === "available").length;
  const avgResp = s.kpi?.avg_resp_s != null ? Number(s.kpi.avg_resp_s) : null;
  const posOf = (a) => posRef.current.get(a.id) || project(a.lat, a.lng);

  const queue = [...active].sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || a.severity - b.severity || a.created - b.created);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: UI, color: C.text }}>
      <style>{`
        *{box-sizing:border-box}
        .s::-webkit-scrollbar{width:8px;height:8px}.s::-webkit-scrollbar-thumb{background:${C.line};border-radius:8px}
        .btn{font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:.5px;color:${C.dim};background:${C.panelHi};border:1px solid ${C.line};border-radius:6px;padding:6px 10px;cursor:pointer;transition:.12s;white-space:nowrap}
        .btn:hover{color:${C.text};border-color:${C.faint}}.btn.on{color:#08101A;border-color:currentColor}
        .btn:focus-visible{outline:2px solid ${C.cyan};outline-offset:2px}
        .row{cursor:pointer;transition:background .1s}.row:hover{background:${C.panelHi}}.row.sel{background:${C.cyan}14;box-shadow:inset 3px 0 0 ${C.cyan}}
        .blink{animation:bl 1.6s ease-in-out infinite}.dot{animation:dt 1.1s ease-in-out infinite}
        @keyframes bl{0%,100%{opacity:1}50%{opacity:.35}}@keyframes dt{0%,100%{opacity:1}50%{opacity:.3}}
        @media(prefers-reduced-motion:reduce){.blink,.dot{animation:none}}
        .grid{display:grid;grid-template-columns:1fr 340px;gap:10px}@media(max-width:920px){.grid{grid-template-columns:1fr}}
        input{font-family:${MONO};font-size:12px;background:${C.bg};border:1px solid ${C.line};border-radius:5px;color:${C.text};padding:6px 8px;width:100%}
        input:focus{outline:none;border-color:${C.cyan}}
      `}</style>

      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 16px", borderBottom: `1px solid ${C.line}`, background: C.panel, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 26, height: 26, borderRadius: 6, background: `linear-gradient(135deg,${C.p1},${C.cyan})`, display: "grid", placeItems: "center" }}>
            <svg width="15" height="15" viewBox="0 0 24 24"><path d="M13 2v6h6v4h-6v6h-4v-6H3V8h6V2z" fill="#08101A" /></svg>
          </div>
          <div style={{ lineHeight: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>LifeLink</div>
            <div style={{ fontSize: 9.5, color: C.faint, letterSpacing: 1.5, fontFamily: MONO, marginTop: 2 }}>EMERGENCY DISPATCH</div>
          </div>
          <span className={connected ? "blink" : ""} style={{ marginLeft: 6, display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 10, fontWeight: 700, color: connected ? C.p3 : C.p1 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? C.p3 : C.p1 }} />{connected ? "LIVE" : "OFFLINE"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 20, marginLeft: "auto", flexWrap: "wrap" }}>
          <Kpi label="Active cases" value={active.length} sub={waiting ? `${waiting} awaiting unit` : "all assigned"} subColor={waiting ? C.p2 : C.green} />
          <Kpi label="Units available" value={`${unitsFree}/${(s.ambulances || []).length}`} mono color={unitsFree === 0 ? C.p1 : C.text} />
          <Kpi label="Avg response" value={fmt(avgResp)} mono />
          <Kpi label="Cases closed" value={s.kpi?.closed ?? 0} mono color={C.cyan} />
        </div>
      </div>

      {/* controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: `1px solid ${C.lineSoft}`, flexWrap: "wrap" }}>
        {auth ? (
          <>
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>◉ {auth.username} <span style={{ color: C.faint }}>({auth.role})</span></span>
            <button className="btn" onClick={logout}>Log out</button>
            {auth.role === "dispatcher" && (
              <>
                <div style={{ width: 1, height: 20, background: C.line, margin: "0 4px" }} />
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.faint }}>new call severity:</span>
                {[1, 2, 3].map((n) => (
                  <button key={n} className={`btn ${sev === n ? "on" : ""}`} onClick={() => setSev(n)} style={sev === n ? { background: SEV[n].color, color: "#08101A" } : { color: SEV[n].color }}>{SEV[n].key}</button>
                ))}
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.faint }}>— click map to dispatch</span>
              </>
            )}
          </>
        ) : (
          <LoginBox onLogin={doLogin} />
        )}
      </div>

      <div className="grid" style={{ padding: 10 }}>
        {/* MAP */}
        <div style={{ background: "#080C12", border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", position: "relative" }}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", aspectRatio: `${W} / ${H}`, cursor: auth?.role === "dispatcher" ? "crosshair" : "default" }} onClick={onMapClick}>
            <defs>
              <pattern id="g1" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke={C.grid} strokeWidth="1" /></pattern>
              <pattern id="g2" width="200" height="200" patternUnits="userSpaceOnUse"><path d="M200 0H0V200" fill="none" stroke={C.gridMajor} strokeWidth="1" /></pattern>
              <radialGradient id="vig" cx="50%" cy="46%" r="75%"><stop offset="60%" stopColor="#000" stopOpacity="0" /><stop offset="100%" stopColor="#000" stopOpacity="0.5" /></radialGradient>
            </defs>
            <rect width={W} height={H} fill="url(#g1)" /><rect width={W} height={H} fill="url(#g2)" />

            {/* routes */}
            {(s.ambulances || []).map((a) => {
              let tgt = null; const em = a.assigned_emergency_id ? emById[a.assigned_emergency_id] : null;
              if (a.status === "transporting" && a.dest_hospital_id) tgt = hospPos[a.dest_hospital_id];
              else if ((a.status === "enroute" || a.status === "onscene") && em) tgt = project(em.lat, em.lng);
              if (!tgt) return null;
              const p = posOf(a); const col = a.status === "transporting" ? C.cyan : em ? SEV[em.severity].color : C.dim;
              return <line key={"r" + a.id} x1={p.x} y1={p.y} x2={tgt.x} y2={tgt.y} stroke={col} strokeWidth={2} strokeOpacity={0.5} strokeLinecap="round" strokeDasharray={a.status === "transporting" ? "7 6" : undefined} />;
            })}

            {/* hospitals */}
            {(s.hospitals || []).map((h) => {
              const p = hospPos[h.id]; const lc = loadColor(loadOf(bm, h.id)); const on = sel?.type === "hospital" && sel.id === h.id;
              return (
                <g key={h.id} transform={`translate(${p.x},${p.y})`} onClick={(e) => { e.stopPropagation(); setSel(on ? null : { type: "hospital", id: h.id }); }} style={{ cursor: "pointer" }}>
                  {on && <rect x={-20} y={-20} width={40} height={40} rx={9} fill="none" stroke={C.cyan} strokeWidth={1.5} />}
                  <rect x={-14} y={-14} width={28} height={28} rx={7} fill={C.panelHi} stroke={lc} strokeWidth={2} />
                  <path d="M2 -6v4h4v4h-4v4h-4v-4h-4v-4h4v-4z" fill={lc} transform="translate(-1,-1)" />
                  <text y={26} textAnchor="middle" fontFamily={MONO} fontSize={10} fontWeight={700} fill={C.dim}>{h.short_code}</text>
                  <text y={38} textAnchor="middle" fontFamily={MONO} fontSize={9} fill={lc}>{Math.round(loadOf(bm, h.id) * 100)}%</text>
                </g>
              );
            })}

            {/* emergencies */}
            {active.map((e) => {
              const p = project(e.lat, e.lng); const S = SEV[e.severity]; const r = e.severity === 1 ? 8 : e.severity === 2 ? 6.5 : 5.5; const on = sel?.type === "em" && sel.id === e.id;
              return (
                <g key={e.id} transform={`translate(${p.x},${p.y})`} onClick={(ev) => { ev.stopPropagation(); setSel(on ? null : { type: "em", id: e.id }); }} style={{ cursor: "pointer" }}>
                  {(e.status === "pending" || e.status === "assigned") && (
                    <circle r={r} fill="none" stroke={S.color} strokeWidth={1.6} opacity={0.7}>
                      <animate attributeName="r" from={r} to={r + 12} dur="1.5s" repeatCount="indefinite" />
                      <animate attributeName="opacity" from="0.7" to="0" dur="1.5s" repeatCount="indefinite" />
                    </circle>
                  )}
                  {on && <circle r={r + 7} fill="none" stroke={C.cyan} strokeWidth={1.5} />}
                  <circle r={r} fill={S.color} fillOpacity={0.22} stroke={S.color} strokeWidth={1.8} /><circle r={2.4} fill={S.color} />
                  {e.status === "pending" && <text y={-r - 6} textAnchor="middle" fontFamily={MONO} fontSize={9} fontWeight={700} fill={S.color}>{S.key}</text>}
                </g>
              );
            })}

            {/* ambulances */}
            {(s.ambulances || []).map((a) => {
              const p = posOf(a); const em = a.assigned_emergency_id ? emById[a.assigned_emergency_id] : null;
              let ring = AMB[a.status]?.c; if (a.status === "enroute") ring = em ? SEV[em.severity].color : C.p2;
              const on = sel?.type === "amb" && sel.id === a.id; const moving = a.status === "enroute" || a.status === "transporting";
              return (
                <g key={a.id} transform={`translate(${p.x},${p.y})`} onClick={(e) => { e.stopPropagation(); setSel(on ? null : { type: "amb", id: a.id }); }} style={{ cursor: "pointer" }}>
                  {on && <circle r={16} fill="none" stroke={C.cyan} strokeWidth={1.5} />}
                  <rect x={-10} y={-7} width={20} height={14} rx={3} fill={C.panelHi} stroke={ring || C.faint} strokeWidth={2} />
                  <rect x={-7} y={-4.5} width={5} height={9} rx={1} fill={ring || C.faint} fillOpacity={0.9} />
                  {moving && <circle cx={0} cy={-10} r={2.6} fill={a.status === "transporting" ? C.cyan : ring} className="dot" />}
                  <text y={20} textAnchor="middle" fontFamily={MONO} fontSize={8.5} fontWeight={700} fill={C.faint}>{a.callsign.replace("AMB-", "")}</text>
                </g>
              );
            })}
            <rect width={W} height={H} fill="url(#vig)" pointerEvents="none" />
          </svg>

          <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 12, background: "#0A0E14CC", border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 10px" }}>
            {Object.values(SEV).map((x) => (<span key={x.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 10, color: C.dim }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: x.color }} />{x.key} {x.label}</span>))}
          </div>
          {!connected && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "#0A0E14CC", fontFamily: MONO, fontSize: 13, color: C.faint }}>connecting to dispatch API…</div>}
        </div>

        {/* right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Panel title="Dispatch queue" right={<Badge color={waiting ? C.p2 : C.faint}>{queue.length} active</Badge>} style={{ flex: "1 1 0", minHeight: 180 }}>
            {queue.length === 0 && <Empty text={auth?.role === "dispatcher" ? "No active emergencies. Click the map to log one." : "No active emergencies."} />}
            {queue.map((e) => {
              const a = e.assigned_ambulance_id ? (s.ambulances || []).find((x) => x.id === e.assigned_ambulance_id) : null; const on = sel?.type === "em" && sel.id === e.id;
              const st = e.status === "pending" ? "AWAITING UNIT" : e.status === "assigned" ? "EN ROUTE" : e.status === "onscene" ? "ON SCENE" : "TRANSPORTING";
              const stC = e.status === "pending" ? C.p2 : e.status === "transported" ? C.cyan : C.dim;
              return (
                <div key={e.id} className={`row ${on ? "sel" : ""}`} onClick={() => setSel(on ? null : { type: "em", id: e.id })} style={{ padding: "9px 12px", borderBottom: `1px solid ${C.lineSoft}`, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Badge color={SEV[e.severity].color} solid={e.severity === 1}>{SEV[e.severity].key}</Badge>
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.type}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: e.status === "pending" ? C.p2 : C.dim }}>{fmt(now - e.created)}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, fontFamily: MONO, fontSize: 10.5 }}>
                    <span className={e.status === "pending" ? "blink" : ""} style={{ color: stC, fontWeight: 700 }}>{st}</span>
                    {a && <span style={{ color: C.faint }}>· {a.callsign}</span>}
                  </div>
                </div>
              );
            })}
          </Panel>

          <Panel title="Fleet status" right={<Badge color={unitsFree ? C.green : C.p1}>{unitsFree} free</Badge>} style={{ flex: "1 1 0", minHeight: 150 }}>
            {(s.ambulances || []).map((a) => {
              const meta = AMB[a.status] || {}; const em = a.assigned_emergency_id ? emById[a.assigned_emergency_id] : null; const hosp = a.dest_hospital_id ? (s.hospitals || []).find((h) => h.id === a.dest_hospital_id) : null;
              const c = meta.c || (em ? SEV[em.severity].color : C.p2); const on = sel?.type === "amb" && sel.id === a.id;
              let task = "Standing by";
              if (a.status === "enroute" && em) task = `→ ${SEV[em.severity].key} ${em.type}`;
              else if (a.status === "onscene" && em) task = `Loading · ${em.type}`;
              else if (a.status === "transporting" && hosp) task = `→ ${hosp.short_code}`;
              return (
                <div key={a.id} className={`row ${on ? "sel" : ""}`} onClick={() => setSel(on ? null : { type: "amb", id: a.id })} style={{ padding: "8px 12px", borderBottom: `1px solid ${C.lineSoft}`, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: c, flexShrink: 0 }} className={a.status !== "available" ? "dot" : ""} />
                  <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 700, width: 58 }}>{a.callsign}</span>
                  <span style={{ fontSize: 11.5, color: C.dim, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: c }}>{meta.t}</span>
                </div>
              );
            })}
          </Panel>

          <Panel title="Activity" style={{ flex: "0 0 auto", maxHeight: 150 }} bodyStyle={{ padding: "4px 0" }}>
            {log.length === 0 && <Empty text="Waiting for dispatch activity…" />}
            {log.slice(0, 7).map((l, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 12px", fontFamily: MONO, fontSize: 10.5 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: SEV[l.sev]?.color || C.faint, flexShrink: 0 }} />
                <span style={{ color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.msg}</span>
              </div>
            ))}
          </Panel>
        </div>
      </div>

      {/* hospital capacity */}
      <div style={{ display: "flex", gap: 10, padding: "0 10px 16px", flexWrap: "wrap" }}>
        {(s.hospitals || []).map((h) => {
          const lc = loadColor(loadOf(bm, h.id)); const on = sel?.type === "hospital" && sel.id === h.id; const t = bm[h.id] || {};
          const tiers = [["ICU", t.icu, C.p1], ["ER", t.er, C.p2], ["Ward", t.ward, C.p3]];
          return (
            <div key={h.id} onClick={() => setSel(on ? null : { type: "hospital", id: h.id })} style={{ flex: "1 1 180px", background: C.panel, border: `1px solid ${on ? C.cyan : C.line}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{h.name}</span><Badge color={lc}>{Math.round(loadOf(bm, h.id) * 100)}%</Badge>
              </div>
              {tiers.map(([name, cell, col]) => { const [occ, tot] = cell || [0, 0]; const over = occ > tot; return (
                <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.faint, width: 32 }}>{name}</span>
                  <div style={{ flex: 1, height: 5, background: C.lineSoft, borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${tot ? Math.min(100, (occ / tot) * 100) : 0}%`, height: "100%", background: over ? C.p1 : col, borderRadius: 3 }} /></div>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: over ? C.p1 : C.dim, width: 40, textAlign: "right" }}>{occ}/{tot}</span>
                </div>); })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LoginBox({ onLogin }) {
  const [u, setU] = useState("dispatch"); const [p, setP] = useState("dispatch123"); const [err, setErr] = useState("");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.faint }}>dispatcher login:</span>
      <div style={{ width: 130 }}><input value={u} onChange={(e) => setU(e.target.value)} placeholder="username" /></div>
      <div style={{ width: 130 }}><input type="password" value={p} onChange={(e) => setP(e.target.value)} placeholder="password" onKeyDown={(e) => e.key === "Enter" && onLogin(u, p, setErr)} /></div>
      <button className="btn" onClick={() => onLogin(u, p, setErr)}>Sign in</button>
      {err && <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.p1 }}>{err}</span>}
    </div>
  );
}
function Kpi({ label, value, sub, subColor, mono, color }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 74 }}>
      <span style={{ fontSize: 9.5, letterSpacing: 1, color: C.faint, textTransform: "uppercase", fontWeight: 700 }}>{label}</span>
      <span style={{ fontFamily: mono ? MONO : UI, fontSize: 19, fontWeight: 800, color: color || C.text, lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontFamily: MONO, fontSize: 9, color: subColor || C.faint }}>{sub}</span>}
    </div>
  );
}
function Panel({ title, right, children, style, bodyStyle }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, display: "flex", flexDirection: "column", minHeight: 0, ...style }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${C.lineSoft}` }}>
        <span style={{ fontFamily: UI, fontSize: 11, fontWeight: 700, letterSpacing: 1.4, color: C.dim, textTransform: "uppercase" }}>{title}</span>{right}
      </div>
      <div className="s" style={{ overflowY: "auto", minHeight: 0, ...bodyStyle }}>{children}</div>
    </div>
  );
}
function Badge({ color, children, solid }) {
  return <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, padding: "2px 6px", borderRadius: 4, color: solid ? "#08101A" : color, background: solid ? color : color + "22", border: `1px solid ${color}${solid ? "" : "44"}`, whiteSpace: "nowrap" }}>{children}</span>;
}
function Empty({ text }) { return <div style={{ padding: "24px 16px", textAlign: "center", color: C.faint, fontSize: 12 }}>{text}</div>; }
