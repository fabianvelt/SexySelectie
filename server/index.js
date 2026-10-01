const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'sexyselectie.db');
const TICKET_SECRET = process.env.TICKET_SECRET || 'dev-ticket-secret-verander-mij';

if (!process.env.TICKET_SECRET && process.env.NODE_ENV === 'production') {
  console.error('TICKET_SECRET moet gezet zijn in productie');
  process.exit(1);
}

const db = openDb(DB_FILE);
const app = createApp({ db, ticketSecret: TICKET_SECRET, secureCookies: process.env.NODE_ENV === 'production' });

app.listen(PORT, () => {
  console.log(`SexySelectie draait op http://localhost:${PORT}`);
});
