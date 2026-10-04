'use strict';
// Fil de publications (façon Instagram) : texte + une image JPEG optionnelle.
// Pas de vidéo ni de document : les membres collent un lien dans le texte.
// Tout est décidé ici ; le client n'est jamais cru sur parole.
// Données dans posts.json (même dossier que db.json, donc aussi sauvegardé sur GitHub).
// Les images sont dans data/img/<id>.jpg et sauvegardées une par une sur GitHub.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const coins = require('./coins');

const DIR = path.resolve(path.dirname(cfg.DATA_FILE));
const FILE = path.join(DIR, 'posts.json');
const IMG_DIR = path.join(DIR, 'img');

const MAX_TEXT = 500;
const MAX_COMMENT = 200;
const MAX_COMMENTS_PER_POST = 200;
const PAGE = 15;
const MAX_IMG_BYTES = 700 * 1024;
const IMG_NAME = /^[a-f0-9]{16}\.jpg$/;

let db = { posts: [], follows: {}, reports: [] };
let saveTimer = null;
const lastAct = new Map();     // "pid:action" -> dernier horodatage
const daily = new Map();       // "pid:action:jour" -> compteur
const pendingUploads = new Map();   // nom d'image -> { pid, at } (image envoyée, pas encore publiée)

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = { posts: j.posts || [], follows: j.follows || {}, reports: j.reports || [] };
  } catch (e) { db = { posts: [], follows: {}, reports: [] }; }
}
function flush() {
  saveTimer = null;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Sauvegarde du fil impossible :', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 500); }
function flushNow() { if (saveTimer) clearTimeout(saveTimer); flush(); }

function day() { return new Date().toISOString().slice(0, 10); }
function newId() { return crypto.randomBytes(8).toString('hex'); }

// Limites : délai minimum entre deux actions + plafond par jour
function allow(pid, action, minMs, perDay) {
  const now = Date.now(), k = pid + ':' + action;
  if (now - (lastAct.get(k) || 0) < minMs) return 'Doucement, réessaie dans quelques secondes.';
  const dk = k + ':' + day();
  if ((daily.get(dk) || 0) >= perDay) return 'Limite du jour atteinte pour cette action.';
  lastAct.set(k, now); daily.set(dk, (daily.get(dk) || 0) + 1);
  return null;
}
function cleanText(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/* ---------- Images ---------- */

// Un vrai JPEG : débute par FFD8FF, finit par FFD9, taille raisonnable.
function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 200 && buf.length <= MAX_IMG_BYTES &&
    buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF &&
    buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
}
function imgPath(name) { return path.join(IMG_DIR, name); }

// Enregistre une image envoyée par un membre. Retourne { name } ou { error }.
function saveImage(pid, buf) {
  const p = coins.get(pid);
  if (!p || p.banned) return { error: 'Compte indisponible' };
  if (!isJpeg(buf)) return { error: 'Image invalide (JPEG uniquement, 700 Ko maximum).' };
  const wait = allow(pid, 'upload', 8000, 30);
  if (wait) return { error: wait };
  const name = crypto.randomBytes(8).toString('hex') + '.jpg';
  try {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(imgPath(name), buf);
  } catch (e) { return { error: 'Enregistrement impossible, réessaie.' }; }
  pendingUploads.set(name, { pid, at: Date.now() });
  return { name };
}
function removeImageFile(name) { try { fs.unlinkSync(imgPath(name)); } catch (e) { /* déjà absente */ } }

/* ---------- Publications ---------- */

function authorOf(id) {
  const p = coins.get(id);
  return p ? { id: p.id, name: p.name } : { id, name: 'Compte supprimé' };
}
function visible(post) {
  const a = coins.get(post.by);
  return !!a && !a.banned;
}
function view(post, viewer) {
  return {
    id: post.id, author: authorOf(post.by), text: post.text, img: post.img || null, at: post.at,
    likes: post.likes.length, liked: post.likes.indexOf(viewer) !== -1,
    comments: post.comments.length, mine: post.by === viewer
  };
}
function findPost(id) { return db.posts.find(p => p.id === id) || null; }

function create(pid, text, img, onNewImage) {
  const p = coins.get(pid);
  if (!p || p.banned) return { error: 'Compte indisponible' };
  text = cleanText(text, MAX_TEXT);
  if (img) {
    const up = pendingUploads.get(img);
    if (typeof img !== 'string' || !IMG_NAME.test(img) || !up || up.pid !== pid) return { error: 'Image introuvable, renvoie-la.' };
  }
  if (!text && !img) return { error: 'Écris quelque chose ou ajoute une photo.' };
  const wait = allow(pid, 'post', 20000, 20);
  if (wait) return { error: wait };
  const post = { id: newId(), by: pid, text, img: img || null, at: Date.now(), likes: [], comments: [] };
  db.posts.unshift(post);
  if (img) { pendingUploads.delete(img); if (onNewImage) onNewImage(img); }
  save();
  return { ok: true, post: view(post, pid) };
}

function feed(pid, scope, before) {
  const follows = new Set(db.follows[pid] || []);
  const cut = Number.isFinite(before) ? before : Infinity;
  const out = [];
  for (const post of db.posts) {           // déjà du plus récent au plus ancien
    if (post.at >= cut) continue;
    if (!visible(post)) continue;
    if (scope === 'following' && !follows.has(post.by) && post.by !== pid) continue;
    out.push(post);
    if (out.length > PAGE) break;
  }
  const more = out.length > PAGE;
  const page = out.slice(0, PAGE);
  return { posts: page.map(x => view(x, pid)), more, next: page.length ? page[page.length - 1].at : null };
}

function toggleLike(pid, id) {
  const post = findPost(id);
  if (!post || !visible(post)) return { error: 'Publication introuvable' };
  const i = post.likes.indexOf(pid);
  if (i === -1) post.likes.push(pid); else post.likes.splice(i, 1);
  save();
  return { ok: true, liked: i === -1, likes: post.likes.length };
}

function listComments(pid, id) {
  const post = findPost(id);
  if (!post || !visible(post)) return { error: 'Publication introuvable' };
  const list = post.comments.filter(c => { const a = coins.get(c.by); return a && !a.banned; })
    .map(c => ({ id: c.id, author: authorOf(c.by), text: c.text, at: c.at, mine: c.by === pid }));
  return { ok: true, comments: list };
}

function addComment(pid, id, text) {
  const post = findPost(id);
  if (!post || !visible(post)) return { error: 'Publication introuvable' };
  text = cleanText(text, MAX_COMMENT).replace(/\n+/g, ' ');
  if (!text) return { error: 'Commentaire vide' };
  if (post.comments.length >= MAX_COMMENTS_PER_POST) return { error: 'Cette publication est pleine de commentaires.' };
  const wait = allow(pid, 'comment', 3000, 150);
  if (wait) return { error: wait };
  const c = { id: newId(), by: pid, text, at: Date.now() };
  post.comments.push(c); save();
  return { ok: true, comment: { id: c.id, author: authorOf(pid), text: c.text, at: c.at, mine: true }, count: post.comments.length };
}

function isAdmin(pid) { const p = coins.get(pid); return !!p && p.admin && !p.banned; }

function deleteComment(pid, id, cid, owner) {
  const post = findPost(id);
  if (!post) return { error: 'Publication introuvable' };
  const i = post.comments.findIndex(c => c.id === cid);
  if (i < 0) return { error: 'Commentaire introuvable' };
  const c = post.comments[i];
  if (c.by !== pid && post.by !== pid && !owner && !isAdmin(pid)) return { error: 'Action refusée' };
  post.comments.splice(i, 1); save();
  return { ok: true, count: post.comments.length };
}

// Supprime une publication. onImageGone(nom) est appelé pour effacer aussi la sauvegarde GitHub.
function deletePost(pid, id, owner, onImageGone) {
  const post = findPost(id);
  if (!post) return { error: 'Publication introuvable' };
  if (post.by !== pid && !owner && !isAdmin(pid)) return { error: 'Action refusée' };
  removePostObj(post, onImageGone);
  return { ok: true };
}
function removePostObj(post, onImageGone) {
  db.posts.splice(db.posts.indexOf(post), 1);
  db.reports = db.reports.filter(r => r.post !== post.id);
  if (post.img) { removeImageFile(post.img); if (onImageGone) onImageGone(post.img); }
  save();
}
// Compte supprimé : on retire ses publications, commentaires, likes, abonnements
function purgeUser(pid, onImageGone) {
  for (const post of db.posts.filter(x => x.by === pid)) removePostObj(post, onImageGone);
  for (const post of db.posts) {
    post.comments = post.comments.filter(c => c.by !== pid);
    post.likes = post.likes.filter(x => x !== pid);
  }
  delete db.follows[pid];
  for (const k in db.follows) db.follows[k] = db.follows[k].filter(x => x !== pid);
  db.reports = db.reports.filter(r => r.by !== pid);
  save();
}

function report(pid, id, reason) {
  const post = findPost(id);
  if (!post || !visible(post)) return { error: 'Publication introuvable' };
  if (post.by === pid) return { error: 'C\'est ta publication : tu peux la supprimer.' };
  if (db.reports.some(r => r.post === id && r.by === pid)) return { ok: true };
  const wait = allow(pid, 'report', 2000, 30);
  if (wait) return { error: wait };
  db.reports.push({ post: id, by: pid, reason: cleanText(reason, 100), at: Date.now() });
  save();
  return { ok: true };
}

// Pour l'admin : publications signalées, les plus signalées d'abord
function reportList() {
  const by = {};
  for (const r of db.reports) (by[r.post] = by[r.post] || []).push(r);
  return Object.keys(by).map(id => {
    const post = findPost(id); if (!post) return null;
    const rs = by[id];
    return { post: id, author: authorOf(post.by), text: post.text.slice(0, 140), img: post.img || null,
      count: rs.length, reasons: rs.map(r => r.reason).filter(Boolean).slice(0, 3), at: rs[rs.length - 1].at };
  }).filter(Boolean).sort((a, b) => b.count - a.count || b.at - a.at).slice(0, 40);
}
function clearReports(id) { db.reports = db.reports.filter(r => r.post !== id); save(); return { ok: true }; }

/* ---------- Abonnements et profils ---------- */

function toggleFollow(pid, target) {
  const t = coins.get(target);
  if (!t || t.banned) return { error: 'Compte introuvable' };
  if (target === pid) return { error: 'Tu ne peux pas te suivre toi-même.' };
  const list = db.follows[pid] || (db.follows[pid] = []);
  const i = list.indexOf(target);
  if (i === -1) list.push(target); else list.splice(i, 1);
  save();
  return { ok: true, following: i === -1, followers: followersOf(target) };
}
function followersOf(id) {
  let n = 0;
  for (const k in db.follows) if (db.follows[k].indexOf(id) !== -1) { const a = coins.get(k); if (a && !a.banned) n++; }
  return n;
}
function profile(pid, id) {
  const p = coins.get(id);
  if (!p || p.banned) return { error: 'Compte introuvable' };
  const mine = db.posts.filter(x => x.by === id);
  return {
    ok: true,
    user: { id: p.id, name: p.name },
    posts: mine.length,
    followers: followersOf(id),
    following: (db.follows[id] || []).filter(x => { const a = coins.get(x); return a && !a.banned; }).length,
    isFollowing: (db.follows[pid] || []).indexOf(id) !== -1,
    me: id === pid,
    grid: mine.slice(0, 60).map(x => ({ id: x.id, img: x.img || null, text: x.text.slice(0, 60) }))
  };
}
function getOne(pid, id) {
  const post = findPost(id);
  if (!post || !visible(post)) return { error: 'Publication introuvable' };
  return { ok: true, post: view(post, pid) };
}

// Images envoyées mais jamais publiées : on les efface au bout d'une heure
function sweepUploads(onImageGone) {
  const now = Date.now();
  for (const [name, up] of pendingUploads) {
    if (now - up.at > 3600 * 1000) {
      pendingUploads.delete(name); removeImageFile(name); if (onImageGone) onImageGone(name);
    }
  }
  for (const [k, t] of lastAct) if (now - t > 3600 * 1000) lastAct.delete(k);
  const today = day();
  for (const k of daily.keys()) if (!k.endsWith(':' + today)) daily.delete(k);
}

load();
process.on('exit', () => { try { flushNow(); } catch (e) { /* rien */ } });

module.exports = {
  IMG_NAME, MAX_IMG_BYTES, isJpeg, imgPath, saveImage, create, feed, toggleLike, listComments, addComment,
  deleteComment, deletePost, purgeUser, report, reportList, clearReports, toggleFollow, profile, getOne,
  sweepUploads, flushNow
};
