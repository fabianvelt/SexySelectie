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

// ---------- Iconen ----------
// Dunne lijniconen (24x24), kleur volgt de tekstkleur.
const ICONS = {
  cards: '<rect x="7.5" y="3" width="12.5" height="16.5" rx="2.5"/><path d="M4.5 7v10.5a3 3 0 0 0 3 3H15"/>',
  ticket: '<path d="M3.5 7.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2V10a2 2 0 0 0 0 4v2.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V14a2 2 0 0 0 0-4Z"/><path d="M14.5 5.5v2.5M14.5 11v2M14.5 16v2.5"/>',
  chat: '<path d="M20.5 11.5a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1.4-4.4A8.5 8.5 0 1 1 20.5 11.5Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5a8 8 0 0 1 16 0"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.4A4.1 4.1 0 0 1 12 7.2a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20Z"/>',
  flag: '<path d="M5.5 21V4M5.5 4h11l-2.2 4 2.2 4h-11"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  scan: '<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M4 12h16"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12M9.5 7V4.5h5V7"/>',
  send: '<path d="M12 19V5.5M6 11.5l6-6 6 6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15L6 16.5ZM10 21h4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

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

function fallbackStyle(user) {
  const light = 34 + ((user.id || 0) * 7) % 22;
  const angle = ((user.id || 0) * 47) % 360;
  return `background: radial-gradient(130% 100% at ${50 + Math.cos(angle) * 30}% 15%, hsl(0 0% ${light}%), #141414 72%)`;
}

function avatar(user, cls = 'avatar') {
  return user.photo
    ? `<div class="${cls}" style="background-image:url('${esc(user.photo)}')"></div>`
    : `<div class="${cls}" style="${fallbackStyle(user)}">${esc(user.name[0] || '?')}</div>`;
}

// "14:32" voor vandaag, anders "ma" of "12 okt".
function shortWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(iso);
  if (now - d < 6 * 86400000) return d.toLocaleDateString('nl-NL', { weekday: 'short' });
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
}

// "wo 7 okt · Zomerzon Festival over 8 dagen"
function eventLine(tickets) {
  const today = new Date().toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '');
  const next = tickets.find((t) => !t.past);
  if (!next) return today;
  const startOfDay = (t) => new Date(t).setHours(0, 0, 0, 0);
  if (Date.parse(next.startsAt) <= Date.now()) return `${today} · nu: ${next.name}`;
  const days = Math.round((startOfDay(next.startsAt) - startOfDay(Date.now())) / 86400000);
  const when = days === 0 ? 'vandaag' : days === 1 ? 'morgen' : `over ${days} dagen`;
  return `${today} · ${next.name} ${when}`;
}

