# JevGrep — Issues d’implémentation du MVP

Version : 1.1. Date : 19 septembre 2026. **Statut initial de toutes les issues : À faire.**

Ce document contient 30 issues locales, prêtes à être reprises dans un gestionnaire de projet. Les identifiants `JG-001` à `JG-030` sont stables ; ils ne correspondent pas à des tickets déjà créés sur GitHub.

**Point de reprise du 19 septembre 2026 :** tout le travail est intégré sur `main`.
Lire [le passage de relais](handoff.md) pour les modules disponibles, les corrections
de revue et l’ordre de reprise. JG-002 et JG-003 sont stabilisés. La revue senior du
corpus JG-027 est faite ; son isolation opérationnelle reste à prouver. Les autres
modules intégrés constituent une base de développement testée hors ligne, sans
clôture automatique de leurs critères. Le transport réel et le benchmark live sont
bloqués dans le code tant que les gates senior restent ouverts.

Sources de référence : [spécification v0.1](specification.md), [plan d’implémentation](implementation-plan.md), [décisions validées](decisions.md) et [vocabulaire](../CONTEXT.md). La spécification reste la référence pour les contrats et les valeurs de configuration.

## Règles communes

- Le MVP est personnel, écrit en TypeScript, avec un moteur partagé entre la CLI et le serveur MCP local.
- La cible d’environ 100 000 lignes sert aux mesures ; elle ne constitue pas une limite commerciale ou technique codée en dur.
- Les plafonds facultatifs de dépenses et de volume total sont désactivés par défaut. Le délai d’exécution et le budget de réponse restent configurables.
- Aucun préfiltrage de pertinence par grep ou embeddings n’est ajouté. Les exclusions servent à déterminer l’éligibilité des fichiers.
- Les résultats contiennent des extraits originaux traçables. L’agent reste responsable du raisonnement, des modifications et des tests du projet recherché.
- La suite habituelle de tests fonctionne hors ligne, sans clé Jev. Les expériences réelles sont des commandes distinctes, exécutées avec des données autorisées et une configuration de budget explicite.

**Priorités :** « Critique » désigne un contrat ou un contrôle dont dépend la fiabilité du produit ; « Haute » désigne une fonction nécessaire au MVP ; « Normale » désigne un travail de mesure ou de livraison nécessaire à sa validation. La priorité ne remplace pas les dépendances et ne rend aucune issue facultative.

**Clôture d’une issue :** les livrables existent, tous ses critères d’acceptation sont vérifiés, les contrôles pertinents passent et les changements de contrat sont documentés. Une étude peut conclure négativement ; sa clôture doit alors enregistrer les conséquences pour les issues dépendantes. L’absence d’accès fournisseur ne permet pas de déclarer une validation réelle réussie.

Les dépendances indiquent les éléments nécessaires à la clôture. Des brouillons et travaux indépendants peuvent commencer avant, notamment avec le fournisseur simulé. Les types partagés sont définis une seule fois ; la CLI et MCP ne réimplémentent pas le moteur.

## Index

### Répartition proposée entre trois personnes

Le niveau porte sur le pilotage de l’issue entière. **J = junior encadré**, **M = medium/intermédiaire**, **S = senior**. La priorité mesure l’importance du résultat ; elle ne détermine pas seule le niveau requis. Chaque issue a un pilote et un relecteur distincts.

| Profil | Issues pilotées | Nombre |
| --- | --- | --- |
| Junior encadré — J | JG-001, JG-012, JG-023, JG-026, JG-027 | 5 |
| Medium / intermédiaire — M | JG-003, JG-006, JG-007, JG-009, JG-010, JG-011, JG-013, JG-014, JG-015, JG-018, JG-019, JG-021, JG-024, JG-028 | 14 |
| Senior — S | JG-002, JG-004, JG-005, JG-008, JG-016, JG-017, JG-020, JG-022, JG-025, JG-029, JG-030 | 11 |

Le junior peut aussi réaliser des sous-lots de fixtures, tests, exécution et documentation sur les autres issues. Le pilote conserve la responsabilité de l’intégration et des décisions. Pour JG-001, S cadre le runtime ; pour JG-026, S valide les affirmations de divulgation ; les annotations JG-027 sont revues directement par S.

Le [workflow à trois personnes](workflow-equipe.md) précise les contributions, les vagues de travail, les passages de relais et les règles de revue. Les dépendances et critères d’acceptation existants restent applicables ; cette attribution ne marque aucune issue comme commencée ou terminée.

### Liste des issues

Les phases `P0` à `P7` correspondent au plan d’implémentation existant.

