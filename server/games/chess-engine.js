'use strict';
// Moteur de règles d'échecs, sans dépendance.
// Gère : coups légaux, roque, prise en passant, promotion, échec et mat, pat,
// matériel insuffisant, règle des 50 coups, triple répétition.
// Vérifié par les tests "perft" officiels (voir test/logic.test.js).
// Cases : 0 = a8 ... 63 = h1 (même ordre que le FEN).
const FILES = 'abcdefgh';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const WK = 1, WQ = 2, BK = 4, BQ = 8;

function sqName(i) { return FILES[i & 7] + (8 - (i >> 3)); }
function sqIndex(n) {
  if (typeof n !== 'string' || n.length !== 2) return -1;
  const f = FILES.indexOf(n[0]), r = parseInt(n[1], 10);
  if (f < 0 || !(r >= 1 && r <= 8)) return -1;
  return (8 - r) * 8 + f;
}
const isWhitePiece = p => p !== '' && p < 'a';

// Tables précalculées
const KNIGHT = [], KING = [], RAYS = [];
const DIRS = [[-1,0],[1,0],[0,1],[0,-1],[-1,1],[-1,-1],[1,1],[1,-1]]; // 0-3 droites, 4-7 diagonales
for (let s = 0; s < 64; s++) {
  const r = s >> 3, c = s & 7;
  KNIGHT[s] = []; KING[s] = []; RAYS[s] = [];
  for (const d of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const rr = r + d[0], cc = c + d[1];
    if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) KNIGHT[s].push(rr * 8 + cc);
  }
  DIRS.forEach((d, i) => {
    const ray = [];
    let rr = r + d[0], cc = c + d[1];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) { ray.push(rr * 8 + cc); rr += d[0]; cc += d[1]; }
    RAYS[s][i] = ray;
    if (ray.length) KING[s].push(ray[0]);
  });
}
const MASK = new Array(64).fill(0);
MASK[56] = WQ; MASK[60] = WK | WQ; MASK[63] = WK;
MASK[0] = BQ;  MASK[4] = BK | BQ;  MASK[7] = BK;

class Position {
  constructor(fen) {
    this.stack = [];
    this.load(fen || START_FEN);
  }

  load(fen) {
    const parts = fen.trim().split(/\s+/);
    this.board = new Array(64).fill('');
    let i = 0;
    for (const ch of parts[0]) {
      if (ch === '/') continue;
      if (ch >= '1' && ch <= '8') i += parseInt(ch, 10);
      else this.board[i++] = ch;
    }
    this.turn = parts[1] === 'b' ? 'b' : 'w';
    const cs = parts[2] || '-';
    this.castle = (cs.includes('K') ? WK : 0) | (cs.includes('Q') ? WQ : 0) |
                  (cs.includes('k') ? BK : 0) | (cs.includes('q') ? BQ : 0);
    this.ep = parts[3] && parts[3] !== '-' ? sqIndex(parts[3]) : -1;
    this.half = parseInt(parts[4], 10) || 0;
    this.full = parseInt(parts[5], 10) || 1;
    this.ksq = { w: this.board.indexOf('K'), b: this.board.indexOf('k') };
    this.stack = [];
    this.keys = [this.key()];
  }

  fen() {
    let s = '';
    for (let r = 0; r < 8; r++) {
      let e = 0;
      for (let c = 0; c < 8; c++) {
        const p = this.board[r * 8 + c];
        if (!p) e++; else { if (e) { s += e; e = 0; } s += p; }
      }
      if (e) s += e;
      if (r < 7) s += '/';
    }
    const cs = (this.castle & WK ? 'K' : '') + (this.castle & WQ ? 'Q' : '') +
               (this.castle & BK ? 'k' : '') + (this.castle & BQ ? 'q' : '') || '-';
    return s + ' ' + this.turn + ' ' + cs + ' ' + (this.ep >= 0 ? sqName(this.ep) : '-') + ' ' + this.half + ' ' + this.full;
  }

  key() {
    return this.board.map(p => p || '.').join('') + this.turn + this.castle + this.ep;
  }

