'use strict';
const path = require('path');

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
