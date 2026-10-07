// Vult de database met demo-evenementen en demo-profielen, en print
// ticketcodes die je zelf kunt "scannen" (of handmatig invoeren) in de app.
//
//   npm run seed
//
// Alle demo-profielen hebben jou al geliket, dus een swipe naar rechts
// levert direct een match op.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('../server/db');
const { hashPassword } = require('../server/auth');
const { createTicketCode, hashTicketCode } = require('../server/tickets');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'sexyselectie.db');
const TICKET_SECRET = process.env.TICKET_SECRET || 'dev-ticket-secret-verander-mij';

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

const EVENTS = [
  { id: 'zomerzon-2026', name: 'Zomerzon Festival', venue: 'Strandpark', city: 'Zandvoort', starts_at: days(14), ends_at: days(16) },
  { id: 'nachtlicht-rave', name: 'Nachtlicht Rave', venue: 'Oude Gashouder', city: 'Amsterdam', starts_at: days(5), ends_at: days(5.5) },
  { id: 'duinbeats-2026', name: 'Duinbeats', venue: 'De Duinen', city: 'Bloemendaal', starts_at: days(30), ends_at: days(32) },
];

const PEOPLE = [
  ['Sanne', 'woman', 'men', '1999-04-12', 'Altijd vooraan bij de mainstage 🎶', ['zomerzon-2026', 'duinbeats-2026']],
  ['Lotte', 'woman', 'everyone', '2001-08-03', 'Techno, zonnebrand en glitter.', ['nachtlicht-rave']],
  ['Mila', 'woman', 'men', '1997-11-21', 'Zoek iemand om mee naar de silent disco te gaan.', ['zomerzon-2026']],
  ['Noor', 'woman', 'women', '2000-02-14', 'Housemuziek > alles', ['zomerzon-2026', 'nachtlicht-rave']],
  ['Daan', 'man', 'women', '1998-06-30', 'Kampeer op camping B, kom langs voor koffie ☕', ['zomerzon-2026', 'duinbeats-2026']],
  ['Ruben', 'man', 'everyone', '1996-01-09', 'Drum & bass en goede gesprekken.', ['nachtlicht-rave', 'duinbeats-2026']],
  ['Sem', 'man', 'women', '2002-09-17', 'Eerste keer festival, laat me alles zien!', ['zomerzon-2026']],
  ['Alex', 'nonbinary', 'everyone', '1999-12-01', 'Op zoek naar dansmaatjes 🕺', ['zomerzon-2026', 'nachtlicht-rave', 'duinbeats-2026']],
];

// Sfeerillustraties (silhouetten, geen echte mensen) zodat de demo laat zien
// hoe profielfoto's de app inkleuren.
function demoPhoto(name) {
  const file = path.join(__dirname, 'demo-photos', `${name.toLowerCase()}.jpg`);
  return fs.existsSync(file) ? `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` : null;
}

const db = openDb(DB_FILE);

const upsertEvent = db.prepare(`INSERT INTO events (id, name, venue, city, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, venue = excluded.venue, city = excluded.city,
                                 starts_at = excluded.starts_at, ends_at = excluded.ends_at`);
for (const e of EVENTS) upsertEvent.run(e.id, e.name, e.venue, e.city, e.starts_at, e.ends_at);

const password = hashPassword('demo1234');
const demoIds = [];
for (const [name, gender, interest, birthdate, bio, events] of PEOPLE) {
  const email = `${name.toLowerCase()}@demo.sexyselectie.nl`;
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, password_hash, name, birthdate, gender, interested_in, bio, photo, email_verified_at)
                                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(email, password, name, birthdate, gender, interest, bio, demoPhoto(name));
    user = { id: lastInsertRowid };
  } else {
    db.prepare('UPDATE users SET photo = COALESCE(photo, ?) WHERE id = ?').run(demoPhoto(name), user.id);
  }
  demoIds.push(user.id);
  for (const eventId of events) {
    const code = createTicketCode(TICKET_SECRET, eventId, `DEMO${name.toUpperCase()}`);
    db.prepare('INSERT OR IGNORE INTO tickets (code_hash, event_id, user_id) VALUES (?, ?, ?)')
      .run(hashTicketCode(code), eventId, user.id);
  }
}

// Demo-profielen liken iedereen die niet zelf een demo-profiel is.
const likeAll = db.prepare(`INSERT OR IGNORE INTO swipes (swiper_id, target_id, liked)
                            SELECT ?, id, 1 FROM users WHERE email NOT LIKE '%@demo.sexyselectie.nl'`);
for (const id of demoIds) likeAll.run(id);

console.log(`Database: ${DB_FILE}`);
console.log(`${EVENTS.length} evenementen en ${PEOPLE.length} demo-profielen klaargezet (wachtwoord: demo1234).\n`);
console.log('Ticketcodes om te scannen of in te voeren (elke code kan maar door één account geclaimd worden):\n');
for (const e of EVENTS) {
  console.log(`  ${e.name} — ${e.city}`);
  for (let i = 0; i < 3; i++) {
    const serial = crypto.randomBytes(5).toString('hex').toUpperCase();
    console.log(`    ${createTicketCode(TICKET_SECRET, e.id, serial)}`);
  }
  console.log('');
}
console.log('Tip: draai "npm run seed" opnieuw nadat je een account hebt aangemaakt,');
console.log('dan liken de demo-profielen jou ook en krijg je meteen matches.');
