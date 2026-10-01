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
  if (state.me) connectStream();

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
router();

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
      <button type="submit">Account maken</button>
    </form>
    <p class="center" style="margin-top:16px">Al een account? <a href="#/login" class="brand">Inloggen</a></p>`;
  onSubmit(view.querySelector('form'), async (data) => {
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
      <div class="info">
        <h2>${esc(p.name)} <small>${p.age}</small></h2>
        <div class="events">${p.sharedEvents.map((e) => `<span>🎪 ${esc(e.name)}</span>`).join('')}</div>
        ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
      </div>
    </div>`).join('');
  enableDrag(deck.lastElementChild);
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

async function openScanner() {
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
        <button class="link" data-unmatch>Unmatch</button>
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

  view.querySelector('[data-unmatch]').addEventListener('click', async () => {
    if (!confirm(`Weet je zeker dat je ${match.user.name} wilt unmatchen? Jullie chat wordt verwijderd.`)) return;
    try {
      await api(`/matches/${id}`, { method: 'DELETE' });
      location.hash = '#/matches';
    } catch (err) {
      toast(err.message, true);
    }
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
    <button class="secondary block" style="margin-top:16px" id="logout">Uitloggen</button>`;

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
    await api('/logout', { method: 'POST' }).catch(() => {});
    logoutLocal();
  });
}
