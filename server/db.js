const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

-- Geblokkeerde mensen zien elkaar nergens meer terug, in beide richtingen.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Meldingen blijven bewaard als de melder het account verwijdert,
-- zodat moderatie ze nog kan afhandelen.
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  handled_at  TEXT
);

-- Apparaten die pushmeldingen willen ontvangen. Voor web is token het
-- PushSubscription-object als JSON, voor fcm/apns het apparaattoken.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('web', 'fcm', 'apns')),
  token      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, token)
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);

-- Eenmalige codes om je e-mailadres te bevestigen of je wachtwoord opnieuw in
-- te stellen. Elke code werkt ook als link (link_hash). Per gebruiker en doel
-- is er maximaal één geldig.
CREATE TABLE IF NOT EXISTS email_codes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  code_hash  TEXT NOT NULL,
  link_hash  TEXT NOT NULL UNIQUE,
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, purpose)
);

-- Profielfoto's (max. 6 per gebruiker; position 0 is de hoofdfoto). Het id is
-- willekeurig, zodat niemand door de foto's van anderen kan bladeren.
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS photos_user ON photos(user_id, position);

-- Line-up per evenement, en welke acts iemand wil zien.
CREATE TABLE IF NOT EXISTS acts (
  id       INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  UNIQUE (event_id, name)
);
CREATE TABLE IF NOT EXISTS user_acts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  act_id  INTEGER NOT NULL REFERENCES acts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, act_id)
);
CREATE INDEX IF NOT EXISTS user_acts_act ON user_acts(act_id);
`;

const newPhotoId = () => crypto.randomBytes(12).toString('base64url');

// Zet een foto (als data-URL) in de photos-tabel. Geeft het id terug.
function insertPhoto(db, userId, dataUrl, position) {
  const [, mime, base64] = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.*)$/s) || [];
  if (!mime) return null;
  const id = newPhotoId();
  db.prepare('INSERT INTO photos (id, user_id, position, mime, data) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, position, mime, Buffer.from(base64, 'base64'));
  return id;
}

// Kolommen die later zijn toegevoegd. CREATE TABLE IF NOT EXISTS voegt ze niet
// toe aan een bestaande database, dus dat doen we hier.
function migrate(db) {
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
    // Accounts van vóór e-mailbevestiging niet ineens blokkeren.
    db.exec('UPDATE users SET email_verified_at = created_at');
  }
  // Vroeger stond er één foto als data-URL in users.photo; die verhuist naar photos.
  for (const u of db.prepare('SELECT id, photo FROM users WHERE photo IS NOT NULL').all()) {
    const has = db.prepare('SELECT 1 FROM photos WHERE user_id = ?').get(u.id);
    if (!has) insertPhoto(db, u.id, u.photo, 0);
    db.prepare('UPDATE users SET photo = NULL WHERE id = ?').run(u.id);
  }
}

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDb, insertPhoto };
