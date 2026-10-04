'use strict';
// Échecs. Même interface que les autres jeux (create, view, move, bot, timeLimit, timeout).
// Siège 0 = Blancs, siège 1 = Noirs. Contre le robot, le joueur a les Blancs.
// Les règles viennent de chess-engine.js ; le client ne reçoit que les coups légaux
// du joueur dont c'est le tour (information publique, rien de caché).
const cfg = require('../config');
const { Position, sqName } = require('./chess-engine');

const REASONS = {
  checkmate: 'Échec et mat',
  stalemate: 'Pat',
  insufficient: 'Matériel insuffisant',
  fifty: 'Règle des 50 coups',
  repetition: 'Triple répétition'
};

const seatOfTurn = pos => (pos.turn === 'w' ? 0 : 1);

function create() {
  return { pos: new Position(), ply: 0, last: null };
}

function view(room, seat) {
  const s = room.state, pos = s.pos;
  const out = {
    board: pos.board.slice(),          // 64 cases, a8 = 0 ... h1 = 63, '' = vide
    turn: pos.turn,
    ply: s.ply,
    last: s.last,                      // { from, to } du dernier coup
    check: pos.inCheck() ? sqName(pos.ksq[pos.turn]) : null,
    moves: {},                         // { e2: ['e3','e4'] } seulement pour le joueur au trait
    promo: []                          // ['e7e8'] : coups qui demandent un choix de pièce
  };
  if (room.status === 'playing' && seat === seatOfTurn(pos)) {
    for (const m of pos.legalMoves()) {
      if (m.pr && m.pr !== 'q') continue;   // une seule entrée par case d'arrivée
      const f = sqName(m.f), t = sqName(m.t);
      (out.moves[f] = out.moves[f] || []).push(t);
      if (m.pr) out.promo.push(f + t);
    }
  }
  return out;
}

function apply(room, m) {
  const s = room.state, pos = s.pos;
  pos.play(m);
  s.ply++;
  s.last = { from: sqName(m.f), to: sqName(m.t) };
  const st = pos.status();
  if (st.over) {
    room.result = {
      winner: st.winner === 'w' ? 0 : st.winner === 'b' ? 1 : null,
      reason: REASONS[st.kind] || 'Fin de partie'
    };
  }
}

function move(room, seat, data) {
  if (room.status !== 'playing') return { error: 'Partie terminée' };
  const pos = room.state.pos;
  if (seat !== seatOfTurn(pos)) return { error: "Ce n'est pas ton tour" };
  if (!data || typeof data.from !== 'string' || typeof data.to !== 'string') return { error: 'Coup invalide' };
  const m = pos.findMove(data.from, data.to, data.promo);
  if (!m) return { error: 'Coup illégal' };
  apply(room, m);
  return { ok: true };
}

/* ---------- Robot ---------- */

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000, INF = 1e9;

// Évaluation du point de vue du camp au trait : matériel + petits bonus de placement
function evaluate(pos) {
  let sc = 0;
  const b = pos.board;
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p) continue;
    const white = p < 'a', t = p.toLowerCase();
    const r = i >> 3, c = i & 7;
    const cen = 3.5 - Math.max(Math.abs(c - 3.5), Math.abs(r - 3.5));   // 0 (bord) à 3 (centre)
    let v = VAL[t];
    if (t === 'n' || t === 'b') v += cen * 8;
    else if (t === 'q') v += cen * 2;
    else if (t === 'p') v += (white ? 6 - r : r - 1) * 6 + (c === 3 || c === 4 ? cen * 3 : 0);
    sc += white ? v : -v;
  }
  return pos.turn === 'w' ? sc : -sc;
}

// Prises les plus rentables d'abord (victime la plus chère, attaquant le moins cher)
function order(moves) {
  for (const m of moves) {
    m.o = (m.c ? VAL[m.c.toLowerCase()] * 10 - VAL[m.p.toLowerCase()] : 0) + (m.pr ? VAL[m.pr] : 0);
  }
  return moves.sort((a, b) => b.o - a.o);
}

