'use strict';
// Lancer avec : npm test  (ou : node test/chat.test.js)
// Messagerie, alertes d'achat (notify.js), envois de Coins, dons / retraits, cadeaux.
// Aucun réseau : faux sockets et faux fetch.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Doit être défini AVANT de charger le serveur (config.js lit l'environnement au chargement)
const TMP = path.join(os.tmpdir(), 'dracula-chat-test-' + process.pid);
process.env.DATA_FILE = path.join(TMP, 'db.json');
process.env.ADMIN_CODE = 'code-de-test-123';
for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'RESEND_API_KEY', 'NOTIFY_EMAIL_TO']) delete process.env[k];

const cfg = require('../server/config');
const coins = require('../server/coins');
const messages = require('../server/messages');
const notify = require('../server/notify');
const shop = require('../server/shop');
const sock = require('../server/socket');
const transfers = require('../server/transfers');

messages._debug.L.MIN_GAP_MS = 0;   // pas de délai entre deux messages dans les tests
cfg.TRANSFER.GAP_MS = 0;            // ni entre deux envois (testé à part)

/* ---------- Petit lanceur (les tests peuvent être asynchrones) ---------- */
let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
function title(s) { queue.push({ title: s }); }

/* ---------- Faux sockets ---------- */
let sockN = 0;
class FakeSocket {
  constructor() {
    this.id = 'f' + (++sockN); this.data = {}; this.handlers = {}; this.mw = []; this.inbox = [];
    this.handshake = { address: '10.1.0.' + sockN, headers: {} };
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  use(fn) { this.mw.push(fn); }
  emit(ev, payload) { this.inbox.push({ ev, payload }); }
  disconnect() { if (this.handlers.disconnect) this.handlers.disconnect(); }
  call(ev, data) {
    let out; const ack = r => { out = r; };
    const packet = [ev, data, ack]; let i = 0;
    const next = () => {
      if (i < this.mw.length) { this.mw[i++](packet, next); return; }
      this.handlers[ev](data, ack);
    };
    next();
    return out;
  }
  last(ev) { for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].ev === ev) return this.inbox[i].payload; return null; }
  all(ev) { return this.inbox.filter(x => x.ev === ev).map(x => x.payload); }
}
const all = new Map();    // io.sockets.sockets
const broadcast = [];     // io.emit(...)
const fakeIo = {
  cbs: [],    // socket.js et transfers.js s'accrochent tous les deux à « connection »
  sockets: { sockets: all },
  on(ev, cb) { if (ev === 'connection') this.cbs.push(cb); },
  emit(ev, payload) { broadcast.push({ ev, payload }); }
};
sock.attach(fakeIo);
transfers.attach(fakeIo);

function connect(name) {
  const s = new FakeSocket();
  all.set(s.id, s);
  fakeIo.cbs.forEach(cb => cb(s));
  const h = s.call('hello', { name });
  assert.ok(h && h.ok, 'connexion de ' + name + ' : ' + JSON.stringify(h));
  s.token = h.token; s.me = h.me; s.id2 = h.me.id;
  return s;
}
function boss(name) { const s = connect(name); assert.ok(s.call('admin:login', { code: process.env.ADMIN_CODE }).ok); return s; }
const bal = s => coins.get(s.me.id).coins;
function setBal(s, n) { coins.get(s.me.id).coins = n; }
function makeAdmin(owner, s) { assert.ok(owner.call('admin:act', { act: 'admin', id: s.me.id }).ok); }

