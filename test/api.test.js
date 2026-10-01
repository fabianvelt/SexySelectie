const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp, fitsInterest } = require('../server/app');
const { createTicketCode } = require('../server/tickets');

const SECRET = 'test-secret';
let server;
let baseUrl;
let db;

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

before(async () => {
  db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO events (id, name, venue, city, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('fest-a', 'Festival A', 'Park', 'Utrecht', days(3), days(5));
  ins.run('fest-b', 'Festival B', 'Hal', 'Rotterdam', days(10), days(11));
  ins.run('fest-old', 'Oud Festival', 'Veld', 'Groningen', days(-10), days(-8));
  server = createApp({ db, ticketSecret: SECRET }).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// Mini-client die de sessiecookie onthoudt.
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
    const data = res.status === 204 ? null : await res.json();
    return { status: res.status, data };
  };
}

let n = 0;
async function newUser(overrides = {}) {
  const c = client();
  n++;
  const res = await c('POST', '/api/register', {
    email: `user${n}@test.nl`,
    password: 'wachtwoord',
    name: `User${n}`,
    birthdate: '1998-05-05',
    gender: 'woman',
    interestedIn: 'everyone',
    bio: '',
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  c.user = res.data.user;
  return c;
}

const ticket = (eventId, serial) => createTicketCode(SECRET, eventId, serial);

test('registratie vereist 18+', async () => {
  const c = client();
  const res = await c('POST', '/api/register', {
    email: 'jong@test.nl', password: 'wachtwoord', name: 'Jong',
    birthdate: new Date().toISOString().slice(0, 10), gender: 'man', interestedIn: 'women',
  });
  assert.equal(res.status, 400);
});

test('inloggen en uitloggen', async () => {
  await newUser({ email: 'login@test.nl' });
  const c = client();
  assert.equal((await c('POST', '/api/login', { email: 'login@test.nl', password: 'fout-wachtwoord' })).status, 401);
  assert.equal((await c('POST', '/api/login', { email: 'LOGIN@test.nl', password: 'wachtwoord' })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200);
  assert.equal((await c('POST', '/api/logout')).status, 204);
  assert.equal((await c('GET', '/api/me')).status, 401);
});

test('tickets: geldig, vervalst, al geclaimd en afgelopen', async () => {
  const a = await newUser();
  const b = await newUser();
  assert.equal((await a('POST', '/api/tickets', { code: ticket('fest-a', 'T1') })).status, 201);
  assert.equal((await a('POST', '/api/tickets', { code: ticket('fest-a', 'T1') })).status, 200, 'opnieuw scannen is ok');
  assert.equal((await b('POST', '/api/tickets', { code: ticket('fest-a', 'T1') })).status, 409, 'ticket van iemand anders');
  assert.equal((await b('POST', '/api/tickets', { code: 'SS1.fest-a.T2.vervalsthandtekening00' })).status, 400);
  assert.equal((await b('POST', '/api/tickets', { code: ticket('fest-old', 'T3') })).status, 400);
  assert.equal((await b('POST', '/api/tickets', { code: ticket('bestaat-niet', 'T4') })).status, 404);

  const { data } = await a('GET', '/api/tickets');
  assert.equal(data.tickets.length, 1);
  assert.equal(data.tickets[0].eventId, 'fest-a');
});

test('ontdekken toont alleen mensen van hetzelfde evenement met passende voorkeur', async () => {
  const me = await newUser({ gender: 'man', interestedIn: 'women' });
  const sameEvent = await newUser({ gender: 'woman', interestedIn: 'men' });
  const otherEvent = await newUser({ gender: 'woman', interestedIn: 'men' });
  const wrongPref = await newUser({ gender: 'woman', interestedIn: 'women' });
  const man = await newUser({ gender: 'man', interestedIn: 'everyone' });

  await me('POST', '/api/tickets', { code: ticket('fest-b', 'ME') });
  await sameEvent('POST', '/api/tickets', { code: ticket('fest-b', 'SAME') });
  await otherEvent('POST', '/api/tickets', { code: ticket('fest-a', 'OTHER') });
  await wrongPref('POST', '/api/tickets', { code: ticket('fest-b', 'WRONG') });
  await man('POST', '/api/tickets', { code: ticket('fest-b', 'MAN') });

  const { data } = await me('GET', '/api/discover');
  assert.deepEqual(data.profiles.map((p) => p.id), [sameEvent.user.id]);
  assert.equal(data.profiles[0].sharedEvents[0].id, 'fest-b');

  const swipeOther = await me('POST', '/api/swipes', { targetId: otherEvent.user.id, like: true });
  assert.equal(swipeOther.status, 403, 'geen swipe op iemand van een ander evenement');
});

test('wederzijdse like geeft een match, daarna kun je chatten en unmatchen', async () => {
  const a = await newUser({ gender: 'man', interestedIn: 'women' });
  const b = await newUser({ gender: 'woman', interestedIn: 'men' });
  const stranger = await newUser();
  await a('POST', '/api/tickets', { code: ticket('fest-a', 'MA') });
  await b('POST', '/api/tickets', { code: ticket('fest-a', 'MB') });

  const first = await a('POST', '/api/swipes', { targetId: b.user.id, like: true });
  assert.equal(first.data.match, null);
  const remaining = (await a('GET', '/api/discover')).data.profiles.map((p) => p.id);
  assert.ok(!remaining.includes(b.user.id), 'geswiped profiel verdwijnt');

  const second = await b('POST', '/api/swipes', { targetId: a.user.id, like: true });
  const matchId = second.data.match.id;
  assert.ok(matchId);
  assert.equal(second.data.match.user.id, a.user.id);

  const sent = await a('POST', `/api/matches/${matchId}/messages`, { body: 'Zien we elkaar bij de mainstage?' });
  assert.equal(sent.status, 201);
  const convo = await b('GET', `/api/matches/${matchId}/messages`);
  assert.equal(convo.data.messages.length, 1);
  assert.equal(convo.data.messages[0].senderId, a.user.id);

  assert.equal((await stranger('GET', `/api/matches/${matchId}/messages`)).status, 404, 'buitenstaander kan niet meelezen');

  const list = await b('GET', '/api/matches');
  assert.equal(list.data.matches[0].lastMessage.body, 'Zien we elkaar bij de mainstage?');

  assert.equal((await b('DELETE', `/api/matches/${matchId}`)).status, 204);
  assert.equal((await a('GET', '/api/matches')).data.matches.length, 0);
});

test('fitsInterest', () => {
  assert.ok(fitsInterest('everyone', 'nonbinary'));
  assert.ok(fitsInterest('men', 'man'));
  assert.ok(!fitsInterest('men', 'woman'));
  assert.ok(!fitsInterest('women', 'nonbinary'));
});
