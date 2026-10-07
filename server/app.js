const path = require('node:path');
const express = require('express');
const { hashPassword, verifyPassword, newSessionToken, hashToken, newCode } = require('./auth');
const { verifyTicketCode, hashTicketCode } = require('./tickets');
const { Realtime } = require('./realtime');
const { Push } = require('./push');
const { createMailer, verifyEmail, resetEmail } = require('./mail');
const { insertPhoto } = require('./db');

const SESSION_COOKIE = 'ss_session';
const GENDERS = ['man', 'woman', 'nonbinary'];
const INTERESTS = ['men', 'women', 'everyone'];
const MAX_PHOTO_BYTES = 600 * 1024;
const MAX_PHOTOS = 6;
const MAX_ACTS_PER_EVENT = 30;
const REPORT_REASONS = ['fake', 'inappropriate', 'harassment', 'underage', 'other'];
const CODE_TTL = { verify: 24 * 60 * 60 * 1000, reset: 30 * 60 * 1000 };
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_AFTER_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

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

function publicUser(u, photos = []) {
  return { id: u.id, name: u.name, age: ageFrom(u.birthdate), gender: u.gender, bio: u.bio, photo: photos[0] ?? null, photos };
}

function privateUser(u, photos = []) {
  return {
    ...publicUser(u, photos),
    email: u.email,
    emailVerified: !!u.email_verified_at,
    birthdate: u.birthdate,
    interestedIn: u.interested_in,
  };
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
  return out;
}

// Controleert een geüploade foto (data-URL) op type, grootte en inhoud. Dat
// laatste voorkomt dat iemand iets anders dan een afbeelding als "foto" opslaat.
function validatePhoto(dataUrl) {
  const [, mime, base64] = (typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.*)$/s)) || [];
  if (!mime) throw new HttpError(400, 'Foto moet een JPEG, PNG of WebP zijn');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(400, 'Foto is te groot');
  const magic = {
    'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8,
    'image/png': bytes.subarray(0, 4).toString('hex') === '89504e47',
    'image/webp': bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
  };
  if (!magic[mime]) throw new HttpError(400, 'Dit bestand is geen geldige foto');
  return dataUrl;
}