/* ================= notify.js ================= */
title('Alertes d\'achat (notify.js)');
const REC = { id: 'a1', name: 'Marie', item: 'Abonnement', cost: 300, at: Date.now() };
function withFetch() {
  const calls = [];
  notify.setFetch(async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; });
  notify.reset();
  return calls;
}
function setEnv(tg, mail) {
  const on = (k, v, yes) => { if (yes) process.env[k] = v; else delete process.env[k]; };
  on('TELEGRAM_BOT_TOKEN', 'tok123', tg); on('TELEGRAM_CHAT_ID', '42', tg);
  on('RESEND_API_KEY', 'key123', mail); on('NOTIFY_EMAIL_TO', 'moi@example.com', mail);
}
t('sans réglage : rien n\'est envoyé et aucune erreur', async () => {
  setEnv(false, false); const calls = withFetch();
  assert.deepStrictEqual(await notify.purchase(REC), { telegram: 'ignore', email: 'ignore' });
  assert.strictEqual(calls.length, 0);
});
t('channels : un canal à la fois', () => {
  setEnv(true, false); assert.deepStrictEqual(notify.channels(), { telegram: true, email: false });
  setEnv(false, true); assert.deepStrictEqual(notify.channels(), { telegram: false, email: true });
  setEnv(false, false);
});
t('Telegram + e-mail : un envoi chacun, avec le bon contenu', async () => {
  setEnv(true, true); const calls = withFetch();
  const r = await notify.purchase(REC);
  assert.deepStrictEqual(r, { telegram: 'ok', email: 'ok' });
  assert.strictEqual(calls.length, 2);
  const tg = calls.find(c => c.url.includes('api.telegram.org')), em = calls.find(c => c.url.includes('api.resend.com'));
  assert.ok(tg && em);
  assert.ok(JSON.parse(tg.init.body).text.includes('Marie') && JSON.parse(tg.init.body).text.includes('Abonnement'));
  assert.strictEqual(JSON.parse(tg.init.body).parse_mode, undefined);   // texte brut
  assert.strictEqual(em.init.headers.Authorization, 'Bearer key123');
});
t('un achat n\'est signalé qu\'une fois', async () => {
  setEnv(true, false); const calls = withFetch();
  await notify.purchase(REC);
  assert.deepStrictEqual(await notify.purchase(REC), { telegram: 'ignore', email: 'ignore' });
  assert.strictEqual(calls.length, 1);
});
t('une panne d\'un canal ne bloque pas l\'autre ni l\'achat', async () => {
  setEnv(true, true); notify.reset();
  const origErr = console.error; console.error = () => { };
  notify.setFetch(async url => { if (url.includes('telegram')) throw new Error('réseau'); return { ok: true }; });
  let r; try { r = await notify.purchase(REC); } finally { console.error = origErr; }
  assert.deepStrictEqual(r, { telegram: 'echec', email: 'ok' });
});
t('réponse HTTP en erreur = échec, sans exception', async () => {
  setEnv(true, false); notify.reset();
  const origErr = console.error; console.error = () => { };
  notify.setFetch(async () => ({ ok: false, status: 500 }));
  let r; try { r = await notify.purchase(REC); } finally { console.error = origErr; }
  assert.strictEqual(r.telegram, 'echec');
});
t('plafond par heure : au-delà, ignoré', async () => {
  setEnv(true, false); const calls = withFetch();
  const max = cfg.NOTIFY.MAX_PER_HOUR;
  for (let i = 0; i < max; i++) await notify.purchase({ id: 'p' + i, name: 'X', item: 'Y', cost: 1 });
  assert.strictEqual((await notify.purchase({ id: 'trop', name: 'X', item: 'Y', cost: 1 })).telegram, 'ignore');
  assert.strictEqual(calls.length, max);
});
t('pseudo piégé : caractères invisibles retirés, HTML échappé', () => {
  assert.strictEqual(notify._clean('Ma\u202Eri\u200Be\n\n  x', 40), 'Ma ri e x');
  assert.strictEqual(notify._esc('<b>"a"&\'</b>'), '&lt;b&gt;&quot;a&quot;&amp;&#39;&lt;/b&gt;');
});
t('achat vide ou sans identifiant : ignoré', async () => {
  setEnv(true, true); withFetch();
  assert.deepStrictEqual(await notify.purchase(null), { telegram: 'ignore', email: 'ignore' });
  assert.deepStrictEqual(await notify.purchase({ name: 'sans id' }), { telegram: 'ignore', email: 'ignore' });
});
queue.push({ fn: () => { setEnv(false, false); notify.reset(); } });

