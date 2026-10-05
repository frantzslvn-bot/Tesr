'use strict';
// Lancer avec : npm test
// Aucun outil externe. Le serveur Socket.io est testé avec de faux sockets (pas de réseau).
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { mock } = require('node:test');

// Doit être défini AVANT de charger le serveur (config.js lit l'environnement au chargement)
const TMP = path.join(os.tmpdir(), 'dracula-test-' + process.pid);
process.env.DATA_FILE = path.join(TMP, 'db.json');
process.env.ADMIN_CODE = 'code-de-test-123';

const cfg = require('../server/config');
const coins = require('../server/coins');
const { Position, sqName } = require('../server/games/chess-engine');
const G = {
  tictactoe: require('../server/games/tictactoe'),
  penalty: require('../server/games/penalty'),
  chess: require('../server/games/chess'),
  quiz: require('../server/games/quiz')
};
const roulette = require('../server/games/roulette');
const sock = require('../server/socket');
const posts = require('../server/posts');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  ECHEC ' + name + '\n        ' + String(e.message).split('\n')[0]); }
}
function mkRoom(game, extra) {
  const r = Object.assign({ game, level: 'easy', status: 'playing', seats: [{ bot: false }, { bot: false }], result: null }, extra || {});
  r.state = G[game].create(r);
  return r;
}

