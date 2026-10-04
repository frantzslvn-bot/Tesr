'use strict';
// Toute la logique en direct. Le client n'est jamais cru sur parole :
// comptes, mises, tours, résultats et gains sont décidés ici.
//
// Événements client -> serveur (toujours avec un accusé de réception) :
//   hello {token?, name?}            ouvre la session (crée le compte si besoin)
//   rename {name}   daily {}   lb {}   shop:buy {id}
//   lobby:rooms {game?}              parties en attente / en cours
//   room:create {game, mode:'bot'|'pvp', level?, bet}
//   room:join {code, spectate?}      rejoint (ou reprend) une salle
//   room:leave {code}                quitter : abandon = mise perdue
//   game:move {code, data}           un coup (le format dépend du jeu)
//   roulette:spin {bet, choice}   roulette:history {}
//   feed:list {scope:'all'|'following', before?}   post:create {text, img?}   post:get {id}
//   post:like {id}   post:comments {id}   post:comment {id, text}   post:delete {id}
//   comment:delete {id, cid}   post:report {id, reason?}   user:profile {id}   user:follow {id}
//   admin:login {code?}   admin:list {}   admin:act {act, id}   admin:reports {}   admin:clear {id}
// Serveur -> client : room:state, room:closed, me, kicked, admin:purchase
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const coins = require('./coins');
const roulette = require('./games/roulette');
const posts = require('./posts');
const backup = require('./backup');

const GAMES = {
  tictactoe: require('./games/tictactoe'),
  penalty: require('./games/penalty'),
  chess: require('./games/chess'),
  quiz: require('./games/quiz')
};
const LEVELS = ['easy', 'normal', 'hard'];
const LEVEL_NAME = { easy: 'Facile', normal: 'Normal', hard: 'Hard' };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sans O, 0, I, 1
const GRACE_MS = 45 * 1000;           // temps pour revenir après une coupure
const OVER_KEEP_MS = 10 * 60 * 1000;  // une partie finie reste consultable 10 min
const MAX_ACCOUNTS_PER_IP = cfg.MAX_ACCOUNTS_PER_IP || 10;   // par 24 h

const rooms = new Map();     // code -> salle
const roomOf = new Map();    // id joueur -> salle où il est assis (attente ou partie)
const byPlayer = new Map();  // id joueur -> Set de sockets
const purchases = [];        // derniers achats (aussi écrits dans purchases.log)
const accountsByIp = new Map();
const adminFails = new Map();