| Issue | Intitulé | Phase | Priorité | Niveau recommandé | Revue |
| --- | --- | --- | --- | --- | --- |
| [JG-001](#jg-001) | Initialiser le package TypeScript et les contrôles hors ligne | P0–P1 | Critique Junior encadré | M |
| [JG-002](#jg-002) | Définir et valider les contrats publics | P0 | Critique Senior | M |
| [JG-003](#jg-003) | Construire le fournisseur simulé et les fixtures de contrat | P0–P1 | Critique Medium | S |
| [JG-004](#jg-004) | Vérifier le contrat réel Jev et la compatibilité du SDK | P0 | Critique Senior | M |
| [JG-005](#jg-005) | Comparer les dispositions des requêtes Jev et choisir le batching | P0 | Critique Senior | M |
| [JG-006](#jg-006) | Valider le compteur de tokens et l’interopérabilité MCP/Codex | P0 | Critique Medium | S |
| [JG-007](#jg-007) | Charger la configuration de confiance et fournir `doctor` | P1 | Critique Medium | S |
| [JG-008](#jg-008) | Garantir le confinement des lectures au dépôt autorisé | P1 | Critique Senior | M |
| [JG-009](#jg-009) | Implémenter le cycle de vie et les diagnostics locaux | P1 | Haute Medium | S |
| [JG-010](#jg-010) | Inventorier les fichiers et appliquer les exclusions | P2–P3 | Haute Medium | S |
| [JG-011](#jg-011) | Capturer les sources et leurs références exactes | P2–P3 | Critique Medium | S |
| [JG-012](#jg-012) | Implémenter le découpage par fenêtres de lignes | P2 | Haute Junior encadré | M |
| [JG-013](#jg-013) | Implémenter l’adaptateur Jev et normaliser ses réponses | P2 | Critique Medium | S |
| [JG-014](#jg-014) | Livrer un premier parcours CLI complet sur fixtures | P2 | Haute Medium | S |
| [JG-015](#jg-015) | Ajouter le découpage syntaxique JavaScript/TypeScript | P3 | Haute Medium | S |
| [JG-016](#jg-016) | Planifier le scan et comptabiliser les limites facultatives | P4 | Critique Senior | M |
| [JG-017](#jg-017) | Ordonner les lots, reprises et annulations | P4 | Critique Senior | M |
| [JG-018](#jg-018) | Mettre en cache uniquement les évaluations identiques | P4 | Haute Medium | S |
| [JG-019](#jg-019) | Classer et fusionner les extraits sélectionnés | P5 | Haute Medium | S |
| [JG-020](#jg-020) | Garantir le budget de la réponse sérialisée | P5 | Critique Senior | M |
| [JG-021](#jg-021) | Écarter les extraits devenus obsolètes | P3–P5 | Haute Medium | S |
| [JG-022](#jg-022) | Finaliser le moteur et ses rapports de couverture | P5 | Critique Senior | M |
| [JG-023](#jg-023) | Finaliser toutes les commandes CLI | P6 | Haute Junior encadré | M |
| [JG-024](#jg-024) | Exposer le moteur par le serveur MCP de production | P6 | Critique Medium | S |
| [JG-025](#jg-025) | Valider les invariants et la parité CLI/MCP | P5–P6 | Critique Senior | M |
| [JG-026](#jg-026) | Rendre l’installation et la configuration reproductibles | P6 | Haute Junior encadré | M |
| [JG-027](#jg-027) | Constituer le corpus de recherche et ses annotations | P0–P7 | Normale Junior encadré | S |
| [JG-028](#jg-028) | Mesurer la qualité de recherche et figer les réglages | P7 | Normale Medium | S |
| [JG-029](#jg-029) | Comparer les tâches Codex avec et sans JevGrep | P7 | Normale Senior | M |
| [JG-030](#jg-030) | Livrer le MVP open source expérimental et son bilan | P7 | Haute Senior | M |

## Issues détaillées

<a id="jg-001"></a>
### JG-001 — Initialiser le package TypeScript et les contrôles hors ligne

**Type :** Infrastructure. **Priorité :** Critique. **Phase :** P0–P1. **Statut :** Terminé le 19 septembre 2026 (commit `4bba8e8`, intégré sur `main`). **Revue :** M — `docs/reviews/jg-001-review.md`, cinq critères PASS, aucun défaut bloquant ; défauts D1 (artefact de test laissé dans `src/` après un arrêt brutal), D3 (`--version` sortait 1 avec une trace) et nits N1–N9 corrigés dans le même commit.

**Livré :** package unique TypeScript (`src/cli.ts`, `dist/cli.js` comme point d’entrée `jevgrep`), lockfile, `tsconfig.json` strict, scripts `typecheck`/`test`/`build`/`smoke`/`verify`, suite hors ligne sur `node --test` (23 tests, dont un contrôle hors réseau et un contrôle qui échoue sur erreur de type), CI Windows/Linux (`.github/workflows/ci.yml`) et commandes documentées dans le README. Vérifié sur Node.js 24.15.0 sous Windows et sous Linux (`npm ci` depuis le lockfile, `npm run verify`).

**Niveau recommandé :** Junior encadré. **Pilote proposé :** J. **Revue :** M.

**Dépendances :** Aucune.

**Références :** plan §3 et §10 ; spécification §3.

**Objectif :** disposer d’un package unique compilable et testable sur Windows et Linux, support des implémentations suivantes.

**Travaux :** choisir une version Node.js LTS supportée, créer le manifeste et le lockfile, activer la vérification TypeScript stricte, préparer le point d’entrée `jevgrep` et les scripts de compilation, de vérification des types et de tests. Ajouter une CI Windows/Linux exécutant ces contrôles hors ligne. Les versions Jev/MCP expérimentales seront confirmées par leurs études respectives.

**Critères d’acceptation :**

- [x] Une installation à partir du lockfile suivie de la compilation réussit sur les deux plateformes. *(vérifié Windows + Linux, `npm ci` puis `npm run verify`)*
- [x] Une erreur de type fait échouer le contrôle de types avec un code de sortie non nul. *(projet témoin hors dépôt + script documenté, `tests/type-check-gate.test.ts`)*
- [x] Les tests habituels n’exigent aucune clé Jev et n’effectuent aucun appel réseau fournisseur. *(garde-fou in-process + preload dans les processus CLI ; variables retirées)*
- [x] Le package contient un point d’entrée exécutable ; aucune commande non implémentée n’est présentée comme disponible. *(`bin jevgrep`, aide par commande qui rappelle l’état non implémenté)*
- [x] Les versions de runtime et les commandes de développement sont documentées. *(README, `.nvmrc`, CI)*

**Livrables :** package TypeScript, lockfile, scripts, configuration CI et instructions de développement.

<a id="jg-002"></a>
### JG-002 — Définir et valider les contrats publics

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P0. **Statut :** Terminé le 19 septembre 2026. Contrat stabilisé après [revue indépendante Standards/Spec](reviews/jg-002-review.md) ; deux défauts corrigés et revérifiés.

**Livré :** schémas exécutables et types déduits dans `src/contracts.ts`, validation stricte des requêtes/configurations/résultats/erreurs/diagnostics, codes bornés, unités et identités des compteurs, conservation de la question originale, plafonds `null`/zéro et usage inconnu. `src/search-response.ts` centralise la sérialisation validée et les correspondances CLI/MCP. [Contrats v1](contracts.md), exemples valides/invalides dans `tests/fixtures/contracts.ts` et tests dans `tests/contract/`. Le raccordement des commandes reste JG-014/JG-024 ; le compteur de production reste JG-006. Vérification locale Windows : `npm run verify` réussi (types, tests, compilation et smoke).

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-001](#jg-001).

**Références :** spécification §4, §7.4 et §10 ; exigences R5–R10.

**Objectif :** donner au moteur, à la CLI et à MCP une définition commune et vérifiable des entrées, sorties et erreurs.

**Travaux :** définir les types et schémas exécutables de `SearchRequest`, `SearchResult`, `SearchError`, de la configuration et des diagnostics. Énumérer les codes d’erreur et les raisons d’arrêt. Documenter les unités, les valeurs nulles, les statuts, les bornes et les identités entre compteurs. Préserver la question originale après validation.

**Critères d’acceptation :**

- [x] Les clés inconnues, questions vides, budgets invalides et types incorrects sont refusés.
- [x] Les contrats distinguent résultat complet, partiel, rejet et erreur fatale.
- [x] Un usage inconnu est représenté explicitement ; il n’est pas converti en zéro.
- [x] Les plafonds facultatifs acceptent `null` ; zéro n’est pas interprété comme « illimité ».
- [x] Des exemples valides et invalides couvrent chaque contrat ; la version de schéma est présente.
- [x] Les sorties CLI et MCP utilisent les mêmes définitions sans duplication de schéma (sérialisation et correspondances partagées testées ; raccordement dans les issues dédiées).

**Livrables :** contrats partagés, validateurs et tests de contrat.

<a id="jg-003"></a>
### JG-003 — Construire le fournisseur simulé et les fixtures de contrat

**Type :** Infrastructure de tests. **Priorité :** Critique. **Phase :** P0–P1. **Statut :** Terminé le 19 septembre 2026, après stabilisation de JG-002 et [revue senior](reviews/jg-003-review.md).

**Livré :** simulateur et horloge contrôlable, capture immuable des octets et scénarios, annulation, réponses malformées/usage inconnu, garde réseau et fixtures synthétiques. Les défauts de partage de mémoire et de fixture ignorée non versionnée ont été corrigés. Onze tests passent dans une archive Git vierge ; contrôle de types réussi.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-001](#jg-001), [JG-002](#jg-002).

**Références :** spécification §11.1 ; plan P0–P2.

**Objectif :** vérifier le moteur indépendamment de la disponibilité, du coût et de la variabilité de Jev.

**Travaux :** créer un adaptateur scriptable et une horloge contrôlable. Préparer des dépôts synthétiques contenant implémentations, tests, configuration, code de premier niveau, fichiers ignorés, sources malformées et contenu ressemblant à des instructions. Prévoir réponses hors ordre, scores absents/invalides, erreurs HTTP, délais, usage inconnu et annulations.

**Critères d’acceptation :**

- [x] Un scénario peut imposer les réponses, leur ordre, leur délai et leur usage déclaré.
- [x] Les tests peuvent observer les octets envoyés et chaque tentative, sans réseau réel.
- [x] Le même scénario produit le même résultat fonctionnel d’une exécution à l’autre.
- [x] Les fixtures contiennent uniquement des données synthétiques ou autorisées, sans secret réel.
- [x] Un appel réseau imprévu fait échouer le scénario hors ligne concerné.

**Livrables :** adaptateur simulé, utilitaires d’horloge et fixtures réutilisables par les autres issues.

<a id="jg-004"></a>
### JG-004 — Vérifier le contrat réel Jev et la compatibilité du SDK

**Type :** Étude technique. **Priorité :** Critique. **Phase :** P0. **Statut :** En cours : recherche SDK actualisée, sonde reproductible et 14 contrôles locaux exécutés ; validation réelle toujours ouverte faute d’accès fournisseur.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Lot préparatoire J (disponible) :** `tests/fixtures/provider-contract/probe-cases.json` + `tests/provider-probe-cases.test.ts` (5 cas) — 14 cas couvrant les douze domaines à trancher (authentification valide/absente/invalide, corrélation des réponses Noul, forme du score, identité du modèle demandé et retourné, champs d’usage, borne réelle de requête, annulation en sous-processus, reprises du SDK désactivables, réponses malformées, divulgation du contenu synthétique envoyé, relevé de tarif daté, contrôle d’expurgation). Chaque cas porte sa question, son protocole d’observation, les champs à consigner et son statut (`open`/`answered` avec `answer_ref`) ; les cas bloquants sont marqués. Hygiène vérifiée par test : la variable d’environnement `TYPESAFE_API_KEY` est nommée mais aucune valeur, les preuves expurgées vont dans `docs/reports/jg-004` et les captures brutes hors du dépôt. La sonde de référence et les faits déjà sourcés sont dans `docs/research/jev-contract-update.md`.

**Dépendances :** [JG-001](#jg-001), [JG-002](#jg-002), [JG-003](#jg-003).

**Avancement senior :** SDK `@typesafe-ai/sdk@0.6.0` épinglé dans un paquet expérimental séparé, annulation en sous-processus et comparaison HTTP native vérifiées sous Node 24.15.0, reprises désactivées et journaux de corps absents dans les scénarios testés. [Rapport exécuté](reports/jg-004-offline-sdk.md), [sonde et commandes](../experiments/jev-contract/README.md). Aucun résultat fournisseur réel ni tarif de compte n’est revendiqué.

**Prérequis externe :** identifiant fournisseur opérationnel et accès au modèle testé.

**Références :** spécification §6 ; [recherche Jev](research/jev.md).

**Objectif :** confirmer le comportement réellement utilisable avant de figer l’adaptateur.

**Travaux :** exécuter une sonde séparée sur des données synthétiques/publiques. Vérifier authentification, corrélation des questions Noul, scores, modèle demandé/retourné, usage, capacité des requêtes et annulation. Examiner les reprises implicites et les journaux du SDK. Tester l’annulation dans un sous-processus avec le runtime choisi.

**Critères d’acceptation :**

- [ ] Le rapport indique les versions, la date, les commandes et les réponses expurgées utilisées comme preuve.
- [ ] Les observations du compte sont distinguées des limites seulement documentées et des points non vérifiés.
- [ ] Les reprises internes peuvent être désactivées et les corps des requêtes ne sont pas journalisés.
- [ ] Le comportement d’annulation est testé ; tout échec du SDK entraîne une comparaison documentée avec un adaptateur HTTP minimal.
- [ ] Aucun tarif exact, identifiant de modèle résolu ou usage manquant n’est inventé.

**Livrables :** sonde reproductible, réponses de référence et fiche de capacités. Sans accès réel, la validation reste ouverte.

<a id="jg-005"></a>
### JG-005 — Comparer les dispositions des requêtes Jev et choisir le batching

**Type :** Étude expérimentale. **Priorité :** Critique. **Phase :** P0. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-004](#jg-004).

**Références :** spécification §6.2 et §9 ; plan P0 ; décision F1.

**Objectif :** choisir une disposition de requête étayée par des mesures, compatible avec la qualité de recherche et l’identité du cache.

**Travaux :** comparer A, question de recherche partagée avec extrait dans chaque question ; B, un extrait dans l’état par appel ; C, plusieurs extraits dans l’état partagé. Utiliser les mêmes exemples et critères, varier l’ordre, les distracteurs et les tailles de lots 1, 8 et 16. Mesurer scores, preuves retrouvées, tokens déclarés, coût estimé et latence.

**Critères d’acceptation :**

- [ ] Le jeu de développement et le seuil sont fixés avant la comparaison concernée.
- [ ] Les trois dispositions et les variations de lots sont comparées ou leur impossibilité est justifiée par une réponse fournisseur.
- [ ] La disposition retenue ne perd aucune preuve directe retrouvée par la référence isolée sur ce jeu, selon le critère expérimental du plan.
- [ ] Les erreurs de corrélation et les effets de composition du lot sont rapportés.
- [ ] La décision précise si le cache doit identifier la requête entière ou peut réutiliser une question indépendante.
- [ ] Si aucune disposition ne satisfait le critère, le rapport conclut explicitement à une révision nécessaire avant activation du parcours réel.

**Livrables :** script de comparaison, résultats et décision de batching ; aucun gain général n’est déduit de ce seul essai.

<a id="jg-006"></a>
### JG-006 — Valider le compteur de tokens et l’interopérabilité MCP/Codex

**Type :** Étude technique. **Priorité :** Critique. **Phase :** P0. **Statut :** Compteur local stabilisé ; compatibilité réelle Codex/MCP encore à vérifier.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-001](#jg-001), [JG-002](#jg-002), [JG-003](#jg-003).

**Avancement senior :** tokenizer `tiktoken@1.0.22`, encodage `cl100k_base`, données locales et compteur identifié dans les réponses. Tests Unicode/JSON/marqueurs spéciaux hors ligne, adaptateurs et découpage validés. Refus des lignes trop grandes avant tokenisation ; aucune hypothèse de monotonie BPE. [Rapport du compteur](reports/jg-006-response-counter.md).

**Prérequis externe :** environnement Codex disponible pour le test d’intégration réel.

**Références :** spécification §4.4 et §8.2 ; [recherche d’intégration](research/integration.md).

**Objectif :** figer une mesure locale reproductible de la réponse et vérifier le transport choisi sans dépendre de Jev.

**Travaux :** sélectionner et versionner un tokenizer local ; tester JSON, échappements et Unicode. Créer une sonde MCP stdio utilisant le fournisseur simulé. Vérifier découverte de l’outil, réponse JSON unique, erreurs, annulation, fin de stdin et visibilité des grandes réponses dans Codex. Consigner les réglages de timeout et de troncature nécessaires.

**Critères d’acceptation :**

- [x] Le nom, la version et l’encodage du compteur sont enregistrés ; son calcul ne nécessite aucun service distant.
- [x] La garantie documentée porte sur le payload JevGrep sérialisé, sans prétendre mesurer la facturation interne de Codex.
- [ ] Codex reçoit une seule copie complète des extraits dans le mode retenu.
- [ ] Le processus démarre hors ligne, garde stdout propre et se termine à la fermeture de stdin.
- [ ] Une annulation empêche l’émission d’un nouveau résultat pour l’appel annulé.
- [ ] La matrice des versions effectivement testées et les limites de compatibilité sont enregistrées.

**Livrables :** choix du compteur, sonde MCP et rapport de compatibilité réutilisable pour l’adaptateur définitif.

<a id="jg-007"></a>
### JG-007 — Charger la configuration de confiance et fournir `doctor`

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P1. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-002](#jg-002), [JG-003](#jg-003).

**Références :** spécification §2.1, §5.1 et §7.4 ; exigences R1, R2 et R6.

**Objectif :** laisser à l’opérateur le contrôle de la racine, de la divulgation distante et des paramètres de fonctionnement.

**Travaux :** charger un fichier JSON explicitement désigné hors du dépôt recherché. Lire le secret par variable d’environnement, valider le fournisseur, la racine, le modèle et les options. Implémenter `doctor` sans réseau, ainsi qu’un exemple de configuration initiale avec évaluation distante désactivée. Les configurations présentes dans le dépôt ne peuvent pas étendre les autorisations.

**Critères d’acceptation :**

- [ ] Tous les plafonds facultatifs de scan sont désactivés par défaut et restent désactivés lorsque leur valeur est `null`.
- [ ] Le délai et le budget de réponse sont configurables ; aucun plafond caché ne remplace un plafond désactivé.
- [ ] `doctor` affiche l’état utile sans clé, source ni question complète et fonctionne sans appel fournisseur.
- [ ] Un secret absent ou une divulgation désactivée produit une erreur exploitable avant tout appel réel.
- [ ] Une option non supportée, notamment le suivi des liens ou la journalisation de source, est refusée.
- [ ] Les redirections vers un autre domaine ne reçoivent pas les identifiants fournisseur.

**Livrables :** chargeur validé, gestion des secrets, commande `doctor`, exemple de configuration et tests.

<a id="jg-008"></a>
### JG-008 — Garantir le confinement des lectures au dépôt autorisé

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P1. **Statut :** À faire (fixtures de chemins préparées par J, implémentation à faire).

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-003](#jg-003), [JG-007](#jg-007).

**Lot préparatoire J (disponible) :** `tests/fixtures/authorization/scope-cases.json` — 37 cas (`schema_version` 1, `kind: authorization-scope-cases`) couvrant quinze catégories : préfixe partagé avec un répertoire frère, traversée, chemins absolus POSIX/Windows, chemin relatif à un lecteur, UNC, noms de périphériques, flux de données alternatifs, octet NUL, formulaires acceptés, portées qui se recouvrent, liens symboliques et jonctions (y compris dans un segment parent), racines proposées par l’appelant, instructions présentes dans un fichier, entrées vides. Chaque cas porte plateforme, formulaire (`scope` ou `layout`), attendu (`accept`/`reject`/`open`) et raison documentée ; les cas `open` posent une question explicite à S (double barre oblique sur POSIX, deux-points dans un nom POSIX, normalisation des antislashs Windows). `tests/authorization-cases.test.ts` (8 cas) valide la table, vérifie que chaque formulaire interdit est représenté, matérialise la disposition déclarée (répertoires, fichiers, liens) dans un répertoire temporaire et contrôle que chaque cible résolue tombe du bon côté de la racine et que chaque lien déclaré s’échappe réellement de la racine autorisée.

**Références :** spécification §4.1 et §5.1 ; exigences R1 et R11.

**Objectif :** empêcher une portée de recherche ou une entrée du système de fichiers de donner accès à du contenu hors autorisation.

**Travaux :** canonicaliser la racine et vérifier les segments de chemin selon la plateforme. Refuser traversées, chemins absolus, chemins relatifs à un lecteur, UNC, périphériques, NUL et flux alternatifs Windows. Exclure les liens symboliques, jonctions et points de réanalyse, y compris dans les parents. Revalider le type et le confinement à l’ouverture.

**Critères d’acceptation :**

- [ ] Une racine `repo` n’autorise pas une lecture dans un répertoire frère `repo-other`.
- [ ] Chaque forme de chemin interdite est couverte par un test ; aucun contenu hors racine n’est lu ni transmis.
- [ ] Les liens et jonctions ne sont jamais suivis pendant l’inventaire ou la lecture.
- [ ] Les chemins qui se recouvrent désignent une seule identité de fichier lorsque la plateforme les considère identiques.
- [ ] Les instructions présentes dans un fichier et les racines proposées par MCP ne modifient aucune autorisation.
- [ ] Les limites face aux remplacements concurrents et liens physiques sont documentées sans présenter le contrôle comme une sandbox système.

**Livrables :** contrôle d’accès aux chemins et tests Windows/POSIX.

<a id="jg-009"></a>
### JG-009 — Implémenter le cycle de vie et les diagnostics locaux

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P1. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-002](#jg-002), [JG-003](#jg-003), [JG-007](#jg-007).

**Références :** spécification §4.4, §6.3, §7 et §9.

**Objectif :** propager une annulation, un délai et un contexte de diagnostic cohérents dans toutes les étapes du moteur.

**Travaux :** créer le contexte de recherche avec identifiant, horloge, signal d’arrêt et échéance. Distinguer expiration interne et annulation du client. Définir des événements de phase, durée, compteurs, tentatives et erreurs expurgées. Prévoir le nettoyage des ressources dans tous les chemins de sortie.

**Critères d’acceptation :**

- [ ] Le temps d’attente en file participe au délai global ; un délai expiré interdit le lancement de nouvelles tâches.
- [ ] Les tests peuvent déclencher chaque type d’arrêt sans attendre du temps réel.
- [ ] Les diagnostics habituels ne contiennent ni code, ni clé, ni corps fournisseur, ni question complète.
- [ ] Les événements différencient échec, annulation et résultat partiel et utilisent des codes stables.
- [ ] Les handles et permis acquis sont libérés lors d’un arrêt ou d’une exception.

**Livrables :** contexte de recherche, conventions de diagnostic et tests de cycle de vie.

<a id="jg-010"></a>
### JG-010 — Inventorier les fichiers et appliquer les exclusions

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P2–P3. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-008](#jg-008), [JG-009](#jg-009).

**Références :** spécification §5.2 ; exigences R1, R3 et R8.

**Objectif :** produire un inventaire déterministe de la portée éligible, indépendant de la pertinence supposée des fichiers.

**Travaux :** appliquer les exclusions administratives, règles opérateur, `.gitignore` hiérarchiques et `.jevgrepignore` restrictif. Détecter dépendances, fichiers générés/minifiés, binaires, encodages non supportés, tailles exclues et motifs de secrets. Inclure les fichiers modifiés et non suivis lorsqu’ils sont éligibles. Compter distinctement exclusions, erreurs de lecture et parcours incomplets.

**Critères d’acceptation :**

- [ ] Une question différente ne modifie pas la liste des fichiers éligibles pour le même état du dépôt.
- [ ] Les fichiers refusés explicitement restent exclus même lorsqu’ils figurent dans `scope`.
- [ ] Un fichier contenant un motif de secret est écarté entièrement avant envoi ; son texte n’est pas remplacé par une version modifiée.
- [ ] Les fichiers sont ordonnés et dédupliqués de manière stable ; aucun script du dépôt n’est exécuté.
- [ ] Une erreur de parcours empêche de déclarer l’inventaire complet.
- [ ] Le nombre de descendants d’un répertoire non parcouru reste inconnu ; aucun total fictif n’est affiché.

**Livrables :** inventaire, règles d’exclusion documentées et tests d’éligibilité.

<a id="jg-011"></a>
### JG-011 — Capturer les sources et leurs références exactes

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P2–P3. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-008](#jg-008), [JG-010](#jg-010).

**Références :** spécification §4.3 et §5.3 ; exigence R4.

**Objectif :** associer chaque futur extrait à un contenu original identifié, à des octets et à des lignes vérifiables.

**Travaux :** lire les fichiers éligibles en snapshots, valider UTF-8, calculer le SHA-256 des octets originaux et construire les tables d’offsets/lignes. Préserver BOM, espaces et fins de ligne. Gérer la conversion entre positions UTF-16 du parseur TypeScript et positions UTF-8. Garder les sources en mémoire pour la recherche en cours.

**Critères d’acceptation :**

- [ ] Les extraits décodés sont identiques aux tranches correspondantes du snapshot, sans réimpression ni normalisation.
- [ ] Les lignes commencent à 1 et leurs bornes sont inclusives ; CRLF ne crée pas deux retours à la ligne.
- [ ] Les tests couvrent Unicode, caractères hors plan multilingue de base, BOM, LF/CRLF et absence de retour final.
- [ ] Le hash porte sur les octets du fichier entier capturé, et non sur une version transformée ou un seul fragment.
- [ ] Les erreurs de lecture/encodage ont une disposition explicite et ne produisent pas de référence inventée.

**Livrables :** modèle de snapshot, fonctions de tranches exactes et tests de correspondance source/référence.

<a id="jg-012"></a>
### JG-012 — Implémenter le découpage par fenêtres de lignes

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P2. **Statut :** Prêt pour revue M : découpeur par fenêtres livré et testé (`src/source/line-windows.ts`, `tests/line-windows.test.ts`, `tests/line-windows-corpus.test.ts`) ; l’interface exportée est volontairement étroite (une fonction pure plus ses types) pour que le découpeur syntaxique de JG-015 la compose sans la modifier, et le retour par repli est signalé par la classification.

**Niveau recommandé :** Junior encadré. **Pilote proposé :** J. **Revue :** M.

**Dépendances :** [JG-006](#jg-006), [JG-011](#jg-011).

**Livré :** `src/source/line-windows.ts` — fonction pure `lineWindows(snapshot, limites, compteur)` : fenêtres contiguës alignées sur les lignes, limites configurables (cibles 800 tokens / 80 lignes, max 1600 tokens / 8 Kio / 120 lignes, recouvrement ≤ 8 lignes), métadonnées par fragment (identifiant, chemin, hash, décalages d’octets UTF-8, lignes inclusives, texte original, tailles, classification, version du découpeur). Une ligne qu’aucune fenêtre légale ne peut contenir est signalée (`unsupported-long-line`, raison `unsupported_long_line`) au lieu d’être tronquée ; un fichier sans ligne non vide ne produit aucune fenêtre. `tests/line-windows.test.ts` : 11 cas, dont un balayage paramétré (5 formes de source × 6 profils de limites) et une vérification par mutation : cinq mutations du découpeur (recouvrement supprimé, limite d’octets ignorée, limite de lignes ignorée, texte tronqué, garde de fin de fichier retirée) font échouer la suite.

**Références :** spécification §5.4 ; exigences R3 et R4.

**Objectif :** proposer un découpage fiable avant le parseur syntaxique, réutilisable comme solution de repli.

**Travaux :** créer des fragments contigus aux bornes de lignes avec limites configurables de tokens de référence, d’octets et de lignes. Appliquer le recouvrement prévu. Attacher chemin, hash, offsets, lignes, tailles et version du découpage. Prendre en charge les fichiers texte autorisés, dont configuration, Markdown et SQL.

**Critères d’acceptation :**

- [x] Chaque ligne non vide d’un fichier préparé est couverte par au moins un fragment. *(tests unitaires + filet sur le corpus réel)*
- [x] Un fragment respecte les limites actives sans tronquer une ligne ni un caractère. *(balayage 5 formes × 6 profils ; tranches d’octets vérifiées)*
- [x] Une ligne isolée impossible à représenter est signalée explicitement selon la politique de contenu supporté. *(`unsupported-long-line`, raison `unsupported_long_line`)*
- [x] Le même snapshot et les mêmes paramètres produisent les mêmes fragments dans le même ordre. *(déterminisme testé sur entrée générée et sur corpus réel)*
- [x] Les fenêtres contiennent uniquement du texte original ; leur chevauchement ne duplique pas les fichiers inventoriés. *(texte = tranche exacte ; identité de fichier unique sous recouvrement)*

**Livrables :** découpeur par fenêtres, métadonnées des fragments et tests de couverture.

<a id="jg-013"></a>
### JG-013 — Implémenter l’adaptateur Jev et normaliser ses réponses

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P2. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-004](#jg-004), [JG-005](#jg-005), [JG-007](#jg-007), [JG-009](#jg-009).

**Références :** spécification §6 et §10 ; exigence R5.

**Objectif :** isoler le contrat fournisseur derrière un adaptateur qui ne décide ni des autorisations ni des reprises.

**Travaux :** construire les requêtes selon la disposition retenue ; transmettre le critère de pertinence versionné et les métadonnées nécessaires. Valider les identifiants de questions, types Noul, scores et usages à l’exécution. Normaliser les erreurs. Exposer l’annulation et les métadonnées utiles au moteur. Désactiver les reprises et journaux de corps du SDK.

**Critères d’acceptation :**

- [ ] Chaque score valide est associé au fragment attendu indépendamment de l’ordre des réponses.
- [ ] Les réponses absentes, surnuméraires, dupliquées, de mauvais type, non finies ou hors `[0,1]` sont détectées.
- [ ] Un score indisponible reste indisponible ; il n’est jamais remplacé par zéro.
- [ ] Les usages absents et identifiants de modèle non résolus restent explicitement inconnus.
- [ ] Un appel à l’adaptateur représente une seule tentative observable ; les reprises relèvent de JG-017.
- [ ] Les tests de contrat fonctionnent avec les réponses enregistrées ; les tests réels sont séparés.

**Livrables :** adaptateur Jev, normalisation des réponses/erreurs et tests associés.

<a id="jg-014"></a>
### JG-014 — Livrer un premier parcours CLI complet sur fixtures

**Type :** Intégration. **Priorité :** Haute. **Phase :** P2. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-003](#jg-003), [JG-006](#jg-006), [JG-007](#jg-007), [JG-010](#jg-010), [JG-011](#jg-011), [JG-012](#jg-012).

**Références :** plan P2 ; spécification §3 et §4.5.

**Objectif :** vérifier tôt le parcours question → fichiers → fragments → scores → extraits, via la future interface partagée du moteur.

**Travaux :** créer `search(request, context)` et relier une première commande `search --json` au fournisseur simulé. Utiliser le découpage par fenêtres, un classement simple et un rendu conforme aux contrats. Les étapes suivantes complètent ces modules ; elles ne créent pas un second moteur. Ce jalon est une démonstration de développement, pas le parcours réel final.

**Critères d’acceptation :**

- [ ] Une fixture connue produit un résultat JSON validé avec le chemin, les lignes, le hash et le texte attendus.
- [ ] Une fixture sans résultat produit une sélection vide avec une raison correcte.
- [ ] Une réponse fournisseur simulée invalide ne devient pas un résultat négatif inventé.
- [ ] Le résultat mesuré tient dans le budget de réponse de la fixture.
- [ ] La commande appelle le moteur partagé ; la logique de recherche n’est pas enfouie dans le parseur CLI.
- [ ] Le jalon est reproductible hors ligne ; l’activation du moteur réel final dépend de JG-022.

**Livrables :** première exécution de bout en bout, commande de démonstration et test d’intégration. **Jalon M1.**

<a id="jg-015"></a>
### JG-015 — Ajouter le découpage syntaxique JavaScript/TypeScript

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P3. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-012](#jg-012).

**Références :** spécification §5.4 ; exigences R3, R4 et R11.

**Objectif :** améliorer les frontières des fragments JS/TS tout en conservant la couverture des sources.

**Travaux :** utiliser le parseur syntaxique TypeScript sur les extensions prévues. Repérer déclarations, fonctions, méthodes, classes, imports/exports, décorateurs et commentaires associés. Conserver les instructions de premier niveau et les zones non attribuées. Diviser les grandes constructions et utiliser JG-012 en cas d’échec de parsing.

**Critères d’acceptation :**

- [ ] Les tests couvrent `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts` et `.cts`.
- [ ] Routes, gestionnaires d’événements et effets de premier niveau restent recherchables même hors fonction nommée.
- [ ] Toutes les lignes non vides d’un fichier préparé sont couvertes ; les identités et tailles restent déterministes.
- [ ] Aucun plugin du dépôt, import exécutable, compilation applicative ou vérification globale des types n’est lancé.
- [ ] Un fichier malformé passe au découpage de repli avec un diagnostic, sans disparition silencieuse.
- [ ] Les extraits sont des tranches du snapshot ; le générateur de code du parseur n’est pas utilisé.

**Livrables :** découpeur JS/TS, politique de repli et fixtures syntaxiques.

<a id="jg-016"></a>
### JG-016 — Planifier le scan et comptabiliser les limites facultatives

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P4. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-007](#jg-007), [JG-012](#jg-012), [JG-013](#jg-013), [JG-018](#jg-018).

**Références :** spécification §7 et §4.2 ; exigences R6 et R8.

**Objectif :** appliquer uniquement les limites configurées, avec une comptabilité distincte du budget de réponse.

**Travaux :** calculer le plan des premières tentatives après recherche des évaluations réutilisables. Estimer les entrées complètes et leur coût avec une grille tarifaire datée. Réserver atomiquement les capacités activées avant chaque envoi, puis rapprocher usage connu et estimations. Rejeter avant envoi un plan qui dépasse un plafond actif en mode complet ; accepter un préfixe déterministe si le mode partiel est explicite.

**Critères d’acceptation :**

- [ ] Tous les plafonds à `null` restent désactivés, même si un ancien seuil expérimental est dépassé.
- [ ] Un rejet préalable produit zéro appel fournisseur et indique, pour chaque plafond actif, la capacité autorisée et le besoin dans la même unité.
- [ ] Les réservations simultanées et reprises ne dépassent pas les plafonds locaux stricts d’octets/tentatives.
- [ ] Les estimations de tokens/USD ne sont pas présentées comme une garantie de facture ; les usages ambigus restent réservés et inconnus.
- [ ] Un dépassement d’estimation seul n’interrompt pas un scan sans plafond applicable.
- [ ] Un plafond USD sans tarif exploitable est refusé ; le budget de réponse ne réduit pas implicitement le volume à scanner.
- [ ] Le plan préalable couvre les premières tentatives ; les reprises consomment la capacité restante à l’exécution.

**Livrables :** planificateur préalable, comptabilité/réservations et tests de concurrence/limites.

<a id="jg-017"></a>
### JG-017 — Ordonner les lots, reprises et annulations

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P4. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-009](#jg-009), [JG-013](#jg-013), [JG-016](#jg-016).

**Références :** spécification §6.3, §7 et §10 ; exigences R3, R5 et R6.

**Objectif :** exécuter les évaluations de façon bornée et observable sans confondre incident fournisseur et non-pertinence.

**Travaux :** former des lots déterministes compatibles avec les capacités Jev mesurées. Appliquer la concurrence configurable, une recherche active et la file bornée prévue. Gérer les reprises finies, `Retry-After`, l’attente progressive et les erreurs terminales. Propager délais et annulations à l’ordonnancement et aux appels en cours.

**Critères d’acceptation :**

- [ ] Chaque tentative, y compris reprise, acquiert sa réservation et son permis avant envoi.
- [ ] L’ordre de fin des requêtes ne modifie pas le classement lorsque les scores sont identiques.
- [ ] Une erreur d’authentification ou de modèle interdit arrête les nouveaux envois ; les résultats déjà valides sont conservés.
- [ ] Les pertes de connexion ambiguës ne sont pas reprises automatiquement par défaut ; leurs usages ne deviennent pas nuls.
- [ ] Une annulation ou une échéance arrête les nouveaux envois et libère les ressources ; un test en sous-processus vérifie l’absence de plantage.
- [ ] Une file saturée retourne `BUSY` ; son temps d’attente est inclus dans le délai global.
- [ ] Aucune reprise implicite du SDK n’échappe à la comptabilité.

**Livrables :** ordonnanceur, politique d’erreurs/reprises et scénarios de panne reproductibles.

<a id="jg-018"></a>
### JG-018 — Mettre en cache uniquement les évaluations identiques

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P4. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-005](#jg-005), [JG-009](#jg-009), [JG-011](#jg-011), [JG-013](#jg-013).

**Références :** spécification §9 ; exigence R9.

**Objectif :** éviter les appels réellement identiques sans réutiliser un jugement dont la question ou le contexte a changé.

**Travaux :** calculer l’identité à partir de tous les éléments visibles par le modèle, de la disposition des requêtes et de la révision du modèle. Implémenter un cache local de scores et empreintes avec schéma versionné, écriture atomique, durée de vie, taille maximale et effacement. Le format initial utilise des entrées JSON hors du dépôt, sauf justification mesurée d’un autre format.

**Critères d’acceptation :**

- [ ] Une répétition strictement identique réutilise le score sans nouvel appel Jev.
- [ ] Une modification de question, chemin transmis, contenu, critère, état partagé ou modèle empêche la réutilisation affectée.
- [ ] Le seuil de sélection, le budget de réponse, le délai et les plafonds de scan ne changent pas seuls l’identité sémantique.
- [ ] Aucun code brut, question complète, corps fournisseur ni identifiant secret n’est persisté.
- [ ] Une entrée corrompue, expirée ou incomplète est traitée comme une absence de cache.
- [ ] Les modèles dont la révision est indéterminée ne bénéficient pas d’une réutilisation persistante supposée sûre.
- [ ] TTL, éviction et effacement sont testés ; les références de lignes proviennent toujours du snapshot courant.

**Livrables :** cache de scores, calcul d’identité, primitive d’effacement et tests d’invalidation.

<a id="jg-019"></a>
### JG-019 — Classer et fusionner les extraits sélectionnés

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P5. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-002](#jg-002), [JG-006](#jg-006), [JG-015](#jg-015).

**Références :** spécification §8.1 ; exigences R4 et R7.

**Objectif :** fournir une sélection simple, déterministe et traçable à partir des évaluations valides.

**Travaux :** filtrer par seuil, trier par score puis références stables, éliminer les doublons de plage d’un même snapshot, fusionner les plages recouvrantes ou adjacentes lorsqu’elles tiennent dans le budget. Conserver les chemins distincts même si leur texte est identique. Préparer les compteurs de fragments représentés et omis ; la garantie finale de rendu relève de JG-020.

**Critères d’acceptation :**

- [ ] L’ordre est stable en cas d’égalité et indépendant de l’ordre des réponses fournisseur.
- [ ] Une fusion porte uniquement sur un même fichier/hash et produit une tranche contiguë du snapshot.
- [ ] Deux plages disjointes ne sont jamais présentées comme un seul extrait continu.
- [ ] Un candidat trop volumineux est ignoré sans empêcher la sélection d’un candidat suivant qui tient.
- [ ] Un fragment déjà couvert par une plage sélectionnée est compté comme représenté une seule fois.
- [ ] Le score d’une plage fusionnée est le maximum de ses contributeurs ; aucune certitude supplémentaire n’est inventée.

**Livrables :** sélection/fusion, ordre documenté et tests d’intervalles, égalités et doublons.

<a id="jg-020"></a>
### JG-020 — Garantir le budget de la réponse sérialisée

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P5. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-002](#jg-002), [JG-006](#jg-006), [JG-019](#jg-019).

**Références :** spécification §4.4 et §8.2 ; exigence R7.

**Objectif :** garantir que le payload complet respecte le budget sous le tokenizer déclaré, code et métadonnées compris.

**Travaux :** produire le JSON canonique, borner les diagnostics et réserver une enveloppe obligatoire conservatrice avant tout travail payant. Compter la représentation réellement sérialisée, puis retirer des plages et recalculer les compteurs jusqu’à respect du budget. Garder le nombre mesuré dans les diagnostics locaux pour éviter une valeur autoréférentielle dans le payload.

**Critères d’acceptation :**

- [ ] Tous les cas valides testés vérifient `count(payload) <= max_context_tokens` après sérialisation finale.
- [ ] Le calcul inclut chemins, hash, scores, JSON échappé, compteurs et rapport, pas seulement le code.
- [ ] Une enveloppe obligatoire qui ne tient pas provoque `RESPONSE_BUDGET_TOO_SMALL` avant appel Jev.
- [ ] Aucune chaîne JSON, ligne source ou plage n’est tronquée pour gagner de la place.
- [ ] Le nombre d’itérations est borné par les plages retirées ; le résultat JSON reste valide.
- [ ] L’erreur compacte respecte ses deux limites de 4 096 octets UTF-8 et 1 024 tokens de référence.
- [ ] Les tests couvrent petits budgets, longs chemins, Unicode, guillemets, caractères d’échappement et listes de diagnostics saturées.

**Livrables :** rendu JSON mesuré, réservation de l’enveloppe obligatoire et tests de budget.

<a id="jg-021"></a>
### JG-021 — Écarter les extraits devenus obsolètes

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P3–P5. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-011](#jg-011), [JG-019](#jg-019), [JG-020](#jg-020).

**Références :** spécification §4.3 et §8.1 ; exigences R4 et R8.

**Objectif :** éviter de retourner du code courant accompagné d’un score calculé sur une ancienne version du fichier.

**Travaux :** revalider le hash des fichiers sélectionnés avant rendu. Retirer leurs plages si le fichier change ou disparaît, marquer ces fichiers comme indisponibles pour la recherche et tenter de remplir l’espace libéré sans nouvel appel Jev. Revalider aussi tout nouveau fichier introduit par remplacement.

**Critères d’acceptation :**

- [ ] Une modification ou suppression pendant l’évaluation empêche le retour des extraits concernés.
- [ ] Chaque fichier de remplacement est contrôlé avant son inclusion ; un fichier détecté obsolète ne réapparaît pas.
- [ ] Le nombre de vérifications est borné à une tentative par fichier candidat.
- [ ] Aucune réévaluation payante n’est déclenchée silencieusement pour réparer une source obsolète.
- [ ] Les compteurs d’obsolescence, le statut partiel et `scope_fully_scanned=false` sont transmis à l’assemblage du rapport.
- [ ] Lorsque toutes les preuves qualifiées deviennent obsolètes, le résultat peut exprimer `no_fresh_excerpt`.

**Livrables :** contrôle de fraîcheur, remplissage borné et tests de modifications concurrentes.

<a id="jg-022"></a>
### JG-022 — Finaliser le moteur et ses rapports de couverture

**Type :** Intégration. **Priorité :** Critique. **Phase :** P5. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-014](#jg-014), [JG-015](#jg-015), [JG-016](#jg-016), [JG-017](#jg-017), [JG-018](#jg-018), [JG-020](#jg-020), [JG-021](#jg-021).

**Références :** spécification §3, §4.2–4.4 et §10 ; exigences R3–R10.

**Objectif :** réunir les modules dans un seul moteur et rendre chaque résultat interprétable, y compris incomplet ou vide.

**Travaux :** finaliser le parcours partagé, les transitions de statut, les raisons de sélection vide et les compteurs. Distinguer évaluations nouvelles, cache réellement réutilisé, cache seulement prévu, échecs et omissions de réponse. Produire estimations préalables, plafonds actifs, usages connus/inconnus et raisons d’arrêt bornées.

**Critères d’acceptation :**

- [ ] Pour une préparation complète, les trois égalités de compteurs de la spécification §4.2 sont vérifiées.
- [ ] Un inventaire/préparation incomplet utilise `total=null` et ne présente pas des comptes partiels comme le total du dépôt.
- [ ] Un rejet préalable ne compte aucun appel ni réemploi exécuté du cache, même si le plan détectait des correspondances.
- [ ] `scope_fully_scanned=true` exige une préparation complète et toutes les évaluations disponibles ; les omissions dues au budget de réponse seules ne rendent pas le scan partiel.
- [ ] Les résultats vides suivent la priorité de raisons définie dans la spécification, sans affirmer l’absence du comportement recherché.
- [ ] Usage total, sous-total connu et coût estimé restent distincts en présence d’une tentative ambiguë.
- [ ] Le moteur réel et le moteur simulé passent par le même parcours ; toute réponse finale passe le validateur et le compteur de JG-020.

**Livrables :** moteur final partagé, assemblage du rapport et scénarios d’intégration complets. **Jalon M2, sous réserve de JG-025.**

<a id="jg-023"></a>
### JG-023 — Finaliser toutes les commandes CLI

**Type :** Implémentation. **Priorité :** Haute. **Phase :** P6. **Statut :** En cours (lots J livrés : arguments, rendu humain, aide par commande ; branchement au moteur et commandes finales en attente de JG-014 et JG-022).

**Niveau recommandé :** Junior encadré. **Pilote proposé :** J. **Revue :** M.

**Dépendances :** [JG-007](#jg-007), [JG-010](#jg-010), [JG-014](#jg-014), [JG-018](#jg-018), [JG-022](#jg-022).

**Lot préparatoire J (disponible) :** `src/cli-args.ts` + `tests/cli-args.test.ts` (11 cas) — analyse des arguments des formulaires documentés (`doctor`, `inspect`, `search`, `mcp`, `cache clear` ; `--config`, `--query`, `--query-file`, `--scope` répétable, `--max-context-tokens`, `--json`, `--allow-partial`). Les valeurs par défaut et les bornes viennent du contrat partagé (`CONTRACT_LIMITS` : 4 000 par défaut, 1 024 minimum, 16 000 maximum, portée ≤ 32 entrées et 4 096 octets) et la requête de recherche est validée par `parseSearchRequest` de `src/contracts.ts`, donc la CLI et MCP ne peuvent pas diverger. L’analyse est pure (aucune lecture de configuration, de dépôt ou de réseau) ; option inconnue ou mal placée, valeur manquante, `--config` absent, source de requête absente ou double, budget non entier ou hors bornes, portée absolue ou traversante, sous-commande `cache` absente ou inconnue sont refusés avec un message et le code 2 de la spécification §4.5. **Branchement au moteur (J, livré) :** `src/cli.ts` transmet une commande validée à la couche de commandes partagée (`executeCommand`) ; le code de sortie de la commande est propagé tel quel et validé contre l’ensemble {0, 2, 3, 4, 130}. Un signal d’interruption unique (SIGINT/SIGTERM) est transmis à la commande. `doctor`, `inspect` et `cache clear` fonctionnent donc réellement hors ligne, sans clé et sans appel fournisseur ; une recherche sans clé sort en 2 avec la charge canonique `CREDENTIAL_MISSING` sur stdout et aucune requête envoyée. Le code d’échafaudage 69 a disparu avec la dernière commande non implémentée : plus rien n’est annoncé comme indisponible.

**Rendu humain J (disponible) :** `src/cli-render.ts` + `tests/cli-render.test.ts` (5 cas) — en-tête d’état, ligne de couverture, raisons d’arrêt bornées, extraits affichés **verbatim** (sauts de ligne CRLF compris, aucune réindentation ni reformulation), et mesure de la vue humaine elle-même (tokens du compteur de référence et octets) présentée **séparément** du budget de réponse qui appartient à la charge JSON (spécification §4.5). Un résultat partiel indique explicitement que la couverture est incomplète et qu’une sélection vide n’établit pas l’absence ; un refus ou une erreur affiche le code et le conseil de reprise sans inventer de preuve. Le rendu est pur et déterministe (même sortie mesurée deux fois), prêt à être raccordé au moteur avec JG-014.

**Branchement J (prêt) :** `src/cli.ts` accepte désormais un exécuteur injecté (`CliDependencies.runCommand`). Une commande validée est transmise telle quelle (type, config, portée, requête résolue, `--json`) et le code de sortie de l’exécuteur est propagé ; sans exécuteur, la commande reste refusée en 69 après validation, donc rien d’inexistant n’est présenté comme disponible. Un échec de l’exécuteur sort en 4 avec une ligne de diagnostic : seul un code court en majuscules est repris, jamais le message (qui peut contenir un chemin ou du code), et un code de sortie non entier est traité comme fatal. `tests/cli.test.ts` couvre les cinq transitions, y compris par mutation (faire fuiter le message fait échouer la suite).

**Aide J (disponible) :** `src/cli-help.ts` + `tests/cli-help.test.ts` (5 cas) — page d’aide par commande et aide globale. La liste d’options est générée depuis la table que l’analyseur applique (`allowedOptionsFor`), donc l’aide ne peut ni annoncer une option refusée ni en cacher une acceptée : un test le vérifie dans les deux sens. `jevgrep <commande> --help` (et `jevgrep cache clear --help`) sort en 0 avec la page demandée ; chaque page rappelle l’état « not implemented in this build » et cite la spécification dont elle vient (§2.1, §4.1, §4.5, §7.3).

**Références :** spécification §2.1 et §4.5 ; exigence R10.

**Objectif :** rendre le moteur utilisable directement et fournir les commandes locales d’inspection et de maintenance.

**Travaux :** finaliser `doctor`, `inspect`, `search`, `cache clear` et leur aide. Ajouter les portées répétées, `--query-file`, `--json`, le budget de réponse et le mode partiel explicite. Fournir le rendu lisible avec sa propre vérification de taille. Réserver stdout au résultat demandé et stderr aux diagnostics.

**Critères d’acceptation :**

- [ ] `doctor` et `inspect` fonctionnent sans clé ni autorisation d’envoi et effectuent zéro appel fournisseur.
- [ ] `inspect` affiche portée, exclusions, fragments et estimations ; une grandeur inconnue reste identifiée comme telle.
- [ ] `search --json` retourne exactement le contrat canonique du moteur.
- [ ] Les codes de sortie sont 0 pour complet, 2 pour rejet/entrée invalide, 3 pour partiel, 4 pour échec fatal et 130 pour interruption utilisateur.
- [x] Les questions multilignes via fichier sont prises en charge sans interprétation du contenu comme commande shell. *(`--query-file` lu tel quel, testé avec tabulations et sauts de ligne)*
- [ ] `cache clear` n’efface que le cache configuré ; les commandes n’écrivent pas dans les sources recherchées.
- [~] Les exemples d’aide correspondent à des commandes réellement disponibles ; les différences de rendu ne sont pas dissimulées dans la comptabilité. **(partiel : l’aide n’annonce rien qui n’existe et la vue humaine comptabilise sa propre taille, mais aucune commande n’est encore disponible)**

**Livrables :** CLI complète, aide, tests des arguments/sorties et exemples exécutables.

<a id="jg-024"></a>
### JG-024 — Exposer le moteur par le serveur MCP de production

**Type :** Implémentation. **Priorité :** Critique. **Phase :** P6. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-006](#jg-006), [JG-009](#jg-009), [JG-022](#jg-022).

**Références :** spécification §4.1 et §4.4 ; exigence R10.

**Objectif :** permettre à Codex d’appeler la recherche sémantique via un adaptateur MCP fin.

**Travaux :** implémenter `jevgrep mcp --config ...` avec le SDK validé. Exposer uniquement `semantic_search_code`, son schéma d’entrée strict et sa description d’usage. Retourner un seul bloc texte JSON validé. Gérer erreurs d’outil, progression supportée, annulation, EOF et arrêt du processus.

**Critères d’acceptation :**

- [ ] Le démarrage ne scanne pas le dépôt et ne contacte pas Jev ; l’outil est découvert hors ligne.
- [ ] Le schéma ne permet pas de changer racine, secrets, destination fournisseur, modèle ou plafonds opérateur.
- [ ] `complete` et `partial` utilisent `isError=false` ; `rejected` et `error` utilisent `isError=true` ; les erreurs de protocole restent gérées par le SDK.
- [ ] Une seule copie du payload est exposée ; aucun `outputSchema` incompatible avec ce mode n’est déclaré.
- [ ] stdout contient exclusivement le protocole ; les diagnostics vont sur stderr.
- [ ] Aucun nouveau résultat n’est émis après annulation du client ; une échéance interne peut renvoyer un résultat partiel avant le timeout du client.
- [ ] La fermeture de stdin termine proprement le serveur et les éventuelles opérations en attente.

**Livrables :** serveur MCP stdio, raccordement CLI et tests en sous-processus.

<a id="jg-025"></a>
### JG-025 — Valider les invariants et la parité CLI/MCP

**Type :** Validation. **Priorité :** Critique. **Phase :** P5–P6. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-023](#jg-023), [JG-024](#jg-024).

**Références :** spécification §11.1 ; exigences R1–R11 ; [revue de conception](research/design-review.md).

**Objectif :** vérifier les garanties transversales avant de considérer le MVP utilisable dans un vrai travail.

**Travaux :** compléter les tests des modules par des parcours adverses de bout en bout. Couvrir chemins, exclusions, Unicode, erreurs Jev, limites concurrentes, cache, obsolescence, réponse bornée et nettoyage. Comparer CLI JSON et MCP sur les mêmes snapshots et scores. Introduire des tests génératifs/paramétrés sur les invariants qui le justifient.

**Critères d’acceptation :**

- [ ] Les tests R1–R11 passent sur Windows et Linux ; chaque exigence est reliée à au moins un contrôle.
- [ ] Aucun octet non autorisé n’atteint l’adaptateur dans les fixtures d’attaque de chemins ou d’exclusion.
- [ ] Chaque extrait émis correspond au snapshot annoncé ; tous les payloads testés respectent leur budget déclaré.
- [ ] Les sorties CLI JSON et MCP sont équivalentes après retrait des identifiants générés et temps d’exécution.
- [ ] Les scénarios erreur/reprise/annulation ne produisent ni faux score, ni fausse couverture, ni ressources abandonnées.
- [ ] Les plafonds désactivés et activés sont tous deux testés ; les hypothèses de facturation restent correctement qualifiées.
- [ ] La CI reste hors ligne ; les résultats des tests fournisseur réels sont conservés séparément.

**Livrables :** suite transversale, matrice exigences/tests et rapport de validation.

<a id="jg-026"></a>
### JG-026 — Rendre l’installation et la configuration reproductibles

**Type :** Livraison. **Priorité :** Haute. **Phase :** P6. **Statut :** À faire.

**Niveau recommandé :** Junior encadré. **Pilote proposé :** J. **Revue :** M.

**Dépendances :** [JG-023](#jg-023), [JG-024](#jg-024), [JG-025](#jg-025).

**Références :** spécification §2.1 et §12 ; plan P6.

**Objectif :** permettre l’installation locale du MVP et son raccordement à Codex à partir d’instructions vérifiées.

**Travaux :** produire un artefact local versionné ; documenter installation, configuration externe de confiance, variable d’environnement, inspection, activation distante, limites facultatives et cache. Fournir une configuration MCP utilisant des chemins absolus. Régler et tester timeout extérieur et limite de sortie du client. Ajouter un guide de diagnostic des erreurs courantes.

**Critères d’acceptation :**

- [ ] Une installation propre sur Windows permet d’exécuter `doctor`, `inspect`, une recherche et le serveur MCP en suivant uniquement le guide.
- [ ] Le même artefact passe le parcours CLI/MCP automatisé sur Linux.
- [ ] Codex reçoit la plus grande réponse autorisée dans la configuration testée sans troncature.
- [ ] Le timeout du client laisse la marge documentée au délai interne et à la finalisation ; un délai plus long est configurable.
- [ ] Le guide explique quels extraits partent chez Jev, sans promettre une inférence locale ou une rétention nulle non vérifiée.
- [ ] Les exemples ne contiennent aucun secret et n’installent pas une version non figée à chaque démarrage.
- [ ] La matrice runtime/SDK/Codex réellement testée est jointe ; aucune publication publique n’est nécessaire à cette issue.

**Livrables :** artefact installable, guide d’installation/utilisation et preuve d’intégration Codex. **Jalon M3.**

<a id="jg-027"></a>
### JG-027 — Constituer le corpus de recherche et ses annotations

**Type :** Préparation d’évaluation. **Priorité :** Normale. **Phase :** P0–P7. **Statut :** Corpus et revue S terminés ; validation opérationnelle de l’isolation réservée à l’exécuteur.

**État au 19 septembre 2026 :** protocole v1 revu ; six fixtures autorisées, 42 questions de développement (30 comportementales, 10 contrôles exacts, 2 sans preuve) et 12 questions réservées sur trois fixtures distinctes. Huit annotations corrigées après revue indépendante. Le précédent jeu réservé, trop proche du développement, est retiré avant réglage. `answers_ref` est un identifiant opaque ; les réponses privées sont chargées uniquement avec `--answers` et exigées pour scorer via `--require-answers`. Les 35 tests du corpus et le contrôle opérateur des réponses v2 passent. Rapport : [revue JG-027](reviews/jg-027-review.md).

**Reste à prouver lors de JG-028/JG-029 :** exécuter l’agent dans une copie de fixture isolée, sans accès au dépôt des curateurs ni au stockage des réponses ; conserver les contrôles négatifs d’accès. Un fichier hors dépôt ne constitue pas à lui seul une isolation. La préparation du runner peut commencer ; aucun résultat réservé ne doit être publié avant ce contrôle.

**Niveau recommandé :** Junior encadré. **Pilote proposé :** J. **Revue :** S.

**Dépendances :** Aucune ; ce travail peut commencer dès le début du projet.

**Références :** spécification §11.2 ; plan P7 ; exigence R12.

**Objectif :** disposer de questions et de preuves de référence indépendantes des réglages choisis pour le moteur.

**Travaux :** préparer au moins trois dépôts JS/TS ou fixtures réalistes autorisés, avec au moins 30 questions comportementales et 10 contrôles par identifiant exact au total. Inclure configuration, migrations, tests, connexions entre fichiers, doublons, absence de preuve et différentes tailles de portée. Annoter les plages utiles et les ensembles de preuves alternatifs. Séparer développement et évaluation réservée avant réglage.

**Critères d’acceptation :**

- [x] Chaque exemple identifie le dépôt, sa révision ou son empreinte, la question, la portée et les preuves attendues.
- [x] Les annotations portent sur des plages et leur utilité, pas uniquement sur des noms de fichiers.
- [x] Les deux ensembles, développement et évaluation réservée, sont distincts et versionnés.
- [x] Les licences et autorisations des contenus utilisés sont enregistrées.
- [ ] Les réponses de référence et correctifs ne sont pas accessibles à l’agent évalué dans son espace de travail.
- [x] Les annotations admettent les preuves alternatives et signalent les cas ambigus.

**Livrables :** corpus versionné, manifestes, annotations et procédure de revue.

<a id="jg-028"></a>
### JG-028 — Mesurer la qualité de recherche et figer les réglages

**Type :** Évaluation. **Priorité :** Normale. **Phase :** P7. **Statut :** À faire.

**Niveau recommandé :** Medium. **Pilote proposé :** M. **Revue :** S.

**Dépendances :** [JG-005](#jg-005), [JG-022](#jg-022), [JG-027](#jg-027).

**Références :** spécification §11.2 ; plan P7 ; exigence R12.

**Objectif :** mesurer les preuves retrouvées sous budget et choisir des réglages sans exploiter les réponses du jeu réservé.

**Travaux :** créer un exécuteur reproductible enregistrant versions, configuration, cache, scores et métriques. Mesurer précision/rappel des preuves, tokens de réponse, latence médiane et de fin de distribution, coût estimé/déclaré disponible, échecs et couverture. Régler seuil, découpage et taille des lots sur le développement uniquement, puis figer ces valeurs avant l’évaluation réservée.

**Critères d’acceptation :**

- [ ] Chaque exécution produit un manifeste suffisant pour reproduire son contexte et ses paramètres.
- [ ] Cache froid et cache chaud font l’objet de résultats séparés.
- [ ] Les recherches partielles, vides et échouées sont incluses dans les résultats publiés.
- [ ] L’usage inconnu n’est pas comptabilisé comme un coût nul ; un tarif calculé reste étiqueté comme estimation.
- [ ] Les réglages sont figés avant le jeu réservé et les écarts sont ventilés par catégorie de question.
- [ ] Le rapport traite les annotations comme une référence révisable, pas comme la preuve que tout extrait non annoté est inutile.

**Livrables :** exécuteur de benchmark de recherche, résultats, configuration figée et analyse des échecs.

<a id="jg-029"></a>
### JG-029 — Comparer les tâches Codex avec et sans JevGrep

**Type :** Évaluation. **Priorité :** Normale. **Phase :** P7. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-026](#jg-026), [JG-028](#jg-028).

**Prérequis externe :** accès aux exécutions de l’agent et du fournisseur, avec budget expérimental explicite.

**Références :** spécification §11.3 ; plan P7 ; exigence R12.

**Objectif :** déterminer l’effet de JevGrep sur la réussite et le coût/temps de tâches complètes, pas seulement sur la taille d’une réponse.

**Travaux :** préparer environ 10 tâches appariées de premier contrôle : A avec outils habituels ; B avec les mêmes outils et JevGrep disponible. Utiliser mêmes modèle, paramètres, objectifs, états de départ et plafonds expérimentaux. Alterner ou randomiser l’ordre, isoler fichiers/caches et laisser l’agent choisir l’outil. Évaluer avec tests de comportement et critères de revue indépendants.

**Critères d’acceptation :**

- [ ] Chaque paire conserve un manifeste de l’état initial, des réglages et du critère objectif de réussite.
- [ ] Les modifications d’un essai et le réchauffement de son cache ne contaminent pas l’autre condition.
- [ ] Le rapport mesure réussite, coût combiné agent/Jev, temps total, appels de recherche/lecture, contexte reçu et usage effectif de JevGrep.
- [ ] Les usages indisponibles, reprises et appels échoués sont visibles dans la comptabilité.
- [ ] Chaque régression est examinée ; une réduction de tokens seule ne suffit pas à conclure à un gain.
- [ ] Ce petit échantillon est présenté comme exploratoire ; aucune non-infériorité statistique générale n’est revendiquée.
- [ ] Les conditions d’un éventuel pilote élargi et d’une étude réservée sont proposées après estimation de la variabilité.

**Livrables :** tâches appariées, procédure d’exécution, traces expurgées et comparaison A/B.

<a id="jg-030"></a>
### JG-030 — Livrer le MVP open source expérimental et son bilan

**Type :** Livraison et décision. **Priorité :** Haute. **Phase :** P7. **Statut :** À faire.

**Niveau recommandé :** Senior. **Pilote proposé :** S. **Revue :** M.

**Dépendances :** [JG-026](#jg-026), [JG-029](#jg-029).

**Références :** spécification §12 ; plan §12–13 ; exigences R1–R12.

**Objectif :** publier une version open source expérimentale exploitable avec un état exact de ses garanties, de ses résultats et de ses limites.

**Travaux :** consolider l’artefact versionné, les contrôles, la documentation et les rapports. Vérifier les décisions du MVP et les fonctionnalités réellement livrées. Documenter les cas où la recherche aide, les régressions, les limitations connues et les suites justifiées par les mesures. Distinguer disponibilité fonctionnelle et bénéfice démontré.

**Critères d’acceptation :**

- [ ] Les exigences R1–R11 sont couvertes par des contrôles réussis et R12 dispose des mesures prévues pour le premier bilan.
- [ ] La version peut être installée et utilisée selon JG-026 ; aucun comportement non livré n’est annoncé.
- [ ] Les plafonds facultatifs sont toujours désactivés par défaut ; les réglages d’expérimentation ne sont pas devenus des restrictions cachées.
- [ ] Le bilan contient aussi les résultats défavorables et les usages inconnus, avec les versions et paramètres évalués.
- [ ] Le statut expérimental est maintenu lorsque les gains ne sont pas établis ; un résultat défavorable peut conduire à restreindre ou suspendre l’usage.
- [ ] Les fonctionnalités hors MVP restent différées : SaaS, mémoire de conversation, embeddings, multi-dépôts et distribution de production.

**Livrables :** version open source expérimentale du MVP, licence publique, notes de version, bilan et décision de suite. **Jalon M4.**

## Ordre de réalisation et validations intermédiaires

L’ordre des identifiants facilite la lecture ; les dépendances font foi. En particulier, **JG-018 doit être disponible pour clôturer JG-016**, car le plan préalable tient compte du cache.

| Étape | Résultat attendu | Issues principales |
| --- | --- | --- |
| Fondations | Package, contrats et simulations | JG-001 à JG-003 |
| Faisabilité M0 | Contrat Jev, disposition des lots et interopérabilité documentés | JG-004 à JG-006 |
| Lecture locale | Configuration, autorisation, diagnostics, inventaire et sources | JG-007 à JG-012 |
| Premier parcours M1 | Recherche CLI reproductible sur fixtures | JG-014 ; JG-013 prépare le fournisseur réel |
| Moteur fiable M2 | Découpage syntaxique, cache, comptabilité, ordonnanceur, sélection et rapport | JG-015, JG-018, JG-016, JG-017, JG-019 à JG-022 |
| Intégration M3 | CLI/MCP validés et installation reproductible | JG-023 à JG-026 |
| Mesure M4 | Corpus, résultats de recherche et tâches appariées, bilan | JG-027 à JG-030 |

JG-027 peut avancer dès le départ. Les contrôles de configuration et de lecture peuvent avancer sans compte Jev ; les validations réelles de JG-004/JG-005 restent alors ouvertes. Après stabilisation des contrats, le découpage syntaxique et le cache/ordonnanceur peuvent être travaillés indépendamment. JG-025 confirme les garanties de M2 dans les deux interfaces avant M3.

## Traçabilité des exigences

| Exigence de la spécification | Issues responsables principales |
| --- | --- |
| R1 — Autorisation des fichiers | [JG-007](#jg-007), [JG-008](#jg-008), [JG-010](#jg-010) |
| R2 — Configuration de la divulgation distante | [JG-007](#jg-007), [JG-013](#jg-013), [JG-024](#jg-024) |
| R3 — Évaluation sans préfiltre de pertinence | [JG-010](#jg-010), [JG-012](#jg-012), [JG-015](#jg-015), [JG-016](#jg-016), [JG-017](#jg-017) |
| R4 — Extraits et références exacts | [JG-011](#jg-011), [JG-012](#jg-012), [JG-015](#jg-015), [JG-019](#jg-019), [JG-021](#jg-021) |
| R5 — Échec distinct de non-pertinence | [JG-003](#jg-003), [JG-004](#jg-004), [JG-013](#jg-013), [JG-017](#jg-017), [JG-022](#jg-022) |
| R6 — Limites indépendantes et comptabilisées | [JG-007](#jg-007), [JG-016](#jg-016), [JG-017](#jg-017), [JG-020](#jg-020), [JG-022](#jg-022) |
| R7 — Réponse complète sous budget | [JG-006](#jg-006), [JG-019](#jg-019), [JG-020](#jg-020) |
| R8 — Rapport de couverture véridique | [JG-010](#jg-010), [JG-016](#jg-016), [JG-021](#jg-021), [JG-022](#jg-022) |
| R9 — Réutilisation des évaluations identiques | [JG-005](#jg-005), [JG-018](#jg-018) |
| R10 — Moteur partagé CLI/MCP | [JG-014](#jg-014), [JG-022](#jg-022), [JG-023](#jg-023), [JG-024](#jg-024), [JG-025](#jg-025) |
| R11 — Sources traitées comme données | [JG-008](#jg-008), [JG-010](#jg-010), [JG-015](#jg-015), [JG-025](#jg-025) |
| R12 — Évaluation sur des tâches complètes | [JG-027](#jg-027), [JG-028](#jg-028), [JG-029](#jg-029), [JG-030](#jg-030) |
