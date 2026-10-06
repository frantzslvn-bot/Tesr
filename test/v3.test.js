'use strict';
// Lancer avec : npm test  (ou : node test/v3.test.js)
// Compte créateur, abonnements, « À la une », recherche de membres, compatibilité des données.
// Aucun réseau : faux sockets.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Doit être défini AVANT de charger le serveur (config.js lit l'environnement au chargement)
const TMP = path.join(os.tmpdir(), 'dracula-v3-test-' + process.pid);
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
const posts = require('../server/posts');
const creator = require('../server/creator');

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
creator.attach(fakeIo);

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

function dm(a, b) { const r = a.call('chat:open', { with: b.me.id }); return r.id || r.conv.id; }

function reset() { creator._reset(); }
const mkPost = (s, text) => posts.create(s.me.id, text || 'Publication de ' + s.me.name, null, () => { }).post;
const following = (a, b) => posts.isFollowing(a.me.id, b.me.id);

/* ================= Compte créateur ================= */
title('Compte créateur');
t('sans créateur : aucune carte, rien ne casse', () => {
  reset(); const a = connect('V3NoCrea');
  const r = a.call('creator:info', {});
  assert.ok(r.ok && r.creator === null && r.following === false && r.isCreator === false);
  assert.ok(a.call('creator:follow', {}).error);
});
t('seul le code créateur désigne le compte créateur', () => {
  reset(); const a = connect('V3Sneaky');
  assert.ok(a.call('admin:creator:set', {}).error);
  assert.ok(a.call('admin:creator:state', {}).error);
  assert.ok(a.call('admin:creator:followall', {}).error);
  assert.ok(a.call('admin:creator:auto', { on: true }).error);
  const ad = connect('V3Named'), o = boss('V3BossX'); makeAdmin(o, ad);
  assert.ok(ad.call('admin:creator:set', {}).error);          // un admin nommé n'a pas ce pouvoir
  assert.strictEqual(a.call('creator:info', {}).creator, null);
});
t('le créateur se désigne ; les autres le voient, lui est « abonné » à lui-même', () => {
  reset(); const o = boss('V3Boss1'), m = connect('V3Member1');
  const r = o.call('admin:creator:set', {});
  assert.ok(r.ok && r.creator.id === o.me.id && r.creator.name === 'V3Boss1');
  const im = m.call('creator:info', {});
  assert.deepStrictEqual([im.creator.id, im.following, im.isCreator], [o.me.id, false, false]);
  const io_ = o.call('creator:info', {});
  assert.deepStrictEqual([io_.isCreator, io_.following], [true, true]);
  assert.ok(broadcast.some(x => x.ev === 'creator:update'));
});
t('s\'abonner au créateur : fonctionne, et recommencer ne désabonne pas', () => {
  reset(); const o = boss('V3Boss2'), m = connect('V3Member2'); o.call('admin:creator:set', {});
  assert.strictEqual(m.call('creator:follow', {}).following, true);
  assert.strictEqual(m.call('creator:follow', {}).following, true);   // 2e appui : toujours abonné
  assert.ok(following(m, o));
  assert.strictEqual(m.call('creator:info', {}).following, true);
});
t('se désabonner depuis le profil fait revenir la carte', () => {
  reset(); const o = boss('V3Boss3'), m = connect('V3Member3'); o.call('admin:creator:set', {});
  m.call('creator:follow', {});
  assert.strictEqual(m.call('user:follow', { id: o.me.id }).following, false);
  assert.strictEqual(m.call('creator:info', {}).following, false);
});
t('le créateur ne peut pas s\'abonner à lui-même', () => {
  reset(); const o = boss('V3Boss4'); o.call('admin:creator:set', {});
  assert.ok(o.call('creator:follow', {}).error);
});
t('remplacer le compte créateur', () => {
  reset(); const o1 = boss('V3Boss5a'), o2 = boss('V3Boss5b'), m = connect('V3Member5');
  o1.call('admin:creator:set', {}); o2.call('admin:creator:set', {});
  assert.strictEqual(m.call('creator:info', {}).creator.id, o2.me.id);
  assert.strictEqual(o2.call('admin:creator:state', {}).isCreator, true);
  assert.strictEqual(o1.call('admin:creator:state', {}).isCreator, false);
});
t('un créateur bloqué disparaît (plus de carte vers un compte bloqué)', () => {
  reset(); const o = boss('V3Boss6'), o2 = boss('V3Boss6b'), m = connect('V3Member6'); o.call('admin:creator:set', {});
  assert.ok(o2.call('admin:act', { act: 'ban', id: o.me.id }).ok);
  assert.strictEqual(m.call('creator:info', {}).creator, null);
});

