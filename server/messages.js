'use strict';
// Messagerie : discussions privées (1 à 1) et groupes, avec photos.
// Tout est décidé ici ; le client n'est jamais cru sur parole.
// Les fonctions ne parlent pas au réseau : elles retournent la liste des destinataires (recipients)
// et socket.js se charge d'envoyer les événements en direct.
// Données dans messages.json (même dossier que db.json, donc aussi sauvegardé sur GitHub).
//
// Conversation : { id, type:'dm'|'group', name, by (créateur), created, members:[pid], admins:[pid],
//                  since:{pid: n}  -> un nouveau membre ne voit pas les messages d'avant son arrivée
//                  reads:{pid: n}  -> dernier message lu
//                  seq, msgs:[{id, n, by, text, img?, at, sys?, del?}] }
// hooks (fournis par socket.js) : { imgName, claim(pid, name), onNewImage(name), dropImage(name) }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const coins = require('./coins');

const DIR = path.resolve(path.dirname(cfg.DATA_FILE));
const FILE = path.join(DIR, 'messages.json');

const MAX_TEXT = 1000;       // caractères par message
const MAX_MSGS = 300;        // messages gardés par conversation
const MAX_GROUP = 50;        // membres par groupe
const MAX_GROUPS = 30;       // groupes par membre
const MAX_DMS = 200;         // discussions privées par membre
const MAX_NAME = 30;         // caractères du nom d'un groupe
const PAGE = 40;             // messages chargés d'un coup
const ID = /^[a-f0-9]{12}$/;

// Limites anti-spam : modifiables à chaud (les tests changent MIN_GAP_MS)
const L = Object.assign({ MIN_GAP_MS: 700, MSG_PER_MIN: 40, GROUP_MIN_MS: 3000 }, cfg.CHAT || {});

let db = { convs: {}, blocks: {} };
let saveTimer = null;
const dmIndex = new Map();   // "idA:idB" (triés) -> id de la conversation
const lastMsg = new Map();   // pid -> dernier message envoyé
const perMin = new Map();    // pid -> horodatages des derniers messages
const lastGroup = new Map(); // pid -> dernière création de groupe

