// Ticketverificatie.
//
// Echte tickets (Paylogic, Ticketmaster, Eventix, See Tickets, ...) hebben elk
// hun eigen barcodeformaat en zijn alleen betrouwbaar te controleren via de API
// van de ticketprovider of organisator. Totdat die koppelingen er zijn, werkt de
// app met eigen "SexySelectie-tickets": een QR-code met daarin
//
//   SS1.<eventId>.<serienummer>.<handtekening>
//
// waarbij de handtekening een HMAC is over eventId + serienummer. Zo kan niemand
// zelf een geldig ticket verzinnen. Een nieuwe provider toevoegen = een extra
// verifier in PROVIDERS die een code herkent en { eventId } teruggeeft.

const crypto = require('node:crypto');

const PREFIX = 'SS1';

function signature(secret, eventId, serial) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${eventId}.${serial}`)
    .digest('base64url')
    .slice(0, 22);
}

function createTicketCode(secret, eventId, serial) {
  return `${PREFIX}.${eventId}.${serial}.${signature(secret, eventId, serial)}`;
}

const PROVIDERS = [
  {
    name: 'sexyselectie',
    verify(code, { secret }) {
      const parts = code.split('.');
      if (parts.length !== 4 || parts[0] !== PREFIX) return null;
      const [, eventId, serial, sig] = parts;
      if (!/^[a-z0-9-]{1,64}$/.test(eventId) || !/^[A-Za-z0-9]{1,32}$/.test(serial)) return null;
      const expected = Buffer.from(signature(secret, eventId, serial));
      const actual = Buffer.from(sig);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
      return { eventId };
    },
  },
];

function verifyTicketCode(code, options) {
  const trimmed = String(code || '').trim();
  if (!trimmed || trimmed.length > 512) return null;
  for (const provider of PROVIDERS) {
    const result = provider.verify(trimmed, options);
    if (result) return { ...result, provider: provider.name, code: trimmed };
  }
  return null;
}

function hashTicketCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

module.exports = { createTicketCode, verifyTicketCode, hashTicketCode };
