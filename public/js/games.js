/* Dracula System : interface des jeux (côté navigateur).
 *
 * Ce fichier ne décide de rien : il affiche ce que le serveur envoie (room:state)
 * et lui transmet les actions du joueur (room:create, room:join, game:move...).
 * Les mises, les tours, les chronos et les gains sont tous gérés par server/socket.js.
 *
 * Branchement depuis index.html :
 *   Games.init({ socket, say(texte), getMe(), getConfig() });
 *   Games.open('chess')        ouvre le lobby d'un jeu (aussi : clic sur .game[data-game])
 *   Games.join(code, spectate) rejoint une salle (lien d'invitation /m/CODE)
 *   Games.resume(code)         reprend une partie en cours après une coupure
 *   Games.refreshMe()          à appeler quand le solde change
 *
 * Éléments HTML attendus : #gv (écran), #gv-back, #gv-ttl, #gv-eye, #gv-body.
 */
(function () {
  'use strict';

  var ctx = null;

  var META = {
    tictactoe: { name: 'Morpion' },
    penalty:   { name: 'Penalty' },
    chess:     { name: 'Échecs' },
    quiz:      { name: 'Quiz' },
    roulette:  { name: 'Roulette' }
  };
  var LEVELS = [['easy', 'Facile'], ['normal', 'Normal'], ['hard', 'Hard']];
  var LEVEL_NAME = { easy: 'Facile', normal: 'Normal', hard: 'Hard' };
  var DIR_NAME = { L: 'à gauche', C: 'au centre', R: 'à droite' };
  var GLYPH = { k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F\uFE0E' };
  var FILES = 'abcdefgh';

  var S = {
    game: null,        // jeu affiché
    screen: null,      // 'lobby' | 'wait' | 'room' | 'roulette' | 'loading'
    code: null,        // salle en cours
    leftCode: null,    // salle qu'on vient de quitter (ses derniers messages sont ignorés)
    room: null,        // dernier état reçu du serveur
    offset: 0,         // décalage horloge serveur - horloge locale
    pref: { mode: 'bot', level: 'normal', bet: 10 },
    sel: null,         // échecs : case sélectionnée
    promo: null,       // échecs : coup en attente du choix de la pièce
    plyKey: null,
    tick: null,
    lobbyTimer: null,
    busy: false
  };
  var R = { choice: { type: 'color', value: 'red' }, num: 7, bet: 10, hist: [], spinning: false };

  /* ---------- Outils ---------- */

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function conf() { return ctx.getConfig() || { bet: { pvp: { min: 5, max: 10000 }, roulette: { min: 5, max: 10000 }, bot: {} } }; }
  function coinsNow() { var m = ctx.getMe(); return m ? m.coins : 0; }

  // Envoie un événement au serveur et attend l'accusé de réception
  function call(ev, data) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (!done) { done = true; resolve({ error: 'Le serveur ne répond pas' }); }
      }, 10000);
      ctx.socket.emit(ev, data || {}, function (r) {
        if (done) return;
        done = true; clearTimeout(t);
        resolve(r || { error: 'Réponse vide du serveur' });
      });
    });
  }

  function stopTimers() {
    if (S.tick) { clearInterval(S.tick); S.tick = null; }
    if (S.lobbyTimer) { clearInterval(S.lobbyTimer); S.lobbyTimer = null; }
  }
  function openOverlay() { $('gv').classList.add('on'); }
  function closeOverlay() {
    stopTimers();
    $('gv').classList.remove('on');
    $('gv-body').innerHTML = '';
    $('gv-eye').textContent = '';
    S.game = null; S.screen = null; S.code = null; S.room = null; S.sel = null; S.promo = null;
  }
  function setTitle() { $('gv-ttl').textContent = S.game && META[S.game] ? META[S.game].name : 'Jeux'; }
  function body(html) { $('gv-body').innerHTML = html; }

  function seatName(p, i) { var s = p.seats[i]; return s ? s.name : '...'; }

  /* ---------- Lobby ---------- */

  function limits() {
    var cfg = conf();
    if (S.game === 'roulette') return cfg.bet.roulette;
    if (S.pref.mode === 'bot') return cfg.bet.bot[S.pref.level] || { min: 5, max: 20 };
    return cfg.bet.pvp;
  }
  function clampBet(n, lim) {
    n = parseInt(n, 10);
    if (!isFinite(n)) n = lim.min;
    return Math.max(lim.min, Math.min(lim.max, n));
  }
  function chipValues(lim) {
    var base = [5, 10, 25, 50, 100, 500, 1000, 10000].filter(function (v) { return v >= lim.min && v <= lim.max; });
    if (base.length > 5) base = base.slice(0, 5);
    if (base.indexOf(lim.max) < 0) base.push(lim.max);
    return base;
  }
  function seg(act, items, current) {
    return items.map(function (it) {
      return '<button data-act="' + act + '" data-v="' + it[0] + '" class="' + (it[0] === current ? 'on' : '') + '">' + esc(it[1]) + '</button>';
    }).join('');
  }
  function chipsHtml(lim) {
    return chipValues(lim).map(function (v) {
      return '<button class="chip" data-act="chip" data-v="' + v + '">' + v + '</button>';
    }).join('');
  }

  function renderLobby() {
    stopTimers();
    S.screen = 'lobby'; S.room = null; S.code = null;
    setTitle(); $('gv-eye').textContent = '';
    var P = S.pref, lim = limits(), cfg = conf();
    P.bet = clampBet(P.bet, lim);
    var note = '';
    if (P.mode === 'bot' && P.level === 'easy') {
      note = '<p class="limits">Robot facile : gain net limité à ' + esc(cfg.easyCap || 100) + ' Coins par jour.</p>';
    }
    body(
      '<div class="lobby">' +
        '<div><h3>Adversaire</h3><div class="seg">' + seg('mode', [['bot', 'Robot'], ['pvp', 'Joueur']], P.mode) + '</div></div>' +
        (P.mode === 'bot' ? '<div><h3>Niveau</h3><div class="seg">' + seg('level', LEVELS, P.level) + '</div></div>' : '') +
        '<div><h3>Mise</h3>' +
          '<div class="betrow"><input class="f" id="l-bet" type="number" inputmode="numeric" min="' + lim.min + '" max="' + lim.max + '" value="' + P.bet + '" aria-label="Mise en Coins">' +
          '<span class="eye" data-solde>Solde ' + coinsNow() + '</span></div>' +
          '<div class="chips">' + chipsHtml(lim) + '</div>' +
          '<p class="limits">Mise de ' + lim.min + ' à ' + lim.max + ' Coins. La mise est prise au début de la partie.</p>' + note +
        '</div>' +
        '<button class="btn" id="l-go" data-act="create">' + (P.mode === 'bot' ? 'Jouer contre le robot' : 'Créer une partie') + '</button>' +
        '<div><h3>Rejoindre avec un code</h3><div class="betrow">' +
          '<input class="f" id="l-code" maxlength="8" placeholder="Code de la salle" autocapitalize="characters" autocomplete="off" aria-label="Code de la salle">' +
          '<button class="btn ghost" data-act="joincode">Rejoindre</button></div></div>' +
        '<div class="rooms"><h3>Parties ouvertes</h3><div id="l-rooms"><p class="hint">Chargement...</p></div></div>' +
      '</div>'
    );
    loadRooms();
    S.lobbyTimer = setInterval(loadRooms, 4000);
  }

  function loadRooms() {
    if (S.screen !== 'lobby') return;
    call('lobby:rooms', { game: S.game }).then(function (r) {
      var box = $('l-rooms');
      if (!box || S.screen !== 'lobby') return;
      if (r.error) { box.innerHTML = '<p class="hint">' + esc(r.error) + '</p>'; return; }
      if (!r.rooms.length) {
        box.innerHTML = '<p class="hint">Aucune partie pour le moment. Crée la première.</p>';
        return;
      }
      box.innerHTML = r.rooms.map(function (x) {
        var who = x.players.length ? x.players.map(esc).join(' contre ') : 'Salle vide';
        var kind = x.mode === 'bot' ? 'Robot ' + (LEVEL_NAME[x.level] || '') : 'Joueur contre joueur';
        var state = x.status === 'waiting' ? 'en attente' : 'en cours';
        var spec = x.spectators ? ', ' + x.spectators + ' spectateur' + (x.spectators > 1 ? 's' : '') : '';
        var btns = '';
        if (x.status === 'waiting' && x.mode === 'pvp') {
          btns += '<button class="sm" data-act="join" data-code="' + esc(x.code) + '">Jouer</button>';
        }
        btns += '<button class="sm" data-act="join" data-code="' + esc(x.code) + '" data-spec="1">Regarder</button>';
        return '<div class="row"><div class="av b" style="width:34px;height:34px"></div>' +
          '<div>' + who + '<small>' + esc(kind) + ', mise ' + x.bet + ', ' + state + spec + '</small></div>' +
          '<div style="margin-left:auto;display:flex;gap:6px">' + btns + '</div></div>';
      }).join('');
    });
  }

  async function createRoom() {
    if (S.busy) return;
    var P = S.pref, lim = limits(), bet = parseInt($('l-bet').value, 10);
    if (!Number.isInteger(bet) || bet < lim.min || bet > lim.max) {
      ctx.say('Mise entre ' + lim.min + ' et ' + lim.max + ' Coins'); return;
    }
    P.bet = bet;
    S.busy = true;
    var r = await call('room:create', {
      game: S.game, mode: P.mode, level: P.mode === 'bot' ? P.level : undefined, bet: bet
    });
    S.busy = false;
    if (r.error) {
      ctx.say(r.error);
      if (r.code) await joinRoom(r.code, false);
      return;
    }
    S.code = r.code;
  }

  async function joinRoom(code, spectate) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { ctx.say('Entre le code de la salle'); return; }
    var r = await call('room:join', { code: code, spectate: !!spectate });
    if (r.error) {
      ctx.say(r.error);
      if (S.screen === 'loading') closeOverlay();
      return;
    }
    S.code = r.code;
  }

  /* ---------- Réception des états de salle ---------- */

  function onState(p) {
    if (p.code === S.leftCode) return;
    if (S.code && p.code !== S.code) return;
    S.code = p.code; S.game = p.game; S.room = p;
    S.offset = (p.now || Date.now()) - Date.now();
    openOverlay(); setTitle();
    if (S.lobbyTimer) { clearInterval(S.lobbyTimer); S.lobbyTimer = null; }
    if (p.status === 'waiting') renderWaiting(p); else renderRoom(p);
    if (!S.tick) S.tick = setInterval(tick, 200);
    tick();
  }

  function onClosed(info) {
    if (!info || info.code !== S.code) return;
    ctx.say(info.reason || 'Salle fermée');
    S.code = null; S.room = null;
    if (S.game) renderLobby(); else closeOverlay();
  }

  function renderWaiting(p) {
    S.screen = 'wait';
    var mine = p.seat === 0;
    body(
      '<div class="codebox"><div class="code">' + esc(p.code) + '</div><small>Code de la salle</small></div>' +
      '<p class="hint" style="text-align:center">' + (mine
        ? 'Mise de ' + p.bet + ' Coins chacun. Envoie le lien à un ami ou attends qu\'un joueur te rejoigne depuis la liste des parties.'
        : 'En attente d\'un adversaire...') + '</p>' +
      (mine ? '<button class="btn" data-act="share">Partager le lien</button>' +
              '<button class="btn ghost" data-act="cancel">Annuler et récupérer ma mise</button>'
            : '<button class="btn ghost" data-act="cancel">Quitter</button>')
    );
  }

  /* ---------- Salle de jeu ---------- */

  function vsBar(p, scoreText, turnSeat, labels) {
    var h = '<div class="vs">';
    for (var i = 0; i < 2; i++) {
      var s = p.seats[i];
      var name = (labels ? labels[i] + ' ' : '') + (s ? s.name : '...') + (p.seat === i ? ' (toi)' : '') + (s && s.offline ? ' (hors ligne)' : '');
      h += '<div class="pl' + (turnSeat === i ? ' turn' : '') + '"><div class="av' + (i ? ' b' : '') + '"></div><span>' + esc(name) + '</span></div>';
      if (i === 0) h += '<div class="sc">' + esc(scoreText) + '</div>';
    }
    return h + '</div>';
  }

  function potLine(p) {
    if (p.mode === 'pvp') return '<div class="pot">Pot : ' + p.pot + ' Coins (mise de ' + p.bet + ' chacun)</div>';
    return '<div class="pot">Robot ' + esc(LEVEL_NAME[p.level] || '') + ', mise de ' + p.bet + ' Coins</div>';
  }

  function renderRoom(p) {
    S.screen = 'room';
    var v = p.view, g = p.game;
    var turnSeat = null, score = 'VS', labels = null, game = '';
    var playing = p.status === 'playing';

    if (g === 'tictactoe') {
      turnSeat = playing ? v.turn : null; labels = ['X', 'O']; game = rTicTacToe(p);
    } else if (g === 'penalty') {
      score = v.score[0] + ' - ' + v.score[1]; game = rPenalty(p);
    } else if (g === 'chess') {
      turnSeat = playing ? (v.turn === 'w' ? 0 : 1) : null; labels = ['Blancs', 'Noirs']; game = rChess(p);
    } else if (g === 'quiz') {
      score = v.score[0] + ' - ' + v.score[1]; game = rQuiz(p);
    }

    var timer = playing && p.deadline ? '<div class="timer" id="tm"><i id="tbar"></i></div>' : '';
    var spec = p.seat === null
      ? '<p class="hint" style="text-align:center">Tu regardes la partie' + (p.spectators ? ' avec ' + p.spectators + ' spectateur' + (p.spectators > 1 ? 's' : '') : '') + '.</p>'
      : '';
    var actions = '';
    if (p.status === 'over') {
      actions = (p.seat !== null ? '<button class="btn" data-act="rematch">Revanche</button>' : '') +
                '<button class="btn ghost" data-act="quit">Quitter</button>';
    }
    body(vsBar(p, score, turnSeat, labels) + potLine(p) + timer + (p.result ? resultHtml(p) : '') + game + spec + actions);
  }

  function resultHtml(p) {
    var r = p.result, my = p.seat, cls, title, sub = esc(r.reason || '');
    if (r.winner === null || r.winner === undefined) { cls = 'draw'; title = 'Match nul'; }
    else if (my === null) { cls = 'draw'; title = 'Victoire de ' + seatName(p, r.winner); }
    else if (r.winner === my) { cls = 'win'; title = 'Victoire !'; }
    else { cls = 'lose'; title = 'Défaite'; }
    if (my !== null && r.bet != null) {
      var pay = r.payout || 0;
      if (pay > r.bet) sub += ' (+' + (pay - r.bet) + ' Coins)';
      else if (pay === r.bet) sub += ' (mise rendue)';
      else sub += ' (-' + r.bet + ' Coins)';
    }
    if (r.note) sub += '<br>' + esc(r.note);
    return '<div class="result ' + cls + '">' + esc(title) + '<small>' + sub + '</small></div>';
  }

  function turnHint(text) { return '<p class="hint" style="text-align:center">' + esc(text) + '</p>'; }

  /* ----- Morpion ----- */

  function rTicTacToe(p) {
    var v = p.view, my = p.seat;
    var can = p.status === 'playing' && my === v.turn;
    var line = v.line || [];
    var cells = v.board.map(function (m, i) {
      var cls = 'cell' + (m === 'X' ? ' x' : m === 'O' ? ' o' : '') + (line.indexOf(i) >= 0 ? ' win' : '');
      return '<button class="' + cls + '" data-act="ttt" data-i="' + i + '"' + (can && !m ? '' : ' disabled') +
        ' aria-label="Case ' + (i + 1) + (m ? ', ' + m : ', vide') + '">' + m + '</button>';
    }).join('');
    var hint = '';
    if (p.status === 'playing') {
      hint = can ? 'À toi de jouer (' + v.marks[my] + ')' : 'Tour de ' + seatName(p, v.turn) + '...';
    }
    return '<div class="board3">' + cells + '</div>' + (hint ? turnHint(hint) : '');
  }

  /* ----- Penalty ----- */

  function rPenalty(p) {
    var v = p.view, my = p.seat, N = v.regulation;
    var playing = p.status === 'playing';
    var canPick = playing && my !== null && !v.chosen[my];
    var say;
    if (!playing) say = 'Séance terminée';
    else if (my === null) say = seatName(p, v.shooter) + ' tire, ' + seatName(p, 1 - v.shooter) + ' garde les buts';
    else if (v.chosen[my]) say = 'Choix fait, en attente de ' + seatName(p, 1 - my) + '...';
    else if (my === v.shooter) say = 'Tu tires : choisis un côté';
    else say = 'Tu es gardien : choisis où plonger';

    var zones = [['L', '\u25C0'], ['C', '\u25B2'], ['R', '\u25B6']].map(function (z) {
      var cls = 'zone' + (v.mine === z[0] ? ' pick' : '');
      return '<button class="' + cls + '" data-act="pen" data-d="' + z[0] + '"' + (canPick ? '' : ' disabled') +
        ' aria-label="' + (my === v.shooter ? 'Tirer ' : 'Plonger ') + DIR_NAME[z[0]] + '">' + z[1] + '</button>';
    }).join('');

    var sudden = v.suddenDeath ? '<p class="hint" style="text-align:center">Mort subite</p>' : '';
    var last = '';
    if (v.last) {
      last = turnHint(seatName(p, v.last.shooter) + ' tire ' + DIR_NAME[v.last.shot] + ', le gardien plonge ' + DIR_NAME[v.last.dive] + ' : ' + (v.last.goal ? 'BUT !' : 'ARRÊTÉ !'));
    }
    var status = '';
    if (my === null && playing) {
      status = '<p class="hint" style="text-align:center">Tireur : ' + (v.chosen[v.shooter] ? 'a choisi' : 'réfléchit') +
        ', gardien : ' + (v.chosen[1 - v.shooter] ? 'a choisi' : 'réfléchit') + '</p>';
    }

    var rows = '';
    for (var s = 0; s < 2; s++) {
      var shots = v.hist.filter(function (h) { return h.shooter === s; });
      var n = Math.max(N, shots.length), dots = '';
      for (var i = 0; i < n; i++) {
        var h = shots[i];
        dots += '<span class="rd' + (h ? (h.goal ? ' goal' : ' miss') : '') + '">' + (h ? (h.goal ? '\u2713' : '\u2715') : '') + '</span>';
      }
      rows += '<div><p class="hint" style="text-align:center;margin-bottom:6px">' + esc(seatName(p, s)) + '</p><div class="rounds">' + dots + '</div></div>';
    }
    return '<div class="pitch"><div class="goal">' + zones + '</div><div class="say">' + esc(say) + '</div></div>' +
      sudden + last + status + rows;
  }

  /* ----- Échecs ----- */

  function sqName(i) { return FILES[i & 7] + (8 - (i >> 3)); }

  function rChess(p) {
    var v = p.view, my = p.seat;
    if (S.plyKey !== p.code + ':' + v.ply) { S.plyKey = p.code + ':' + v.ply; S.sel = null; S.promo = null; }
    var turnSeat = v.turn === 'w' ? 0 : 1;
    var can = p.status === 'playing' && my === turnSeat;
    var targets = S.sel && v.moves[S.sel] ? v.moves[S.sel] : [];
    var flip = my === 1;
    var cells = '';
    for (var k = 0; k < 64; k++) {
      var i = flip ? 63 - k : k;
      var name = sqName(i), piece = v.board[i];
      var light = (((i >> 3) + (i & 7)) % 2) === 0;
      var cls = 'sq ' + (light ? 'l' : 'd');
      if (v.last && (v.last.from === name || v.last.to === name)) cls += ' last';
      if (S.sel === name) cls += ' sel';
      if (v.check === name) cls += ' chk';
      if (targets.indexOf(name) >= 0) cls += ' hintm' + (piece ? ' cap' : '');
      var clickable = can && (v.moves[name] || targets.indexOf(name) >= 0);
      var glyph = piece ? '<span class="pc ' + (piece < 'a' ? 'w' : 'b') + '">' + GLYPH[piece.toLowerCase()] + '</span>' : '';
      cells += '<button class="' + cls + '" data-act="sq" data-sq="' + name + '"' + (clickable ? '' : ' disabled') +
        ' aria-label="' + name + (piece ? ', ' + piece : '') + '">' + glyph + '</button>';
    }
    var promo = '';
    if (S.promo) {
      var cls2 = my === 0 ? 'w' : 'b';
      promo = '<div class="promo">' + ['q', 'r', 'b', 'n'].map(function (x) {
        return '<button data-act="promo" data-p="' + x + '" aria-label="Promotion"><span class="pc ' + cls2 + '" style="' +
          (cls2 === 'w' ? 'color:#fff;text-shadow:0 0 2px #000,0 0 2px #000' : 'color:#14081f') + '">' + GLYPH[x] + '</span></button>';
      }).join('') + '</div>';
    }
    var hint = '';
    if (p.status === 'playing') {
      if (my === null) hint = 'Tour des ' + (v.turn === 'w' ? 'Blancs' : 'Noirs');
      else if (can) hint = (v.check ? 'Échec ! ' : '') + 'À toi de jouer (' + (my === 0 ? 'Blancs' : 'Noirs') + ')';
      else hint = 'Tour de ' + seatName(p, turnSeat) + '...';
    }
    return '<div class="chess">' + cells + '</div>' + promo + (hint ? turnHint(hint) : '');
  }

  function onSquare(sq) {
    var p = S.room;
    if (!p || p.status !== 'playing' || p.game !== 'chess') return;
    var v = p.view;
    if (p.seat !== (v.turn === 'w' ? 0 : 1)) return;
    if (S.sel && v.moves[S.sel] && v.moves[S.sel].indexOf(sq) >= 0) {
      if (v.promo.indexOf(S.sel + sq) >= 0) { S.promo = { from: S.sel, to: sq }; renderRoom(p); return; }
      var data = { from: S.sel, to: sq };
      S.sel = null;
      sendMove(data);
      renderRoom(p);
      return;
    }
    S.promo = null;
    S.sel = v.moves[sq] && S.sel !== sq ? sq : null;
    renderRoom(p);
  }

  /* ----- Quiz ----- */

  function rQuiz(p) {
    var v = p.view, my = p.seat;
    var can = p.status === 'playing' && v.phase === 'q' && my !== null && v.mine === null;
    var opts = v.q.opts.map(function (o, i) {
      var cls = 'quiz-opt';
      if (v.phase === 'reveal' && v.reveal) {
        if (i === v.reveal.c) cls += ' right';
        else if (my !== null ? v.mine === i : v.reveal.picks.indexOf(i) >= 0) cls += ' wrong';
      } else if (v.mine === i) cls += ' picked';
      return '<button class="' + cls + '" data-act="quiz" data-o="' + i + '"' + (can ? '' : ' disabled') + '>' + esc(o) + '</button>';
    }).join('');
    var note = '';
    if (p.status === 'playing' || v.phase === 'reveal') {
      if (v.phase === 'reveal') note = v.mine === -1 ? 'Temps écoulé pour cette question' : '';
      else if (my !== null && v.mine !== null) note = 'Réponse envoyée, en attente de ' + seatName(p, 1 - my) + '...';
      else if (my !== null && v.answered[1 - my]) note = seatName(p, 1 - my) + ' a déjà répondu';
    }
    var times = '';
    if (v.time) times = turnHint('Temps cumulé sur les bonnes réponses : ' + (v.time[0] / 1000).toFixed(1) + ' s contre ' + (v.time[1] / 1000).toFixed(1) + ' s');
    return '<div class="quiz-q"><small>Question ' + (v.i + 1) + ' sur ' + v.n + '</small>' + esc(v.q.text) + '</div>' +
      '<div class="quiz-opts">' + opts + '</div>' + (note ? turnHint(note) : '') + times;
  }

  /* ---------- Envoi d'un coup ---------- */

  function sendMove(data) {
    if (!S.code) return;
    call('game:move', { code: S.code, data: data }).then(function (r) {
      if (r.error) ctx.say(r.error);
    });
  }

  /* ---------- Chrono ---------- */

  function tick() {
    var p = S.room, eye = $('gv-eye'), bar = $('tbar'), tm = $('tm');
    if (!eye) return;
    if (!p || p.status !== 'playing' || !p.deadline || !bar) { eye.textContent = ''; return; }
    var left = Math.max(0, p.deadline - (Date.now() + S.offset));
    var frac = p.limit ? Math.min(1, left / p.limit) : 0;
    bar.style.transform = 'scaleX(' + frac + ')';
    tm.classList.toggle('low', left < 4000 || frac < 0.25);
    eye.textContent = Math.ceil(left / 1000) + ' s';
  }

  /* ---------- Quitter / revanche ---------- */

  async function leaveRoom(askIfPlaying) {
    var p = S.room;
    if (askIfPlaying && p && p.status === 'playing' && p.seat !== null) {
      if (!window.confirm('Quitter la partie ? Tu perds ta mise.')) return false;
    }
    if (S.code) {
      S.leftCode = S.code;
      await call('room:leave', { code: S.code });
    }
    S.code = null; S.room = null; S.sel = null; S.promo = null;
    return true;
  }

  async function rematch() {
    var p = S.room;
    if (!p || p.seat === null) return;
    var cfgRoom = { game: p.game, mode: p.mode, level: p.level, bet: p.bet };
    if (!(await leaveRoom(false))) return;
    var r = await call('room:create', {
      game: cfgRoom.game, mode: cfgRoom.mode, level: cfgRoom.mode === 'bot' ? cfgRoom.level : undefined, bet: cfgRoom.bet
    });
    if (r.error) { ctx.say(r.error); renderLobby(); return; }
    S.code = r.code;
  }

  function share(code) {
    var url = location.origin + '/m/' + code;
    if (navigator.share) {
      navigator.share({ title: 'Dracula System', text: 'Rejoins ma partie !', url: url }).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { ctx.say('Lien copié'); }, function () { window.prompt('Copie ce lien', url); });
    } else {
      window.prompt('Copie ce lien', url);
    }
  }

  /* ---------- Roulette ---------- */

  function rbBtn(type, value, label, pay, extra) {
    var on = R.choice.type === type && (type === 'green' || type === 'number' || R.choice.value === value);
    return '<button class="rb ' + (extra || '') + (on ? ' on' : '') + '" data-act="rchoice" data-type="' + type + '" data-value="' + value + '">' +
      label + '<br><small>x' + pay + '</small></button>';
  }
  function histHtml() {
    if (!R.hist.length) return '<span style="background:none;color:var(--muted)">Aucun tirage</span>';
    return R.hist.map(function (h) { return '<span class="' + esc(h.color) + '">' + h.n + '</span>'; }).join('');
  }

  async function renderRoulette() {
    stopTimers();
    S.screen = 'roulette'; setTitle(); $('gv-eye').textContent = '';
    var cfg = conf(), pay = cfg.roulettePay || { color: 2, parity: 2, green: 36, number: 36 }, lim = cfg.bet.roulette;
    R.bet = clampBet(R.bet, lim);
    body(
      '<div class="rn" id="r-n" aria-live="polite">?</div>' +
      '<p class="hint" style="text-align:center" id="r-msg">Choisis un pari, une mise, puis lance la bille.</p>' +
      '<div class="rhist" id="r-hist">' + histHtml() + '</div>' +
      '<div class="rbets" id="r-bets">' +
        rbBtn('color', 'red', 'Rouge', pay.color, 'red') + rbBtn('color', 'black', 'Noir', pay.color) + rbBtn('green', 0, 'Vert 0', pay.green, 'green') +
        rbBtn('parity', 'even', 'Pair', pay.parity) + rbBtn('parity', 'odd', 'Impair', pay.parity) + rbBtn('number', 0, 'Numéro', pay.number) +
      '</div>' +
      '<div id="r-numrow" style="display:' + (R.choice.type === 'number' ? 'block' : 'none') + '">' +
        '<input class="f" id="r-num" type="number" inputmode="numeric" min="0" max="36" value="' + R.num + '" aria-label="Numéro de 0 à 36"></div>' +
      '<div><h3 style="font-size:15px;margin-bottom:8px">Mise</h3>' +
        '<div class="betrow"><input class="f" id="r-bet" type="number" inputmode="numeric" min="' + lim.min + '" max="' + lim.max + '" value="' + R.bet + '" aria-label="Mise en Coins">' +
        '<span class="eye" data-solde>Solde ' + coinsNow() + '</span></div>' +
        '<div class="chips">' + chipsHtml(lim) + '</div>' +
        '<p class="limits">Mise de ' + lim.min + ' à ' + lim.max + ' Coins. Le tirage est fait par le serveur.</p></div>' +
      '<button class="btn" id="r-go" data-act="spin">Lancer la bille</button>'
    );
    var h = await call('roulette:history');
    if (h.ok && S.screen === 'roulette') { R.hist = h.history; var el = $('r-hist'); if (el) el.innerHTML = histHtml(); }
  }

  async function spin() {
    if (R.spinning) return;
    var lim = conf().bet.roulette;
    var bet = parseInt($('r-bet').value, 10);
    if (!Number.isInteger(bet) || bet < lim.min || bet > lim.max) { ctx.say('Mise entre ' + lim.min + ' et ' + lim.max + ' Coins'); return; }
    var choice;
    if (R.choice.type === 'number') {
      var n = parseInt($('r-num').value, 10);
      if (!Number.isInteger(n) || n < 0 || n > 36) { ctx.say('Choisis un numéro de 0 à 36'); return; }
      R.num = n; choice = { type: 'number', value: n };
    } else if (R.choice.type === 'green') {
      choice = { type: 'green' };
    } else {
      choice = { type: R.choice.type, value: R.choice.value };
    }
    R.bet = bet; R.spinning = true;
    var go = $('r-go'), rn = $('r-n');
    go.disabled = true; rn.className = 'rn spin'; rn.textContent = '...';
    $('r-msg').textContent = 'La bille tourne...';
    var res = await call('roulette:spin', { bet: bet, choice: choice });
    await sleep(900);
    R.spinning = false;
    if (S.screen !== 'roulette' || !$('r-n')) return;
    $('r-go').disabled = false;
    if (res.error) {
      $('r-n').className = 'rn'; $('r-n').textContent = '?';
      $('r-msg').textContent = res.error; ctx.say(res.error);
      return;
    }
    $('r-n').className = 'rn ' + res.color; $('r-n').textContent = res.n;
    $('r-msg').textContent = res.win ? 'Gagné ! +' + res.net + ' Coins' : 'Perdu : -' + bet + ' Coins';
    R.hist = res.history || R.hist;
    $('r-hist').innerHTML = histHtml();
  }

  /* ---------- Événements de l'interface ---------- */

  function onBodyClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var act = b.getAttribute('data-act');
    switch (act) {
      case 'mode':   S.pref.mode = b.getAttribute('data-v'); renderLobby(); break;
      case 'level':  S.pref.level = b.getAttribute('data-v'); renderLobby(); break;
      case 'chip': {
        var inp = $('l-bet') || $('r-bet');
        if (inp) inp.value = b.getAttribute('data-v');
        break;
      }
      case 'create': createRoom(); break;
      case 'joincode': joinRoom($('l-code').value, false); break;
      case 'join': joinRoom(b.getAttribute('data-code'), b.getAttribute('data-spec') === '1'); break;
      case 'share': share(S.code); break;
      case 'cancel':
      case 'quit':
        leaveRoom(false).then(function () { renderLobby(); });
        break;
      case 'rematch': rematch(); break;
      case 'ttt': sendMove({ i: parseInt(b.getAttribute('data-i'), 10) }); break;
      case 'pen': sendMove({ dir: b.getAttribute('data-d') }); break;
      case 'sq': onSquare(b.getAttribute('data-sq')); break;
      case 'promo':
        if (S.promo) {
          var d = { from: S.promo.from, to: S.promo.to, promo: b.getAttribute('data-p') };
          S.promo = null; S.sel = null;
          sendMove(d);
          if (S.room) renderRoom(S.room);
        }
        break;
      case 'quiz':
        if (S.room) sendMove({ i: S.room.view.i, o: parseInt(b.getAttribute('data-o'), 10) });
        break;
      case 'rchoice': {
        R.choice = { type: b.getAttribute('data-type'), value: b.getAttribute('data-value') };
        var all = document.querySelectorAll('#r-bets .rb');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('on');
        b.classList.add('on');
        $('r-numrow').style.display = R.choice.type === 'number' ? 'block' : 'none';
        break;
      }
      case 'spin': spin(); break;
    }
  }

  function onBodyInput(e) {
    if (e.target.id === 'l-bet') { var n = parseInt(e.target.value, 10); if (Number.isInteger(n)) S.pref.bet = n; }
  }

  function onBack() {
    if (S.screen === 'room' || S.screen === 'wait') {
      leaveRoom(true).then(function (ok) { if (ok) renderLobby(); });
    } else {
      closeOverlay();
    }
  }

  function onDocClick(e) {
    var card = e.target.closest('.game[data-game]');
    if (card) open(card.getAttribute('data-game'));
  }

  /* ---------- API publique ---------- */

  function open(game) {
    if (!META[game]) return;
    S.game = game; S.code = null; S.room = null; S.leftCode = null;
    openOverlay();
    if (game === 'roulette') renderRoulette(); else renderLobby();
  }

  function loading() {
    S.screen = 'loading'; S.room = null;
    openOverlay(); setTitle(); $('gv-eye').textContent = '';
    body('<p class="hint" style="text-align:center">Connexion à la partie...</p>');
  }

  function join(code, spectate) {
    if (S.code) return;
    S.leftCode = null;
    if (!$('gv').classList.contains('on')) loading();
    return joinRoom(code, spectate);
  }

  function resume(code) {
    if (!code) return;
    S.leftCode = null;
    loading();
    return joinRoom(code, false);
  }

  function refreshMe() {
    var els = document.querySelectorAll('#gv [data-solde]');
    for (var i = 0; i < els.length; i++) els[i].textContent = 'Solde ' + coinsNow();
  }

  function init(c) {
    ctx = c;
    c.socket.on('room:state', onState);
    c.socket.on('room:closed', onClosed);
    document.addEventListener('click', onDocClick);
    $('gv-body').addEventListener('click', onBodyClick);
    $('gv-body').addEventListener('input', onBodyInput);
    $('gv-back').addEventListener('click', onBack);
  }

  window.Games = { init: init, open: open, join: join, resume: resume, refreshMe: refreshMe };
})();