  isAttacked(sq, by) {
    const b = this.board, r = sq >> 3, c = sq & 7;
    if (by === 'w') {
      if (r < 7) { if (c > 0 && b[sq + 7] === 'P') return true; if (c < 7 && b[sq + 9] === 'P') return true; }
    } else {
      if (r > 0) { if (c > 0 && b[sq - 9] === 'p') return true; if (c < 7 && b[sq - 7] === 'p') return true; }
    }
    const N = by === 'w' ? 'N' : 'n', K = by === 'w' ? 'K' : 'k';
    const R = by === 'w' ? 'R' : 'r', B = by === 'w' ? 'B' : 'b', Q = by === 'w' ? 'Q' : 'q';
    for (const t of KNIGHT[sq]) if (b[t] === N) return true;
    for (const t of KING[sq]) if (b[t] === K) return true;
    for (let d = 0; d < 8; d++) {
      const ray = RAYS[sq][d];
      for (let i = 0; i < ray.length; i++) {
        const p = b[ray[i]];
        if (!p) continue;
        if (p === Q || (d < 4 ? p === R : p === B)) return true;
        break;
      }
    }
    return false;
  }

  inCheck() { return this.isAttacked(this.ksq[this.turn], this.turn === 'w' ? 'b' : 'w'); }

  // Coups pseudo-légaux (le roi peut rester en échec). captureOnly = prises et promotions seulement.
  gen(captureOnly) {
    const b = this.board, white = this.turn === 'w', out = [];
    const add = (f, t, p, c, pr, fl) => out.push({ f, t, p, c, pr, fl });
    const addPawn = (f, t, p, c, fl, lastRow) => {
      if ((t >> 3) === lastRow) { add(f, t, p, c, 'q', ''); add(f, t, p, c, 'r', ''); add(f, t, p, c, 'b', ''); add(f, t, p, c, 'n', ''); }
      else add(f, t, p, c, '', fl);
    };
    for (let f = 0; f < 64; f++) {
      const p = b[f];
      if (!p || white !== (p < 'a')) continue;
      const pl = p.toLowerCase();
      if (pl === 'p') {
        const dir = white ? -8 : 8, startRow = white ? 6 : 1, lastRow = white ? 0 : 7;
        const r = f >> 3, c = f & 7, t1 = f + dir;
        if (!b[t1]) {
          if ((t1 >> 3) === lastRow) addPawn(f, t1, p, '', '', lastRow);
          else if (!captureOnly) {
            add(f, t1, p, '', '', '');
            if (r === startRow && !b[t1 + dir]) add(f, t1 + dir, p, '', '', 'dp');
          }
        }
        for (const dc of [-1, 1]) {
          const cc = c + dc;
          if (cc < 0 || cc > 7) continue;
          const t = t1 + dc, q = b[t];
          if (q && (q < 'a') !== white) addPawn(f, t, p, q, '', lastRow);
          else if (!q && t === this.ep) add(f, t, p, white ? 'p' : 'P', '', 'ep');
        }
      } else if (pl === 'n' || pl === 'k') {
        const targets = pl === 'n' ? KNIGHT[f] : KING[f];
        for (const t of targets) {
          const q = b[t];
          if (!q) { if (!captureOnly) add(f, t, p, '', '', ''); }
          else if ((q < 'a') !== white) add(f, t, p, q, '', '');
        }
        if (pl === 'k' && !captureOnly && f === (white ? 60 : 4)) {
          const opp = white ? 'b' : 'w', rook = white ? 'R' : 'r';
          if ((this.castle & (white ? WK : BK)) && b[f + 3] === rook && !b[f + 1] && !b[f + 2] &&
              !this.isAttacked(f, opp) && !this.isAttacked(f + 1, opp)) add(f, f + 2, p, '', '', 'k');
          if ((this.castle & (white ? WQ : BQ)) && b[f - 4] === rook && !b[f - 1] && !b[f - 2] && !b[f - 3] &&
              !this.isAttacked(f, opp) && !this.isAttacked(f - 1, opp)) add(f, f - 2, p, '', '', 'q');
        }
      } else {
        const d0 = pl === 'b' ? 4 : 0, d1 = pl === 'r' ? 4 : 8;
        for (let d = d0; d < d1; d++) {
          const ray = RAYS[f][d];
          for (let i = 0; i < ray.length; i++) {
            const t = ray[i], q = b[t];
            if (!q) { if (!captureOnly) add(f, t, p, '', '', ''); continue; }
            if ((q < 'a') !== white) add(f, t, p, q, '', '');
            break;
          }
        }
      }
    }
    return out;
  }

