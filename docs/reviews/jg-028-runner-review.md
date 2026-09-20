# Instrument de benchmark — revue du 20 septembre 2026

Le runner de développement est intégrable. La revue a corrigé la confusion entre
intersection d'une annotation et récupération complète : le rappel reste un taux
d'intersection déclaré, tandis qu'un ensemble complet exige la couverture de toutes
les lignes de ses annotations directes et de soutien. L'union de plages adjacentes
est acceptée, les trous restent incomplets. Ce contrôle ne prouve pas la justesse
sémantique d'une réponse ; les sorties discutées doivent être revues.

Les alternatives constituent des ensembles distincts. Les questions ambiguës sont
rapportées séparément de la précision et du rappel principaux. Un contrôle négatif
vide n'est réussi que si la recherche est complète et le scope entièrement scanné ;
erreurs, refus et scans partiels sont comptés comme non évaluables. Les annotations
vides injustifiées, ensembles de seul contexte et négatifs avec preuves sont refusés.

Avant exécution, le runner vérifie la révision de la fixture et sa concordance avec
la racine configurée. Le rapport contient les empreintes des sources et des octets
du manifeste réellement lu, ainsi que le commit du corpus quand Git est disponible.
Les exécutions cold utilisent un cache temporaire isolé ; une purge défaillante
interdit de produire un résultat étiqueté cold. Chaque manifeste conserve sa propre
sortie même s'il porte sur la même fixture. Les temporaires hors ligne sont nettoyés.

Le scorer local sert uniquement à tester l'instrument. Sa révision simulée n'est pas
une révision Jev qualifiée et n'exerce pas la réutilisation persistante du cache.
Les rapports le déclarent explicitement. Le runner refuse les manifestes réservés.
Les réponses privées n'ont pas été lues pendant cette revue.

Revue Standards indépendante close après correction de la provenance des annotations.
Les 21 contrôles `corpus-scoring` / `retrieval-benchmark` passent sous Windows à ce
stade ; la vérification globale est consignée dans `handoff.md`. Aucun appel réel
ni mesure de qualité Jev effectués. JG-028 reste ouvert pour les mesures et le choix
des réglages ; JG-029 pour la comparaison des tâches dans Codex.
