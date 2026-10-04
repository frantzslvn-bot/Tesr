# Dracula System

Site de groupe : Coins, jeux multijoueurs, boutique, espace admin.

## Lancer en local
    npm install
    cp .env.example .env     # puis choisis un ADMIN_CODE long
    npm start                # http://localhost:3000
    npm test                 # 51 tests, sans réseau

(Charge le .env avec `node --env-file=.env server/index.js` ou définis les variables à la main.)

## Mettre en ligne sur Render
1. Crée un dépôt GitHub PRIVÉ vide pour les sauvegardes (ex : dracula-backup).
2. Crée un jeton GitHub (fine-grained) avec accès « Contents : lecture et écriture » à ce dépôt seulement.
3. Sur Render : New > Blueprint (render.yaml). Renseigne ADMIN_CODE, GITHUB_TOKEN, BACKUP_REPO.
4. Accès admin : 3 appuis rapides sur le logo, puis le code.

## Structure
    server/   index.js, socket.js, coins.js, posts.js (fil), backup.js, config.js, games/
    public/   index.html, legal.html, css/games.css, js/games.js
    test/     logic.test.js

## Le fil de publications
- Texte (500 caractères) + une photo facultative. Pas de vidéo ni de document : on colle un lien.
- La photo est réduite en JPEG (1080 px, moins de 700 Ko) par le navigateur, envoyée sur /api/upload,
  puis sauvegardée dans le dépôt GitHub de sauvegarde (dossier img/). Une photo absente du disque
  (Render a redémarré) est relue depuis GitHub à la demande.
- Likes, commentaires, abonnements, profils, signalements (onglet « Signalés » de l'admin).
- Garde un oeil sur la taille du dépôt de sauvegarde : GitHub recommande moins de 1 Go
  (environ 6000 photos). Au besoin, supprime les anciennes publications depuis l'admin.
