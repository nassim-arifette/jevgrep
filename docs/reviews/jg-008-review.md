# Revue JG-008 — autorisation des lectures

Date : 20 septembre 2026. Base de revue : `3340155`, puis intégration des
changements fournisseur jusqu'à `a17dd73`. Implémentation : `e8952c8` ; corrections
des fixtures et de l'installation hors ligne : `07d48e1`.

Complément `3c16fce` : le délai est recontrôlé après les accès filesystem et le
calcul des réservations, juste avant comptabilisation/envoi. Le contre-exemple
expirait pendant la revalidation puis envoyait encore un lot ; il retourne
maintenant un résultat partiel `DEADLINE` sans tentative. Les 30 tests du moteur
ont été rejoués après correction sur Windows et Linux, tous réussis.

Complément `cc8410c` : les processus de test CLI ont un emplacement de configuration
vierge. Le test de découverte du lot CLI en cours chargeait autrement le profil
réel de l'opérateur. L'environnement hors ligne ne doit charger ni ce profil ni
ses secrets. Les 16 tests ciblés CLI/MCP passent sur les deux systèmes.

Le contrôle est implémenté et revu pour le système de fichiers Windows/NTFS de
cette machine et pour Linux sous WSL. JG-008 reste administrativement lié à la
clôture de JG-007. Aucun appel fournisseur réel n'a été effectué ; les autres
gates d'activation restent en place.

## Contrôle livré

`AuthorizedRoot` conserve les identités BigInt de la racine et de ses parents.
La même instance traverse configuration, inventaire, préparation, moteur,
inspection et vérification de fraîcheur. Un refus observé sur l'ancre reste
mémorisé, même si le répertoire d'origine revient : il faut recharger la
configuration pour réautoriser l'accès. Le moteur contrôle l'ancre après la
préparation et revalide chaque chemin du lot avant envoi. Le mode partiel ne
contourne pas une invalidation.

Les lectures de répertoires, de fichiers d'exclusion et de sources passent par
ce contrôle. Le lecteur compare `lstat` et `fstat` avant le premier octet,
vérifie le type, lit jusqu'à EOF sous une limite d'octets effectivement lus,
contrôle identité/taille/dates et chemin après lecture, puis ferme le descripteur
sur toutes les sorties. Les lectures courtes sont poursuivies ; une croissance
observée ne devient pas un préfixe présenté comme complet.

Sur Windows, un worker dessert un processus PowerShell système persistant,
sans profil, fenêtre ni interpolation de chemins dans son programme. Les chemins
arrivent en JSON sur stdin. `File.GetAttributes` contrôle le bit
`ReparsePoint` de chaque composant dans l'ordre. La réponse contient seulement
un statut et l'index du composant refusé. Cette précision permet de mémoriser
les refus de l'ancre, y compris lors d'un contrôle de descendant. Les demandes
sont bornées à 512 composants et 1 Mio ; le helper est arrêté après 8 secondes
sans réponse, avec une attente maximale de 10 secondes côté appelant. Les erreurs
de chemin restent locales ; une panne du helper refuse les accès suivants.
Les sorties du helper ne rejoignent jamais stdout/stderr de la CLI ou de MCP.

Le contrôle utilise l'attribut générique documenté par
[Microsoft](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileattributes),
pas une liste de tags reconnus par Node. Le test Windows crée un véritable tag
non-Microsoft `0x00000042` avec un GUID fixe et aucune cible, via
[REPARSE_GUID_DATA_BUFFER](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-reparse_guid_data_buffer),
puis le retire dans `finally`. Le lecteur refuse l'entrée avant `lstat` ou lecture.
Ce helper de fixture n'est pas livré dans le package.

La politique de portée est identique sur les deux systèmes : refus des chemins
absolus, UNC, périphériques, traversées, deux-points/ADS, contrôles et composants
ambigus ; normalisation des antislashs en séparateurs. Les trois questions encore
ouvertes dans la table junior sont résolues. Aucune conversion globale en
minuscules : les alias observés sont dédupliqués, les noms distincts par casse
et les chemins de liens physiques restent distincts.

La configuration est lue par le lecteur vérifié, sous 1 Mio. Les ancêtres déjà
existants du cache sont contrôlés avec `lstat`, y compris les liens pendants,
avant calcul du chemin extérieur au dépôt.

## Standards