function reply(ack, obj) { if (typeof ack === 'function') ack(obj); }
function ipOf(socket) {
  const h = socket.handshake || {};
  const xf = h.headers && h.headers['x-forwarded-for'];
  // On prend la DERNIÈRE adresse : c'est celle ajoutée par le proxy (Render).
  // La première peut être inventée par le visiteur.
  if (xf) { const parts = String(xf).split(','); return parts[parts.length - 1].trim() || 'inconnu'; }
  return h.address || 'inconnu';
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
function seatOf(room, pid) {
  for (let i = 0; i < 2; i++) {
    const s = room.seats[i];
    if (s && !s.bot && s.id === pid) return i;
  }
  return null;
}
function pushCoins(pid) {
  const p = coins.get(pid), set = byPlayer.get(pid);
  if (!p || !set) return;
  for (const s of set) s.emit('me', coins.pub(p));
}

/* ---------- Salles ---------- */

function countSpectators(room) {
  const ids = new Set();
  for (const m of room.members.values()) if (seatOf(room, m.pid) === null) ids.add(m.pid);
  return ids.size;
}

function payload(room, seat) {
  let result = null;
  if (room.result) {
    result = {
      winner: room.result.winner,
      reason: room.result.reason,
      bet: seat !== null ? room.bet : null,
      payout: seat !== null && room.payout ? room.payout[seat] : null,
      note: room.note || null
    };
  }
  return {
    code: room.code, game: room.game, mode: room.mode, level: room.level, bet: room.bet,
    status: room.status,
    seats: room.seats.map(s => (s ? { id: s.id, name: s.name, bot: !!s.bot, offline: !!s.offline } : null)),
    seat,                                   // 0, 1 ou null (spectateur)
    spectators: countSpectators(room),
    view: room.status === 'waiting' ? null : GAMES[room.game].view(room, seat),
    result,
    deadline: room.deadline, limit: room.limit, now: Date.now(),
    pot: room.bet * 2
  };
}

function emitRoom(room) {
  for (const m of room.members.values()) {
    m.socket.emit('room:state', payload(room, seatOf(room, m.pid)));
  }
}

function attach(room, socket, pid) {
  room.members.set(socket.id, { socket, pid });
  socket.data.rooms.add(room.code);
  const seat = seatOf(room, pid);
  if (seat !== null) {
    room.seats[seat].offline = false;
    clearTimeout(room.grace[seat]); room.grace[seat] = null;
  }
}
function detach(room, socket) {
  room.members.delete(socket.id);
  socket.data.rooms.delete(room.code);
}
function detachPlayer(room, pid) {
  for (const m of Array.from(room.members.values())) if (m.pid === pid) detach(room, m.socket);
}

function clearTimers(room) {
  clearTimeout(room.timer); room.timer = null;
  clearTimeout(room.botTimer); room.botTimer = null;
  clearTimeout(room.grace[0]); clearTimeout(room.grace[1]);
  room.grace = [null, null];
}

function closeRoom(room, reason) {
  clearTimers(room);
  for (const m of room.members.values()) {
    m.socket.emit('room:closed', { code: room.code, reason });
    m.socket.data.rooms.delete(room.code);
  }
  room.members.clear();
  rooms.delete(room.code);
  for (const s of room.seats) if (s && !s.bot && roomOf.get(s.id) === room) roomOf.delete(s.id);
}

// Salle en attente annulée : la mise du créateur est rendue
function cancelWaiting(room, reason) {
  if (room.status !== 'waiting') return;
  const s = room.seats[0];
  if (s && !s.bot) { coins.credit(s.id, room.bet); pushCoins(s.id); }
  closeRoom(room, reason);
}

// Gains. Contre un robot : victoire = mise rendue + gain égal à la mise.
// Entre joueurs : le vainqueur prend les deux mises. Nul : tout le monde est remboursé.
function settle(room) {
  if (room.settled) return;
  room.settled = true;
  const bet = room.bet, w = room.result ? room.result.winner : null;
  const pay = [0, 0];
  if (room.mode === 'pvp') {
    if (w === 0 || w === 1) pay[w] = bet * 2;
    else { pay[0] = bet; pay[1] = bet; }
  } else if (w === 0) {
    let net = bet;
    if (room.level === 'easy') {
      net = coins.easyNet(room.seats[0].id, bet);
      if (net <= 0) room.note = 'Plafond de gains du jour atteint contre le robot facile : mise rendue.';
      else if (net < bet) room.note = 'Gain réduit : plafond du jour atteint contre le robot facile.';
    }
    pay[0] = bet + net;
  } else if (w === null) {
    pay[0] = bet;
  }
  room.payout = pay;
  for (let i = 0; i < 2; i++) {
    const s = room.seats[i];
    if (s && !s.bot && pay[i] > 0) coins.credit(s.id, pay[i]);
  }
}

function finish(room) {
  room.status = 'over';
  room.finishedAt = Date.now();
  clearTimers(room);
  settle(room);
  for (const s of room.seats) {
    if (s && !s.bot) {
      if (roomOf.get(s.id) === room) roomOf.delete(s.id);
      pushCoins(s.id);
    }
  }
}

function timerKey(room) {
  const s = room.state;
  switch (room.game) {
    case 'quiz': return s.i + ':' + s.phase;
    case 'penalty': return String(s.k);
    case 'tictactoe': return String(s.turn);
    case 'chess': return String(s.ply);
  }
  return String(Date.now());
}

// Le chrono repart seulement quand un nouveau tour / une nouvelle question commence
function armTimer(room) {
  if (room.status !== 'playing') {
    clearTimeout(room.timer); room.timer = null; room.deadline = null; room.limit = 0;
    return;
  }
  const key = timerKey(room);
  if (room.timer && room.timerKey === key) return;
  clearTimeout(room.timer); room.timer = null;
  room.timerKey = key;
  const ms = GAMES[room.game].timeLimit(room);
  if (ms > 0) {
    room.deadline = Date.now() + ms; room.limit = ms;
    room.timer = setTimeout(() => onTimeout(room), ms);
  } else {
    room.deadline = null; room.limit = 0;
  }
}

function onTimeout(room) {
  room.timer = null;
  if (room.status !== 'playing') return;
  try { GAMES[room.game].timeout(room); } catch (e) { console.error(e); }
  afterChange(room);
}

function scheduleBot(room) {
  if (room.botTimer) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.status !== 'playing') return;
    let acted = false;
    try { acted = GAMES[room.game].bot(room); } catch (e) { console.error(e); }
    if (acted) afterChange(room);
  }, 450 + Math.floor(Math.random() * 650));
}

