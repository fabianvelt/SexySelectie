'use strict';

const view = document.getElementById('view');
const tabs = document.getElementById('tabs');
const badge = document.getElementById('badge');

const state = {
  me: null,
  stream: null,
  eventFilter: '',
  profiles: [],
  unread: new Set(),
  chatMatchId: null,
};

const GENDER_LABEL = { man: 'Man', woman: 'Vrouw', nonbinary: 'Non-binair' };
const INTEREST_LABEL = { men: 'Mannen', women: 'Vrouwen', everyone: 'Iedereen' };
const REPORT_REASONS = {
  fake: 'Nepprofiel of oplichting',
  inappropriate: 'Ongepaste foto of tekst',
  harassment: 'Intimidatie of bedreiging',
  underage: 'Lijkt jonger dan 18',
  other: 'Iets anders',
};

// ---------- Helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && path !== '/login') {
    logoutLocal();
    throw new Error('Log opnieuw in');
  }
  if (!res.ok) throw new Error(data?.error || 'Er ging iets mis');
  return data;
}

let toastTimer;
function toast(message, error = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

function avatar(user, cls = 'avatar') {
  return user.photo
    ? `<div class="${cls}" style="background-image:url('${esc(user.photo)}')"></div>`
    : `<div class="${cls}">${esc(user.name[0] || '?')}</div>`;
}

function formatDay(iso) {
  const d = new Date(iso);
  return { day: d.getDate(), month: d.toLocaleDateString('nl-NL', { month: 'short' }).replace('.', '') };
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// Onderin uitschuivend paneel. Sluit bij tik op de achtergrond.
function sheet(html) {
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML = `<div class="sheet">${html}</div>`;
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) el.remove();
  });
  document.body.appendChild(el);
  return el;
}

function openReport(user, onDone) {
  const el = sheet(`
    <h2>${esc(user.name)} melden</h2>
    <p class="muted">We bekijken elke melding. ${esc(user.name)} krijgt niet te zien dat jij het was, en jullie zien elkaar niet meer terug.</p>
    <form>
      ${Object.entries(REPORT_REASONS).map(([v, l], i) => `
        <label class="radio"><input type="radio" name="reason" value="${v}" ${i === 0 ? 'checked' : ''}> ${l}</label>`).join('')}
      <label>Toelichting (optioneel)<textarea name="details" maxlength="1000"></textarea></label>
      <button type="submit">Melden</button>
      <button type="button" class="secondary" data-close>Annuleren</button>
    </form>`);
  onSubmit(el.querySelector('form'), async (data) => {
    await api('/reports', { method: 'POST', body: { userId: user.id, ...data } });
    el.remove();
    toast('Bedankt voor je melding');
    onDone();
  });
}

function onSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    try {
      await handler(formData(form));
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });
}

// Verkleint een gekozen foto tot max 640px JPEG zodat hij klein genoeg is voor de API.
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 640 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('Kon de foto niet lezen'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Native app (Capacitor) ----------
// In de iOS/Android-app laadt Capacitor deze pagina en zet het een bridge klaar
// op window.Capacitor. Plugins roepen we direct via die bridge aan.

const Native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor : null;
const hasPlugin = (name) => !!Native?.PluginHeaders?.some((h) => h.name === name);
const nativeCall = (plugin, method, options = {}) => Native.nativePromise(plugin, method, options);

// ---------- Pushmeldingen ----------

const PUSH_TOKEN_KEY = 'ss_push_token';
let pendingRegistration = null;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* privémodus */ } },
  remove: (k) => { try { localStorage.removeItem(k); } catch { /* privémodus */ } },
};

function pushMode() {
  if (Native && hasPlugin('PushNotifications')) return 'native';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'web';
  return null;
}

const nativePushKind = () => (Native.getPlatform() === 'ios' ? 'apns' : 'fcm');

