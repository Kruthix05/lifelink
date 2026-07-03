import { q } from "./db.js";

// severity -> destination bed tier
const TIER = { 1: "icu", 2: "er", 3: "ward" };

const TYPES = {
  1: ["Cardiac arrest", "Major trauma (RTA)", "Stroke — FAST+", "Anaphylaxis", "Severe hemorrhage"],
  2: ["Chest pain", "Breathing difficulty", "Long-bone fracture", "Seizure", "Acute abdomen"],
  3: ["Minor laceration", "High fever", "Ankle sprain", "Non-urgent transfer", "Mild allergy"],
};

// ---------------------------------------------------------------------
// CORE: assign every pending emergency to the nearest AVAILABLE unit.
// Greedy nearest-neighbour, priority-ordered (P1 first, then oldest).
// O(pending × 1 spatial query) — fast enough for real-time dispatch.
// ---------------------------------------------------------------------
export async function assignPending(io) {
  const pending = await q(
    `SELECT id, severity, type, lat, lng FROM emergencies
      WHERE status = 'pending'
      ORDER BY severity ASC, created_at ASC`
  );
  let changed = false;

  for (const e of pending) {
    // Nearest available ambulance by great-circle distance (metres).
    const rows = await q(
      `SELECT id, callsign,
              ST_Distance_Sphere(location, ST_SRID(POINT(?, ?), 0)) AS dist_m
         FROM ambulances
        WHERE status = 'available'
        ORDER BY dist_m ASC
        LIMIT 1`,
      [e.lng, e.lat]
    );
    const amb = rows[0];
    if (!amb) break; // no free units — emergency stays queued

    await q(`UPDATE ambulances SET status='enroute', assigned_emergency_id=? WHERE id=?`, [e.id, amb.id]);
    await q(`UPDATE emergencies SET status='assigned', assigned_ambulance_id=? WHERE id=?`, [amb.id, e.id]);
    changed = true;
    io?.emit("event", { t: Date.now(), msg: `${amb.callsign} dispatched → P${e.severity} ${e.type}`, sev: e.severity });
  }
  return changed;
}

// ---------------------------------------------------------------------
// Nearest hospital WITH a free bed in the required tier.
// Hospitals with a free bed sort first; ties break on distance.
// If every hospital's tier is full, the nearest is chosen anyway
// (patient is diverted / admitted over capacity).
// ---------------------------------------------------------------------
export async function chooseHospital(severity, lat, lng) {
  const tier = TIER[severity] || "er";
  const rows = await q(
    `SELECT h.id, h.short_code, h.lat, h.lng,
            ST_Distance_Sphere(h.location, ST_SRID(POINT(?, ?), 0)) AS dist_m
       FROM hospitals h
       JOIN hospital_beds b ON b.hospital_id = h.id AND b.tier = ?
      ORDER BY (b.occupied < b.total) DESC, dist_m ASC
      LIMIT 1`,
    [lng, lat, tier]
  );
  return rows[0] ? { ...rows[0], tier } : null;
}

// =====================================================================
// DEMO SIMULATOR (only runs when SIMULATE=true).
// Replaces real driver apps: moves units along a route, drives the
// state machine, spawns emergencies, and discharges beds so the system
// stays in equilibrium. Positions persist to MySQL every tick.
// `routes` holds transient per-unit path state (rebuilt from DB if lost).
// =====================================================================
const routes = new Map(); // ambId -> { wps: [{lat,lng}], dwellMs }
let spawnAcc = 0;
let dischargeAcc = 0;

const SIM_SPEED_DEG_PER_S = 0.0009; // accelerated for a watchable demo
const SCENE_DWELL_MS = 2500;
const SPAWN_EVERY_MS = 6000;
const DISCHARGE_EVERY_MS = 4000;
const MAX_ACTIVE = 9;

// Coimbatore-ish bounds for random emergencies
const BOUNDS = { latMin: 10.955, latMax: 11.075, lngMin: 76.905, lngMax: 77.045 };

const lerp = (a, b, t) => a + (b - a) * t;
const dDeg = (a, b) => Math.hypot(a.lat - b.lat, a.lng - b.lng);

