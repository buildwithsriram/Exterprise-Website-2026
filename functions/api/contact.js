// POST /api/contact (Cloudflare Pages Function): checks a contact-form submission and emails it to the company inbox
// through Resend. The visitor sees success only once Resend has accepted the email; busy or failed attempts are
// retried for up to about 12 seconds. Settings live in the Pages project (Settings > Variables and Secrets):
//   RESEND_API_KEY        secret, required: Resend API key with sending access for exterprise.us
//   TURNSTILE_SECRET_KEY  secret, optional: when set, every submission must carry a valid Turnstile token
//   MAIL_TO               optional, default contact@exterprise.us (comma-separate several addresses)
//   MAIL_FROM             optional, default "Exterprise Website <website@exterprise.us>"
//   RESEND_API_URL        testing only: send to a mock server instead of Resend

const FIELDS = ['Name', 'Email', 'Company', 'Phone', 'Topics', 'Interested in', 'Message', 'Page', 'URL'];
const LIMIT = { Message: 5000, URL: 500 };
const EMAIL_RX = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const RETRY_DELAYS = [500, 1000, 2000, 3000, 5000];   // total under the browser's 20-second wait

const reply = (status, data) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});
const fail = (status, message) => reply(status, { success: false, message });
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = s => s.replace(/[\r\n]+/g, ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Resend allows a few requests per second, so a burst can get 429s: retry those and server errors.
async function sendEmail(env, mail) {
  let last = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt) await sleep(RETRY_DELAYS[attempt - 1] + Math.random() * 400);
    try {
      const r = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(mail)
      });
      if (r.ok) return true;
      last = `${r.status} ${(await r.text()).slice(0, 200)}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = String(e).slice(0, 200); }
  }
  console.error('contact: email failed', last);
  return false;
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (!origin || new URL(origin).host !== new URL(request.url).host) return fail(403, 'Forbidden');
  if (Number(request.headers.get('Content-Length') || 0) > 20000) return fail(413, 'Message too long');
  if (!env.RESEND_API_KEY) { console.error('contact: RESEND_API_KEY is not set'); return fail(503, 'Sending is not set up yet.'); }

  let body;
  try { body = await request.json(); } catch { return fail(400, 'Invalid request'); }
  if (!body || typeof body !== 'object') return fail(400, 'Invalid request');
  if (body._honey) return reply(200, { success: true });   // spam trap filled in: accept quietly, send nothing

  const f = {};
  for (const k of FIELDS) {
    const v = typeof body[k] === 'string' ? body[k].trim() : '';
    if (v && v !== '-') f[k] = v.slice(0, LIMIT[k] || 300);
  }
  if (!f.Name || f.Name.length < 2) return fail(400, 'Please enter your name.');
  if (!f.Email || !EMAIL_RX.test(f.Email)) return fail(400, 'Please enter a valid email address.');

  if (env.TURNSTILE_SECRET_KEY) {
    if (typeof body.token !== 'string' || !body.token) return fail(400, 'Verification missing. Please try again.');
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: body.token, remoteip: request.headers.get('CF-Connecting-IP') || '' })
    }).then(r => r.json()).catch(() => ({ success: false }));
    if (!v.success) return fail(403, 'Verification failed. Please try again.');
  }

  const rows = Object.entries(f);
  const sent = await sendEmail(env, {
    from: env.MAIL_FROM || 'Exterprise Website <website@exterprise.us>',
    to: (env.MAIL_TO || 'contact@exterprise.us').split(',').map(s => s.trim()).filter(Boolean),
    reply_to: oneLine(f.Email),
    subject: oneLine('Website inquiry from ' + [f.Name, f.Company].filter(Boolean).join(', ')).slice(0, 180),
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n'),
    html: '<table cellpadding="8" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' +
      rows.map(([k, v]) => `<tr><th align="left" valign="top" style="background:#f4f4f4;border:1px solid #ddd">${esc(k)}</th>` +
        `<td style="border:1px solid #ddd;white-space:pre-wrap">${esc(v)}</td></tr>`).join('') + '</table>'
  });
  return sent ? reply(200, { success: true }) : fail(502, 'Could not send right now.');
}
