# Mode multi-commerçants de la caisse

Ce document explique, simplement, le mode où **chaque commerçant ouvre la page `/caisse` avec son propre compte Cyclos**, au lieu d'un seul compte d'écoute réglé dans le `.env`.

Les valeurs données en exemple sont inventées.

## En bref

- Désactivé par défaut. Sans `CAISSE_MULTI_MERCHANT=true`, rien ne change : un seul compte d'écoute, comme avant.
- Le commerçant se connecte sur la page d'accueil avec son identifiant et son mot de passe Cyclos. Le serveur ne garde **jamais** le mot de passe : il sert à deux demandes à Cyclos (un jeton pour la page, un jeton pour l'écoute), puis il est oublié. Il n'est ni écrit dans un fichier, ni dans le journal, ni renvoyé dans une page.
- Peut ouvrir la caisse tout membre qui possède un compte dont le type interne est exactement **`MonComptePro`** (les commerçants). Les particuliers, qui n'ont que `monCompte` et `compteurBonus`, sont refusés. La liste `CAISSE_ALLOWED_USERS` est **facultative** : si elle est remplie, elle restreint (il faut y figurer ET avoir `MonComptePro`), elle n'élargit jamais.
- Chaque commerçant a sa propre écoute : il ne voit jamais les paiements, le bilan d'hier ou l'état d'un autre.
- L'**exécutable** (version à lancer sur un poste) reste mono-commerçant. Ce mode n'y existe pas : le réglage est ignoré et le démarrage l'indique (« Mode multi-commerçants ignoré : l'exécutable reste mono-commerçant »).
- Le canal Cyclos reste `main`. Le démarrage affiche toujours « Canal Cyclos : main ».

## Les réglages (dans le `.env`)

| Réglage | Rôle | Défaut |
|---|---|---|
| `CAISSE_ENABLED` | Active la page caisse (comme avant) | `false` |
| `CAISSE_MULTI_MERCHANT` | Active le mode multi-commerçants | `false` |
| `CAISSE_ALLOWED_USERS` | Liste facultative qui restreint (voir plus bas) | vide, donc tout membre avec `MonComptePro` |
| `CAISSE_TRUSTED_PROXY_HOPS` | Nombre de relais de confiance devant le serveur (voir plus bas) | `0` |
| `CAISSE_MAX_LISTENERS` | Nombre maximal de commerçants écoutés en même temps (1 à 200) | `30` dans ce mode |

Dans ce mode, `CAISSE_CYCLOS_LOGIN` et `CAISSE_CYCLOS_PASSWORD` ne servent plus et sont ignorés : il n'y a pas de compte d'écoute commun. Les autres réglages `CAISSE_*` (rythme, nombre de paiements gardés, nom du payeur...) s'appliquent à tous les commerçants.

Exemple minimal pour un test local :

```
CAISSE_ENABLED=true
CAISSE_MULTI_MERCHANT=true
CAISSE_ALLOWED_USERS=1234567890123456789,2345678901234567890
CAISSE_TRUSTED_PROXY_HOPS=0
CYCLOS_BASE_URL=https://ADRESSE-DE-LINSTANCE/api
CYCLOS_CHANNEL=main
```

Aucun mot de passe n'a sa place dans ce fichier.

## La règle d'accès : MonComptePro, et la liste si elle existe