function emptyState(iconName, title, text, action = '') {
  return `
    <div class="empty">
      <div class="icon">${icon(iconName)}</div>
      <h2>${title}</h2>
      <p class="muted">${text}</p>
      ${action}
    </div>`;
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

// Verkleint een gekozen foto tot max 960px JPEG zodat hij klein genoeg is voor de API.
function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 960 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
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
      <strong style="display:flex;align-items:center;gap:8px">${icon('bell')} ${title}</strong>
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
        toast('Meldingen staan aan');
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
      toast('Nieuw bericht');
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
    <div class="auth">
      <div class="hero">
        <h1>Sexy<em>Selectie</em></h1>
        <p>Scan je ticket. Zie wie er ook gaat. Match vóór de eerste act.</p>
      </div>
      <form>
        <input name="email" type="email" autocomplete="email" placeholder="E-mailadres" aria-label="E-mailadres" required>
        <input name="password" type="password" autocomplete="current-password" placeholder="Wachtwoord" aria-label="Wachtwoord" required>
        <button type="submit" class="block">Inloggen</button>
      </form>
      <p class="switch">Nog geen account? <a href="#/registreer">Maak er een</a></p>
    </div>`;
  onSubmit(view.querySelector('form'), async (data) => {
    state.me = (await api('/login', { method: 'POST', body: data })).user;
    location.hash = '#/ontdek';
  });
}

function renderRegister() {
  view.innerHTML = `
    <div class="auth">
    <div class="hero" style="padding:32px 0 24px">
      <h1>Wie ben <em>jij?</em></h1>
      <p>Een paar dingen over jou. Je foto voeg je straks toe in je profiel.</p>
    </div>
    <form>
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
      <button type="submit" class="block">Account maken</button>
    </form>
    <p class="switch">Al een account? <a href="#/login">Inloggen</a></p>
    </div>`;
  onSubmit(view.querySelector('form'), async (data) => {
    delete data.terms;
    state.me = (await api('/register', { method: 'POST', body: data })).user;
    toast('Welkom. Scan nu je eerste ticket.');
    location.hash = '#/tickets';
  });
}

// ---------- Ontdek (swipen) ----------

async function renderDiscover() {
  const [{ tickets }, discover] = await Promise.all([
    api('/tickets'),
    api(`/discover${state.eventFilter ? `?eventId=${encodeURIComponent(state.eventFilter)}` : ''}`),
  ]);
  const active = tickets.filter((t) => !t.past);
  if (state.eventFilter && !active.some((t) => t.eventId === state.eventFilter)) state.eventFilter = '';

  const head = `
    <header class="page-head">
      <div>
        <h1>${greeting()}, <em>${esc(state.me.name)}</em></h1>
        <span class="eyebrow">${esc(eventLine(tickets))}</span>
      </div>
      <a class="btn icon-btn" href="#/tickets" aria-label="Tickets">${icon('ticket')}</a>
    </header>`;

  if (!active.length) {
    view.innerHTML = head + emptyState('ticket', 'Scan eerst je ticket',
      'Je ziet alleen mensen die naar hetzelfde festival of feest gaan als jij.',
      `<a class="btn" href="#/tickets">${icon('scan')} Ticket scannen</a>`);
    return;
  }

  state.profiles = discover.profiles;
  view.innerHTML = `
    ${head}
    ${active.length > 1 ? `
      <div class="chips">
        <button class="chip ${state.eventFilter ? '' : 'active'}" data-event="">Alles</button>
        ${active.map((t) => `<button class="chip ${state.eventFilter === t.eventId ? 'active' : ''}" data-event="${esc(t.eventId)}">${esc(t.name)}</button>`).join('')}
      </div>` : ''}
    <div class="deck"></div>`;

  view.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.eventFilter = chip.dataset.event;
      renderDiscover();
    }));
  renderDeck();
}

function profileCard(p, isNext) {
  return `
    <div class="profile-card ${isNext ? 'next' : ''}" data-id="${p.id}">
      ${p.photo
        ? `<div class="photo" style="background-image:url('${esc(p.photo)}')"></div>`
        : `<div class="avatar-fallback" style="${fallbackStyle(p)}">${esc(p.name[0])}</div>`}
      <div class="shade"></div>
      <div class="stamp like">Ja</div>
      <div class="stamp nope">Nee</div>
      <div class="top">
        <div class="events">${p.sharedEvents.map((e) => `<span class="pill glass">${icon('ticket')}${esc(e.name)}</span>`).join('')}</div>
        <button class="flag glass" data-report aria-label="${esc(p.name)} melden">${icon('flag')}</button>
      </div>
      <div class="bottom">
        <div class="who">
          <h2>${esc(p.name)}<small>${p.age}</small></h2>
          ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
        </div>
        <div class="choices">
          <button class="glass nope" data-choice="nope" aria-label="Nee">${icon('x')}</button>
          <button class="glass like" data-choice="like" aria-label="Ja">${icon('heart')}</button>
        </div>
      </div>
    </div>`;
}

function renderDeck() {
  const deck = view.querySelector('.deck');
  if (!deck) return;
  if (!state.profiles.length) {
    deck.innerHTML = emptyState('moon', 'Even niemand meer',
      'Je hebt iedereen gezien. Kom later terug, want er scannen steeds meer mensen hun ticket.',
      '<button class="secondary" id="reload">Opnieuw laden</button>');
    deck.querySelector('#reload').addEventListener('click', renderDiscover);
    return;
  }
  // De volgende kaart ligt er al onder, zodat de overgang vloeiend is.
  const [top, next] = state.profiles;
  deck.innerHTML = (next ? profileCard(next, true) : '') + profileCard(top, false);

  const card = deck.lastElementChild;
  for (const button of card.querySelectorAll('button')) button.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.querySelector('[data-choice=nope]').addEventListener('click', () => swipeTop(false));
  card.querySelector('[data-choice=like]').addEventListener('click', () => swipeTop(true));
  card.querySelector('[data-report]').addEventListener('click', () => {
    openReport(top, () => {
      state.profiles = state.profiles.filter((p) => p.id !== top.id);
      renderDeck();
    });
  });
  enableDrag(card);
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
    card.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${dx / 18}deg)`;
    like.style.opacity = Math.max(0, Math.min(1, dx / 90));
    nope.style.opacity = Math.max(0, Math.min(1, -dx / 90));
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
    card.style.transform = `translate(${like ? 600 : -600}px, 40px) rotate(${like ? 24 : -24}deg)`;
    view.querySelector('.profile-card.next')?.classList.remove('next');
  }
  try {
    const { match } = await api('/swipes', { method: 'POST', body: { targetId: profile.id, like } });
    await new Promise((r) => setTimeout(r, 300));
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
    <div class="pair">${avatar(state.me)}${avatar(match.user)}</div>
    <h1>It's a match</h1>
    <p>Jij en ${esc(match.user.name)} gaan allebei naar <strong>${esc(match.sharedEvents.map((e) => e.name).join(' & ') || 'hetzelfde evenement')}</strong>.</p>
    <button class="block" data-go>Stuur een bericht</button>
    <button class="secondary block" data-close>Verder kijken</button>`;
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
    <header class="page-head">
      <div>
        <h1>Tickets</h1>
        <span class="eyebrow">Je ticket bepaalt wie je ziet</span>
      </div>
    </header>
    <button class="block" id="scan">${icon('scan')} Ticket scannen</button>
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
              <span>${esc(t.venue)}, ${esc(t.city)}</span><br>
              <small>${t.past ? 'Afgelopen' : `${t.others} ${t.others === 1 ? 'ander' : 'anderen'} gaan ook`}</small>
            </div>
            <button data-remove="${t.id}" aria-label="Verwijderen">${icon('trash')}</button>
          </div>`;
      }).join('') : '<p class="muted center" style="margin-top:24px">Nog geen tickets. Scan je eerste ticket hierboven.</p>'}
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
  toast(`Ticket voor ${event.name} toegevoegd`);
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
  const head = `
    <header class="page-head">
      <div>
        <h1>Matches</h1>
        ${matches.length ? `<span class="eyebrow">${matches.length} ${matches.length === 1 ? 'match' : 'matches'}</span>` : ''}
      </div>
    </header>`;

  if (!matches.length) {
    view.innerHTML = head + emptyState('heart', 'Nog geen matches',
      'Zie je iemand die je leuk vindt? Tik op het hartje. Is het wederzijds, dan kun je hier chatten.',
      '<a class="btn" href="#/ontdek">Bekijk wie er gaan</a>');
    return;
  }

  view.innerHTML = `
    ${head}
    <div id="push-banner"></div>
    ${fresh.length ? `
      <h3>Nieuw</h3>
      <div class="new-matches">
        ${fresh.map((m) => `<a href="#/chat/${m.id}"><span class="ring">${avatar(m.user)}</span><br>${esc(m.user.name)}</a>`).join('')}
      </div>` : ''}
    ${conversations.length ? '<h3>Berichten</h3>' : ''}
    <div>
    ${conversations.map((m) => `
      <a class="conversation ${state.unread.has(m.id) ? 'unread' : ''}" href="#/chat/${m.id}">
        ${avatar(m.user)}
        <div class="meta">
          <strong>${esc(m.user.name)}</strong>${state.unread.has(m.id) ? '<span class="dot"></span>' : ''}
          <p>${m.lastMessage.senderId === state.me.id ? 'Jij: ' : ''}${esc(m.lastMessage.body)}</p>
        </div>
        <small class="muted">${shortWhen(m.lastMessage.createdAt)}</small>
      </a>`).join('')}
    </div>`;

  // Alleen een herinnering tonen als meldingen nog uit staan.
  const banner = view.querySelector('#push-banner');
  if ((await pushStatus().catch(() => null)) === 'off') {
    banner.style.marginBottom = '8px';
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
        <a class="back" href="#/matches" aria-label="Terug">${icon('back')}</a>
        ${avatar(match.user)}
        <div class="meta">
          <strong>${esc(match.user.name)}, ${match.user.age}</strong>
          <small>${esc(match.sharedEvents.map((e) => e.name).join(', ') || 'Geen gedeelde evenementen meer')}</small>
        </div>
        <button data-menu aria-label="Opties">${icon('more')}</button>
      </header>
      <div class="messages">
        <div class="intro">
          ${avatar(match.user)}
          <h2>Jij &amp; ${esc(match.user.name)}</h2>
          <p class="muted">Jullie matchten via ${esc(match.sharedEvents[0]?.name || 'SexySelectie')}. Spreek af bij een podium dat jullie allebei kennen.</p>
        </div>
      </div>
      <form>
        <input name="body" placeholder="Typ een bericht…" autocomplete="off" maxlength="1000" required>
        <button type="submit" aria-label="Versturen">${icon('send')}</button>
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
    <div class="profile-head">
      <div id="photo-preview">${avatar(me)}</div>
      <h1>${esc(me.name)}</h1>
      <span class="eyebrow">${me.age} · ${GENDER_LABEL[me.gender]}</span>
      <div class="photo-actions">
        <label class="btn secondary">${me.photo ? 'Andere foto' : 'Foto toevoegen'}
          <input type="file" accept="image/*" hidden>
        </label>
        ${me.photo ? '<button type="button" class="secondary" data-remove-photo>Verwijderen</button>' : ''}
      </div>
    </div>
    ${me.photo ? '' : '<p class="muted center" style="margin-top:-8px">Je foto bepaalt hoe je kaart eruitziet. Kies er een die laat zien wie je bent.</p>'}
    <form class="card" id="profile-form">
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
      <p class="muted" style="margin:0;font-size:13px">${esc(me.email)}</p>
      <button type="submit" class="block">Opslaan</button>
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
      await save(formData(form));
    } catch (err) {
      toast(err.message, true);
    }
  });
  view.querySelector('[data-remove-photo]')?.addEventListener('click', async () => {
    photo = null;
    try {
      await save(formData(form));
    } catch (err) {
      toast(err.message, true);
    }
  });

  const save = async (data) => {
    state.me = (await api('/me', { method: 'PUT', body: { ...data, photo } })).user;
    toast('Profiel opgeslagen');
    renderProfile();
  };
  const form = view.querySelector('#profile-form');
  onSubmit(form, save);

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
      <strong style="display:flex;align-items:center;gap:8px">${icon('phone')} Zet SexySelectie op je beginscherm</strong>
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
