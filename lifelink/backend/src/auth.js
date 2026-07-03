import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const EXPIRES = process.env.JWT_EXPIRES || "12h";

// Issue a signed JWT carrying the user's identity + role.
export function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      ambulance_id: user.ambulance_id,
      hospital_id: user.hospital_id,
    },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

// Reject requests without a valid Bearer token; attach req.user otherwise.
export function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Restrict a route to specific roles. Use after authRequired.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}