/* ================= Messagerie ================= */
title('Messagerie');
t('discussion privée : même conversation dans les deux sens', () => {
  const a = connect('ChatA1'), b = connect('ChatB1');
  const c1 = a.call('chat:open', { with: b.me.id }), c2 = b.call('chat:open', { with: a.me.id });
  assert.ok(c1.ok && c2.ok);
  assert.strictEqual(c1.id || c1.conv.id, c2.id || c2.conv.id);
});
t('on ne peut pas s\'écrire à soi-même, ni à un inconnu', () => {
  const a = connect('ChatA2');
  assert.ok(a.call('chat:open', { with: a.me.id }).error);
  assert.ok(a.call('chat:open', { with: 'inconnu' }).error);
});
function dm(a, b) { const r = a.call('chat:open', { with: b.me.id }); return r.id || r.conv.id; }
t('un message arrive chez l\'autre, avec un non-lu', () => {
  const a = connect('ChatA3'), b = connect('ChatB3'), id = dm(a, b);
  const r = a.call('chat:send', { id, text: 'Salut !' });
  assert.ok(r.ok && r.msg.text === 'Salut !');
  const got = b.last('chat:msg');
  assert.ok(got && got.msg.text === 'Salut !' && got.conv.unread === 1);
  assert.strictEqual(messages.unreadTotal(b.me.id), 1);
  assert.strictEqual(messages.unreadTotal(a.me.id), 0);
});
t('lu : le non-lu retombe à zéro et l\'expéditeur est prévenu', () => {
  const a = connect('ChatA4'), b = connect('ChatB4'), id = dm(a, b);
  a.call('chat:send', { id, text: 'Tu es là ?' });
  assert.ok(b.call('chat:read', { id }).ok);
  assert.strictEqual(messages.unreadTotal(b.me.id), 0);
  assert.ok(a.last('chat:read'));
});
t('message vide ou trop long', () => {
  const a = connect('ChatA5'), b = connect('ChatB5'), id = dm(a, b);
  assert.ok(a.call('chat:send', { id, text: '   ' }).error);
  const r = a.call('chat:send', { id, text: 'x'.repeat(messages.MAX_TEXT + 500) });
  assert.ok(r.ok && r.msg.text.length <= messages.MAX_TEXT);
});
t('une photo inconnue est refusée', () => {
  const a = connect('ChatA6'), b = connect('ChatB6'), id = dm(a, b);
  assert.ok(a.call('chat:send', { id, text: 'photo', img: 'pas-une-photo.jpg' }).error);
});
t('historique : seuls les membres le lisent', () => {
  const a = connect('ChatA7'), b = connect('ChatB7'), c = connect('ChatC7'), id = dm(a, b);
  a.call('chat:send', { id, text: 'secret' });
  const h = b.call('chat:history', { id });
  assert.ok(h.ok && JSON.stringify(h).includes('secret'));
  assert.ok(c.call('chat:history', { id }).error);
  assert.ok(c.call('chat:send', { id, text: 'intrus' }).error);
});
t('blocage : plus d\'écriture dans aucun sens, puis débloquer', () => {
  const a = connect('ChatA8'), b = connect('ChatB8'), id = dm(a, b);
  a.call('chat:send', { id, text: 'avant' });
  assert.strictEqual(a.call('chat:block', { id: b.me.id }).blocked, true);
  assert.ok(b.call('chat:send', { id, text: 'après' }).error);
  assert.ok(a.call('chat:send', { id, text: 'moi aussi' }).error);
  assert.strictEqual(a.call('chat:block', { id: b.me.id }).blocked, false);
  assert.ok(b.call('chat:send', { id, text: 'ça remarche' }).ok);
});
t('on ne se bloque pas soi-même', () => {
  const a = connect('ChatA9'); assert.ok(a.call('chat:block', { id: a.me.id }).error);
});
t('suppression : ses propres messages seulement (en privé)', () => {
  const a = connect('ChatA10'), b = connect('ChatB10'), id = dm(a, b);
  const m = a.call('chat:send', { id, text: 'à effacer' }).msg;
  assert.ok(b.call('chat:delete', { id, mid: m.id }).error);
  assert.ok(a.call('chat:delete', { id, mid: m.id }).ok);
  assert.ok(b.last('chat:del') && b.last('chat:del').mid === m.id);
  assert.ok(!JSON.stringify(b.call('chat:history', { id })).includes('à effacer'));
});
t('groupe : création, message pour tous, un non-membre n\'entre pas', () => {
  const a = connect('GrpA'), b = connect('GrpB'), c = connect('GrpC'), d = connect('GrpD');
  const g = a.call('chat:group:create', { name: 'Les copains', ids: [b.me.id, c.me.id] });
  assert.ok(g.ok && g.id);
  assert.ok(a.call('chat:send', { id: g.id, text: 'Bienvenue' }).ok);
  assert.ok(b.last('chat:msg') && c.last('chat:msg'));
  assert.ok(!d.last('chat:msg'));
  assert.ok(d.call('chat:history', { id: g.id }).error);
});
t('groupe : sans membre ou sans nom = refusé', () => {
  const a = connect('GrpE'), b = connect('GrpF');
  assert.ok(a.call('chat:group:create', { name: 'Vide', ids: [] }).error);
  assert.ok(a.call('chat:group:create', { name: '   ', ids: [b.me.id] }).error);
});
t('groupe : l\'admin du groupe supprime le message d\'un autre, pas l\'inverse', () => {
  const a = connect('GrpG'), b = connect('GrpH');
  const g = a.call('chat:group:create', { name: 'Modération', ids: [b.me.id] });
  const mb = b.call('chat:send', { id: g.id, text: 'bêtise' }).msg;
  const ma = a.call('chat:send', { id: g.id, text: 'officiel' }).msg;
  assert.ok(b.call('chat:delete', { id: g.id, mid: ma.id }).error);
  assert.ok(a.call('chat:delete', { id: g.id, mid: mb.id }).ok);
});
t('groupe : quitter retire l\'accès', () => {
  const a = connect('GrpI'), b = connect('GrpJ');
  const g = a.call('chat:group:create', { name: 'Départ', ids: [b.me.id] });
  assert.ok(b.call('chat:leave', { id: g.id }).ok);
  assert.ok(b.call('chat:history', { id: g.id }).error);
});
t('rien sans compte valide', () => {
  const s = new FakeSocket(); all.set(s.id, s); fakeIo.cbs.forEach(cb => cb(s));
  for (const ev of ['chat:list', 'chat:open', 'chat:send', 'chat:block', 'chat:group:create']) assert.ok(s.call(ev, {}).error, ev);
});
t('les admins ne lisent pas les messages privés', () => {
  const a = connect('PrivA'), b = connect('PrivB'), o = boss('PrivBoss'), id = dm(a, b);
  a.call('chat:send', { id, text: 'entre nous' });
  assert.ok(o.call('chat:history', { id }).error);
});

