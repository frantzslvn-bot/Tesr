'use strict';
// Cadeaux de la boutique et bonus du jour, modifiables depuis l'admin.
// Les réglages sont dans shop.json (même dossier que db.json, donc sauvegardés sur GitHub).
// Ils modifient directement cfg.SHOP et cfg.DAILY_BONUS : socket.js et coins.js les relisent à chaque appel,
// donc un changement est pris en compte tout de suite, sans redémarrer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const FILE = path.join(path.dirname(cfg.DATA_FILE), 'shop.json');
const ID = /^[a-f0-9]{6,12}$|^[a-z0-9_-]{2,20}$/;
const DEFAULT_SHOP = cfg.SHOP.map(x => Object.assign({}, x));   // cadeaux d'origine (config.js)
const DEFAULT_BONUS = cfg.DAILY_BONUS;

let saveTimer = null;

function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069<>&"'`]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 40);
}
function isCost(n) { return Number.isInteger(n) && n >= 1 && n <= cfg.GIFTS.MAX_COST; }
function isBonus(n) { return Number.isInteger(n) && n >= 0 && n <= cfg.GIFTS.MAX_DAILY_BONUS; }

// Remplace le contenu de cfg.SHOP sans changer l'objet (socket.js garde la même référence)
function setShop(list) { cfg.SHOP.splice(0, cfg.SHOP.length, ...list); }

function flush() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ shop: cfg.SHOP, dailyBonus: cfg.DAILY_BONUS }));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Sauvegarde des cadeaux impossible :', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 400); }
function flushNow() { if (saveTimer) clearTimeout(saveTimer); flush(); }

// À appeler au démarrage, APRÈS la restauration depuis GitHub
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(j.shop)) {
      const ok = j.shop
        .filter(x => x && typeof x.id === 'string' && ID.test(x.id) && cleanName(x.name) && isCost(x.cost))
        .slice(0, cfg.GIFTS.MAX_ITEMS)
        .map(x => ({ id: x.id, name: cleanName(x.name), cost: x.cost }));
      setShop(ok);
    }
    if (isBonus(j.dailyBonus)) cfg.DAILY_BONUS = j.dailyBonus;
  } catch (e) { /* pas encore de réglages : on garde ceux de config.js */ }
}

function view() { return { shop: cfg.SHOP.map(x => Object.assign({}, x)), dailyBonus: cfg.DAILY_BONUS }; }

// Ajoute un cadeau (sans id) ou modifie un cadeau existant (avec id)
function save_gift(data) {
  const name = cleanName(data.name);
  if (!name) return { error: 'Donne un nom au cadeau' };
  if (!isCost(data.cost)) return { error: 'Prix invalide (entier entre 1 et ' + cfg.GIFTS.MAX_COST + ')' };
  if (data.id) {
    const it = cfg.SHOP.find(x => x.id === String(data.id));
    if (!it) return { error: 'Cadeau introuvable' };
    it.name = name; it.cost = data.cost;
  } else {
    if (cfg.SHOP.length >= cfg.GIFTS.MAX_ITEMS) return { error: 'Maximum ' + cfg.GIFTS.MAX_ITEMS + ' cadeaux' };
    cfg.SHOP.push({ id: crypto.randomBytes(4).toString('hex'), name, cost: data.cost });
  }
  save();
  return Object.assign({ ok: true }, view());
}

function remove(id) {
  const i = cfg.SHOP.findIndex(x => x.id === String(id));
  if (i < 0) return { error: 'Cadeau introuvable' };
  cfg.SHOP.splice(i, 1);
  save();
  return Object.assign({ ok: true }, view());
}

function setDaily(n) {
  if (!isBonus(n)) return { error: 'Bonus invalide (entier entre 0 et ' + cfg.GIFTS.MAX_DAILY_BONUS + ')' };
  cfg.DAILY_BONUS = n;
  save();
  return Object.assign({ ok: true }, view());
}

// Remet les cadeaux et le bonus d'origine (config.js)
function resetDefaults() {
  setShop(DEFAULT_SHOP.map(x => Object.assign({}, x)));
  cfg.DAILY_BONUS = DEFAULT_BONUS;
  save();
  return Object.assign({ ok: true }, view());
}

module.exports = { load, view, saveGift: save_gift, remove, setDaily, resetDefaults, flushNow, FILE };
