# LifeLink — Emergency Medical Ride & Dispatch System

A cloud-deployable emergency medical dispatch platform. Logs emergencies,
assigns the **nearest available ambulance** using MySQL spatial queries,
routes patients to a hospital with a free bed, and streams the whole board to
a live operations console over WebSockets.

> Stack: **React (Vite)** · **Node/Express** · **MySQL 8** · **Socket.IO** · deploys on **AWS**

---

## What is happening (read this first)

```
┌─────────────────────┐        WebSocket (live board)       ┌──────────────────────┐
│  FRONTEND            │  ◄──────────────────────────────►  │  BACKEND             │
│  React + Vite        │        REST (login, log call)      │  Express + Socket.IO │
│  dispatch console    │  ──────────────────────────────►   │  dispatch engine     │
└─────────────────────┘                                     └──────────┬───────────┘
                                                                        │ SQL (mysql2)
                                                             ┌──────────▼───────────┐
                                                             │  MySQL 8             │
                                                             │  hospitals, beds,    │
                                                             │  ambulances,         │
                                                             │  emergencies, users  │
                                                             └──────────────────────┘
```

**The flow, step by step:**

1. A dispatcher logs in (gets a **JWT**) and clicks the map. The frontend
   converts the click to lat/lng and `POST`s a new **emergency** to the backend.
2. The backend's **dispatch engine** (runs every 1.5 s) finds all `pending`
   emergencies, and for each runs a spatial query for the **nearest available
   ambulance** (`ST_Distance_Sphere`), then locks that unit to the call.
3. The unit drives to the scene → loads the patient → the engine picks the
   **nearest hospital with a free bed** in the right tier (P1→ICU, P2→ER,
   P3→Ward) → drives there → hands over. The bed is occupied; the case closes.
4. Every state change is pushed to all connected consoles over **Socket.IO**,
   so the map, queue, fleet, KPIs, and hospital capacity update in real time.

**Two modes** (set in `backend/.env`):
- `SIMULATE=true` — the server moves ambulances itself, so you can demo with no
  driver apps. Great for screenshots and viva.
- `SIMULATE=false` — positions/status come only from real driver `POST`s. This
  is the production path.

**Key point for interviews:** dispatch is *decoupled* from the position source —
a simulator for testing, real GPS pings in production. Same engine either way.

---

## Folder structure

```
lifelink/
├── README.md                ← you are here
├── .gitignore
├── backend/                 Node/Express + MySQL + Socket.IO
│   ├── package.json
│   ├── .env.example
│   ├── db/
│   │   ├── schema.sql       tables + spatial indexes + seed data
│   │   └── seed.js          creates login users (bcrypt)
│   └── src/
│       ├── db.js            MySQL connection pool
│       ├── auth.js          JWT + role guards
│       ├── dispatch.js      the dispatch algorithm + demo simulator
│       └── server.js        REST API + Socket.IO + engine loop
└── frontend/                Vite + React live console
    ├── package.json
    ├── vite.config.js
    ├── index.html
    ├── .env.example
    └── src/
        ├── main.jsx
        ├── api.js           socket + REST client
        ├── projection.js    lat/lng ↔ screen coordinates
        └── App.jsx          the dispatch console UI
```

---

## Run locally

**Prereqs:** Node 18+, MySQL 8.0+.

**Terminal 1 — backend**
```bash
cd backend
npm install
cp .env.example .env            # edit DB_* and JWT_SECRET
mysql -u root -p < db/schema.sql
npm run seed                    # creates login accounts
npm start                       # → http://localhost:4000
```

**Terminal 2 — frontend**
```bash
cd frontend
npm install
cp .env.example .env            # VITE_API_URL=http://localhost:4000
npm run dev                     # → http://localhost:5173
```

Open **http://localhost:5173**. Sign in as `dispatch` / `dispatch123`, pick a
severity, and click the map to dispatch. With `SIMULATE=true` you'll also see
auto-generated calls flowing on their own.