/* ---------- Sauvegarde ---------- */

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = { convs: j.convs || {}, blocks: j.blocks || {} };
  } catch (e) { db = { convs: {}, blocks: {} }; }
  dmIndex.clear();
  for (const id in db.convs) {
    const c = db.convs[id];
    if (c.type === 'dm' && c.members.length === 2) dmIndex.set(dmKey(c.members[0], c.members[1]), id);
  }
}
function flush() {
  saveTimer = null;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Sauvegarde de la messagerie impossible :', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 500); }
function flushNow() { if (saveTimer) clearTimeout(saveTimer); flush(); }

/* ---------- Outils ---------- */

function dmKey(a, b) { return a < b ? a + ':' + b : b + ':' + a; }
function newId() { return crypto.randomBytes(6).toString('hex'); }
function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
function cleanGroupName(s) {
  return cleanText(s, 200).replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}
function nameOf(id) { const p = coins.get(id); return p ? p.name : 'Compte supprimé'; }
function usable(id) { const p = coins.get(id); return !!p && !p.banned; }
function isBlocked(by, target) { return (db.blocks[by] || []).indexOf(target) !== -1; }
function eitherBlocked(a, b) { return isBlocked(a, b) || isBlocked(b, a); }
function conv(id) { return typeof id === 'string' && ID.test(id) ? db.convs[id] || null : null; }
function isMember(c, pid) { return c.members.indexOf(pid) !== -1; }
function otherOf(c, pid) { return c.members.find(x => x !== pid) || null; }
function others(c, pid) { return c.members.filter(x => x !== pid); }
function roleOf(c, pid) {
  if (c.type !== 'group') return 'member';
  if (c.by === pid) return 'owner';
  return c.admins.indexOf(pid) !== -1 ? 'admin' : 'member';
}
function isMod(c, pid) { const r = roleOf(c, pid); return r === 'owner' || r === 'admin'; }
function groupCount(pid) {
  let n = 0;
  for (const id in db.convs) if (db.convs[id].type === 'group' && isMember(db.convs[id], pid)) n++;
  return n;
}
function dmCount(pid) {
  let n = 0;
  for (const id in db.convs) if (db.convs[id].type === 'dm' && isMember(db.convs[id], pid)) n++;
  return n;
}
function canWrite(c, pid) {
  if (!isMember(c, pid)) return false;
  if (c.type === 'group') return true;
  const o = otherOf(c, pid);
  return !!o && usable(o) && !eitherBlocked(pid, o);
}

// Les messages d'un compte bloqué ou supprimé sont cachés ; ceux d'avant l'arrivée d'un membre aussi
function visible(c, pid) {
  const since = c.since[pid] || 0;
  return c.msgs.filter(m => m.n > since && (m.sys || usable(m.by)));
}
function unreadOf(c, pid) {
  const read = Math.max(c.reads[pid] || 0, c.since[pid] || 0);
  let n = 0;
  for (const m of c.msgs) if (m.n > read && !m.sys && !m.del && m.by !== pid && usable(m.by)) n++;
  return n;
}
function msgView(m) {
  return {
    id: m.id, n: m.n, at: m.at, sys: !!m.sys, del: !!m.del,
    text: m.del ? '' : m.text,
    img: m.del ? null : (m.img || null),
    by: m.sys ? null : m.by,
    name: m.sys ? '' : nameOf(m.by)
  };
}
function dropImg(hooks, name) { if (name && hooks && hooks.dropImage) hooks.dropImage(name); }
function addMsg(c, by, text, sys, img, hooks) {
  const m = { id: newId(), n: ++c.seq, by: sys ? null : by, text, at: Date.now() };
  if (sys) m.sys = true;
  if (img) m.img = img;
  c.msgs.push(m);
  if (c.msgs.length > MAX_MSGS) {
    for (const old of c.msgs.splice(0, c.msgs.length - MAX_MSGS)) dropImg(hooks, old.img);
  }
  save();
  return m;
}

function summary(c, pid) {
  const vis = visible(c, pid);
  const last = vis.length ? vis[vis.length - 1] : null;
  const o = c.type === 'dm' ? otherOf(c, pid) : null;
  return {
    id: c.id, type: c.type,
    name: c.type === 'dm' ? nameOf(o) : c.name,
    other: o,
    iBlocked: o ? isBlocked(pid, o) : false,
    members: c.members.length,
    unread: unreadOf(c, pid),
    last: last ? {
      text: last.del ? '' : String(last.text).slice(0, 80), img: !!(last.img && !last.del),
      at: last.at, sys: !!last.sys, del: !!last.del,
      mine: last.by === pid, name: last.by ? nameOf(last.by) : ''
    } : null,
    at: last ? last.at : c.created
  };
}

/* ---------- Lecture ---------- */

// Conversations du membre, la plus récente d'abord (une discussion vide n'apparaît pas)
function list(pid) {
  const out = [];
  for (const id in db.convs) {
    const c = db.convs[id];
    if (!isMember(c, pid)) continue;
    if (c.type === 'dm' && !usable(otherOf(c, pid))) continue;
    if (!visible(c, pid).length) continue;
    out.push(summary(c, pid));
  }
  out.sort((a, b) => b.at - a.at);
  return { ok: true, convs: out, unread: out.reduce((t, x) => t + x.unread, 0) };
}

function unreadTotal(pid) {
  let n = 0;
  for (const id in db.convs) {
    const c = db.convs[id];
    if (!isMember(c, pid)) continue;
    if (c.type === 'dm' && !usable(otherOf(c, pid))) continue;
    n += unreadOf(c, pid);
  }
  return n;
}

// Derniers messages, ou page plus ancienne (before). Ne marque PAS comme lu : voir markRead.
function history(pid, id, before) {
  const c = conv(id);
  if (!c || !isMember(c, pid)) return { error: 'Conversation introuvable' };
  const vis = visible(c, pid);
  const older = typeof before === 'number' ? vis.filter(m => m.n < before) : vis;
  const page = older.slice(-PAGE);
  return {
    ok: true,
    conv: Object.assign(summary(c, pid), {
      role: roleOf(c, pid),
      canWrite: canWrite(c, pid),
      reads: Object.assign({}, c.reads),
      members: c.members.map(m => ({ id: m, name: nameOf(m), role: roleOf(c, m) }))
    }),
    msgs: page.map(msgView),
    more: older.length > page.length
  };
}

function markRead(pid, id) {
  const c = conv(id);
  if (!c || !isMember(c, pid)) return { error: 'Conversation introuvable' };
  const changed = (c.reads[pid] || 0) < c.seq;
  if (changed) { c.reads[pid] = c.seq; save(); }
  return { ok: true, changed, n: c.seq, recipients: others(c, pid) };
}

// Qui doit être prévenu que pid est en train d'écrire (null si pid n'est pas dans la conversation)
function typingAudience(pid, id) {
  const c = conv(id);
  if (!c || !isMember(c, pid)) return null;
  return others(c, pid);
}

// Recherche d'un membre par son pseudo (pour écrire ou l'ajouter à un groupe)
function searchUsers(pid, q) {
  q = cleanText(q, 20).toLowerCase();
  return {
    ok: true,
    users: coins.listAll()
      .filter(a => !a.banned && a.id !== pid && (!q || a.name.toLowerCase().indexOf(q) !== -1))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .slice(0, 20)
      .map(a => ({ id: a.id, name: a.name, blocked: isBlocked(pid, a.id) }))
  };
}

// Tous les membres avec qui pid partage une conversation (pour les prévenir d'un blocage / d'une suppression)
function peersOf(pid) {
  const set = new Set();
  for (const id in db.convs) {
    const c = db.convs[id];
    if (isMember(c, pid)) for (const m of c.members) if (m !== pid) set.add(m);
  }
  return Array.from(set);
}

/* ---------- Écriture ---------- */

function openDm(pid, otherId) {
  if (typeof otherId !== 'string' || otherId === pid || !usable(otherId)) return { error: 'Membre introuvable' };
  if (eitherBlocked(pid, otherId)) return { error: 'Impossible d\'écrire à ce membre.' };
  const key = dmKey(pid, otherId), had = dmIndex.get(key);
  if (had && db.convs[had]) return { ok: true, id: had, created: false };
  if (dmCount(pid) >= MAX_DMS) return { error: 'Trop de discussions : supprime-en une avant d\'en ouvrir une autre.' };
  const c = {
    id: newId(), type: 'dm', name: '', by: pid, created: Date.now(),
    members: [pid, otherId], admins: [], since: {}, reads: {}, seq: 0, msgs: []
  };
  db.convs[c.id] = c; dmIndex.set(key, c.id); save();
  return { ok: true, id: c.id, created: true };
}

function send(pid, id, text, img, hooks) {
  const c = conv(id);
  if (!c || !isMember(c, pid)) return { error: 'Conversation introuvable' };
  if (c.type === 'dm') {
    const o = otherOf(c, pid);
    if (!o || !usable(o)) return { error: 'Ce membre n\'est plus joignable.' };
    if (eitherBlocked(pid, o)) return { error: 'Impossible d\'écrire à ce membre.' };
  }
  text = cleanText(text, MAX_TEXT);
  if (img != null && img !== '') {
    if (typeof img !== 'string' || !hooks || !hooks.imgName || !hooks.imgName.test(img)) return { error: 'Photo invalide, renvoie-la.' };
  } else img = null;
  if (!text && !img) return { error: 'Écris un message.' };

  const now = Date.now();
  if (now - (lastMsg.get(pid) || 0) < L.MIN_GAP_MS) return { error: 'Doucement, réessaie dans un instant.' };
  const times = (perMin.get(pid) || []).filter(t => now - t < 60000);
  if (times.length >= L.MSG_PER_MIN) return { error: 'Trop de messages, patiente un peu.' };

  // La photo n'est réclamée qu'une fois toutes les autres vérifications passées
  if (img) {
    if (!hooks.claim || !hooks.claim(pid, img)) return { error: 'Photo introuvable ou déjà utilisée, renvoie-la.' };
    if (hooks.onNewImage) hooks.onNewImage(img);
  }
  lastMsg.set(pid, now);
  times.push(now); perMin.set(pid, times);

  const m = addMsg(c, pid, text, false, img, hooks);
  c.reads[pid] = c.seq;
  return { ok: true, msg: msgView(m), conv: c, recipients: others(c, pid) };
}

// Supprime pour tout le monde : son propre message, ou n'importe lequel si on est admin du groupe
function deleteMsg(pid, id, mid, hooks) {
  const c = conv(id);
  if (!c || !isMember(c, pid)) return { error: 'Conversation introuvable' };
  const m = c.msgs.find(x => x.id === mid);
  if (!m || m.sys) return { error: 'Message introuvable' };
  if (m.by !== pid && !(c.type === 'group' && isMod(c, pid))) return { error: 'Tu ne peux supprimer que tes messages.' };
  if (!m.del) {
    m.del = true; m.text = '';
    if (m.img) { dropImg(hooks, m.img); delete m.img; }
    save();
  }
  return { ok: true, mid: m.id, recipients: c.members.slice() };
}

function toggleBlock(pid, target) {
  if (typeof target !== 'string' || !coins.get(target)) return { error: 'Membre introuvable' };
  if (target === pid) return { error: 'Tu ne peux pas te bloquer toi-même.' };
  const was = isBlocked(pid, target);
  const list = (db.blocks[pid] || []).filter(x => x !== target);
  if (!was) list.push(target);
  if (list.length) db.blocks[pid] = list; else delete db.blocks[pid];
  save();
  return { ok: true, blocked: !was };
}

/* ---------- Groupes ---------- */

function createGroup(pid, name, memberIds) {
  name = cleanGroupName(name);
  if (!name) return { error: 'Donne un nom au groupe.' };
  const ids = [];
  for (const id of Array.isArray(memberIds) ? memberIds.slice(0, 200) : []) {
    if (typeof id === 'string' && id !== pid && ids.indexOf(id) === -1 && usable(id) && !eitherBlocked(pid, id) && groupCount(id) < MAX_GROUPS) ids.push(id);
  }
  if (!ids.length) return { error: 'Choisis au moins un membre.' };
  if (ids.length + 1 > MAX_GROUP) return { error: 'Un groupe contient ' + MAX_GROUP + ' membres au maximum.' };
  if (groupCount(pid) >= MAX_GROUPS) return { error: 'Tu es déjà dans ' + MAX_GROUPS + ' groupes : quitte-en un avant d\'en créer un autre.' };
  const now = Date.now();
  if (now - (lastGroup.get(pid) || 0) < L.GROUP_MIN_MS) return { error: 'Doucement, réessaie dans quelques secondes.' };
  lastGroup.set(pid, now);
  const c = {
    id: newId(), type: 'group', name, by: pid, created: now,
    members: [pid].concat(ids), admins: [], since: {}, reads: {}, seq: 0, msgs: []
  };
  db.convs[c.id] = c;
  addMsg(c, null, nameOf(pid) + ' a créé le groupe « ' + name + ' »', true);
  c.reads[pid] = c.seq;
  save();
  return { ok: true, id: c.id, recipients: ids };
}

// Retire un membre. Si le groupe devient vide il disparaît (avec ses photos).
function dropMember(c, uid, hooks) {
  c.members = c.members.filter(x => x !== uid);
  c.admins = c.admins.filter(x => x !== uid);
  delete c.since[uid]; delete c.reads[uid];
  if (!c.members.length) {
    for (const m of c.msgs) dropImg(hooks, m.img);
    delete db.convs[c.id];
    save();
    return;
  }
  if (c.by === uid) {                      // le créateur part : un admin, sinon le plus ancien membre, prend la suite
    c.by = c.admins[0] || c.members[0];
    c.admins = c.admins.filter(x => x !== c.by);
  }
  save();
}

function groupOf(pid, id) {
  const c = conv(id);
  if (!c || !isMember(c, pid)) return { error: 'Conversation introuvable' };
  if (c.type !== 'group') return { error: 'Cette action concerne les groupes.' };
  return { c };
}

// act : 'rename' | 'add' | 'remove' | 'promote'
function groupAct(pid, id, act, args, hooks) {
  const g = groupOf(pid, id); if (g.error) return g;
  const c = g.c;
  args = args || {};
  let removed;
  let to;   // qui doit être prévenu en plus des membres restants

  if (act === 'rename') {
    if (!isMod(c, pid)) return { error: 'Réservé aux admins du groupe.' };
    const name = cleanGroupName(args.name);
    if (!name) return { error: 'Donne un nom au groupe.' };
    if (name !== c.name) {
      c.name = name;
      addMsg(c, null, nameOf(pid) + ' a renommé le groupe « ' + name + ' »', true, null, hooks);
    }
  } else if (act === 'add') {
    if (!isMod(c, pid)) return { error: 'Réservé aux admins du groupe.' };
    const add = [];
    for (const uid of Array.isArray(args.ids) ? args.ids.slice(0, MAX_GROUP) : []) {
      if (typeof uid === 'string' && add.indexOf(uid) === -1 && usable(uid) && !isMember(c, uid) &&
          !eitherBlocked(pid, uid) && groupCount(uid) < MAX_GROUPS) add.push(uid);
    }
    if (!add.length) return { error: 'Aucun membre à ajouter.' };
    if (c.members.length + add.length > MAX_GROUP) return { error: 'Un groupe contient ' + MAX_GROUP + ' membres au maximum.' };
    for (const uid of add) {
      c.members.push(uid);
      c.since[uid] = c.seq;                // il ne verra pas les messages d'avant son arrivée
      c.reads[uid] = c.seq;
    }
    addMsg(c, null, nameOf(pid) + ' a ajouté ' + add.map(nameOf).join(', '), true, null, hooks);
  } else if (act === 'remove') {
    if (!isMod(c, pid)) return { error: 'Réservé aux admins du groupe.' };
    const uid = args.id;
    if (uid === pid) return { error: 'Utilise « Quitter le groupe ».' };
    if (typeof uid !== 'string' || !isMember(c, uid)) return { error: 'Ce membre n\'est pas dans le groupe.' };
    if (roleOf(c, uid) === 'owner') return { error: 'Le créateur du groupe ne peut pas être retiré.' };
    if (roleOf(c, uid) === 'admin' && roleOf(c, pid) !== 'owner') return { error: 'Seul le créateur du groupe peut retirer un admin.' };
    const who = nameOf(uid);
    dropMember(c, uid, hooks);
    addMsg(c, null, nameOf(pid) + ' a retiré ' + who, true, null, hooks);
    removed = uid; to = [uid];
  } else if (act === 'promote') {
    if (roleOf(c, pid) !== 'owner') return { error: 'Seul le créateur du groupe peut nommer un admin.' };
    const uid = args.id;
    if (typeof uid !== 'string' || !isMember(c, uid) || uid === pid) return { error: 'Ce membre n\'est pas dans le groupe.' };
    const on = !!args.admin, is = c.admins.indexOf(uid) !== -1;
    if (on && !is) { c.admins.push(uid); addMsg(c, null, nameOf(uid) + ' est maintenant admin', true, null, hooks); }
    else if (!on && is) { c.admins = c.admins.filter(x => x !== uid); addMsg(c, null, nameOf(uid) + ' n\'est plus admin', true, null, hooks); }
  } else return { error: 'Action inconnue' };

  save();
  return {
    ok: true, removed,
    recipients: others(c, pid).concat(to || []),
    conv: summary(c, pid)
  };
}

function leave(pid, id, hooks) {
  const g = groupOf(pid, id); if (g.error) return g;
  const c = g.c, who = nameOf(pid);
  dropMember(c, pid, hooks);
  if (db.convs[c.id]) addMsg(c, null, who + ' a quitté le groupe', true, null, hooks);
  save();
  return { ok: true, recipients: db.convs[c.id] ? c.members.slice() : [] };
}

/* ---------- Compte supprimé par l'admin ---------- */

function purgeUser(pid, hooks) {
  for (const id of Object.keys(db.convs)) {
    const c = db.convs[id];
    if (!isMember(c, pid)) continue;
    if (c.type === 'dm') {
      for (const m of c.msgs) dropImg(hooks, m.img);
      dmIndex.delete(dmKey(c.members[0], c.members[1]));
      delete db.convs[id];
    } else {
      c.msgs = c.msgs.filter(m => {
        if (m.by === pid) { dropImg(hooks, m.img); return false; }
        return true;
      });
      dropMember(c, pid, hooks);
      if (db.convs[id]) addMsg(c, null, 'Un membre a quitté le groupe', true, null, hooks);
    }
  }
  delete db.blocks[pid];
  for (const k in db.blocks) {
    db.blocks[k] = db.blocks[k].filter(x => x !== pid);
    if (!db.blocks[k].length) delete db.blocks[k];
  }
  save();
}

// Ménage périodique (appelé chaque minute par socket.js)
function sweep() {
  const now = Date.now();
  for (const id of Object.keys(db.convs)) {            // discussions ouvertes mais jamais écrites : effacées après 24 h
    const c = db.convs[id];
    if (c.type === 'dm' && !c.msgs.length && now - c.created > 24 * 3600 * 1000) {
      dmIndex.delete(dmKey(c.members[0], c.members[1]));
      delete db.convs[id];
      save();
    }
  }
  for (const [pid, t] of lastMsg) if (now - t > 3600 * 1000) { lastMsg.delete(pid); perMin.delete(pid); }
  for (const [pid, t] of lastGroup) if (now - t > 3600 * 1000) lastGroup.delete(pid);
}

load();
process.on('exit', () => { try { flushNow(); } catch (e) { /* rien à faire */ } });

module.exports = {
  MAX_TEXT, MAX_GROUP, MAX_MSGS, PAGE,
  list, unreadTotal, history, markRead, typingAudience, searchUsers, peersOf, summary,
  openDm, send, deleteMsg, toggleBlock, createGroup, groupAct, leave, purgeUser, sweep, flushNow,
  _debug: { L }
};