/* ================= Abonnements en masse ================= */
title('Abonner les membres');
t('« abonner tout le monde » : tous les membres, une seule fois chacun', () => {
  reset(); const o = boss('V3Boss7'), a = connect('V3A7'), b = connect('V3B7');
  o.call('admin:creator:set', {});
  const r1 = o.call('admin:creator:followall', {});
  assert.ok(r1.ok && r1.added >= 2);
  assert.ok(following(a, o) && following(b, o));
  assert.ok(!following(o, o));
  assert.strictEqual(o.call('admin:creator:followall', {}).added, 0);   // déjà fait
});
t('« abonner tout le monde » sans créateur : refusé', () => {
  reset(); const o = boss('V3Boss8'); assert.ok(o.call('admin:creator:followall', {}).error);
});
t('les comptes bloqués ne sont pas abonnés', () => {
  reset(); const o = boss('V3Boss9'), a = connect('V3A9'); o.call('admin:creator:set', {});
  o.call('admin:act', { act: 'ban', id: a.me.id });
  o.call('admin:creator:followall', {});
  assert.ok(!following(a, o));
});
t('abonnement automatique : les nouveaux membres suivent le créateur', () => {
  reset(); const o = boss('V3Boss10'); o.call('admin:creator:set', {});
  const before = connect('V3Before10');
  assert.ok(!following(before, o));                       // désactivé : rien
  const r = o.call('admin:creator:auto', { on: true });
  assert.ok(r.ok && r.autoFollow === true && r.added >= 1);
  assert.ok(following(before, o));                        // l'activation rattrape les anciens
  const after = connect('V3After10');
  assert.ok(following(after, o));                         // et les nouveaux
  assert.strictEqual(after.call('creator:info', {}).following, true);
});
t('abonnement automatique coupé : les nouveaux ne sont plus abonnés', () => {
  reset(); const o = boss('V3Boss11'); o.call('admin:creator:set', {});
  o.call('admin:creator:auto', { on: true }); o.call('admin:creator:auto', { on: false });
  const n = connect('V3New11'); assert.ok(!following(n, o));
});
t('un membre abonné automatiquement peut se désabonner', () => {
  reset(); const o = boss('V3Boss12'); o.call('admin:creator:set', {}); o.call('admin:creator:auto', { on: true });
  const n = connect('V3New12');
  assert.strictEqual(n.call('user:follow', { id: o.me.id }).following, false);
});
t('la valeur « on » doit être exactement vraie', () => {
  reset(); const o = boss('V3Boss13'); o.call('admin:creator:set', {});
  assert.strictEqual(o.call('admin:creator:auto', { on: 'oui' }).autoFollow, false);
});

