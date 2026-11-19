# Mode multi-commerçants de la caisse

Ce document explique, simplement, le mode où **chaque commerçant ouvre la page `/caisse` avec son propre compte Cyclos**, au lieu d'un seul compte d'écoute réglé dans le `.env`.

Les valeurs données en exemple sont inventées.

## En bref

- Désactivé par défaut. Sans `CAISSE_MULTI_MERCHANT=true`, rien ne change : un seul compte d'écoute, comme avant.
- Le commerçant se connecte sur la page d'accueil avec son identifiant et son mot de passe Cyclos. Le serveur ne garde **jamais** le mot de passe : il sert à deux demandes à Cyclos (un jeton pour la page, un jeton pour l'écoute), puis il est oublié. Il n'est ni écrit dans un fichier, ni dans le journal, ni renvoyé dans une page.
- Seuls les comptes de la **liste blanche** peuvent ouvrir la caisse. Les simples clients sont refusés.
- Chaque commerçant a sa propre écoute : il ne voit jamais les paiements, le bilan d'hier ou l'état d'un autre.
- L'**exécutable** (version à lancer sur un poste) reste mono-commerçant. Ce mode n'y existe pas : le réglage est ignoré et le démarrage l'indique (« Mode multi-commerçants ignoré : l'exécutable reste mono-commerçant »).
- Le canal Cyclos reste `main`. Le démarrage affiche toujours « Canal Cyclos : main ».

## Les réglages (dans le `.env`)

| Réglage | Rôle | Défaut |
|---|---|---|
| `CAISSE_ENABLED` | Active la page caisse (comme avant) | `false` |
| `CAISSE_MULTI_MERCHANT` | Active le mode multi-commerçants | `false` |
| `CAISSE_ALLOWED_USERS` | Liste blanche (voir plus bas) | vide, donc **personne** |
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

## La liste blanche : qui peut ouvrir la caisse

`CAISSE_ALLOWED_USERS` est une liste séparée par des virgules. Pour chaque commerçant, au choix :

- son **numéro interne Cyclos** (voie principale) : par exemple `1234567890123456789`. Ces numéros ont 19 chiffres. Ils sont toujours traités comme du **texte**, jamais comme un nombre, donc deux numéros qui ne diffèrent que par les derniers chiffres ne sont jamais confondus ;
- ou son **adresse e-mail** : par exemple `marie@exemple.test`. La comparaison ignore les majuscules et les espaces autour. Cette voie dépend de ce que Cyclos renvoie pour le profil : si l'adresse n'est pas fournie, seul le numéro interne compte.

Un commerçant est autorisé si son numéro **ou** son e-mail est dans la liste. Les deux sortes peuvent être mélangées. Une liste vide, ou une identité illisible, refuse tout le monde.

> **À COMPLÉTER : où trouver le numéro interne dans l'administration de Cyclos**
>
> (Chemin dans les menus de l'administration, capture ou description à ajouter ici.)

### Après un changement de liste : redémarrer

La liste est lue **une seule fois, au démarrage**. Après toute modification de `CAISSE_ALLOWED_USERS` dans le `.env` :

1. enregistrer le `.env` ;
2. arrêter le serveur ;
3. le relancer (`npm start`).

Sans redémarrage, l'ancienne liste reste en vigueur. Un commerçant déjà connecté garde sa session jusqu'à sa fin ; la liste est vérifiée à la connexion.

## Lire le journal

### Un compte refusé

Quand un compte ne figure pas dans la liste, il voit « Ce compte n'est pas autorisé à ouvrir la caisse » (erreur 403) et le journal du serveur écrit :

```
Caisse : compte refusé (absent de CAISSE_ALLOWED_USERS), numéro interne Cyclos : 1234567890123456789
```

Pour autoriser ce commerçant : copier le numéro dans `CAISSE_ALLOWED_USERS`, puis redémarrer. Le journal ne donne que ce numéro (jamais l'e-mail, ni l'identifiant tapé, ni le mot de passe). Aucune écoute n'est ouverte pour un compte refusé, et il n'y a pas de nouvel essai automatique.

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

## Ce qui n'est pas dans ce mode

- Pas de mémoire du mot de passe, donc pas de reconnexion automatique après expiration du jeton : le commerçant se reconnecte lui-même.
- Pas de liste blanche par groupe Cyclos : le groupe n'est pas lisible avec les droits d'un commerçant.
- Pas d'exécutable multi-commerçants.
