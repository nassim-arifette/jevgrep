# Reprise sur main — 20 septembre 2026

La base commune est `main`, dans le dossier habituel `jevgrep`. Tous les lots de
stabilisation et les modifications parallèles de l'utilisateur sont réunis sur cette
branche. Aucun remote n'est configuré : les commits restent locaux.

Les points 1 et 2 de la reprise sont traités : configuration, parseur, budgets/reprises,
HTTP/cache, profils d'initialisation, instrument de benchmark et documentation.
Cela stabilise la base de reprise ; les qualifications externes ci-dessous restent ouvertes.

## Lots disponibles

| Périmètre | État et preuve |
| --- | --- |
| JG-002 / JG-003 | Contrats v1 et fournisseur simulé stabilisés ; mêmes schémas entre CLI et MCP. |
| JG-007 / JG-008 | Revue configuration close (`9608b36`) et contrôle d'accès conservé (`e8952c8`, `07d48e1`, `3c16fce`). Voir [profils](reviews/jg-007-profile-review.md) et [autorisation](reviews/jg-008-review.md). |
| JG-015 | Parseur syntaxique TypeScript 6.0.2 épinglé par alias, distinct du compilateur 7.0.2 ; aucun plugin/import exécuté. Parcours non quadratique des membres. `1e93e7d`, `e70d507`, [rapport](reports/jg-015-syntax-chunker.md). |
| JG-016 / JG-017 | Réservations par tentative, octets du corps exact, reprises finies, cooldown partagé, arrêt sur erreur terminale et annulation bornée du scheduler. `d3899e2`, [revue](reviews/jg-016-017-stabilisation.md). |
| JG-013 / JG-018 | Transports bornés, voisins valides conservés, usage ambigu inconnu, cache exact par lot complet, modèle explicitement versionné et verrou local par génération. `864472b`, [revue](reviews/jg-013-018-stabilisation.md). |
| CLI / profils | `init --global`, profil par dépôt, découverte depuis un sous-dossier et remplacement explicite de fournisseur. Les limites CLI viennent de la configuration ; environnement prioritaire sur secrets stockés. `9608b36`. |
| JG-027 / JG-028 | Corpus revu par le senior ; runner corrigé pour ensembles/alternatives, populations, cache froid isolé et provenance des annotations. `48fef9c`, [revue du runner](reviews/jg-028-runner-review.md). |
| Contributions utilisateur | Tous les textes UTF-8 éligibles sont recherchables, sans filtre d'extension ; retrait de `unsupported_format` (`4a44fc1`, `befe984`, `ad999ab`). Délai initial de cinq minutes (`2a3fde8`). `init` crée un `.jevgrepignore` commenté sans écraser l'existant (`f13fb24`). |

Les checklists historiques d'issues ne constituent pas une nouvelle implémentation à
recommencer. Reprendre les modules présents et les critères encore ouverts dans
[issues.md](issues.md). La revue locale d'un module dépendant du fournisseur ne vaut
pas qualification de son compte, de sa latence ou de sa qualité de recherche.

## Comportement stabilisé

- Les nouveaux profils gardent `remote_evaluation_enabled: false`. Après inspection,
  l'opérateur l'active dans la configuration externe. `init --global` seul n'autorise
  aucun dépôt. Les credentials ne vont ni dans les résultats, ni dans le cache.
- Les transports réels sont accessibles après autorisation, activation et credential.
  Le verrou global `readiness.ts` a été retiré conformément à l'activation expérimentale.
  Les tests utilisent des transports simulés, y compris le SDK Gateway réel sur fetch local.
- Les redirections sont refusées et les corps de réponse bornés à 8 Mio. Un HTTP 401
  reste terminal et un HTTP 429 conserve son délai même si le corps est inexploitable.
- Une reprise consomme une nouvelle réservation ; l'usage d'une tentative ambiguë
  reste inconnu. Les reprises ambiguës sont désactivées par défaut. Les tarifs de
  sortie non nuls sont refusés par l'estimateur actuel, qui couvre Jev à sortie gratuite.