export async function simulateTick(io, dtMs) {
  const stepDeg = SIM_SPEED_DEG_PER_S * (dtMs / 1000);
  const ambs = await q(`SELECT * FROM ambulances`);

  for (const a of ambs) {
    if (a.status === "available" || a.status === "offline") { routes.delete(a.id); continue; }

    // ---- on-scene: wait, then load patient and depart to hospital ----
    if (a.status === "onscene") {
      const r = routes.get(a.id) || { wps: [], dwellMs: SCENE_DWELL_MS };
      routes.set(a.id, r);
      if (r.dwellMs > 0) { r.dwellMs -= dtMs; continue; }

      const em = (await q(`SELECT id, severity FROM emergencies WHERE id=?`, [a.assigned_emergency_id]))[0];
      if (!em) { routes.delete(a.id); await q(`UPDATE ambulances SET status='available', assigned_emergency_id=NULL WHERE id=?`, [a.id]); continue; }
      const h = await chooseHospital(em.severity, Number(a.lat), Number(a.lng));
      await q(`UPDATE ambulances SET status='transporting', dest_hospital_id=? WHERE id=?`, [h.id, a.id]);
      await q(`UPDATE emergencies SET status='transported', dest_hospital_id=? WHERE id=?`, [h.id, em.id]);
      routes.set(a.id, { wps: makePath(a, h), dwellMs: 0 });
      io?.emit("event", { t: Date.now(), msg: `${a.callsign} transporting P${em.severity} → ${h.short_code}`, sev: em.severity });
      continue;
    }

    // ---- ensure a route toward the current target exists ----
    let route = routes.get(a.id);
    if (!route || !route.wps || route.wps.length === 0) {
      let target = null;
      if (a.status === "enroute" && a.assigned_emergency_id) {
        target = (await q(`SELECT lat, lng FROM emergencies WHERE id=?`, [a.assigned_emergency_id]))[0];
      } else if (a.status === "transporting" && a.dest_hospital_id) {
        target = (await q(`SELECT lat, lng FROM hospitals WHERE id=?`, [a.dest_hospital_id]))[0];
      }
      if (!target) continue;
      route = { wps: makePath(a, target), dwellMs: 0 };
      routes.set(a.id, route);
    }

    // ---- advance position along the path ----
    let remaining = stepDeg;
    let pos = { lat: Number(a.lat), lng: Number(a.lng) };
    while (route.wps.length && remaining > 0) {
      const tgt = route.wps[0];
      const d = dDeg(pos, tgt);
      if (d <= remaining || d === 0) { pos = { lat: tgt.lat, lng: tgt.lng }; route.wps.shift(); remaining -= d; }
      else { const t = remaining / d; pos = { lat: lerp(pos.lat, tgt.lat, t), lng: lerp(pos.lng, tgt.lng, t) }; remaining = 0; }
    }
    await q(`UPDATE ambulances SET lat=?, lng=? WHERE id=?`, [pos.lat.toFixed(6), pos.lng.toFixed(6), a.id]);

    // ---- arrival transitions ----
    if (route.wps.length === 0) {
      if (a.status === "enroute") {
        await q(`UPDATE ambulances SET status='onscene' WHERE id=?`, [a.id]);
        await q(`UPDATE emergencies SET status='onscene', on_scene_at=NOW() WHERE id=? AND on_scene_at IS NULL`, [a.assigned_emergency_id]);
        routes.set(a.id, { wps: [], dwellMs: SCENE_DWELL_MS });
        const em = (await q(`SELECT severity, type FROM emergencies WHERE id=?`, [a.assigned_emergency_id]))[0];
        io?.emit("event", { t: Date.now(), msg: `${a.callsign} on scene — P${em?.severity} ${em?.type || ""}`, sev: em?.severity || 2 });
      } else if (a.status === "transporting") {
        // Handover: occupy a bed, close the case, free the unit at the hospital.
        const em = (await q(`SELECT id, severity FROM emergencies WHERE id=?`, [a.assigned_emergency_id]))[0];
        const tier = TIER[em?.severity] || "er";
        await q(`UPDATE hospital_beds SET occupied = LEAST(total, occupied + 1) WHERE hospital_id=? AND tier=?`, [a.dest_hospital_id, tier]);
        if (em) await q(`UPDATE emergencies SET status='resolved', resolved_at=NOW() WHERE id=?`, [em.id]);
        await q(`UPDATE ambulances SET status='available', assigned_emergency_id=NULL, dest_hospital_id=NULL WHERE id=?`, [a.id]);
        io?.emit("event", { t: Date.now(), msg: `${a.callsign} handover complete — case closed`, sev: 3 });
        routes.delete(a.id);
      }
    }
  }

  // ---- spawn new emergencies on a cadence ----
  spawnAcc += dtMs;
  if (spawnAcc >= SPAWN_EVERY_MS) {
    spawnAcc = 0;
    const active = (await q(`SELECT COUNT(*) n FROM emergencies WHERE status <> 'resolved'`))[0].n;
    if (active < MAX_ACTIVE) {
      const r = Math.random();
      const sev = r < 0.2 ? 1 : r < 0.55 ? 2 : 3;
      const type = TYPES[sev][Math.floor(Math.random() * TYPES[sev].length)];
      const lat = (BOUNDS.latMin + Math.random() * (BOUNDS.latMax - BOUNDS.latMin)).toFixed(6);
      const lng = (BOUNDS.lngMin + Math.random() * (BOUNDS.lngMax - BOUNDS.lngMin)).toFixed(6);
      await q(`INSERT INTO emergencies (severity, type, lat, lng) VALUES (?,?,?,?)`, [sev, type, lat, lng]);
      io?.emit("event", { t: Date.now(), msg: `NEW P${sev} — ${type}`, sev });
    }
  }

  // ---- discharge patients so hospitals don't lock up ----
  dischargeAcc += dtMs;
  if (dischargeAcc >= DISCHARGE_EVERY_MS) {
    dischargeAcc = 0;
    await q(
      `UPDATE hospital_beds
          SET occupied = GREATEST(0, occupied - 1)
        WHERE occupied > 0 AND RAND() < 0.5`
    );
  }

  return true; // positions moved — tell the server to re-broadcast
}

// L-shaped (Manhattan) path — reads like following city streets.
function makePath(from, to) {
  const f = { lat: Number(from.lat), lng: Number(from.lng) };
  const t = { lat: Number(to.lat), lng: Number(to.lng) };
  const latFirst = Math.random() < 0.5;
  const mid = latFirst ? { lat: t.lat, lng: f.lng } : { lat: f.lat, lng: t.lng };
  return [mid, t];
}
