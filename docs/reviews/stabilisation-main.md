# Revue de consolidation — 19 septembre 2026

Base : `291e394`, puis intégration des modules auparavant non versionnés dans
`d4a6827` et correction de la file dans `efea6f2`. Deux relectures indépendantes,
Standards et Spec, ont examiné les chemins moteur/adaptateurs. Les contrôles ont été
exécutés sur Windows, Node.js 24.15.0, avec des fournisseurs synthétiques.

## Standards

- **Corrigé :** la deuxième recherche MCP démarrait immédiatement ; la file est
  désormais réelle, bornée à une attente, annulable, avec IDs texte/nombre distincts.
- **Corrigé :** `null` faisait planter le parseur et le JSON invalide était ignoré.
  Les erreurs JSON-RPC sont bornées, y compris avec `id:null`.
- **Corrigé :** le rendu humain mesurait sans borner et convertissait un total
  inconnu en zéro. La représentation entière est bornée séparément, avec suppression
  d’extraits entiers et remesure.
- **Corrigé après contre-revue :** l’attente MCP n’était pas déduite du délai. Le
  moteur reçoit maintenant l’heure d’admission sur la même horloge ; un test contrôlé
  vérifie qu’une attente expirée ne déclenche aucun appel fournisseur.
- **Documentation rectifiée :** les suites locales ne qualifient pas un client Codex,
  Linux sur l’artefact intégré, un parseur syntaxique complet ou le contrat réel Jev.

## Spec

- **P1 corrigé :** `allow_partial_scan` contournait les plafonds. Le plan admet un
  préfixe déterministe de lots ; un plafond zéro ne permet aucun dispatch.
- **P1 corrigé :** les octets comptaient uniquement les sources. Le corps JSON complet
  est maintenant mesuré, critères et métadonnées compris, puis réservé avant envoi.
- **P1 corrigé :** l’annulation d’un appel envoyé effaçait sa tentative. La réservation
  inconnue et les octets restent comptés ; l’annulation avant transport ne l’appelle pas.
- **P2 corrigé après contre-revue :** une deadline interrompant la première tentative
  devenait une erreur fatale. L’arrêt interne est distingué d’un échec fournisseur et
  renvoie un résultat partiel sans inventer d’évaluation réussie.
- **Corrigé pendant validation :** une préparation interrompue annonçait un plan total
  exact. Les quantités inconnues restent `null`, et un scan complet requis est refusé
  lorsqu’un plafond de préparation empêche de le terminer.

## Limites et preuves

Les tests de régression couvrent ces défauts. `npm run verify` passe avec 336 tests,
build et 7 smoke checks. Les 14 tests de l’expérience SDK et le validateur du corpus
passent également. Ces preuves qualifient la base de développement hors ligne.

JG-008, les décisions fournisseur JG-004/JG-005, l’ordonnanceur complet JG-016/JG-017
et l’interopérabilité réelle restent ouverts. Les autres modules intégrés conservent
leurs critères de revue/acceptation. `src/readiness.ts` bloque le transport réel,
le benchmark refuse live/holdout et la CLI publique reste au scaffold.

L’ordre de reprise et les preuves restantes figurent dans [le passage de relais](../handoff.md).