- Le cache n'assume pas l'indépendance des questions : identité du lot transmis complet,
  réutilisation seulement si toutes ses entrées sont présentes. Les aliases
  `jev-latest` et Gateway ne bénéficient pas de réutilisation persistante ; une révision
  explicite `jev-X.Y.Z` doit être cohérente avec celle retournée.
- Le benchmark distingue intersection d'annotation et couverture complète de ses lignes.
  Ni l'une ni l'autre ne prouve seule la justesse sémantique ou le succès d'une tâche.
  Une erreur sur un contrôle négatif n'est jamais comptée comme une réussite.

## Ce qu'il reste après cette stabilisation

| Priorité | Travail à reprendre | Preuve attendue |
| --- | --- | --- |
| 1 — JG-004 / JG-005 | Qualifier un compte réel et le batching | Scores, usages, modèle effectif, limites, tarif et comparaison des dispositions sur données autorisées. Le premier essai est prévu via Gateway ; aucun appel réel effectué dans cette stabilisation. |
| 2 — JG-006 / JG-024 / JG-026 | Qualifier MCP avec un vrai client Codex | Découverte, réponse complète unique, annulation, fermeture, timeout et troncature réellement observés. Le stdio local est testé ; le client réel ne l'est pas. |
| 3 — JG-025 / JG-028 / JG-029 | Compléter la qualification intégrée et les mesures | Matrice R1–R11 finale, réglages figés, développement puis exécuteur réservé isolé ; comparaison de tâches avec/sans JevGrep. Les chiffres du scorer hors ligne ne mesurent pas Jev. |
| 4 — JG-030 | Préparer la diffusion expérimentale et le bilan | Licence et distribution à choisir, limites et résultats documentés. Le package reste privé et `UNLICENSED`. |

JG-027 contient six fixtures : 42 questions de développement et 12 réservées sur
des fixtures distinctes. Les réponses réservées restent hors du dépôt. Leur absence
du checkout ne prouve pas l'isolation d'un agent évalué : le contrôle négatif d'accès
doit être exécuté dans l'environnement de mesure. Le runner de développement refuse
ces manifestes et ne charge aucune réponse privée.

## Vérification et commandes

La suite complète sur le code `e2f1b77` passe : **460 tests, 458 réussis et 2 skips
sur Windows ; 460 tests, 457 réussis et 3 skips sur Linux**. Types, build, installation
de l'artefact empaqueté et huit smoke checks passent sur les deux systèmes, sous
Node 24.15.0. Linux a utilisé une copie figée issue de `git archive`, avec le delta
documentaire et son test de compatibilité. Le corpus passe : six fixtures, 54 questions,
aucune incohérence publique ; les réponses réservées sont absentes, comme prévu.

Le dernier ajustement `1a8e2b7` signale les purges de cache incomplètes et isole aussi
les profils des tests en processus. Ses 12 tests CLI, types, build et huit smoke checks
ont été revérifiés sur Windows et sur la même copie Linux après application du delta.
Les 21 tests du runner et les revues indépendantes Spec/Standards sont clos.
La CI distante n'a pas tourné, faute de remote.

Les deux skips Windows concernent le renommage d'une racine pendant l'ouverture d'un
fichier, interdit par cet hôte, et la création d'un symlink de fichier sans privilège.
Ces cas passent sous Linux. Les trois skips Linux sont les contrôles du helper
d'attributs Windows, exercés sous Windows. Aucun appel réel au fournisseur effectué.

```sh
npm ci
npm run verify
npm run corpus:check
```

L'expérience SDK locale séparée se reproduit sans fournisseur avec
`npm ci --prefix experiments/jev-contract` puis `npm test --prefix experiments/jev-contract`.
Les 14 contrôles locaux antérieurs ne remplacent pas une sonde sur compte réel.