  make(m) {
    const b = this.board, white = this.turn === 'w';
    this.stack.push({ m, castle: this.castle, ep: this.ep, half: this.half });
    b[m.f] = '';
    b[m.t] = m.pr ? (white ? m.pr.toUpperCase() : m.pr) : m.p;
    if (m.fl === 'ep') b[white ? m.t + 8 : m.t - 8] = '';
    else if (m.fl === 'k') { b[m.f + 1] = b[m.f + 3]; b[m.f + 3] = ''; }
    else if (m.fl === 'q') { b[m.f - 1] = b[m.f - 4]; b[m.f - 4] = ''; }
    if (m.p === 'K') this.ksq.w = m.t; else if (m.p === 'k') this.ksq.b = m.t;
    this.castle &= ~(MASK[m.f] | MASK[m.t]);
    this.ep = m.fl === 'dp' ? (m.f + m.t) >> 1 : -1;
    this.half = (m.p === 'P' || m.p === 'p' || m.c) ? 0 : this.half + 1;
    if (!white) this.full++;
    this.turn = white ? 'b' : 'w';
  }

  undo() {
    const u = this.stack.pop(), m = u.m, b = this.board;
    this.turn = this.turn === 'w' ? 'b' : 'w';
    const white = this.turn === 'w';
    if (!white) this.full--;
    b[m.f] = m.p;
    if (m.fl === 'ep') { b[m.t] = ''; b[white ? m.t + 8 : m.t - 8] = m.c; }
    else b[m.t] = m.c;
    if (m.fl === 'k') { b[m.f + 3] = b[m.f + 1]; b[m.f + 1] = ''; }
    else if (m.fl === 'q') { b[m.f - 4] = b[m.f - 1]; b[m.f - 1] = ''; }
    if (m.p === 'K') this.ksq.w = m.f; else if (m.p === 'k') this.ksq.b = m.f;
    this.castle = u.castle; this.ep = u.ep; this.half = u.half;
  }

  legalMoves() {
    const me = this.turn, opp = me === 'w' ? 'b' : 'w', out = [];
    for (const m of this.gen(false)) {
      this.make(m);
      if (!this.isAttacked(this.ksq[me], opp)) out.push(m);
      this.undo();
    }
    return out;
  }

  // Trouve le coup légal correspondant (promotion par défaut en dame)
  findMove(from, to, promo) {
    const f = sqIndex(from), t = sqIndex(to);
    if (f < 0 || t < 0) return null;
    const c = this.legalMoves().filter(m => m.f === f && m.t === t);
    if (!c.length) return null;
    if (c[0].pr) {
      const want = ['q', 'r', 'b', 'n'].indexOf(promo) >= 0 ? promo : 'q';
      return c.find(m => m.pr === want) || null;
    }
    return c[0];
  }

  // Joue un coup en gardant la trace des positions (répétitions)
  play(m) { this.make(m); this.keys.push(this.key()); }

  insufficient() {
    const rest = [];
    for (const p of this.board) if (p && p !== 'K' && p !== 'k') rest.push(p.toLowerCase());
    if (!rest.length) return true;
    return rest.length === 1 && (rest[0] === 'n' || rest[0] === 'b');
  }

  // { over, kind, winner: 'w' | 'b' | null }
  status() {
    if (!this.legalMoves().length) {
      return this.inCheck()
        ? { over: true, kind: 'checkmate', winner: this.turn === 'w' ? 'b' : 'w' }
        : { over: true, kind: 'stalemate', winner: null };
    }
    if (this.insufficient()) return { over: true, kind: 'insufficient', winner: null };
    if (this.half >= 100) return { over: true, kind: 'fifty', winner: null };
    const k = this.keys[this.keys.length - 1];
    let n = 0;
    for (const x of this.keys) if (x === k) n++;
    if (n >= 3) return { over: true, kind: 'repetition', winner: null };
    return { over: false };
  }

  perft(d) {
    if (d === 0) return 1;
    let n = 0;
    for (const m of this.legalMoves()) { this.make(m); n += this.perft(d - 1); this.undo(); }
    return n;
  }
}

module.exports = { Position, START_FEN, sqName, sqIndex, isWhitePiece };