function createApp({
  db,
  ticketSecret,
  secureCookies = false,
  push = new Push(db),
  mailer = createMailer({}),
  appUrl = null,
  requireVerifiedEmail = true,
}) {
  if (!ticketSecret) throw new Error('ticketSecret is verplicht');

  const app = express();
  // Achter de proxy van de host (Fly.io) klopt req.protocol dan ook.
  app.set('trust proxy', 1);
  const realtime = new Realtime();
  app.locals.realtime = realtime;
  app.locals.push = push;

  // Pushmelding alleen als de ontvanger de app niet open heeft; anders komt
  // het bericht al realtime binnen.
  function notify(userId, message) {
    if (realtime.isConnected(userId)) return;
    push.notify(userId, message).catch((err) => console.error('Push mislukt:', err));
  }

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

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token &&
      q('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(hashToken(token));
    if (!user) return null;
    req.user = user;
    req.sessionTokenHash = hashToken(token);
    return user;
  }

  function requireUser(req, res, next) {
    next(currentUser(req) ? undefined : new HttpError(401, 'Niet ingelogd'));
  }

  // Zonder bevestigd e-mailadres kun je je profiel en tickets regelen, maar
  // niet swipen of chatten. Dat houdt nepaccounts buiten de deur.
  function requireVerified(user) {
    if (requireVerifiedEmail && !user.email_verified_at) {
      throw new HttpError(403, 'Bevestig eerst je e-mailadres');
    }
  }

  // ---------- Codes per e-mail ----------

  const codeHash = (userId, purpose, code) => hashToken(`${userId}:${purpose}:${code}`);
  const baseUrl = (req) => (appUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

  // Maakt een nieuwe code (de vorige vervalt) en mailt hem. De mail gaat op de
  // achtergrond, zodat een trage maildienst de app niet ophoudt.
  function sendCode(req, user, purpose) {
    const code = newCode();
    const linkToken = newSessionToken();
    q(`INSERT OR REPLACE INTO email_codes (user_id, purpose, code_hash, link_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`)
      .run(user.id, purpose, codeHash(user.id, purpose, code), hashToken(linkToken),
        new Date(Date.now() + CODE_TTL[purpose]).toISOString());
    const route = purpose === 'verify' ? 'bevestig' : 'nieuw-wachtwoord';
    const content = (purpose === 'verify' ? verifyEmail : resetEmail)({
      name: user.name,
      code,
      link: `${baseUrl(req)}/#/${route}/${linkToken}`,
    });
    mailer.send({ to: user.email, ...content }).catch((err) => console.error('Mail versturen mislukt:', err.message));
  }

  function recentlySent(userId, purpose) {
    const row = q('SELECT created_at FROM email_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose);
    return row && Date.now() - Date.parse(row.created_at) < CODE_RESEND_AFTER_MS;
  }

  // Controleert een code (van een gebruiker) of een link-token. Geeft de
  // gebruiker terug en laat de code direct vervallen.
  function useCode(purpose, { userId, code, token }) {
    const now = new Date().toISOString();
    let row;
    if (token) {
      row = q('SELECT * FROM email_codes WHERE link_hash = ? AND purpose = ?').get(hashToken(String(token)), purpose);
      if (!row || row.expires_at < now) throw new HttpError(400, 'Deze link is verlopen of al gebruikt. Vraag een nieuwe code aan.');
    } else {
      row = userId && q('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose);
      if (!row || row.expires_at < now) throw new HttpError(400, 'Deze code is verlopen. Vraag een nieuwe aan.');
      if (row.attempts >= CODE_MAX_ATTEMPTS) throw new HttpError(429, 'Te vaak geprobeerd. Vraag een nieuwe code aan.');
      if (row.code_hash !== codeHash(userId, purpose, String(code || '').replace(/\s/g, ''))) {
        q('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
        throw new HttpError(400, 'Deze code klopt niet');
      }
    }
    q('DELETE FROM email_codes WHERE id = ?').run(row.id);
    return q('SELECT * FROM users WHERE id = ?').get(row.user_id);
  }

  // Eenvoudige rem op wachtwoord raden: te veel mislukte pogingen per e-mailadres.
  const loginFailures = new Map();
  function checkLoginAllowed(email) {
    const entry = loginFailures.get(email);
    if (entry && Date.now() - entry.first < LOGIN_WINDOW_MS && entry.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, 'Te veel pogingen. Probeer het over een kwartier opnieuw of kies een nieuw wachtwoord.');
    }
  }
  function recordLoginFailure(email) {
    const entry = loginFailures.get(email);
    if (!entry || Date.now() - entry.first >= LOGIN_WINDOW_MS) loginFailures.set(email, { first: Date.now(), count: 1 });
    else entry.count++;
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

  const photoUrls = (userId) =>
    q('SELECT id FROM photos WHERE user_id = ? ORDER BY position').all(userId).map((p) => `/api/photos/${p.id}`);
  const pub = (u) => publicUser(u, photoUrls(u.id));
  const priv = (u) => privateUser(u, photoUrls(u.id));
  const freshMe = (id) => priv(q('SELECT * FROM users WHERE id = ?').get(id));

  // Acts die allebei willen zien, bij evenementen waar ze allebei heen gaan.
  function sharedActs(userId, otherId) {
    return q(`SELECT a.name FROM user_acts x JOIN user_acts y ON y.act_id = x.act_id AND y.user_id = ?
              JOIN acts a ON a.id = x.act_id JOIN events e ON e.id = a.event_id
              WHERE x.user_id = ? AND e.ends_at > ? ORDER BY a.name`)
      .all(otherId, userId, new Date().toISOString())
      .map((r) => r.name);
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
    const { lastInsertRowid } = q(`INSERT INTO users (email, password_hash, name, birthdate, gender, interested_in, bio)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(email, hashPassword(password), profile.name, birthdate, profile.gender, profile.interested_in, profile.bio);
    const user = q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    startSession(res, user.id);
    sendCode(req, user, 'verify');
    res.status(201).json({ user: priv(user) });
  });

  app.post('/api/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    checkLoginAllowed(email);
    const user = q('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordLoginFailure(email);
      throw new HttpError(401, 'E-mail of wachtwoord klopt niet');
    }
    loginFailures.delete(email);
    startSession(res, user.id);
    res.json({ user: priv(user) });
  });

  // ---------- E-mail bevestigen ----------

  // Met een code (ingelogd) of met de link uit de mail (ook als je in een
  // andere browser zit dan waar je bent ingelogd).
  app.post('/api/email/verify', (req, res) => {
    const me = currentUser(req);
    if (!req.body.token && !me) throw new HttpError(401, 'Niet ingelogd');
    const user = useCode('verify', { userId: me?.id, code: req.body.code, token: req.body.token });
    q("UPDATE users SET email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(user.id);
    const fresh = q('SELECT * FROM users WHERE id = ?').get(user.id);
    res.json({ user: me?.id === fresh.id ? priv(fresh) : null });
  });

  app.post('/api/email/resend', requireUser, (req, res) => {
    if (req.user.email_verified_at) throw new HttpError(400, 'Je e-mailadres is al bevestigd');
    if (recentlySent(req.user.id, 'verify')) throw new HttpError(429, 'We hebben net een mail gestuurd. Probeer het over een minuut opnieuw.');
    sendCode(req, req.user, 'verify');
    res.status(204).end();
  });

  // ---------- Wachtwoord vergeten ----------

  // Antwoordt altijd hetzelfde, zodat niemand kan uitzoeken welke e-mailadressen een account hebben.
  app.post('/api/password/forgot', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = email && q('SELECT * FROM users WHERE email = ?').get(email);
    if (user && !recentlySent(user.id, 'reset')) sendCode(req, user, 'reset');
    res.status(204).end();
  });

  app.post('/api/password/reset', (req, res) => {
    const password = str(req.body.password, 'Wachtwoord', { min: 8, max: 200 });
    let user;
    if (req.body.token) {
      user = useCode('reset', { token: req.body.token });
    } else {
      const email = String(req.body.email || '').trim().toLowerCase();
      const found = email && q('SELECT id FROM users WHERE email = ?').get(email);
      user = useCode('reset', { userId: found?.id, code: req.body.code });
    }
    // Wie de code uit de mail heeft, heeft ook toegang tot het e-mailadres.
    q(`UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, datetime('now'))
       WHERE id = ?`).run(hashPassword(password), user.id);
    // Overal uitloggen: misschien heeft iemand anders je wachtwoord.
    q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    loginFailures.delete(user.email);
    startSession(res, user.id);
    res.json({ user: priv(q('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  app.post('/api/logout', requireUser, (req, res) => {
    q('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ user: priv(req.user) });
  });

  app.put('/api/me', requireUser, (req, res) => {
    const changes = validateProfile(req.body, { partial: true });
    const keys = Object.keys(changes);
    if (keys.length) {
      q(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => changes[k]), req.user.id);
    }
    res.json({ user: priv(q('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  // ---------- Foto's ----------

  // Alleen voor ingelogde gebruikers. Een foto verandert nooit (een nieuwe foto
  // krijgt een nieuw id), dus de telefoon mag hem voor altijd bewaren.
  app.get('/api/photos/:id', requireUser, (req, res) => {
    const photo = q('SELECT mime, data FROM photos WHERE id = ?').get(String(req.params.id));
    if (!photo) throw new HttpError(404, 'Foto niet gevonden');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(photo.mime).send(Buffer.from(photo.data));
  });

  app.post('/api/me/photos', requireUser, (req, res) => {
    const dataUrl = validatePhoto(req.body.photo);
    const { n } = q('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?').get(req.user.id);
    if (n >= MAX_PHOTOS) throw new HttpError(400, `Je kunt maximaal ${MAX_PHOTOS} foto's toevoegen`);
    insertPhoto(db, req.user.id, dataUrl, n);
    res.status(201).json({ user: freshMe(req.user.id) });
  });

  // Nieuwe volgorde: een lijst met al je foto-id's, de eerste wordt je hoofdfoto.
  app.put('/api/me/photos', requireUser, (req, res) => {
    const ids = Array.isArray(req.body.order) ? req.body.order.map((u) => String(u).split('/').pop()) : [];
    const own = q('SELECT id FROM photos WHERE user_id = ?').all(req.user.id).map((p) => p.id);
    if (ids.length !== own.length || new Set(ids).size !== ids.length || !ids.every((id) => own.includes(id))) {
      throw new HttpError(400, 'Ongeldige volgorde');
    }
    ids.forEach((id, i) => q('UPDATE photos SET position = ? WHERE id = ?').run(i, id));
    res.json({ user: freshMe(req.user.id) });
  });

  app.delete('/api/me/photos/:id', requireUser, (req, res) => {
    const { changes } = q('DELETE FROM photos WHERE id = ? AND user_id = ?').run(String(req.params.id), req.user.id);
    if (!changes) throw new HttpError(404, 'Foto niet gevonden');
    q('SELECT id FROM photos WHERE user_id = ? ORDER BY position').all(req.user.id)
      .forEach((p, i) => q('UPDATE photos SET position = ? WHERE id = ?').run(i, p.id));
    res.json({ user: freshMe(req.user.id) });
  });

  // ---------- Line-up ----------

  app.get('/api/events/:id/lineup', requireUser, (req, res) => {
    const event = q('SELECT id, name FROM events WHERE id = ?').get(String(req.params.id));
    if (!event) throw new HttpError(404, 'Evenement niet gevonden');
    const acts = q(`SELECT a.id, a.name, (ua.user_id IS NOT NULL) AS selected FROM acts a
                    LEFT JOIN user_acts ua ON ua.act_id = a.id AND ua.user_id = ?
                    WHERE a.event_id = ? ORDER BY a.name COLLATE NOCASE`)
      .all(req.user.id, event.id)
      .map((a) => ({ id: a.id, name: a.name, selected: !!a.selected }));
    res.json({ event, acts });
  });

  app.put('/api/events/:id/lineup', requireUser, (req, res) => {
    const eventId = String(req.params.id);
    if (!q('SELECT 1 FROM tickets WHERE user_id = ? AND event_id = ?').get(req.user.id, eventId)) {
      throw new HttpError(403, 'Scan eerst je ticket voor dit evenement');
    }
    const wanted = Array.isArray(req.body.actIds) ? [...new Set(req.body.actIds.map(Number))] : null;
    if (!wanted || wanted.length > MAX_ACTS_PER_EVENT) throw new HttpError(400, 'Ongeldige selectie');
    const valid = new Set(q('SELECT id FROM acts WHERE event_id = ?').all(eventId).map((a) => a.id));
    if (!wanted.every((id) => valid.has(id))) throw new HttpError(400, 'Deze act staat niet in de line-up');
    q('DELETE FROM user_acts WHERE user_id = ? AND act_id IN (SELECT id FROM acts WHERE event_id = ?)').run(req.user.id, eventId);
    for (const id of wanted) q('INSERT INTO user_acts (user_id, act_id) VALUES (?, ?)').run(req.user.id, id);
    res.json({ selected: wanted.length });
  });

  // ---------- Tickets ----------

  app.get('/api/tickets', requireUser, (req, res) => {
    const now = new Date().toISOString();
    const tickets = q(`SELECT t.id, t.scanned_at AS scannedAt, e.id AS eventId, e.name, e.venue, e.city,
                              e.starts_at AS startsAt, e.ends_at AS endsAt,
                              (SELECT COUNT(DISTINCT o.user_id) FROM tickets o WHERE o.event_id = e.id AND o.user_id != t.user_id) AS others,
                              (SELECT COUNT(*) FROM acts a WHERE a.event_id = e.id) AS lineupSize,
                              (SELECT COUNT(*) FROM user_acts ua JOIN acts a ON a.id = ua.act_id
                                WHERE a.event_id = e.id AND ua.user_id = t.user_id) AS myActs
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
    const { n: lineupSize } = q('SELECT COUNT(*) AS n FROM acts WHERE event_id = ?').get(event.id);
    res.status(existing ? 200 : 201).json({
      event: { id: event.id, name: event.name, venue: event.venue, city: event.city, startsAt: event.starts_at, lineupSize },
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
                            ${requireVerifiedEmail ? 'AND u.email_verified_at IS NOT NULL' : ''}
                          GROUP BY u.id`)
      .all(...eventIds, me.id, me.id, me.id, me.id)
      .filter((u) => fitsInterest(me.interested_in, u.gender) && fitsInterest(u.interested_in, me.gender))
      .map((u) => ({ u, acts: sharedActs(me.id, u.id), random: Math.random() }))
      .sort((a, b) => b.u.shared - a.u.shared || b.acts.length - a.acts.length || a.random - b.random)
      .slice(0, 20);

    res.json({
      hasTickets: true,
      profiles: candidates.map(({ u, acts }) => ({ ...pub(u), sharedEvents: sharedEvents(me.id, u.id), sharedActs: acts })),
    });
  });

  app.post('/api/swipes', requireUser, (req, res) => {
    const me = req.user;
    requireVerified(me);
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
      const acts = sharedActs(me.id, target.id);
      match = { id: row.id, user: pub(target), sharedEvents: sharedEvents(me.id, target.id), sharedActs: acts };
      realtime.send(target.id, 'match', { id: row.id, user: pub(me), sharedEvents: match.sharedEvents, sharedActs: acts });
      notify(target.id, {
        title: "It's a match",
        body: `Jij en ${me.name} gaan allebei naar ${match.sharedEvents.map((e) => e.name).join(' & ')}`,
        url: `/#/chat/${row.id}`,
        tag: `match-${row.id}`,
      });
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
        user: pub(r),
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
    res.json({
      match: { id: match.id, user: pub(other), sharedEvents: sharedEvents(req.user.id, other.id), sharedActs: sharedActs(req.user.id, other.id) },
      messages,
    });
  });

  app.post('/api/matches/:id/messages', requireUser, (req, res) => {
    requireVerified(req.user);
    const match = getMatchFor(Number(req.params.id), req.user.id);
    const body = str(req.body.body, 'Bericht', { min: 1, max: 1000 });
    const { lastInsertRowid } = q('INSERT INTO messages (match_id, sender_id, body) VALUES (?, ?, ?)')
      .run(match.id, req.user.id, body);
    const message = messageJson(q('SELECT * FROM messages WHERE id = ?').get(lastInsertRowid));
    realtime.send(match.otherId, 'message', message);
    realtime.send(req.user.id, 'message', message);
    // Bewust zonder de inhoud: meldingen zijn zichtbaar op een vergrendeld scherm.
    notify(match.otherId, {
      title: 'Nieuw bericht',
      body: `${req.user.name} heeft je een bericht gestuurd`,
      url: `/#/chat/${match.id}`,
      tag: `chat-${match.id}`,
    });
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

  // ---------- Pushmeldingen ----------

  app.get('/api/push/config', requireUser, (req, res) => {
    res.json({ webPublicKey: push.senders.web ? push.vapidPublicKey : null, kinds: push.enabledKinds() });
  });

  app.post('/api/push/subscribe', requireUser, (req, res) => {
    const { kind } = req.body;
    if (!['web', 'fcm', 'apns'].includes(kind)) throw new HttpError(400, 'Onbekend type');
    let token = req.body.token;
    if (kind === 'web') {
      if (!token || typeof token !== 'object' || !/^https:\/\//.test(token.endpoint || '') || !token.keys?.p256dh || !token.keys?.auth) {
        throw new HttpError(400, 'Ongeldig push-abonnement');
      }
      token = JSON.stringify({ endpoint: token.endpoint, keys: { p256dh: token.keys.p256dh, auth: token.keys.auth } });
    } else if (typeof token !== 'string' || !/^[A-Za-z0-9:_\-.]{20,4096}$/.test(token)) {
      throw new HttpError(400, 'Ongeldig apparaattoken');
    }
    push.subscribe(req.user.id, kind, token);
    res.status(204).end();
  });

  app.post('/api/push/unsubscribe', requireUser, (req, res) => {
    const token = typeof req.body.token === 'object' ? req.body.token?.endpoint : req.body.token;
    if (typeof token !== 'string') throw new HttpError(400, 'Token ontbreekt');
    // Web-abonnementen staan als JSON opgeslagen; zoek die op endpoint.
    // CASE garandeert dat json_extract alleen op web-tokens (JSON) draait.
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?
                AND (token = ? OR CASE WHEN kind = 'web' THEN json_extract(token, '$.endpoint') END = ?)`)
      .run(req.user.id, token, token);
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
