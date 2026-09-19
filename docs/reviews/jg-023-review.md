# Revue JG-023 — commandes CLI

Date : 20 septembre 2026. Point de départ : `2216377`. Correctif de revue :
`5bd0f98`.

## Standards

Aucune violation dure ni convention propre au dépôt enfreinte.

La fiche et le commentaire d'en-tête de `src/cli.ts` décrivaient encore le scaffold
où les commandes sortaient en 69. Ils ont été alignés sur le dispatch réel. Le catalogue
des commandes reste répété entre l'analyseur, l'aide et l'exécuteur ; les contrôles de
parité limitent ce risque, qui ne bloque pas le lot.

## Spec

Deux défauts ont été trouvés et corrigés :

- l'aide de `mcp` promettait à tort de ne jamais contacter le fournisseur ; elle distingue
  maintenant le démarrage local sans appel des recherches distantes demandées par un outil ;
- l'adaptateur stdout ajoutait un saut de ligne à un rendu humain qui incluait déjà son saut
  final mesuré ; il conserve désormais exactement un terminateur, inclus dans la mesure.

Les autres critères sont couverts hors ligne : commandes locales, contrat JSON, codes de
sortie, question multiligne, effacement borné du cache, aide et séparation stdout/stderr.
La réussite d'une recherche fournisseur et la qualification live restent ouvertes avec les
gates senior ; elles ne sont pas revendiquées par cette revue.

## Vérifications

- `node --test "tests/cli*.test.ts"` : 66/66 tests réussis ;
- `npm run typecheck` : réussi ;
- `npm run verify` avant le correctif : 366/366 tests, build et 8/8 smoke checks réussis ;
  les tests CLI et le typecheck ont ensuite été rejoués après le correctif.

Conclusion : axes Standards et Spec sans défaut bloquant après `5bd0f98`. JG-023 a passé
la revue M pour son périmètre hors ligne ; les critères live restent soumis à JG-022.
