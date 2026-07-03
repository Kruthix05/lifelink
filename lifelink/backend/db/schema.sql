-- =====================================================================
-- LifeLink — MySQL 8 schema
-- Requires MySQL 8.0+ (spatial functions: ST_Distance_Sphere, POINT, SRID)
-- Run:  mysql -h <host> -u <user> -p < db/schema.sql
-- =====================================================================

CREATE DATABASE IF NOT EXISTS lifelink
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE lifelink;

DROP TABLE IF EXISTS emergencies;
DROP TABLE IF EXISTS hospital_beds;
DROP TABLE IF EXISTS ambulances;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS hospitals;

-- ---------------------------------------------------------------------
-- Hospitals. `location` is a generated POINT so we can build a SPATIAL
-- INDEX and run nearest-facility queries with ST_Distance_Sphere.
-- POINT is stored as (lng, lat) so distances come back in metres.
-- ---------------------------------------------------------------------
CREATE TABLE hospitals (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  short_code  VARCHAR(12)  NOT NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  location    POINT GENERATED ALWAYS AS (ST_SRID(POINT(lng, lat), 0)) STORED NOT NULL,
  SPATIAL INDEX idx_hospital_loc (location)
) ENGINE=InnoDB;

CREATE TABLE hospital_beds (
  hospital_id INT NOT NULL,
  tier        ENUM('icu','er','ward') NOT NULL,
  occupied    INT NOT NULL DEFAULT 0,
  total       INT NOT NULL,
  PRIMARY KEY (hospital_id, tier),
  FOREIGN KEY (hospital_id) REFERENCES hospitals(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Ambulances. Position updated by driver GPS pings (prod) or the
-- simulator (demo). Status drives the dispatch state machine.
-- ---------------------------------------------------------------------
CREATE TABLE ambulances (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  callsign              VARCHAR(20) NOT NULL UNIQUE,
  base_hospital_id      INT NULL,
  lat                   DECIMAL(9,6) NOT NULL,
  lng                   DECIMAL(9,6) NOT NULL,
  location              POINT GENERATED ALWAYS AS (ST_SRID(POINT(lng, lat), 0)) STORED NOT NULL,
  status                ENUM('available','enroute','onscene','transporting','offline')
                          NOT NULL DEFAULT 'available',
  assigned_emergency_id INT NULL,
  dest_hospital_id      INT NULL,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  SPATIAL INDEX idx_amb_loc (location),
  INDEX idx_amb_status (status),
  FOREIGN KEY (base_hospital_id) REFERENCES hospitals(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Emergencies. severity 1=P1 (Critical) 2=P2 (Urgent) 3=P3 (Stable).
-- Response time KPI = on_scene_at - created_at.
-- ---------------------------------------------------------------------
CREATE TABLE emergencies (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  severity              TINYINT NOT NULL,
  type                  VARCHAR(80) NOT NULL,
  lat                   DECIMAL(9,6) NOT NULL,
  lng                   DECIMAL(9,6) NOT NULL,
  status                ENUM('pending','assigned','onscene','transported','resolved')
                          NOT NULL DEFAULT 'pending',
  assigned_ambulance_id INT NULL,
  dest_hospital_id      INT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  on_scene_at           TIMESTAMP NULL,
  resolved_at           TIMESTAMP NULL,
  INDEX idx_em_status (status),
  INDEX idx_em_sev (severity)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- Users + roles (dispatcher / driver / hospital_admin). Passwords are
-- bcrypt-hashed by db/seed.js — never store plaintext.
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(60) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('dispatcher','driver','hospital_admin') NOT NULL,
  ambulance_id  INT NULL,
  hospital_id   INT NULL
) ENGINE=InnoDB;

-- =====================================================================
-- Seed reference data — Coimbatore area coordinates
-- =====================================================================
INSERT INTO hospitals (name, short_code, lat, lng) VALUES
  ('Metro Trauma Center', 'METRO',  11.0510, 76.9800),
  ('Central General',     'CENTRL', 11.0000, 76.9600),
  ('Riverside Medical',   'RIVER',  11.0300, 77.0200),
  ("St. Anne's",          'STANNE', 10.9880, 76.9400);

INSERT INTO hospital_beds (hospital_id, tier, occupied, total) VALUES
  (1,'icu',7,12), (1,'er',9,20), (1,'ward',22,40),
  (2,'icu',4,8),  (2,'er',8,16), (2,'ward',30,60),
  (3,'icu',3,6),  (3,'er',6,12), (3,'ward',16,30),
  (4,'icu',2,4),  (4,'er',5,10), (4,'ward',12,24);

INSERT INTO ambulances (callsign, base_hospital_id, lat, lng) VALUES
  ('AMB-01', 1, 11.0512, 76.9805),
  ('AMB-02', 1, 11.0505, 76.9795),
  ('AMB-03', 2, 11.0005, 76.9605),
  ('AMB-04', 3, 11.0305, 77.0205),
  ('AMB-05', 4, 10.9885, 76.9405),
  ('AMB-06', 2, 10.9995, 76.9595);
