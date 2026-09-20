# Configuration et profils — 20 septembre 2026

La revue de configuration après JG-002 est close. Les schémas restent stricts et la
racine est autorisée avant toute lecture de sources. Les profils et secrets utilisent
désormais les mêmes contrôles de fichiers locaux que le cache : lectures bornées,
refus des liens et des remplacements observables, permissions de création restreintes,
publication atomique et refus d'écrasement implicite.

`init` valide le dépôt et l'emplacement externe avant de demander une clé ou de
modifier des réglages globaux. Le chemin relatif est résolu depuis le répertoire de
la commande. Un nouveau profil conserve `remote_evaluation_enabled: false`.
`init --global` configure seulement le stockage utilisateur et ne transforme pas son
répertoire courant en autorisation de dépôt. La découverte depuis un sous-dossier
trouve le profil de l'ancêtre autorisé ; `--config` reste disponible.

Un changement explicite de fournisseur préserve les réglages de divulgation et les
limites du profil. La clé de l'autre fournisseur est conservée pour les projets qui
l'utilisent encore. L'environnement du processus prévaut ; la CLI ne charge que la
variable de credential sélectionnée. Les erreurs de JSON/secrets n'affichent pas
leur contenu. Les erreurs et clés factices des tests sont confinées aux temporaires.

Les budgets CLI sont résolus après chargement de la configuration. Régressions :
défaut 6 000, maximum 20 000 acceptés et 20 001 refusé ; l'absence du flag n'injecte
plus un défaut fixe de 4 000 avant le moteur.

Relecture indépendante Spec : les défauts initiaux et la régression du démarrage
global ont été corrigés et revérifiés. Tests : `init-profile`, `cli-args`,
`cli-commands`, `local-directory` et contrats de configuration. La qualification
globale Windows/Linux et les commandes de reprise sont consignées dans `handoff.md`.