/* ================= Envois de Coins ================= */
title('Envois de Coins');
t('envoi : débit et crédit ensemble, les deux sont prévenus', () => {
  const a = connect('SendA1'), b = connect('SendB1');
  setBal(a, 100); setBal(b, 20);
  const r = a.call('coins:send', { to: b.me.id, amount: 30 });
  assert.ok(r.ok && r.coins === 70);
  assert.strictEqual(bal(a), 70); assert.strictEqual(bal(b), 50);
  assert.strictEqual(a.last('me').coins, 70); assert.strictEqual(b.last('me').coins, 50);
  const rec = b.last('coins:received');
  assert.ok(rec && rec.amount === 30 && rec.from === 'SendA1');
});
t('envoi : le total de Coins ne change pas', () => {
  const a = connect('SendA2'), b = connect('SendB2');
  setBal(a, 200); setBal(b, 10);
  a.call('coins:send', { to: b.me.id, amount: 77 });
  assert.strictEqual(bal(a) + bal(b), 210);
});
t('envoi : montants invalides refusés, rien ne bouge', () => {
  const a = connect('SendA3'), b = connect('SendB3');
  setBal(a, 500); setBal(b, 0);
  for (const amount of [0, -5, 1.5, '30', NaN, null, undefined, cfg.TRANSFER.MIN - 1, cfg.TRANSFER.MAX + 1]) {
    assert.ok(a.call('coins:send', { to: b.me.id, amount }).error, 'montant ' + String(amount));
  }
  assert.strictEqual(bal(a), 500); assert.strictEqual(bal(b), 0);
});
t('envoi : solde insuffisant', () => {
  const a = connect('SendA4'), b = connect('SendB4');
  setBal(a, 10); const r = a.call('coins:send', { to: b.me.id, amount: 50 });
  assert.ok(r.error && /40/.test(r.error)); assert.strictEqual(bal(a), 10);
});
t('envoi : pas à soi-même, pas à un inconnu, pas à un compte bloqué', () => {
  const a = connect('SendA5'), b = connect('SendB5'), o = boss('SendBoss5');
  setBal(a, 100);
  assert.ok(a.call('coins:send', { to: a.me.id, amount: 10 }).error);
  assert.ok(a.call('coins:send', { to: 'inconnu', amount: 10 }).error);
  assert.ok(o.call('admin:act', { act: 'ban', id: b.me.id }).ok);
  assert.ok(a.call('coins:send', { to: b.me.id, amount: 10 }).error);
  assert.strictEqual(bal(a), 100);
});
t('envoi : plafond du jour par membre', () => {
  const a = connect('SendA6'), b = connect('SendB6');
  setBal(a, 5000);
  const per = cfg.TRANSFER.MAX; let sent = 0;
  while (sent + per <= cfg.TRANSFER.DAY_MAX) { assert.ok(a.call('coins:send', { to: b.me.id, amount: per }).ok); sent += per; }
  const left = cfg.TRANSFER.DAY_MAX - sent;
  const r = a.call('coins:send', { to: b.me.id, amount: Math.max(cfg.TRANSFER.MIN, left + 1) });
  assert.ok(r.error && /Limite du jour/.test(r.error));
});
t('envoi : délai anti-rafale', () => {
  const a = connect('SendA7'), b = connect('SendB7');
  setBal(a, 500); cfg.TRANSFER.GAP_MS = 60000;
  try {
    assert.ok(a.call('coins:send', { to: b.me.id, amount: 10 }).ok);
    assert.ok(a.call('coins:send', { to: b.me.id, amount: 10 }).error);
  } finally { cfg.TRANSFER.GAP_MS = 0; }
});
t('envoi : un compte supprimé ne reçoit plus, un compte inexistant ne peut pas envoyer', () => {
  const s = new FakeSocket(); all.set(s.id, s); fakeIo.cbs.forEach(cb => cb(s));
  assert.ok(s.call('coins:send', { to: 'x', amount: 10 }).error);
});
t('envoi : écrit dans le journal', () => {
  const a = connect('SendA8'), b = connect('SendB8'), o = boss('SendBoss8');
  setBal(a, 100); a.call('coins:send', { to: b.me.id, amount: 25 });
  const led = o.call('admin:ledger', {});
  assert.ok(led.ok && led.list.some(x => x.type === 'send' && x.fromName === 'SendA8' && x.toName === 'SendB8' && x.amount === 25));
});

