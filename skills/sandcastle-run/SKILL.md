---
name: sandcastle-run
description: Traduire une consigne d'opérateur — « traite le ticket #42 en AFK avec Sandcastle en mode split en partant de main » — en gestes corrects sur une instance Software Factory : distinguer l'identité (config.ts, à faire confirmer) de l'invocation (variables SANDCASTLE_*), vérifier les préalables, passer par un dry-run, puis lancer en tâche de fond. À charger dès qu'on demande de lancer, relancer, restreindre ou reconfigurer une boucle Sandcastle / Factory.
---

# Lancer une boucle Software Factory

Cette skill ne récite pas les réglages. Elle tient **une seule frontière** : ce qui
relève de l'**identité du projet** (`.sandcastle/config.ts`, réglé une fois, tracé
dans git) et ce qui relève de l'**invocation** (variables d'environnement du run).
Confondre les deux est l'erreur coûteuse : éditer `baseBranch` alors qu'il n'y avait
rien à faire, ou coder en dur un numéro de ticket dans l'identité du dépôt.

## La table de frontière

| Ce que dit l'humain | Où ça vit | Geste |
|---|---|---|
| « le ticket #42 » | `SANDCASTLE_ONLY=42` **+ label de file** | env + `gh issue edit 42 --add-label <label>` (ou `glab issue update 42 --label <label>`) |
| « mode split » / « opus » | `SANDCASTLE_PROFILE` | env (défaut `split`) |
| « chaîné », « empile les MR » | `SANDCASTLE_CHAIN=1` | env (exige un `chainableBases` non vide dans l'identité) |
| « refais-le », « relance-le » | `SANDCASTLE_FORCE=1` | env — **exige** `SANDCASTLE_ONLY` |
| « juste un tour », « n tours » | `SANDCASTLE_MAX_ITERATIONS` | env |
| « n tickets à la fois » | `SANDCASTLE_MAX_PARALLEL` | env (forcé à 1 en chaîné) |
| « montre-moi d'abord », « à blanc » | `SANDCASTLE_DRYRUN=1` | env |
| « en partant de main », « depuis l'epic » | `baseBranch` / `labelBases` | `config.ts`, **avec confirmation** |
| `gitHost`, `queueLabels`, `assignee`, `mergeStrategy`, `commitStyle`, `hooks`, `report`… | `config.ts` | identité — **avec confirmation** |

Ces sept variables sont l'intégralité de la surface d'invocation : elle est lue en un
seul endroit, `loadRunConfig` dans `.sandcastle/config.ts`. Tout le reste est identité.

**N'énumère pas les valeurs et les défauts de mémoire.** La seule source qui ne mente
jamais est `.sandcastle/config.ts` et ses commentaires de doc ; lis-le avant de
répondre sur un champ précis.

## Le piège n° 1 : `SANDCASTLE_ONLY` restreint, il n'élargit pas

La file du tour est construite côté hôte depuis `queueLabels` (`host.queueIssues`).
`SANDCASTLE_ONLY` **filtre** cette file (`applyOnly`, `plan.ts`) — il ne va pas
chercher un ticket qui n'y est pas.

Conséquence : `SANDCASTLE_ONLY=42` sur un ticket **sans label de file** donne un
**tour vide, sans aucune erreur**. C'est le mode d'échec le plus cher en AFK : on part,
on revient, rien ne s'est passé et rien ne l'a dit.

Donc : « traite le ticket #42 » = poser le label de file **et** restreindre. Les deux.

## Procédure

### 1. Préalables — en lecture seule, sauf le label

Vérifie, nomme ce qui manque avec le geste correspondant, et **ne corrige rien** :

- **Label de file** — `gh issue view <n> --json labels` croisé avec `queueLabels` de
  `config.ts`. **Seule exception à la règle : pose-le.** C'est le sens littéral de
  « traite ce ticket », et un `--remove-label` l'annule. Quand `queueLabels` en liste
  plusieurs, prends celui que portent déjà les autres tickets de la file plutôt que le
  premier de la liste : le dépôt en utilise un en pratique, les autres sont de la
  compatibilité.
- **Token de fournisseur** — le `tokenKey` de chaque provider du profil actif, dans
  l'environnement ou dans `.sandcastle/.env.secrets`. **Ne lis jamais la valeur, ne
  l'affiche jamais** : constate la présence de la clé. Le dry-run le dit mieux que toi
  (`requiredTokens`, source `env` / `.env.secrets` / `MISSING`).
- **Hôte authentifié et d'accord avec `origin`** — `gh auth status` (ou `glab auth
  status`), et `git remote get-url origin` cohérent avec `gitHost`. Le dry-run reporte
  ce désaccord (`hostMismatch`).
- **Base à jour** — la base locale ne doit pas être en retard sur le remote :
  `git fetch origin && git status -sb`. Un run réel la fast-forwarde lui-même ; le
  dry-run se contente d'avertir. Le geste, si tu dois le nommer :
  `git fetch origin && git switch <base> && git pull`.

Ce qui ne s'automatise pas depuis une skill : authentifier un hôte, écrire un secret.
Demande le geste à l'humain.

### 2. Dry-run — systématique, avant tout lancement réel

```sh
SANDCASTLE_DRYRUN=1 SANDCASTLE_ONLY=42 npx tsx .sandcastle/main.ts
```

Mets les **mêmes** variables que le run réel : c'est la seule façon de voir le profil,
les tokens, les bases, l'état du chaînage et la file tels qu'ils seront. Montre le
verdict à l'opérateur. Il lance rien et sort 0 même avec des tokens manquants.

C'est le sens d'« AFK » : ce qui coûte cher n'est pas la minute du dry-run, c'est de
partir et de découvrir au retour que le tour était vide ou le profil faux.

### 3. Lancement — en tâche de fond, sans redemander

Le dry-run a servi de confirmation. Lance, puis donne le chemin du log et la façon de
suivre :

```sh
mkdir -p .sandcastle/logs
SANDCASTLE_ONLY=42 npx tsx .sandcastle/main.ts > .sandcastle/logs/run-42.log 2>&1 &
tail -f .sandcastle/logs/run-42.log
```

### 4. Toute édition de `config.ts` se fait confirmer

Propose le diff, attends l'accord. L'identité est tracée dans le dépôt du consommateur
et une erreur y contamine **tous** les runs suivants — pas seulement celui-ci. « En
partant de main » n'est presque jamais une édition : `baseBranch` vaut déjà `main` dans
la plupart des instances. Lis avant de proposer.

## Ce que cette skill ne fait pas

- Elle ne remplit pas le `CLAUDE.md` ni le `CONTEXT.md` du projet — ça reste chez le
  consommateur.
- Elle n'authentifie pas l'hôte et n'écrit pas de secret.
- Elle ne récite pas `ProjectConfig` : elle renvoie à `.sandcastle/config.ts`.