// À appeler après tout changement d'état d'une salle
function afterChange(room) {
  if (rooms.get(room.code) !== room) return;
  room.lastActive = Date.now();
  if (room.status === 'playing' && room.result) finish(room);
  armTimer(room);
  emitRoom(room);
  if (room.status === 'playing' && room.mode === 'bot') scheduleBot(room);
}

function start(room) {
  if (room.mode === 'pvp' && Math.random() < 0.5) room.seats.reverse();   // couleurs / ordre tirés au sort
  room.status = 'playing';
  room.state = GAMES[room.game].create(room);
}

function forfeit(room, seat, reason) {
  if (room.status !== 'playing') return;
  room.result = { winner: 1 - seat, reason };
  afterChange(room);
}

function startGrace(room, seat) {
  clearTimeout(room.grace[seat]);
  room.grace[seat] = setTimeout(() => {
    room.grace[seat] = null;
    const s = room.seats[seat];
    if (room.status === 'playing' && s && s.offline) forfeit(room, seat, 'Déconnexion');
  }, GRACE_MS);
}

function roomsList(game) {
  return Array.from(rooms.values())
    .filter(r => r.status !== 'over' && (!game || r.game === game))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map(r => ({
      code: r.code, game: r.game, mode: r.mode, level: r.level, bet: r.bet, status: r.status,
      players: r.seats.filter(Boolean).map(s => s.name), spectators: countSpectators(r)
    }));
}

// Sortie d'un joueur (abandon, bannissement, suppression)
function removeSeated(pid, reason) {
  const room = roomOf.get(pid);
  if (!room) return;
  const seat = seatOf(room, pid);
  detachPlayer(room, pid);
  if (room.status === 'waiting') cancelWaiting(room, 'Partie annulée');
  else if (room.status === 'playing' && seat !== null) forfeit(room, seat, reason);
}

function sweep() {
  const now = Date.now(), idle = cfg.ROOM_IDLE_MINUTES * 60 * 1000;
  for (const room of Array.from(rooms.values())) {
    if (room.status === 'waiting' && now - room.createdAt > idle) cancelWaiting(room, 'Aucun adversaire');
    else if (room.status === 'playing' && now - room.lastActive > idle) {
      room.result = { winner: null, reason: 'Partie inactive : mises rendues' };
      afterChange(room);
    } else if (room.status === 'over' && (!room.members.size || now - room.finishedAt > OVER_KEEP_MS)) {
      closeRoom(room, 'Partie terminée');
    }
  }
  posts.sweepUploads();
  for (const [ip, list] of accountsByIp) {
    const fresh = list.filter(t => now - t < 24 * 3600 * 1000);
    if (fresh.length) accountsByIp.set(ip, fresh); else accountsByIp.delete(ip);
  }
}

/* ---------- Connexion ---------- */