/* ================= Dons et retraits ================= */
title('Dons et retraits');
t('créateur : donne et retire sans limite, se donne à lui-même', () => {
  const o = boss('GiveBoss1'), b = connect('GiveB1');
  setBal(b, 0);
  const r = o.call('admin:give', { id: b.me.id, amount: 50000 });
  assert.ok(r.ok && r.applied === 50000 && bal(b) === 50000);
  assert.strictEqual(b.last('me').coins, 50000);
  const rec = b.last('coins:received'); assert.ok(rec && rec.amount === 50000 && rec.from === 'Dracula System');
  assert.ok(o.call('admin:give', { id: o.me.id, amount: 999 }).ok);
  assert.ok(o.call('admin:give', { id: b.me.id, amount: -20000 }).ok && bal(b) === 30000);
});
t('retrait : jamais sous zéro', () => {
  const o = boss('GiveBoss2'), b = connect('GiveB2');
  setBal(b, 40);
  const r = o.call('admin:give', { id: b.me.id, amount: -500 });
  assert.ok(r.ok && r.applied === -40 && bal(b) === 0);
  assert.ok(o.call('admin:give', { id: b.me.id, amount: -5 }).error);   // déjà à 0
});
t('montants invalides refusés', () => {
  const o = boss('GiveBoss3'), b = connect('GiveB3'); setBal(b, 10);
  for (const amount of [0, 1.5, '10', NaN, null]) assert.ok(o.call('admin:give', { id: b.me.id, amount }).error, String(amount));
  assert.ok(o.call('admin:give', { id: 'inconnu', amount: 10 }).error);
  assert.strictEqual(bal(b), 10);
});
t('un membre ordinaire ne peut ni donner ni lire le journal', () => {
  const a = connect('GiveA4'), b = connect('GiveB4'); setBal(b, 0);
  assert.ok(a.call('admin:give', { id: b.me.id, amount: 100 }).error);
  assert.ok(a.call('admin:ledger', {}).error);
  assert.strictEqual(bal(b), 0);
});
t('admin nommé : plafonné, pas à lui-même, pas à un autre admin', () => {
  const o = boss('GiveBoss5'), ad = connect('GiveAdmin5'), ad2 = connect('GiveAdmin5b'), b = connect('GiveB5');
  makeAdmin(o, ad); makeAdmin(o, ad2); setBal(b, 0);
  assert.ok(ad.call('admin:give', { id: b.me.id, amount: cfg.GIVE.ADMIN_MAX }).ok);
  assert.ok(ad.call('admin:give', { id: b.me.id, amount: cfg.GIVE.ADMIN_MAX + 1 }).error);
  assert.ok(ad.call('admin:give', { id: b.me.id, amount: -(cfg.GIVE.ADMIN_MAX + 1) }).error);
  assert.ok(ad.call('admin:give', { id: ad.me.id, amount: 10 }).error);
  assert.ok(ad.call('admin:give', { id: ad2.me.id, amount: 10 }).error);
  assert.strictEqual(bal(b), cfg.GIVE.ADMIN_MAX);
});
t('journal : les dons et retraits apparaissent, les admins sont prévenus en direct', () => {
  const o = boss('GiveBoss6'), b = connect('GiveB6'); setBal(b, 100);
  o.call('admin:give', { id: b.me.id, amount: 10 });
  o.call('admin:give', { id: b.me.id, amount: -5 });
  const live = o.all('admin:ledger'); assert.ok(live.length >= 2);
  const list = o.call('admin:ledger', {}).list;
  assert.ok(list.some(x => x.type === 'give' && x.toName === 'GiveB6' && x.amount === 10));
  assert.ok(list.some(x => x.type === 'take' && x.toName === 'GiveB6' && x.amount === 5));
  assert.ok(list.length <= 60);
});
t('un compte bloqué ne peut plus envoyer', () => {
  const o = boss('GiveBoss7'), a = connect('GiveA7'), b = connect('GiveB7'); setBal(a, 100);
  o.call('admin:act', { act: 'ban', id: a.me.id });
  assert.ok(a.call('coins:send', { to: b.me.id, amount: 10 }).error);
});

