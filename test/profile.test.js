const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createTicketCode } = require('../server/tickets');

const SECRET = 'test-secret';
let server;
let baseUrl;
let db;

before(async () => {
  db = openDb(':memory:');
  const ins = db.prepare('INSERT INTO events (id, name, venue, city, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)');
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
  ins.run('fest', 'Festival', 'Park', 'Utrecht', day(2), day(4));
  ins.run('ander', 'Ander Feest', 'Hal', 'Delft', day(5), day(6));
  const act = db.prepare('INSERT INTO acts (event_id, name) VALUES (?, ?)');
  for (const name of ['Nova Lux', 'Kaapse Kade', 'De Nachtploeg', 'Mira Sol']) act.run('fest', name);
  act.run('ander', 'Elders');
  server = createApp({ db, ticketSecret: SECRET, mailer: { send: async () => {} } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = res.status === 204 ? null : type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return call;
}

let n = 0;
async function newUser(gender = 'woman', interestedIn = 'everyone') {
  const c = client();
  n++;
  const res = await c('POST', '/api/register', {
    email: `prof${n}@test.nl`, password: 'wachtwoord', name: `Prof${n}`, birthdate: '1996-06-06', gender, interestedIn,
  });
  c.user = res.data.user;
  db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(c.user.id);
  await c('POST', '/api/tickets', { code: createTicketCode(SECRET, 'fest', `F${n}`) });
  return c;
}

// Kleinste "JPEG" die door de controle komt: begint met FF D8.
const jpeg = (tag) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]).toString('base64')}`;
const idOf = (url) => url.split('/').pop();

test("foto's: toevoegen, maximaal 6, alleen echte afbeeldingen", async () => {
  const c = await newUser();
  assert.equal((await c('POST', '/api/me/photos', { photo: 'data:image/jpeg;base64,' + Buffer.from('<html>').toString('base64') })).status, 400);
  assert.equal((await c('POST', '/api/me/photos', { photo: 'data:text/html;base64,PGh0bWw+' })).status, 400);
  let user;
  for (let i = 0; i < 6; i++) user = (await c('POST', '/api/me/photos', { photo: jpeg(`foto${i}`) })).data.user;
  assert.equal(user.photos.length, 6);
  assert.equal(user.photo, user.photos[0], 'hoofdfoto is de eerste');
  assert.equal((await c('POST', '/api/me/photos', { photo: jpeg('zevende') })).status, 400);
});

test("foto's ophalen: alleen ingelogd, juiste inhoud en cache-header", async () => {
  const c = await newUser();
  const { user } = (await c('POST', '/api/me/photos', { photo: jpeg('inhoud') })).data;
  const anon = await client()('GET', user.photos[0]);
  assert.equal(anon.status, 401);
  const other = await newUser();
  const res = await other('GET', user.photos[0]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.ok(res.data.includes(Buffer.from('inhoud')));
  assert.ok(idOf(user.photos[0]).length >= 16, 'id is niet te raden');
});

test("foto's: volgorde wijzigen en verwijderen, niet die van een ander", async () => {
  const c = await newUser();
  for (const t of ['a', 'b', 'c']) await c('POST', '/api/me/photos', { photo: jpeg(t) });
  const before = (await c('GET', '/api/me')).data.user.photos;
  const reordered = (await c('PUT', '/api/me/photos', { order: [before[2], before[0], before[1]] })).data.user.photos;
  assert.deepEqual(reordered, [before[2], before[0], before[1]]);
  assert.equal((await c('PUT', '/api/me/photos', { order: [before[0]] })).status, 400, 'alle foto\'s moeten erin');

  const other = await newUser();
  assert.equal((await other('DELETE', `/api/me/photos/${idOf(before[0])}`)).status, 404);
  const after = (await c('DELETE', `/api/me/photos/${idOf(before[2])}`)).data.user.photos;
  assert.deepEqual(after, [before[0], before[1]]);
});

test('line-up: kiezen kan alleen met ticket en alleen acts van dat evenement', async () => {
  const c = await newUser();
  const { data } = await c('GET', '/api/events/fest/lineup');
  assert.equal(data.acts.length, 4);
  assert.ok(data.acts.every((a) => a.selected === false));
  const nova = data.acts.find((a) => a.name === 'Nova Lux').id;
  const elders = db.prepare("SELECT id FROM acts WHERE name = 'Elders'").get().id;

  assert.equal((await c('PUT', '/api/events/ander/lineup', { actIds: [elders] })).status, 403, 'geen ticket voor ander');
  assert.equal((await c('PUT', '/api/events/fest/lineup', { actIds: [elders] })).status, 400, 'act van ander evenement');
  assert.equal((await c('PUT', '/api/events/fest/lineup', { actIds: [nova, nova] })).data.selected, 1);
  assert.ok((await c('GET', '/api/events/fest/lineup')).data.acts.find((a) => a.id === nova).selected);
  const ticket = (await c('GET', '/api/tickets')).data.tickets[0];
  assert.equal(ticket.lineupSize, 4);
  assert.equal(ticket.myActs, 1);
});

test('ontdekken: gedeelde acts staan op de kaart en die mensen komen eerst', async () => {
  const me = await newUser('man', 'women');
  const noMatch = await newUser('woman', 'men');
  const sameActs = await newUser('woman', 'men');
  const acts = Object.fromEntries((await me('GET', '/api/events/fest/lineup')).data.acts.map((a) => [a.name, a.id]));
  await me('PUT', '/api/events/fest/lineup', { actIds: [acts['Nova Lux'], acts['Mira Sol']] });
  await sameActs('PUT', '/api/events/fest/lineup', { actIds: [acts['Mira Sol'], acts['Kaapse Kade']] });
  await noMatch('PUT', '/api/events/fest/lineup', { actIds: [acts['De Nachtploeg']] });
  await sameActs('POST', '/api/me/photos', { photo: jpeg('x') });

  // Kijk alleen naar de twee personen van deze test.
  const profiles = (await me('GET', '/api/discover')).data.profiles.filter((p) => [noMatch.user.id, sameActs.user.id].includes(p.id));
  assert.equal(profiles[0].id, sameActs.user.id, 'gedeelde act eerst');
  assert.deepEqual(profiles[0].sharedActs, ['Mira Sol']);
  assert.equal(profiles[0].photos.length, 1);
  assert.deepEqual(profiles[1].sharedActs, []);

  await sameActs('POST', '/api/swipes', { targetId: me.user.id, like: true });
  const { match } = (await me('POST', '/api/swipes', { targetId: sameActs.user.id, like: true })).data;
  assert.deepEqual(match.sharedActs, ['Mira Sol']);
  const chat = (await me('GET', `/api/matches/${match.id}/messages`)).data;
  assert.deepEqual(chat.match.sharedActs, ['Mira Sol']);
});

test('migratie: oude profielfoto uit users.photo verhuist naar de fototabel', () => {
  const { DatabaseSync } = require('node:sqlite');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fotomig-')), 'oud.db');
  openDb(file).close();
  const raw = new DatabaseSync(file);
  raw.prepare(`INSERT INTO users (email, password_hash, name, birthdate, gender, interested_in, photo)
               VALUES ('foto@test.nl', 'x', 'Foto', '1990-01-01', 'man', 'women', ?)`).run(jpeg('oud'));
  raw.close();
  const migrated = openDb(file);
  const user = migrated.prepare('SELECT id, photo FROM users').get();
  assert.equal(user.photo, null);
  const photo = migrated.prepare('SELECT * FROM photos WHERE user_id = ?').get(user.id);
  assert.equal(photo.mime, 'image/jpeg');
  assert.ok(Buffer.from(photo.data).includes(Buffer.from('oud')));
  migrated.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
