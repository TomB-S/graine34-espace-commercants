# Notification de paiement pour le caissier (mission 2B)

Petit serveur web qui affiche au caissier, sur la page `/caisse`, les **paiements
reçus** en monnaie locale (La Graine 34) comme un petit ticket : payeur, montant,
heure, description. Il écoute les notifications du logiciel
[Cyclos](https://www.cyclos.org/) avec un compte d'écoute. Un petit script
(`/caisse.js`) relit les paiements toutes les 3 secondes et met l'affichage à jour
**sans recharger la page** ; sans JavaScript, la page reste complète et se recharge
seule toutes les 5 secondes.

**C'est la mission 2B, indépendante de la mission 2A.** La mission 2A est l'outil
de relevé de caisse (ticket de fin de service, PDF), dans le dossier
`releves-caisse/prod`, qui garde le port 3000 et son propre dépôt. Cette application est
autonome : elle a son dépôt, son `package.json` et ses tests, et ne dépend de rien
de 2A à l'exécution. Le code commun (connexion, sessions, en-têtes de sécurité,
`escapeHtml`, `formatAmount`, charte graphique, faux Cyclos de test) y a été
**copié**, pas partagé : une correction faite d'un côté n'est pas reportée toute
seule de l'autre. Pas de relevé, pas de PDF, pas de `pdfkit` ici.

L'outil ne fait que lire : il ne modifie rien dans Cyclos et ne garde aucune
donnée sur disque.

## Prérequis

- Node.js 22.9 ou plus récent (développé et testé avec Node 24.16).
- Un accès réseau vers l'API Cyclos et un compte Cyclos d'écoute (le compte du
  commerçant), avec le canal `main` pour un compte professionnel.

## Installation

```sh
npm install
```

Une seule dépendance : `luxon` (heures de Paris).

## Lancement

```sh
npm start
```

