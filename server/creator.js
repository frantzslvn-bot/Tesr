'use strict';
// Compte créateur, abonnement au créateur, publications « À la une » et recherche de membres.
// Les réglages sont dans settings.json (même dossier que db.json, donc sauvegardés sur GitHub).
// Ce fichier est NOUVEAU : db.json, posts.json et messages.json ne changent pas de format.
//
// Client -> serveur
//   creator:info {}                  créateur + « suis-je abonné ? » + ids à la une (tout membre)
//   feed:featured {}                 publications à la une (tout membre)
//   members:search {q}               recherche de membres (tout membre)
//   admin:creator:set {}             fait du compte connecté le compte créateur (code créateur requis)
//   admin:creator:state {}           réglages (code créateur requis)
//   admin:creator:followall {}       abonne tous les membres existants au créateur (code créateur requis)
//   admin:creator:auto {on}          abonne automatiquement les nouveaux membres (code créateur requis)
//   admin:feature {id, on}           met / retire une publication de « À la une » (créateur ou admin)
// Serveur -> client : creator:update {creator, ...} quand le compte créateur change
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const coins = require('./coins');
const posts = require('./posts');

const FILE = path.join(path.dirname(cfg.DATA_FILE), 'settings.json');
const MAX_FEATURED = 20;
const ID = /^[A-Za-z0-9_-]{4,64}$/;

let st = { creatorId: null, autoFollow: false, featured: [] };
let saveTimer = null;

function reply(ack, obj) { if (typeof ack === 'function') ack(obj); }

function flush() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Sauvegarde des réglages impossible :', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 400); }
function flushNow() { if (saveTimer) clearTimeout(saveTimer); if (dirty) flush(); }
let dirty = false;
function touch() { dirty = true; save(); }
const _flush = flush;
// flush() doit aussi remettre « dirty » à zéro
function flushAll() { dirty = false; _flush(); }

// À appeler au démarrage, APRÈS la restauration depuis GitHub
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    st = {
      creatorId: typeof j.creatorId === 'string' && ID.test(j.creatorId) ? j.creatorId : null,
      autoFollow: j.autoFollow === true,
      featured: Array.isArray(j.featured) ? j.featured.filter(x => typeof x === 'string' && ID.test(x)).slice(0, MAX_FEATURED) : []
    };
  } catch (e) { /* pas encore de réglages */ }
}

function creatorAccount() {
  if (!st.creatorId) return null;
  const a = coins.get(st.creatorId);
  return a && !a.banned ? a : null;
}
function creatorView() { const a = creatorAccount(); return a ? { id: a.id, name: a.name } : null; }

function info(pid) {
  const c = creatorView();
  return {
    ok: true,
    creator: c,
    following: !!c && (c.id === pid || posts.isFollowing(pid, c.id)),
    isCreator: !!c && c.id === pid,
    featured: st.featured.slice()
  };
}

function setCreator(pid) {
  const a = coins.get(pid);
  if (!a || a.banned) return { error: 'Compte introuvable' };
  st.creatorId = pid; touch();
  if (st.autoFollow) followAll();
  return { ok: true, creator: creatorView() };
}

// Abonne tous les membres existants au créateur ; renvoie le nombre de nouveaux abonnements
function followAll() {
  const c = creatorAccount();
  if (!c) return { error: 'Choisis d\'abord le compte créateur' };
  let added = 0;
  for (const a of coins.listAll()) if (posts.ensureFollow(a.id, c.id)) added++;
  return { ok: true, added };
}

function setAuto(on) {
  st.autoFollow = on === true; touch();
  let added = 0;
  if (st.autoFollow && creatorAccount()) added = followAll().added;
  return { ok: true, autoFollow: st.autoFollow, added };
}

// Appelé par socket.js à la création d'un compte neuf
function onNewAccount(pid) {
  if (!st.autoFollow) return false;
  const c = creatorAccount();
  if (!c || c.id === pid) return false;
  return posts.ensureFollow(pid, c.id);
}

