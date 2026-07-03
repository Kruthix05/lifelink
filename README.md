# LifeLink — Emergency Medical Ride & Dispatch System

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8-4479A1?logo=mysql&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?logo=socketdotio&logoColor=white)
![AWS](https://img.shields.io/badge/Deploys%20on-AWS-FF9900?logo=amazonaws&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

A cloud-deployable emergency medical dispatch platform. It logs emergencies,
assigns the **nearest available ambulance** using MySQL spatial queries, routes
each patient to a hospital with a free bed of the right type, and streams the
entire operations board to dispatchers **live over WebSockets**.

> **In one line:** a 3-tier emergency dispatch system — React console, a
> Node/Express backend with a nearest-unit dispatch engine over MySQL spatial
> indexing, and a real-time operations board via Socket.IO.

<!-- Add a screenshot here to make the repo shine:
     put an image at docs/screenshot.png and it will render below. -->
<!-- ![LifeLink dispatch console](docs/screenshot.png) -->

---

## The problem

Traditional hospital and ambulance systems suffer from slow response times and
poor coordination — a human manually decides which ambulance to send, with no
live view of unit availability or hospital capacity. LifeLink automates the two
decisions that decide whether a patient lives: **which ambulance goes**, and
**which hospital receives them** — computed geographically in milliseconds, with
the whole picture visible to the dispatcher in real time.

The single metric the system optimizes is **response time** — the gap between a
call arriving and an ambulance reaching the scene.

---

## Key features

- **Real-time operations board** — map, dispatch queue, fleet status, KPIs, and
  hospital capacity update live with no page refresh.
- **Nearest-unit dispatch** — the closest available ambulance is found with a
  MySQL spatial query (`ST_Distance_Sphere`), not a naive loop.
- **Clinical triage** — every call is P1 (Critical), P2 (Urgent) or P3 (Stable),
  which drives both dispatch priority and the destination hospital tier.
- **Hospital capacity management** — patients are routed to the nearest hospital
  with a free bed in the required tier (ICU / ER / Ward); when full, they are
  diverted, exactly as an overloaded real system behaves.
- **Live KPIs** — average response time, unit availability, active cases, and
  cases closed, computed directly in SQL.
- **Role-based access** — JWT auth for dispatchers, drivers, and hospital admins.
- **Runs anywhere** — identical code runs on a laptop or on AWS; only environment
  variables change (12-factor config).

---

## Architecture

```
┌─────────────────────┐        WebSocket (live board)       ┌──────────────────────┐
│  FRONTEND            │  ◄──────────────────────────────►  │  BACKEND             │
│  React + Vite        │        REST (login, log call)      │  Express + Socket.IO │
│  dispatch console    │  ──────────────────────────────►   │  dispatch engine     │
└─────────────────────┘                                     └──────────┬───────────┘
                                                                        │ SQL (mysql2)
                                                             ┌──────────▼───────────┐
                                                             │  MySQL 8             │
                                                             │  hospitals · beds ·  │
                                                             │  ambulances ·        │
                                                             │  emergencies · users │
                                                             └──────────────────────┘
```

**Life of one emergency:**

```
1. Dispatcher clicks the map → emergency saved to MySQL (status: pending)
2. Engine (every 1.5s) finds the nearest available ambulance → assigns it
3. Unit drives to scene → arrives → response time recorded (on_scene_at)
4. Engine picks nearest hospital with a free bed in the right tier
5. Unit transports → handover → bed occupied, case closed, unit freed
```

The emergency and ambulance state machines run in lockstep:

```
Emergency:  pending → assigned → onscene → transported → resolved
Ambulance:  available → enroute → onscene → transporting → available
```

Every state change is pushed to all connected consoles over Socket.IO.

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | React + Vite | Component UI, efficient re-rendering for a live dashboard |
| Backend | Node.js + Express | One language across the stack; lightweight REST + WebSocket |
| Database | MySQL 8 | Relational integrity + **spatial functions** for geo-queries |
| Real-time | Socket.IO | Server-push updates instead of wasteful polling |
| Auth | JWT + bcrypt | Stateless auth; hashed passwords; role-based access |
| Deployment | AWS (RDS · Elastic Beanstalk · S3/CloudFront) | Managed, scalable cloud hosting |

---

## Project structure

```
lifelink/
├── backend/                 Node/Express + MySQL + Socket.IO
│   ├── db/
│   │   ├── schema.sql        tables + spatial indexes + seed data
│   │   └── seed.js           creates login users (bcrypt-hashed)
│   └── src/
│       ├── db.js             MySQL connection pool
│       ├── auth.js           JWT signing + role guards
│       ├── dispatch.js       dispatch algorithm + demo simulator
│       └── server.js         REST API + Socket.IO + engine loop
└── frontend/                Vite + React live console
    └── src/
        ├── api.js            socket + REST client
        ├── projection.js     lat/lng ↔ screen coordinates
        └── App.jsx           the dispatch console UI
```

---

## Getting started

### Prerequisites
- Node.js 18+
- MySQL 8.0+

### 1. Backend
```bash
cd backend
npm install
cp .env.example .env            # edit DB_* and JWT_SECRET
mysql -u root -p < db/schema.sql
npm run seed                    # creates login accounts
npm start                       # → http://localhost:4000
```

### 2. Frontend
```bash
cd frontend
npm install
cp .env.example .env            # VITE_API_URL=http://localhost:4000
npm run dev                     # → http://localhost:5173
```

Open **http://localhost:5173**, sign in as a dispatcher, choose a severity, and
click the map to dispatch. With `SIMULATE=true` the system also generates and
handles calls on its own.

### Default accounts

| Role | Username | Password |
|---|---|---|
| Dispatcher | `dispatch` | `dispatch123` |
| Driver | `driver1` | `driver123` |
| Hospital admin | `hospadmin` | `hosp123` |

### Environment variables

**Backend (`backend/.env`)**
```
PORT=4000
DB_HOST=localhost
DB_USER=lifelink
DB_PASSWORD=change_me
DB_NAME=lifelink
JWT_SECRET=<long-random-string>
SIMULATE=true                   # true = self-running demo; false = real GPS only
CORS_ORIGIN=http://localhost:5173
```

**Frontend (`frontend/.env`)**
```
VITE_API_URL=http://localhost:4000
```

---

## How dispatch works

Finding the nearest ambulance is a single spatial query:

```sql
SELECT id, ST_Distance_Sphere(location, ST_SRID(POINT(?, ?), 0)) AS dist_m
FROM ambulances
WHERE status = 'available'
ORDER BY dist_m ASC
LIMIT 1;
```

Emergencies are processed **most-critical-first, then oldest-first**
(`ORDER BY severity ASC, created_at ASC`), so a cardiac arrest is always
assigned before a minor injury.

Hospital selection prefers facilities that actually have a free bed, then sorts
by distance — diverting to the nearest hospital only if every bed of the needed
tier is full:

```sql
ORDER BY (occupied < total) DESC, dist_m ASC
```

---

## API reference

| Method | Route | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | Authenticate, receive a JWT |
| GET | `/api/state` | any | Full board snapshot + KPIs |
| POST | `/api/emergencies` | dispatcher | Log a new emergency |
| POST | `/api/ambulances/:id/location` | driver | Push GPS position |
| POST | `/api/ambulances/:id/status` | driver | Report a status change |
| GET | `/api/health` | public | Health check (for load balancers) |

**WebSocket (Socket.IO):** clients receive `state` (full board, pushed on every
change) and `event` (activity-feed lines).

---

## Deployment on AWS

Three services, all free-tier eligible for ~12 months at low usage:

| Piece | Service | Summary |
|---|---|---|
| Database | **Amazon RDS (MySQL 8)** | Create instance → run `schema.sql` + `npm run seed` |
| Backend | **Elastic Beanstalk** | `eb init` → `eb create` → set env vars → `eb deploy` |
| Frontend | **S3 + CloudFront** | Set `VITE_API_URL` → `npm run build` → upload `dist/` |

**No code changes are needed** — only environment variables point at RDS and the
deployed backend. The same repository runs locally and in the cloud.

**Security checklist:** RDS reachable only from the backend security group (never
`0.0.0.0/0`); secrets in environment variables, not the repo; CORS locked to the
CloudFront origin; bcrypt-hashed passwords; HTTPS end-to-end.

---

## Design notes

- **Greedy nearest-unit, not global-optimal assignment.** Optimal assignment
  (the Hungarian algorithm) is O(n³); emergency dispatch must be sub-second, so
  real systems use greedy nearest-unit plus redeployment. This project reflects
  that real-world trade-off.
- **WebSockets over polling.** The board is pushed only when state actually
  changes, rather than the client repeatedly asking for updates.
- **Dispatch decoupled from position source.** A simulator moves units in demo
  mode; in production, drivers' devices send GPS. The dispatch engine reads
  positions from the database and is agnostic to their source.
- **3-tier architecture, not microservices** — the appropriate design for this
  scope. The services could later be split (dispatch, intake, notification)
  behind an API gateway if horizontal scaling demanded it.

---

## Roadmap

- Real driver mobile app feeding live GPS (replacing the simulator)
- Road-network ETAs via a routing engine (OSRM / Mapbox) instead of straight-line
- Predictive unit positioning from historical call-density data
- Hospital-admin dashboard for live bed management
- Automated tests and CI/CD pipeline

---

## Author

Built as a full-stack engineering project demonstrating real-time systems,
geospatial querying, and cloud deployment.

## License

Released under the MIT License.
