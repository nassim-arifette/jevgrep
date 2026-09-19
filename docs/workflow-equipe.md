# JevGrep — Répartition et workflow pour trois personnes

Version : 1.0. Cette organisation est une proposition pour **une personne junior, une personne intermédiaire (« medium ») et une personne senior**, travaillant sur le [backlog de 30 issues](issues.md).

**Reprise actuelle :** la branche commune est `main`, dans le dossier `jevgrep`.
Les travaux intermédiaires sont consolidés ; reprendre depuis ce HEAD, pas depuis
les anciennes branches JG. Le [passage de relais](handoff.md) indique les validations
terminées, les modules encore provisoires et les gates d’activation.

Le niveau indique l’autonomie recommandée pour piloter l’issue entière. Il dépend des compétences réelles de la personne, pas uniquement de son ancienneté. Un junior peut contribuer aux tests d’une issue senior sans porter la décision technique ni sa clôture.

## 1. Les trois rôles

| Personne | Profil | Responsabilité principale | Autonomie attendue |
| --- | --- | --- | --- |
| **J** | Junior encadré | Outillage, fixtures, corpus, découpage simple, commandes CLI et installation | Réaliser un périmètre défini avec des exemples, un contrat stable et une revue |
| **M** | Medium / intermédiaire | Modules de lecture et de recherche, adaptateur Jev, cache et MCP | Concevoir l’implémentation d’un module, traiter ses erreurs et tester son intégration |
| **S** | Senior | Contrats, autorisation, hypothèses fournisseur, budgets, concurrence, intégration et interprétation des mesures | Arbitrer les invariants transversaux et les incertitudes qui affectent plusieurs modules |

Chaque issue conserve **un seul pilote**, responsable de ses livrables et de sa clôture. Les contributions et revues sont explicites. Le nombre d’issues ne représente pas leur charge : le corpus et les essais peuvent occuper le junior sur une durée importante.

### Junior : 5 issues pilotées

