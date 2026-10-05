'use strict';
const path = require('path');

// Lit un entier dans l'environnement ("0" est une vraie valeur, pas "absent")
function envInt(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  ADMIN_CODE: process.env.ADMIN_CODE || '',
  DATA_FILE: process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),

  START_COINS: 120,
  DAILY_BONUS: 10,

  // Mises autorisées (en Coins, entiers)
  BET: {
    pvp:      { min: 5,  max: 10000 },
    roulette: { min: 5,  max: 10000 },
    bot: {
      easy:   { min: 5,  max: 20 },
      normal: { min: 5,  max: 50 },
      hard:   { min: 10, max: 10000 }
    }
  },

  // Contre un robot : victoire = mise rendue + gain égal à la mise
  // Robot facile : gain net maximum par jour et par joueur (anti-farm)
  EASY_DAILY_NET_CAP: 100,

  // Messagerie : limites anti-spam (CHAT_MIN_GAP_MS permet de changer le délai sans toucher au code)
  CHAT: {
    MIN_GAP_MS: envInt('CHAT_MIN_GAP_MS', 700),   // délai minimum entre deux messages d'un même membre
    MSG_PER_MIN: 40,                              // messages par minute et par membre
    GROUP_MIN_MS: 3000                            // délai minimum entre deux créations de groupe
  },

  // Envoi de Coins entre membres (tout est vérifié côté serveur)
  TRANSFER: {
    MIN: 5,                  // envoi minimum
    MAX: 1000,               // envoi maximum, une seule fois
    DAY_MAX: 2000,           // total qu'un membre peut envoyer par jour (anti-farm entre comptes)
    GAP_MS: 2000             // délai minimum entre deux envois d'un même membre
  },

  // Dons / retraits de Coins par l'admin (le créateur n'a aucune limite)
  GIVE: {
    ADMIN_MAX: 1000          // plafond par opération pour un admin nommé
  },

  // Cadeaux et bonus modifiables depuis l'admin (voir shop.js)
  GIFTS: {
    MAX_ITEMS: 30,           // nombre maximum de cadeaux dans la boutique
    MAX_COST: 1000000,       // prix maximum d'un cadeau
    MAX_DAILY_BONUS: 1000    // bonus du jour maximum
  },

  // Notifications d'achat (Telegram / e-mail) : jamais bloquantes
  NOTIFY: {
    TIMEOUT_MS: 6000,        // délai maximum d'un envoi
    MAX_PER_HOUR: 30         // au-delà, les achats sont enregistrés mais plus signalés (anti-spam)
  },

  // Paramètres des jeux
  GAMES: ['tictactoe', 'penalty', 'chess', 'quiz', 'roulette'],
  TURN_SECONDS: { tictactoe: 20, penalty: 12, chess: 90, quiz: 15 },
  PENALTY_ROUNDS: 5,
  QUIZ_QUESTIONS: 5,
  ROOM_IDLE_MINUTES: 30,
  MAX_SPECTATORS: 30,

  // Roulette européenne (0 à 36). Valeurs = total rendu pour 1 de mise.
  ROULETTE: {
    reds: [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36],
    pay: { color: 2, parity: 2, green: 36, number: 36 }
  },

  // Boutique (le prix est vérifié côté serveur)
  SHOP: [
    { id: 'premium', name: 'Abonnement premium',    cost: 500 },
    { id: 'code',    name: 'Carte / code officiel', cost: 300 },
    { id: 'autre',   name: 'Autre récompense',      cost: 100 }
  ]
};
