'use strict';
// Portefeuille et comptes. Tout est calculé côté serveur.
// Sauvegarde dans un fichier JSON (écriture atomique, différée de 400 ms).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

let db = { players: {}, purchases: [], ledger: [] };
let saveTimer = null;

function today() { return new Date().toISOString().slice(0, 10); }
function isAmount(n) { return Number.isInteger(n) && n > 0 && n <= 1e9; }

function load() {
  try {
    db = JSON.parse(fs.readFileSync(cfg.DATA_FILE, 'utf8'));
    if (!db.players) db.players = {};
    if (!Array.isArray(db.purchases)) db.purchases = [];
    if (!Array.isArray(db.ledger)) db.ledger = [];
  } catch (e) {
    db = { players: {}, purchases: [], ledger: [] };
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

// --- Achats de la boutique (dans db.json : sauvegardés sur GitHub avec les Coins) ---
const MAX_PURCHASES = 300;

// Enregistre un achat « à livrer ». Retourne l'achat avec son identifiant.
function addPurchase(info) {
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    at: Date.now(),
    pid: info.pid, name: info.name, item: info.item, cost: info.cost,
    status: 'todo'
  };
  db.purchases.unshift(rec);
  if (db.purchases.length > MAX_PURCHASES) {
    // on garde d'abord les achats pas encore livrés : on retire le plus ancien déjà livré
    let i = db.purchases.length - 1;
    while (i > 0 && db.purchases[i].status !== 'done') i--;
    db.purchases.splice(db.purchases[i].status === 'done' ? i : db.purchases.length - 1, 1);
  }
  save();
  return rec;
}
function listPurchases(n) { return db.purchases.slice(0, n || 30); }
function markDelivered(id) {
  const rec = db.purchases.find(x => x.id === id);
  if (!rec) return { error: 'Achat introuvable' };
  rec.status = 'done'; rec.doneAt = Date.now();
  save();
  return { ok: true, purchase: rec };
}

load();
process.on('exit', () => { try { flushNow(); } catch (e) {} });

// --- Envois et dons de Coins ---
const MAX_BALANCE = 1e12;      // plafond d'un solde (évite les nombres trop grands)
const MAX_LEDGER = 500;        // lignes gardées dans le journal

// Journal : envois entre membres, dons et retraits de l'admin (dans db.json : sauvegardé sur GitHub)
function addLedger(info) {
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    at: Date.now(),
    type: info.type,                       // 'send' | 'give' | 'take'
    from: info.from || null, fromName: info.fromName || '',
    to: info.to, toName: info.toName || '',
    amount: info.amount,
    by: info.by || ''                      // 'owner' | 'admin' pour un don / retrait
  };
  db.ledger.unshift(rec);
  if (db.ledger.length > MAX_LEDGER) db.ledger.length = MAX_LEDGER;
  save();
  return rec;
}
function listLedger(n) { return db.ledger.slice(0, n || 50); }

// Envoi d'un membre à un autre. Le débit et le crédit se font ensemble ici, jamais séparément.
// opts : { min, max, dayMax }. Retourne { ok, coins, toCoins, rec } ou { error }.
function transfer(fromId, toId, amount, opts) {
  opts = opts || {};
  const a = get(fromId), b = get(toId);
  if (!a || a.banned) return { error: 'Compte indisponible' };
  if (!b || b.banned) return { error: 'Ce membre est introuvable' };
  if (a.id === b.id) return { error: 'Tu ne peux pas t\'envoyer des Coins' };
  if (!Number.isInteger(amount) || amount <= 0) return { error: 'Montant invalide' };
  if (opts.min && amount < opts.min) return { error: 'Envoi minimum : ' + opts.min + ' Coins' };
  if (opts.max && amount > opts.max) return { error: 'Envoi maximum : ' + opts.max + ' Coins' };
  if (a.coins < amount) return { error: 'Il te manque ' + (amount - a.coins) + ' Coins' };
  if (b.coins + amount > MAX_BALANCE) return { error: 'Ce membre ne peut pas en recevoir autant' };
  if (!a.sent || a.sent.day !== today()) a.sent = { day: today(), n: 0 };
  if (opts.dayMax && a.sent.n + amount > opts.dayMax) {
    return { error: 'Limite du jour : il te reste ' + Math.max(0, opts.dayMax - a.sent.n) + ' Coins à envoyer' };
  }
  a.coins -= amount; b.coins += amount; a.sent.n += amount;
  const rec = addLedger({ type: 'send', from: a.id, fromName: a.name, to: b.id, toName: b.name, amount });
  return { ok: true, coins: a.coins, toCoins: b.coins, rec };
}

// Don (amount > 0) ou retrait (amount < 0) par l'admin. Un retrait ne descend jamais sous 0.
// Retourne { ok, coins, applied, rec } ou { error }. Pas de limite ici : socket / transfers.js décident qui peut.
function adjust(id, amount, by, actorId) {
  const t = get(id);
  if (!t) return { error: 'Compte introuvable' };
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1e9) return { error: 'Montant invalide' };
  let applied = amount;
  if (amount < 0) applied = -Math.min(t.coins, -amount);
  else applied = Math.min(amount, MAX_BALANCE - t.coins);
  if (applied === 0) return { error: amount < 0 ? 'Ce compte n\'a plus de Coins' : 'Solde déjà au maximum' };
  t.coins += applied;
  const actor = actorId ? get(actorId) : null;
  const rec = addLedger({
    type: applied > 0 ? 'give' : 'take', from: actor ? actor.id : null, fromName: actor ? actor.name : 'Créateur',
    to: t.id, toName: t.name, amount: Math.abs(applied), by: by || ''
  });
  return { ok: true, coins: t.coins, applied, rec };
}


module.exports = {
  isAmount, createPlayer, byToken, get, rename, pub,
  debit, credit, canAfford, claimDaily, dailyClaimed, easyNet,
  leaderboard, listAll, setAdmin, setBanned, remove, flushNow,
  addPurchase, listPurchases, markDelivered,
  addLedger, listLedger, transfer, adjust
};