function base64UrlToUint8Array(value) {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// 'on' | 'off' | 'denied' | 'install' (iPhone: eerst op beginscherm) | 'unavailable'
async function pushStatus() {
  const mode = pushMode();
  if (!mode) return isIos() && !isStandalone() ? 'install' : 'unavailable';
  const config = await api('/push/config').catch(() => null);
  if (!config) return 'unavailable';

  if (mode === 'native') {
    if (!config.kinds.includes(nativePushKind())) return 'unavailable';
    const { receive } = await nativeCall('PushNotifications', 'checkPermissions');
    if (receive === 'denied') return 'denied';
    return receive === 'granted' && store.get(PUSH_TOKEN_KEY) ? 'on' : 'off';
  }

  if (!config.webPublicKey) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

async function enablePush() {
  if (pushMode() === 'native') {
    const { receive } = await nativeCall('PushNotifications', 'requestPermissions');
    if (receive !== 'granted') throw new Error('Meldingen staan uit in de instellingen van je telefoon');
    // Het token komt los binnen via het 'registration'-event; daar wachten we op.
    const registered = new Promise((resolve, reject) => {
      pendingRegistration = { resolve, reject };
      setTimeout(() => reject(new Error('Meldingen aanzetten duurde te lang, probeer het opnieuw')), 20000);
    });
    await nativeCall('PushNotifications', 'register');
    await registered;
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Meldingen zijn niet toegestaan in je browser');
  const { webPublicKey } = await api('/push/config');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(webPublicKey) });
  await api('/push/subscribe', { method: 'POST', body: { kind: 'web', token: sub.toJSON() } });
}

// Haalt dit apparaat weg bij het account (bij uitzetten en bij uitloggen).
async function disablePush() {
  if (pushMode() === 'native') {
    const token = store.get(PUSH_TOKEN_KEY);
    if (token) await api('/push/unsubscribe', { method: 'POST', body: { token } }).catch(() => {});
    store.remove(PUSH_TOKEN_KEY);
    await nativeCall('PushNotifications', 'unregister').catch(() => {});
    return;
  }
  if (pushMode() !== 'web') return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('/push/unsubscribe', { method: 'POST', body: { token: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

// Na inloggen: koppel een bestaand abonnement van dit apparaat aan wie er nu ingelogd is.
let pushSynced = false;
async function syncPush() {
  if (pushSynced) return;
  pushSynced = true;
  try {
    if (pushMode() === 'native') {
      const { receive } = await nativeCall('PushNotifications', 'checkPermissions');
      if (receive === 'granted' && store.get(PUSH_TOKEN_KEY)) await nativeCall('PushNotifications', 'register');
    } else if (pushMode() === 'web' && Notification.permission === 'granted') {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) await api('/push/subscribe', { method: 'POST', body: { kind: 'web', token: sub.toJSON() } });
    }
  } catch {
    /* niet erg: dan zet de gebruiker het opnieuw aan */
  }
}

if (Native && hasPlugin('PushNotifications')) {
  Native.addListener('PushNotifications', 'registration', async ({ value }) => {
    store.set(PUSH_TOKEN_KEY, value);
    try {
      if (state.me) await api('/push/subscribe', { method: 'POST', body: { kind: nativePushKind(), token: value } });
      pendingRegistration?.resolve();
    } catch (err) {
      pendingRegistration?.reject(err);
    }
    pendingRegistration = null;
  });
  Native.addListener('PushNotifications', 'registrationError', () => {
    const error = new Error('Meldingen aanzetten is mislukt');
    if (pendingRegistration) pendingRegistration.reject(error);
    else toast(error.message, true);
    pendingRegistration = null;
  });
  Native.addListener('PushNotifications', 'pushNotificationActionPerformed', ({ notification }) => {
    const url = notification?.data?.url;
    if (url?.startsWith('/#/')) location.hash = url.slice(1);
  });
}

// Tik op een webmelding terwijl de app al open is: de service worker stuurt de route door.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'navigate' && e.data.url?.startsWith('/#/')) location.hash = e.data.url.slice(1);
});

const PUSH_TEXT = {
  on: ['Meldingen staan aan', 'Je krijgt een melding bij een nieuwe match of een nieuw bericht.', 'Uitzetten'],
  off: ['Meldingen staan uit', 'Krijg een melding als je matcht of als iemand je een bericht stuurt.', 'Aanzetten'],
  denied: ['Meldingen geblokkeerd', 'Zet meldingen voor SexySelectie aan in de instellingen van je telefoon of browser.', null],
  install: ['Meldingen op iPhone', 'Zet de app eerst op je beginscherm (zie hieronder); daarna kun je meldingen aanzetten.', null],
  unavailable: ['Meldingen niet beschikbaar', 'Meldingen werken op dit apparaat (nog) niet.', null],
};

async function renderPushCard(container) {
  const status = await pushStatus().catch(() => 'unavailable');
  const [title, text, action] = PUSH_TEXT[status];
  container.innerHTML = `
    <div class="card">
      <strong>🔔 ${title}</strong>
      <p class="muted" style="margin:6px 0 0">${text}</p>
      ${action ? `<button class="${status === 'on' ? 'secondary' : ''} block" style="margin-top:12px" data-toggle>${action}</button>` : ''}
    </div>`;
  container.querySelector('[data-toggle]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      if (status === 'on') {
        await disablePush();
      } else {
        await enablePush();
        toast('Meldingen staan aan 🔔');
      }
    } catch (err) {
      toast(err.message, true);
    }
    renderPushCard(container);
  });
}

