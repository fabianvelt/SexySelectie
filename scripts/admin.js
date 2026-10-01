// Beheer van evenementen, ticketcodes en meldingen, voor op de server.
//
//   npm run admin -- events
//   npm run admin -- add-event <id> "<naam>" "<locatie>" "<stad>" <start ISO> <eind ISO>
//   npm run admin -- tickets <eventId> <aantal>        (print codes als CSV)
//   npm run admin -- reports                           (open meldingen)
//   npm run admin -- handle-report <id>
//   npm run admin -- delete-user <e-mail>

const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('../server/db');
const { createTicketCode } = require('../server/tickets');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'sexyselectie.db');
const TICKET_SECRET = process.env.TICKET_SECRET || 'dev-ticket-secret-verander-mij';
const db = openDb(DB_FILE);
const [command, ...args] = process.argv.slice(2);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function iso(value, label) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) fail(`Ongeldige ${label}: ${value} (gebruik bijv. 2026-07-18T12:00:00+02:00)`);
  return d.toISOString();
}

switch (command) {
  case 'events': {
    const rows = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM tickets t WHERE t.event_id = e.id) AS tickets
                             FROM events e ORDER BY starts_at`).all();
    console.table(rows.map((e) => ({ id: e.id, naam: e.name, stad: e.city, start: e.starts_at, eind: e.ends_at, tickets: e.tickets })));
    break;
  }
  case 'add-event': {
    const [id, name, venue, city, start, end] = args;
    if (!/^[a-z0-9-]{1,64}$/.test(id || '')) fail('id mag alleen kleine letters, cijfers en - bevatten');
    if (!name || !venue || !city) fail('Gebruik: add-event <id> "<naam>" "<locatie>" "<stad>" <start> <eind>');
    const startsAt = iso(start, 'starttijd');
    const endsAt = iso(end, 'eindtijd');
    if (endsAt <= startsAt) fail('Eindtijd moet na de starttijd liggen');
    db.prepare(`INSERT INTO events (id, name, venue, city, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET name = excluded.name, venue = excluded.venue, city = excluded.city,
                                               starts_at = excluded.starts_at, ends_at = excluded.ends_at`)
      .run(id, name, venue, city, startsAt, endsAt);
    console.log(`Evenement ${id} opgeslagen.`);
    break;
  }
  case 'tickets': {
    const [eventId, count = '10'] = args;
    if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId || '')) fail(`Onbekend evenement: ${eventId}`);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100000) fail('Aantal moet tussen 1 en 100000 liggen');
    if (!process.env.TICKET_SECRET) console.error('Let op: TICKET_SECRET is niet gezet, deze codes werken alleen lokaal.');
    console.log('event,code');
    for (let i = 0; i < n; i++) {
      const serial = crypto.randomBytes(6).toString('hex').toUpperCase();
      console.log(`${eventId},${createTicketCode(TICKET_SECRET, eventId, serial)}`);
    }
    break;
  }
  case 'reports': {
    const rows = db.prepare(`SELECT r.id, r.reason, r.details, r.created_at, ru.email AS melder, tu.email AS gemeld, tu.name
                             FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id LEFT JOIN users tu ON tu.id = r.reported_id
                             WHERE r.handled_at IS NULL ORDER BY r.id`).all();
    if (!rows.length) console.log('Geen open meldingen.');
    else console.table(rows);
    break;
  }
  case 'handle-report': {
    const { changes } = db.prepare("UPDATE reports SET handled_at = datetime('now') WHERE id = ?").run(Number(args[0]));
    console.log(changes ? 'Melding afgehandeld.' : 'Melding niet gevonden.');
    break;
  }
  case 'delete-user': {
    const { changes } = db.prepare('DELETE FROM users WHERE email = ?').run(String(args[0] || '').toLowerCase());
    console.log(changes ? 'Gebruiker verwijderd.' : 'Gebruiker niet gevonden.');
    break;
  }
  default:
    console.log('Commando\'s: events, add-event, tickets, reports, handle-report, delete-user (zie scripts/admin.js)');
}
