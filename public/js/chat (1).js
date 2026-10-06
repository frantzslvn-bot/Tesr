/* Dracula System : interface de la messagerie (discussions privées et groupes).
   Tout est décidé par le serveur ; ici on affiche et on envoie des demandes.
   Chargé par index.html : Chat.init({ socket, say, esc, linkify, compress, token, getMe }). */
var Chat = (function () {
  'use strict';

  var U = null;                       // outils fournis par index.html
  var S = { convs: [], unread: 0, cur: null, mode: 'dm', picked: {}, users: [], sending: false };
  var E = {};                         // éléments de la page
  var CAM = '<svg class="ico" viewBox="0 0 24 24"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  var typingTimer = null, listTimer = null, userTimer = null, lastTypingEmit = 0, ready = false;

  function $(id) { return document.getElementById(id); }
  function me() { return (U && U.getMe()) || {}; }
  function say(t, bad) { U.say(t, bad); }
  function esc(s) { return U.esc(s); }
  function initial(n) { return esc(String(n || '?').charAt(0).toUpperCase()); }
  function avCls(id, group) {
    if (group) return 'g';
    var h = 0, i; id = String(id || '');
    for (i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % 3;
    return ['', 'b', 'c'][h];
  }
  function whoCls(id) { var h = 0, i; id = String(id || ''); for (i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % 4; return 'h' + h; }
  function hm(ts) { return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(ts) {
    var now = Date.now();
    if (dayKey(ts) === dayKey(now)) return 'Aujourd\'hui';
    if (dayKey(ts) === dayKey(now - 86400000)) return 'Hier';
    return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  }
  function shortTime(ts) {
    var now = Date.now();
    if (dayKey(ts) === dayKey(now)) return hm(ts);
    if (dayKey(ts) === dayKey(now - 86400000)) return 'Hier';
    return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }

  /* ---------- Page : liste + écrans ---------- */

  function build() {
    $('v-msg').innerHTML =
      '<div class="ch-top"><h2>Messages</h2><button class="btn" id="ch-new">+ Nouveau</button></div>' +
      '<div class="ch-list" id="ch-list"><p class="empty">Chargement...</p></div>';

    var host = $('pv').parentNode;
    host.insertAdjacentHTML('beforeend',
      // conversation
      '<div class="overlay" id="cv">' +
        '<header><button class="back" id="cv-back" aria-label="Retour">‹</button>' +
        '<button class="ch-title" id="cv-title"><div class="ch-av" id="cv-av" style="width:36px;height:36px"></div>' +
        '<div class="ch-t1"><b id="cv-name"></b><small id="cv-sub"></small></div></button></header>' +
        '<div class="ch-msgs" id="cv-msgs"></div>' +
        '<div class="ch-typing" id="cv-typing"></div>' +
        '<div class="ch-comp"><button class="btn ghost" id="cv-photo" aria-label="Envoyer une photo">' + CAM + '</button>' +
        '<textarea id="cv-text" rows="1" maxlength="1000" placeholder="Écrire un message..." aria-label="Message"></textarea>' +
        '<button class="btn" id="cv-send">Envoyer</button>' +
        '<input type="file" id="cv-file" accept="image/*" hidden></div>' +
        '<div class="ch-lock" id="cv-lock"></div>' +
      '</div>' +
      // nouvelle discussion / nouveau groupe / ajout de membres
      '<div class="overlay" id="cn">' +
        '<header><button class="back" id="cn-back" aria-label="Retour">‹</button><b class="display" id="cn-title">Nouvelle discussion</b></header>' +
        '<div class="ch-seg" id="cn-seg"><button class="on" data-m="dm">Privé</button><button data-m="grp">Groupe</button></div>' +
        '<div class="ch-pad"><input class="f" id="cn-q" type="search" placeholder="Chercher un pseudo" aria-label="Chercher un membre" autocomplete="off"></div>' +
        '<div class="ch-grp"><input class="f" id="cn-name" maxlength="30" placeholder="Nom du groupe" aria-label="Nom du groupe" autocomplete="off"></div>' +
        '<div class="ch-chips" id="cn-chips"></div>' +
        '<div id="cn-list" style="flex:1;overflow-y:auto;padding:0 16px"></div>' +
        '<div class="ch-foot"><button class="btn" id="cn-go">Créer le groupe</button></div>' +
      '</div>' +
      // infos
      '<div class="overlay" id="cg">' +
        '<header><button class="back" id="cg-back" aria-label="Retour">‹</button><b class="display" id="cg-title">Infos</b></header>' +
        '<div class="ovbody" id="cg-body" style="flex:1;overflow-y:auto;padding:16px"></div>' +
      '</div>' +
      '<div id="ch-lb"><img alt="Photo"></div>');

    E = {
      list: $('ch-list'), cv: $('cv'), msgs: $('cv-msgs'), name: $('cv-name'), sub: $('cv-sub'), av: $('cv-av'),
      typing: $('cv-typing'), text: $('cv-text'), send: $('cv-send'), photo: $('cv-photo'), file: $('cv-file'), lock: $('cv-lock'),
      cn: $('cn'), cnq: $('cn-q'), cnname: $('cn-name'), cnlist: $('cn-list'), cnchips: $('cn-chips'), cngo: $('cn-go'),
      cg: $('cg'), cgbody: $('cg-body'), lb: $('ch-lb')
    };
  }

  /* ---------- Liste des conversations ---------- */

  function setUnread(n) {
    S.unread = Math.max(0, n | 0);
    var b = document.getElementById('nb-msg');
    if (!b) {
      var btn = document.querySelector('nav button[data-v="msg"]');
      if (!btn) return;
      b = document.createElement('span'); b.id = 'nb-msg'; b.className = 'nbadge'; btn.appendChild(b);
    }
    b.textContent = S.unread > 99 ? '99+' : String(S.unread);
    b.classList.toggle('on', S.unread > 0);
  }
  function sumUnread() { var t = 0; S.convs.forEach(function (c) { t += c.unread || 0; }); setUnread(t); }

  function preview(c) {
    var l = c.last;
    if (!l) return 'Aucun message';
    if (l.del) return 'Message supprimé';
    var t = l.img && !l.text ? 'Photo' : l.text;
    if (l.sys) return t;
    if (l.mine) return 'Toi : ' + t;
    return c.type === 'group' && l.name ? l.name + ' : ' + t : t;
  }

  function renderList() {
    if (!S.convs.length) {
      E.list.innerHTML = '<p class="ch-hint">Aucune conversation pour l\'instant.<br>Appuie sur « + Nouveau » pour écrire à un membre ou créer un groupe.</p>';
      return;
    }
    E.list.innerHTML = S.convs.map(function (c) {
      return '<button class="ch-row' + (c.unread ? ' unread' : '') + '" data-id="' + esc(c.id) + '">' +
        '<div class="ch-av ' + avCls(c.other || c.id, c.type === 'group') + '" style="width:46px;height:46px">' + initial(c.name) + '</div>' +
        '<div class="ch-mid"><b>' + esc(c.name) + '</b><small>' + esc(preview(c)) + '</small></div>' +
        '<div class="ch-side"><span>' + esc(shortTime(c.at)) + '</span>' + (c.unread ? '<span class="dot">' + c.unread + '</span>' : '') + '</div></button>';
    }).join('');
  }

  function loadList() {
    U.socket.emit('chat:list', {}, function (r) {
      if (!r || r.error) { E.list.innerHTML = '<p class="empty">' + esc((r && r.error) || 'Erreur') + '</p>'; return; }
      S.convs = r.convs; setUnread(r.unread); renderList();
    });
  }
  function loadListSoon() { clearTimeout(listTimer); listTimer = setTimeout(loadList, 250); }

  function upsert(conv) {
    if (!conv) return;
    var i = -1; S.convs.forEach(function (c, k) { if (c.id === conv.id) i = k; });
    if (i >= 0) S.convs[i] = conv; else S.convs.push(conv);
    S.convs.sort(function (a, b) { return b.at - a.at; });
    renderList(); sumUnread();
  }

  /* ---------- Conversation ---------- */

  function isMod() { return !!S.cur && !!S.cur.conv && (S.cur.conv.role === 'owner' || S.cur.conv.role === 'admin'); }
  function nearBottom() { var m = E.msgs; return m.scrollHeight - m.scrollTop - m.clientHeight < 120; }
  function toBottom() { E.msgs.scrollTop = E.msgs.scrollHeight; }

  function openConv(id) {
    S.cur = { id: id, conv: null, msgs: [], more: false };
    E.msgs.innerHTML = ''; E.name.textContent = 'Chargement...'; E.sub.textContent = ''; E.typing.textContent = '';
    E.text.value = ''; autosize();
    E.cv.classList.add('on'); E.cv.classList.remove('locked');
    U.socket.emit('chat:history', { id: id }, function (r) {
      if (!S.cur || S.cur.id !== id) return;
      if (!r || r.error) { say((r && r.error) || 'Conversation introuvable', true); closeConv(); return; }
      S.cur.conv = r.conv; S.cur.msgs = r.msgs; S.cur.more = r.more;
      renderConv(); toBottom(); markRead();
    });
  }
  function closeConv() {
    S.cur = null; E.cv.classList.remove('on'); E.cg.classList.remove('on'); E.cn.classList.remove('on');
    loadList();
  }
  // Recharge la page la plus récente (nom, droits, membres peuvent avoir changé)
  function reloadCur(done) {
    if (!S.cur) return;
    var id = S.cur.id;
    U.socket.emit('chat:history', { id: id }, function (r) {
      if (!S.cur || S.cur.id !== id) return;
      if (!r || r.error) { closeConv(); return; }
      S.cur.conv = r.conv; S.cur.msgs = r.msgs; S.cur.more = r.more;
      renderConv(); if (done) done();
    });
  }
  function markRead() {
    if (!S.cur) return;
    var id = S.cur.id;
    U.socket.emit('chat:read', { id: id }, function () { });
    S.convs.forEach(function (c) { if (c.id === id) c.unread = 0; });
    renderList(); sumUnread();
  }

  function renderConv() {
    var c = S.cur.conv, group = c.type === 'group';
    E.name.textContent = c.name;
    E.av.className = 'ch-av ' + avCls(c.other || c.id, group);
    E.av.innerHTML = initial(c.name);
    E.sub.textContent = group ? c.members.length + ' membres' : (c.iBlocked ? 'Bloqué' : '');
    E.cv.classList.toggle('locked', !c.canWrite);
    E.lock.textContent = c.iBlocked ? 'Tu as bloqué ce membre. Débloque-le dans les infos pour lui écrire.' : 'Tu ne peux plus écrire à ce membre.';
    renderMsgs();
  }

  function readByOthers(m) {
    var c = S.cur.conv, i;
    for (i = 0; i < c.members.length; i++) {
      var id = c.members[i].id;
      if (id !== me().id && (c.reads[id] || 0) >= m.n) return true;
    }
    return false;
  }

  function msgHtml(m, prev, group) {
    if (m.sys) return '<div class="ch-sys">' + esc(m.text) + '</div>';
    var mine = m.by === me().id;
    var first = !prev || prev.sys || prev.by !== m.by || m.at - prev.at > 5 * 60000;
    var body;
    if (m.del) body = '<span class="ch-del">Message supprimé</span>';
    else {
      body = (m.img ? '<img class="ch-img" src="/img/' + esc(m.img) + '" alt="Photo" loading="lazy" data-full="/img/' + esc(m.img) + '">' : '') +
        (m.text ? '<div class="ch-t">' + U.linkify(m.text) + '</div>' : '');
    }
    var canDel = !m.del && (mine || (group && isMod()));
    return '<div class="ch-m' + (mine ? ' me' : '') + (first ? ' first' : '') + '" data-mid="' + esc(m.id) + '">' +
      '<div class="ch-b">' +
      (group && !mine && first ? '<span class="ch-who ' + whoCls(m.by) + '">' + esc(m.name) + '</span>' : '') +
      body +
      '<div class="ch-time"><span>' + hm(m.at) + '</span>' + (mine && !m.del ? '<span class="ch-tk' + (readByOthers(m) ? ' r' : '') + '">' + (readByOthers(m) ? '✓✓' : '✓') + '</span>' : '') + '</div>' +
      '</div>' +
      (canDel ? '<div class="ch-act"><button data-act="del">Supprimer pour tous</button></div>' : '') +
      '</div>';
  }

  function renderMsgs() {
    if (!S.cur || !S.cur.conv) return;
    var stick = nearBottom() || !E.msgs.children.length;
    var group = S.cur.conv.type === 'group', h = '', prev = null, lastDay = '';
    if (S.cur.more) h += '<button class="ch-older" id="cv-older">Messages plus anciens</button>';
    S.cur.msgs.forEach(function (m) {
      var d = dayKey(m.at);
      if (d !== lastDay) { h += '<div class="ch-day">' + esc(dayLabel(m.at)) + '</div>'; lastDay = d; prev = null; }
      h += msgHtml(m, prev, group); prev = m;
    });
    if (!S.cur.msgs.length) h += '<p class="ch-hint">Aucun message. Dis bonjour !</p>';
    E.msgs.innerHTML = h;
    if (stick) toBottom();
  }

  function loadOlder() {
    if (!S.cur || !S.cur.msgs.length) return;
    var id = S.cur.id, before = S.cur.msgs[0].n, oldH = E.msgs.scrollHeight;
    U.socket.emit('chat:history', { id: id, before: before }, function (r) {
      if (!S.cur || S.cur.id !== id || !r || r.error) return;
      S.cur.msgs = r.msgs.concat(S.cur.msgs); S.cur.more = r.more;
      renderMsgs();
      E.msgs.scrollTop = E.msgs.scrollHeight - oldH;
    });
  }

  function autosize() { E.text.style.height = 'auto'; E.text.style.height = Math.min(110, E.text.scrollHeight) + 'px'; }

  function sendMessage(img) {
    if (!S.cur || S.sending) return;
    var id = S.cur.id, text = E.text.value.trim();
    if (!text && !img) return;
    S.sending = true; E.send.disabled = true;
    U.socket.emit('chat:send', { id: id, text: text, img: img || null }, function (r) {
      S.sending = false; E.send.disabled = false; E.photo.innerHTML = CAM;
      if (!r || r.error) { say((r && r.error) || 'Envoi impossible', true); return; }
      E.text.value = ''; autosize();
      if (S.cur && S.cur.id === id) {
        S.cur.msgs.push(r.msg); renderMsgs(); toBottom();
        S.cur.conv.reads[me().id] = r.msg.n;
      }
      upsert(r.conv);
    });
  }

  function sendPhoto(file) {
    if (!/^image\//.test(file.type)) { say('Photos uniquement.', true); return; }
    E.photo.textContent = '...'; E.send.disabled = true;
    function reset() { E.photo.innerHTML = CAM; E.send.disabled = false; }
    U.compress(file, function (blob) {
      if (!blob) { reset(); say('Image illisible ou trop lourde', true); return; }
      fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Token': U.token() }, body: blob })
        .then(function (res) { return res.json(); })
        .then(function (r) {
          if (!r || r.error) { reset(); say((r && r.error) || 'Envoi impossible', true); return; }
          E.send.disabled = false;
          sendMessage(r.name);
        })
        .catch(function () { reset(); say('Envoi impossible, réessaie.', true); });
    });
  }

  /* ---------- Nouvelle discussion / groupe / ajout de membres ---------- */

  function openNew(mode) {
    S.mode = mode; S.picked = {};
    E.cn.classList.add('on');
    E.cnq.value = ''; E.cnname.value = '';
    setMode(mode);
    loadUsers();
    setTimeout(function () { E.cnq.focus(); }, 60);
  }
  function setMode(mode) {
    S.mode = mode;
    E.cn.classList.toggle('grp', mode === 'grp');
    E.cn.classList.toggle('multi', mode === 'grp' || mode === 'add');
    $('cn-seg').style.display = mode === 'add' ? 'none' : 'flex';
    $('cn-title').textContent = mode === 'add' ? 'Ajouter des membres' : (mode === 'grp' ? 'Nouveau groupe' : 'Nouvelle discussion');
    E.cngo.textContent = mode === 'add' ? 'Ajouter' : 'Créer le groupe';
    Array.prototype.forEach.call($('cn-seg').children, function (b) { b.classList.toggle('on', b.dataset.m === mode); });
    renderChips(); renderUsers();
  }
  function loadUsers() {
    U.socket.emit('chat:users', { q: E.cnq.value }, function (r) {
      if (!r || r.error) { E.cnlist.innerHTML = '<p class="empty">' + esc((r && r.error) || 'Erreur') + '</p>'; return; }
      S.users = r.users; renderUsers();
    });
  }
  function renderUsers() {
    var inGroup = {};
    if (S.mode === 'add' && S.cur && S.cur.conv) S.cur.conv.members.forEach(function (m) { inGroup[m.id] = true; });
    var list = S.users.filter(function (u) { return !inGroup[u.id]; });
    if (!list.length) { E.cnlist.innerHTML = '<p class="ch-hint">Aucun membre trouvé.</p>'; return; }
    var multi = S.mode !== 'dm';
    E.cnlist.innerHTML = list.map(function (u) {
      return '<button class="ch-user' + (S.picked[u.id] ? ' on' : '') + '" data-id="' + esc(u.id) + '">' +
        '<div class="ch-av ' + avCls(u.id) + '" style="width:36px;height:36px">' + initial(u.name) + '</div>' +
        '<span>' + esc(u.name) + (u.blocked ? '<small>bloqué</small>' : '') + '</span>' +
        (multi ? '<span class="tick">' + (S.picked[u.id] ? '✓' : '') + '</span>' : '') + '</button>';
    }).join('');
  }
  function renderChips() {
    var ids = Object.keys(S.picked);
    E.cnchips.innerHTML = ids.map(function (id) {
      return '<span class="ch-chip">' + esc(S.picked[id]) + '<button data-id="' + esc(id) + '" aria-label="Retirer">×</button></span>';
    }).join('');
  }

  function pickUser(id) {
    var u = null; S.users.forEach(function (x) { if (x.id === id) u = x; });
    if (!u) return;
    if (S.mode === 'dm') {
      U.socket.emit('chat:open', { with: id }, function (r) {
        if (!r || r.error) { say((r && r.error) || 'Impossible', true); return; }
        E.cn.classList.remove('on'); openConv(r.id);
      });
      return;
    }
    if (S.picked[id]) delete S.picked[id]; else S.picked[id] = u.name;
    renderChips(); renderUsers();
  }

  function submitNew() {
    var ids = Object.keys(S.picked);
    if (!ids.length) { say('Choisis au moins un membre.', true); return; }
    E.cngo.disabled = true;
    if (S.mode === 'add') {
      U.socket.emit('chat:group:act', { id: S.cur.id, act: 'add', ids: ids }, function (r) {
        E.cngo.disabled = false;
        if (!r || r.error) { say((r && r.error) || 'Erreur', true); return; }
        E.cn.classList.remove('on'); say('Membres ajoutés');
        reloadCur(renderInfo);
      });
      return;
    }
    U.socket.emit('chat:group:create', { name: E.cnname.value, ids: ids }, function (r) {
      E.cngo.disabled = false;
      if (!r || r.error) { say((r && r.error) || 'Erreur', true); return; }
      E.cn.classList.remove('on'); openConv(r.id); loadList();
    });
  }

  /* ---------- Infos du groupe / de la discussion ---------- */

  function openInfo() { if (!S.cur || !S.cur.conv) return; E.cg.classList.add('on'); renderInfo(); }

  function roleTag(r) { return r === 'owner' ? '<small>Créateur</small>' : (r === 'admin' ? '<small>Admin</small>' : ''); }

  function renderInfo() {
    if (!S.cur || !S.cur.conv || !E.cg.classList.contains('on')) return;
    var c = S.cur.conv, group = c.type === 'group', h = '';
    $('cg-title').textContent = group ? 'Infos du groupe' : 'Infos';
    h += '<div class="ch-info"><div class="ch-av ' + avCls(c.other || c.id, group) + '" style="width:72px;height:72px;font-size:28px">' + initial(c.name) + '</div>' +
      '<h2>' + esc(c.name) + '</h2>' +
      (group ? '<p class="note">' + c.members.length + ' membres</p>' : '') + '</div>';

    if (group) {
      if (isMod()) {
        h += '<div class="ch-rename"><input class="f" id="cg-name" maxlength="30" value="' + esc(c.name) + '" aria-label="Nom du groupe"><button class="btn" data-act="rename">OK</button></div>';
      }
      h += '<div class="ch-sec"><h3>Membres</h3>';
      c.members.forEach(function (m) {
        var mineRow = m.id === me().id, btns = '';
        if (!mineRow && isMod() && m.role !== 'owner' && (c.role === 'owner' || m.role === 'member')) {
          btns += '<button class="sm red" data-act="remove" data-id="' + esc(m.id) + '">Retirer</button>';
        }
        if (!mineRow && c.role === 'owner' && m.role !== 'owner') {
          btns += '<button class="sm" data-act="promote" data-id="' + esc(m.id) + '" data-admin="' + (m.role === 'admin' ? '0' : '1') + '">' + (m.role === 'admin' ? 'Retirer admin' : 'Admin') + '</button>';
        }
        h += '<div class="ch-mem"><div class="ch-av ' + avCls(m.id) + '" style="width:32px;height:32px">' + initial(m.name) + '</div>' +
          '<div class="nm">' + esc(m.name) + (mineRow ? ' (toi)' : '') + roleTag(m.role) + '</div><div class="btns">' + btns + '</div></div>';
      });
      h += '</div>';
      if (isMod()) h += '<button class="ch-wide" data-act="add">+ Ajouter des membres</button>';
      h += '<button class="ch-wide ch-danger" data-act="leave">Quitter le groupe</button>';
    } else if (c.other) {
      h += '<button class="ch-wide ' + (c.iBlocked ? '' : 'ch-danger') + '" data-act="block" data-id="' + esc(c.other) + '">' +
        (c.iBlocked ? 'Débloquer ce membre' : 'Bloquer ce membre') + '</button>';
      h += '<p class="ch-hint">Un membre bloqué ne peut plus t\'écrire, et tu ne peux plus lui écrire.</p>';
    }
    E.cgbody.innerHTML = h;
  }

  function infoAction(btn) {
    var act = btn.dataset.act, c = S.cur.conv, id = S.cur.id;
    function done(r, msg) {
      if (!r || r.error) { say((r && r.error) || 'Erreur', true); return; }
      if (msg) say(msg);
      reloadCur(renderInfo); loadListSoon();
    }
    if (act === 'rename') {
      U.socket.emit('chat:group:act', { id: id, act: 'rename', name: $('cg-name').value }, function (r) { done(r, 'Nom modifié'); });
    } else if (act === 'add') {
      openNew('add');
    } else if (act === 'remove') {
      if (!window.confirm('Retirer ce membre du groupe ?')) return;
      U.socket.emit('chat:group:act', { id: id, act: 'remove', memberId: btn.dataset.id }, function (r) { done(r, 'Membre retiré'); });
    } else if (act === 'promote') {
      U.socket.emit('chat:group:act', { id: id, act: 'promote', memberId: btn.dataset.id, admin: btn.dataset.admin === '1' }, function (r) { done(r); });
    } else if (act === 'leave') {
      if (!window.confirm('Quitter ce groupe ?')) return;
      U.socket.emit('chat:leave', { id: id }, function (r) {
        if (!r || r.error) { say((r && r.error) || 'Erreur', true); return; }
        closeConv();
      });
    } else if (act === 'block') {
      var wasBlocked = c.iBlocked;
      if (!wasBlocked && !window.confirm('Bloquer ce membre ?')) return;
      U.socket.emit('chat:block', { id: btn.dataset.id }, function (r) { done(r, wasBlocked ? 'Membre débloqué' : 'Membre bloqué'); });
    }
  }

  /* ---------- Événements reçus du serveur ---------- */

  function bindSocket() {
    var s = U.socket;
    s.on('chat:msg', function (ev) {
      if (!ev || !ev.msg) return;
      var open = S.cur && S.cur.id === ev.id, mine = ev.msg.by === me().id;
      if (open) {
        var dup = S.cur.msgs.some(function (m) { return m.id === ev.msg.id; });
        if (!dup) S.cur.msgs.push(ev.msg);
        if (ev.conv) ev.conv.unread = 0;
        renderMsgs();
        if (!mine) markRead();
      } else if (!mine) {
        say('Message de ' + (ev.msg.name || 'un membre') + (ev.conv && ev.conv.type === 'group' ? ' (' + ev.conv.name + ')' : ''));
      }
      upsert(ev.conv);
    });
    s.on('chat:read', function (ev) {
      if (!ev || !S.cur || S.cur.id !== ev.id || !S.cur.conv) return;
      S.cur.conv.reads[ev.pid] = ev.n; renderMsgs();
    });
    s.on('chat:typing', function (ev) {
      if (!ev || !S.cur || S.cur.id !== ev.id) return;
      E.typing.textContent = (ev.name || 'Un membre') + ' écrit...';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(function () { E.typing.textContent = ''; }, 3500);
    });
    s.on('chat:del', function (ev) {
      if (!ev) return;
      if (S.cur && S.cur.id === ev.id) {
        S.cur.msgs.forEach(function (m) { if (m.id === ev.mid) { m.del = true; m.text = ''; m.img = null; } });
        renderMsgs();
      }
      loadListSoon();
    });
    s.on('chat:conv', function (ev) {
      ev = ev || {};
      if (S.cur && ev.removed === me().id && ev.id === S.cur.id) { say('Tu n\'es plus dans cette conversation.', true); closeConv(); return; }
      loadListSoon();
      if (S.cur && (ev.id === null || ev.id === S.cur.id)) reloadCur(renderInfo);
    });
  }

  function bindDom() {
    $('ch-new').addEventListener('click', function () { openNew('dm'); });
    E.list.addEventListener('click', function (e) {
      var b = e.target.closest('.ch-row'); if (b) openConv(b.dataset.id);
    });

    $('cv-back').addEventListener('click', closeConv);
    $('cv-title').addEventListener('click', openInfo);
    E.msgs.addEventListener('click', function (e) {
      if (e.target.id === 'cv-older') { loadOlder(); return; }
      var img = e.target.closest('.ch-img');
      if (img) { E.lb.querySelector('img').src = img.dataset.full; E.lb.classList.add('on'); return; }
      var del = e.target.closest('[data-act="del"]');
      if (del) {
        var mid = del.closest('.ch-m').dataset.mid, id = S.cur.id;
        if (!window.confirm('Supprimer ce message pour tout le monde ?')) return;
        U.socket.emit('chat:delete', { id: id, mid: mid }, function (r) {
          if (!r || r.error) say((r && r.error) || 'Erreur', true);
        });
        return;
      }
      var bubble = e.target.closest('.ch-b');
      if (bubble) {
        var m = bubble.parentNode, was = m.classList.contains('sel');
        Array.prototype.forEach.call(E.msgs.querySelectorAll('.ch-m.sel'), function (x) { x.classList.remove('sel'); });
        if (!was) m.classList.add('sel');
      }
    });
    E.msgs.addEventListener('error', function (e) {
      var el = e.target;
      if (el && el.tagName === 'IMG') { var d = document.createElement('span'); d.className = 'ch-imgbad'; d.textContent = 'Photo indisponible'; el.replaceWith(d); }
    }, true);
    E.lb.addEventListener('click', function () { E.lb.classList.remove('on'); });

    E.send.addEventListener('click', function () { sendMessage(null); });
    E.text.addEventListener('keydown', function (e) {
      var touch = 'ontouchstart' in window;
      if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); sendMessage(null); }
    });
    E.text.addEventListener('input', function () {
      autosize();
      var now = Date.now();
      if (S.cur && now - lastTypingEmit > 2000) { lastTypingEmit = now; U.socket.emit('chat:typing', { id: S.cur.id }, function () { }); }
    });
    E.photo.addEventListener('click', function () { E.file.click(); });
    E.file.addEventListener('change', function () {
      var f = E.file.files && E.file.files[0]; E.file.value = '';
      if (f) sendPhoto(f);
    });

    $('cn-back').addEventListener('click', function () { E.cn.classList.remove('on'); });
    $('cn-seg').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      S.picked = {}; setMode(b.dataset.m);
    });
    E.cnq.addEventListener('input', function () { clearTimeout(userTimer); userTimer = setTimeout(loadUsers, 250); });
    E.cnlist.addEventListener('click', function (e) { var b = e.target.closest('.ch-user'); if (b) pickUser(b.dataset.id); });
    E.cnchips.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      delete S.picked[b.dataset.id]; renderChips(); renderUsers();
    });
    E.cngo.addEventListener('click', submitNew);

    $('cg-back').addEventListener('click', function () { E.cg.classList.remove('on'); });
    E.cgbody.addEventListener('click', function (e) { var b = e.target.closest('button[data-act]'); if (b) infoAction(b); });
  }

  /* ---------- API publique ---------- */

  function init(opts) {
    if (ready) { loadList(); return; }       // reconnexion : on rafraîchit seulement
    U = opts; ready = true;
    build(); bindDom(); bindSocket(); loadList();
  }
  function show() { if (ready) loadList(); }
  // Depuis un profil : ouvre (ou crée) la discussion avec ce membre
  function openWith(userId) {
    if (!ready) return;
    U.socket.emit('chat:open', { with: userId }, function (r) {
      if (!r || r.error) { say((r && r.error) || 'Impossible', true); return; }
      var btn = document.querySelector('nav button[data-v="msg"]'); if (btn) btn.click();
      openConv(r.id);
    });
  }

  return { init: init, show: show, setUnread: setUnread, openWith: openWith };
})();
