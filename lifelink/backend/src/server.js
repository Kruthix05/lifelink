import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { q } from "./db.js";
import { signToken, authRequired, requireRole } from "./auth.js";
import { assignPending, simulateTick } from "./dispatch.js";

dotenv.config();

const app = express();
const origins = (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim());
app.use(cors({ origin: origins }));
app.use(express.json());

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const user = (await q(`SELECT * FROM users WHERE username=?`, [username]))[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(password || "", user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: signToken(user), role: user.role, username: user.username });
});

// ---------------------------------------------------------------------
// Read the live board (any authenticated role)
// ---------------------------------------------------------------------
app.get("/api/state", authRequired, async (_req, res) => res.json(await snapshot()));

// ---------------------------------------------------------------------
// Dispatcher: log a new emergency (auto-assigned by the engine)
// ---------------------------------------------------------------------
app.post("/api/emergencies", authRequired, requireRole("dispatcher"), async (req, res) => {
  const { severity, type, lat, lng } = req.body || {};
  if (![1, 2, 3].includes(Number(severity)) || lat == null || lng == null) {
    return res.status(400).json({ error: "severity (1-3), lat and lng are required" });
  }
  const r = await q(`INSERT INTO emergencies (severity, type, lat, lng) VALUES (?,?,?,?)`, [
    Number(severity), type || "Unspecified", lat, lng,
  ]);
  await broadcast();
  res.status(201).json({ id: r.insertId });
});

// ---------------------------------------------------------------------
// Driver: push GPS position (the real-time source in production)
// ---------------------------------------------------------------------
app.post("/api/ambulances/:id/location", authRequired, requireRole("driver"), async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: "lat and lng required" });
  await q(`UPDATE ambulances SET lat=?, lng=? WHERE id=?`, [lat, lng, req.params.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Driver: report a status transition (arrived on scene, cleared, etc.)
// ---------------------------------------------------------------------
app.post("/api/ambulances/:id/status", authRequired, requireRole("driver"), async (req, res) => {
  const allowed = ["enroute", "onscene", "transporting", "available", "offline"];
  const { status } = req.body || {};
  if (!allowed.includes(status)) return res.status(400).json({ error: "invalid status" });
  await q(`UPDATE ambulances SET status=? WHERE id=?`, [status, req.params.id]);
  await broadcast();
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------------------------------------------------------------------
// Snapshot of the whole board + KPIs, sent over REST and Socket.IO
// ---------------------------------------------------------------------
async function snapshot() {
  const [ambulances, emergencies, hospitals, beds, kpiRows] = await Promise.all([
    q(`SELECT id, callsign, lat, lng, status, assigned_emergency_id, dest_hospital_id FROM ambulances`),
    q(`SELECT id, severity, type, lat, lng, status, assigned_ambulance_id, dest_hospital_id,
              UNIX_TIMESTAMP(created_at)  AS created,
              UNIX_TIMESTAMP(on_scene_at) AS on_scene
         FROM emergencies
        WHERE status <> 'resolved' OR resolved_at > (NOW() - INTERVAL 20 SECOND)`),
    q(`SELECT id, name, short_code, lat, lng FROM hospitals`),
    q(`SELECT hospital_id, tier, occupied, total FROM hospital_beds`),
    q(`SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, on_scene_at)) AS avg_resp_s,
              (SELECT COUNT(*) FROM emergencies WHERE status='resolved') AS closed,
              (SELECT COUNT(*) FROM ambulances WHERE status='available')  AS units_free
         FROM emergencies WHERE on_scene_at IS NOT NULL`),
  ]);
  return { ambulances, emergencies, hospitals, beds, kpi: kpiRows[0] || {}, ts: Date.now() };
}

// ---------------------------------------------------------------------
// Server + realtime
// ---------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: origins } });

io.on("connection", async (socket) => {
  socket.emit("state", await snapshot()); // send current board on connect
});

async function broadcast() {
  io.emit("state", await snapshot());
}

// Dispatch engine — assign queued emergencies to the nearest free unit.
setInterval(async () => {
  try {
    if (await assignPending(io)) await broadcast();
  } catch (e) {
    console.error("assign error:", e.message);
  }
}, 1500);

// Optional demo simulation — moves units when no real driver apps exist.
if (String(process.env.SIMULATE).toLowerCase() === "true") {
  let last = Date.now();
  setInterval(async () => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    try {
      await simulateTick(io, dt);
      await broadcast();
    } catch (e) {
      console.error("sim error:", e.message);
    }
  }, 500);
}

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () =>
  console.log(`LifeLink API listening on :${PORT}  (simulate=${process.env.SIMULATE})`)
);
