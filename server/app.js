const path = require('node:path');
const express = require('express');
const { hashPassword, verifyPassword, newSessionToken, hashToken } = require('./auth');
const { verifyTicketCode, hashTicketCode } = require('./tickets');
const { Realtime } = require('./realtime');

const SESSION_COOKIE = 'ss_session';
const GENDERS = ['man', 'woman', 'nonbinary'];
const INTERESTS = ['men', 'women', 'everyone'];
const MAX_PHOTO_BYTES = 400 * 1024;
const REPORT_REASONS = ['fake', 'inappropriate', 'harassment', 'underage', 'other'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ageFrom(birthdate, now = new Date()) {
  const b = new Date(`${birthdate}T00:00:00Z`);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

// Valt iemand met `gender` binnen de voorkeur `interest`?
function fitsInterest(interest, gender) {
  if (interest === 'everyone') return true;
  return (interest === 'men' && gender === 'man') || (interest === 'women' && gender === 'woman');
}

function publicUser(u) {
  return { id: u.id, name: u.name, age: ageFrom(u.birthdate), gender: u.gender, bio: u.bio, photo: u.photo };
}

function privateUser(u) {
  return { ...publicUser(u), email: u.email, birthdate: u.birthdate, interestedIn: u.interested_in };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function str(value, field, { min = 0, max = 200 } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} ontbreekt`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw new HttpError(400, `${field} moet tussen ${min} en ${max} tekens zijn`);
  return v;
}

function validateProfile(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = str(body.name, 'Naam', { min: 1, max: 40 });
  if (!partial || body.bio !== undefined) out.bio = str(body.bio ?? '', 'Bio', { max: 300 });
  if (!partial || body.gender !== undefined) {
    if (!GENDERS.includes(body.gender)) throw new HttpError(400, 'Ongeldig geslacht');
    out.gender = body.gender;
  }
  if (!partial || body.interestedIn !== undefined) {
    if (!INTERESTS.includes(body.interestedIn)) throw new HttpError(400, 'Ongeldige voorkeur');
    out.interested_in = body.interestedIn;
  }
  if (body.photo !== undefined && body.photo !== null) {
    if (typeof body.photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(body.photo)) {
      throw new HttpError(400, 'Foto moet een JPEG, PNG of WebP zijn');
    }
    if (body.photo.length > MAX_PHOTO_BYTES * 1.37) throw new HttpError(400, 'Foto is te groot');
    out.photo = body.photo;
  } else if (body.photo === null) {
    out.photo = null;
  }
  return out;
}

function createApp({ db, ticketSecret, secureCookies = false }) {
  if (!ticketSecret) throw new Error('ticketSecret is verplicht');

  const app = express();
  const realtime = new Realtime();
  app.locals.realtime = realtime;

  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.send('ok'));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, file) {
      // De service worker moet altijd vers opgehaald worden, anders blijven updates hangen.
      if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  const q = (sql) => db.prepare(sql);

  function startSession(res, userId) {
    const token = newSessionToken();
    q('INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)').run(hashToken(token), userId);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: 1000 * 60 * 60 * 24 * 30,
      path: '/',
    });
  }

  function requireUser(req, res, next) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token &&
      q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hashToken(token));
    if (!user) return next(new HttpError(401, 'Niet ingelogd'));
    req.user = user;
    req.sessionTokenHash = hashToken(token);
    next();
  }

  // Events waarvoor de gebruiker een ticket heeft en die nog niet voorbij zijn.
  function activeEventIds(userId) {
    return q(`SELECT DISTINCT t.event_id AS id FROM tickets t JOIN events e ON e.id = t.event_id
              WHERE t.user_id = ? AND e.ends_at > ?`)
      .all(userId, new Date().toISOString())
      .map((r) => r.id);
  }

  function sharedEvents(userId, otherId) {
    return q(`SELECT DISTINCT e.id, e.name, e.starts_at AS startsAt FROM tickets a
              JOIN tickets b ON b.event_id = a.event_id AND b.user_id = ?
              JOIN events e ON e.id = a.event_id
              WHERE a.user_id = ? AND e.ends_at > ? ORDER BY e.starts_at`)
      .all(otherId, userId, new Date().toISOString());
  }

  function isBlocked(a, b) {
    return !!q('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
      .get(a, b, b, a);
  }

  function deleteMatchBetween(a, b) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const m = q('SELECT id FROM matches WHERE user_a = ? AND user_b = ?').get(lo, hi);
    if (!m) return;
    q('DELETE FROM matches WHERE id = ?').run(m.id);
    realtime.send(a, 'unmatch', { id: m.id });
    realtime.send(b, 'unmatch', { id: m.id });
  }

  function getMatchFor(matchId, userId) {
    const m = q('SELECT * FROM matches WHERE id = ? AND (user_a = ? OR user_b = ?)').get(matchId, userId, userId);
    if (!m) throw new HttpError(404, 'Match niet gevonden');
    m.otherId = m.user_a === userId ? m.user_b : m.user_a;
    return m;
  }

  function messageJson(m) {
    return { id: m.id, matchId: m.match_id, senderId: m.sender_id, body: m.body, createdAt: m.created_at };
  }

  // ---------- Account ----------

  app.post('/api/register', (req, res) => {
    const email = str(req.body.email, 'E-mail', { min: 3, max: 200 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Ongeldig e-mailadres');
    const password = str(req.body.password, 'Wachtwoord', { min: 8, max: 200 });
    const birthdate = str(req.body.birthdate, 'Geboortedatum', { min: 10, max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate) || Number.isNaN(Date.parse(birthdate))) {
      throw new HttpError(400, 'Ongeldige geboortedatum');
    }
    if (ageFrom(birthdate) < 18) throw new HttpError(400, 'Je moet 18 jaar of ouder zijn');
    const profile = validateProfile(req.body);

    if (q('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'Er bestaat al een account met dit e-mailadres');
    }
    const { lastInsertRowid } = q(`INSERT INTO users (email, password_hash, name, birthdate, gender, interested_in, bio, photo)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(email, hashPassword(password), profile.name, birthdate, profile.gender, profile.interested_in,
        profile.bio, profile.photo ?? null);
    const user = q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    startSession(res, user.id);
    res.status(201).json({ user: privateUser(user) });
  });

  app.post('/api/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = q('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'E-mail of wachtwoord klopt niet');
    }
    startSession(res, user.id);
    res.json({ user: privateUser(user) });
  });

  app.post('/api/logout', requireUser, (req, res) => {
    q('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ user: privateUser(req.user) });
  });

  app.put('/api/me', requireUser, (req, res) => {
    const changes = validateProfile(req.body, { partial: true });
    const keys = Object.keys(changes);
    if (keys.length) {
      q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => changes[k]), req.user.id);
    }
    res.json({ user: privateUser(q('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  // ---------- Tickets ----------

  app.get('/api/tickets', requireUser, (req, res) => {
    const now = new Date().toISOString();
    const tickets = q(`SELECT t.id, t.scanned_at AS scannedAt, e.id AS eventId, e.name, e.venue, e.city,
                              e.starts_at AS startsAt, e.ends_at AS endsAt,
                              (SELECT COUNT(DISTINCT o.user_id) FROM tickets o WHERE o.event_id = e.id AND o.user_id != t.user_id) AS others
                       FROM tickets t JOIN events e ON e.id = t.event_id
                       WHERE t.user_id = ? ORDER BY e.starts_at`)
      .all(req.user.id)
      .map((t) => ({ ...t, past: t.endsAt <= now }));
    res.json({ tickets });
  });

  app.post('/api/tickets', requireUser, (req, res) => {
    const verified = verifyTicketCode(req.body.code, { secret: ticketSecret });
    if (!verified) throw new HttpError(400, 'Dit ticket herkennen we niet of het is ongeldig');

    const event = q('SELECT * FROM events WHERE id = ?').get(verified.eventId);
    if (!event) throw new HttpError(404, 'Dit evenement staat (nog) niet in SexySelectie');
    if (event.ends_at <= new Date().toISOString()) throw new HttpError(400, 'Dit evenement is al voorbij');

    const codeHash = hashTicketCode(verified.code);
    const existing = q('SELECT * FROM tickets WHERE code_hash = ?').get(codeHash);
    if (existing && existing.user_id !== req.user.id) {
      throw new HttpError(409, 'Dit ticket is al door iemand anders gescand');
    }
    if (!existing) {
      q('INSERT INTO tickets (code_hash, event_id, user_id) VALUES (?, ?, ?)').run(codeHash, event.id, req.user.id);
    }
    res.status(existing ? 200 : 201).json({
      event: { id: event.id, name: event.name, venue: event.venue, city: event.city, startsAt: event.starts_at },
    });
  });

  app.delete('/api/tickets/:id', requireUser, (req, res) => {
    const { changes } = q('DELETE FROM tickets WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    if (!changes) throw new HttpError(404, 'Ticket niet gevonden');
    res.status(204).end();
  });

  // ---------- Swipen ----------

  app.get('/api/discover', requireUser, (req, res) => {
    const me = req.user;
    let eventIds = activeEventIds(me.id);
    if (req.query.eventId) eventIds = eventIds.filter((id) => id === req.query.eventId);
    if (!eventIds.length) return res.json({ profiles: [], hasTickets: activeEventIds(me.id).length > 0 });

    const placeholders = eventIds.map(() => '?').join(',');
    const candidates = q(`SELECT u.*, COUNT(DISTINCT t.event_id) AS shared FROM users u
                          JOIN tickets t ON t.user_id = u.id AND t.event_id IN (${placeholders})
                          WHERE u.id != ?
                            AND u.id NOT IN (SELECT target_id FROM swipes WHERE swiper_id = ?)
                            AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
                            AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
                          GROUP BY u.id`)
      .all(...eventIds, me.id, me.id, me.id, me.id)
      .filter((u) => fitsInterest(me.interested_in, u.gender) && fitsInterest(u.interested_in, me.gender))
      .sort((a, b) => b.shared - a.shared || Math.random() - 0.5)
      .slice(0, 20);

    res.json({
      hasTickets: true,
      profiles: candidates.map((u) => ({ ...publicUser(u), sharedEvents: sharedEvents(me.id, u.id) })),
    });
  });

  app.post('/api/swipes', requireUser, (req, res) => {
    const me = req.user;
    const targetId = Number(req.body.targetId);
    const liked = req.body.like === true;
    const target = Number.isInteger(targetId) && targetId !== me.id && q('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) throw new HttpError(404, 'Profiel niet gevonden');
    if (isBlocked(me.id, target.id)) throw new HttpError(404, 'Profiel niet gevonden');
    if (!sharedEvents(me.id, target.id).length) {
      throw new HttpError(403, 'Je kunt alleen swipen op mensen die naar hetzelfde evenement gaan');
    }

    q(`INSERT INTO swipes (swiper_id, target_id, liked) VALUES (?, ?, ?)
       ON CONFLICT (swiper_id, target_id) DO UPDATE SET liked = excluded.liked, created_at = datetime('now')`)
      .run(me.id, target.id, liked ? 1 : 0);

    let match = null;
    const likedBack = liked && q('SELECT 1 FROM swipes WHERE swiper_id = ? AND target_id = ? AND liked = 1').get(target.id, me.id);
    if (likedBack) {
      const [a, b] = me.id < target.id ? [me.id, target.id] : [target.id, me.id];
      q('INSERT OR IGNORE INTO matches (user_a, user_b) VALUES (?, ?)').run(a, b);
      const row = q('SELECT * FROM matches WHERE user_a = ? AND user_b = ?').get(a, b);
      match = { id: row.id, user: publicUser(target), sharedEvents: sharedEvents(me.id, target.id) };
      realtime.send(target.id, 'match', { id: row.id, user: publicUser(me), sharedEvents: match.sharedEvents });
    }
    res.json({ match });
  });

  // ---------- Matches & chat ----------

  app.get('/api/matches', requireUser, (req, res) => {
    const me = req.user.id;
    const rows = q(`SELECT m.id, m.created_at, u.*,  m.id AS match_id,
                           (SELECT body FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_body,
                           (SELECT sender_id FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_sender,
                           (SELECT created_at FROM messages WHERE match_id = m.id ORDER BY id DESC LIMIT 1) AS last_at
                    FROM matches m JOIN users u ON u.id = CASE WHEN m.user_a = ? THEN m.user_b ELSE m.user_a END
                    WHERE m.user_a = ? OR m.user_b = ?`)
      .all(me, me, me);
    const matches = rows
      .map((r) => ({
        id: r.match_id,
        user: publicUser(r),
        sharedEvents: sharedEvents(me, r.id),
        lastMessage: r.last_body == null ? null : { body: r.last_body, senderId: r.last_sender, createdAt: r.last_at },
      }))
      .sort((x, y) => (y.lastMessage?.createdAt ?? '').localeCompare(x.lastMessage?.createdAt ?? '') || y.id - x.id);
    res.json({ matches });
  });

  app.get('/api/matches/:id/messages', requireUser, (req, res) => {
    const match = getMatchFor(Number(req.params.id), req.user.id);
    const other = q('SELECT * FROM users WHERE id = ?').get(match.otherId);
    const messages = q('SELECT * FROM messages WHERE match_id = ? ORDER BY id').all(match.id).map(messageJson);
    res.json({ match: { id: match.id, user: publicUser(other), sharedEvents: sharedEvents(req.user.id, other.id) }, messages });
  });

  app.post('/api/matches/:id/messages', requireUser, (req, res) => {
    const match = getMatchFor(Number(req.params.id), req.user.id);
    const body = str(req.body.body, 'Bericht', { min: 1, max: 1000 });
    const { lastInsertRowid } = q('INSERT INTO messages (match_id, sender_id, body) VALUES (?, ?, ?)')
      .run(match.id, req.user.id, body);
    const message = messageJson(q('SELECT * FROM messages WHERE id = ?').get(lastInsertRowid));
    realtime.send(match.otherId, 'message', message);
    realtime.send(req.user.id, 'message', message);
    res.status(201).json({ message });
  });

  app.delete('/api/matches/:id', requireUser, (req, res) => {
    const match = getMatchFor(Number(req.params.id), req.user.id);
    q('DELETE FROM matches WHERE id = ?').run(match.id);
    realtime.send(match.otherId, 'unmatch', { id: match.id });
    res.status(204).end();
  });

  // ---------- Veiligheid ----------

  app.post('/api/blocks', requireUser, (req, res) => {
    const targetId = Number(req.body.userId);
    if (!Number.isInteger(targetId) || targetId === req.user.id || !q('SELECT 1 FROM users WHERE id = ?').get(targetId)) {
      throw new HttpError(404, 'Profiel niet gevonden');
    }
    q('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, targetId);
    deleteMatchBetween(req.user.id, targetId);
    res.status(204).end();
  });

  // Melden blokkeert meteen ook, zodat je de ander nooit meer hoeft te zien.
  app.post('/api/reports', requireUser, (req, res) => {
    const targetId = Number(req.body.userId);
    if (!Number.isInteger(targetId) || targetId === req.user.id || !q('SELECT 1 FROM users WHERE id = ?').get(targetId)) {
      throw new HttpError(404, 'Profiel niet gevonden');
    }
    if (!REPORT_REASONS.includes(req.body.reason)) throw new HttpError(400, 'Kies een reden');
    const details = str(req.body.details ?? '', 'Toelichting', { max: 1000 });
    q('INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES (?, ?, ?, ?)')
      .run(req.user.id, targetId, req.body.reason, details);
    q('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, targetId);
    deleteMatchBetween(req.user.id, targetId);
    res.status(201).json({ ok: true });
  });

  app.delete('/api/me', requireUser, (req, res) => {
    if (!verifyPassword(String(req.body?.password || ''), req.user.password_hash)) {
      throw new HttpError(401, 'Wachtwoord klopt niet');
    }
    const me = req.user.id;
    for (const m of q('SELECT * FROM matches WHERE user_a = ? OR user_b = ?').all(me, me)) {
      realtime.send(m.user_a === me ? m.user_b : m.user_a, 'unmatch', { id: m.id });
    }
    q('DELETE FROM users WHERE id = ?').run(me);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  app.get('/api/stream', requireUser, (req, res) => {
    realtime.connect(req.user.id, req, res);
  });

  // ---------- Fouten ----------

  app.use('/api', (req, res) => res.status(404).json({ error: 'Niet gevonden' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Er ging iets mis op de server' });
  });

  return app;
}

module.exports = { createApp, ageFrom, fitsInterest };