**Logins** (from `backend/db/seed.js`): `dispatch`/`dispatch123`,
`driver1`/`driver123`, `hospadmin`/`hosp123`.

---

## Deploy to GitHub

```bash
cd lifelink
git init
git add .
git commit -m "LifeLink — emergency dispatch system"

# create an EMPTY repo on github.com first (no README), then:
git branch -M main
git remote add origin https://github.com/<your-username>/lifelink.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/` and `.env`. **Never commit
`.env`** — it holds your DB password and JWT secret. Commit only `.env.example`.

---

## Deploy to AWS (3 pieces)

Target: **RDS** (database) + **Elastic Beanstalk** (backend) + **S3/CloudFront**
(frontend). All free-tier eligible for ~12 months at low usage.

### Step 1 — Database on Amazon RDS
1. AWS Console → RDS → **Create database** → MySQL 8.0 → **Free tier** →
   `db.t3.micro`. Set master username/password. Copy the **endpoint**.
2. Security group: allow inbound `3306` **only** from the backend's security
   group (never `0.0.0.0/0`).
3. Load the schema and users from your machine:
   ```bash
   cd backend
   mysql -h <rds-endpoint> -u admin -p < db/schema.sql
   DB_HOST=<rds-endpoint> DB_USER=admin DB_PASSWORD=<pw> DB_NAME=lifelink npm run seed
   ```

### Step 2 — Backend on Elastic Beanstalk
1. Install the EB CLI (`pip install awsebcli`), then:
   ```bash
   cd backend
   eb init          # platform: Node.js; choose your region
   eb create lifelink-api
   ```
2. Set environment variables (`eb setenv ...` or EB Console → Configuration):
   ```
   DB_HOST=<rds-endpoint>  DB_USER=admin  DB_PASSWORD=<pw>  DB_NAME=lifelink
   JWT_SECRET=<long-random-string>  SIMULATE=true
   CORS_ORIGIN=https://<your-cloudfront-domain>
   ```
3. `eb deploy`. EB returns a URL — that's your **backend API URL**.
4. **Socket.IO note:** if you scale past 1 instance, enable **session
   stickiness** on the load balancer (single instance needs nothing). Mention
   this in your viva — it shows you understand stateful WebSocket connections.

### Step 3 — Frontend on S3 + CloudFront
1. Point the frontend at the backend and build:
   ```bash
   cd frontend
   echo "VITE_API_URL=https://<your-eb-backend-url>" > .env
   npm install && npm run build      # outputs dist/
   ```
2. Create an **S3 bucket** (static website hosting) and upload everything in
   `dist/`.
3. Create a **CloudFront** distribution with the S3 bucket as origin; set the
   default root object to `index.html`; attach an **ACM** certificate for HTTPS.
4. Put the CloudFront domain into the backend's `CORS_ORIGIN` env var and
   `eb deploy` again so the API accepts requests from it.

### Security checklist (say these out loud in interviews)
- RDS is **private** — reachable only from the backend, never the internet.
- Secrets live in EB env vars / **SSM Parameter Store**, never in the repo.
- CORS is locked to your CloudFront origin, not `*`.
- Passwords are **bcrypt**-hashed; auth is short-lived **JWT**.
- HTTPS end-to-end (CloudFront + load balancer).

---

## How to describe this project (honest version)

> "A 3-tier cloud application for emergency medical dispatch: a React console on
> S3/CloudFront, a Node/Express API on Elastic Beanstalk, and MySQL on RDS.
> Nearest-unit dispatch uses MySQL spatial indexing (`ST_Distance_Sphere`); the
> live operations board is pushed to clients over Socket.IO; auth is JWT with
> role-based access for dispatchers, drivers, and hospital admins."

Every word of that is true and buildable by one person — which is exactly what
survives follow-up questions and wins a placement. It is a **3-tier monolith**,
not microservices; only claim microservices if you actually split the services.