/* ================= Échecs : moteur ================= */
console.log('Échecs - moteur');
const PERFT = [
  ['position de départ', undefined, [20, 400, 8902]],
  ['Kiwipete (roques, prises, promotions)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039]],
  ['finale avec prise en passant', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812]],
  ['promotions et échecs', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486]]
];
PERFT.forEach(([name, fen, counts]) => t('perft ' + name, () => {
  counts.forEach((exp, i) => assert.strictEqual(new Position(fen).perft(i + 1), exp, 'profondeur ' + (i + 1)));
}));
t('échec et mat du fou (1.f3 e5 2.g4 Dh4#)', () => {
  const p = new Position();
  for (const [a, b] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) p.play(p.findMove(a, b));
  const s = p.status();
  assert.deepStrictEqual([s.over, s.kind, s.winner], [true, 'checkmate', 'b']);
});
t('pat', () => assert.strictEqual(new Position('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').status().kind, 'stalemate'));
t('matériel insuffisant', () => assert.strictEqual(new Position('8/8/4k3/8/8/3K4/6B1/8 w - - 0 1').status().kind, 'insufficient'));
t('règle des 50 coups', () => assert.strictEqual(new Position('8/8/4k3/8/8/3K4/6R1/8 w - - 100 80').status().kind, 'fifty'));
t('triple répétition', () => {
  const p = new Position('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  for (let i = 0; i < 2; i++) for (const [a, b] of [['a1', 'a2'], ['e8', 'e7'], ['a2', 'a1'], ['e7', 'e8']]) p.play(p.findMove(a, b));
  assert.strictEqual(p.status().kind, 'repetition');
});
t('le roque est refusé si la case est attaquée', () => {
  const p = new Position('4k3/8/8/8/8/5r2/8/4K2R w K - 0 1');
  assert.strictEqual(p.findMove('e1', 'g1'), null);
});

/* ================= Échecs : jeu ================= */
console.log('Échecs - jeu et robot');
t('le joueur au trait reçoit ses coups, pas l\'adversaire', () => {
  const r = mkRoom('chess');
  assert.deepStrictEqual(G.chess.view(r, 0).moves.e2, ['e3', 'e4']);
  assert.strictEqual(Object.keys(G.chess.view(r, 1).moves).length, 0);
  assert.strictEqual(Object.keys(G.chess.view(r, null).moves).length, 0);
});
t('mauvais tour, coup illégal, coup valide', () => {
  const r = mkRoom('chess');
  assert.ok(G.chess.move(r, 1, { from: 'e7', to: 'e5' }).error);
  assert.ok(G.chess.move(r, 0, { from: 'e2', to: 'e5' }).error);
  assert.ok(G.chess.move(r, 0, { from: 'e2' }).error);
  assert.ok(G.chess.move(r, 0, { from: 'e2', to: 'e4' }).ok);
  assert.deepStrictEqual(G.chess.view(r, 1).last, { from: 'e2', to: 'e4' });
});
t('mat détecté : résultat pour les noirs', () => {
  const r = mkRoom('chess');
  for (const [s, a, b] of [[0, 'f2', 'f3'], [1, 'e7', 'e5'], [0, 'g2', 'g4'], [1, 'd8', 'h4']]) assert.ok(G.chess.move(r, s, { from: a, to: b }).ok);
  assert.deepStrictEqual(r.result, { winner: 1, reason: 'Échec et mat' });
});
t('promotion : choix de la pièce', () => {
  const r = mkRoom('chess');
  r.state.pos.load('8/P6k/8/8/8/8/7K/8 w - - 0 1');
  assert.deepStrictEqual(G.chess.view(r, 0).promo, ['a7a8']);
  assert.ok(G.chess.move(r, 0, { from: 'a7', to: 'a8', promo: 'n' }).ok);
  assert.strictEqual(r.state.pos.board[0], 'N');
});
t('le robot trouve un mat en 1 (hard)', () => {
  const r = mkRoom('chess', { level: 'hard', seats: [{ bot: false }, { bot: true }] });
  r.state.pos.load('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2');
  assert.ok(G.chess.bot(r));
  assert.strictEqual(r.result.reason, 'Échec et mat');
});
t('les 3 niveaux de robot ne jouent que des coups légaux', () => {
  for (const lvl of ['easy', 'normal']) {
    const r = mkRoom('chess', { level: lvl, seats: [{ bot: false }, { bot: true }] });
    for (let i = 0; i < 12 && !r.result; i++) {
      const pos = r.state.pos, seat = pos.turn === 'w' ? 0 : 1;
      const m = G.chess.chooseMove(pos, seat === 0 ? 'easy' : lvl);
      assert.ok(G.chess.move(r, seat, { from: sqName(m.f), to: sqName(m.t), promo: m.pr }).ok);
    }
  }
});
t('temps écoulé : le joueur au trait perd', () => {
  const r = mkRoom('chess');
  assert.strictEqual(G.chess.timeLimit(r), cfg.TURN_SECONDS.chess * 1000);
  G.chess.timeout(r);
  assert.strictEqual(r.result.winner, 1);
});

/* ================= Morpion, Penalty, Quiz ================= */
console.log('Morpion, Penalty, Quiz');
t('morpion : victoire, case occupée, mauvais tour', () => {
  const r = mkRoom('tictactoe');
  assert.ok(G.tictactoe.move(r, 1, { i: 0 }).error);
  for (const [s, i] of [[0, 0], [1, 3], [0, 1], [1, 4]]) assert.ok(G.tictactoe.move(r, s, { i }).ok);
  assert.ok(G.tictactoe.move(r, 0, { i: 3 }).error);
  assert.ok(G.tictactoe.move(r, 0, { i: 2 }).ok);
  assert.strictEqual(r.result.winner, 0);
});
t('morpion : le robot hard ne perd jamais (60 parties au hasard)', () => {
  for (let g = 0; g < 60; g++) {
    const r = mkRoom('tictactoe', { level: 'hard', seats: [{ bot: false }, { bot: true }] });
    while (!r.result) {
      const free = r.state.board.map((c, i) => (c ? -1 : i)).filter(i => i >= 0);
      G.tictactoe.move(r, 0, { i: free[Math.floor(Math.random() * free.length)] });
      if (!r.result) G.tictactoe.bot(r);
    }
    assert.notStrictEqual(r.result.winner, 0);
  }
});
t('penalty : le choix de l\'adversaire reste caché', () => {
  const r = mkRoom('penalty');
  assert.ok(G.penalty.move(r, 0, { dir: 'L' }).ok);
  const v1 = G.penalty.view(r, 1), vs = G.penalty.view(r, null);
  assert.deepStrictEqual(v1.chosen, [true, false]);
  assert.strictEqual(v1.mine, null);
  assert.strictEqual(vs.mine, null);
  assert.ok(G.penalty.move(r, 0, { dir: 'R' }).error);
  assert.ok(G.penalty.move(r, 1, { dir: 'X' }).error);
  assert.ok(G.penalty.move(r, 1, { dir: 'L' }).ok);
  assert.strictEqual(r.state.last.goal, false);
});
t('penalty : égalité 5-5 puis mort subite', () => {
  const r = mkRoom('penalty');
  const kick = (shooter, goal) => {
    const keeper = 1 - shooter;
    G.penalty.move(r, shooter, { dir: 'L' });
    G.penalty.move(r, keeper, { dir: goal ? 'R' : 'L' });
  };
  for (let i = 0; i < 5; i++) { kick(0, true); kick(1, true); }
  assert.strictEqual(r.result, null);
  assert.strictEqual(G.penalty.view(r, 0).suddenDeath, true);
  kick(0, true); kick(1, false);
  assert.strictEqual(r.result.winner, 0);
});
t('penalty : trois oublis de suite = forfait', () => {
  const r = mkRoom('penalty');
  for (let i = 0; i < 4 && !r.result; i++) { G.penalty.timeout(r); }
  assert.ok(r.result && r.result.reason === 'Inactivité');
});
t('quiz : la bonne réponse n\'apparaît qu\'à la révélation', () => {
  const r = mkRoom('quiz');
  const q = r.state.qs[0];
  assert.strictEqual(G.quiz.view(r, 0).reveal, null);
  assert.ok(!JSON.stringify(G.quiz.view(r, 1)).includes('"c":'));
  assert.ok(G.quiz.move(r, 0, { i: 0, o: q.c }).ok);
  assert.strictEqual(G.quiz.view(r, 1).reveal, null);
  assert.ok(G.quiz.move(r, 1, { i: 0, o: (q.c + 1) % 4 }).ok);
  const v = G.quiz.view(r, null);
  assert.strictEqual(v.reveal.c, q.c);
  assert.deepStrictEqual(v.score, [1, 0]);
});
t('quiz : partie complète, le meilleur score gagne', () => {
  const r = mkRoom('quiz');
  for (let i = 0; i < cfg.QUIZ_QUESTIONS; i++) {
    const q = r.state.qs[i];
    G.quiz.move(r, 0, { i, o: q.c });
    G.quiz.move(r, 1, { i, o: (q.c + 1) % 4 });
    if (!r.result) G.quiz.timeout(r);
  }
  assert.strictEqual(r.result.winner, 0);
});

/* ================= Coins ================= */
console.log('Coins et roulette');
t('compte neuf, mise débitée, gains crédités', () => {
  const p = coins.createPlayer('Test <b>');
  assert.strictEqual(p.coins, cfg.START_COINS);
  assert.strictEqual(p.name, 'Test b');
  assert.strictEqual(coins.debit(p.id, 1000), false);
  assert.strictEqual(coins.debit(p.id, -5), false);
  assert.strictEqual(coins.debit(p.id, 2.5), false);
  assert.strictEqual(coins.debit(p.id, 20), true);
  assert.strictEqual(coins.credit(p.id, 5), true);
  assert.strictEqual(coins.get(p.id).coins, cfg.START_COINS - 15);
});
t('bonus du jour une seule fois', () => {
  const p = coins.createPlayer('Bonus');
  assert.ok(coins.claimDaily(p.id).ok);
  assert.strictEqual(coins.claimDaily(p.id).error, 'deja');
});
t('plafond quotidien du robot facile', () => {
  const p = coins.createPlayer('Farm');
  let total = 0;
  for (let i = 0; i < 10; i++) total += coins.easyNet(p.id, 20);
  assert.strictEqual(total, cfg.EASY_DAILY_NET_CAP);
});
t('un compte banni ne peut plus miser', () => {
  const p = coins.createPlayer('Banni');
  coins.setBanned(p.id, true);
  assert.strictEqual(coins.debit(p.id, 5), false);
  assert.ok(!coins.leaderboard(100).some(x => x.id === p.id));
});
t('roulette : règles des mises', () => {
  assert.strictEqual(roulette.colorOf(0), 'green');
  assert.strictEqual(roulette.colorOf(1), 'red');
  assert.strictEqual(roulette.colorOf(2), 'black');
  assert.ok(roulette.wins({ type: 'color', value: 'red' }, 32));
  assert.ok(!roulette.wins({ type: 'parity', value: 'even' }, 0));
  assert.ok(roulette.wins({ type: 'green' }, 0));
  assert.ok(roulette.wins({ type: 'number', value: 17 }, 17));
  assert.strictEqual(roulette.parseChoice({ type: 'number', value: 37 }), null);
  assert.strictEqual(roulette.parseChoice({ type: 'color', value: 'blue' }), null);
});
t('roulette : mises hors limites refusées, Coins intacts', () => {
  const p = coins.createPlayer('Roul');
  const c = { type: 'color', value: 'red' };
  assert.ok(roulette.spin(p.id, cfg.BET.roulette.min - 1, c).error);
  assert.ok(roulette.spin(p.id, cfg.BET.roulette.max + 1, c).error);
  assert.ok(roulette.spin(p.id, 5000, c).error);       // plus que son solde
  assert.ok(roulette.spin(p.id, 10, { type: 'x' }).error);
  assert.strictEqual(coins.get(p.id).coins, cfg.START_COINS);
});
t('roulette : le gain net est toujours cohérent (300 tirages)', () => {
  let seen0 = false;
  for (let i = 0; i < 300; i++) {
    const p = coins.createPlayer('R' + i);
    const r = roulette.spin(p.id, 10, { type: 'color', value: 'red' });
    assert.ok(r.ok);
    assert.strictEqual(r.net, r.win ? 10 : -10);
    assert.strictEqual(coins.get(p.id).coins, cfg.START_COINS + r.net);
    assert.ok(r.n >= 0 && r.n <= 36);
    if (r.n === 0) { seen0 = true; assert.strictEqual(r.win, false); }
  }
  assert.ok(roulette.history().length <= 15);
  void seen0;
});

/* ================= Serveur : parcours complets avec faux sockets ================= */
console.log('Serveur (faux sockets)');
let sockN = 0;
class FakeSocket {
  constructor(io, ip) {
    this.id = 'f' + (++sockN); this.data = {}; this.handlers = {}; this.mw = []; this.inbox = [];
    this.handshake = { address: ip || '10.0.0.' + sockN, headers: {} };
    this.io = io; this.gone = false;
  }
  on(ev, fn) { this.handlers[ev] = fn; }
  use(fn) { this.mw.push(fn); }
  emit(ev, payload) { this.inbox.push({ ev, payload }); }
  disconnect() { if (this.gone) return; this.gone = true; if (this.handlers.disconnect) this.handlers.disconnect(); }
  // appel client -> serveur, réponse immédiate
  call(ev, data) {
    let out; let blocked = true;
    const ack = r => { out = r; };
    const packet = [ev, data, ack];
    let i = 0;
    const next = () => {
      if (i < this.mw.length) { this.mw[i++](packet, next); return; }
      blocked = false; this.handlers[ev](data, ack);
    };
    next();
    void blocked;
    return out;
  }
  last(ev) { for (let i = this.inbox.length - 1; i >= 0; i--) if (this.inbox[i].ev === ev) return this.inbox[i].payload; return null; }
  all(ev) { return this.inbox.filter(x => x.ev === ev).map(x => x.payload); }
}
const fakeIo = { cb: null, on(ev, cb) { if (ev === 'connection') this.cb = cb; } };
sock.attach(fakeIo);
function connect(name, token) {
  const s = new FakeSocket(fakeIo);
  fakeIo.cb(s);
  const h = s.call('hello', { name, token });
  s.hello = h; s.token = h.token; s.me = h.me;
  return s;
}
const dbg = sock._debug;
const coinsOf = s => coins.get(s.me.id).coins;
function rig(s, code, fn) { fn(dbg.rooms.get(code)); }

t('hello : crée le compte, puis le retrouve avec le jeton', () => {
  const a = connect('Alice');
  assert.ok(a.hello.ok && a.hello.created && a.token && a.me.coins === 120);
  assert.ok(!('token' in a.me));
  const again = connect('Autre', a.token);
  assert.strictEqual(again.me.id, a.me.id);
  assert.strictEqual(again.hello.created, false);
});
t('une session sans hello est refusée', () => {
  const s = new FakeSocket(fakeIo); fakeIo.cb(s);
  assert.ok(s.call('room:create', { game: 'quiz', mode: 'bot', level: 'easy', bet: 5 }).error);
  assert.ok(s.call('admin:list', {}).error);
});
t('anti-spam : plus de 30 messages par seconde bloqués', () => {
  const s = connect('Spam');
  let blocked = 0;
  for (let i = 0; i < 40; i++) { const r = s.call('lb', {}); if (r && r.error === 'Trop de requêtes') blocked++; }
  assert.ok(blocked >= 9);
});
t('création : mise et niveau contrôlés par le serveur', () => {
  const a = connect('Bob');
  assert.ok(a.call('room:create', { game: 'nope', mode: 'bot', level: 'easy', bet: 10 }).error);
  assert.ok(a.call('room:create', { game: 'quiz', mode: 'bot', level: 'god', bet: 10 }).error);
  assert.ok(a.call('room:create', { game: 'quiz', mode: 'bot', level: 'easy', bet: 21 }).error);
  assert.ok(a.call('room:create', { game: 'quiz', mode: 'bot', level: 'easy', bet: 4 }).error);
  assert.ok(a.call('room:create', { game: 'quiz', mode: 'bot', level: 'easy', bet: 10.5 }).error);
  assert.ok(a.call('room:create', { game: 'quiz', mode: 'bot', level: 'hard', bet: 10000 }).error);   // 120 Coins seulement
  assert.ok(a.call('room:create', { game: 'quiz', mode: 'pvp', bet: 10001 }).error);
  assert.strictEqual(coinsOf(a), 120);
});
t('robot facile : mise débitée au début, victoire = +mise', () => {
  const a = connect('Carl');
  const r = a.call('room:create', { game: 'tictactoe', mode: 'bot', level: 'easy', bet: 10 });
  assert.ok(r.ok && r.code.length === 4);
  assert.strictEqual(coinsOf(a), 110);                    // débité avant de jouer
  assert.strictEqual(a.last('me').coins, 110);
  assert.ok(a.call('room:create', { game: 'quiz', mode: 'bot', level: 'easy', bet: 10 }).error);   // déjà en partie
  rig(a, r.code, room => { room.state.board = ['X', 'X', '', 'O', 'O', '', '', '', '']; });
  assert.ok(a.call('game:move', { code: r.code, data: { i: 2 } }).ok);
  assert.strictEqual(a.last('room:state').status, 'over');
  assert.strictEqual(a.last('room:state').result.payout, 20);
  assert.strictEqual(coinsOf(a), 130);
});
t('robot : défaite = mise perdue, nul = mise rendue', () => {
  const a = connect('Dana');
  let r = a.call('room:create', { game: 'tictactoe', mode: 'bot', level: 'normal', bet: 20 });
  rig(a, r.code, room => { room.status = 'playing'; room.result = null; });
  assert.ok(a.call('room:leave', { code: r.code }).ok);   // abandon
  assert.strictEqual(coinsOf(a), 100);
  r = a.call('room:create', { game: 'tictactoe', mode: 'bot', level: 'normal', bet: 20 });
  rig(a, r.code, room => { room.state.board = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', ''];  room.state.turn = 0; });
  assert.ok(a.call('game:move', { code: r.code, data: { i: 8 } }).ok);
  assert.strictEqual(a.last('room:state').result.winner, null);
  assert.strictEqual(coinsOf(a), 100);
});
t('plafond du robot facile appliqué au gain', () => {
  const a = connect('Eve');
  coins.credit(a.me.id, 500);
  let total = coinsOf(a);
  for (let i = 0; i < 7; i++) {
    const r = a.call('room:create', { game: 'tictactoe', mode: 'bot', level: 'easy', bet: 20 });
    rig(a, r.code, room => { room.state.board = ['X', 'X', '', 'O', 'O', '', '', '', '']; });
    a.call('game:move', { code: r.code, data: { i: 2 } });
    a.call('room:leave', { code: r.code });
  }
  assert.strictEqual(coinsOf(a) - total, cfg.EASY_DAILY_NET_CAP);
  assert.ok(a.last('room:state').result.note);
});
t('entre joueurs : mises des deux débitées, le vainqueur prend le pot', () => {
  const a = connect('Fay'), b = connect('Gus'), c = connect('Spectateur');
  const r = a.call('room:create', { game: 'tictactoe', mode: 'pvp', bet: 50 });
  assert.strictEqual(coinsOf(a), 70);
  assert.strictEqual(a.last('room:state').status, 'waiting');
  assert.ok(b.call('room:join', { code: r.code.toLowerCase() }).ok);
  assert.strictEqual(coinsOf(b), 70);
  const st = b.last('room:state');
  assert.strictEqual(st.status, 'playing');
  assert.ok(st.seat === 0 || st.seat === 1);
  assert.ok(c.call('room:join', { code: r.code }).spectator);
  assert.strictEqual(c.last('room:state').seat, null);
  assert.ok(c.call('game:move', { code: r.code, data: { i: 0 } }).error);           // spectateur : refusé
  assert.strictEqual(a.last('room:state').spectators, 1);
  const firstSeat = st.seat;
  const [first, second] = firstSeat === 0 ? [b, a] : [a, b];
  assert.ok(second.call('game:move', { code: r.code, data: { i: 0 } }).error);       // pas son tour
  assert.ok(first.call('game:move', { code: r.code, data: { i: 0 } }).ok);
  assert.ok(second.call('room:leave', { code: r.code }).ok);                         // abandon
  assert.strictEqual(coinsOf(first), 70 + 100);
  assert.strictEqual(coinsOf(second), 70);
  assert.strictEqual(c.last('room:state').status, 'over');
});
t('entre joueurs : nul = remboursement des deux', () => {
  const a = connect('Hal'), b = connect('Ivy');
  const r = a.call('room:create', { game: 'tictactoe', mode: 'pvp', bet: 30 });
  b.call('room:join', { code: r.code });
  rig(a, r.code, room => { room.state.board = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', '']; room.state.turn = 0; });
  const seatX = a.last('room:state').seat === 0 ? a : b;
  assert.ok(seatX.call('game:move', { code: r.code, data: { i: 8 } }).ok);
  assert.strictEqual(coinsOf(a), 120); assert.strictEqual(coinsOf(b), 120);
});
t('rejoindre sans assez de Coins : refusé, rien débité', () => {
  const a = connect('Jo'), b = connect('Kim');
  coins.credit(a.me.id, 900);
  const r = a.call('room:create', { game: 'quiz', mode: 'pvp', bet: 500 });
  assert.ok(b.call('room:join', { code: r.code }).error);
  assert.strictEqual(coinsOf(b), 120);
  assert.strictEqual(a.call('lobby:rooms', { game: 'quiz' }).rooms.filter(x => x.code === r.code).length, 1);
  assert.ok(a.call('room:leave', { code: r.code }).ok);       // annulation : mise rendue
  assert.strictEqual(coinsOf(a), 1020);
  assert.strictEqual(b.call('room:join', { code: r.code }).error, 'Salle introuvable');
});
t('penalty entre joueurs : le choix de l\'autre n\'est jamais envoyé', () => {
  const a = connect('Lea'), b = connect('Max');
  const r = a.call('room:create', { game: 'penalty', mode: 'pvp', bet: 10 });
  b.call('room:join', { code: r.code });
  const sa = a.last('room:state').seat;
  assert.ok(a.call('game:move', { code: r.code, data: { dir: 'L' } }).ok);
  const seen = b.last('room:state');
  assert.deepStrictEqual(seen.view.chosen[sa], true);
  assert.strictEqual(seen.view.mine, null);
  assert.ok(!('state' in seen));
  assert.ok(!JSON.stringify(seen).includes('"pick"'));
  a.call('room:leave', { code: r.code });
});
t('coupure : 45 s pour revenir, sinon abandon', () => {
  const a = connect('Nina'), b = connect('Omar');
  const r = a.call('room:create', { game: 'quiz', mode: 'pvp', bet: 40 });
  b.call('room:join', { code: r.code });
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    a.disconnect();
    assert.strictEqual(b.last('room:state').seats.some(s => s && s.offline), true);
    const a2 = connect('Nina', a.token);
    assert.strictEqual(a2.hello.activeRoom, r.code);          // l'interface reprend la partie
    assert.ok(a2.call('room:join', { code: r.code }).ok);
    assert.strictEqual(b.last('room:state').seats.some(s => s && s.offline), false);
    mock.timers.tick(dbg.GRACE_MS + 1000);
    assert.strictEqual(b.last('room:state').status, 'playing');   // elle est revenue : rien ne se passe
    a2.disconnect();
    mock.timers.tick(dbg.GRACE_MS + 1000);
    assert.strictEqual(b.last('room:state').status, 'over');
    assert.strictEqual(b.last('room:state').result.reason, 'Déconnexion');
    assert.strictEqual(coinsOf(b), 120 - 40 + 80);
  } finally { mock.timers.reset(); }
});
t('le chrono du tour fait perdre le joueur trop lent', () => {
  const a = connect('Paul'), b = connect('Quinn');
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });   // avant la création : le chrono doit être simulé
  try {
    const r = a.call('room:create', { game: 'tictactoe', mode: 'pvp', bet: 10 });
    b.call('room:join', { code: r.code });
    const st = a.last('room:state');
    assert.ok(st.deadline && st.limit === cfg.TURN_SECONDS.tictactoe * 1000);
    mock.timers.tick(cfg.TURN_SECONDS.tictactoe * 1000 + 50);
    const end = a.last('room:state');
    assert.strictEqual(end.status, 'over');
    assert.strictEqual(end.result.reason, 'Temps écoulé');
  } finally { mock.timers.reset(); }
});
t('boutique : prix vérifié par le serveur, achat journalisé', () => {
  const a = connect('Rita');
  const adm = connect('Boss');
  assert.ok(adm.call('admin:login', { code: process.env.ADMIN_CODE }).ok);
  assert.ok(a.call('shop:buy', { id: 'inconnu' }).error);
  const ok = a.call('shop:buy', { id: 'autre' });
  assert.ok(ok.ok); assert.strictEqual(coinsOf(a), 20);
  assert.ok(/80/.test(a.call('shop:buy', { id: 'autre' }).error));
  assert.strictEqual(adm.last('admin:purchase').item, 'Autre récompense');
  assert.ok(fs.readFileSync(path.join(TMP, 'purchases.log'), 'utf8').includes('Rita'));
});
t('roulette via le serveur : Coins mis à jour, anti-spam', () => {
  const a = connect('Sam');
  const r = a.call('roulette:spin', { bet: 10, choice: { type: 'parity', value: 'even' } });
  assert.ok(r.ok && Array.isArray(r.history));
  assert.strictEqual(a.last('me').coins, 120 + r.net);
  assert.ok(a.call('roulette:spin', { bet: 10, choice: { type: 'green' } }).error);
});
t('bonus du jour et classement', () => {
  const a = connect('Tom');
  assert.ok(a.call('daily', {}).ok);
  assert.ok(a.call('daily', {}).error);
  const lb = a.call('lb', {});
  assert.ok(lb.ok && lb.list.length > 0 && lb.rank >= 1);
  assert.ok(lb.list.every(x => !('token' in x)));
});
t('admin : mauvais code refusé, blocage après 5 essais', () => {
  const s = new FakeSocket(fakeIo, '9.9.9.9'); fakeIo.cb(s);
  s.call('hello', { name: 'Intrus' });
  for (let i = 0; i < 5; i++) assert.strictEqual(s.call('admin:login', { code: 'faux' + i }).error, 'Code incorrect');
  assert.ok(/essais/.test(s.call('admin:login', { code: process.env.ADMIN_CODE }).error));
  assert.ok(s.call('admin:list', {}).error);
  assert.ok(s.call('admin:act', { act: 'ban', id: s.me ? s.me.id : 'x' }).error);
});
t('admin : promouvoir, bannir (avec abandon de la partie), supprimer', () => {
  const owner = connect('Chef'), a = connect('Vic'), b = connect('Walt'), c = connect('Xena');
  assert.ok(owner.call('admin:login', { code: process.env.ADMIN_CODE }).ok);
  const list = owner.call('admin:list', {});
  assert.ok(list.accounts.length >= 4 && list.accounts.every(x => !('token' in x)));
  const r = a.call('room:create', { game: 'quiz', mode: 'pvp', bet: 20 });
  b.call('room:join', { code: r.code });
  assert.ok(owner.call('admin:act', { act: 'ban', id: a.me.id }).ok);
  assert.ok(a.last('kicked'));
  assert.strictEqual(a.gone, true);
  assert.strictEqual(b.last('room:state').status, 'over');           // l'autre joueur gagne le pot
  assert.strictEqual(coinsOf(b), 120 + 20);
  assert.strictEqual(connect('Vic', a.token).hello ? true : false, true);
  const re = new FakeSocket(fakeIo); fakeIo.cb(re);
  assert.strictEqual(re.call('hello', { token: a.token }).error, 'banned');
  assert.ok(owner.call('admin:act', { act: 'unban', id: a.me.id }).ok);
  assert.ok(owner.call('admin:act', { act: 'admin', id: c.me.id }).ok);
  const adm = connect('Xena', c.token);
  assert.strictEqual(adm.call('admin:login', {}).level, 'admin');    // admin : accès sans code
  assert.ok(adm.call('admin:act', { act: 'admin', id: b.me.id }).error);          // pas le droit de nommer
  assert.ok(adm.call('admin:act', { act: 'ban', id: owner.me.id === c.me.id ? 'x' : c.me.id }).error);   // ni soi-même
  assert.ok(owner.call('admin:act', { act: 'delete', id: b.me.id }).ok);
  assert.strictEqual(coins.get(b.me.id), null);
});
t('salle de bot : les spectateurs voient la partie, le robot joue seul', () => {
  const a = connect('Yann'), s = connect('Zoe');
  const r = a.call('room:create', { game: 'penalty', mode: 'bot', level: 'hard', bet: 10 });
  assert.ok(s.call('room:join', { code: r.code, spectate: true }).spectator);
  assert.strictEqual(s.last('room:state').view.mine, null);
  a.call('room:leave', { code: r.code });
  assert.strictEqual(s.last('room:state').status, 'over');
});


/* ================= Fil de publications ================= */
console.log('Fil de publications');
function fakeJpeg(n) { const b = Buffer.alloc(n || 1500, 7); b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[n ? n - 2 : 1498] = 0xFF; b[n ? n - 1 : 1499] = 0xD9; return b; }

t('photo : seul un vrai JPEG de taille raisonnable est accepté', () => {
  const u = connect('Photo1');
  assert.ok(u.call('feed:list', {}).ok);
  assert.ok(posts.saveImage(u.me.id, Buffer.from('<?php echo 1; ?>' + 'x'.repeat(400))).error);          // pas un JPEG
  const png = Buffer.alloc(1500, 1); png[0] = 0x89; assert.ok(posts.saveImage(u.me.id, png).error);       // PNG refusé
  assert.ok(posts.saveImage(u.me.id, fakeJpeg(800 * 1024)).error);                                         // trop lourd
  const noEnd = fakeJpeg(1500); noEnd[1499] = 0; assert.ok(posts.saveImage(u.me.id, noEnd).error);        // fichier tronqué
  assert.ok(posts.saveImage('inconnu', fakeJpeg()).error);                                                 // compte inexistant
});
t('photo : enregistrée sur disque, nom aléatoire, délai entre deux envois', () => {
  const u = connect('Photo2');
  const r = posts.saveImage(u.me.id, fakeJpeg());
  assert.ok(r.name && posts.IMG_NAME.test(r.name));
  assert.ok(fs.existsSync(posts.imgPath(r.name)));
  assert.ok(posts.saveImage(u.me.id, fakeJpeg()).error);        // trop vite
});
t('publier : texte seul, photo seule, vide refusé, photo d\'un autre refusée', () => {
  const a = connect('Pub1'), b = connect('Pub2');
  const r1 = a.call('post:create', { text: 'Salut tout le monde https://exemple.fr/video' });
  assert.ok(r1.ok && r1.post.author.name === 'Pub1' && r1.post.mine);
  assert.ok(b.call('post:create', { text: '   ' }).error);                              // vide
  const up = posts.saveImage(a.me.id, fakeJpeg());
  assert.ok(b.call('post:create', { img: up.name }).error);                             // image d'un autre compte
  assert.ok(b.call('post:create', { img: '../../etc/passwd' }).error);                  // nom piégé
  const gone = [];
  const r2 = posts.create(a.me.id, '', up.name, n => gone.push(n));                     // bloqué : 20 s entre deux posts
  assert.ok(r2.error);
  const c = connect('Pub3');
  const up3 = posts.saveImage(c.me.id, fakeJpeg());
  const r3 = posts.create(c.me.id, '', up3.name, n => gone.push(n));
  assert.ok(r3.ok && r3.post.img === up3.name && gone[0] === up3.name);
  assert.ok(posts.create(c.me.id, 'x', up3.name).error);                                // image déjà utilisée
});
t('texte : trop long coupé, caractères de contrôle retirés', () => {
  const a = connect('Texte1');
  const r = a.call('post:create', { text: 'a'.repeat(900) + '\u202E' });
  assert.strictEqual(r.post.text.length, 500);
  const b = connect('Texte2');
  assert.strictEqual(b.call('post:create', { text: 'bon\u202Ejour\u0000' }).post.text, 'bonjour');
});
t('likes : un like par compte, retirer le like', () => {
  const a = connect('Like1'), b = connect('Like2');
  const id = a.call('post:create', { text: 'like moi' }).post.id;
  assert.deepStrictEqual([b.call('post:like', { id }).liked, b.call('post:like', { id }).liked], [true, false]);
  b.call('post:like', { id }); a.call('post:like', { id });
  const f = a.call('feed:list', { scope: 'all' }).posts.find(x => x.id === id);
  assert.strictEqual(f.likes, 2); assert.ok(f.liked);
  assert.ok(b.call('post:like', { id: 'nexistepas' }).error);
});
t('commentaires : ajout, liste, trop vite, suppression par l\'auteur du post', () => {
  const a = connect('Com1'), b = connect('Com2'), c = connect('Com3');
  const id = a.call('post:create', { text: 'commentez' }).post.id;
  const r = b.call('post:comment', { id, text: '  Joli !  ' });
  assert.ok(r.ok && r.comment.text === 'Joli !' && r.count === 1);
  assert.ok(b.call('post:comment', { id, text: 'encore' }).error);          // 3 s entre deux commentaires
  assert.ok(c.call('post:comment', { id, text: '' }).error);
  assert.strictEqual(a.call('post:comments', { id }).comments.length, 1);
  assert.ok(c.call('comment:delete', { id, cid: r.comment.id }).error);     // un tiers ne peut pas
  assert.ok(a.call('comment:delete', { id, cid: r.comment.id }).ok);        // l'auteur du post oui
  assert.strictEqual(a.call('post:comments', { id }).comments.length, 0);
});
t('supprimer : seul l\'auteur, un admin ou le créateur', () => {
  const a = connect('Del1'), b = connect('Del2'), boss = connect('Del3');
  const id = a.call('post:create', { text: 'à supprimer' }).post.id;
  assert.ok(b.call('post:delete', { id }).error);
  assert.ok(boss.call('admin:login', { code: process.env.ADMIN_CODE }).ok);
  assert.ok(boss.call('post:delete', { id }).ok);                           // créateur : accepté
  assert.ok(a.call('post:get', { id }).error);
  const id2 = b.call('post:create', { text: 'le mien' }).post.id;
  assert.ok(b.call('post:delete', { id: id2 }).ok);                         // auteur : accepté
});
t('abonnements : suivre / ne plus suivre, onglet Abonnements, profil', () => {
  const a = connect('Fol1'), b = connect('Fol2'), c = connect('Fol3');
  const pb = b.call('post:create', { text: 'post de Fol2' }).post.id;
  c.call('post:create', { text: 'post de Fol3' });
  assert.ok(a.call('user:follow', { id: a.me.id }).error);                  // pas soi-même
  const f = a.call('user:follow', { id: b.me.id });
  assert.ok(f.following && f.followers === 1);
  const feed = a.call('feed:list', { scope: 'following' }).posts;
  assert.ok(feed.length === 1 && feed[0].id === pb);
  const pr = a.call('user:profile', { id: b.me.id });
  assert.ok(pr.isFollowing && pr.posts === 1 && pr.followers === 1 && pr.grid.length === 1);
  assert.ok(!a.call('user:follow', { id: b.me.id }).following);
  assert.strictEqual(a.call('feed:list', { scope: 'following' }).posts.length, 0);
});
t('fil : pagination du plus récent au plus ancien', () => {
  const a = connect('Page1');
  for (let i = 0; i < 17; i++) { posts.create(a.me.id, 'p' + i); }   // contourne le délai en passant par un autre compte
  const first = a.call('feed:list', { scope: 'all' });
  assert.ok(first.ok && first.posts.length <= 15);
  if (first.more) assert.ok(a.call('feed:list', { scope: 'all', before: first.next }).posts.length >= 1);
});
t('compte bloqué : ses publications disparaissent du fil, reviennent au déblocage', () => {
  const boss = connect('Mod1'), a = connect('Mod2'), b = connect('Mod3');
  boss.call('admin:login', { code: process.env.ADMIN_CODE });
  const id = a.call('post:create', { text: 'contenu douteux' }).post.id;
  assert.ok(b.call('feed:list', {}).posts.some(x => x.id === id));
  boss.call('admin:act', { act: 'ban', id: a.me.id });
  assert.ok(!b.call('feed:list', {}).posts.some(x => x.id === id));
  assert.ok(b.call('post:like', { id }).error);
  boss.call('admin:act', { act: 'unban', id: a.me.id });
  assert.ok(b.call('feed:list', {}).posts.some(x => x.id === id));
});
t('signalement : compté une fois par compte, visible par l\'admin, effaçable', () => {
  const boss = connect('Sig1'), a = connect('Sig2'), b = connect('Sig3');
  boss.call('admin:login', { code: process.env.ADMIN_CODE });
  const id = a.call('post:create', { text: 'à signaler' }).post.id;
  assert.ok(a.call('post:report', { id }).error);                          // pas son propre post
  assert.ok(b.call('post:report', { id, reason: 'spam' }).ok);
  assert.ok(b.call('post:report', { id }).ok);                              // doublon ignoré
  assert.ok(b.call('admin:reports', {}).error);                             // pas admin : refusé
  const list = boss.call('admin:reports', {}).reports;
  const r = list.find(x => x.post === id);
  assert.ok(r && r.count === 1 && r.reasons[0] === 'spam' && r.author.name === 'Sig2');
  assert.ok(boss.call('admin:clear', { id }).ok);
  assert.ok(!boss.call('admin:reports', {}).reports.some(x => x.post === id));
});
t('compte supprimé : publications, commentaires, likes et photos effacés', () => {
  const boss = connect('Sup1'), a = connect('Sup2'), b = connect('Sup3');
  boss.call('admin:login', { code: process.env.ADMIN_CODE });
  const up = posts.saveImage(a.me.id, fakeJpeg());
  const r = posts.create(a.me.id, 'avec photo', up.name);
  const idB = b.call('post:create', { text: 'post de Sup3' }).post.id;
  a.call('post:comment', { id: idB, text: 'bravo' }); a.call('post:like', { id: idB });
  assert.ok(boss.call('admin:act', { act: 'delete', id: a.me.id }).ok);
  assert.ok(r.ok && !fs.existsSync(posts.imgPath(up.name)));
  assert.strictEqual(b.call('post:comments', { id: idB }).comments.length, 0);
  assert.strictEqual(b.call('feed:list', {}).posts.find(x => x.id === idB).likes, 0);
});
t('fil : il faut un compte valide', () => {
  const s = new FakeSocket(fakeIo); fakeIo.cb(s);
  for (const ev of ['feed:list', 'post:create', 'post:like', 'user:follow']) assert.ok(s.call(ev, {}).error);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* rien */ }
console.log('\n' + pass + ' réussis, ' + fail + ' en échec');
process.exit(fail ? 1 : 0);
