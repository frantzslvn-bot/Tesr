'use strict';
// Quiz : 5 questions (config), 4 choix, 15 s par question.
// Le serveur garde la bonne réponse secrète jusqu'à la révélation de chaque question.
// Gagnant = plus de bonnes réponses ; à égalité, temps cumulé le plus court sur les bonnes réponses.
const cfg = require('../config');
const BANK = require('./quiz-questions');

const REVEAL_MS = 2800;
const MAX_MISSED = 2;
const BOT_ACCURACY = { easy: 0.4, normal: 0.65, hard: 0.88 };
const BOT_SPEED = { easy: [5000, 12000], normal: [3000, 9000], hard: [1500, 6000] };

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function between(r) { return r[0] + Math.floor(Math.random() * (r[1] - r[0])); }

function create() {
  const picked = shuffle(BANK).slice(0, cfg.QUIZ_QUESTIONS).map(row => {
    const correctText = row[1];
    const opts = shuffle(row.slice(1));
    return { text: row[0], opts, c: opts.indexOf(correctText) };
  });
  return {
    qs: picked, i: 0, phase: 'q', startedAt: Date.now(),
    pick: [null, null],      // -1 = pas de réponse
    at: [null, null],        // temps de réponse (ms)
    score: [0, 0], time: [0, 0],
    missed: [0, 0],
    reveal: null
  };
}

function view(room, seat) {
  const s = room.state, q = s.qs[s.i];
  const out = {
    n: s.qs.length, i: s.i, phase: s.phase,
    q: { text: q.text, opts: q.opts },
    answered: [s.pick[0] !== null, s.pick[1] !== null],
    mine: seat === 0 || seat === 1 ? s.pick[seat] : null,
    score: s.score.slice(),
    reveal: s.phase === 'reveal' ? s.reveal : null   // la bonne réponse n'apparaît qu'ici
  };
  if (room.status === 'over' || room.result) out.time = s.time.slice();
  return out;
}

function finish(room) {
  const s = room.state;
  let winner = null, reason = s.score[0] + ' - ' + s.score[1];
  if (s.score[0] !== s.score[1]) {
    winner = s.score[0] > s.score[1] ? 0 : 1;
  } else if (s.time[0] !== s.time[1]) {
    winner = s.time[0] < s.time[1] ? 0 : 1;
    reason += ' (départagés au temps)';
  }
  room.result = { winner, reason };
}

function resolveQ(room) {
  const s = room.state, q = s.qs[s.i];
  const correct = [0, 1].map(k => s.pick[k] === q.c);
  correct.forEach((ok, k) => { if (ok) { s.score[k]++; s.time[k] += s.at[k]; } });
  s.reveal = { i: s.i, c: q.c, picks: s.pick.slice(), correct };
  s.phase = 'reveal';
  if (s.i === s.qs.length - 1) finish(room);
}

function nextQ(room) {
  const s = room.state;
  s.i++;
  s.pick = [null, null]; s.at = [null, null];
  s.phase = 'q'; s.startedAt = Date.now(); s.reveal = null;
}

function move(room, seat, data) {
  const s = room.state;
  if (room.status !== 'playing') return { error: 'Partie terminée' };
  if (seat !== 0 && seat !== 1) return { error: 'Spectateur' };
  if (s.phase !== 'q') return { error: 'Question terminée' };
  if (!data || data.i !== s.i) return { error: 'Mauvaise question' };
  const o = data.o;
  if (!Number.isInteger(o) || o < 0 || o > 3) return { error: 'Réponse invalide' };
  if (s.pick[seat] !== null) return { error: 'Déjà répondu' };
  s.pick[seat] = o;
  s.at[seat] = Math.min(Date.now() - s.startedAt, cfg.TURN_SECONDS.quiz * 1000);
  s.missed[seat] = 0;
  if (s.pick[0] !== null && s.pick[1] !== null) resolveQ(room);
  return { ok: true };
}

function botAnswer(room) {
  const s = room.state, q = s.qs[s.i];
  const lvl = BOT_ACCURACY[room.level] ? room.level : 'easy';
  let o = q.c;
  if (Math.random() >= BOT_ACCURACY[lvl]) {
    const wrong = [0, 1, 2, 3].filter(x => x !== q.c);
    o = wrong[Math.floor(Math.random() * wrong.length)];
  }
  s.pick[1] = o;
  s.at[1] = Math.min(between(BOT_SPEED[lvl]), cfg.TURN_SECONDS.quiz * 1000);
}

function bot(room) {
  const s = room.state;
  if (room.status !== 'playing' || s.phase !== 'q' || s.pick[1] !== null) return false;
  botAnswer(room);
  if (s.pick[0] !== null) resolveQ(room);
  return true;
}

function timeLimit(room) {
  if (room.status !== 'playing') return 0;
  const s = room.state;
  if (s.phase === 'reveal') return REVEAL_MS;
  for (let seat = 0; seat < 2; seat++) {
    if (!room.seats[seat].bot && s.pick[seat] === null) return cfg.TURN_SECONDS.quiz * 1000;
  }
  return 0;
}

function timeout(room) {
  const s = room.state;
  if (room.status !== 'playing') return;
  if (s.phase === 'reveal') { nextQ(room); return; }
  for (let seat = 0; seat < 2; seat++) {
    if (s.pick[seat] !== null) continue;
    if (room.seats[seat].bot) { botAnswer(room); continue; }
    s.missed[seat]++;
    if (s.missed[seat] > MAX_MISSED) {
      room.result = { winner: 1 - seat, reason: 'Inactivité' };
      return;
    }
    s.pick[seat] = -1;
    s.at[seat] = cfg.TURN_SECONDS.quiz * 1000;
  }
  resolveQ(room);
}

module.exports = { name: 'quiz', create, view, move, bot, timeLimit, timeout };
