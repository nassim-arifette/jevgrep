# Revue JG-012 — fenêtres de lignes

Date : 20 septembre 2026. Point de départ : `958c444`. Correctif de revue :
`28d4552`.

## Standards

Aucune violation dure ni convention propre au dépôt enfreinte.

La fiche de l'issue était cependant périmée : elle annonçait 11 tests, un balayage
de 5 formes par 6 profils et une vérification par mutation absente du dépôt. La
suite effective comporte désormais 16 tests unitaires et un contrôle sur le corpus ;
le balayage couvre 6 formes par 5 profils. La duplication mineure du helper
`nonblankLines` entre les deux fichiers de test ne justifie pas de retarder le lot.

## Spec

Deux écarts ont été trouvés et corrigés :

- `overlapLines` acceptait une valeur supérieure à la borne contractuelle de huit
  lignes ; l'entrée est maintenant refusée explicitement ;
- une source composée uniquement d'une très longue ligne blanche était signalée
  `unsupported-long-line` ; elle produit maintenant zéro fragment sans invoquer le
  tokenizer.

Les autres exigences ont été retrouvées dans le code et les tests : couverture des
lignes non vides, tranches originales et offsets UTF-8 exacts, limites d'octets,
de tokens et de lignes, déterminisme, métadonnées, chevauchement borné et signalement
d'une ligne non représentable.

## Vérifications

- `node --test tests/line-windows.test.ts tests/line-windows-corpus.test.ts` :
  17/17 tests réussis ;
- le typecheck global n'a pas pu servir de preuve au moment du correctif : un lot CLI
  concurrent référençait temporairement `EXIT_NOT_IMPLEMENTED` sans l'importer.

Conclusion : axe Standards sans défaut bloquant ; axe Spec avec deux défauts corrigés.
JG-012 peut passer la revue M dès que la fiche d'issue est alignée et que le typecheck
global redevient vert après intégration du lot CLI concurrent.
