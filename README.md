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

(équivalent de `node server.js`, avec en plus la lecture de `.env` s'il existe.)
Puis ouvrir <http://localhost:3001> (port **3001** par défaut, pour ne pas gêner
l'outil de relevé qui garde le 3000). Après la connexion, le navigateur arrive sur
`/caisse`. La page est **désactivée par défaut** (voir « Activer et lancer la caisse »).

Les variables peuvent se mettre dans un fichier `.env` (copier
[.env.example](.env.example) en `.env`) : `npm start` le lit s'il existe, `node
server.js` seul et `npm test` ne le lisent pas, une variable placée devant la
commande l'emporte sur le fichier, et `.env` est ignoré par git (ne jamais le
commiter).

## Scripts

| Commande | Effet |
| --- | --- |
| `npm start` | Démarre le serveur (`node --env-file-if-exists=.env server.js`) |
| `npm test` | Lance les tests (`node --test`), sans appel à un vrai Cyclos |

## Arborescence

```
server.js            serveur HTTP : connexion, sessions, /caisse, déconnexion, statiques
caisse-config.js     lecture et validation des variables CAISSE_*
sse-parser.js        analyseur du flux d'événements Cyclos (SSE), sans accès réseau
cyclos-push.js       appels Cyclos : flux, transfert, historique, réglage
ticket-store.js      tickets en mémoire : modèle, doublons, tri, état
cyclos-listener.js   boucle d'écoute d'un commerçant : réouverture, chien de garde, reconnexion
payment-processor.js événements reçus, tickets, filet de sécurité par l'historique
listener-manager.js  cycle de vie des écouteurs : inscription, inactivité, plafond, arrêt
caisse-page.js       HTML de la page /caisse (fonctions pures), complète sans script
caisse-data.js       bannière, textes d'un ticket et JSON de /caisse/data (fonctions pures)
caisse-texts.js      textes fixes de la page, partagés avec le navigateur
caisse.js            script du navigateur : lecture toutes les N secondes, minuteries, réseau
caisse-view.js       script du navigateur : construit l'affichage (textContent, jamais de HTML brut)
new-payments.js      détection des nouveaux paiements (fonction pure, servira au son et à la notification)
date-line.js         ligne de date et décalage d'horloge (fonctions pures)
age.js               « il y a x min » (fonction pure, utilisée par le serveur et le navigateur)
sound-logic.js       quand sonner et que dire de l'état du son, son voulu par défaut (fonctions pures)
controls-logic.js    le bouton unique du son et des notifications : libellé et action (fonctions pures)
refresh-logic.js     le bouton « Actualiser » : libellé et état désactivé (fonctions pures)
sound.js             le son : Web Audio, bip généré, aucun fichier audio
notification-logic.js  quoi notifier et que dire de l'état (regroupement, tag, texte : fonctions pures)
notification.js      notifications du navigateur : le seul fichier qui touche à l'API Notification
style.css            feuille de style unique (charte La Graine 34, classes de la caisse comprises)
logo-lagraine34.png  logo, servi sur /logo.png
icon-lagraine34.png  icône carrée, servie sur /icon.png (favicon des pages et icône des notifications)
fonts/               polices Roboto et Voltaire (woff2) et leurs licences
test/                tests (node:test)
test-support/        faux Cyclos, harnais de test, options communes
test-cyclos/         push-smoke.js : script de vérification du flux, à lancer à la main
.env.example         modèle du fichier `.env`
```

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
| `CAISSE_ACCOUNT_TYPE` | Type de compte à lire (par exemple `MonComptePro`) ; lettres, chiffres, `.`, `-`, `_` | découverte automatique |
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

1. **Script de vérification du flux** (`test-cyclos/push-smoke.js`, dans cette application). Il ouvre une session, ouvre le flux avec le jeton de session, puis se
   reconnecte avec `Last-Event-ID`, et n'affiche que la structure (statut,
   durée, noms des événements et des clés, jamais une valeur). Pendant qu'il
   écoute (environ une minute par connexion), faire un paiement vers le compte
   pour voir un événement :

   ```sh
   cd test-cyclos
   read -s CAISSE_PW
   CAISSE_CYCLOS_LOGIN="..." CAISSE_CYCLOS_PASSWORD="$CAISSE_PW" \
   CYCLOS_CHANNEL=main CYCLOS_BASE_URL="https://laruchedesmonnaieslocales.org/lagraine34/api" node push-smoke.js
   unset CAISSE_PW
   cd ..
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

Les tests utilisent `node:test` (rien à installer) et durent quelques secondes. Ils
démarrent le vrai serveur sur un port libre face à un **faux Cyclos** local
(`test-support/fake-cyclos.js`) : aucun appel à un service externe, aucun vrai
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
- Un test lancé seul : `node --test test/caisse.test.js`.

## Sécurité en bref

- **Pas de mot de passe conservé par la page** : l'identifiant et le mot de passe
  servent une seule fois, à la connexion, pour obtenir un jeton de session Cyclos.
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

Les polices Roboto et Voltaire servies par l'outil (`fonts/`) sont sous licence SIL
Open Font License 1.1 : voir [fonts/LICENSES.txt](fonts/LICENSES.txt). Le logo est
celui de La Graine 34.