/* ================= Cadeaux ================= */
title('Cadeaux et bonus du jour');
t('créateur : ajoute, modifie et retire un cadeau, la boutique est diffusée', () => {
  const o = boss('ShopBoss1'); broadcast.length = 0;
  const add = o.call('admin:gift:save', { name: 'Test cadeau', cost: 50 });
  assert.ok(add.ok && add.shop.some(x => x.name === 'Test cadeau'));
  const id = add.shop.find(x => x.name === 'Test cadeau').id;
  assert.ok(cfg.SHOP.some(x => x.id === id));
  assert.ok(broadcast.some(x => x.ev === 'shop:update' && x.payload.shop.some(g => g.id === id)));
  const mod = o.call('admin:gift:save', { id, name: 'Cadeau modifié', cost: 75 });
  assert.ok(mod.ok && mod.shop.find(x => x.id === id).cost === 75);
  const del = o.call('admin:gift:remove', { id });
  assert.ok(del.ok && !cfg.SHOP.some(x => x.id === id));
});
t('cadeau : nom et prix vérifiés', () => {
  const o = boss('ShopBoss2'), n = cfg.SHOP.length;
  for (const cost of [0, -1, 1.5, '10', cfg.GIFTS.MAX_COST + 1, null]) assert.ok(o.call('admin:gift:save', { name: 'X', cost }).error, String(cost));
  assert.ok(o.call('admin:gift:save', { name: '   ', cost: 10 }).error);
  assert.ok(o.call('admin:gift:save', { id: 'inconnu', name: 'X', cost: 10 }).error);
  assert.ok(o.call('admin:gift:remove', { id: 'inconnu' }).error);
  assert.strictEqual(cfg.SHOP.length, n);
});
t('cadeau : le nom est nettoyé (pas de HTML)', () => {
  const o = boss('ShopBoss3');
  const r = o.call('admin:gift:save', { name: '<b>Gras</b> "x"', cost: 10 });
  const it = r.shop[r.shop.length - 1];
  assert.ok(!/[<>"&]/.test(it.name));
  o.call('admin:gift:remove', { id: it.id });
});
t('cadeau : nombre maximum', () => {
  const o = boss('ShopBoss4'), added = [];
  // remplissage direct (le serveur limite le nombre de requêtes par connexion)
  while (cfg.SHOP.length < cfg.GIFTS.MAX_ITEMS) added.push(shop.saveGift({ name: 'Rempli', cost: 5 }).shop.slice(-1)[0].id);
  try { assert.ok(o.call('admin:gift:save', { name: 'En trop', cost: 5 }).error); }
  finally { added.forEach(id => shop.remove(id)); }
});
t('bonus du jour : valeurs vérifiées, puis pris en compte par le serveur', () => {
  const o = boss('ShopBoss5'), old = cfg.DAILY_BONUS;
  for (const amount of [-1, 1.5, '5', cfg.GIFTS.MAX_DAILY_BONUS + 1, null]) assert.ok(o.call('admin:daily', { amount }).error, String(amount));
  assert.ok(o.call('admin:daily', { amount: 25 }).ok);
  const p = connect('ShopDaily5'); setBal(p, 0);
  const r = p.call('daily', {});
  assert.ok(r.ok && r.gain === 25 && bal(p) === 25);
  o.call('admin:daily', { amount: old });
});
t('boutique : un membre ordinaire ne peut rien changer', () => {
  const a = connect('ShopA6'), n = cfg.SHOP.length, bonus = cfg.DAILY_BONUS;
  for (const [ev, d] of [['admin:gift:save', { name: 'X', cost: 5 }], ['admin:gift:remove', { id: cfg.SHOP[0].id }], ['admin:daily', { amount: 999 }], ['admin:gifts', {}]]) {
    assert.ok(a.call(ev, d).error, ev);
  }
  assert.strictEqual(cfg.SHOP.length, n); assert.strictEqual(cfg.DAILY_BONUS, bonus);
});
t('admin nommé : peut gérer les cadeaux', () => {
  const o = boss('ShopBoss7'), ad = connect('ShopAdmin7'); makeAdmin(o, ad);
  const r = ad.call('admin:gift:save', { name: 'Par admin', cost: 20 });
  assert.ok(r.ok); ad.call('admin:gift:remove', { id: r.shop.slice(-1)[0].id });
  assert.ok(ad.call('admin:gifts', {}).ok);
});
t('achat : utilise le prix modifié, avec un nouveau cadeau', () => {
  const o = boss('ShopBoss8'), p = connect('ShopBuyer8');
  const id = o.call('admin:gift:save', { name: 'Mini cadeau', cost: 15 }).shop.slice(-1)[0].id;
  setBal(p, 100);
  const r = p.call('shop:buy', { id });
  assert.ok(r.ok && bal(p) === 85);
  o.call('admin:gift:remove', { id });
  assert.ok(p.call('shop:buy', { id }).error);    // cadeau retiré : plus achetable
  assert.strictEqual(bal(p), 85);
});
t('hello : le client reçoit les cadeaux et le bonus actuels', () => {
  const o = boss('ShopBoss9');
  o.call('admin:daily', { amount: 12 });
  const p = new FakeSocket(); all.set(p.id, p); fakeIo.cbs.forEach(cb => cb(p));
  const h = p.call('hello', { name: 'ShopHello9' });
  assert.strictEqual(h.config.dailyBonus, 12);
  assert.ok(h.config.shop.length === cfg.SHOP.length);
  o.call('admin:daily', { amount: 10 });
});
t('shop.json : sauvegardé puis relu au redémarrage', () => {
  const o = boss('ShopBoss10');
  const id = o.call('admin:gift:save', { name: 'Persistant', cost: 33 }).shop.slice(-1)[0].id;
  o.call('admin:daily', { amount: 17 });
  shop.flushNow();
  assert.ok(fs.existsSync(shop.FILE));
  const saved = JSON.parse(fs.readFileSync(shop.FILE, 'utf8'));
  assert.ok(saved.shop.some(x => x.id === id) && saved.dailyBonus === 17);
  cfg.SHOP.splice(0, cfg.SHOP.length); cfg.DAILY_BONUS = 1;   // « redémarrage »
  shop.load();
  assert.ok(cfg.SHOP.some(x => x.id === id && x.cost === 33)); assert.strictEqual(cfg.DAILY_BONUS, 17);
  shop.resetDefaults();
});

/* ================= Exécution ================= */
(async () => {
  for (const item of queue) {
    if (item.title) { console.log(item.title); continue; }
    if (!item.name) { await item.fn(); continue; }
    try { await item.fn(); pass++; console.log('  ok   ' + item.name + ''); }
    catch (e) { fail++; console.log('  ECHEC ' + item.name + '\n        ' + String(e && e.message).split('\n')[0]); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* rien */ }
  console.log('\n' + pass + ' réussis, ' + fail + ' en échec');
  process.exit(fail ? 1 : 0);
})();