| Issue | Travail confié | Encadrement nécessaire |
| --- | --- | --- |
| [JG-001](issues.md#jg-001) | Package TypeScript, scripts et CI | S confirme le runtime et les contraintes ; M vérifie l’installation et la CI |
| [JG-012](issues.md#jg-012) | Fenêtres de lignes et cas de couverture | Contrat de snapshot fourni par M ; revue M sur offsets, limites et recouvrement |
| [JG-023](issues.md#jg-023) | Arguments, aide, commandes et rendu CLI | M expose le moteur final ; toute modification du contrat public revient à S |
| [JG-026](issues.md#jg-026) | Artefact local, guide et installation propre | M vérifie l’intégration réelle ; S valide les affirmations concernant la divulgation distante |
| [JG-027](issues.md#jg-027) | Corpus, manifestes et annotations initiales | S valide le protocole et les preuves de référence ; les cas ambigus sont soumis à revue |

Ces issues sont adaptées à un junior **avec ce cadrage**. Par exemple, JG-027 ne lui demande pas de décider seul ce qui constitue une preuve suffisante pour toutes les recherches.

### Medium : 14 issues pilotées

| Issue | Pourquoi ce niveau | Point de revue par S |
| --- | --- | --- |
| [JG-003](issues.md#jg-003) | Simulation asynchrone et infrastructure de tests | Réalisme des erreurs, horloge et observation des tentatives |
| [JG-006](issues.md#jg-006) | Intégration de SDK, tokenizer et processus stdio | Portée de la garantie de tokens, annulation et troncature Codex |
| [JG-007](issues.md#jg-007) | Configuration, secrets et validation | Origine de confiance, caps à `null` et absence de divulgation implicite |
| [JG-009](issues.md#jg-009) | Cycle de vie asynchrone et diagnostics | Différence entre annulation et délai, nettoyage des ressources |
| [JG-010](issues.md#jg-010) | Inventaire et règles d’exclusion | Exclusions avant envoi et honnêteté des comptes incomplets |
| [JG-011](issues.md#jg-011) | Octets, Unicode, hashes et offsets | Identité exacte du contenu et références de lignes |
| [JG-013](issues.md#jg-013) | Adaptateur d’un fournisseur avec validation | Scores indisponibles, usages inconnus et reprises cachées |
| [JG-014](issues.md#jg-014) | Premier assemblage du parcours CLI | Moteur partagé et conformité des sorties sur fixtures |
| [JG-015](issues.md#jg-015) | Parseur syntaxique et stratégies de repli | Couverture de toutes les lignes éligibles, sans exécution du dépôt |
| [JG-018](issues.md#jg-018) | Persistance, invalidation et identité des requêtes | Composition exacte de la clé, modèle et état partagé |
| [JG-019](issues.md#jg-019) | Algorithmes de classement et de fusion | Provenance, intervalles contigus et déterminisme |
| [JG-021](issues.md#jg-021) | Revalidation de fichiers pendant une recherche | Aucun mélange entre anciens scores et nouveau contenu |
| [JG-024](issues.md#jg-024) | Adaptateur MCP de production | Contrat d’erreur, stdout, autorisation et arrêt du client |
| [JG-028](issues.md#jg-028) | Exécuteur de benchmark et instrumentation | Protocole, jeu réservé et interprétation des métriques |

### Senior : 11 issues pilotées

| Issue | Décision ou invariant à porter | Contribution possible de J ou M |
| --- | --- | --- |
| [JG-002](issues.md#jg-002) | Contrats communs, unités et états | J prépare les exemples ; M vérifie leur utilisabilité |
| [JG-004](issues.md#jg-004) | Validité du contrat réel fournisseur | M prépare le transport ; J organise les cas et les observations expurgées |
| [JG-005](issues.md#jg-005) | Choix des lots et conséquences sur le cache | J exécute la matrice d’essais selon le protocole figé |
| [JG-008](issues.md#jg-008) | Autorisation des chemins sous Windows/POSIX | J prépare les fixtures ; M reproduit et conteste les hypothèses |
| [JG-016](issues.md#jg-016) | Réservations et comptabilité des limites | J ajoute les cas chiffrés ; M intègre le plan et le cache |
| [JG-017](issues.md#jg-017) | Concurrence, reprises et annulations | J exécute les scénarios simulés ; M revoit les transitions |
| [JG-020](issues.md#jg-020) | Garantie sur le payload entièrement sérialisé | J prépare les chaînes et chemins limites ; M revoit le raccordement à la sélection |
| [JG-022](issues.md#jg-022) | Intégration finale et vérité des rapports | M apporte les modules ; J vérifie les scénarios bout en bout |
| [JG-025](issues.md#jg-025) | Validation des garanties transversales | J exécute les essais ; M mène une contre-revue des résultats |
| [JG-029](issues.md#jg-029) | Validité de la comparaison A/B | M maintient le runner ; J lance les essais et prépare les tableaux |
| [JG-030](issues.md#jg-030) | Bilan et décision de livraison | J assemble les livrables ; M revoit la version et les limitations |

S conserve l’analyse et la conclusion des études. Les scripts, fixtures et collectes ne doivent pas tous être réalisés personnellement par S.

## 2. Préparer les échanges avant de coder en parallèle

Au démarrage, S et M extraient de la spécification les contrats minimaux nécessaires aux échanges. Il s’agit de stabiliser les formes utiles au travail, pas de créer une architecture extensible supplémentaire.

| Contrat à partager | Contenu à fixer | Qui le prépare / le valide |
| --- | --- | --- |
| Entrée, résultat et erreur | Champs, valeurs nulles, codes, unités et compteurs | S prépare JG-002 ; M revoit |
| Snapshot et fragment | Texte original, offsets, lignes, hash et tailles | M prépare ; S vérifie les invariants de source |
| Évaluation | Identifiants, score valide ou indisponible, usage et modèle | S fixe les garanties ; M réalise les adaptateurs |
| Plan de scan | Cache prévu, premières tentatives, besoins et plafonds actifs | S prépare ; M vérifie le raccordement aux modules |
| Cycle de vie | Signal d’arrêt, délai global et événements de diagnostic | M prépare JG-009 ; S valide |

Chaque contrat est accompagné d’un exemple valide et d’un cas d’échec. Les premiers brouillons de S et M peuvent commencer pendant que J initialise le package. **La clôture de JG-002 attend JG-001 ; celle de JG-003 attend JG-002.**

Une interface convenue permet de développer avec le fournisseur simulé ou des fixtures. Elle ne remplace pas les dépendances de clôture du backlog. Une issue testée seulement contre un double reste ouverte si son intégration réelle est un critère d’acceptation.

## 3. Workflow en parallèle

Les séquences ci-dessous sont des **vagues de travail, pas des semaines**. Dans une cellule, `→` indique l’ordre proposé pour une même personne. Les dépendances entre personnes imposent parfois une livraison intermédiaire. « Préparer » signifie que la clôture reste soumise aux dépendances du ticket.

| Vague | J — Junior | M — Medium | S — Senior | Passage à la suite |
| --- | --- | --- | --- | --- |
| **0. Fondations** | Réaliser **001** ; commencer le corpus **027** | Préparer puis finaliser **003** | Préparer puis finaliser **002**, cadrer le runtime et les annotations | 001 → 002 → 003 intégrés ; contrats et doubles partagés |
| **1. Contrats réels et autorisation** | Poursuivre **027** ; préparer les cas fournisseur et chemins | **007 → 009 → 006** | **004**, puis **008** dès que 007 est prêt, puis **005** | 004–009 validés ; les points dépendant d’un accès externe restent identifiés s’ils sont bloqués |
| **2. Lecture et premier parcours** | Réaliser **012** après 011 et 006 ; finaliser **027** après revue | **010 → 011 → 013 → 018 → 014 → 015 → 019**, avec 014/015 après 012 | Préparer **016** sur plans simulés et **020** sur payloads de référence ; assurer les revues | Sources, fenêtres, cache, premier parcours et sélection disponibles ; préparation ≠ clôture de 016/020 |
| **3. Budgets et intégration du moteur** | Exécuter les scénarios de limites/obsolescence ; préparer aide et arguments de **023** | Réaliser **021** après 020 ; préparer l’adaptateur **024** sur le contrat stable | Finaliser **020** pour débloquer M, puis **016 → 017 → 022** ; 022 attend aussi 021 | 022 intégré avec toutes ses dépendances et les contrôles de résultat |
| **4. Interfaces et mesures de recherche** | Finaliser **023** ; préparer l’installation **026** | Finaliser **024 → 028** | Réaliser **025** après 023 et 024 ; préparer le protocole de **029** | 023–025 validés ; 028 analysé ; préparation de 029 seulement |
| **5. Installation et essais agent** | Finaliser **026**, puis exécuter les essais A/B prévus | Assister la compatibilité et l’exécuteur de benchmark ; revoir les résultats | Exécuter/analyser **029** après 026 et 028 | Installation prouvée et comparaison A/B documentée |
| **6. Livraison** | Assembler guide, artefact et preuves de validation | Revoir la version et reproduire le parcours d’installation | Finaliser **030** | Version personnelle et bilan exact, y compris les résultats défavorables |

Les numéros abrégés désignent les issues `JG-xxx`. Une personne n’a qu’une implémentation principale en cours ; les éléments supplémentaires d’une cellule sont des tâches successives ou des contributions de revue.

### Pourquoi cette séquence

- S traite JG-008 dès que la configuration est disponible pour débloquer l’inventaire et les sources.
- M livre JG-011 tôt : J peut alors développer JG-012 pendant que M avance sur l’adaptateur et le cache.
- M priorise JG-018 après l’adaptateur : sa livraison permet à S de terminer la comptabilité JG-016.
- S peut préparer les algorithmes de JG-016/JG-020 sur les contrats et fixtures, puis les intégrer lorsque cache et sélection sont prêts.
- S finalise JG-020 tôt dans la vague 3 : M peut traiter l’obsolescence JG-021 pendant que S termine comptabilité et ordonnanceur.
- Le junior travaille sur corpus, fixtures et procédures pendant les attentes. Les étapes qui demandent un jugement de pertinence restent revues par S.
- La CLI définitive et MCP avancent réellement en parallèle après JG-022, sous la responsabilité respective de J et M.

Une chaîne structurante est **013 → 018 → 016 → 017 → 022**. Une autre est **015 → 019 → 020 → 021 → 022**. On ne supprime pas ces dépendances pour donner l’impression que trois personnes peuvent tout réaliser simultanément.

## 4. Décomposer les contributions sans dupliquer les issues

Les sous-lots suivants restent des tâches de leurs issues parentes ; ils ne créent pas de nouvelles issues ni de responsabilité partagée ambiguë.

| Issue parent | Travail de J | Travail de M | Travail de S |
| --- | --- | --- | --- |
| JG-003 | Écrire les fichiers et jeux d’erreurs synthétiques | Implémenter le double et l’horloge ; piloter l’issue | Valider les comportements simulés |
| JG-005 | Lancer les essais, conserver les paramètres et résultats | Vérifier les appels et leur corrélation | Définir le protocole, choisir la disposition et conclure |
| JG-016/JG-017 | Ajouter les scénarios chiffrés et exécuter les pannes | Vérifier les interfaces et intégrer les données du cache | Concevoir et réaliser les réservations, transitions et décisions d’arrêt |
| JG-020 | Préparer les cas d’échappement, Unicode et grands rapports | Vérifier les unions de plages et leur branchement | Porter la garantie finale de taille et la terminaison |
| JG-025 | Exécuter la matrice et documenter les reproductions | Vérifier indépendamment les résultats et la parité | Piloter la couverture R1–R11 et traiter les défauts transversaux |
| JG-028/JG-029 | Exécuter selon protocole et assembler les tableaux | Maintenir le runner ; piloter JG-028 | Valider les métriques, piloter JG-029 et interpréter la comparaison |

Pour chaque sous-lot, le pilote précise **le fichier ou répertoire concerné, l’entrée attendue, la sortie attendue et le contrôle de réussite**. Une contribution de J aux tests ne décharge pas l’auteur du module de ses propres tests.

## 5. Réduire les conflits dans le dépôt

La répartition s’applique à l’arborescence intégrée sur `main`.

| Zone | Référent | Règle pratique |
| --- | --- | --- |
| `src/contracts.ts`, `src/engine.ts` | S | Tout changement de contrat est annoncé aux consommateurs et revu par M |
| Autorisation, comptabilité, ordonnanceur, garantie de rendu | S | J et M contribuent sur des fichiers de tests ou sous-lots identifiés |
| Inventaire, snapshots, découpage syntaxique, Jev, cache, sélection, MCP | M | S revoit les invariants transversaux avant intégration |
| Découpage par fenêtres, commandes CLI, documentation, manifestes de corpus | J | M fournit les contrats et revoit l’implémentation ; S valide les annotations de référence |
| `package.json` et lockfile | Un éditeur désigné à la fois | L’ajout de dépendance est coordonné ; aucune modification simultanée par plusieurs contributeurs |
| Fixtures et tests | L’auteur du sous-lot | Répartir par fichier/scénario pour éviter de modifier le même test en parallèle |

À la demande de l’opérateur, conserver une seule branche commune : `main`. Le pilote
attribue des fichiers distincts pour les travaux simultanés, coordonne les modifications
des contrats et vérifie l’état Git avant chaque commit. Committer chaque incrément
significatif après ses contrôles. Tous les contributeurs reprennent les contrats et
modules intégrés sur cette branche ; ne pas recréer les anciennes branches JG.

Un changement d’interface nécessaire est proposé tôt avec un exemple avant/après, ses consommateurs et ses effets sur les tests. S décide de la cohérence technique et l’autre implémenteur concerné revoit la compatibilité. Un changement de périmètre produit revient à l’utilisateur.

## 6. Cycle d’un ticket et revues

Le suivi peut utiliser : **À faire → Prêt → En cours → En revue → À intégrer → Terminé**, avec **Bloqué** lorsque le prérequis manquant est nommé.

1. **Préparer.** Le pilote vérifie les dépendances, choisit un livrable limité et identifie le relecteur. J reçoit un exemple d’entrée/sortie et les contrôles attendus.
2. **Réaliser.** Une seule implémentation principale par personne. Les tests sont ajoutés à mesure que les invariants sont implémentés.
3. **Présenter.** La demande de revue indique l’issue, les comportements ajoutés, les critères vérifiés, les commandes exécutées et les limites restantes.
4. **Revoir.** M revoit les travaux de J ; S revoit les modules de M ; M revoit les travaux de S contre les contrats et les cas adverses. S revoit directement les annotations JG-027.
5. **Intégrer.** L’auteur intègre après revue et contrôles réussis, puis vérifie le parcours concerné sur la branche partagée. Le pilote met l’issue à jour ; un brouillon ou une simple réussite sur doubles ne satisfait pas une validation externe requise.

Le niveau du relecteur n’a pas à être supérieur à celui de l’auteur : M peut vérifier une preuve de dépassement de budget, un contre-exemple de chemin ou un résultat de test de S. Si un invariant critique reste inexpliqué, l’issue reste en revue jusqu’à clarification ; la signature de S seule ne vaut pas preuve.

Prévoir deux créneaux courts de revue par jour, adaptés au rythme de l’équipe, et réserver environ **un quart de la capacité de S** aux revues, décisions et intégrations. Ce sont des réglages d’organisation proposés. Les revues qui débloquent J ou M passent avant l’ouverture d’une nouvelle grande tâche de S.

## 7. Que faire lorsqu’une personne attend

| Blocage | Travail utile pendant l’attente | Ce qui reste ouvert |
| --- | --- | --- |
| Accès Jev absent ou modèle indisponible | Config, autorisation, inventaire, sources, fixtures, corpus et parcours simulé | JG-004/JG-005 et les validations réelles dépendantes |
| Snapshot ou contrat de fragment non stabilisé | J prépare les cas limites et le corpus ; M et S fixent l’exemple d’échange minimal | Intégration finale de JG-012 |
| Cache pas encore livré | S réalise/teste les réservations sur plans simulés ; J complète les scénarios de reprise | Clôture de JG-016 avec cache réel |
| Moteur final pas encore intégré | J prépare parsing CLI et aide ; M prépare le transport MCP contre le contrat stable | Clôture de JG-023/JG-024 |
| File de revue chargée | Terminer les revues et contrôles qui débloquent le travail existant | Nouvelle implémentation principale différée |

Une dépendance non résolue n’autorise pas à supprimer une validation, affirmer une couverture complète ou remplacer un usage inconnu par zéro. Les cas simulés doivent rester identifiés comme tels.

## 8. Démarrage concret

**Première affectation :** J prend JG-001 et prépare la collecte JG-027 ; S prépare JG-002 et confirme les choix de runtime ; M prépare les scénarios de JG-003 à partir de la spécification. Après intégration de JG-001, S finalise JG-002, puis M finalise JG-003.

**Point de coordination initial :** obtenir un package commun, un exemple de recherche/résultat et un exemple d’échec. Il n’est pas nécessaire d’attendre une intégration fournisseur réelle pour commencer le travail local.

**Suivi minimal :** chaque jour, noter le livrable terminé, la prochaine dépendance à livrer et la revue attendue. À chaque vague, démontrer un parcours concret et vérifier les critères du backlog.

La charge est concentrée sur M pour les nombreux modules et sur S pour le chemin critique. Le travail d’annotation, de fixtures, d’exécution et de documentation confié à J sert à leur libérer du temps. Le gain de calendrier se mesure après le premier parcours JG-014 ; l’estimation initiale d’effort du plan ne doit pas être simplement divisée par trois.
