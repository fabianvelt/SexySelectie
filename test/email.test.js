const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createTicketCode } = require('../server/tickets');
const { verifyEmail } = require('../server/mail');

const SECRET = 'test-secret';
let server;
let baseUrl;
let db;
const outbox = [];

before(async () => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO events (id, name, venue, city, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('fest', 'Festival', 'Park', 'Utrecht', new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 3 * 86400000).toISOString());
  const mailer = { send: async (m) => outbox.push(m) };
  server = createApp({ db, ticketSecret: SECRET, mailer, appUrl: 'https://app.test' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };
}

let n = 0;
async function register(extra = {}) {
  const c = client();
  n++;
  const email = `mail${n}@test.nl`;
  const res = await c('POST', '/api/register', {
    email, password: 'wachtwoord', name: `Mail${n}`, birthdate: '1997-01-01', gender: 'woman', interestedIn: 'everyone', ...extra,
  });
  assert.equal(res.status, 201);
  c.user = res.data.user;
  c.email = email;
  return c;
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const lastMailTo = (email) => [...outbox].reverse().find((m) => m.to === email);
const codeFrom = (mail) => mail.text.match(/Je code: (\d{6})/)[1];
const linkTokenFrom = (mail) => mail.text.match(/#\/[a-z-]+\/([A-Za-z0-9_-]+)/)[1];

test('na registreren: mail met code en link, nog niet bevestigd', async () => {
  const c = await register();
  await settle();
  const mail = lastMailTo(c.email);
  assert.ok(mail, 'er is een mail verstuurd');
  assert.match(mail.subject, /^\d{6} is je SexySelectie-code$/);
  assert.match(mail.text, /https:\/\/app\.test\/#\/bevestig\/[A-Za-z0-9_-]{20,}/);
  assert.equal(c.user.emailVerified, false);
});

test('zonder bevestiging: wel tickets, niet swipen, niet zichtbaar voor anderen', async () => {
  const unverified = await register();
  const verified = await register();
  await verified('POST', '/api/email/verify', { code: codeFrom(lastMailTo(verified.email)) });
  await unverified('POST', '/api/tickets', { code: createTicketCode(SECRET, 'fest', 'U1') });
  await verified('POST', '/api/tickets', { code: createTicketCode(SECRET, 'fest', 'V1') });

  const seen = (await verified('GET', '/api/discover')).data.profiles.map((p) => p.id);
  assert.ok(!seen.includes(unverified.user.id), 'onbevestigd profiel is onzichtbaar');
  const swipe = await unverified('POST', '/api/swipes', { targetId: verified.user.id, like: true });
  assert.equal(swipe.status, 403);
});

test('bevestigen met code: verkeerde codes tellen, na 5 pogingen geblokkeerd', async () => {
  const c = await register();
  await settle();
  const code = codeFrom(lastMailTo(c.email));
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await c('POST', '/api/email/verify', { code: wrong })).status, 400);
  const ok = await c('POST', '/api/email/verify', { code });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.emailVerified, true);
  assert.equal((await c('POST', '/api/email/verify', { code })).status, 400, 'code is eenmalig');

  const d = await register();
  await settle();
  const dCode = codeFrom(lastMailTo(d.email));
  for (let i = 0; i < 5; i++) await d('POST', '/api/email/verify', { code: dCode === '000000' ? '111111' : '000000' });
  assert.equal((await d('POST', '/api/email/verify', { code: dCode })).status, 429, 'ook de juiste code werkt niet meer');
});

test('bevestigen via de link werkt ook zonder ingelogd te zijn', async () => {
  const c = await register();
  await settle();
  const token = linkTokenFrom(lastMailTo(c.email));
  const anon = client();
  const res = await anon('POST', '/api/email/verify', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.user, null);
  assert.equal((await c('GET', '/api/me')).data.user.emailVerified, true);
  assert.equal((await anon('POST', '/api/email/verify', { token })).status, 400, 'link is eenmalig');
});

test('opnieuw sturen: nieuwe code, oude vervalt, met wachttijd', async () => {
  const c = await register();
  await settle();
  const first = codeFrom(lastMailTo(c.email));
  assert.equal((await c('POST', '/api/email/resend')).status, 429, 'niet direct opnieuw');
  db.prepare("UPDATE email_codes SET created_at = '2000-01-01T00:00:00Z' WHERE user_id = ?").run(c.user.id);
  assert.equal((await c('POST', '/api/email/resend')).status, 204);
  await settle();
  const second = codeFrom(lastMailTo(c.email));
  if (first !== second) assert.equal((await c('POST', '/api/email/verify', { code: first })).status, 400);
  assert.equal((await c('POST', '/api/email/verify', { code: second })).status, 200);
});

test('wachtwoord vergeten: zelfde antwoord voor onbekend adres, code zet nieuw wachtwoord en logt overal uit', async () => {
  const c = await register();
  const before = outbox.length;
  assert.equal((await client()('POST', '/api/password/forgot', { email: 'bestaat-niet@test.nl' })).status, 204);
  await settle();
  assert.equal(outbox.length, before, 'geen mail naar onbekend adres');

  assert.equal((await client()('POST', '/api/password/forgot', { email: c.email.toUpperCase() })).status, 204);
  await settle();
  const mail = lastMailTo(c.email);
  assert.match(mail.subject, /nieuw wachtwoord/);

  const other = client();
  const wrong = await other('POST', '/api/password/reset', { email: c.email, code: '12345', password: 'nieuwwachtwoord' });
  assert.equal(wrong.status, 400);
  const reset = await other('POST', '/api/password/reset', { email: c.email, code: codeFrom(mail), password: 'nieuwwachtwoord' });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.user.emailVerified, true, 'reset bewijst ook het e-mailadres');

  assert.equal((await c('GET', '/api/me')).status, 401, 'oude sessie is uitgelogd');
  assert.equal((await other('GET', '/api/me')).status, 200, 'nieuwe sessie werkt');
  assert.equal((await client()('POST', '/api/login', { email: c.email, password: 'wachtwoord' })).status, 401);
  assert.equal((await client()('POST', '/api/login', { email: c.email, password: 'nieuwwachtwoord' })).status, 200);
});

