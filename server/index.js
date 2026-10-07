const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { Push, sendersFromEnv } = require('./push');
const { createMailer } = require('./mail');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'sexyselectie.db');
const TICKET_SECRET = process.env.TICKET_SECRET || 'dev-ticket-secret-verander-mij';

if (!process.env.TICKET_SECRET && process.env.NODE_ENV === 'production') {
  console.error('TICKET_SECRET moet gezet zijn in productie');
  process.exit(1);
}

const db = openDb(DB_FILE);
const push = new Push(db, sendersFromEnv(), { vapidPublicKey: process.env.VAPID_PUBLIC_KEY });
const mailer = createMailer();
const app = createApp({
  db,
  ticketSecret: TICKET_SECRET,
  secureCookies: process.env.NODE_ENV === 'production',
  push,
  mailer,
  appUrl: process.env.APP_URL || null,
  // Tijdelijk uit te zetten tijdens een eerste test met vrienden.
  requireVerifiedEmail: process.env.REQUIRE_EMAIL_VERIFICATION !== 'false',
});

app.listen(PORT, () => {
  console.log(`SexySelectie draait op http://localhost:${PORT}`);
  console.log(`Pushmeldingen: ${push.enabledKinds().join(', ') || 'uit (zie README)'}`);
  console.log(`E-mail: ${mailer.kind === 'resend' ? 'via Resend' : 'alleen in deze log (zet RESEND_API_KEY, zie README)'}`);
});
