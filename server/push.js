// Pushmeldingen naar drie soorten apparaten:
//
//   web   – de PWA in de browser of op het beginscherm (Web Push, VAPID)
//   fcm   – de Android-app (Firebase Cloud Messaging, HTTP v1 API)
//   apns  – de iOS-app (Apple Push Notification service, token-auth via .p8-sleutel)
//
// Elk kanaal is optioneel: zonder de bijbehorende omgevingsvariabelen wordt het
// overgeslagen. Ongeldige of verlopen abonnementen worden automatisch opgeruimd.

const crypto = require('node:crypto');
const http2 = require('node:http2');
const webpush = require('web-push');

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(header, payload, key, algorithm) {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = algorithm === 'ES256'
    ? crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('sha256', Buffer.from(data), key);
  return `${data}.${signature.toString('base64url')}`;
}

// ---------- Web Push ----------

function createWebSender({ publicKey, privateKey, subject }) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return async (sub, message) => {
    try {
      await webpush.sendNotification(JSON.parse(sub.token), JSON.stringify(message), { TTL: 60 * 60 * 24 });
      return 'ok';
    } catch (err) {
      return err.statusCode === 404 || err.statusCode === 410 ? 'gone' : 'error';
    }
  };
}

// ---------- Firebase Cloud Messaging ----------

function createFcmSender(serviceAccount) {
  let cached = { token: null, expires: 0 };

  async function accessToken() {
    if (cached.token && Date.now() < cached.expires - 60000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      serviceAccount.private_key,
      'RS256',
    );
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`FCM-token ophalen mislukt: ${res.status}`);
    const data = await res.json();
    cached = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    return cached.token;
  }

  return async (sub, message) => {
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: sub.token,
            notification: { title: message.title, body: message.body },
            data: { url: message.url, tag: message.tag },
            android: { priority: 'high', notification: { tag: message.tag, color: '#89cff0', icon: 'ic_stat_notify' } },
          },
        }),
      });
      if (res.ok) return 'ok';
      const text = await res.text();
      return res.status === 404 || text.includes('UNREGISTERED') ? 'gone' : 'error';
    } catch {
      return 'error';
    }
  };
}

// ---------- Apple Push Notification service ----------

function createApnsSender({ key, keyId, teamId, bundleId, production }) {
  const host = production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  let session = null;
  let jwt = { token: null, issued: 0 };

  function bearer() {
    // Apple wil dat het token tussen 20 en 60 minuten oud is voordat je een nieuwe maakt.
    if (!jwt.token || Date.now() - jwt.issued > 40 * 60 * 1000) {
      jwt = {
        token: signJwt({ alg: 'ES256', kid: keyId }, { iss: teamId, iat: Math.floor(Date.now() / 1000) }, key, 'ES256'),
        issued: Date.now(),
      };
    }
    return jwt.token;
  }

  function connection() {
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(host);
      session.on('error', () => (session = null));
      session.unref();
    }
    return session;
  }

  return (sub, message) => new Promise((resolve) => {
    const req = connection().request({
      ':method': 'POST',
      ':path': `/3/device/${sub.token}`,
      authorization: `bearer ${bearer()}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'apns-collapse-id': message.tag,
    });
    let status = 0;
    let body = '';
    req.setEncoding('utf8');
    req.on('response', (headers) => (status = headers[':status']));
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (status === 200) resolve('ok');
      else resolve(status === 410 || body.includes('BadDeviceToken') || body.includes('Unregistered') ? 'gone' : 'error');
    });
    req.on('error', () => resolve('error'));
    req.end(JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: 'default', 'thread-id': message.tag },
      url: message.url,
    }));
  });
}

// ---------- Configuratie uit omgevingsvariabelen ----------

function sendersFromEnv(env = process.env) {
  const senders = {};
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    senders.web = createWebSender({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT || 'mailto:support@example.com',
    });
  }
  if (env.FCM_SERVICE_ACCOUNT) {
    const json = env.FCM_SERVICE_ACCOUNT.trim().startsWith('{')
      ? env.FCM_SERVICE_ACCOUNT
      : Buffer.from(env.FCM_SERVICE_ACCOUNT, 'base64').toString('utf8');
    senders.fcm = createFcmSender(JSON.parse(json));
  }
  if (env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID) {
    const key = env.APNS_KEY.includes('BEGIN') ? env.APNS_KEY : Buffer.from(env.APNS_KEY, 'base64').toString('utf8');
    senders.apns = createApnsSender({
      key: key.replace(/\\n/g, '\n'),
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      bundleId: env.APNS_BUNDLE_ID,
      production: env.APNS_PRODUCTION === 'true',
    });
  }
  return senders;
}

class Push {
  constructor(db, senders = {}, { vapidPublicKey = null } = {}) {
    this.db = db;
    this.senders = senders;
    this.vapidPublicKey = vapidPublicKey;
  }

  enabledKinds() {
    return Object.keys(this.senders);
  }

  subscribe(userId, kind, token) {
    this.db.prepare(`INSERT INTO push_subscriptions (user_id, kind, token) VALUES (?, ?, ?)
                     ON CONFLICT (kind, token) DO UPDATE SET user_id = excluded.user_id, created_at = datetime('now')`)
      .run(userId, kind, token);
  }

  // Verstuurt naar alle apparaten van een gebruiker. De API roept dit aan zonder
  // await, zodat een trage pushdienst een request nooit ophoudt.
  async notify(userId, message) {
    const subs = this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    await Promise.all(subs.map(async (sub) => {
      const send = this.senders[sub.kind];
      if (!send) return;
      const result = await send(sub, message);
      if (result === 'gone') this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
    }));
  }
}

module.exports = { Push, sendersFromEnv, signJwt };