// ---------- Realtime ----------

function connectStream() {
  if (state.stream) return;
  const es = new EventSource('/api/stream');
  es.addEventListener('match', (e) => {
    const match = JSON.parse(e.data);
    state.unread.add(match.id);
    updateBadge();
    showMatch(match);
  });
  es.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (state.chatMatchId === msg.matchId) {
      appendMessage(msg);
    } else if (msg.senderId !== state.me?.id) {
      state.unread.add(msg.matchId);
      updateBadge();
      if (location.hash === '#/matches') renderMatches();
      toast('Nieuw bericht 💬');
    }
  });
  es.addEventListener('unmatch', (e) => {
    const { id } = JSON.parse(e.data);
    state.unread.delete(id);
    updateBadge();
    if (state.chatMatchId === id) {
      toast('Deze match is verbroken');
      location.hash = '#/matches';
    } else if (location.hash === '#/matches') {
      renderMatches();
    }
  });
  state.stream = es;
}

function updateBadge() {
  badge.hidden = state.unread.size === 0;
  badge.textContent = state.unread.size;
}

function logoutLocal() {
  state.me = null;
  pushSynced = false;
  state.stream?.close();
  state.stream = null;
  state.unread.clear();
  updateBadge();
  location.hash = '#/login';
}

// ---------- Router ----------

const routes = {
  login: renderLogin,
  registreer: renderRegister,
  ontdek: renderDiscover,
  tickets: renderTickets,
  matches: renderMatches,
  chat: renderChat,
  profiel: renderProfile,
};