function attachIo(io) {
  setInterval(sweep, 60 * 1000).unref();

  io.on('connection', socket => {
    socket.data.rooms = new Set();
    socket.data.pid = null;
    socket.data.owner = false;

    // Anti-spam : 30 messages par seconde au maximum
    let n = 0, t0 = Date.now();
    socket.use((packet, next) => {
      const now = Date.now();
      if (now - t0 > 1000) { t0 = now; n = 0; }
      if (++n > 30) { reply(packet[packet.length - 1], { error: 'Trop de requêtes' }); return; }
      next();
    });

    // Enveloppe : accepte on(ev, ack) ou on(ev, data, ack), et ne laisse jamais une erreur planter le serveur
    function on(ev, fn) {
      socket.on(ev, (a, b) => {
        const data = typeof a === 'function' ? {} : (a && typeof a === 'object' ? a : {});
        const ack = typeof a === 'function' ? a : b;
        try { fn(data, ack); } catch (e) { console.error(ev, e); reply(ack, { error: 'Erreur du serveur' }); }
      });
    }
    // Même chose, mais il faut être connecté avec un compte valide
    function authed(ev, fn) {
      on(ev, (data, ack) => {
        const p = coins.get(socket.data.pid);
        if (!p) return reply(ack, { error: 'Session expirée, recharge la page' });
        if (p.banned) return reply(ack, { error: 'Compte bloqué' });
        fn(p, data, ack);
      });
    }
    function level() {
      if (socket.data.owner) return 'owner';
      const p = coins.get(socket.data.pid);
      return p && p.admin && !p.banned ? 'admin' : null;
    }

    on('hello', (data, ack) => {
      let p = coins.byToken(data.token), created = false;
      if (!p) {
        const ip = ipOf(socket), now = Date.now();
        const recent = (accountsByIp.get(ip) || []).filter(t => now - t < 24 * 3600 * 1000);
        if (recent.length >= MAX_ACCOUNTS_PER_IP) {
          return reply(ack, { error: 'Trop de comptes créés depuis cette connexion. Réessaie demain.' });
        }
        p = coins.createPlayer(data.name);
        created = true;
        recent.push(now); accountsByIp.set(ip, recent);
      }
      if (p.banned) return reply(ack, { error: 'banned' });
      const old = socket.data.pid;
      if (old && old !== p.id && byPlayer.get(old)) byPlayer.get(old).delete(socket);
      socket.data.pid = p.id;
      if (!byPlayer.has(p.id)) byPlayer.set(p.id, new Set());
      byPlayer.get(p.id).add(socket);
      const room = roomOf.get(p.id);
      reply(ack, {
        ok: true, token: p.token, created, me: coins.pub(p),
        daily: coins.dailyClaimed(p.id),
        activeRoom: room ? room.code : null,
        config: {
          bet: cfg.BET, shop: cfg.SHOP, dailyBonus: cfg.DAILY_BONUS, games: cfg.GAMES,
          turnSeconds: cfg.TURN_SECONDS, penaltyRounds: cfg.PENALTY_ROUNDS,
          quizQuestions: cfg.QUIZ_QUESTIONS, roulettePay: cfg.ROULETTE.pay,
          easyCap: cfg.EASY_DAILY_NET_CAP, maxSpectators: cfg.MAX_SPECTATORS
        }
      });
    });

    authed('rename', (p, data, ack) => {
      const q = coins.rename(p.id, data.name);
      pushCoins(p.id);
      reply(ack, { ok: true, name: q.name });
    });

    authed('daily', (p, data, ack) => {
      const r = coins.claimDaily(p.id);
      if (!r.ok) return reply(ack, { error: r.error === 'deja' ? 'Bonus déjà récupéré aujourd\'hui' : 'Compte indisponible' });
      pushCoins(p.id);
      reply(ack, { ok: true, coins: r.coins, gain: r.gain });
    });

    authed('lb', (p, data, ack) => {
      const all = coins.leaderboard(1e6);
      const i = all.findIndex(x => x.id === p.id);
      reply(ack, { ok: true, list: all.slice(0, 10), rank: i < 0 ? null : i + 1, total: all.length });
    });

    authed('shop:buy', (p, data, ack) => {
      const item = cfg.SHOP.find(x => x.id === data.id);
      if (!item) return reply(ack, { error: 'Récompense inconnue' });
      if (!coins.debit(p.id, item.cost)) {
        return reply(ack, { error: 'Il te manque ' + Math.max(0, item.cost - p.coins) + ' Coins' });
      }
      const rec = { at: Date.now(), pid: p.id, name: p.name, item: item.name, cost: item.cost };
      purchases.unshift(rec);
      if (purchases.length > 50) purchases.pop();
      try {
        fs.mkdirSync(path.dirname(cfg.DATA_FILE), { recursive: true });
        fs.appendFileSync(path.join(path.dirname(cfg.DATA_FILE), 'purchases.log'), JSON.stringify(rec) + '\n');
      } catch (e) { /* le journal est un bonus */ }
      for (const [pid, set] of byPlayer) for (const s of set) {
        const sp = coins.get(pid);
        if (s.data.owner || (sp && sp.admin)) s.emit('admin:purchase', rec);
      }
      pushCoins(p.id);
      reply(ack, { ok: true, coins: coins.get(p.id).coins, item });
    });

    authed('lobby:rooms', (p, data, ack) => {
      reply(ack, { ok: true, rooms: roomsList(GAMES[data.game] ? data.game : null) });
    });

    authed('roulette:history', (p, data, ack) => reply(ack, { ok: true, history: roulette.history() }));

    authed('roulette:spin', (p, data, ack) => {
      const res = roulette.spin(p.id, data.bet, data.choice);
      if (res.ok) { res.history = roulette.history(); pushCoins(p.id); }
      reply(ack, res);
    });

    authed('room:create', (p, data, ack) => {
      const game = data.game;
      if (!GAMES[game]) return reply(ack, { error: 'Jeu inconnu' });
      const mode = data.mode === 'bot' ? 'bot' : 'pvp';
      const lvl = mode === 'bot' ? data.level : null;
      if (mode === 'bot' && LEVELS.indexOf(lvl) < 0) return reply(ack, { error: 'Niveau invalide' });
      const lim = mode === 'bot' ? cfg.BET.bot[lvl] : cfg.BET.pvp;
      const bet = data.bet;
      if (!Number.isInteger(bet) || bet < lim.min || bet > lim.max) {
        return reply(ack, { error: 'Mise entre ' + lim.min + ' et ' + lim.max + ' Coins' });
      }
      const cur = roomOf.get(p.id);
      if (cur) return reply(ack, { error: 'Tu as déjà une partie en cours', code: cur.code });
      if (!coins.debit(p.id, bet)) return reply(ack, { error: 'Pas assez de Coins' });   // mise prise avant le début

      const room = {
        code: newCode(), game, mode, level: lvl, bet, status: 'waiting',
        seats: [{ id: p.id, name: p.name, bot: false, offline: false }, null],
        state: null, result: null, payout: null, note: null, settled: false,
        members: new Map(), timer: null, timerKey: '', deadline: null, limit: 0,
        botTimer: null, grace: [null, null],
        createdAt: Date.now(), lastActive: Date.now(), finishedAt: 0
      };
      rooms.set(room.code, room);
      roomOf.set(p.id, room);
      attach(room, socket, p.id);
      if (mode === 'bot') {
        room.seats[1] = { id: 'bot', name: 'Robot ' + LEVEL_NAME[lvl], bot: true };
        start(room);
      }
      pushCoins(p.id);
      reply(ack, { ok: true, code: room.code });
      if (mode === 'bot') afterChange(room); else emitRoom(room);
    });

    authed('room:join', (p, data, ack) => {
      const code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const room = rooms.get(code);
      if (!room) return reply(ack, { error: 'Salle introuvable' });

      const seat = seatOf(room, p.id);
      if (seat !== null) {                       // reprise après une coupure
        attach(room, socket, p.id);
        reply(ack, { ok: true, code });
        return emitRoom(room);
      }
      if (room.status === 'waiting' && room.mode === 'pvp' && !data.spectate) {
        const cur = roomOf.get(p.id);
        if (cur) return reply(ack, { error: 'Tu as déjà une partie en cours', code: cur.code });
        if (!coins.debit(p.id, room.bet)) return reply(ack, { error: 'Il faut ' + room.bet + ' Coins pour rejoindre' });
        room.seats[1] = { id: p.id, name: p.name, bot: false, offline: false };
        roomOf.set(p.id, room);
        attach(room, socket, p.id);
        start(room);
        pushCoins(p.id);
        reply(ack, { ok: true, code });
        return afterChange(room);
      }
      if (countSpectators(room) >= cfg.MAX_SPECTATORS) return reply(ack, { error: 'Trop de spectateurs dans cette salle' });
      attach(room, socket, p.id);                // spectateur : lecture seule
      reply(ack, { ok: true, code, spectator: true });
      emitRoom(room);
    });

    authed('room:leave', (p, data, ack) => {
      const room = rooms.get(String(data.code || '').toUpperCase());
      if (!room) return reply(ack, { ok: true });
      const seat = seatOf(room, p.id);
      if (seat === null) {
        detachPlayer(room, p.id);
        reply(ack, { ok: true });
        if (room.status === 'over' && !room.members.size) closeRoom(room, 'Partie terminée');
        else emitRoom(room);
        return;
      }
      detachPlayer(room, p.id);
      reply(ack, { ok: true });
      if (room.status === 'waiting') cancelWaiting(room, 'Partie annulée');
      else if (room.status === 'playing') forfeit(room, seat, 'Abandon');
      else if (!room.members.size) closeRoom(room, 'Partie terminée');
    });

    authed('game:move', (p, data, ack) => {
      const room = rooms.get(String(data.code || '').toUpperCase());
      if (!room) return reply(ack, { error: 'Salle introuvable' });
      const seat = seatOf(room, p.id);
      if (seat === null) return reply(ack, { error: 'Les spectateurs ne peuvent pas jouer' });
      if (room.status !== 'playing') return reply(ack, { error: 'Partie non active' });
      const res = GAMES[room.game].move(room, seat, data.data);
      if (res && res.error) return reply(ack, res);
      reply(ack, { ok: true });
      afterChange(room);
    });

    /* ----- Fil de publications ----- */

    authed('feed:list', (p, data, ack) => {
      const scope = data.scope === 'following' ? 'following' : 'all';
      const before = typeof data.before === 'number' ? data.before : undefined;
      reply(ack, Object.assign({ ok: true }, posts.feed(p.id, scope, before)));
    });
    authed('post:create', (p, data, ack) => {
      reply(ack, posts.create(p.id, data.text, typeof data.img === 'string' ? data.img : null, backup.queueImage));
    });
    authed('post:get', (p, data, ack) => reply(ack, posts.getOne(p.id, String(data.id || ''))));
    authed('post:like', (p, data, ack) => reply(ack, posts.toggleLike(p.id, String(data.id || ''))));
    authed('post:comments', (p, data, ack) => reply(ack, posts.listComments(p.id, String(data.id || ''))));
    authed('post:comment', (p, data, ack) => reply(ack, posts.addComment(p.id, String(data.id || ''), data.text)));
    authed('post:delete', (p, data, ack) => {
      reply(ack, posts.deletePost(p.id, String(data.id || ''), socket.data.owner, backup.deleteImage));
    });
    authed('comment:delete', (p, data, ack) => {
      reply(ack, posts.deleteComment(p.id, String(data.id || ''), String(data.cid || ''), socket.data.owner));
    });
    authed('post:report', (p, data, ack) => reply(ack, posts.report(p.id, String(data.id || ''), data.reason)));
    authed('user:profile', (p, data, ack) => reply(ack, posts.profile(p.id, String(data.id || ''))));
    authed('user:follow', (p, data, ack) => reply(ack, posts.toggleFollow(p.id, String(data.id || ''))));

    /* ----- Admin ----- */

    on('admin:login', (data, ack) => {
      const p = coins.get(socket.data.pid);
      if (!p || p.banned) return reply(ack, { error: 'Session expirée, recharge la page' });
      const code = String(data.code || '');
      if (!code) return p.admin ? reply(ack, { ok: true, level: 'admin' }) : reply(ack, { error: 'Entre le code' });
      if (!cfg.ADMIN_CODE) return reply(ack, { error: 'Code admin non configuré sur le serveur' });
      const ip = ipOf(socket), f = adminFails.get(ip) || { n: 0, until: 0 };
      if (Date.now() < f.until) return reply(ack, { error: 'Trop d\'essais, patiente un peu' });
      if (!safeEqual(code, cfg.ADMIN_CODE)) {
        f.n++;
        if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60 * 1000; }
        adminFails.set(ip, f);
        return reply(ack, { error: 'Code incorrect' });
      }
      adminFails.delete(ip);
      socket.data.owner = true;
      reply(ack, { ok: true, level: 'owner' });
    });

    on('admin:list', (data, ack) => {
      const lv = level();
      if (!lv) return reply(ack, { error: 'Accès refusé' });
      const accounts = coins.listAll().map(a => Object.assign({ online: byPlayer.has(a.id) }, a));
      reply(ack, { ok: true, level: lv, accounts, purchases: purchases.slice(0, 30) });
    });

    on('admin:reports', (data, ack) => {
      if (!level()) return reply(ack, { error: 'Accès refusé' });
      reply(ack, { ok: true, reports: posts.reportList() });
    });
    on('admin:clear', (data, ack) => {
      if (!level()) return reply(ack, { error: 'Accès refusé' });
      reply(ack, posts.clearReports(String(data.id || '')));
    });

    on('admin:act', (data, ack) => {
      const lv = level();
      if (!lv) return reply(ack, { error: 'Accès refusé' });
      const t = coins.get(data.id);
      if (!t) return reply(ack, { error: 'Compte introuvable' });
      const act = data.act;
      if ((act === 'ban' || act === 'delete') && t.id === socket.data.pid) {
        return reply(ack, { error: 'Impossible sur ton propre compte' });
      }
      if ((act === 'admin' || act === 'unadmin') && lv !== 'owner') {
        return reply(ack, { error: 'Réservé au créateur' });
      }
      if ((act === 'ban' || act === 'delete') && lv !== 'owner' && t.admin) {
        return reply(ack, { error: 'Un admin ne peut pas agir sur un autre admin' });
      }
      if (act === 'admin') coins.setAdmin(t.id, true);
      else if (act === 'unadmin') coins.setAdmin(t.id, false);
      else if (act === 'unban') coins.setBanned(t.id, false);
      else if (act === 'ban' || act === 'delete') {
        if (act === 'ban') coins.setBanned(t.id, true);
        removeSeated(t.id, 'Joueur exclu');
        for (const s of Array.from(byPlayer.get(t.id) || [])) { s.emit('kicked', { reason: act }); s.disconnect(true); }
        if (act === 'delete') { posts.purgeUser(t.id, backup.deleteImage); coins.remove(t.id); }
      } else return reply(ack, { error: 'Action inconnue' });
      reply(ack, { ok: true });
    });

    socket.on('disconnect', () => {
      const pid = socket.data.pid;
      const set = byPlayer.get(pid);
      if (set) { set.delete(socket); if (!set.size) byPlayer.delete(pid); }
      for (const code of Array.from(socket.data.rooms)) {
        const room = rooms.get(code);
        if (!room) continue;
        detach(room, socket);
        const seat = seatOf(room, pid);
        const stillThere = Array.from(room.members.values()).some(m => m.pid === pid);
        if (seat !== null && !stillThere && room.status === 'playing') {
          room.seats[seat].offline = true;       // 45 s pour revenir, sinon abandon
          startGrace(room, seat);
        }
        if (room.status === 'over' && !room.members.size) closeRoom(room, 'Partie terminée');
        else emitRoom(room);
      }
    });
  });
}

module.exports = { attach: attachIo, _debug: { rooms, roomOf, byPlayer, sweep, settle, GRACE_MS } };
