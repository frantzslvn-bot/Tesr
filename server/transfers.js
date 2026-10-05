'use strict';
// Envoi de Coins entre membres, dons / retraits de l'admin, gestion des cadeaux depuis l'admin.
// Ce module s'ajoute à socket.js sans le modifier : il écoute les mêmes connexions et lit
// socket.data.pid (compte) et socket.data.owner (créateur entré avec le code), remplis par socket.js.
//
// Client -> serveur
//   coins:send {to, amount}                 envoi d'un membre à un autre
//   admin:give {id, amount}                 don (amount > 0) ou retrait (amount < 0), créateur ou admin
//   admin:ledger {}                         journal des envois et dons
//   admin:gifts {}                          cadeaux + bonus du jour
//   admin:gift:save {id?, name, cost}       ajoute (sans id) ou modifie un cadeau
//   admin:gift:remove {id}                  retire un cadeau
//   admin:daily {amount}                    change le bonus du jour
// Serveur -> client : me (solde mis à jour), coins:received {from, amount}, shop:update {shop, dailyBonus}
const cfg = require('./config');
const coins = require('./coins');
const shop = require('./shop');

function reply(ack, obj) { if (typeof ack === 'function') ack(obj); }

function attach(io) {
  const lastSend = new Map();   // pid -> horodatage du dernier envoi (anti-rafale)

  // Tous les appareils connectés d'un compte
  function socketsOf(pid) {
    const out = [];
    for (const s of io.sockets.sockets.values()) if (s.data && s.data.pid === pid) out.push(s);
    return out;
  }
  function pushMe(pid) {
    const p = coins.get(pid);
    if (!p) return;
    for (const s of socketsOf(pid)) s.emit('me', coins.pub(p));
  }
  function emitAdmins(ev, data) {
    for (const s of io.sockets.sockets.values()) {
      const sp = s.data && coins.get(s.data.pid);
      if ((s.data && s.data.owner) || (sp && sp.admin && !sp.banned)) s.emit(ev, data);
    }
  }

  io.on('connection', socket => {
    function on(ev, fn) {
      socket.on(ev, (a, b) => {
        const data = typeof a === 'function' ? {} : (a && typeof a === 'object' ? a : {});
        const ack = typeof a === 'function' ? a : b;
        try { fn(data, ack); } catch (e) { console.error(ev, e); reply(ack, { error: 'Erreur du serveur' }); }
      });
    }
    function authed(ev, fn) {
      on(ev, (data, ack) => {
        const p = coins.get(socket.data.pid);
        if (!p) return reply(ack, { error: 'Session expirée, recharge la page' });
        if (p.banned) return reply(ack, { error: 'Compte bloqué' });
        fn(p, data, ack);
      });
    }
    // 'owner' (créateur avec le code), 'admin' (compte nommé) ou null
    function level() {
      if (socket.data.owner) return 'owner';
      const p = coins.get(socket.data.pid);
      return p && p.admin && !p.banned ? 'admin' : null;
    }
    function staff(ev, fn) {
      on(ev, (data, ack) => {
        const lv = level();
        if (!lv) return reply(ack, { error: 'Accès refusé' });
        fn(lv, data, ack);
      });
    }

    /* ----- Envoi entre membres ----- */

    authed('coins:send', (p, data, ack) => {
      const T = cfg.TRANSFER, now = Date.now();
      if (now - (lastSend.get(p.id) || 0) < T.GAP_MS) return reply(ack, { error: 'Doucement : patiente quelques secondes' });
      const to = String(data.to || '');
      const r = coins.transfer(p.id, to, data.amount, { min: T.MIN, max: T.MAX, dayMax: T.DAY_MAX });
      if (r.error) return reply(ack, r);
      lastSend.set(p.id, now);
      pushMe(p.id); pushMe(to);
      for (const s of socketsOf(to)) s.emit('coins:received', { from: p.name, amount: data.amount });
      reply(ack, { ok: true, coins: r.coins });
    });

    /* ----- Dons et retraits (créateur sans limite, admin plafonné) ----- */

    staff('admin:give', (lv, data, ack) => {
      const id = String(data.id || ''), amount = data.amount;
      if (!Number.isInteger(amount) || amount === 0) return reply(ack, { error: 'Montant invalide' });
      if (lv !== 'owner') {
        if (Math.abs(amount) > cfg.GIVE.ADMIN_MAX) return reply(ack, { error: 'Un admin peut donner au plus ' + cfg.GIVE.ADMIN_MAX + ' Coins à la fois' });
        if (id === socket.data.pid) return reply(ack, { error: 'Un admin ne peut pas se donner des Coins' });
        const t = coins.get(id);
        if (t && t.admin) return reply(ack, { error: 'Réservé au créateur' });
      }
      const r = coins.adjust(id, amount, lv, socket.data.pid);
      if (r.error) return reply(ack, r);
      pushMe(id);
      for (const s of socketsOf(id)) s.emit('coins:received', { from: 'Dracula System', amount: r.applied });
      emitAdmins('admin:ledger', r.rec);
      reply(ack, { ok: true, coins: r.coins, applied: r.applied });
    });

    staff('admin:ledger', (lv, data, ack) => reply(ack, { ok: true, list: coins.listLedger(60) }));

    /* ----- Cadeaux et bonus du jour ----- */

    function shopChanged(r, ack) {
      if (r.error) return reply(ack, r);
      io.emit('shop:update', { shop: r.shop, dailyBonus: r.dailyBonus });
      reply(ack, r);
    }
    staff('admin:gifts', (lv, data, ack) => reply(ack, Object.assign({ ok: true }, shop.view())));
    staff('admin:gift:save', (lv, data, ack) => shopChanged(shop.saveGift({ id: data.id, name: data.name, cost: data.cost }), ack));
    staff('admin:gift:remove', (lv, data, ack) => shopChanged(shop.remove(data.id), ack));
    staff('admin:daily', (lv, data, ack) => shopChanged(shop.setDaily(data.amount), ack));
  });
}

module.exports = { attach };
