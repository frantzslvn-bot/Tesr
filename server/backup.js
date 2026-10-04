'use strict';
// Sauvegarde des comptes et des Coins dans un dépôt GitHub PRIVÉ (API "contents").
//  - au démarrage : si le fichier local manque (Render gratuit), on le récupère sur GitHub ;
//  - ensuite : toutes les BACKUP_INTERVAL_MIN minutes (3 par défaut), on envoie les
//    fichiers qui ont changé ; un dernier envoi est fait quand Render arrête le service.
// Variables : GITHUB_TOKEN, BACKUP_REPO ("compte/depot"), BACKUP_BRANCH (main),
//             BACKUP_INTERVAL_MIN (3). Sans token ni dépôt, le module ne fait rien.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.BACKUP_REPO || '';
const BRANCH = process.env.BACKUP_BRANCH || 'main';
const API = process.env.GITHUB_API || 'https://api.github.com';
const EVERY_MIN = Math.max(1, parseInt(process.env.BACKUP_INTERVAL_MIN, 10) || 3);
const enabled = !!(TOKEN && REPO);

const DIR = path.dirname(cfg.DATA_FILE);
const FILES = [path.basename(cfg.DATA_FILE), 'posts.json', 'purchases.log'];
const imgQueue = new Set();   // images (img/xxx.jpg) à envoyer sur GitHub

const shas = {};        // nom -> sha du fichier sur GitHub (requis pour le mettre à jour)
const lastHash = {};    // nom -> empreinte du dernier contenu envoyé / reçu
let canPush = false;    // faux tant que la restauration n'a pas réussi (évite d'écraser la sauvegarde)
let running = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hash(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function gh(method, name, body, accept) {
  let url = API + '/repos/' + REPO + '/contents/' + name.split('/').map(encodeURIComponent).join('/');
  if (method === 'GET') url += '?ref=' + encodeURIComponent(BRANCH);
  return fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dracula-system-backup',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
}

// Lit un fichier sur GitHub. Retourne null s'il n'existe pas encore.
async function pull(name) {
  const res = await gh('GET', name);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = new Error('GitHub ' + res.status);
    err.fatal = res.status === 401 || res.status === 403;   // token refusé : inutile de réessayer
    throw err;
  }
  const j = await res.json();
  let buf;
  if (j.content) buf = Buffer.from(j.content, 'base64');
  else {                                   // fichier > 1 Mo : il faut demander le contenu brut
    const r2 = await gh('GET', name, null, 'application/vnd.github.raw+json');
    if (!r2.ok) throw new Error('GitHub ' + r2.status);
    buf = Buffer.from(await r2.arrayBuffer());
  }
  return { sha: j.sha, buf };
}

async function restore() {
  if (!enabled) {
    console.warn('Sauvegarde GitHub désactivée (GITHUB_TOKEN ou BACKUP_REPO absent).');
    return;
  }
  let failed = false;
  for (const name of FILES) {
    const file = path.join(DIR, name);
    let r = null, ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      try { r = await pull(name); ok = true; }
      catch (e) {
        console.error('Restauration de ' + name + ' impossible :', e.message);
        if (e.fatal) break;
        await sleep(1500 * (i + 1));
      }
    }
    if (!ok) { failed = true; continue; }
    if (!r) continue;                      // première fois : rien à restaurer
    shas[name] = r.sha;
    lastHash[name] = hash(r.buf);
    if (!fs.existsSync(file)) {            // le fichier local, s'il existe, reste prioritaire
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(file, r.buf);
      console.log('Restauré depuis GitHub : ' + name);
    }
  }
  canPush = !failed;
  if (failed) console.error('Restauration incomplète : les envois vers GitHub sont suspendus jusqu\'au prochain redémarrage.');
}

async function push(name) {
  let buf;
  try { buf = fs.readFileSync(path.join(DIR, name)); } catch (e) { return; }
  if (!buf.length) return;
  const h = hash(buf);
  if (lastHash[name] === h) return;        // rien n'a changé
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      message: 'sauvegarde ' + new Date().toISOString(),
      content: buf.toString('base64'),
      branch: BRANCH
    };
    if (shas[name]) body.sha = shas[name];
    const res = await gh('PUT', name, body);
    if (res.ok) {
      const j = await res.json();
      shas[name] = j.content.sha;
      lastHash[name] = h;
      return;
    }
    if (res.status === 409 || res.status === 422) {   // sha périmé : on le relit et on réessaie
      const r = await pull(name).catch(() => null);
      shas[name] = r ? r.sha : undefined;
      continue;
    }
    throw new Error('GitHub ' + res.status);
  }
  throw new Error('conflit persistant');
}

async function pushImage(rel) {
  let buf;
  try { buf = fs.readFileSync(path.join(DIR, rel)); } catch (e) { imgQueue.delete(rel); return; }
  const res = await gh('PUT', rel, { message: 'image ' + rel, content: buf.toString('base64'), branch: BRANCH });
  if (res.ok || res.status === 422) { imgQueue.delete(rel); return; }   // 422 : déjà présente
  if (res.status === 401 || res.status === 403) throw new Error('GitHub ' + res.status);
  throw new Error('GitHub ' + res.status);
}

function pushAll() {
  if (!enabled) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    if (canPush) {
      for (const name of FILES) {
        try { await push(name); }
        catch (e) { console.error('Sauvegarde GitHub échouée (' + name + ') :', e.message); }
      }
    }
    for (const rel of Array.from(imgQueue)) {
      try { await pushImage(rel); }
      catch (e) { console.error('Sauvegarde GitHub échouée (' + rel + ') :', e.message); }
    }
  })().finally(() => {
    running = null;
    if (imgQueue.size) setTimeout(pushAll, 30000).unref();   // on réessaie les images en échec
  });
  return running;
}

// Une nouvelle image vient d'être publiée : envoi sur GitHub dès que possible
function queueImage(name) {
  if (!enabled) return;
  imgQueue.add('img/' + name);
  setTimeout(pushAll, 500).unref();
}

// Image absente du disque (Render a redémarré) : on la relit depuis GitHub
async function fetchImage(name) {
  if (!enabled) return null;
  try { const r = await pull('img/' + name); return r ? r.buf : null; }
  catch (e) { return null; }
}

// Publication supprimée : on retire aussi l'image du dépôt (au mieux)
async function deleteImage(name) {
  const rel = 'img/' + name;
  imgQueue.delete(rel);
  if (!enabled) return;
  try {
    const r = await pull(rel);
    if (!r) return;
    await gh('DELETE', rel, { message: 'suppression ' + rel, sha: r.sha, branch: BRANCH });
  } catch (e) { console.error('Suppression sur GitHub impossible (' + rel + ') :', e.message); }
}

function start() {
  if (!enabled) return;
  const t = setInterval(pushAll, EVERY_MIN * 60 * 1000);
  t.unref();
  console.log('Sauvegarde GitHub active : ' + REPO + ' (toutes les ' + EVERY_MIN + ' min)');
}

// Dernier envoi avant l'arrêt (Render laisse environ 30 s après SIGTERM)
async function final() {
  await Promise.race([pushAll(), sleep(10000)]);
}

module.exports = { enabled, restore, start, pushAll, final, queueImage, fetchImage, deleteImage };