test('wachtwoord resetten via de link', async () => {
  const c = await register();
  await client()('POST', '/api/password/forgot', { email: c.email });
  await settle();
  const token = linkTokenFrom(lastMailTo(c.email));
  assert.equal((await client()('POST', '/api/password/reset', { token, password: 'kort' })).status, 400);
  assert.equal((await client()('POST', '/api/password/reset', { token, password: 'linkwachtwoord' })).status, 200);
  assert.equal((await client()('POST', '/api/password/reset', { token, password: 'nogeenkeer1' })).status, 400, 'link is eenmalig');
});

test('te veel mislukte inlogpogingen worden afgeremd', async () => {
  const c = await register();
  const anon = client();
  for (let i = 0; i < 10; i++) assert.equal((await anon('POST', '/api/login', { email: c.email, password: 'fout' })).status, 401);
  assert.equal((await anon('POST', '/api/login', { email: c.email, password: 'wachtwoord' })).status, 429);
});

test('mails escapen de naam in HTML', () => {
  const mail = verifyEmail({ name: '<script>x</script>', code: '123456', link: 'https://app.test/#/bevestig/abc' });
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('123456'));
});

test('migratie: bestaande accounts worden als bevestigd gemarkeerd', () => {
  const { DatabaseSync } = require('node:sqlite');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'oud.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    name TEXT NOT NULL, birthdate TEXT NOT NULL, gender TEXT NOT NULL, interested_in TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
    photo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (email, password_hash, name, birthdate, gender, interested_in) VALUES ('oud@test.nl', 'x', 'Oud', '1990-01-01', 'man', 'women');`);
  old.close();
  const migrated = openDb(file);
  assert.ok(migrated.prepare('SELECT email_verified_at FROM users').get().email_verified_at);
  migrated.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('Resend-mailer stuurt het juiste verzoek', async () => {
  const { createMailer } = require('../server/mail');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, text: async () => '' };
  };
  try {
    const mailer = createMailer({ RESEND_API_KEY: 're_test', MAIL_FROM: 'SexySelectie <hoi@sexyselectie.nl>' });
    assert.equal(mailer.kind, 'resend');
    await mailer.send({ to: 'a@b.nl', subject: 'Onderwerp', html: '<p>x</p>', text: 'x' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    from: 'SexySelectie <hoi@sexyselectie.nl>', to: ['a@b.nl'], subject: 'Onderwerp', html: '<p>x</p>', text: 'x',
  });
});