async function router() {
  const [name = '', param] = location.hash.replace(/^#\/?/, '').split('/');
  const publicRoute = name === 'login' || name === 'registreer';

  if (!state.me && !publicRoute) {
    try {
      state.me = (await api('/me')).user;
    } catch {
      location.hash = '#/login';
      return;
    }
  }
  if (state.me && publicRoute) {
    location.hash = '#/ontdek';
    return;
  }
  if (state.me) {
    connectStream();
    syncPush();
  }

  const render = routes[name];
  if (!render) {
    location.hash = state.me ? '#/ontdek' : '#/login';
    return;
  }
  state.chatMatchId = null;
  tabs.hidden = publicRoute || name === 'chat';
  for (const a of tabs.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === name);
  window.scrollTo(0, 0);
  await render(param);
}

window.addEventListener('hashchange', router);

// ---------- Inloggen & registreren ----------

function renderLogin() {
  view.innerHTML = `
    <div class="hero">
      <h1 class="brand">SexySelectie</h1>
      <p class="muted">Scan je ticket. Swipe op wie er ook is. Match vóór de eerste act.</p>
    </div>
    <form class="card">
      <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
      <label>Wachtwoord<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Inloggen</button>
    </form>
    <p class="center" style="margin-top:16px">Nog geen account? <a href="#/registreer" class="brand">Maak er een</a></p>`;
  onSubmit(view.querySelector('form'), async (data) => {
    state.me = (await api('/login', { method: 'POST', body: data })).user;
    location.hash = '#/ontdek';
  });
}

function renderRegister() {
  view.innerHTML = `
    <div class="hero" style="padding-bottom:12px">
      <h1 class="brand">Account maken</h1>
      <p class="muted">Je moet 18+ zijn.</p>
    </div>
    <form class="card">
      <label>Voornaam<input name="name" maxlength="40" autocomplete="given-name" required></label>
      <label>E-mail<input name="email" type="email" autocomplete="email" required></label>
      <label>Wachtwoord (min. 8 tekens)<input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <label>Geboortedatum<input name="birthdate" type="date" required></label>
      <div class="row">
        <label>Ik ben
          <select name="gender">${Object.entries(GENDER_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        </label>
        <label>Ik zoek
          <select name="interestedIn">${Object.entries(INTEREST_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        </label>
      </div>
      <label>Over jou<textarea name="bio" maxlength="300" placeholder="Welke acts mag je niet missen?"></textarea></label>
      <label class="radio"><input type="checkbox" name="terms" required>
        <span>Ik ben 18+, ga akkoord met de <a href="/voorwaarden.html" target="_blank">voorwaarden</a> en geef toestemming om mijn voorkeur te gebruiken zoals in de <a href="/privacy.html" target="_blank">privacyverklaring</a> staat</span></label>
      <button type="submit">Account maken</button>
    </form>
    <p class="center" style="margin-top:16px">Al een account? <a href="#/login" class="brand">Inloggen</a></p>`;
  onSubmit(view.querySelector('form'), async (data) => {
    delete data.terms;
    state.me = (await api('/register', { method: 'POST', body: data })).user;
    toast('Welkom! Scan nu je eerste ticket 🎟️');
    location.hash = '#/tickets';
  });
}

// ---------- Ontdek (swipen) ----------

async function renderDiscover() {
  view.innerHTML = '<p class="muted center">Laden…</p>';
  const [{ tickets }, discover] = await Promise.all([
    api('/tickets'),
    api(`/discover${state.eventFilter ? `?eventId=${encodeURIComponent(state.eventFilter)}` : ''}`),
  ]);
  const active = tickets.filter((t) => !t.past);
  if (state.eventFilter && !active.some((t) => t.eventId === state.eventFilter)) state.eventFilter = '';

  if (!active.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="icon">🎟️</div>
        <h2>Scan eerst je ticket</h2>
        <p class="muted">Je ziet alleen mensen die naar hetzelfde festival of feest gaan als jij.</p>
        <a class="btn" href="#/tickets">Ticket scannen</a>
      </div>`;
    return;
  }

  state.profiles = discover.profiles;
  view.innerHTML = `
    <div class="chips">
      <button class="chip ${state.eventFilter ? '' : 'active'}" data-event="">Alle evenementen</button>
      ${active.map((t) => `<button class="chip ${state.eventFilter === t.eventId ? 'active' : ''}" data-event="${esc(t.eventId)}">${esc(t.name)}</button>`).join('')}
    </div>
    <div class="deck"></div>
    <div class="actions">
      <button class="nope" aria-label="Nee">✕</button>
      <button class="like" aria-label="Ja">♥</button>
    </div>`;

  view.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.eventFilter = chip.dataset.event;
      renderDiscover();
    }));
  view.querySelector('.actions .nope').addEventListener('click', () => swipeTop(false));
  view.querySelector('.actions .like').addEventListener('click', () => swipeTop(true));
  renderDeck();
}

function renderDeck() {
  const deck = view.querySelector('.deck');
  if (!deck) return;
  const actions = view.querySelector('.actions');
  if (!state.profiles.length) {
    actions.hidden = true;
    deck.innerHTML = `
      <div class="empty">
        <div class="icon">🌙</div>
        <h2>Even niemand meer</h2>
        <p class="muted">Je hebt iedereen gezien. Kom later terug — er scannen steeds meer mensen hun ticket.</p>
        <button class="secondary" id="reload">Opnieuw laden</button>
      </div>`;
    deck.querySelector('#reload').addEventListener('click', renderDiscover);
    return;
  }
  actions.hidden = false;
  // Twee kaarten renderen zodat de volgende al klaarligt onder de bovenste.
  deck.innerHTML = state.profiles.slice(0, 2).reverse().map((p) => `
    <div class="profile-card" data-id="${p.id}">
      ${p.photo ? `<div class="photo" style="background-image:url('${esc(p.photo)}')"></div>` : `<div class="avatar-fallback">${esc(p.name[0])}</div>`}
      <div class="shade"></div>
      <div class="stamp like">LIKE</div>
      <div class="stamp nope">NOPE</div>
      <button class="flag" data-report aria-label="Melden">⚑</button>
      <div class="info">
        <h2>${esc(p.name)} <small>${p.age}</small></h2>
        <div class="events">${p.sharedEvents.map((e) => `<span>🎪 ${esc(e.name)}</span>`).join('')}</div>
        ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
      </div>
    </div>`).join('');
  const top = deck.lastElementChild;
  const flag = top.querySelector('[data-report]');
  flag.addEventListener('pointerdown', (e) => e.stopPropagation());
  flag.addEventListener('click', () => {
    const profile = state.profiles[0];
    openReport(profile, () => {
      state.profiles = state.profiles.filter((p) => p.id !== profile.id);
      renderDeck();
    });
  });
  enableDrag(top);
}

function enableDrag(card) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
  const like = card.querySelector('.stamp.like');
  const nope = card.querySelector('.stamp.nope');

  card.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 15}deg)`;
    like.style.opacity = Math.max(0, Math.min(1, dx / 100));
    nope.style.opacity = Math.max(0, Math.min(1, -dx / 100));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    if (Math.abs(dx) > 110) {
      swipeTop(dx > 0);
    } else {
      card.style.transform = '';
      like.style.opacity = nope.style.opacity = 0;
    }
    dx = dy = 0;
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

let swiping = false;
async function swipeTop(like) {
  if (swiping || !state.profiles.length) return;
  swiping = true;
  const profile = state.profiles[0];
  const card = view.querySelector(`.profile-card[data-id="${profile.id}"]`);
  if (card) {
    card.querySelector(`.stamp.${like ? 'like' : 'nope'}`).style.opacity = 1;
    card.style.transform = `translate(${like ? 600 : -600}px, 40px) rotate(${like ? 30 : -30}deg)`;
  }
  try {
    const { match } = await api('/swipes', { method: 'POST', body: { targetId: profile.id, like } });
    await new Promise((r) => setTimeout(r, 250));
    state.profiles.shift();
    renderDeck();
    if (match) showMatch(match);
  } catch (err) {
    toast(err.message, true);
    renderDeck();
  } finally {
    swiping = false;
  }
}

function showMatch(match) {
  document.querySelector('.overlay')?.remove();
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `
    <h1 class="brand">It's a match!</h1>
    <div class="pair">${avatar(state.me)}${avatar(match.user)}</div>
    <p>Jij en ${esc(match.user.name)} gaan allebei naar <strong>${esc(match.sharedEvents.map((e) => e.name).join(' & ') || 'hetzelfde evenement')}</strong>.</p>
    <button class="block" data-go>Stuur een bericht</button>
    <button class="secondary block" data-close>Verder swipen</button>`;
  el.querySelector('[data-go]').addEventListener('click', () => {
    el.remove();
    location.hash = `#/chat/${match.id}`;
  });
  el.querySelector('[data-close]').addEventListener('click', () => el.remove());
  document.body.appendChild(el);
}

// ---------- Tickets ----------

async function renderTickets() {
  const { tickets } = await api('/tickets');
  view.innerHTML = `
    <h1>Mijn tickets</h1>
    <p class="muted">Scan de QR-code of barcode van je ticket. Je ziet daarna alleen mensen die naar dezelfde evenementen gaan.</p>
    <button class="block" id="scan">📷 Ticket scannen</button>
    <form id="manual" style="margin:12px 0 24px">
      <div class="row">
        <input name="code" placeholder="Of voer de ticketcode in" autocomplete="off" required>
        <button type="submit" class="secondary" style="flex:none">Toevoegen</button>
      </div>
    </form>
    <div class="stack">
      ${tickets.length ? tickets.map((t) => {
        const { day, month } = formatDay(t.startsAt);
        return `
          <div class="card ticket ${t.past ? 'past' : ''}">
            <div class="date">${day}<small>${esc(month)}</small></div>
            <div class="meta">
              <strong>${esc(t.name)}</strong>
              <span class="muted">${esc(t.venue)}, ${esc(t.city)}</span><br>
              <small class="muted">${t.past ? 'Afgelopen' : `${t.others} ${t.others === 1 ? 'ander' : 'anderen'} met een ticket`}</small>
            </div>
            <button data-remove="${t.id}" aria-label="Verwijderen">🗑️</button>
          </div>`;
      }).join('') : '<p class="muted center">Nog geen tickets gescand.</p>'}
    </div>`;

  view.querySelector('#scan').addEventListener('click', openScanner);
  onSubmit(view.querySelector('#manual'), ({ code }) => addTicket(code));
  view.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Ticket verwijderen? Je ziet dan geen mensen meer van dit evenement.')) return;
      try {
        await api(`/tickets/${b.dataset.remove}`, { method: 'DELETE' });
        renderTickets();
      } catch (err) {
        toast(err.message, true);
      }
    }));
}

