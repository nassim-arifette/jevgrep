# Reprise sur main — 20 septembre 2026

La base commune est `main`, dans le dossier habituel `jevgrep`. Les anciens lots
JG ont été réunis et les modules qui étaient non commités sont intégrés. Reprendre
depuis ce HEAD. Aucun remote n’est configuré : les commits sont locaux.

Repères : `291e394` fige le tokenizer, `d4a6827` consolide les modules hors ligne
et les gardes d’activation, `efea6f2` corrige l’attente MCP et les plans incomplets.
Voir aussi [le compte rendu de revue](reviews/stabilisation-main.md).

Le contrôle d'accès JG-008 est intégré dans `e8952c8`, puis les corrections de
portabilité dans `07d48e1`. Ces deux lots ont été vérifiés sur une copie figée de
la base commune pour exclure les modifications simultanées des autres tâches.
Les changements encore non commités ne font pas partie de cette qualification.
`3c16fce` ajoute le contrôle du délai après revalidation, vérifié par les 30 tests
du moteur sur Windows et Linux ; `cc8410c` isole les profils/secrets de l'opérateur
des tests CLI (16 contrôles CLI/MCP réussis sur chaque système).

## Ce qui est stabilisé

- **JG-002** : contrat public v1 et validateurs, revus et corrigés. Les unités,
  `null`, plafonds zéro, usages inconnus et invariants de compteurs sont partagés.
- **JG-003** : fournisseur simulé, horloge et fixtures, revus après JG-002.
- **JG-027** : annotations et protocole revus par le senior. Six fixtures,
  42 questions de développement et 12 réservées sur des fixtures distinctes.
  Les réponses réservées restent hors du dépôt. Leur séparation sur disque ne
  prouve pas l’isolation d’un agent d’évaluation : ce dernier contrôle reste ouvert.
- **JG-006, compteur** : `tiktoken@1.0.22/cl100k_base`, données embarquées, budget
  de la sérialisation entière. La partie MCP/Codex réel reste ouverte.
- **JG-004, expérimentation locale** : SDK `@typesafe-ai/sdk@0.6.0` épinglé dans
  `experiments/jev-contract`, 14 cas locaux SDK/fetch vérifiés. La sonde fournisseur
  réelle est préparée et n’a pas été exécutée.
- **JG-008** : ancre d'autorisation conservée et invalidation mémorisée, lectures
  et fichiers d'exclusion vérifiés, attributs reparse Windows contrôlés avant
  descente, descripteur comparé avant lecture et chemins revalidés avant envoi.
  Revue et tests Windows/NTFS + Linux passés ; clôture administrative liée à JG-007.
  Voir les [preuves et limites](reviews/jg-008-review.md).

Les modules configuration, cycle de vie, inventaire, snapshots, découpage, cache,
sélection, moteur, commandes et MCP sont maintenant versionnés et testables
ensemble. Leur présence ne clôt pas les issues dont les critères restent ouverts.

## Corrections de la consolidation

- Le mode partiel respecte les plafonds et ne sélectionne qu’un préfixe déterministe
  de lots. Le compte d’octets inclut critères, question, métadonnées et JSON échappé.
- Les réservations sont prises avant dispatch, visibles entre workers, puis
  réconciliées avec l’usage connu. Une annulation après envoi conserve sa tentative
  et sa réservation inconnue. Un dépassement d’estimation arrête les prochains lots.
- Le MCP limite les recherches à une active et une en attente ; une troisième reçoit
  `BUSY`. Les annulations et les identifiants numériques/texte restent distincts.
  Les entrées nulles ou malformées produisent des erreurs de protocole bornées.
  L’attente compte dans le délai ; une recherche expirée dans la file n’envoie rien.
  Les plans incomplets conservent des totaux inconnus, sans inventer de scan complet.
- Le rendu humain mesure et borne son propre texte complet ; il retire des extraits
  entiers et préserve les totaux inconnus. Les rendus sont remesurés sans supposer
  qu’un compteur BPE est monotone.
- L’erreur de parsing de configuration n’affiche plus le contenu JSON fourni.

## Gates maintenus dans le code