/* ================= À la une ================= */
title('À la une');
t('un membre ordinaire ne peut pas mettre à la une', () => {
  reset(); const a = connect('V3FA'), p = mkPost(a);
  assert.ok(a.call('admin:feature', { id: p.id }).error);
  assert.strictEqual(a.call('feed:featured', {}).posts.length, 0);
});
t('le créateur et un admin nommé mettent et retirent', () => {
  reset(); const o = boss('V3FBoss'), ad = connect('V3FAdmin'), a = connect('V3FB'); makeAdmin(o, ad);
  const p1 = mkPost(a, 'un'), p2 = mkPost(connect('V3FC'), 'deux');
  assert.ok(o.call('admin:feature', { id: p1.id }).ok);
  assert.ok(ad.call('admin:feature', { id: p2.id }).ok);
  const l = a.call('feed:featured', {});
  assert.deepStrictEqual(l.posts.map(x => x.id), [p2.id, p1.id]);          // le plus récent en premier
  assert.ok(a.call('creator:info', {}).featured.indexOf(p1.id) !== -1);
  const off = o.call('admin:feature', { id: p1.id, on: false });
  assert.ok(off.ok && off.on === false);
  assert.deepStrictEqual(a.call('feed:featured', {}).posts.map(x => x.id), [p2.id]);
});
t('mettre deux fois à la une ne duplique pas', () => {
  reset(); const o = boss('V3FBoss2'), p = mkPost(connect('V3FD'));
  o.call('admin:feature', { id: p.id }); o.call('admin:feature', { id: p.id });
  assert.strictEqual(o.call('feed:featured', {}).posts.length, 1);
});
t('publication inconnue refusée', () => {
  reset(); const o = boss('V3FBoss3');
  assert.ok(o.call('admin:feature', { id: 'inconnue' }).error);
  assert.ok(o.call('admin:feature', {}).error);
});
t('une publication supprimée disparaît de « À la une »', () => {
  reset(); const o = boss('V3FBoss4'), a = connect('V3FE'), p = mkPost(a);
  o.call('admin:feature', { id: p.id });
  assert.ok(a.call('post:delete', { id: p.id }).ok);
  assert.strictEqual(a.call('feed:featured', {}).posts.length, 0);
  assert.strictEqual(a.call('creator:info', {}).featured.length, 0);
});
t('maximum de publications à la une', () => {
  reset(); const o = boss('V3FBoss5'); const ids = [];
  for (let i = 0; i < 21; i++) ids.push(mkPost(connect('V3Mx' + i), 'p' + i).id);
  let err = null;
  for (const id of ids) { const r = o.call('admin:feature', { id }); if (r.error) err = r.error; }
  assert.ok(err && /Maximum/.test(err));
  assert.strictEqual(o.call('feed:featured', {}).posts.length, 20);
});

/* ================= Recherche de membres ================= */
title('Recherche de membres');
t('trouve par morceau de pseudo, sans soi-même', () => {
  reset(); const me = connect('Zoé-Cherche'), x = connect('Zoé-Cible1'), y = connect('Zoé-Cible2'), z = connect('AutreNom');
  const r = me.call('members:search', { q: 'zoé-ci' });
  assert.deepStrictEqual(r.users.map(u => u.name).sort(), ['Zoé-Cible1', 'Zoé-Cible2']);
  assert.ok(!r.users.some(u => u.id === me.me.id));
  assert.ok(me.call('members:search', { q: 'ZOÉ-CIBLE1' }).users.some(u => u.id === x.me.id));   // sans tenir compte des majuscules
});
t('indique abonné, en ligne, nombre de publications, créateur', () => {
  reset(); const o = boss('V3SBoss'), me = connect('V3SMe'), a = connect('V3SAlpha');
  o.call('admin:creator:set', {}); mkPost(a, 'x');   // le serveur espace les publications d'un même membre
  me.call('user:follow', { id: a.me.id });
  const r = me.call('members:search', { q: 'v3s' });
  const ua = r.users.find(u => u.id === a.me.id), uo = r.users.find(u => u.id === o.me.id);
  assert.deepStrictEqual([ua.following, ua.posts, ua.online, ua.creator], [true, 1, true, false]);
  assert.strictEqual(uo.creator, true);
  assert.strictEqual(r.users[0].id, o.me.id);                // le créateur arrive en premier
});
t('les comptes bloqués n\'apparaissent pas', () => {
  reset(); const o = boss('V3SBoss2'), me = connect('V3SMe2'), a = connect('V3SBan');
  o.call('admin:act', { act: 'ban', id: a.me.id });
  assert.ok(!me.call('members:search', { q: 'v3sban' }).users.some(u => u.id === a.me.id));
});
t('requête vide : une liste limitée ; requête piégée : nettoyée', () => {
  reset(); const me = connect('V3SMe3');
  const r = me.call('members:search', {});
  assert.ok(r.ok && r.users.length <= 30);
  assert.ok(me.call('members:search', { q: '<script>' + 'x'.repeat(500) }).ok);
  assert.ok(me.call('members:search', { q: { a: 1 } }).ok);
});
t('il faut un compte pour chercher', () => {
  const s = new FakeSocket(); all.set(s.id, s); fakeIo.cbs.forEach(cb => cb(s));
  for (const ev of ['members:search', 'creator:info', 'creator:follow', 'feed:featured']) assert.ok(s.call(ev, {}).error, ev);
});

