# Dracula System

Site de groupe : Coins, jeux multijoueurs, messagerie, boutique, espace admin.

## Lancer en local
    npm install
    cp .env.example .env     # puis choisis un ADMIN_CODE long
    npm start                # http://localhost:3000
    npm test                 # 115 tests (64 + 51), sans réseau

(Charge le .env avec `node --env-file=.env server/index.js` ou définis les variables à la main.)

## Mettre en ligne sur Render
1. Crée un dépôt GitHub PRIVÉ vide pour les sauvegardes (ex : dracula-backup).
2. Crée un jeton GitHub (fine-grained) avec accès « Contents : lecture et écriture » à ce dépôt seulement.
3. Sur Render : New > Blueprint (render.yaml). Renseigne ADMIN_CODE, GITHUB_TOKEN, BACKUP_REPO.
4. Facultatif : TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID et/ou RESEND_API_KEY + NOTIFY_EMAIL_TO pour être prévenu à chaque achat.
5. Accès admin : 3 appuis rapides sur le logo, puis le code.

## Structure
    server/   index.js, socket.js, coins.js, posts.js (fil), messages.js (messagerie), shop.js (cadeaux),
              transfers.js (envois de Coins, dons, cadeaux), notify.js (alertes), backup.js, config.js, games/
    public/   index.html, legal.html, css/games.css, css/chat.css, js/games.js, js/chat.js
    test/     logic.test.js (jeux, comptes, fil), chat.test.js (messagerie, alertes, envois, dons, cadeaux)

## Sauvegardes
Render gratuit efface le disque à chaque redémarrage. Ces fichiers sont donc envoyés toutes les 3 minutes
(et à l'arrêt) dans le dépôt GitHub privé : db.json (comptes, Coins, achats, journal des Coins),
posts.json, messages.json, shop.json (cadeaux et bonus du jour), purchases.log, et les photos (dossier img/).
Le dépôt doit rester PRIVÉ : db.json contient les jetons de connexion des joueurs.

## Le fil de publications
- Texte (500 caractères) + une photo facultative. Pas de vidéo ni de document : on colle un lien.
- La photo est réduite en JPEG (1080 px, moins de 700 Ko) par le navigateur, envoyée sur /api/upload,
  puis sauvegardée dans le dépôt GitHub de sauvegarde (dossier img/). Une photo absente du disque
  (Render a redémarré) est relue depuis GitHub à la demande.
- Likes, commentaires, abonnements, profils, signalements (onglet « Signalés » de l'admin).
- Garde un oeil sur la taille du dépôt de sauvegarde : GitHub recommande moins de 1 Go
  (environ 6000 photos). Au besoin, supprime les anciennes publications depuis l'admin.

## La messagerie
- Discussions privées et groupes (50 membres au plus), photos, non-lus, « écrit... », lu / non lu.
- Un membre supprime ses messages pour tout le monde ; les admins d'un groupe suppriment ceux des autres.
- Chaque membre peut en bloquer un autre. Le créateur et les admins du site ne lisent PAS les messages privés :
  ils peuvent seulement bloquer ou supprimer un compte (ses messages sont alors effacés).
- Limites anti-spam dans config.js (CHAT) ; le délai entre deux messages se règle avec CHAT_MIN_GAP_MS.

## Les Coins : envois, dons, cadeaux
Tout est vérifié et calculé par le serveur.
- Envoi entre membres (`coins:send {to, amount}`) : 5 Coins minimum, 1000 au plus par envoi, 2000 par jour et
  par membre, 2 secondes entre deux envois (réglages `TRANSFER` de config.js). Le débit et le crédit se font ensemble.
- Dons et retraits (`admin:give {id, amount}`, montant négatif = retrait) : le créateur (code admin) n'a aucune limite
  et peut se donner des Coins à lui-même, à un admin ou à un membre ; un admin nommé est limité à 1000 Coins par
  opération (`GIVE.ADMIN_MAX`), ne peut ni se donner des Coins ni en donner à un autre admin. Un retrait ne descend jamais sous 0.
- Journal : `admin:ledger` renvoie les 60 dernières opérations (500 gardées, dans db.json).
- Cadeaux et bonus du jour : le créateur et les admins les modifient sans toucher au code
  (`admin:gifts`, `admin:gift:save {id?, name, cost}`, `admin:gift:remove {id}`, `admin:daily {amount}`).
  Les réglages sont dans shop.json ; les valeurs de départ viennent de config.js (SHOP et DAILY_BONUS).
- Les Coins ne doivent JAMAIS s'acheter avec de l'argent : sinon la roulette devient un jeu d'argent.

## Les achats
- Chaque achat est enregistré (statut « à livrer ») ; le créateur est prévenu par Telegram et e-mail si les
  variables sont renseignées. L'admin a un bouton « Livré » par achat.

## Où les trouver dans l'interface
- Envoyer des Coins : ouvre le profil d'un membre, saisis un montant puis « Envoyer des Coins ».
- Admin > Recharge : donner ou retirer des Coins à un compte, et le journal des opérations.
- Admin > Cadeaux : ajouter, modifier ou retirer un cadeau, et régler le bonus du jour.
  La boutique de tous les membres se met à jour tout de suite (`shop:update`).
