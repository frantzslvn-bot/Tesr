'use strict';
// Penalty : tirs au but à 5 tirs par joueur, puis mort subite.
// À chaque tir, le tireur choisit où tirer (G / C / D) et le gardien où plonger.
// Les deux choix restent cachés sur le serveur jusqu'à ce que les deux soient faits.
const cfg = require('../config');

const DIRS = ['L', 'C', 'R'];
const MAX_AUTO = 2; // choix automatiques tolérés par joueur avant forfait
function rnd(a) { return a[Math.floor(Math.random() * a.length)]; }

function create() {
  return {
    k: 0,                 // numéro du tir en cours (0, 1, 2...)
    pick: [null, null],   // choix cachés de la manche en cours, par siège
    score: [0, 0],
    taken: [0, 0],        // tirs déjà tirés par siège
    hist: [],             // [{ shooter, shot, dive, goal }]
    missed: [0, 0],       // choix automatiques consécutifs
    last: null
  };
}

const shooterOf = s => s.k % 2;

function view(room, seat) {
  const s = room.state, N = cfg.PENALTY_ROUNDS;
  return {
    k: s.k,
    shooter: shooterOf(s),
    score: s.score.slice(),
    taken: s.taken.slice(),
    regulation: N,
    suddenDeath: s.taken[0] >= N && s.taken[1] >= N,
    chosen: [s.pick[0] !== null, s.pick[1] !== null],   // jamais la valeur de l'adversaire
    mine: seat === 0 || seat === 1 ? s.pick[seat] : null,
    last: s.last,
    hist: s.hist.map(h => ({ shooter: h.shooter, goal: h.goal }))
  };
}

// -1 = pas fini, sinon siège gagnant
function decide(s) {
  const N = cfg.PENALTY_ROUNDS;
  const t0 = s.taken[0], t1 = s.taken[1];
  if (t0 <= N && t1 <= N) {
    if (s.score[0] > s.score[1] + (N - t1)) return 0;
    if (s.score[1] > s.score[0] + (N - t0)) return 1;
  } else if (t0 === t1 && s.score[0] !== s.score[1]) {
    return s.score[0] > s.score[1] ? 0 : 1;
  }
  return -1;
}

function resolve(room) {
  const s = room.state;
  const sh = shooterOf(s), kp = 1 - sh;
  const shot = s.pick[sh], dive = s.pick[kp];
  const goal = shot !== dive;
  if (goal) s.score[sh]++;
  s.taken[sh]++;
  s.last = { k: s.k, shooter: sh, shot, dive, goal };
  s.hist.push({ shooter: sh, shot, dive, goal });
  s.k++;
  s.pick = [null, null];
  const w = decide(s);
  if (w >= 0) room.result = { winner: w, reason: 'Score final ' + s.score[0] + ' - ' + s.score[1] };
}

function move(room, seat, data) {
  const s = room.state;
  if (room.status !== 'playing') return { error: 'Partie terminée' };
  if (seat !== 0 && seat !== 1) return { error: 'Spectateur' };
  const dir = data && data.dir;
  if (DIRS.indexOf(dir) < 0) return { error: 'Choix invalide' };
  if (s.pick[seat] !== null) return { error: 'Choix déjà fait' };
  s.pick[seat] = dir;
  s.missed[seat] = 0;
  if (s.pick[0] !== null && s.pick[1] !== null) resolve(room);
  return { ok: true };
}

// Le robot ne regarde JAMAIS le choix en cours du joueur : seulement l'historique.
function leastAndMost(hist, seat, key) {
  const c = { L: 0, C: 0, R: 0 };
  hist.forEach(h => { if (h.shooter === seat) c[h.shot]++; });
  return c;
}
function botChoice(room) {
  const s = room.state;
  const botSeat = 1, human = 0;
  const botShoots = shooterOf(s) === botSeat;
  const adaptive = room.level === 'hard' ? 0.65 : room.level === 'normal' ? 0.3 : 0;
  if (Math.random() >= adaptive || !s.hist.length) return rnd(DIRS);
  if (botShoots) {
    // le joueur plonge : tirer là où il a le moins plongé
    const c = { L: 0, C: 0, R: 0 };
    s.hist.forEach(h => { if (h.shooter === botSeat) c[h.dive]++; });
    const min = Math.min(c.L, c.C, c.R);
    return rnd(DIRS.filter(d => c[d] === min));
  }
  // le joueur tire : plonger là où il tire le plus souvent
  const c = leastAndMost(s.hist, human);
  const max = Math.max(c.L, c.C, c.R);
  return rnd(DIRS.filter(d => c[d] === max));
}

function bot(room) {
  const s = room.state;
  if (room.status !== 'playing' || s.pick[1] !== null) return false;
  s.pick[1] = botChoice(room);
  if (s.pick[0] !== null) resolve(room);
  return true;
}

function timeLimit(room) {
  if (room.status !== 'playing') return 0;
  const s = room.state;
  for (let seat = 0; seat < 2; seat++) {
    if (!room.seats[seat].bot && s.pick[seat] === null) return cfg.TURN_SECONDS.penalty * 1000;
  }
  return 0;
}

// Temps écoulé : choix au hasard pour ceux qui n'ont pas joué ; 3 oublis de suite = forfait
function timeout(room) {
  const s = room.state;
  if (room.status !== 'playing') return;
  for (let seat = 0; seat < 2; seat++) {
    if (room.seats[seat].bot || s.pick[seat] !== null) continue;
    s.missed[seat]++;
    if (s.missed[seat] > MAX_AUTO) {
      room.result = { winner: 1 - seat, reason: 'Inactivité' };
      return;
    }
    s.pick[seat] = rnd(DIRS);
  }
  if (s.pick[0] !== null && s.pick[1] !== null) resolve(room);
}

module.exports = { name: 'penalty', create, view, move, bot, timeLimit, timeout };
