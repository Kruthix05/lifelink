import bcrypt from "bcryptjs";
import { q, pool } from "../src/db.js";

// Sample accounts — change these before any real deployment.
const users = [
  { username: "dispatch",  password: "dispatch123", role: "dispatcher" },
  { username: "driver1",   password: "driver123",   role: "driver",         ambulance_id: 1 },
  { username: "hospadmin", password: "hosp123",     role: "hospital_admin", hospital_id: 1 },
];

for (const u of users) {
  const hash = await bcrypt.hash(u.password, 10);
  await q(
    `INSERT INTO users (username, password_hash, role, ambulance_id, hospital_id)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role=VALUES(role)`,
    [u.username, hash, u.role, u.ambulance_id || null, u.hospital_id || null]
  );
  console.log(`seeded ${u.role.padEnd(15)} ${u.username} / ${u.password}`);
}

await pool.end();
console.log("done.");
