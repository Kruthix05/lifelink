import { io } from "socket.io-client";

// Backend URL — set VITE_API_URL in .env for production (the AWS backend URL).
export const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

// One shared realtime connection. The server pushes `state` (full board)
// and `event` (activity-feed lines) over this socket.
export const socket = io(API, { transports: ["websocket"], reconnection: true });

export async function login(username, password) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error("Invalid credentials");
  return res.json(); // { token, role, username }
}

export async function createEmergency(token, body) {
  const res = await fetch(`${API}/api/emergencies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error || "Failed");
  return res.json();
}
