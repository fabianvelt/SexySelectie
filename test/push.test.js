const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { Push, sendersFromEnv, signJwt } = require('../server/push');
const { createTicketCode } = require('../server/tickets');

const SECRET = 'test-secret';
let app;
let server;
let baseUrl;
let db;
const sent = [];
let nextResult = 'ok';

before(async () => {
  db = openDb(':memory:');
  db.prepare('INSERT INTO events (id, name, venue, city, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('fest', 'Festival', 'Park', 'Utrecht', new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 3 * 86400000).toISOString());
  const fake = (kind) => async (sub, message) => {
    sent.push({ kind, userId: sub.user_id, token: sub.token, message });
    return nextResult;
  };
  const push = new Push(db, { web: fake('web'), fcm: fake('fcm'), apns: fake('apns') }, { vapidPublicKey: 'PUBKEY' });
  app = createApp({ db, ticketSecret: SECRET, push });
  server = app.listen(0);
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
async function newUser(gender, interestedIn) {
  const c = client();
  n++;
  const res = await c('POST', '/api/register', {
    email: `push${n}@test.nl`, password: 'wachtwoord', name: `Push${n}`, birthdate: '1998-05-05', gender, interestedIn,
  });
  c.user = res.data.user;
  await c('POST', '/api/tickets', { code: createTicketCode(SECRET, 'fest', `P${n}`) });
  return c;
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const webSub = (id) => ({ endpoint: `https://push.example.com/${id}`, keys: { p256dh: 'BPk3', auth: 'abc' } });

test('config en ongeldige abonnementen', async () => {
  const a = await newUser('man', 'women');
  const { data } = await a('GET', '/api/push/config');
  assert.equal(data.webPublicKey, 'PUBKEY');
  assert.deepEqual(data.kinds.sort(), ['apns', 'fcm', 'web']);
  assert.equal((await a('POST', '/api/push/subscribe', { kind: 'web', token: { endpoint: 'http://onveilig' } })).status, 400);
  assert.equal((await a('POST', '/api/push/subscribe', { kind: 'fcm', token: 'kort' })).status, 400);
  assert.equal((await a('POST', '/api/push/subscribe', { kind: 'sms', token: 'x'.repeat(30) })).status, 400);
});

test('match en bericht geven pushmeldingen op alle apparaten, zonder berichtinhoud', async () => {
  const a = await newUser('man', 'women');
  const b = await newUser('woman', 'men');
  assert.equal((await b('POST', '/api/push/subscribe', { kind: 'web', token: webSub('b1') })).status, 204);
  assert.equal((await b('POST', '/api/push/subscribe', { kind: 'fcm', token: 'fcm-token-'.padEnd(40, 'x') })).status, 204);

  await b('POST', '/api/swipes', { targetId: a.user.id, like: true });
  sent.length = 0;
  const { data } = await a('POST', '/api/swipes', { targetId: b.user.id, like: true });
  await settle();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.userId === b.user.id && s.message.url === `/#/chat/${data.match.id}`));
  assert.match(sent[0].message.title, /match/);

  sent.length = 0;
  await a('POST', `/api/matches/${data.match.id}/messages`, { body: 'Geheim berichtje' });
  await settle();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => !s.message.body.includes('Geheim')), 'inhoud niet op het vergrendelscherm');

  // Uitschrijven via endpoint werkt voor web-abonnementen.
  assert.equal((await b('POST', '/api/push/unsubscribe', { token: webSub('b1') })).status, 204);
  sent.length = 0;
  await a('POST', `/api/matches/${data.match.id}/messages`, { body: 'Nog een' });
  await settle();
  assert.deepEqual(sent.map((s) => s.kind), ['fcm']);
});

test('geen push als de ontvanger de app open heeft, en verlopen tokens worden opgeruimd', async () => {
  const a = await newUser('man', 'women');
  const b = await newUser('woman', 'men');
  await b('POST', '/api/push/subscribe', { kind: 'apns', token: 'a'.repeat(64) });
  await b('POST', '/api/swipes', { targetId: a.user.id, like: true });
  const { data } = await a('POST', '/api/swipes', { targetId: b.user.id, like: true });
  await settle();

  // b opent de app (SSE-verbinding)
  const { realtime } = app.locals;
  realtime.clients.set(b.user.id, new Set());
  sent.length = 0;
  await a('POST', `/api/matches/${data.match.id}/messages`, { body: 'Hoi' });
  await settle();
  assert.equal(sent.length, 0);
  realtime.clients.delete(b.user.id);

  nextResult = 'gone';
  await a('POST', `/api/matches/${data.match.id}/messages`, { body: 'Hoi?' });
  await settle();
  nextResult = 'ok';
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(b.user.id).n, 0);
});

test('APNs- en FCM-JWT worden correct ondertekend', () => {
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwt = signJwt({ alg: 'ES256', kid: 'K' }, { iss: 'T', iat: 1 }, ec.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'ES256');
  const [h, p, s] = jwt.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt2 = signJwt({ alg: 'RS256' }, { iss: 'x' }, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'RS256');
  const [h2, p2, s2] = jwt2.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h2}.${p2}`), rsa.publicKey, Buffer.from(s2, 'base64url')));
});

test('sendersFromEnv zet alleen geconfigureerde kanalen aan', () => {
  assert.deepEqual(Object.keys(sendersFromEnv({})), []);
  const keys = require('web-push').generateVAPIDKeys();
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const senders = sendersFromEnv({
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    APNS_KEY: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_BUNDLE_ID: 'nl.sexyselectie.app',
  });
  assert.deepEqual(Object.keys(senders).sort(), ['apns', 'web']);
});

// Draait alleen als openssl beschikbaar is (voor een tijdelijk TLS-certificaat).
const { execSync } = require('node:child_process');
const hasOpenssl = (() => { try { execSync('openssl version', { stdio: 'ignore' }); return true; } catch { return false; } })();

test('echte Web Push-verzending: versleuteld, met VAPID, en 410 ruimt op', { skip: !hasOpenssl && 'openssl ontbreekt' }, async () => {
  const https = require('node:https');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=127.0.0.1 -keyout ${dir}/key.pem -out ${dir}/cert.pem`, { stdio: 'ignore' });

  const received = [];
  let reply = 201;
  const fakePushService = https.createServer({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(reply).end();
    });
  }).listen(0);
  await new Promise((r) => fakePushService.once('listening', r));
  const previous = https.globalAgent.options.rejectUnauthorized;
  https.globalAgent.options.rejectUnauthorized = false; // alleen voor het zelfondertekende testcertificaat

  try {
    const keys = require('web-push').generateVAPIDKeys();
    const { web } = sendersFromEnv({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:t@t.nl' });
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const token = JSON.stringify({
      endpoint: `https://127.0.0.1:${fakePushService.address().port}/push/abc`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    });

    assert.equal(await web({ token }, { title: 'Hoi', body: 'Test', url: '/#/matches', tag: 't' }), 'ok');
    assert.match(received[0].headers.authorization, /^vapid t=.+, k=/);
    assert.equal(received[0].headers['content-encoding'], 'aes128gcm');
    assert.ok(!received[0].body.includes('Hoi'), 'payload is versleuteld');

    reply = 410;
    assert.equal(await web({ token }, { title: 'x', body: 'y' }), 'gone');
  } finally {
    https.globalAgent.options.rejectUnauthorized = previous;
    fakePushService.closeAllConnections();
    fakePushService.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
