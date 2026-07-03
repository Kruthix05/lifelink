import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

// One shared connection pool for the whole app.
export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,
});

// Small helper so callers get rows directly.
export async function q(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}