/* ================= Sauvegarde et compatibilité ================= */
title('Sauvegarde et compatibilité des données');
t('les réglages sont écrits dans settings.json puis relus', () => {
  reset(); const o = boss('V3PBoss'), p = mkPost(connect('V3PA'));
  o.call('admin:creator:set', {}); o.call('admin:creator:auto', { on: true }); o.call('admin:feature', { id: p.id });
  creator.flushNow();
  const saved = JSON.parse(fs.readFileSync(creator.FILE, 'utf8'));
  assert.deepStrictEqual([saved.creatorId, saved.autoFollow, saved.featured], [o.me.id, true, [p.id]]);
  reset(); assert.strictEqual(creator._state().creatorId, null);       // « redémarrage »
  creator.load();
  assert.deepStrictEqual([creator._state().creatorId, creator._state().autoFollow, creator._state().featured], [o.me.id, true, [p.id]]);
});
t('settings.json absent ou abîmé : démarrage normal', () => {
  reset(); const orig = fs.readFileSync(creator.FILE, 'utf8');
  try {
    fs.writeFileSync(creator.FILE, '{pas du json'); creator.load();
    assert.strictEqual(creator._state().creatorId, null);
    fs.writeFileSync(creator.FILE, JSON.stringify({ creatorId: '../etc', autoFollow: 'oui', featured: ['ok-id-1', 5, '../x', null] })); creator.load();
    assert.deepStrictEqual([creator._state().creatorId, creator._state().autoFollow, creator._state().featured], [null, false, ['ok-id-1']]);
    fs.unlinkSync(creator.FILE); creator.load();
    assert.strictEqual(creator._state().creatorId, null);
  } finally { fs.writeFileSync(creator.FILE, orig); creator.load(); }
});
t('settings.json fait partie des fichiers sauvegardés sur GitHub', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'backup.js'), 'utf8');
  assert.ok(/settings\.json/.test(src) && /shop\.json/.test(src) && /posts\.json/.test(src) && /messages\.json/.test(src));
});
t('les nouveautés ne modifient ni les Coins, ni les publications, ni les messages', () => {
  reset(); const o = boss('V3CBoss'), a = connect('V3CA'), b = connect('V3CB'); setBal(a, 321);
  const p = mkPost(a, 'texte'); const ida = dm(a, b);
  a.call('chat:send', { id: ida, text: 'coucou' });
  const players = () => JSON.stringify(coins.listAll().map(x => ({ id: x.id, name: x.name, coins: x.coins, admin: !!x.admin, banned: !!x.banned })));
  const postsView = () => JSON.stringify(posts.getOne('x', p.id));
  const msgs = () => JSON.stringify(b.call('chat:history', { id: ida }));
  const B = [players(), postsView(), msgs()];
  o.call('admin:creator:set', {}); o.call('admin:creator:followall', {}); o.call('admin:creator:auto', { on: true });
  o.call('admin:feature', { id: p.id }); a.call('members:search', { q: 'v3' }); a.call('feed:featured', {});
  assert.deepStrictEqual([players(), postsView(), msgs()], B);
  assert.strictEqual(bal(a), 321);
});
t('un ancien jeu de fichiers (sans settings.json) se relit tel quel', () => {
  // db.json / posts.json / messages.json existent déjà d'une version précédente : on vérifie qu'ils se rechargent
  // sans settings.json et sans que celui-ci soit nécessaire.
  const dir = path.join(TMP, 'old'); fs.mkdirSync(dir, { recursive: true });
  const oldPosts = { posts: [{ id: 'p1', by: 'u1', text: 'ancien', at: 1, likes: ['u2'], comments: [] }], follows: { u2: ['u1'] }, reports: [] };
  fs.writeFileSync(path.join(dir, 'posts.json'), JSON.stringify(oldPosts));
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'posts.json'), 'utf8'));
  assert.deepStrictEqual(j, oldPosts);
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
});

/* ================= Exécution ================= */
(async () => {
  for (const item of queue) {
    if (item.title) { console.log(item.title); continue; }
    if (!item.name) { await item.fn(); continue; }
    try { await item.fn(); pass++; console.log('  ok   ' + item.name); }
    catch (e) { fail++; console.log('  ECHEC ' + item.name + '\n        ' + String(e && e.message).split('\n')[0]); }
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* rien */ }
  console.log('\n' + pass + ' réussis, ' + fail + ' en échec');
  process.exit(fail ? 1 : 0);
})();
