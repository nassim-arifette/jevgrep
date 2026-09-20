# Transports et cache — revue du 20 septembre 2026

Les transports TypeSafe direct et Vercel Gateway sont accessibles après les contrôles
du moteur : autorisation du dépôt, activation distante explicite et credential.
La suppression de `readiness.ts` conserve l'activation expérimentale demandée.
Aucun appel réel n'a été exécuté pour cette revue.

Les réponses sont bornées à 8 Mio, les redirections restent manuelles, les corps
d'erreur sont abandonnés en conservant statut et `Retry-After`. Les associations
valides survivent aux voisins mal typés. Les clés JSON dupliquées, même échappées,
invalident l'association concernée ; un usage ambigu reste inconnu. Le SDK Gateway
reçoit un corps normalisé par association et son opération de modèle s'exécute sans
reprise ni journal de warnings. Les octets réservés correspondent au JSON effectivement
envoyé, y compris `providerOptions`. Les tarifs de sortie non nuls sont refusés :
l'estimateur actuel couvre uniquement les modèles Jev à sortie gratuite.

Le cache passe au schéma 2. Sa clé inclut le lot sérialisé complet et les options
d'adaptateur. Un lot est réutilisé seulement si toutes ses entrées sont présentes.
Seules les révisions explicites `jev-X.Y.Z` concordant avec le modèle demandé/rendu
sont persistées ; `jev-latest` et l'alias Gateway ne permettent pas de réutilisation
persistante. Cela ne suppose aucune indépendance entre questions non encore mesurée.

Les lectures locales sont bornées et conservent leurs ancres d'autorisation. Les
écritures utilisent un temporaire puis publication atomique ; un nouveau fichier est
publié sans écrasement. Les writers du cache partagent un verrou de répertoire non
vide, publié par renommage sur le même volume. Chaque génération possède son marqueur,
ce qui empêche un récupérateur retardé de supprimer un nouveau propriétaire. PID mort
et verrou vide sont récupérables ; les candidats abandonnés sont nettoyés prudemment.
PID réutilisé, propriétaire inaccessible ou état inconnu restent des refus conservateurs.
Le verrou vise des processus sur une même machine et un système de fichiers local.

L'éviction réconcilie les index des writers via les identités et dates des répertoires
de shards. Liens, fichiers inconnus et racines remplacées ne sont pas suivis.
`cache clear` fonctionne même si la réutilisation est désactivée, sans effacement récursif.

Relectures indépendantes Spec et Standards : défauts de compteur ambigu, validation
globale Gateway, perte de statut HTTP et courses du verrou corrigés puis revus.
Régressions : `provider-http`, adaptateurs, `cache-reuse`, `score-cache`,
`local-directory` et contrats. La qualification réelle du fournisseur, du batching
et des aliases reste ouverte dans JG-004/JG-005 ; voir le passage de relais pour la
vérification globale Windows/Linux de la branche intégrée.
