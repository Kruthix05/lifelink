# LifeLink — Backend (Node/Express + MySQL + Socket.IO)

Emergency medical dispatch API. Nearest-unit dispatch over MySQL spatial
queries, live board over WebSockets, JWT auth with roles, deployable on AWS.

```
Browser (React)  ──REST + WebSocket──►  Express + Socket.IO  ──mysql2──►  MySQL 8
```

---

## 1. Run locally

**Prereqs:** Node 18+, MySQL 8.0+.

```bash
# install
npm install

# configure
cp .env.example .env          # edit DB_* and JWT_SECRET

# create schema + reference data (hospitals, beds, ambulances)
mysql -u root -p < db/schema.sql

# create login accounts (bcrypt-hashed)
npm run seed

# start (SIMULATE=true makes ambulances move on their own)
npm start
```

API is on `http://localhost:4000`.

**Sample logins** (from `db/seed.js`):

| Role | Username | Password |
|---|---|---|
| Dispatcher | `dispatch` | `dispatch123` |
| Driver | `driver1` | `driver123` |
| Hospital admin | `hospadmin` | `hosp123` |

**Quick test:**
```bash
# login → get a token
curl -s localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"dispatch","password":"dispatch123"}'

# log an emergency (paste the token)
curl -s localhost:4000/api/emergencies \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"severity":1,"type":"Cardiac arrest","lat":11.02,"lng":76.97}'
```

---

## 2. API summary

| Method | Route | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | public | Get a JWT |
| GET | `/api/state` | any | Full board snapshot + KPIs |
| POST | `/api/emergencies` | dispatcher | Log a new emergency |
| POST | `/api/ambulances/:id/location` | driver | Push GPS position |
| POST | `/api/ambulances/:id/status` | driver | Report status change |
| GET | `/api/health` | public | Health check (for load balancer) |

**WebSocket:** connect via Socket.IO → receive `state` (full board, pushed on
every change) and `event` (activity-feed lines).

---

## 3. The dispatch algorithm (know this for interviews)

**Assignment** (`assignPending`): pull pending emergencies ordered by severity
then age; for each, run a spatial query for the nearest `available` ambulance
and lock it to that call. Greedy nearest-neighbour — O(pending × 1 query).

```sql
SELECT id, ST_Distance_Sphere(location, ST_SRID(POINT(?, ?), 0)) AS dist_m
FROM ambulances WHERE status='available' ORDER BY dist_m ASC LIMIT 1;
```

**Hospital selection** (`chooseHospital`): nearest facility that has a free bed
in the required tier (P1→ICU, P2→ER, P3→Ward); if all are full the patient is
diverted to the nearest anyway.

**Why greedy, not optimal?** Optimal assignment (Hungarian algorithm) is O(n³);
dispatch must be sub-second, so real EMS uses greedy + coverage/redeployment on
top. Knowing that trade-off *is* the interview answer.

---

## 4. Deploy on AWS

Target topology (all free-tier eligible for ~12 months at low usage):

```
                    ┌──────────────┐
 Browser ──────────►│  CloudFront  │  HTTPS + CDN
   (static)         └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  S3 bucket   │  React build (dist/)
                    └──────────────┘

 Browser ─────────► ┌───────────────────────────┐
 (API + WebSocket)  │  Elastic Beanstalk (Node) │  Express + Socket.IO
                    └──────────┬────────────────┘
                               │ mysql2 (3306, private)
                    ┌──────────▼────────────────┐
                    │  Amazon RDS for MySQL 8    │  db.t3.micro
                    └───────────────────────────┘
```

### 4a. Database — Amazon RDS for MySQL
1. RDS → Create database → MySQL 8.0 → **Free tier** → `db.t3.micro`.
2. Set master username/password. Note the **endpoint**.
3. Security group: allow inbound `3306` **only** from the backend's security
   group (not `0.0.0.0/0`).
4. Load schema + seed from your machine (or a bastion):
   ```bash
   mysql -h <rds-endpoint> -u admin -p < db/schema.sql
   DB_HOST=<rds-endpoint> DB_USER=admin DB_PASSWORD=... DB_NAME=lifelink npm run seed
   ```

### 4b. Backend — Elastic Beanstalk (managed Node)
1. Install the EB CLI, then in this folder:
   ```bash
   eb init          # platform: Node.js; pick your region
   eb create lifelink-api
   ```
2. Set environment variables (EB console → Configuration → Software, or
   `eb setenv`):
   ```
   DB_HOST=<rds-endpoint>  DB_USER=admin  DB_PASSWORD=...  DB_NAME=lifelink
   JWT_SECRET=<long-random>  SIMULATE=true  CORS_ORIGIN=https://<your-cloudfront-domain>
   ```
3. `eb deploy`. EB gives you a URL — that's your API host.
4. **Socket.IO gotcha:** if you scale beyond 1 instance, enable **session
   stickiness** on the load balancer (or add the Redis adapter). Single instance
   needs nothing. Mention this in your viva — it shows you understand
   stateful connections behind a load balancer.

> Simpler alternative (more manual, but you control every layer):
> EC2 `t3.micro` → install Node → `git clone` → `npm ci` → run with `pm2` →
> put **nginx** in front as a reverse proxy → **certbot** for HTTPS.

### 4c. Frontend — S3 + CloudFront
1. In the React app set the API + socket base URL to the EB backend URL, then
   `npm run build`.
2. Upload `dist/` to an S3 bucket (static website hosting).
3. Create a CloudFront distribution with the S3 bucket as origin; set default
   root object to `index.html`; attach an **ACM** certificate for HTTPS.
4. Put the CloudFront domain into the backend's `CORS_ORIGIN` and redeploy.

### 4d. Security checklist (say these out loud in the interview)
- RDS is **private** — reachable only from the backend SG, never the internet.
- Secrets live in EB env vars / **SSM Parameter Store**, never in the repo.
- CORS is locked to the CloudFront origin, not `*`.
- Passwords are **bcrypt**-hashed; auth is short-lived **JWT**.
- HTTPS end-to-end (CloudFront + ALB).

---

## 5. Honest scope note

This is a **3-tier cloud application**, not microservices — and that is the
right choice for this project. Describe it accurately:

> "React on S3/CloudFront, a Node/Express API on Elastic Beanstalk, MySQL on
> RDS, real-time updates over Socket.IO, JWT auth with role-based access, and
> MySQL spatial indexing for nearest-unit dispatch."

That sentence is true, buildable by one person, and survives follow-up
questions — which is exactly what wins a placement. Only claim "microservices"
if you actually split the dispatch, intake, and notification services into
separate deployables behind an API Gateway/ALB.