`src/readiness.ts` bloque les appels réels depuis le moteur et l’adaptateur, même
avec une clé et `remote_evaluation_enabled=true`. Les tests injectent leur fournisseur
hors ligne. Le runner de développement refuse `--provider live` et tout split réservé.
Ne pas retirer ces contrôles sans les preuves d’acceptation correspondantes.

Le binaire `dist/cli.js` appelle maintenant les commandes réelles : aide, doctor,
inspect, cache et MCP sont raccordés. Les adaptateurs TypeSafe direct et Vercel
AI Gateway existent et sont testés hors ligne. Cela ne retire pas les gates des
recherches fournisseur. Voir la [revue CLI](reviews/jg-023-review.md) et la
[matrice de compatibilité](compatibility.md).

## Ordre de reprise

| Priorité / pilote | Travail | Preuve attendue avant clôture |
| --- | --- | --- |
| S + M : JG-007/JG-008 | Finaliser la revue de configuration et clôturer leur dépendance | Le contrôle JG-008 est implémenté et revu ; conserver son ancre dans les nouvelles entrées et ne jamais réautoriser une racine par son seul chemin. Voir `reviews/jg-008-review.md`. |
| S : JG-004 → JG-005 | Exécuter la sonde réelle autorisée, qualifier scores/usage/modèle/tarif puis disposition des requêtes | Résultats expurgés, budget d’expérience explicite, choix mesuré et conséquences sur le cache. Aucun résultat réel disponible actuellement. |
| S + M : JG-016/JG-017 | Finaliser l’estimateur et l’ordonnanceur | Reprises finies et `Retry-After`, limites fournisseur, annulation/cleanup borné ; étendre les tests de réservations concurrentes. |
| M + S : JG-006/JG-024 | Qualifier le transport MCP et un vrai client Codex | Choix SDK documenté, flux/buffers bornés, versions négociées, timeout et sortie maximale réellement observés. |
| M + S : JG-013/JG-015/JG-018 | Revoir les modules dépendant des décisions réelles | Corps HTTP lu sous limite, parseur JS/TS qualifié, identité des modèles et réutilisation exacte du cache. Le scanner lexical actuel est provisoire. |
| S + M + J : JG-020/JG-022/JG-025 puis JG-023/JG-026 | Compléter la qualification des invariants et de l'installation | Binaire raccordé et artefact installé hors ligne ; restent la matrice R1–R11 complète et la qualification des intégrations réelles. |
| M + S : JG-028/JG-029 | Qualifier l’instrument, mesurer développement puis jeu réservé | Couverture complète des preuves/alternatives, settings figés, exécuteur isolé et contrôle négatif d’accès aux réponses. Aucun résultat du scorer hors ligne n’est une mesure de qualité Jev. |

J peut poursuivre les fixtures, cas d’échec et procédures d’installation. M dispose
des contrats et modules intégrés pour continuer les lots hors ligne. Toute modification
significative doit être accompagnée de ses contrôles et d’un commit sur la base commune.

## Vérification de cette base

Pour JG-008 et ses corrections de portabilité, sur Node.js 24.15.0 : 396 tests sur
chaque système, zéro échec (Windows : 394 réussis, 2 skips ; Linux : 393 réussis,
3 skips Windows), contrôle de types, build et 8 smoke checks réussis. Installation
depuis le lockfile et de l'artefact empaqueté vérifiées. Les skips et la copie figée
exacte sont décrits dans la revue JG-008. La matrice CI distante n'a pas tourné.
Les 14 contrôles SDK locaux et le corpus avaient passé lors de la consolidation ;
cette validation ne prétend pas qualifier un fournisseur réel.

La dernière vérification Windows de l'arbre partagé, avec les autres lots encore
non commités, passe aussi : 410 tests, dont 408 réussis et 2 skips, types, build et
8 smoke checks. Les modifications en cours restent à relire et committer par leurs
pilotes ; ce résultat ne constitue pas leur clôture.

```sh
npm ci
npm run verify
npm run corpus:check
```

Expérience SDK locale distincte, sans appel fournisseur :

```sh
npm ci --prefix experiments/jev-contract
npm test --prefix experiments/jev-contract
```

La validation des réponses réservées se fait uniquement côté curateur, selon
`benchmarks/README.md`. Ne pas recopier le fichier de réponses dans le dépôt ni dans
l’espace de l’agent évalué.