Après une connexion Cyclos réussie, le serveur lit les comptes du membre (`GET /self/accounts`, canal `main`) et cherche un compte dont le **type interne** (`type.internalName`) est exactement `MonComptePro`. La comparaison porte sur ce type interne, jamais sur le nom affiché : le compte « Mon Compte Pro Billets » est d'un autre type et ne compte pas. Le groupe Cyclos n'est pas utilisé (un compte membre n'a pas le droit de le lire).

| `CAISSE_ALLOWED_USERS` | Membre avec `MonComptePro` | Membre sans `MonComptePro` |
|---|---|---|
| vide | accepté | refusé |
| remplie, membre dans la liste | accepté | refusé |
| remplie, membre hors liste | refusé | refusé |

Fermé par défaut : sans `MonComptePro`, ou si Cyclos refuse (403) la lecture des comptes, le membre reçoit le refus habituel. Si Cyclos est en panne ou injoignable pendant cette lecture, il reçoit « Cyclos ne répond pas, réessayez dans un moment » (502), qui ne dit rien de lui. Dans tous les cas la session Cyclos ouverte pour le contrôle est fermée. Un 403 ou une panne ne comptent pas comme un échec du membre dans le frein de connexion. La règle est la même pour `/caisse`, `/espace` et le bouton « Notifications de caisse » de l'espace. Elle ne change rien sans `CAISSE_MULTI_MERCHANT=true` et dans les exécutables mono-commerçant.

### La liste facultative

`CAISSE_ALLOWED_USERS` est une liste séparée par des virgules. Pour chaque commerçant, au choix :

- son **numéro interne Cyclos** (voie principale) : par exemple `1234567890123456789`. Ces numéros ont 19 chiffres. Ils sont toujours traités comme du **texte**, jamais comme un nombre, donc deux numéros qui ne diffèrent que par les derniers chiffres ne sont jamais confondus ;
- ou son **adresse e-mail** : par exemple `marie@exemple.test`. La comparaison ignore les majuscules et les espaces autour. Cette voie dépend de ce que Cyclos renvoie pour le profil : si l'adresse n'est pas fournie, seul le numéro interne compte.

Un commerçant est autorisé si son numéro **ou** son e-mail est dans la liste. Les deux sortes peuvent être mélangées. Une liste vide ne restreint personne (c'est alors `MonComptePro` seul qui décide). Une identité illisible est toujours refusée.

### Où trouver le numéro interne dans Cyclos

1. Dans l'administration Cyclos (adresse `.../lagraine34/classic`), ouvrir **Utilisateurs**, puis la fiche du membre.
2. Le numéro interne est le long nombre à la fin de l'adresse du navigateur, juste après `profile!id=`.

Cette méthode a été vérifiée : pour le compte de test, le nombre lu dans l'adresse est identique à l'id renvoyé par l'API (`GET /users/self`).

Attention : le champ « Identifiant » affiché dans la fiche (par exemple un numéro à 8 chiffres) est un autre numéro. Il ne marche pas dans `CAISSE_ALLOWED_USERS`.

Rappel : la liste est facultative. Sans liste, tout membre avec un compte `MonComptePro` est accepté. La liste sert seulement à restreindre.

### Après un changement de liste : redémarrer

La liste est lue **une seule fois, au démarrage**. Après toute modification de `CAISSE_ALLOWED_USERS` dans le `.env` :

1. enregistrer le `.env` ;
2. arrêter le serveur ;
3. le relancer (`npm start`).

Sans redémarrage, l'ancienne liste reste en vigueur. Un commerçant déjà connecté garde sa session jusqu'à sa fin ; la liste est vérifiée à la connexion.

## Lire le journal

### Un compte refusé

Quand un compte est refusé (absent de la liste, ou sans compte `MonComptePro`), il voit « Ce compte n'est pas autorisé à ouvrir la caisse » (erreur 403) et le journal du serveur écrit :

```
Caisse : compte refusé (absent de CAISSE_ALLOWED_USERS), numéro interne Cyclos : 1234567890123456789
Caisse : compte refusé (pas de compte MonComptePro), numéro interne Cyclos : 1234567890123456789
Caisse : compte refusé (lecture des comptes interdite par Cyclos), numéro interne Cyclos : 1234567890123456789
```

Pour autoriser un commerçant refusé par la liste : copier le numéro dans `CAISSE_ALLOWED_USERS`, puis redémarrer (ou vider la liste). Un refus « pas de compte MonComptePro » ne se règle pas par la liste : le membre doit avoir ce type de compte dans Cyclos. Le journal ne donne que ce numéro (jamais l'e-mail, ni l'identifiant tapé, ni le mot de passe). Aucune écoute n'est ouverte pour un compte refusé, et il n'y a pas de nouvel essai automatique.

### L'adresse lue et `CAISSE_TRUSTED_PROXY_HOPS`

Les limites de connexion comptent les essais **par adresse**. Derrière un relais (le reverse proxy de l'hébergeur), toutes les visites semblent venir du relais, sauf si le serveur lit l'adresse du visiteur dans l'en-tête `X-Forwarded-For`. À chaque connexion, le journal écrit une ligne comme :

```
adresse lue 203.0.113.5 (X-Forwarded-For, adresse de la connexion 10.0.0.9, 1 entrée(s) X-Forwarded-For, relais de confiance 1)
```

Comment la lire :

- **adresse lue** : celle qui sert aux limites. Ce doit être l'adresse du visiteur (publique), pas celle du relais.
- **adresse de la connexion** : celle de la machine qui parle au serveur (le relais).
- **entrée(s) X-Forwarded-For** : combien d'adresses l'en-tête contenait.
- **relais de confiance** : la valeur de `CAISSE_TRUSTED_PROXY_HOPS`.

Réglage :

- `0` (défaut) : l'en-tête est ignoré. Convient sans relais. Derrière un relais, tous les visiteurs partagent alors la même adresse et se gêneraient mutuellement.
- `1` : un relais de confiance devant le serveur (cas probable chez l'hébergeur). Le serveur prend la dernière adresse de l'en-tête, celle que le relais a ajoutée.
- `2` ou plus : autant de relais en chaîne.

Si l'en-tête est absent, trop court ou illisible, le serveur retombe sur l'adresse de la connexion. Il n'utilise jamais une adresse écrite par le visiteur lui-même. **Après un vrai test sur le site déployé**, vérifier la ligne du journal et ajuster la valeur jusqu'à ce que « adresse lue » soit bien celle du visiteur.

## Les limites

- **Mots de passe refusés** : 5 par identifiant tapé sur 15 minutes, et 10 par adresse sur 15 minutes. Au-delà : message « trop de tentatives » avec le temps d'attente, sans appeler Cyclos. Un compte non autorisé qui insiste est compté de la même façon. Ces limites protègent aussi le compte du commerçant contre un blocage côté Cyclos. Contrepartie : quelqu'un qui tape de faux mots de passe pour un identifiant peut le bloquer 15 minutes.
- **Disjoncteur Cyclos** : après 5 pannes de Cyclos (réponse 429, erreur 5xx, réseau) en 30 secondes, les connexions sont suspendues 1 minute sans appeler Cyclos. Après la pause, une seule nouvelle panne suffit à suspendre de nouveau.
- **Écoutes simultanées** : 30 par défaut (`CAISSE_MAX_LISTENERS`). Au-delà, un nouveau commerçant reçoit « Caisse très sollicitée » (503) et peut réessayer. Les commerçants déjà écoutés ne sont pas touchés.
- **Démarrages** : au plus 3 écoutes chargent leur premier historique en même temps, les autres attendent leur tour (leur page affiche « Connexion à Cyclos en cours »).
- **Deux connexions Cyclos par connexion** d'un commerçant (le jeton de la page et celui de l'écoute). Un compte refusé par la liste n'en fait qu'une, refermée aussitôt.
- **Plusieurs onglets ou tablettes** du même commerçant partagent une seule écoute.
- **Sans visite** pendant `CAISSE_IDLE_SECONDS` (45 s par défaut), l'écoute s'arrête et ses données sont oubliées. La session reste ouverte et la visite suivante relance l'écoute.

## Quand la session expire

- **Inactivité ou durée maximale** (`SESSION_IDLE_MINUTES`, 20 min par défaut ; `SESSION_MAX_HOURS`, 8 h par défaut) : la session se termine, les deux jetons sont fermés chez Cyclos et l'écoute s'arrête. Le commerçant est renvoyé vers la page de connexion.
- **Déconnexion** : les deux jetons de cette session sont fermés. L'écoute s'arrête s'il ne reste aucune autre session du même commerçant. S'il en reste une (autre tablette), l'écoute repart avec le jeton de cette autre session.
- **Jeton refusé par Cyclos** (il a expiré chez Cyclos, par exemple après une longue durée) : la durée de vie du jeton n'a été mesurée que jusqu'à 92 minutes. Au premier refus, le serveur essaie une seule fois un autre jeton du même commerçant s'il y en a un, sinon l'écoute s'arrête. La page affiche alors **« Session expirée, reconnectez-vous »** avec un lien « Se reconnecter », et cesse de se rafraîchir toute seule. Il n'y a aucun nouvel essai en boucle. Se reconnecter ouvre de nouveaux jetons et relance l'écoute.
- Le fait que Cyclos soit lent ou en panne n'est pas une session expirée : l'écoute essaie de se reconnecter avec des pauses de plus en plus longues.

## L'espace commerçants (`/espace`)

Une page d'entrée qui regroupe les outils du commerçant. Elle n'existe que dans ce mode : sans `CAISSE_MULTI_MERCHANT=true`, toutes les adresses `/espace` répondent 404 (elle a besoin de la liste blanche, des freins et du réglage des relais, qui n'existent que dans ce mode).

Ce que voit le commerçant :

1. `GET /espace` sans session : un formulaire (identifiant Cyclos, mot de passe).
2. Il se connecte (`POST /espace/connexion`). Le serveur vérifie le compte auprès de Cyclos (canal `CYCLOS_CHANNEL`, `main`), lit son numéro interne et son e-mail, contrôle `CAISSE_ALLOWED_USERS` si elle est remplie, puis la présence d'un compte `MonComptePro`. Le mot de passe sert à **un seul** appel à Cyclos (le jeton de session) puis il est oublié : jamais gardé, jamais écrit dans le journal.
3. Si le compte est autorisé : la page avec deux entrées, « Notifications de caisse » (un bouton, voir plus bas) et « Relevé de transactions » (un lien vers `/espace/releve`, même session, aucune seconde connexion).
4. Le bouton « Notifications de caisse » envoie `POST /espace/caisse` : le commerçant arrive sur `/caisse` sans retaper son mot de passe.
5. `POST /espace/deconnexion` ferme la session de l'espace (et le jeton chez Cyclos si plus rien ne l'utilise, voir plus bas).

Points à connaître :

- **Même message dans tous les refus** : mauvais mot de passe, compte inconnu, compte valide mais absent de la liste, liste vide. La page répond 401 avec « Identifiants incorrects ou accès non autorisé. ». Le visiteur ne peut donc pas savoir qui est sur la liste. Le journal du serveur, lui, garde la ligne « compte refusé ... numéro interne Cyclos : ... » décrite plus haut, pour l'administrateur.
- **L'adresse racine `/` mène à l'espace** : dans ce mode, ouvrir `/` (GET ou HEAD) redirige vers `/espace` (redirection temporaire 307, que le navigateur ne mémorise pas), y compris pour un commerçant déjà connecté à `/caisse`. Le formulaire de connexion de `/caisse` reste accessible sur `/connexion` ; les liens « Retour », la déconnexion de la caisse et le lien « Se reconnecter » y mènent. Sans ce mode, et dans l'exécutable, `/` reste le formulaire de connexion, comme avant.
- **Du bouton à la caisse sans mot de passe** : `POST /espace/caisse` exige l'origine du site et le jeton CSRF de la session de l'espace (sans JavaScript : la politique de sécurité de la page l'interdit). Le serveur interroge de nouveau Cyclos avec le jeton de l'espace : si Cyclos le refuse, la session de l'espace se termine et le commerçant se reconnecte ; si le compte n'a plus de compte `MonComptePro` (ou n'est plus dans `CAISSE_ALLOWED_USERS`, quand elle est remplie), réponse 403. Sinon il crée la session de `/caisse` (cookie `session`, jeton CSRF propre) avec ce même jeton Cyclos, pour la page comme pour l'écoute, et redirige vers `/caisse`. Le mot de passe n'est jamais conservé : il a servi à un seul appel au moment de la connexion à l'espace. Si ce navigateur a déjà une session de caisse du même commerçant, elle est gardée telle quelle. La connexion à l'espace seule n'ouvre aucune écoute ; elle démarre à la première visite de `/caisse`.
- **Le jeton Cyclos est partagé, il est fermé par la dernière session qui le détient.** Les cookies et les sessions locales restent séparés (`espace_session` limité à `/espace`, `session` pour la caisse), seul le jeton Cyclos est commun. Au moment où une session locale se termine (déconnexion, expiration, jeton refusé), le serveur regarde si une autre session locale détient encore ce jeton : si oui, il ne le ferme pas chez Cyclos ; sinon il le ferme. Conséquences :
  - déconnexion de la caisse : l'écoute s'arrête, la session de caisse se termine, **l'espace reste connecté** et le jeton reste ouvert pour lui ;
  - déconnexion de l'espace : la caisse **reste ouverte** (elle a sa propre session et sa propre durée), le jeton reste ouvert pour elle et se ferme avec elle ;
  - les deux sessions expirent : le jeton est fermé une seule fois ;
  - arrêt de l'écoute pour inactivité (`CAISSE_IDLE_SECONDS`, 45 secondes sans visite de `/caisse`) : en mode multi-commerçants l'écoute n'emprunte que le jeton et ne le ferme pas, donc rien n'est fermé et l'espace n'est pas touché ; la prochaine visite relance l'écoute avec le même jeton, sans nouvelle connexion ; la session de caisse inactive finit par expirer (`SESSION_IDLE_MINUTES`) et libère le jeton.
  - Rien n'est fermé deux fois et aucun jeton ne reste ouvert quand plus aucune session locale ne l'utilise. Un jeton que Cyclos a lui-même fait expirer est découvert au prochain clic sur le bouton (retour à la connexion de l'espace) ou, pour l'écoute, par l'état « reconnexion nécessaire » déjà décrit.
- **Mêmes freins que les autres connexions**, avec les mêmes compteurs (un refus sur `/connexion` compte aussi sur `/espace`), la même lecture de l'adresse (`CAISSE_TRUSTED_PROXY_HOPS`, même ligne « adresse lue » dans le journal), les mêmes durées de session et les mêmes en-têtes de sécurité.
- **Liste modifiée** : comme pour la caisse, elle est lue au démarrage ; redémarrer après un changement.

Le réglage `ESPACE_RELEVE_URL` n'existe plus : le relevé fait partie du site (`/espace/releve`). S'il figure encore dans un environnement, il est ignoré.

## Le relevé de transactions (`/espace/releve`)

Le ticket de fin de service, ouvert depuis l'espace. **Une seule connexion** : il lit chez Cyclos avec le jeton de la session de l'espace
(`espace_session`, jeton CSRF de cette session), sans second formulaire ni mot de passe. Même mode que l'espace : sans
`CAISSE_MULTI_MERCHANT=true`, `/espace/releve` répond 404, et il n'est pas dans l'exécutable.

- `GET /espace/releve` : les filtres (début, fin, raccourcis `?preset=aujourdhui|hier|6h`). `POST /espace/releve/ticket` : le ticket
  à l'écran. `POST /espace/releve/ticket.pdf` : le PDF. Chaque POST exige l'origine du site et le jeton CSRF de la session de l'espace ;
  les données sont relues chez Cyclos à chaque demande (rien ne vient du navigateur que les deux dates).
- **Une lecture à la fois par session** (429 sinon) et une lecture limitée à 60 secondes : jusqu'à une douzaine d'appels Cyclos de suite,
  et le PDF relit tout.
- Un 401 de Cyclos ferme la session de l'espace (retour à `/espace`), comme le bouton de la caisse. La déconnexion se fait depuis l'espace.
- Pages sans aucun script (politique de sécurité sans `script-src` ni `connect-src` sur `/espace/releve*`).
- Réglages : `HISTORY_PAGE_SIZE` (200 lignes par page) et `HISTORY_MAX_ROWS` (2000 lignes au plus). Au-delà du plafond, la liste est
  coupée aux plus récentes avec un avertissement. Sans totaux donnés par Cyclos (le cas de l'instance réelle), ils sont calculés si
  la liste est complète, sinon « Non disponible » (jamais un total inventé).
- **Compte lu.** Un commerçant peut avoir plusieurs comptes. Le relevé et la caisse lisent le même : dans `GET /self/accounts`, le
  compte de type `MonComptePro`, sinon `monCompte`, sinon le premier de la liste, quel que soit l'ordre donné par Cyclos
  (constante `PREFERRED_ACCOUNT_TYPES` dans `src/cyclos-push.js`). Il n'y a pas de choix de compte à l'écran, et le ticket ne dit
  pas lequel est lu.
- Le détail (heure de Paris, changement d'heure, PDF en Helvetica, impression 80 mm) est dans le README, « Relevé de transactions ».

## Ce qui n'est pas dans ce mode

- Pas de mémoire du mot de passe, donc pas de reconnexion automatique après expiration du jeton : le commerçant se reconnecte lui-même.
- Pas de liste blanche par groupe Cyclos : le groupe n'est pas lisible avec les droits d'un commerçant.
- Pas d'exécutable multi-commerçants (l'espace commerçants et le relevé n'y existent donc pas non plus).
