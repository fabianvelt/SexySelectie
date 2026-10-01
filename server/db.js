const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  birthdate     TEXT NOT NULL,
  gender        TEXT NOT NULL CHECK (gender IN ('man', 'woman', 'nonbinary')),
  interested_in TEXT NOT NULL CHECK (interested_in IN ('men', 'women', 'everyone')),
  bio           TEXT NOT NULL DEFAULT '',
  photo         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  venue     TEXT NOT NULL,
  city      TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at   TEXT NOT NULL
);

-- Eén rij per gescand ticket. We bewaren alleen een hash van de ticketcode,
-- zodat een gelekte database geen bruikbare tickets bevat.
CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  event_id   TEXT NOT NULL REFERENCES events(id),
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS tickets_event ON tickets(event_id);

CREATE TABLE IF NOT EXISTS swipes (
  swiper_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  liked      INTEGER NOT NULL CHECK (liked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (swiper_id, target_id)
);

-- user_a is altijd de kleinste id, zodat elk paar maar één match kan hebben.
CREATE TABLE IF NOT EXISTS matches (
  id         INTEGER PRIMARY KEY,
  user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS messages_match ON messages(match_id, id);
`;

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