Trois défauts relevés et corrigés : un refus propre à un chemin désactivait
globalement le helper ; `existsSync` masquait les liens pendants du cache ; un
fichier listé puis disparu pouvait conserver un inventaire complet. La relecture
ne relève plus de défaut bloquant dans ce périmètre. Les modules worker sont
émis dans `dist/source` ; les appels depuis `.ts` et `.js` ont été vérifiés.

## Spec

Deux défauts relevés et corrigés : la résolution d'alias pouvait interrompre
l'inventaire au lieu de le marquer incomplet ; un refus de racine pouvait être
oublié et autoriser un envoi partiel après restauration. Les contre-exemples
post-ouverture, attributs Windows et résolution POSIX ont été rejoués : le moteur
refuse avec `UNAUTHORIZED_SCOPE`, sans dispatch. Aucun défaut restant identifié
dans cette contre-revue ciblée.

Les tests couvrent également répertoire frère à préfixe commun, syntaxe refusée
avant accès filesystem, racine remplacée, fichier substitué avant ouverture,
liens/jonctions dans les parents, fichier d'exclusion lié ou disparu, changement
de taille pendant lecture, alias, liens physiques, casse, et métacaractères
traités comme données. Les tests existants du moteur et de MCP confirment que
les instructions sources et racines proposées par le client ne donnent aucune
autorisation supplémentaire.

## Vérifications reproductibles

Les suites complètes ont été exécutées sur une copie figée de `a17dd73` avec le
lot `e8952c8` et les corrections de portabilité de `07d48e1`, sans les changements
non commités des autres tâches. Les modifications finales de la table de chemins
ont ensuite été vérifiées sur les deux systèmes (13 tests de fixtures).

| Hôte | Vérification | Résultat |
| --- | --- | --- |
| Windows, Node 24.15.0 | `npm run verify` | 396 tests : 394 réussis, 2 skips, zéro échec ; types, build, 8 smoke checks réussis |
| Linux/WSL, Node officiel 24.15.0, fixture sur filesystem Linux | `npm ci`, puis `npm run verify` | 396 tests : 393 réussis, 3 skips Windows, zéro échec ; types, build, 8 smoke checks réussis |
| Windows et Linux | Tests ciblés autorisation + moteur | 50 cas : zéro échec ; respectivement 2 et 3 skips |

Les deux skips Windows sont explicites : création d'un lien symbolique de fichier
sans privilège et renommage du répertoire pendant qu'un fichier y est ouvert,
refusé par cet hôte. Ces deux cas sont exécutés sur Linux. Les jonctions, le tag
non symbolique et la sensibilité à la casse Windows ont réellement été testés.
La matrice CI distante n'a pas tourné : aucun remote n'est configuré.

Après les compléments `3c16fce` et `cc8410c`, un dernier `npm run verify` sur l'arbre
partagé Windows a aussi réussi : 410 tests, 408 réussis, 2 skips, zéro échec ; types,
build et 8 smoke checks réussis. Ce contrôle inclut les modifications CLI/init et
benchmark non encore commitées d'autres tâches. Il décrit leur état observé à cet
instant, distinct de la qualification de la copie figée ci-dessus.

Trois défauts de la suite existante ont été corrigés après le premier passage
Linux : reconnaissance des chemins Windows indépendamment de l'hôte, destination
relative extérieure pour les captures de sonde, et installation npm hors ligne
à partir du graphe du lockfile. `npm ci` ne préchauffait pas les métadonnées de
registre requises par le précédent test. Le test d'installation reconstruit
désormais systématiquement l'artefact et n'accepte plus un vieux `dist`.

## Limites de la garantie

Ce contrôle vise un dépôt sous contrôle de l'opérateur. Il ne constitue pas une
sandbox atomique face à un adversaire modifiant simultanément le filesystem.
Les contrôles de chemins et `open` restent des opérations séparées : une
substitution/restauration entièrement située entre eux peut rester invisible.
Une identité d'inode n'est pas éternelle ; les liens physiques peuvent partager
des octets entre plusieurs noms ; les dates et tailles ne prouvent pas un
snapshot atomique face à des écritures concurrentes. La limite de lecture borne
les octets, pas la durée de tous les appels système synchrones.

La qualification Windows locale porte sur NTFS. ReFS et ses identifiants 128 bits,
les volumes réseau, les montages spéciaux et macOS ne sont pas qualifiés. Le
contrôle des ancêtres du cache décrit ici s'applique au chargement ; la résistance
de ses écritures à une substitution ultérieure reste à examiner dans JG-018.
Voir l'[étude des garanties système](../research/source-authorization.md) pour
les sources primaires et les limites de Node/libuv.
