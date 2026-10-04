'use strict';
// Morpion. Interface commune à tous les jeux :
//   create(room) -> state        view(room, seat) -> objet envoyé au client (seat 0, 1 ou null = spectateur)
//   move(room, seat, data) -> {ok} | {error}      bot(room) -> true si le robot a joué
//   timeLimit(room) -> ms (0 = pas de limite)     timeout(room) -> applique la sanction
// Fin de partie : le jeu renseigne room.result = { winner: 0 | 1 | null (nul), reason, ... }
const cfg = require('../config');

const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const MARKS = ['X', 'O'];

function lineOf(b) {
  for (const l of LINES) {
    if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return l;
  }
  return null;
}
function freeCells(b) {
  const r = [];
  for (let i = 0; i < 9; i++) if (!b[i]) r.push(i);
  return r;
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function create() {
  return { board: Array(9).fill(''), turn: 0, line: null };
}

function view(room) {
  const s = room.state;
  return { board: s.board.slice(), turn: s.turn, marks: MARKS, line: s.line };
}

function place(room, i) {
  const s = room.state;
  s.board[i] = MARKS[s.turn];
  const line = lineOf(s.board);
  if (line) {
    s.line = line;
    room.result = { winner: s.turn, reason: 'Trois alignés' };
  } else if (!freeCells(s.board).length) {
    room.result = { winner: null, reason: 'Match nul' };
  } else {
    s.turn = 1 - s.turn;
  }
}

function move(room, seat, data) {
  const s = room.state;
  if (room.status !== 'playing') return { error: 'Partie terminée' };
  if (seat !== s.turn) return { error: "Ce n'est pas ton tour" };
  const i = data && data.i;
  if (!Number.isInteger(i) || i < 0 || i > 8) return { error: 'Case invalide' };
  if (s.board[i]) return { error: 'Case occupée' };
  place(room, i);
  return { ok: true };
}

// Cherche une case qui fait gagner "mark" tout de suite
function winningCell(b, mark) {
  for (const i of freeCells(b)) {
    b[i] = mark;
    const w = lineOf(b);
    b[i] = '';
    if (w) return i;
  }
  return -1;
}

// Minimax : score du point de vue de "me" (plus rapide = mieux)
function minimax(b, mark, me, opp, depth) {
  const l = lineOf(b);
  if (l) return b[l[0]] === me ? 10 - depth : depth - 10;
  const f = freeCells(b);
  if (!f.length) return 0;
  const maxing = mark === me;
  let best = maxing ? -Infinity : Infinity;
  for (const i of f) {
    b[i] = mark;
    const sc = minimax(b, maxing ? opp : me, me, opp, depth + 1);
    b[i] = '';
    best = maxing ? Math.max(best, sc) : Math.min(best, sc);
  }
  return best;
}

function hardMove(b, me, opp) {
  let best = -Infinity, cells = [];
  for (const i of freeCells(b)) {
    b[i] = me;
    const sc = minimax(b, opp, me, opp, 1);
    b[i] = '';
    if (sc > best) { best = sc; cells = [i]; }
    else if (sc === best) cells.push(i);
  }
  return pick(cells);
}

function bot(room) {
  const s = room.state;
  if (room.status !== 'playing' || s.turn !== 1) return false;
  const b = s.board, me = MARKS[1], opp = MARKS[0];
  let i;
  if (room.level === 'hard') {
    i = hardMove(b, me, opp);
  } else if (room.level === 'normal') {
    i = winningCell(b, me);
    if (i < 0) i = winningCell(b, opp);
    if (i < 0 || Math.random() < 0.15) {
      const f = freeCells(b);
      const pref = [4, 0, 2, 6, 8].filter(c => f.includes(c));
      i = (pref.length && Math.random() < 0.6) ? pref[0] : pick(f);
    }
  } else {
    i = pick(freeCells(b));
  }
  place(room, i);
  return true;
}

function timeLimit(room) {
  if (room.status !== 'playing') return 0;
  const seat = room.state.turn;
  if (room.seats[seat].bot) return 0;
  return cfg.TURN_SECONDS.tictactoe * 1000;
}

// Temps écoulé : le joueur qui devait jouer perd
function timeout(room) {
  if (room.status !== 'playing') return;
  room.result = { winner: 1 - room.state.turn, reason: 'Temps écoulé' };
}

module.exports = { name: 'tictactoe', create, view, move, bot, timeLimit, timeout };