async function addTicket(code) {
  const { event } = await api('/tickets', { method: 'POST', body: { code } });
  toast(`🎉 Ticket voor ${event.name} toegevoegd!`);
  if (location.hash === '#/tickets') renderTickets();
}

let jsQRPromise;
function loadJsQR() {
  jsQRPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => reject(new Error('Kon de QR-scanner niet laden'));
    document.head.appendChild(s);
  });
  return jsQRPromise;
}

// Scanner van de iOS/Android-app zelf: sneller, en leest ook de barcodes die op
// veel e-tickets staan (pdf417, aztec, code128), niet alleen QR-codes.
async function nativeScan() {
  const { ScanResult } = await nativeCall('CapacitorBarcodeScanner', 'scanBarcode', {
    hint: 17, // alle formaten
    scanInstructions: 'Richt je camera op de QR-code of barcode van je ticket',
    scanOrientation: 1, // staand
    android: { scanningLibrary: 'mlkit' },
  });
  return ScanResult || null;
}

async function openScanner() {
  if (Native && hasPlugin('CapacitorBarcodeScanner')) {
    try {
      const code = await nativeScan();
      if (code) await addTicket(code);
    } catch (err) {
      if (!/cancel/i.test(err.message)) toast(err.message, true);
    }
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'scanner';
  overlay.innerHTML = `
    <video playsinline muted></video>
    <div class="frame"></div>
    <div class="bar">
      <p>Richt je camera op de QR-code of barcode van je ticket</p>
      <button class="secondary" data-close>Annuleren</button>
    </div>`;
  document.body.appendChild(overlay);

  let stream;
  let stopped = false;
  const close = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  };
  overlay.querySelector('[data-close]').addEventListener('click', close);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    close();
    toast('Geen toegang tot de camera. Voer de code handmatig in.', true);
    return;
  }
  const video = overlay.querySelector('video');
  video.srcObject = stream;
  await video.play();

  let detect;
  if ('BarcodeDetector' in window) {
    const detector = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'pdf417', 'aztec', 'data_matrix'] });
    detect = async () => (await detector.detect(video))[0]?.rawValue;
  } else {
    const jsQR = await loadJsQR().catch((err) => {
      close();
      toast(err.message, true);
    });
    if (!jsQR) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    detect = async () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
    };
  }

  const tick = async () => {
    if (stopped) return;
    const code = video.readyState >= 2 ? await detect().catch(() => null) : null;
    if (code) {
      close();
      try {
        await addTicket(code);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}

// ---------- Matches ----------

async function renderMatches() {
  const { matches } = await api('/matches');
  const fresh = matches.filter((m) => !m.lastMessage);
  const conversations = matches.filter((m) => m.lastMessage);

  if (!matches.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="icon">💘</div>
        <h2>Nog geen matches</h2>
        <p class="muted">Swipe naar rechts op mensen die je leuk vindt. Als het wederzijds is, kun je hier chatten.</p>
        <a class="btn" href="#/ontdek">Begin met swipen</a>
      </div>`;
    return;
  }

  view.innerHTML = `
    <h1>Matches</h1>
    <div id="push-banner"></div>
    ${fresh.length ? `
      <h3 class="muted">Nieuwe matches</h3>
      <div class="new-matches">
        ${fresh.map((m) => `<a href="#/chat/${m.id}">${avatar(m.user)}${esc(m.user.name)}</a>`).join('')}
      </div>` : ''}
    ${conversations.length ? `<h3 class="muted">Berichten</h3>` : ''}
    ${conversations.map((m) => `
      <a class="conversation" href="#/chat/${m.id}">
        ${avatar(m.user)}
        <div class="meta">
          <strong>${esc(m.user.name)}</strong> ${state.unread.has(m.id) ? '<span class="brand">●</span>' : ''}
          <p>${m.lastMessage.senderId === state.me.id ? 'Jij: ' : ''}${esc(m.lastMessage.body)}</p>
        </div>
      </a>`).join('')}`;

  // Alleen een herinnering tonen als meldingen nog uit staan.
  const banner = view.querySelector('#push-banner');
  if ((await pushStatus().catch(() => null)) === 'off') {
    banner.style.marginBottom = '16px';
    renderPushCard(banner);
  }
}

// ---------- Chat ----------

async function renderChat(matchId) {
  const id = Number(matchId);
  let data;
  try {
    data = await api(`/matches/${id}/messages`);
  } catch (err) {
    toast(err.message, true);
    location.hash = '#/matches';
    return;
  }
  const { match, messages } = data;
  state.chatMatchId = id;
  state.unread.delete(id);
  updateBadge();

  view.innerHTML = `
    <div class="chat">
      <header>
        <a class="back" href="#/matches" aria-label="Terug">‹</a>
        ${avatar(match.user)}
        <div class="meta">
          <strong>${esc(match.user.name)}, ${match.user.age}</strong>
          <small>🎪 ${esc(match.sharedEvents.map((e) => e.name).join(', ') || 'Geen gedeelde evenementen meer')}</small>
        </div>
        <button class="link" data-menu aria-label="Opties">•••</button>
      </header>
      <div class="messages">
        <p class="intro">Jullie matchten via ${esc(match.sharedEvents[0]?.name || 'SexySelectie')}. Spreek af bij een podium! 🎶</p>
      </div>
      <form>
        <input name="body" placeholder="Typ een bericht…" autocomplete="off" maxlength="1000" required>
        <button type="submit">Stuur</button>
      </form>
    </div>`;

  messages.forEach(appendMessage);

  const form = view.querySelector('.chat form');
  onSubmit(form, async ({ body }) => {
    const { message } = await api(`/matches/${id}/messages`, { method: 'POST', body: { body } });
    form.reset();
    appendMessage(message);
  });
  form.querySelector('input').focus();

  const leave = () => (location.hash = '#/matches');
  view.querySelector('[data-menu]').addEventListener('click', () => {
    const menu = sheet(`
      <button class="secondary block" data-unmatch>Unmatchen</button>
      <button class="secondary block" data-block>${esc(match.user.name)} blokkeren</button>
      <button class="secondary block danger" data-report>${esc(match.user.name)} melden</button>
      <button class="link block" data-close>Annuleren</button>`);
    const run = (fn) => async () => {
      try {
        await fn();
        menu.remove();
      } catch (err) {
        toast(err.message, true);
      }
    };
    menu.querySelector('[data-unmatch]').addEventListener('click', run(async () => {
      if (!confirm(`${match.user.name} unmatchen? Jullie chat wordt verwijderd.`)) return;
      await api(`/matches/${id}`, { method: 'DELETE' });
      leave();
    }));
    menu.querySelector('[data-block]').addEventListener('click', run(async () => {
      if (!confirm(`${match.user.name} blokkeren? Jullie zien elkaar nergens meer terug.`)) return;
      await api('/blocks', { method: 'POST', body: { userId: match.user.id } });
      toast(`${match.user.name} is geblokkeerd`);
      leave();
    }));
    menu.querySelector('[data-report]').addEventListener('click', () => {
      menu.remove();
      openReport(match.user, leave);
    });
  });
}

function appendMessage(msg) {
  const list = view.querySelector('.chat .messages');
  if (!list || list.querySelector(`[data-msg="${msg.id}"]`)) return;
  list.querySelector('.intro')?.remove();
  const el = document.createElement('div');
  el.className = `bubble ${msg.senderId === state.me.id ? 'mine' : ''}`;
  el.dataset.msg = msg.id;
  el.innerHTML = `${esc(msg.body)}<time>${formatTime(msg.createdAt)}</time>`;
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

// ---------- Profiel ----------

function renderProfile() {
  const me = state.me;
  let photo = me.photo;
  view.innerHTML = `
    <h1>Profiel</h1>
    <form class="card">
      <div class="photo-picker">
        <div id="photo-preview">${avatar(me)}</div>
        <div class="stack" style="gap:4px">
          <label class="btn secondary" style="color:var(--text);background:var(--surface-2)">Foto kiezen
            <input type="file" accept="image/*" hidden>
          </label>
          ${me.photo ? '<button type="button" class="link" data-remove-photo>Foto verwijderen</button>' : ''}
        </div>
      </div>
      <label>Voornaam<input name="name" value="${esc(me.name)}" maxlength="40" required></label>
      <div class="row">
        <label>Ik ben
          <select name="gender">${Object.entries(GENDER_LABEL).map(([v, l]) => `<option value="${v}" ${me.gender === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label>Ik zoek
          <select name="interestedIn">${Object.entries(INTEREST_LABEL).map(([v, l]) => `<option value="${v}" ${me.interestedIn === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
      </div>
      <label>Over jou<textarea name="bio" maxlength="300">${esc(me.bio)}</textarea></label>
      <p class="muted" style="margin:0">${esc(me.email)} · ${me.age} jaar</p>
      <button type="submit">Opslaan</button>
    </form>
    <div id="push-card" style="margin-top:16px"></div>
    ${installHelp()}
    <div class="stack" style="margin-top:16px">
      <button class="secondary block" id="logout">Uitloggen</button>
      <p class="center muted links">
        <a href="/voorwaarden.html" target="_blank">Voorwaarden</a> ·
        <a href="/privacy.html" target="_blank">Privacy</a> ·
        <button class="link" id="delete-account">Account verwijderen</button>
      </p>
    </div>`;

  const preview = view.querySelector('#photo-preview');
  view.querySelector('input[type=file]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      photo = await resizePhoto(file);
      preview.innerHTML = avatar({ ...me, photo });
    } catch (err) {
      toast(err.message, true);
    }
  });
  view.querySelector('[data-remove-photo]')?.addEventListener('click', () => {
    photo = null;
    preview.innerHTML = avatar({ ...me, photo: null });
  });

  onSubmit(view.querySelector('form'), async (data) => {
    state.me = (await api('/me', { method: 'PUT', body: { ...data, photo } })).user;
    toast('Profiel opgeslagen');
    renderProfile();
  });

  view.querySelector('#logout').addEventListener('click', async () => {
    await disablePush().catch(() => {});
    await api('/logout', { method: 'POST' }).catch(() => {});
    logoutLocal();
  });

  bindInstallButton();
  renderPushCard(view.querySelector('#push-card'));

  view.querySelector('#delete-account').addEventListener('click', () => {
    const el = sheet(`
      <h2>Account verwijderen</h2>
      <p class="muted">Je profiel, foto, tickets, matches en chats worden direct en definitief verwijderd. Dit kan niet ongedaan worden.</p>
      <form>
        <label>Bevestig met je wachtwoord<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit" class="danger">Definitief verwijderen</button>
        <button type="button" class="secondary" data-close>Annuleren</button>
      </form>`);
    onSubmit(el.querySelector('form'), async ({ password }) => {
      await api('/me', { method: 'DELETE', body: { password } });
      el.remove();
      logoutLocal();
      toast('Je account is verwijderd');
    });
  });
}

// ---------- Installeren op je telefoon (PWA) ----------

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function installHelp() {
  if (isStandalone() || Native) return '';
  const how = isIos()
    ? 'Tik in Safari op <strong>Deel</strong> (□↑) en kies <strong>Zet op beginscherm</strong>.'
    : 'Open het browsermenu (⋮) en kies <strong>App installeren</strong> of <strong>Toevoegen aan startscherm</strong>.';
  return `
    <div class="card install" style="margin-top:16px">
      <strong>📲 Zet SexySelectie op je beginscherm</strong>
      <p class="muted" style="margin:6px 0 0">${how}</p>
      ${isIos() ? '' : '<button class="block" id="install" style="margin-top:12px" hidden>Installeren</button>'}
    </div>`;
}

function bindInstallButton() {
  const button = view.querySelector('#install');
  if (!button || !installPrompt) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    renderProfile();
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

router();