function setFeatured(id, on) {
  id = String(id || '');
  const found = posts.getOne('x', id);
  if (found.error) return { error: 'Publication introuvable' };
  const i = st.featured.indexOf(id);
  if (on === false) { if (i !== -1) st.featured.splice(i, 1); }
  else if (i === -1) {
    if (st.featured.length >= MAX_FEATURED) return { error: 'Maximum ' + MAX_FEATURED + ' publications à la une' };
    st.featured.unshift(id);
  }
  touch();
  return { ok: true, featured: st.featured.slice(), on: st.featured.indexOf(id) !== -1 };
}

// Publications à la une encore existantes (les supprimées sont retirées de la liste)
function featuredList(pid) {
  const out = [], keep = [];
  for (const id of st.featured) {
    const r = posts.getOne(pid, id);
    if (r.ok) { out.push(r.post); keep.push(id); }
  }
  if (keep.length !== st.featured.length) { st.featured = keep; touch(); }
  return { ok: true, posts: out };
}

function cleanQuery(q) {
  return String(q == null ? '' : q).replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 20);
}

function attach(io) {
  function online(pid) {
    for (const s of io.sockets.sockets.values()) if (s.data && s.data.pid === pid) return true;
    return false;
  }

  io.on('connection', socket => {
    function on(ev, fn) {
      socket.on(ev, (a, b) => {
        const data = typeof a === 'function' ? {} : (a && typeof a === 'object' ? a : {});
        const ack = typeof a === 'function' ? a : b;
        try { fn(data, ack); } catch (e) { console.error(ev, e); reply(ack, { error: 'Erreur du serveur' }); }
      });
    }
    function authed(ev, fn) {
      on(ev, (data, ack) => {
        const p = coins.get(socket.data.pid);
        if (!p) return reply(ack, { error: 'Session expirée, recharge la page' });
        if (p.banned) return reply(ack, { error: 'Compte bloqué' });
        fn(p, data, ack);
      });
    }
    function owner(ev, fn) {   // code créateur obligatoire
      authed(ev, (p, data, ack) => {
        if (!socket.data.owner) return reply(ack, { error: 'Réservé au créateur' });
        fn(p, data, ack);
      });
    }

    authed('creator:info', (p, data, ack) => reply(ack, info(p.id)));
    authed('feed:featured', (p, data, ack) => reply(ack, featuredList(p.id)));

    authed('members:search', (p, data, ack) => {
      const q = cleanQuery(data.q), c = st.creatorId;
      const users = coins.listAll()
        .filter(a => !a.banned && a.id !== p.id && (!q || a.name.toLowerCase().indexOf(q) !== -1))
        .map(a => ({ id: a.id, name: a.name, posts: posts.countOf(a.id), online: online(a.id), following: posts.isFollowing(p.id, a.id), creator: a.id === c }))
        .sort((x, y) => (y.creator - x.creator) || (y.online - x.online) || x.name.localeCompare(y.name, 'fr'))
        .slice(0, 30);
      reply(ack, { ok: true, users });
    });

    owner('admin:creator:set', (p, data, ack) => {
      const r = setCreator(p.id);
      if (r.error) return reply(ack, r);
      io.emit('creator:update', { creator: r.creator });
      reply(ack, r);
    });
    owner('admin:creator:state', (p, data, ack) => reply(ack, { ok: true, creator: creatorView(), autoFollow: st.autoFollow, isCreator: st.creatorId === p.id }));
    owner('admin:creator:followall', (p, data, ack) => reply(ack, followAll()));
    owner('admin:creator:auto', (p, data, ack) => reply(ack, setAuto(data.on === true)));

    on('admin:feature', (data, ack) => {
      const p = coins.get(socket.data.pid);
      const ok = socket.data.owner || (p && p.admin && !p.banned);
      if (!ok) return reply(ack, { error: 'Accès refusé' });
      reply(ack, setFeatured(data.id, data.on !== false));
    });
  });
}

module.exports = {
  load, attach, info, setCreator, followAll, setAuto, onNewAccount, setFeatured, featuredList,
  flushNow: flushAll, FILE, _state: () => st, _reset: () => { st = { creatorId: null, autoFollow: false, featured: [] }; }
};
