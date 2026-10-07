// E-mail versturen. Met RESEND_API_KEY gaat het via Resend (resend.com);
// zonder sleutel wordt de mail in de serverlog gezet, zodat je lokaal alles
// kunt testen zonder echte mails te versturen.

function createMailer(env = process.env) {
  if (env.RESEND_API_KEY) {
    const from = env.MAIL_FROM || 'SexySelectie <onboarding@resend.dev>';
    return {
      kind: 'resend',
      async send({ to, subject, html, text }) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject, html, text }),
        });
        if (!res.ok) throw new Error(`Resend gaf ${res.status}: ${await res.text()}`);
      },
    };
  }
  return {
    kind: 'log',
    async send({ to, subject, text }) {
      console.log(`\n[mail] aan ${to}: ${subject}\n${text}\n`);
    },
  };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Zwart-witte mail in de stijl van de app. Inline styles, want veel
// mailprogramma's negeren <style>.
function layout({ title, intro, code, link, linkLabel, outro }) {
  const html = `<!doctype html>
<html lang="nl"><body style="margin:0;background:#f4f4f3;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b0b0b">
  <div style="max-width:460px;margin:0 auto;background:#ffffff;border-radius:20px;padding:36px 28px">
    <p style="margin:0 0 28px;font-family:Georgia,serif;font-size:22px">Sexy<em>Selectie</em></p>
    <h1 style="margin:0 0 12px;font-family:Georgia,serif;font-weight:400;font-size:30px;line-height:1.1">${escapeHtml(title)}</h1>
    <p style="margin:0 0 24px;color:#55554f;line-height:1.5">${escapeHtml(intro)}</p>
    <p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#8b8b88">Je code</p>
    <p style="margin:0 0 28px;font-size:38px;font-weight:600;letter-spacing:.3em;font-family:'SF Mono',Menlo,Consolas,monospace">${code}</p>
    <a href="${escapeHtml(link)}" style="display:inline-block;background:#0b0b0b;color:#ffffff;text-decoration:none;font-weight:600;padding:14px 24px;border-radius:999px">${escapeHtml(linkLabel)}</a>
    <p style="margin:28px 0 0;color:#8b8b88;font-size:13px;line-height:1.5">${escapeHtml(outro)}</p>
  </div>
</body></html>`;
  const text = `${title}\n\n${intro}\n\nJe code: ${code}\n\nOf open deze link: ${link}\n\n${outro}`;
  return { html, text };
}

function verifyEmail({ name, code, link }) {
  return {
    subject: `${code} is je SexySelectie-code`,
    ...layout({
      title: `Welkom, ${name}`,
      intro: 'Bevestig je e-mailadres zodat anderen je kunnen zien en je kunt gaan swipen. Vul de code in de app in, of tik op de knop.',
      code,
      link,
      linkLabel: 'E-mailadres bevestigen',
      outro: 'De code is 24 uur geldig. Heb je geen account aangemaakt? Dan kun je deze mail negeren.',
    }),
  };
}

function resetEmail({ name, code, link }) {
  return {
    subject: `${code} is je code voor een nieuw wachtwoord`,
    ...layout({
      title: 'Nieuw wachtwoord',
      intro: `Hoi ${name}, vul deze code in de app in om een nieuw wachtwoord te kiezen, of tik op de knop.`,
      code,
      link,
      linkLabel: 'Nieuw wachtwoord kiezen',
      outro: 'De code is 30 minuten geldig. Heb je dit niet aangevraagd? Dan blijft je wachtwoord gewoon hetzelfde.',
    }),
  };
}

module.exports = { createMailer, verifyEmail, resetEmail };
