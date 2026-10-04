'use strict';
// Portefeuille et comptes. Tout est calculé côté serveur.
// Sauvegarde dans un fichier JSON (écriture atomique, différée de 400 ms).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

let db = { players: {} };
let saveTimer = null;

function today() { return new Date().toISOString().slice(0, 10); }
function isAmount(n) { return Number.isInteger(n) && n > 0 && n <= 1e9; }

function load() {
  try {
    db = JSON.parse(fs.readFileSync(cfg.DATA_FILE, 'utf8'));
    if (!db.players) db.players = {};
  } catch (e) {
    db = { players: {} };
  }
}

function flush() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(cfg.DATA_FILE), { recursive: true });
    const tmp = cfg.DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, cfg.DATA_FILE);
  } catch (e) {
    console.error('Sauvegarde impossible :', e.message);
  }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 400); }
function flushNow() { if (saveTimer) clearTimeout(saveTimer); flush(); }

function cleanName(s) {
  s = String(s || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return s || 'Membre';
}

function createPlayer(name) {
  const id = crypto.randomBytes(6).toString('hex');
  const p = {
    id,
    token: crypto.randomBytes(24).toString('hex'),
    name: cleanName(name),
    coins: cfg.START_COINS,
    lastBonus: '',
    easy: { day: '', net: 0 },
    admin: false,
    banned: false,
    created: Date.now()
  };
  db.players[id] = p;
  save();
  return p;
}

function byToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  for (const id in db.players) {
    if (db.players[id].token === token) return db.players[id];
  }
  return null;
}

function get(id) { return db.players[id] || null; }

function rename(id, name) {
  const p = get(id); if (!p) return null;
  p.name = cleanName(name); save(); return p;
}

// Ce que le client a le droit de voir
function pub(p) {
  return { id: p.id, name: p.name, coins: p.coins, admin: !!p.admin };
}

// Débite d'abord, joue ensuite : si la page se ferme, la mise est déjà prise.
function debit(id, amount) {
  const p = get(id);
  if (!p || p.banned || !isAmount(amount) || p.coins < amount) return false;
  p.coins -= amount; save();
  return true;
}

function credit(id, amount) {
  const p = get(id);
  if (!p || !isAmount(amount)) return false;
  p.coins += amount; save();
  return true;
}

function canAfford(id, amount) {
  const p = get(id);
  return !!p && !p.banned && isAmount(amount) && p.coins >= amount;
}

function claimDaily(id) {
  const p = get(id);
  if (!p || p.banned) return { ok: false, error: 'compte' };
  if (p.lastBonus === today()) return { ok: false, error: 'deja', coins: p.coins };
  p.lastBonus = today();
  p.coins += cfg.DAILY_BONUS;
  save();
  return { ok: true, coins: p.coins, gain: cfg.DAILY_BONUS };
}

function dailyClaimed(id) {
  const p = get(id);
  return !!p && p.lastBonus === today();
}

// Robot facile : combien de gain net est encore permis aujourd'hui ?
// Retourne le gain net accordé (entre 0 et "wanted") et l'enregistre.
function easyNet(id, wanted) {
  const p = get(id);
  if (!p) return 0;
  if (p.easy.day !== today()) p.easy = { day: today(), net: 0 };
  const room = Math.max(0, cfg.EASY_DAILY_NET_CAP - p.easy.net);
  const granted = Math.min(wanted, room);
  p.easy.net += granted;
  save();
  return granted;
}

function leaderboard(n) {
  return Object.values(db.players)
    .filter(p => !p.banned)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, n || 10)
    .map(p => ({ id: p.id, name: p.name, coins: p.coins }));
}

// --- Admin ---
function listAll() {
  return Object.values(db.players).map(p => ({
    id: p.id, name: p.name, coins: p.coins, admin: !!p.admin, banned: !!p.banned
  }));
}
function setAdmin(id, v) { const p = get(id); if (!p) return false; p.admin = !!v; save(); return true; }
function setBanned(id, v) { const p = get(id); if (!p) return false; p.banned = !!v; save(); return true; }
function remove(id) { if (!db.players[id]) return false; delete db.players[id]; save(); return true; }

load();
process.on('exit', () => { try { flushNow(); } catch (e) {} });

module.exports = {
  isAmount, createPlayer, byToken, get, rename, pub,
  debit, credit, canAfford, claimDaily, dailyClaimed, easyNet,
  leaderboard, listAll, setAdmin, setBanned, remove, flushNow
};