function quiesce(pos, alpha, beta, ctx, qd) {
  if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) ctx.stop = true;
  if (ctx.stop) return 0;
  const stand = evaluate(pos);
  if (qd >= 6 || stand >= beta) return stand;
  if (stand > alpha) alpha = stand;
  const me = pos.turn, opp = me === 'w' ? 'b' : 'w';
  for (const m of order(pos.gen(true))) {
    pos.make(m);
    if (pos.isAttacked(pos.ksq[me], opp)) { pos.undo(); continue; }
    const sc = -quiesce(pos, -beta, -alpha, ctx, qd + 1);
    pos.undo();
    if (ctx.stop) return 0;
    if (sc >= beta) return sc;
    if (sc > alpha) alpha = sc;
  }
  return alpha;
}

function search(pos, depth, alpha, beta, ply, ctx) {
  if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) ctx.stop = true;
  if (ctx.stop) return 0;
  if (pos.half >= 100) return 0;
  if (depth <= 0) return quiesce(pos, alpha, beta, ctx, 0);
  const me = pos.turn, opp = me === 'w' ? 'b' : 'w';
  let legal = 0, best = -INF;
  for (const m of order(pos.gen(false))) {
    pos.make(m);
    if (pos.isAttacked(pos.ksq[me], opp)) { pos.undo(); continue; }
    legal++;
    const sc = -search(pos, depth - 1, -beta, -alpha, ply + 1, ctx);
    pos.undo();
    if (ctx.stop) return 0;
    if (sc > best) best = sc;
    if (sc > alpha) alpha = sc;
    if (alpha >= beta) break;
  }
  if (!legal) return pos.isAttacked(pos.ksq[me], opp) ? -MATE + ply : 0;
  return best;
}

// Approfondissement itératif avec limite de temps. Retourne le meilleur coup terminé.
function bestMove(pos, maxDepth, ms) {
  const ctx = { nodes: 0, stop: false, deadline: Date.now() + ms };
  let moves = order(pos.legalMoves());
  if (!moves.length) return null;
  let best = moves[0];
  for (let d = 1; d <= maxDepth; d++) {
    let alpha = -INF, bestD = null, bestSc = -INF;
    for (const m of moves) {
      pos.make(m);
      // éviter de provoquer une triple répétition quand on peut faire mieux
      const k = pos.key();
      let n = 0;
      for (const x of pos.keys) if (x === k) n++;
      const sc = n >= 2 ? 0 : -search(pos, d - 1, -INF, -alpha, 1, ctx);
      pos.undo();
      if (ctx.stop) break;
      if (sc > bestSc) { bestSc = sc; bestD = m; }
      if (sc > alpha) alpha = sc;
    }
    if (ctx.stop || !bestD) break;
    best = bestD;
    moves = [bestD].concat(moves.filter(m => m !== bestD));
    if (Math.abs(bestSc) > MATE - 100) break;    // mat forcé trouvé
  }
  return best;
}

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

function chooseMove(pos, level) {
  const legal = pos.legalMoves();
  if (!legal.length) return null;
  if (level === 'hard') return bestMove(pos, 5, 1000);
  if (level === 'normal') {
    if (Math.random() < 0.2) return pick(legal);          // 1 coup sur 5 est une erreur
    return bestMove(pos, 2, 400);
  }
  const caps = legal.filter(m => m.c);                    // facile : prend si possible, sinon au hasard
  return caps.length && Math.random() < 0.45 ? pick(caps) : pick(legal);
}

function bot(room) {
  const pos = room.state.pos;
  if (room.status !== 'playing' || pos.turn !== 'b') return false;
  const m = chooseMove(pos, room.level);
  if (!m) return false;
  apply(room, m);
  return true;
}

function timeLimit(room) {
  if (room.status !== 'playing') return 0;
  const seat = seatOfTurn(room.state.pos);
  if (room.seats[seat].bot) return 0;
  return cfg.TURN_SECONDS.chess * 1000;
}

// Temps écoulé : le joueur au trait perd
function timeout(room) {
  if (room.status !== 'playing') return;
  room.result = { winner: 1 - seatOfTurn(room.state.pos), reason: 'Temps écoulé' };
}

module.exports = { name: 'chess', create, view, move, bot, timeLimit, timeout, chooseMove };
