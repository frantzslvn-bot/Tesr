'use strict';
// Alertes d'achat : un message Telegram et un e-mail (Resend) à chaque achat de la boutique.
// Règles :
//  - sans dépendance : on utilise le fetch intégré à Node 18+ ;
//  - ne fait JAMAIS échouer un achat : aucune erreur ne sort de ce module ;
//  - une variable absente désactive seulement le canal concerné ;
//  - délai maximum par envoi, un seul message par achat, plafond par heure (anti-spam) ;
//  - le pseudo est nettoyé : texte brut sur Telegram, échappé dans l'e-mail.
const cfg = require('./config');

const env = () => ({
  tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
  tgChat: process.env.TELEGRAM_CHAT_ID || '',
  mailKey: process.env.RESEND_API_KEY || '',
  mailTo: process.env.NOTIFY_EMAIL_TO || '',
  mailFrom: process.env.NOTIFY_EMAIL_FROM || 'Dracula System <onboarding@resend.dev>'
});

let doFetch = (...a) => fetch(...a);   // remplaçable dans les tests (faux envois)
const sent = new Set();                // identifiants d'achats déjà signalés (anti-doublon)
let windowStart = 0, windowCount = 0;  // plafond d'envois par heure

function setFetch(fn) { doFetch = fn; }
function reset() { sent.clear(); windowStart = 0; windowCount = 0; }

function channels() {
  const e = env();
  return { telegram: !!(e.tgToken && e.tgChat), email: !!(e.mailKey && e.mailTo) };
}

// Au démarrage : dit clairement ce qui est actif
function warnIfMissing() {
  const c = channels();
  if (!c.telegram) console.warn('Notifications Telegram désactivées (TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID absent).');
  if (!c.email) console.warn('Notifications e-mail désactivées (RESEND_API_KEY ou NOTIFY_EMAIL_TO absent).');
  return c;
}

// Pseudo piégé : on retire les caractères de contrôle / invisibles et on limite la longueur
function clean(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max || 60);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function lines(rec) {
  return {
    name: clean(rec.name, 40) || 'Membre',
    item: clean(rec.item, 60),
    cost: Number.isFinite(rec.cost) ? rec.cost : 0,
    when: new Date(rec.at || Date.now()).toLocaleString('fr-FR', { timeZone: 'America/Port-au-Prince' })
  };
}

async function post(url, init) {
  const res = await doFetch(url, Object.assign({ signal: AbortSignal.timeout(cfg.NOTIFY.TIMEOUT_MS) }, init));
  if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
}

async function sendTelegram(rec) {
  const e = env(), l = lines(rec);
  const text = 'Nouvel achat\n' + l.name + ' a pris « ' + l.item + ' » (' + l.cost + ' Coins)\n' + l.when + '\nÀ livrer : ouvre l\'onglet Achats de l\'admin.';
  await post('https://api.telegram.org/bot' + encodeURIComponent(e.tgToken) + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: e.tgChat, text })   // texte brut : pas de parse_mode, donc rien à interpréter
  });
}

async function sendEmail(rec) {
  const e = env(), l = lines(rec);
  const html = '<p><b>Nouvel achat</b></p><p>' + esc(l.name) + ' a pris « ' + esc(l.item) + ' » (' + l.cost + ' Coins)</p><p>' +
    esc(l.when) + '</p><p>À livrer : ouvre l\'onglet Achats de l\'admin.</p>';
  await post('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + e.mailKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: e.mailFrom,
      to: [e.mailTo],
      subject: 'Achat : ' + l.name + ' - ' + l.item,
      html,
      text: l.name + ' a pris « ' + l.item + ' » (' + l.cost + ' Coins) - ' + l.when
    })
  });
}

// Signale un achat. Retourne toujours une promesse qui réussit, avec le résultat par canal.
// "ok" envoyé, "ignore" canal absent / doublon / plafond, "echec" erreur (écrite dans les logs).
async function purchase(rec) {
  const out = { telegram: 'ignore', email: 'ignore' };
  try {
    if (!rec || !rec.id || sent.has(rec.id)) return out;           // un seul message par achat
    const c = channels();
    if (!c.telegram && !c.email) return out;
    const now = Date.now();
    if (now - windowStart > 3600 * 1000) { windowStart = now; windowCount = 0; }
    if (windowCount >= cfg.NOTIFY.MAX_PER_HOUR) return out;         // anti-spam : l'achat reste dans l'admin
    windowCount++;
    sent.add(rec.id);
    if (sent.size > 500) sent.delete(sent.values().next().value);

    const jobs = [];
    if (c.telegram) jobs.push(['telegram', sendTelegram]);
    if (c.email) jobs.push(['email', sendEmail]);
    // les deux canaux partent en même temps : l'un en panne ne retarde pas l'autre
    await Promise.all(jobs.map(async ([name, fn]) => {
      try { await fn(rec); out[name] = 'ok'; }
      catch (e) { out[name] = 'echec'; console.error('Notification ' + name + ' échouée :', e && e.message); }
    }));
  } catch (e) {
    console.error('Notification impossible :', e && e.message);
  }
  return out;
}

module.exports = { purchase, channels, warnIfMissing, setFetch, reset, _clean: clean, _esc: esc };
