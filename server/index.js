'use strict';
// Point d'entrée : Express sert le site, Socket.io gère les jeux et les comptes.
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const cfg = require('./config');
const backup = require('./backup');
const notify = require('./notify');

const PUBLIC = path.join(__dirname, '..', 'public');

async function main() {
  // IMPORTANT : on restaure db.json depuis GitHub AVANT de charger coins.js
  // (coins.js lit le fichier dès qu'il est chargé).
  await backup.restore();
  const coins = require('./coins');
  const posts = require('./posts');
  const messages = require('./messages');
  const shop = require('./shop');
  const transfers = require('./transfers');
  const creator = require('./creator');
  creator.load();   // compte créateur, abonnement auto, publications à la une (settings.json)
  shop.load();   // cadeaux et bonus du jour réglés depuis l'admin (après la restauration GitHub)
  const { attach } = require('./socket');

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Utilisé par Render pour savoir si le service répond
  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  // Envoi d'une photo : le navigateur la réduit en JPEG (1080 px max) puis l'envoie ici.
  app.post('/api/upload', express.raw({ type: 'image/jpeg', limit: posts.MAX_IMG_BYTES + 1024 }), (req, res) => {
    const p = coins.byToken(String(req.get('x-token') || ''));
    if (!p) return res.status(401).json({ error: 'Session expirée, recharge la page' });
    const r = posts.saveImage(p.id, req.body);
    res.status(r.error ? 400 : 200).json(r);
  });
  app.use((err, req, res, next) => {          // photo trop lourde ou illisible
    if (req.path === '/api/upload') return res.status(413).json({ error: 'Image trop lourde (700 Ko maximum).' });
    next(err);
  });

  // Affichage d'une photo : sur le disque, sinon relue depuis la sauvegarde GitHub (Render a redémarré)
  app.get('/img/:name', async (req, res) => {
    const name = req.params.name;
    if (!posts.IMG_NAME.test(name)) return res.sendStatus(404);
    const file = posts.imgPath(name);
    if (!fs.existsSync(file)) {
      const buf = await backup.fetchImage(name);
      if (!buf || !posts.isJpeg(buf)) return res.sendStatus(404);
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); } catch (e) { /* cache impossible */ }
    }
    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    res.sendFile(file, err => { if (err && !res.headersSent) res.sendStatus(404); });
  });

  app.use(express.static(PUBLIC, { maxAge: '5m' }));

  // Lien d'invitation : https://site/m/ABCD ouvre le site, l'interface rejoint la salle ABCD
  app.get('/m/:code', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 1e5,   // 100 Ko : aucun message du site n'a besoin de plus
    pingInterval: 20000,
    pingTimeout: 25000
  });
  attach(io);
  transfers.attach(io);   // envoi de Coins, dons, cadeaux
  creator.attach(io);     // compte créateur, « À la une », recherche de membres

  server.listen(cfg.PORT, () => {
    console.log('Dracula System sur le port ' + cfg.PORT);
    if (!cfg.ADMIN_CODE) console.warn('ADMIN_CODE est vide : l\'espace admin est désactivé.');
    backup.start();
    notify.warnIfMissing();   // dit dans les logs si Telegram / e-mail ne sont pas configurés
  });

  // Render envoie SIGTERM à chaque redémarrage : on sauvegarde avant de partir.
  let stopping = false;
  async function bye() {
    if (stopping) return;
    stopping = true;
    try { coins.flushNow(); posts.flushNow(); messages.flushNow(); shop.flushNow(); creator.flushNow(); } catch (e) { /* rien à faire */ }
    try { await backup.final(); } catch (e) { console.error('Dernière sauvegarde échouée :', e.message); }
    process.exit(0);
  }
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

main().catch(e => { console.error('Démarrage impossible :', e); process.exit(1); });