(équivalent de `node src/server.js`, avec en plus la lecture de `.env` s'il existe.)
Puis ouvrir <http://localhost:3001> (port **3001** par défaut, pour ne pas gêner
l'outil de relevé qui garde le 3000). Après la connexion, le navigateur arrive sur
`/caisse`. La page est **désactivée par défaut** (voir « Activer et lancer la caisse »).

Les variables peuvent se mettre dans un fichier `.env` (copier
[.env.example](.env.example) en `.env`) : `npm start` le lit s'il existe, `node
src/server.js` seul et `npm test` ne le lisent pas, une variable placée devant la
commande l'emporte sur le fichier, et `.env` est ignoré par git (ne jamais le
commiter).

## Scripts

| Commande | Effet |
| --- | --- |
| `npm start` | Démarre le serveur (`node --env-file-if-exists=.env src/server.js`) |
| `npm test` | Lance les tests (`node --test "test/*.test.js"`), sans appel à un vrai Cyclos |
| `npm run build:exe` | Fabrique l'exécutable (voir « Exécutable ») |

## Exécutable

Essai : l'application peut être fabriquée en un seul fichier exécutable, sans Node
installé sur la machine qui le lance (« single executable application » de Node).
Il en faut un par système : celui fabriqué sur un Mac ne tourne que sur ce type de Mac.

**Fabrication**, en une commande, depuis le dossier du projet (après `npm install`).
Elle exige un Node 25.5 ou plus récent (option `--build-sea`). Si le Node de votre
terminal est plus ancien (par exemple 24), indiquer le chemin d'un Node récent dans
`SEA_NODE`, sans changer votre Node habituel :

```sh
SEA_NODE=/chemin/vers/node-v26/bin/node npm run build:exe
```

Avec un Node 25.5 ou plus récent dans le terminal, `npm run build:exe` suffit. Le
script refuse de continuer si ce Node est trop ancien. Résultat :
`build/graine34-notif-caisse` (`.exe` sous Windows), environ 146 Mo. Sur macOS, le
script y ajoute la signature locale (ad hoc) sans laquelle le système tue le
programme au lancement ; elle ne remplace pas une vraie signature de diffusion.
`esbuild`, l'outil qui regroupe le code, n'est qu'une dépendance de fabrication : il
n'est pas dans l'exécutable. Le relevé de transactions (`/espace/releve`, mode multi-commerçants) n'en fait pas partie : le fabricant
laisse `releve-pdf.js` et `pdfkit` hors du fichier et **s'arrête avec une erreur s'ils y entrent quand même**, et le contrôle de
démarrage (`tools/smoke-exe.js`) vérifie que `/espace` et `/espace/releve` y répondent 404.

**Lancement.** Un double clic (ou la commande `./build/graine34-notif-caisse`) ouvre une fenêtre de terminal.
Le programme :

1. applique des réglages intégrés, tous modifiables par variables d'environnement : adresse de La Graine 34
   (`CYCLOS_BASE_URL`), canal `main` (`CYCLOS_CHANNEL`), port 3001 (`PORT`) ;
2. démarre la caisse sur l'adresse locale (`127.0.0.1`) seulement ;
3. ouvre la page de connexion dans le navigateur par défaut. **L'identifiant et le mot de passe se saisissent sur cette
   page. Rien n'est demandé dans la fenêtre.** Si le navigateur ne s'ouvre pas, l'adresse est affichée : l'ouvrir soi-même.

La connexion réussie démarre l'écoute des paiements. Le premier compte qui se connecte devient le commerçant de cette
exécution : un autre compte est refusé (pour en changer, arrêter puis relancer le programme).

**Mot de passe.** Il n'est lu qu'à la connexion, saisi sur la page. Il est gardé **en mémoire seulement**, dans la session
de la page, pour que l'écoute puisse se reconnecter à Cyclos quand son jeton expire. Il n'est écrit ni dans un fichier,
ni dans les journaux, ni dans un message, ni dans l'environnement du programme. Il disparaît avec la session : à la
déconnexion, après 20 minutes sans visite, au bout de **12 heures** au plus, ou si Cyclos le refuse. Les variables
`CAISSE_CYCLOS_LOGIN` et `CAISSE_CYCLOS_PASSWORD` sont ignorées par l'exécutable. Une session expirée renvoie au formulaire :
on s'y reconnecte avec le même compte. L'écoute s'arrête d'elle-même environ 45 secondes après la fermeture de la page.

**Une seule tentative.** Pour ne pas faire bloquer le compte ou l'adresse par Cyclos :

- un envoi du formulaire = un seul appel à Cyclos, jamais répété par le programme ;
- un deuxième envoi pendant qu'un premier est vérifié est refusé ;
- après un refus d'identifiant : pause de **30 secondes** ; après un deuxième refus de suite : **15 minutes**. Une connexion
  réussie remet le compte à zéro ;
- si Cyclos répond « trop de demandes » : 15 minutes tout de suite ; autre panne de Cyclos : 30 secondes ;
- si Cyclos refuse l'identifiant quand l'écoute se reconnecte (mot de passe changé entre-temps) : un seul essai, puis le
  formulaire est de nouveau demandé.

**Sécurité en local.** La page est en HTTP, sans HTTPS : le mot de passe ne quitte pas l'ordinateur (adresse locale),
mais il n'est pas chiffré sur cette liaison. Pour cette raison l'exécutable **refuse `CAISSE_OPEN_NETWORK`** (message, le
programme ne démarre pas) et ne répond qu'aux noms `127.0.0.1`, `localhost` et `[::1]` avec son port (en-tête `Host`),
ce qui écarte une page web qui chercherait à atteindre le programme sous un autre nom.

| Variable | Rôle | Valeur par défaut |
| --- | --- | --- |
| `CYCLOS_BASE_URL` | Adresse de l'API Cyclos (jamais la démo : une valeur vide donne l'adresse de La Graine 34) | `https://laruchedesmonnaieslocales.org/lagraine34/api` |
| `CYCLOS_CHANNEL` | Canal Cyclos (vide : aucun canal) | `main` |
| `PORT` | Port d'écoute. Sans `PORT`, si 3001 est pris, 3002 à 3010 sont essayés. Avec `PORT`, seul ce port est essayé | `3001` |
| `CAISSE_OPEN_NETWORK` | Refusé par l'exécutable : le programme s'arrête avec un message (le mot de passe est saisi sur une page sans HTTPS, il ne doit pas traverser le réseau). Toujours possible avec `npm start`, voir « Activer et lancer la caisse » | non accepté |
| `CAISSE_NO_BROWSER` | `true` : le navigateur n'est pas ouvert, seule l'adresse est affichée (contrôles automatiques). `false` ou absent : comportement normal | non défini |

Les autres variables `CAISSE_*` (voir « Activer et lancer la caisse ») s'appliquent aussi, sauf les deux identifiants
(voir plus haut). L'exécutable ne lit pas de fichier `.env`. L'écoute est toujours activée (pas besoin de `CAISSE_ENABLED`).

**Erreurs au démarrage.** Un réglage invalide, un port déjà pris ou `CAISSE_OPEN_NETWORK` donnent un message en français,
sans valeur saisie. Le programme attend « Entrée » avant de fermer la fenêtre (rien de ce qui est tapé n'est lu ni gardé).
Les erreurs de connexion (identifiant refusé, Cyclos injoignable, trop de demandes) s'affichent sur la page, avec
l'attente à respecter avant un nouvel essai.

Pour arrêter : `Ctrl+C` (la fermeture de la fenêtre arrête aussi le programme).

**État des essais.** Testé sur macOS avec un faux Cyclos (démarrage, port occupé, connexion sur la page, mauvais mot de passe,
pauses). **Non testé** sur Windows et Linux : ouverture du navigateur (`rundll32` sous Windows, `xdg-open` sous Linux), double clic, pare-feu, SmartScreen.

### Fabrication automatique (GitHub Actions)

Le fichier [.github/workflows/build.yml](.github/workflows/build.yml) fabrique les exécutables pour Windows, macOS et Linux.
Il ne se lance pas à chaque push : seulement à la demande, ou quand une étiquette de version `v*` est publiée.

**Lancer la fabrication.** Sur GitHub, onglet **Actions**, workflow « Fabrication des exécutables », bouton **Run workflow**
(branche `main`), puis **Run workflow**. Le travail « Tests » (Node 24, `npm test`) passe d'abord ; s'il échoue, rien n'est fabriqué.
Ensuite quatre travaux tournent en parallèle, avec Node 26 : `linux-x64` (`ubuntu-24.04`), `windows-x64` (`windows-2025`),
`macos-arm64` (`macos-15`, Apple Silicon) et `macos-x64` (`macos-15-intel`, Mac Intel). Chacun lance `npm ci`, `npm run build:exe`,
puis un **contrôle de démarrage** (`node tools/smoke-exe.js`) : l'exécutable est lancé sans navigateur (`CAISSE_NO_BROWSER=true`)
sur le port 3101, la page de connexion et un fichier intégré doivent répondre, puis le programme est arrêté. Aucun identifiant n'est
utilisé, Cyclos n'est jamais appelé. Le même contrôle se lance en local après une fabrication : `node tools/smoke-exe.js`.

**Télécharger.** Ouvrir l'exécution terminée (onglet Actions, clic sur l'exécution) : les fichiers sont dans la section
**Artifacts**, en bas de la page. Ils sont **conservés 7 jours**, puis supprimés : relancer la fabrication si besoin. Chaque fichier
fait environ 140 Mo.

| Fichier | Système |
| --- | --- |
| `graine34-notif-caisse-linux-x64.tar.gz` | Linux, processeur Intel/AMD 64 bits |
| `graine34-notif-caisse-windows-x64.exe` | Windows 64 bits |
| `graine34-notif-caisse-macos-arm64.tar.gz` | Mac Apple Silicon (M1 et suivants) |
| `graine34-notif-caisse-macos-x64.tar.gz` | Mac à processeur Intel |

Sous Linux et macOS, le fichier est une archive `.tar.gz` : un zip d'artefact ferait perdre le droit d'exécution. Après
l'extraction (`tar -xzf graine34-notif-caisse-<système>.tar.gz`), le droit est normalement conservé. S'il manque quand même :
`chmod +x graine34-notif-caisse`.

**Les exécutables ne sont pas signés.** Aucune signature de code n'est faite à ce stade, des alertes de sécurité sont donc
attendues :

- **macOS** : le fichier téléchargé reçoit une quarantaine et le système refuse de l'ouvrir. Après extraction, dans le terminal :
  `xattr -d com.apple.quarantine graine34-notif-caisse`, puis `./graine34-notif-caisse`. La signature ad hoc ajoutée à la
  fabrication évite seulement que le système tue le programme au lancement, elle ne remplace pas une signature de diffusion.
- **Windows** : SmartScreen peut afficher « Windows a protégé votre ordinateur » ; **Informations complémentaires**, puis **Exécuter
  quand même**.
- **Linux** : si le droit d'exécution manque, `chmod +x graine34-notif-caisse`.

Le workflow n'utilise aucun secret et demande seulement la permission de lire le dépôt (`contents: read`).

## Arborescence

```
src/                 le serveur et la logique côté Node
  server.js            serveur HTTP : connexion, sessions, /caisse, /espace, déconnexion, statiques
  assets.js            lecture des fichiers statiques de web/ (disque, ou fichiers embarqués dans l'exécutable)
  main.js              point d'entrée de l'exécutable
  launcher.js          démarrage de l'exécutable : réglages, port libre, navigateur
  caisse-config.js     lecture et validation des variables CAISSE_*
  sse-parser.js        analyseur du flux d'événements Cyclos (SSE), sans accès réseau
  cyclos-push.js       appels Cyclos : flux, transfert, historique, réglage, relevé (nom, totaux, historique paginé)
  ticket-store.js      tickets en mémoire : modèle, doublons, tri, état
  cyclos-listener.js   boucle d'écoute d'un commerçant : réouverture, chien de garde, reconnexion
  payment-processor.js événements reçus, tickets, filet de sécurité par l'historique
  listener-manager.js  cycle de vie des écouteurs : inscription, inactivité, plafond, arrêt
  caisse-page.js       HTML de la page /caisse (fonctions pures), complète sans script
  caisse-data.js       bannière, textes d'un ticket et JSON de /caisse/data (fonctions pures)
  espace-page.js       HTML de la page d'entrée /espace (fonctions pures)
  format.js            échappement HTML, message d'erreur, montants à la française (fonctions pures)
  releve-calcul.js     relevé : plages de dates (heure de Paris), montants exacts en BigInt, totaux, ticket (fonctions pures)
  releve-page.js       relevé : HTML des filtres, du ticket et des refus (fonctions pures)
  releve-routes.js     relevé : routes /espace/releve (origine, session, CSRF, une lecture à la fois, erreurs Cyclos)
  releve-pdf.js        relevé : PDF du ticket (pdfkit), chargé au premier PDF, hors de l'exécutable
web/                 tout ce que le navigateur reçoit
  style.css            feuille de style unique (charte La Graine 34, classes de la caisse comprises)
  images/              logo-lagraine34.png (servi sur /logo.png), icon-lagraine34.png (servi sur /icon.png :
                       favicon des pages et icône des notifications)
  fonts/               polices Roboto et Voltaire (woff2) et leurs licences
  js/                  les scripts du navigateur, tous servis à la racine (/caisse.js, /age.js...)
    caisse.js            lecture toutes les N secondes, minuteries, réseau
    caisse-view.js       construit l'affichage (textContent, jamais de HTML brut)
    caisse-texts.js      textes fixes de la page, partagés avec le serveur
    new-payments.js      détection des nouveaux paiements (fonction pure, servira au son et à la notification)
    date-line.js         ligne de date et décalage d'horloge (fonctions pures)
    age.js               « il y a x min » (fonction pure, utilisée par le serveur et le navigateur)
    sound-logic.js       quand sonner et que dire de l'état du son, son voulu par défaut (fonctions pures)
    controls-logic.js    le bouton unique du son et des notifications : libellé et action (fonctions pures)
    refresh-logic.js     le bouton « Actualiser » : libellé et état désactivé (fonctions pures, aussi utilisées par le serveur)
    password-toggle.js   le bouton en forme d'œil des pages de connexion (voir le mot de passe saisi)
    sound.js             le son : Web Audio, bip généré, aucun fichier audio
    notification-logic.js  quoi notifier et que dire de l'état (regroupement, tag, texte : fonctions pures)
    notification.js      notifications du navigateur : le seul fichier qui touche à l'API Notification
    print-ticket.js      le bouton « Imprimer » du ticket du relevé (créé par le script, seul script de ces pages)
test/                tests (node:test), un fichier par sujet : *.test.js
  support/             faux Cyclos, harnais de test, options communes (pas des tests)
tools/               outils hors serveur
  build-sea.js         fabrication de l'exécutable (npm run build:exe)
  push-smoke.js        script de vérification du flux, à lancer à la main
.env.example         modèle du fichier `.env`
```

Trois fichiers sont utilisés par le serveur **et** par le navigateur (`caisse-texts.js`, `refresh-logic.js`, `age.js`) :
ils restent dans `web/js/`, parce que les scripts s'importent entre eux par chemin relatif, et le serveur les lit depuis là.
Les adresses du navigateur ne dépendent pas de ce rangement (`/style.css`, `/logo.png`, `/caisse.js`, `/fonts/...`).

## Variables d'environnement

Générales (celles de la mission 2A, sauf `PORT` qui vaut ici 3001 par défaut) :

| Nom | Rôle | Valeur par défaut |
| --- | --- | --- |
| `CYCLOS_BASE_URL` | Adresse de l'API Cyclos (avec `/api`) | `https://demo.cyclos.org/api` (la démo publique) |
| `CYCLOS_CHANNEL` | Canal Cyclos, envoyé dans l'en-tête `Channel` sur tous les appels. Lettres, chiffres, `-` et `_`, 32 caractères au maximum, sinon le serveur refuse de démarrer. `main` est obligatoire avec un compte professionnel. | aucun (en-tête non envoyé) |
| `PORT` | Port d'écoute | `3001` |
| `SESSION_IDLE_MINUTES` | Inactivité après laquelle la session de la page se ferme | `20` |
| `SESSION_MAX_HOURS` | Durée maximale d'une session de la page | `8` |
| `COOKIE_SECURE` | `true` : cookie `Secure` et en-tête HSTS (à activer derrière HTTPS) | désactivé |

Les variables `CAISSE_*` sont décrites dans « Activer et lancer la caisse ». Une valeur
numérique générale absente ou invalide est remplacée par sa valeur par défaut ; seule la
valeur exacte `true` active `COOKIE_SECURE`.

## Activer et lancer la caisse

Désactivée par défaut : sans `CAISSE_ENABLED=true`, `/caisse` répond 404 et
aucun identifiant n'est exigé. Le serveur ne lit aucun fichier `.env` lui-même
(voir « Lancement ») et refuse de démarrer si une variable `CAISSE_*` est invalide.
Pour ne pas laisser le mot de passe dans l'historique du terminal :

```sh
read -s CAISSE_PW
CAISSE_ENABLED=true CAISSE_CYCLOS_LOGIN="..." CAISSE_CYCLOS_PASSWORD="$CAISSE_PW" \
CYCLOS_CHANNEL=main CYCLOS_BASE_URL="https://laruchedesmonnaieslocales.org/lagraine34/api" npm start
unset CAISSE_PW
```

Puis ouvrir <http://localhost:3001> et se connecter avec le **même compte** que le
compte d'écoute : le navigateur arrive directement sur `/caisse`.

| Nom | Rôle | Valeur par défaut |
| --- | --- | --- |
| `CAISSE_ENABLED` | `true` active la page ; `false` : 404 et aucun identifiant exigé | `false` |
| `CAISSE_CYCLOS_LOGIN` | Identifiant du compte d'écoute (exigé si activée) | aucun |
| `CAISSE_CYCLOS_PASSWORD` | Mot de passe du compte d'écoute (exigé si activée, jamais journalisé) | aucun |
| `CAISSE_ACCOUNT_TYPE` | Type de compte à lire (par exemple `MonComptePro`) ; lettres, chiffres, `.`, `-`, `_`. Réglé, il passe avant la règle `MonComptePro`, `monCompte`, puis premier de la liste | règle automatique |
| `CAISSE_POLL_SECONDS` | Rythme de lecture du script (0 à 60). `0` = mode manuel, voir ci-dessous | `3` |
| `CAISSE_REFRESH_SECONDS` | Rechargement de la page pour un navigateur **sans** JavaScript (2 à 60) | `5` |
| `CAISSE_IDLE_SECONDS` | Arrêt de l'écoute sans visite (15 à 600) | `45` |
| `CAISSE_STREAM_WATCHDOG_SECONDS` | Silence maximal sur le flux avant de le rouvrir (10 à 600) | `60` |
| `CAISSE_RECONNECT_MAX_SECONDS` | Pause maximale entre deux essais (1 à 600) | `30` |
| `CAISSE_REAUTH_MAX` | Refus d'identifiants de suite avant l'état erreur (1 à 10) | `3` |
| `CAISSE_SAFETY_POLL_SECONDS` | Intervalle du filet de sécurité périodique (10 à 3600) | `60` |
| `CAISSE_HISTORY_INITIAL` | Paiements chargés à l'ouverture (1 à 100) | `10` |
| `CAISSE_TICKETS_KEPT` | Tickets gardés en mémoire (1 à 500) | `50` |
| `CAISSE_MAX_LISTENERS` | Écouteurs simultanés (1 à 50) | `5` |
| `CAISSE_HIDE_PAYER_NAME` | `true` : le nom du payeur est remplacé par « Client » | `false` |
| `CAISSE_NAME_ORDER` | Ordre des mots du nom du payeur dans Cyclos : `nom-prenom` (« Dupont Marie », le prénom est le dernier mot) ou `prenom-nom` (« Marie Dupont »). Voir « Nom du payeur » | `nom-prenom` |
| `CAISSE_HIDDEN_DESCRIPTIONS` | Descriptions à ne pas afficher (celle que le type de paiement ajoute quand le payeur n'a rien écrit), séparées par des virgules ; la casse, les accents et les espaces en trop sont ignorés. Une valeur vide ne masque rien | `Virement Mobile Pro` |

Valeur invalide ou identifiants manquants avec `CAISSE_ENABLED=true` : le
serveur s'arrête au démarrage avec un message qui nomme la variable (sans
jamais afficher sa valeur). Quand la page est désactivée, les autres variables
`CAISSE_*` ne sont pas lues.

## Espace commerçants

Page d'entrée `/espace`, pour le mode multi-commerçants (`CAISSE_ENABLED=true` et `CAISSE_MULTI_MERCHANT=true`, voir
`docs/multi-commercants.md`). Le commerçant s'y connecte avec son compte Cyclos (canal `CYCLOS_CHANNEL`, `main` en production) ;
**seulement s'il possède un compte de type interne `MonComptePro`** (et, si `CAISSE_ALLOWED_USERS` est remplie, s'il figure aussi dans cette liste), il voit deux entrées : « Notifications de caisse » (un bouton qui ouvre `/caisse`
sans nouvelle saisie du mot de passe) et « Relevé de transactions » (un lien vers `/espace/releve`, qui
utilise la même session : une seule connexion pour l'espace, la caisse et le relevé).

| Adresse | Rôle |
| --- | --- |
| `GET /espace` | Sans session : le formulaire. Avec une session valide : la page des deux entrées |
| `POST /espace/connexion` | Vérifie le compte auprès de Cyclos : présence d'un compte `MonComptePro`, puis la liste si elle est remplie ; ne garde que le jeton de session |
| `POST /espace/caisse` | Origine du site et jeton CSRF exigés, session de l'espace valide : ouvre la session de `/caisse` à partir du jeton Cyclos déjà obtenu, puis redirige vers `/caisse` |
| `POST /espace/deconnexion` | Ferme la session chez Cyclos et sur le serveur (jeton CSRF exigé) |

- Un mauvais mot de passe, un compte valide sans `MonComptePro` et un compte valide absent de la liste (quand elle est remplie)
  donnent **la même réponse** (401) et le même message, « Identifiants incorrects ou accès non autorisé. », pour ne pas révéler
  qui est accepté. Si Cyclos ne répond pas pendant la lecture des comptes, la réponse est « Cyclos ne répond pas » (502), qui ne dit
  rien du membre ; un 403 de Cyclos sur cette lecture donne le refus habituel. Ces deux cas ne comptent pas comme un échec du membre dans le frein de connexion (5 échecs en 15 minutes par adresse).
- Le bouton « Notifications de caisse » est un formulaire (méthode POST, jeton CSRF, vérification d'origine), sans JavaScript.
  Le serveur vérifie de nouveau, auprès de Cyclos, que le jeton fonctionne encore et que le compte a toujours un compte `MonComptePro` (et figure toujours dans la liste, si elle est remplie),
  puis crée la session de `/caisse` (autre cookie `session`, autre jeton CSRF) à partir du jeton de l'espace. Le mot de passe n'existe
  plus à ce stade : il n'est jamais conservé. Si le jeton n'est plus valable chez Cyclos, la session de l'espace se termine et le
  commerçant se connecte de nouveau. La connexion directe par `/connexion` (identifiant et mot de passe) fonctionne comme avant.
- Les deux sessions locales (espace et caisse) **partagent le même jeton Cyclos**. Il n'est fermé chez Cyclos que lorsque plus aucune
  session locale ne le détient : se déconnecter de la caisse arrête l'écoute et ferme la caisse, mais l'espace reste connecté ;
  se déconnecter de l'espace laisse la caisse ouverte ; le jeton se ferme avec la dernière des deux (déconnexion ou expiration).
  L'arrêt de l'écoute pour inactivité (45 secondes sans visite) ne ferme aucun jeton en mode multi-commerçants : l'écoute n'emprunte que
  le jeton, elle ne le ferme pas.
- Mêmes freins que les autres connexions (5 refus par identifiant et 10 par adresse sur 15 minutes, disjoncteur Cyclos, compteurs
  partagés avec `/connexion`), même lecture de l'adresse (`CAISSE_TRUSTED_PROXY_HOPS`), mêmes sessions (`SESSION_IDLE_MINUTES`,
  `SESSION_MAX_HOURS`) et mêmes en-têtes de sécurité.
- En mode multi-commerçants, l'adresse racine `/` (GET et HEAD) redirige vers `/espace` (redirection temporaire 307, sans cache),
  même pour quelqu'un déjà connecté à `/caisse`. Le formulaire de connexion de `/caisse` reste accessible sur `/connexion`, et les
  liens « Retour », la déconnexion et le lien « Se reconnecter » y mènent.
- Sans le mode multi-commerçants (mode à compte d'écoute unique, exécutable), `/espace` n'existe pas : toutes ses adresses répondent 404. Dans ces modes, `/` reste le formulaire de connexion, comme avant.

Le réglage `ESPACE_RELEVE_URL` n'existe plus : le relevé fait partie du site. S'il figure encore dans un environnement, il est ignoré.

## Relevé de transactions

Le ticket de fin de service des commerçants (outil de la mission 2A) fait partie de l'espace : `/espace/releve`, **en mode
multi-commerçants seulement** (sans ce mode, toutes ces adresses répondent 404, comme `/espace`). Il n'a pas de connexion propre : il
utilise la session de l'espace et son jeton Cyclos (une seule connexion pour l'espace, la caisse et le relevé ; le mot de passe n'est jamais
conservé). Le relevé n'est **pas dans l'exécutable** (mode multi-commerçants absent), pdfkit non plus.

| Adresse | Rôle |
| --- | --- |
| `GET /espace/releve` | Les filtres « Choisir la période » : trois boutons-raccourcis (Aujourd'hui, Hier, 6 dernières heures), puis une journée ou une soirée, un mois complet et, dans un menu replié, une autre période de plusieurs jours |
| `POST /espace/releve/ticket` | Le ticket à l'écran, relu chez Cyclos pour un jour et deux heures (champs `jour`, `de`, `a` ; l'ancien champ `lendemain`, s'il est encore envoyé, est ignoré), pour le mois choisi (champs `mois` et `annee`) pour un raccourci (champ `raccourci` : `aujourdhui`, `hier` ou `6h`) ou pour les deux dates saisies (`start`, `end`) |
| `POST /espace/releve/ticket.pdf` | Le même ticket en PDF (téléchargement), relu chez Cyclos |

- Chaque POST exige l'origine du site, une session d'espace valide et son jeton CSRF. Seule la période (le jour et les heures, le mois, ou les deux dates) vient du navigateur.
  Un GET sur `/espace/releve/ticket` ou `ticket.pdf` renvoie aux filtres ; sans session, tout renvoie à `/espace`.
- **Une lecture à la fois par session** : la lecture fait jusqu'à une douzaine d'appels Cyclos de suite, et le PDF relit tout. Une
  seconde demande de la même session pendant une lecture reçoit 429 (page, `Retry-After: 5`) sans rien lire. Une lecture entière est
  limitée à 60 secondes (502 au-delà, journalisé « délai dépassé »).
- Un 401 de Cyclos pendant la lecture ferme la session de l'espace (retour à `/espace`), comme pour la caisse. Un 403 sur la liste des
  comptes (ou une liste vide) affiche « Accès aux comptes refusé », un autre 403 « Accès refusé » : la session reste ouverte. Une panne
  ou un réseau coupé donne 502 avec une page de retour (jamais un PDF à moitié envoyé).
- **Trois façons de choisir la période**, de haut en bas de la page des filtres, sans aucun JavaScript :
  1. **Une journée ou une soirée** (avec la phrase d'aide « Choisissez le jour, puis l'heure de début et l'heure de fin. ») : un jour
     (sélecteur de date), une heure « De » et une heure « À » (sélecteurs d'heure). Il n'y a plus de case à cocher : le serveur déduit
     le jour de fin des deux heures, et une phrase fixe sous les champs l'explique (« Si l'heure de fin est avant l'heure de début, le
     relevé s'arrête le lendemain (exemple : de 18:00 à 02:00). »). Le serveur préremplit en heure de Paris (aujourd'hui, 00:00, 23:59),
     à chaque arrivée sur la page, même par un ancien lien `?preset=…` ; les champs demandent au navigateur de ne pas rappeler d'anciennes
     valeurs (`autocomplete="off"`). **« À » après « De »** : même jour ; **« À » avant « De »** : la fin tombe le lendemain (du 22/11
     à 18:00 jusqu'au 23/11 à 02:00) ; **« À » égal à « De »** : 24 heures complètes, jusqu'au lendemain à la même heure. Le lendemain
     est un jour de calendrier ajouté avec Luxon en `Europe/Paris` (`plus({ days: 1 })`), jamais 24 heures fixes : du 24 octobre 2026
     à 22:00 au 25 octobre à 04:00 couvre 7 heures réelles, et un jour de 25 h (25 octobre 2026) ou de 23 h (29 mars 2026) n'est jamais
     refusé à tort. Ce relevé ne dépasse donc jamais un jour de calendrier (la limite de 31 jours de la plage libre est inchangée).
     Un ancien formulaire ou un favori qui envoie encore le champ `lendemain` n'a pas d'erreur : le champ est ignoré. La dernière minute
     indiquée est incluse, comme pour les autres plages (23:59 va jusqu'à 23:59:59). Le calcul passe ensuite par les mêmes règles que la
     plage libre (début futur refusé, fin future ramenée à maintenant, heure inexistante au passage à l'heure d'été refusée) : aucun
     décalage en dur. Le ticket écrit toujours les dates et heures exactes (« Du 22/11/2026 18:00 au 23/11/2026 02:00 ») ; le bouton
     PDF redemande le jour et les deux heures, et le fichier se nomme comme celui d'une plage libre
     (`ticket-2026-11-22_1800_2026-11-23_0200.pdf`).
  2. **Un mois complet** : voir ci-dessous.
  3. **Autre période (plusieurs jours)** : un menu replié (éléments natifs `details` et `summary`) qui contient les deux dates avec
     heure (Début, Fin), limitées à 31 jours calendaires. Le serveur l'ouvre seulement après une erreur de cette plage.
     Le titre est vert, souligné au survol, précédé d'un chevron dessiné en CSS (vers la droite replié, vers le bas ouvert, ignoré des
     lecteurs d'écran) ; il reste un `summary` natif, utilisable au clavier (Entrée, Espace).

  **Les trois raccourcis** (Aujourd'hui, Hier, 6 dernières heures) sont des boutons d'un formulaire POST avec jeton CSRF : un clic affiche
  directement le ticket, avec les mêmes bornes qu'avant (aujourd'hui de 00:00 à maintenant, hier de 00:00 à 23:59, les 6 dernières
  heures jusqu'à maintenant) et les dates exactes dans la période. Un nom inconnu donne une erreur 400 sans appel à Cyclos. Le bouton
  PDF d'un raccourci renvoie les **bornes exactes du ticket affiché** (les deux dates), pas le nom du raccourci : un téléchargement
  fait plus tard couvre la même période que l'écran, au lieu de relire « maintenant ». Les anciens liens `?preset=…` ne préremplissent
  plus rien : ils affichent la page avec ses valeurs par défaut.

  Si une erreur (400) vient d'un bloc, la page revient avec les valeurs saisies et le message placé dans ce bloc. Le serveur reconnaît le
  mode aux champs reçus : `mois` et `annee`, sinon `jour`, `de` et `a`, sinon `raccourci`, sinon `start` et `end`. Le mode mois et
  la plage libre fonctionnent comme avant, et les politiques de sécurité ne changent pas.
- **Un mois complet (ancien « Relevé mensuel »).** Pour un comptable : sur la page des filtres, le bloc « Un mois complet » a une liste du
  mois (en français) et une liste de l'année (l'année courante et les deux précédentes), préremplies avec le mois précédent, et le
  bouton « Voir le mois » (un POST avec jeton CSRF : une lecture ne se déclenche jamais par un simple lien). Le mois va du 1er à 00:00 au dernier jour à 23:59, heure de Paris (même convention que
  « Hier » ; Cyclos reçoit la dernière milliseconde de cette minute). Un mois qui n'a pas commencé est refusé avec un message ; le mois
  en cours est accepté, sa fin est ramenée à maintenant et le ticket l'écrit (« mois en cours »). Mois et année sont vérifiés
  strictement (nombre de 1 à 12, année de la liste) : toute autre valeur donne une erreur 400. Le ticket et le PDF s'intitulent
  « Relevé du mois de novembre 2026 » (« d'octobre », « d'avril », « d'août ») avec la période exacte ; le PDF se nomme
  `releve-AAAA-MM.pdf` (par exemple `releve-2026-11.pdf`). Les plages libres gardent leur nom `ticket-…pdf`.
- **Limite de durée.** Elle est comptée en jours de calendrier (31 au plus, avec Luxon en `Europe/Paris`), pas en heures écoulées : un
  mois entier passe toujours, y compris octobre 2026 (745 h, le 25 octobre l'heure recule) et mars 2027 (743 h). La plage libre garde
  sa limite de 31 jours.
- **Plafond de lignes du mois.** Le mode mois lit jusqu'à `HISTORY_MAX_ROWS_MONTH` lignes (10000 par défaut, contre
  `HISTORY_MAX_ROWS` = 2000 pour la plage libre, qui ne change pas). La règle au plafond est la même que pour la plage libre : la
  liste est coupée aux transactions les plus récentes avec un avertissement, les totaux de Cyclos sont repris s'il y en a, sinon
  « Non disponible » : jamais un total inventé. Le temps de lecture d'un mois est de 60 secondes plus 2 secondes par page que le
  plafond permet de lire (160 s pour 10000 lignes à 200 par page), les appels se suivant sur le même jeton Cyclos.
- Les pages du relevé n'ont **aucun script**, sauf le ticket : leur politique de sécurité n'a ni `script-src` ni `connect-src` (celle de
  l'outil d'origine), alors que le reste du site garde celle qui laisse tourner le script de `/caisse`. Pas de bouton de déconnexion :
  un lien « Retour à l'espace » (la déconnexion se fait depuis l'espace).
- Le bouton **Imprimer** : le ticket (du jour ou du mois, c'est la même page) charge `/print-ticket.js` par une balise `script` avec
  `src`, à la fin du corps. Ce petit module (`web/js/print-ticket.js`) crée lui-même le bouton, à côté du téléchargement du PDF, et appelle
  `window.print()` au clic ; sans JavaScript, ou script bloqué, il n'y a pas de bouton (le HTML du serveur n'en contient aucun). Il est servi
  par la même liste blanche que les scripts de la caisse (`BROWSER_MODULES` dans `server.js`, et `tools/build-sea.js` pour l'exécutable).
  La réponse **200 du ticket seulement** ajoute `script-src 'self'` à la politique du relevé, rien d'autre (ni `unsafe-inline`, ni
  `connect-src`) ; les filtres, les refus du ticket (400, 403, redirection), le PDF, la caisse et l'espace gardent leur politique exacte.
- L'impression : le ticket d'une plage reste le ticket de 80 mm de la feuille de style commune (même bloc `@media print` que l'outil
  d'origine). Le ticket du mois reçoit la classe `page-mois` sur `<html>` (posée par le serveur) et s'imprime sur une page A4 nommée
  (`@page mois`, marges de 15 mm) : le détail devient un tableau dont la ligne de titres (Date, Numéro, Contrepartie, Description,
  Montant, cachée à l'écran) est répétée sur chaque page imprimée, et une ligne n'est jamais coupée entre deux pages. Le bouton n'est
  jamais imprimé. Les pages nommées demandent un navigateur récent ; sinon le mois garde la page du ticket de 80 mm, avec le contenu
  qui en suit la largeur.
- Le détail : dates saisies et lues en heure de Paris, au plus 31 jours, début jamais dans le futur, fin future ramenée à maintenant ;
  une heure qui n'existe pas (passage à l'heure d'été) est refusée ; une heure double (passage à l'heure d'hiver) prend la seconde
  occurrence, sans avertissement. Les montants sont calculés en entiers exacts. Cyclos répond le plus récent d'abord, le ticket
  se lit du plus ancien au plus récent.
- Totaux : ceux de Cyclos sont repris tels quels ; sur l'instance réelle Cyclos n'en donne pas, ils sont alors calculés à partir des
  transactions lues, **seulement si la liste est complète**. Liste coupée au plafond, ou montant illisible : « Non disponible » trois
  fois, avec un avertissement (page et PDF), jamais un total inventé.
- **Nom de la contrepartie.** La colonne de la contrepartie (page et PDF, plage libre et mois) s'écrit comme le payeur de la caisse :
  « Tom B. » pour « Benameur - Tom », avec les mêmes réglages `CAISSE_NAME_ORDER` et `CAISSE_HIDE_PAYER_NAME` (aucune variable de plus ;
  `true` donne « Client »). C'est la même fonction que la caisse, appliquée seulement quand le texte ressemble à une personne :
  un seul séparateur « - » (le format de Cyclos), ou deux mots sans séparateur, avec un prénom d'un seul mot (trait d'union permis).
  Tout le reste est affiché tel quel : un seul mot, une structure de plus de deux mots, un prénom écrit avec une espace, un texte qui
  ne commence pas par des lettres. Un compte système (« Compte système ») n'est jamais modifié, ni masqué. Le nom du commerçant, en haut
  du ticket, n'est jamais modifié. Une structure à deux mots (« Boulangerie Dupont ») ne se distingue pas d'une personne : comme à la
  caisse, elle est abrégée.
- Le PDF n'imprime que les lettres de Windows-1252 (accents français, €, guillemets) ; tout autre caractère devient `?` (la page
  les affiche tous).

| Nom | Rôle | Valeur par défaut |
| --- | --- | --- |
| `HISTORY_PAGE_SIZE` | Lignes demandées à Cyclos par page (entier positif ; sinon la valeur par défaut) | 200 |
| `HISTORY_MAX_ROWS` | Plafond de lignes lues pour un ticket (entier positif ; sinon la valeur par défaut). Au-delà, la liste est coupée aux plus récentes avec un avertissement | 2000 |
| `HISTORY_MAX_ROWS_MONTH` | Même plafond, pour le mode « Relevé mensuel » seulement (la plage libre garde `HISTORY_MAX_ROWS`). Entier positif ; sinon la valeur par défaut | 10000 |

**Compte lu quand il y en a plusieurs.** Le relevé et la caisse lisent le même compte, choisi dans la liste de Cyclos
(`GET /self/accounts`) par une règle unique : le compte de type `MonComptePro`, sinon celui de type `monCompte`, sinon le premier de
la liste. L'ordre dans lequel Cyclos répond ne change rien tant qu'un de ces deux types est présent. La liste d'ordre est la
constante `PREFERRED_ACCOUNT_TYPES` de `src/cyclos-push.js` (pas de réglage par variable d'environnement). Il n'y a pas de choix de
compte à l'écran, et le ticket ne dit pas lequel est lu. Dans la caisse, `CAISSE_ACCOUNT_TYPE`, s'il est réglé, garde la priorité sur
cette règle ; il ne s'applique pas au relevé.

## Comment elle fonctionne

Un serveur Node écoute le flux de notifications de Cyclos
(`GET /push/subscribe`) avec un compte Cyclos « d'écoute » (le compte du
commerçant, un seul pour le prototype). Une notification de paiement reçu donne
un ticket (un seul appel `GET /transfers/{id}` pour le détail). Un filet de
sécurité lit l'historique du compte pour ne rater aucun paiement.

- **Inscription** : le visiteur connecté doit être le même utilisateur Cyclos
  que le compte d'écoute, comparé par **identifiant utilisateur** (jamais par
  nom affiché). Un autre utilisateur reçoit une page 403 en français et rien
  n'est écouté. Si l'identifiant ne peut pas être lu de façon fiable, la
  réponse est aussi 403 (refuser est le choix prudent). Pour connaître
  l'identifiant du compte d'écoute sans démarrer l'écoute, le serveur ouvre
  **une seule fois** une session courte avec ce compte, lit l'identifiant et la
  ferme aussitôt ; après 3 échecs de suite il n'essaie plus avant le
  redémarrage (pour ne pas faire verrouiller le compte).
- **Écoute seulement pendant que la page est ouverte** : la première visite
  d'un inscrit démarre l'écoute ; chaque lecture (de la page ou du script) la prolonge ; plusieurs
  onglets ou tablettes ouverts ensemble partagent **un seul écouteur** ; sans
  visite pendant 45 secondes (`CAISSE_IDLE_SECONDS`) elle s'arrête : flux
  coupé, session Cyclos fermée, tickets et session effacés de la mémoire. À la
  réouverture, les derniers paiements sont relus dans l'historique (aucun n'est
  perdu). Si l'écoute vient de redémarrer, `GET /caisse/data` **attend la fin de cette
  première lecture** (5 secondes au plus) avant de répondre, pour renvoyer les paiements et non une liste
  vide « Connexion à Cyclos en cours ». Passé ce délai, la réponse est celle d'avant (liste vide, état
  « starting »). `GET /caisse` n'attend pas. Au plus 5 écouteurs en même temps (`CAISSE_MAX_LISTENERS`), au-delà
  la page répond 503. À l'arrêt du serveur (Ctrl+C ou `SIGTERM`), tous les
  écouteurs sont arrêtés proprement.
- **Le flux** : Cyclos le ferme tout seul après environ 41 secondes, c'est
  normal : il est rouvert aussitôt, sans rien écrire dans le journal. Un silence
  de 60 secondes (`CAISSE_STREAM_WATCHDOG_SECONDS`) est une connexion morte :
  elle est coupée et rouverte. Une erreur réseau, un 5xx ou un 429 donnent des
  pauses de 1, 2, 4, 8 secondes jusqu'à 30 (`CAISSE_RECONNECT_MAX_SECONDS`).
  Un 401 renouvelle la connexion ; si Cyclos refuse les identifiants 3 fois de
  suite (`CAISSE_REAUTH_MAX`), l'écoute s'arrête en état erreur. Un 403 arrête
  aussi l'écoute, sans nouvel essai.
- **Doublons et filet de sécurité** : un même paiement arrive plusieurs fois
  (notification, changement de solde, historique). La clé est le **numéro de
  transaction** ; un ticket incomplet (créé depuis la notification seule) est
  **remplacé**, jamais doublé. L'historique (20 derniers crédits) est relu
  après une coupure ou une nouvelle connexion, 1 seconde après un changement
  de solde (regroupé), toutes les 60 secondes (`CAISSE_SAFETY_POLL_SECONDS`) et
  quand le détail d'un transfert n'a pas pu être lu (3 relances au plus).
- **Le ticket** : le montant reste une **chaîne** (aucun calcul en flottants),
  affiché avec la virgule, le suffixe de la devise et ses décimales. L'heure est
  celle de Paris. La mention **Nouveau** (en texte) marque un paiement
  que **cette page n'avait pas encore vu**, depuis moins de 60 secondes : arrivé en direct, rattrapé
  par le filet de sécurité, ou **lu dans l'historique après une pause de l'écoute** (voir
  « Nouveau paiement » plus bas). Si le montant n'est pas lisible, la page l'écrit
  (« Montant en cours de lecture » ou « Montant indisponible ») au lieu
  d'inventer un chiffre. Le texte du message de la notification n'est jamais
  utilisé.
- **Bannière d'état** (ce que voit le caissier) : **aucune** quand l'écoute
  fonctionne, y compris en « mode de secours » (le réglage de notification
  « paiement reçu » n'est pas confirmé : le prototype **lit** ce réglage et ne le
  modifie jamais, les paiements peuvent alors apparaître avec quelques secondes
  de retard, sans message). Une bannière d'avertissement apparaît pendant une
  reconnexion (« Connexion interrompue, reconnexion en cours. Les nouveaux
  paiements peuvent apparaître avec du retard. »). Une bannière d'erreur apparaît
  si la lecture est durablement impossible (« Impossible de lire les paiements
  pour le moment. Prévenir l'équipe La Graine 34. »), sans détail technique.
  Seule la première connexion affiche « Connexion à Cyclos en cours ». Le
  message d'avertissement du mode de secours reste dans le terminal.
- **Nom du payeur** : affiché en « Prénom + initiale du nom », par exemple « Marie D. ». `CAISSE_NAME_ORDER`
  dit dans quel ordre Cyclos écrit le nom. Avec `nom-prenom` (défaut), « Dupont Marie » : le prénom est le
  **dernier mot**, le nom est tout ce qui le précède et l'initiale est celle de son premier mot (« De La
  Fontaine Marie » donne « Marie D. »). Avec `prenom-nom`, « Marie Dupont » : le prénom est le premier mot,
  l'initiale est celle du dernier. Un prénom avec trait d'union est un seul mot (« Martin Jean-Pierre » donne
  « Jean-Pierre M. »). Un prénom composé séparé par une espace n'est pas reconnu (« Dupont Jean Pierre » donne
  « Pierre D. »), et un nom d'entreprise est traité comme une personne. Un seul mot, ou un nom dont les deux
  mots utilisés ne commencent pas par une lettre (« Client 1 »), reste tel quel.
  `CAISSE_HIDE_PAYER_NAME=true` donne toujours « Client ».
- **Grand ticket** (dernier paiement), de haut en bas : la marque « NOUVEAU »,
  le payeur, le montant, la date (« Aujourd'hui 10:33 · il y a 2 min », ou
  « 12/11 17:21 » un autre jour, avec « il y a N h » seulement sous 24 heures),
  « Description : ... » (absente si vide, ou si elle figure dans la liste `CAISSE_HIDDEN_DESCRIPTIONS`), puis le numéro de transaction en petit.
- **Paiements précédents** : une ligne par paiement avec la date et l'heure sur
  une seule ligne, le payeur en gras, sa description en petit gris dessous (une
  ligne, coupée par « … » si elle est longue) et le montant à droite.
- **Journal** : on n'y écrit que des types d'événements, des statuts HTTP, des
  compteurs et des états. Jamais d'identifiant, de mot de passe, de jeton, de nom
  de payeur, de montant ni de description.

## Limites du prototype

- **Un seul commerçant** (celui du compte d'écoute), un seul compte Cyclos par
  commerçant : pas de sous-comptes ni d'opérateurs. Pas de base de
  données : tout est en mémoire et oublié à l'arrêt de l'écoute.
- **Session de la page** : la page garde sa session (20 minutes
  d'inactivité, 8 heures au plus). Au bout de 8 heures, elle ramène à la
  connexion. La session de l'**écouteur** est distincte.
- **État erreur** : l'écoute ne reprend pas toute seule (pour ne pas marteler la
  connexion). Fermer la page environ une minute, puis la rouvrir, relance l'écoute.
- **Mise à jour par le script** : la page n'est plus rechargée, il n'y a donc plus de
  clignotement. Le script interroge `GET /caisse/data` (même session, même contrôle
  d'inscription, même prolongation de l'écoute que `/caisse` ; réponse JSON, jamais mise en cache). Il recalcule « il y a x min » toutes les 15 secondes,
  continue d'interroger quand l'onglet est caché et relit tout de suite au retour au
  premier plan. **Limite connue** : les navigateurs ralentissent les minuteurs d'un onglet
  caché (souvent une lecture par seconde au plus, et jusqu'à une par minute après
  plusieurs minutes de masquage sur certains navigateurs) ; le délai réel est à mesurer
  (voir le test à la main).
  Si le serveur ne répond plus, l'affichage reste en place avec la bannière « Connexion au
  serveur interrompue. » ; une réponse 401 (session expirée) ramène à la connexion.
- **Nouveau paiement (son, notification, fond et marque « Nouveau »)** : un paiement est nouveau quand
  **la page ne l'a pas encore vu**, quelle que soit son origine (direct, filet de sécurité, historique relu
  après un redémarrage de l'écoute). La page retient les clés (numéros de transaction) déjà vues, en
  mémoire seulement : un rechargement de la page oublie tout. Le **premier chargement** n'annonce rien : tout
  ce qui est là est seulement appris, même si le serveur n'a pas fini de lire l'historique (`loaded: false`
  dans `/caisse/data` : la page apprend en silence jusqu'à ce que l'historique soit chargé, pour que les
  anciens paiements ne sonnent jamais). **Risques connus** : (1) deux onglets ouverts ont chacun
  leur mémoire, chacun annonce ; (2) un rechargement de la page efface la mémoire, les paiements
  encore affichés ne sonnent pas (premier chargement) mais un paiement reçu pendant le rechargement est appris
  sans sonner ; (3) si la lecture initiale de l'historique échoue côté serveur (`loaded` reste faux), la
  page apprend en silence jusqu'à son succès ; (4) un ticket sans numéro de transaction ni identifiant de
  notification n'a pas de clé stable et peut être annoncé de nouveau après un redémarrage de l'écoute.
- **Son (actif par défaut)** : le son est **voulu par défaut**. Les navigateurs interdisent
  pourtant tout son avant un geste de l'utilisateur sur la page, à **chaque chargement** : tant
  que l'audio ne tourne pas vraiment, la page écrit « Son en attente : toucher la page pour
  l'activer », et le **premier clic, toucher ou touche du clavier n'importe où** sur la page
  crée ou reprend l'audio (sans bip ; l'écouteur est posé une seule fois et retiré dès que
  l'audio tourne). « Son activé » n'est **jamais** affiché si le navigateur a suspendu l'audio
  (veille, appel, onglet interrompu) : l'état repasse à « en attente » et le geste suivant le
  relance. Le bouton permet de **couper le son** (« Son désactivé : cliquer pour activer ») ; ce
  choix est **mémorisé** dans le navigateur (`localStorage`, toujours dans un `try/catch` : un
  stockage bloqué ou absent n'empêche rien, le son reste alors actif par défaut). Le bip est
  **généré** par Web Audio (deux notes brèves, moins d'une demi-seconde, volume modéré), sans fichier
  audio. Un seul bip par lot de nouveaux paiements, jamais pour le premier chargement de la page. Un navigateur sans Web Audio affiche « Son non disponible sur ce navigateur ».
  Sur certains navigateurs (téléphones surtout), le son d'un onglet caché ou d'un écran verrouillé
  peut être coupé : à vérifier sur le matériel réel.
- **Un seul bouton pour le son et les notifications** : tant que l'un des deux n'est pas actif et
  peut être activé par un clic, le bouton s'appelle « Activer le son et les notifications » : un clic
  débloque l'audio (avec un bip d'essai) **et** demande l'autorisation des notifications, dans le
  même geste. Une fois les deux actifs, il devient « Couper le son ». Ce que le navigateur ne peut
  pas activer n'est pas promis : notifications refusées ou hors HTTPS, le bouton dit « Activer le
  son » ; navigateur sans Web Audio, « Activer les notifications ».
- **Lectures automatiques du script** : avec `CAISSE_POLL_SECONDS` à N, la page lit `/caisse/data` (1) à
  l'ouverture, (2) N secondes après la fin de chaque lecture (minuterie), (3) dès que l'onglet redevient
  visible (retour sur l'onglet ou la fenêtre : un changement de fenêtre pour faire un paiement
  déclenche donc une lecture), (4) au retour du réseau (événement `online`). Il n'y a pas de lecture
  au simple focus de la fenêtre. Devant la page, seule la minuterie joue.
- **Mode manuel (`CAISSE_POLL_SECONDS=0`)** : aucune lecture automatique, ni minuterie, ni retour sur
  l'onglet, ni retour du réseau. Seules la lecture initiale à l'ouverture et le bouton « Actualiser »
  lisent les données. Le bas de page dit « Mise à jour manuelle : cliquer sur Actualiser pour relire
  les paiements. » Pratique pour tester le bouton à la main. Un navigateur sans script recharge
  toujours la page toutes les `CAISSE_REFRESH_SECONDS` secondes.
- **Bouton « Actualiser »** : placé sous la ligne du son, il relit tout de suite `/caisse/data`
  (même session, même contrôle d'inscription) et met la page à jour sans la recharger. La mise à jour
  automatique continue comme avant. Pendant la lecture le bouton est désactivé et affiche
  « Actualisation... ». Si la lecture échoue, la bannière « Connexion au serveur interrompue. »
  apparaît ; une réponse 401 ramène à la connexion. Si une lecture automatique est déjà en cours,
  le clic attend celle-ci au lieu d'en lancer une seconde. Le clic compte comme un geste de
  l'utilisateur (il peut débloquer le son comme les autres clics), mais la détection des nouveaux
  paiements est la même : un paiement déjà affiché ne fait jamais sonner ni notifier. Aucune
  variable de configuration, aucun changement de la CSP.
- **Notifications du navigateur** : si l'autorisation est **déjà accordée** au chargement
  (`Notification.permission` vaut `granted`), elles sont actives tout de suite, sans bouton :
  « Notifications activées ». Sinon la demande d'autorisation se fait **uniquement au clic sur le
  bouton** (voir ci-dessus), jamais automatiquement ni au simple toucher de la page. L'état est écrit en
  toutes lettres : désactivées (avec le bouton), activées, refusées (une phrase explique comment les
  réactiver : cadenas à gauche de l'adresse, autoriser les notifications, recharger la page), ou non
  disponibles (navigateur sans l'API, ou page hors HTTPS). Pour chaque nouveau paiement : titre
  « Paiement reçu : 7,50 G », corps « de Nom du payeur » (« de Client » avec `CAISSE_HIDE_PAYER_NAME=true`),
  **jamais la description ni le numéro de transaction** (une notification peut s'afficher sur un écran
  verrouillé). Le `tag` est propre à chaque paiement : le même paiement ne s'affiche jamais deux
  fois. L'icône est carrée (`/icon.png`). Plus de 3 paiements d'un coup : une seule notification « N nouveaux paiements », sans nom ni montant. Si le montant
  d'un paiement n'est pas encore lu, la notification attend (15 secondes au plus) pour l'afficher
  avec le montant. Elle utilise la même détection que le son : **jamais** pour le premier chargement de la page. Un clic sur la notification ramène l'onglet au premier plan.
  **Limites** :
  - elles ne fonctionnent **que tant que la page est ouverte** (onglet ouvert, même en arrière-plan
    ou réduit) : pas de Web Push, pas de service worker, pas d'appli ;
  - elles exigent **HTTPS ou localhost** : en production, HTTPS est obligatoire (avec
    `COOKIE_SECURE=true`), sans quoi le navigateur les refuse et la page l'écrit ;
  - il faut l'**autorisation du navigateur** (Chrome peut aussi la bloquer pour le site, ou
    la masquer s'il juge les demandes gênantes) et les **réglages de notifications du système**
    (macOS : Réglages Système, Notifications, Chrome ; Windows : Paramètres, Notifications ;
    mode Ne pas déranger ou Concentration inclus) ;
  - sur téléphone, beaucoup de navigateurs refusent l'API Notification depuis une page web : la
    page l'indique ou l'ignore sans erreur, à vérifier sur le matériel réel.
- **Sans JavaScript** : la page rendue par le serveur est complète ; un
  `<meta http-equiv="refresh">` placé dans `<noscript>` la recharge toutes les
  `CAISSE_REFRESH_SECONDS` secondes (il n'y a plus d'en-tête `Refresh`).
- **Remboursements** (`paymentReceivedChargedBack`) : ignorés.
- **À confirmer avec l'instance réelle** (le test réel ci-dessous le fait) : que
  le flux accepte le jeton de session avec le canal `main` (jusqu'ici testé depuis
  un navigateur avec un cookie) ; la forme exacte des événements ; que
  `GET /users/self?fields=id` rend bien l'identifiant utilisateur ; les
  paramètres `direction=credit` et `kinds=payment` de l'historique ; la forme de
  la réponse de `GET /transactions/{id}`.
- **Réglage de notification « paiement reçu »** : le prototype le **lit** (jamais
  modifié) dans `GET /self/notification-settings/data-for-edit`. Sur l'instance
  réelle, les réglages ne sont ni à la racine ni dans `notificationSettings` : ils
  sont dans le tableau `settings.notifications`, dont chaque élément a les champs
  `kind`, `type`, `internal`, `sms`, `email` et `app`. Le réglage voulu est l'élément
  dont `type` vaut `paymentReceived` (`kind` n'est pas filtré), et seul son booléen
  `internal` compte (pas `email` ni `app`). S'il y a plusieurs éléments de ce type,
  le réglage est considéré comme activé dès que l'un a `internal` à `true`. Tableau
  absent ou vide, élément absent, `internal` qui n'est pas un booléen : réglage
  « inconnu », donc mode de secours, avec l'avertissement du terminal (sans donnée
  sensible). Les anciennes formes (racine, `notificationSettings`) ne sont plus lues.

## Test réel avec le compte de test

Ne rien coller dans une conversation qui contienne un nom, un montant, un jeton ou
un identifiant réel : donner seulement des formes agrégées (statuts, noms de
champs, nombres de tickets).

1. **Script de vérification du flux** (`tools/push-smoke.js`, dans cette application). Il ouvre une session, ouvre le flux avec le jeton de session, puis se
   reconnecte avec `Last-Event-ID`, et n'affiche que la structure (statut,
   durée, noms des événements et des clés, jamais une valeur). Pendant qu'il
   écoute (environ une minute par connexion), faire un paiement vers le compte
   pour voir un événement :

   ```sh
   read -s CAISSE_PW
   CAISSE_CYCLOS_LOGIN="..." CAISSE_CYCLOS_PASSWORD="$CAISSE_PW" \
   CYCLOS_CHANNEL=main CYCLOS_BASE_URL="https://laruchedesmonnaieslocales.org/lagraine34/api" node tools/push-smoke.js
   unset CAISSE_PW
   ```

   Attendu : statut 200 avec le jeton de session, `text/event-stream`,
   `:Initialized` reçu, fermeture par Cyclos après environ 41 secondes.
2. Lancer le serveur avec la commande de la section « Activer et lancer la caisse », se connecter
   avec le compte de test, ouvrir `/caisse` : la mention « Connexion à Cyclos en
   cours » disparaît et les derniers paiements s'affichent.
3. Payer 1 G depuis Appligraine vers le compte de test avec une description
   reconnaissable : le ticket doit apparaître en **moins de 7 secondes**, avec
   le bon payeur, le bon montant, la bonne heure et la bonne description, et la
   mention « Nouveau ».
4. Faire deux paiements à quelques secondes d'intervalle : deux tickets, aucun
   doublon.
5. Laisser la page ouverte plusieurs minutes : le journal ne doit montrer aucune
   erreur (les fermetures à 41 secondes sont silencieuses).
6. Fermer l'onglet et attendre environ une minute : le journal indique
   « écoute arrêtée (inactivité) ». Rouvrir : les paiements réapparaissent par
   l'historique.
7. Ouvrir la page sur deux appareils en même temps : un seul « écoute démarrée »
   dans le journal.
8. Facultatif, test de rattrapage : couper le réseau du serveur environ 2
   minutes, faire un paiement, rétablir : le ticket doit apparaître, par le
   rejeu de Cyclos ou par le filet de sécurité (noter lequel).

## Tests

```sh
npm test
```

Les tests utilisent `node:test` (rien à installer) et durent quelques secondes. Le script lance uniquement les
fichiers `test/*.test.js` : le dossier `test/support/` ne contient pas de tests. Ils
démarrent le vrai serveur sur un port libre face à un **faux Cyclos** local
(`test/support/fake-cyclos.js`) : aucun appel à un service externe, aucun vrai
identifiant (ceux des tests sont fictifs).

- Étape B : `test/new-payments.test.js` (détection), `test/date-line.test.js`
  (date et âge), `test/caisse-view.test.js` (affichage, avec un faux `document`),
  `test/caisse-script.test.js` (minuteries et réseau du script), `test/caisse-data.test.js`
  (`/caisse/data` et fichiers servis).
- Étape E : `test/controls-logic.test.js` (le bouton unique) ; les tests du son et des notifications
  ci-dessous couvrent aussi l'état « en attente », le geste, la mémorisation et le stockage bloqué.
- Mode manuel, détection « vu par la page », attente de la lecture initiale, nom du payeur, description :
  `test/new-payments.test.js`, `test/listener-manager.test.js` (`touchAndWait`), `test/ticket-store.test.js`,
  `test/caisse-data.test.js`, `test/caisse-script.test.js`.
- Étape F : `test/refresh-logic.test.js` (libellé du bouton « Actualiser », rythme et mode manuel) ; le bouton dans la vue et dans le
  script est couvert par `test/caisse-view.test.js` et `test/caisse-script.test.js`.
- Étape C : `test/sound-logic.test.js` (quand sonner), `test/sound.test.js` (audio, avec un faux
  `AudioContext`) ; le son dans le script est couvert par `test/caisse-script.test.js`.
- Étape D : `test/notification-logic.test.js` (regroupement, tag, texte, attente du montant),
  `test/notification.test.js` (API du navigateur, avec une fausse API) ; les notifications dans le
  script sont couvertes par `test/caisse-script.test.js`.
- Caisse : `test/caisse-config.test.js` (variables), `test/sse-parser.test.js`
  (flux), `test/cyclos-push.test.js` (appels Cyclos), `test/ticket-store.test.js`
  (tickets), `test/cyclos-listener.test.js` (boucle d'écoute),
  `test/payment-processor.test.js` (événements et filet de sécurité),
  `test/listener-manager.test.js` (cycle de vie), `test/caisse.test.js` (page et route).
- Socle copié de la mission 2A et adapté : `test/connexion.test.js` (connexion,
  sessions, CSRF), `test/securite.test.js` (en-têtes, CSP, cache, taille des
  requêtes), `test/statique.test.js` (fichiers statiques), `test/demarrage.test.js`
  (démarrage réel), `test/unit.test.js` (`escapeHtml`, `formatAmount`).
- Racine `/` : `test/racine.test.js`.
- Espace commerçants : `test/espace.test.js` (connexion, refus uniforme, déconnexion, lien interne du relevé, freins, séparation des cookies) ;
  `test/connexion-unique.test.js` (bouton vers la caisse sans mot de passe, refus, jeton partagé, arrêt de l'écoute, texte de la page) ;
  `test/caisse-config.test.js` (l'ancien réglage `ESPACE_RELEVE_URL` n'est plus lu).
- Relevé : `test/releve-calcul.test.js` (plages de dates, changement d'heure, montants exacts, totaux, ticket : fonctions pures, portés
  de l'outil d'origine avec les mêmes attentes), `test/cyclos-statement.test.js` (lecture Cyclos : pagination, crédits et débits,
  plafond, « Non disponible », erreurs), `test/releve.test.js` (pages, session et jeton de l'espace, origine, CSRF, une lecture à la fois,
  politique de sécurité sans script, impression, 404 hors mode multi), `test/releve-pdf.test.js` (PDF, texte du PDF, mêmes contrôles),
  `test/releve-mois.test.js` (mode mois : bornes de février à décembre, changements d'heure, valeurs refusées, mois en cours et futur,
  plafond propre au mois, PDF de 1500 lignes), `test/releve-contrepartie.test.js` (nom de la contrepartie).
- Un test lancé seul : `node --test test/caisse.test.js`.

## Sécurité en bref

- **Pas de mot de passe conservé par la page** (mode `npm start`) : l'identifiant et le mot de passe
  servent une seule fois, à la connexion, pour obtenir un jeton de session Cyclos. Dans l'exécutable,
  le mot de passe est gardé en mémoire, dans la session, le temps de celle-ci (voir « Exécutable »).
  Le navigateur reçoit un identifiant de session aléatoire sans rapport avec le
  jeton, dans un cookie `HttpOnly` + `SameSite=Lax`.
- **Sessions** : fermées à la déconnexion (le jeton est aussi fermé côté Cyclos),
  après 20 minutes d'inactivité, ou au bout de 8 heures.
- **CSRF** : chaque session a un jeton aléatoire exigé sur `POST /deconnexion`
  (comparaison à temps constant) ; la connexion vérifie l'en-tête `Origin` (ou
  `Referer`).
- **En-têtes** : Content-Security-Policy stricte (`default-src 'none'`, avec
  seulement `script-src 'self'` et `connect-src 'self'` en plus ; pas de script ni de
  style en ligne, pas d'`eval`, rien d'externe), `X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Cache-Control: no-store` sur les
  pages, HSTS avec `COOKIE_SECURE=true`.
- **Voir le mot de passe** : sur les pages de connexion (espace, caisse, et la page de l'exécutable, qui est la même), un petit
  bouton en forme d'œil, **créé par JavaScript** (`web/js/password-toggle.js`, servi comme les autres modules et embarqué dans
  l'exécutable) : sans JavaScript, aucun bouton mort n'apparaît et la connexion marche comme avant. Un clic bascule le champ entre
  `type="password"` et `type="text"` ; la valeur n'est jamais lue, copiée, stockée ni journalisée, et les attributs `autocomplete`
  ne changent pas (les gestionnaires de mots de passe continuent de marcher). Le champ redevient masqué à l'envoi, quand l'onglet est
  caché et au retour par l'historique du navigateur. Le bouton se nomme « Afficher le mot de passe » / « Masquer le mot de passe »
  (`aria-pressed`), fait 44 px et se commande au clavier. Ces pages avaient déjà `script-src 'self'` : la politique de sécurité ne
  change pour aucune page, et le module n'est chargé que par les pages de connexion.
- **Limites** : 5 échecs de connexion par adresse IP et par 15 minutes (puis 429) ;
  corps des requêtes limité à 10 ko ; toutes les valeurs venant de Cyclos sont échappées.
- **Page caisse** : le mot de passe du compte d'écoute vient uniquement de
  l'environnement et n'est jamais mis dans l'objet de configuration ni dans le
  journal ; le visiteur doit être le même utilisateur Cyclos que le compte d'écoute
  (comparé par identifiant, jamais par nom) et l'écoute n'existe que pendant que la
  page est ouverte ; le journal ne contient ni identifiant, ni jeton, ni nom de
  payeur, ni montant, ni description. Côté navigateur, les textes venant de Cyclos
  ne sont posés qu'avec `textContent`, jamais comme du HTML ; `/caisse/data` ne
  contient ni jeton, ni identifiant Cyclos (les clés des tickets sont opaques).

## Limites connues

- **Adresse IP derrière un proxy** : le compteur d'échecs de connexion utilise
  l'adresse du pair TCP ; derrière un proxy inverse, tous les utilisateurs
  partagent le même compteur.
- **Sessions perdues au redémarrage** : sessions, compteurs et tickets sont en mémoire.
- **Instance unique** : pas de partage d'état entre plusieurs processus.
- **Compte professionnel et canal `main`** : sans l'en-tête `Channel: main`
  (`CYCLOS_CHANNEL=main`), Cyclos répond 403 ou 404 à un compte professionnel.
  Le canal prévu pour un outil externe reste à confirmer avec Cylaos.

## Avant la mise en production

- [ ] Servir **uniquement en HTTPS** (le serveur parle HTTP simple : le placer
      derrière un proxy inverse qui termine TLS) et définir `COOKIE_SECURE=true`.
- [ ] Définir `CYCLOS_BASE_URL` vers le Cyclos de production (et pas la démo).
- [ ] Régler le proxy : en-têtes transmis, taille des corps (10 ko au moins), délais.
- [ ] Lancer le processus sous un service qui le redémarre, avec un utilisateur sans
      privilèges, et surveiller sa sortie.
- [ ] Laisser la page désactivée tant que Cylaos n'a pas été prévenu de la charge
      (une connexion longue par commerçant, une requête par minute) et n'a pas
      confirmé le canal et le client d'accès à utiliser.
- [ ] Lancer `npm audit` avant chaque mise en production, puis `npm test`.

## Licences

Les polices Roboto et Voltaire servies par l'outil (`web/fonts/`) sont sous licence SIL
Open Font License 1.1 : voir [web/fonts/LICENSES.txt](web/fonts/LICENSES.txt). Le logo est
celui de La Graine 34.
