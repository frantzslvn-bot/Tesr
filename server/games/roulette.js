'use strict';
// Roulette européenne (0 à 36), joueur contre la banque.
// Le tirage est fait uniquement ici (crypto.randomInt), jamais côté client.
// Pas de salle : un appel = une mise débitée, un tirage, un gain crédité.
const crypto = require('crypto');
const cfg = require('../config');
const coins = require('../coins');

const REDS = new Set(cfg.ROULETTE.reds);
const history = [];          // derniers numéros, visibles par tous
const lastSpin = new Map();  // anti-spam par joueur
const COOLDOWN_MS = 1200;

function colorOf(n) {
  if (n === 0) return 'green';
  return REDS.has(n) ? 'red' : 'black';
}

// Valide le choix du joueur ; retourne {kind, pay} ou null
function parseChoice(c) {
  if (!c || typeof c !== 'object') return null;
  const pay = cfg.ROULETTE.pay;
  if (c.type === 'color' && (c.value === 'red' || c.value === 'black')) return { kind: 'color', pay: pay.color };
  if (c.type === 'parity' && (c.value === 'even' || c.value === 'odd')) return { kind: 'parity', pay: pay.parity };
  if (c.type === 'green') return { kind: 'green', pay: pay.green };
  if (c.type === 'number' && Number.isInteger(c.value) && c.value >= 0 && c.value <= 36) return { kind: 'number', pay: pay.number };
  return null;
}

function wins(choice, n) {
  switch (choice.type) {
    case 'color':  return n !== 0 && colorOf(n) === choice.value;
    case 'parity': return n !== 0 && (n % 2 === 0) === (choice.value === 'even');
    case 'green':  return n === 0;
    case 'number': return n === choice.value;
  }
  return false;
}

function spin(playerId, bet, choice) {
  const p = coins.get(playerId);
  if (!p || p.banned) return { error: 'Compte indisponible' };

  const now = Date.now();
  if (now - (lastSpin.get(playerId) || 0) < COOLDOWN_MS) return { error: 'Doucement, attends une seconde' };

  const parsed = parseChoice(choice);
  if (!parsed) return { error: 'Choix invalide' };

  const lim = cfg.BET.roulette;
  if (!Number.isInteger(bet) || bet < lim.min || bet > lim.max) {
    return { error: 'Mise entre ' + lim.min + ' et ' + lim.max + ' Coins' };
  }
  if (!coins.debit(playerId, bet)) return { error: 'Pas assez de Coins' };
  lastSpin.set(playerId, now);

  const n = crypto.randomInt(0, 37);
  const win = wins(choice, n);
  const payout = win ? bet * parsed.pay : 0;
  if (payout) coins.credit(playerId, payout);

  history.unshift({ n, color: colorOf(n) });
  if (history.length > 15) history.pop();

  return {
    ok: true, n, color: colorOf(n), win,
    payout, net: payout - bet, coins: coins.get(playerId).coins
  };
}

function getHistory() { return history.slice(); }

module.exports = { name: 'roulette', spin, history: getHistory, colorOf, wins, parseChoice };
