# JG-016/JG-017 — Stabilisation locale

20 septembre 2026. Les premières tentatives restent planifiées avant tout envoi.
Chaque reprise repasse par la réservation synchrone du moteur : octets, tentative,
tokens estimés et coût estimé. Les tentatives sans usage connu conservent leur
réservation, même si une reprise réussit. Les fragments ne sont comptés qu'une fois.

`search.retry` est facultatif, avec les valeurs suivantes en son absence :

```json
{"max_retries":2,"base_delay_ms":250,"max_delay_ms":5000,"retry_ambiguous":false}
```

Le schéma accepte 0 à 10 reprises, des délais de 1 à 60 000 ms et exige
`base_delay_ms <= max_delay_ms`. L'attente progressive avec jitter respecte le
minimum `Retry-After`, y compris pour les lots suivants lorsque les reprises sont
désactivées. Activer `retry_ambiguous` peut répéter une tentative déjà facturée.
Ces paramètres ne sont pas exposés aux arguments MCP.

Les refus d'autorisation/quota et les erreurs de requête terminales arrêtent les
nouveaux envois. Les appels en cours restent annulables ; une réponse tardive après
arrêt ne produit ni score ni écriture de cache. Un transport ignorant l'annulation
ne retient pas l'attente locale du moteur. Son interruption distante reste hors de
notre contrôle.

Validation : tests d'horloge manuelle pour backoff, Retry-After, annulation,
concurrence, limite de reprises et capacité restante ; tests moteur pour les usages
inconnus et plafonds ; sous-processus réel pour une reprise suivie d'une sortie propre.
La revue indépendante a détecté puis fait corriger le timer non référencé et le
cooldown absent sans reprise. La qualification du compte fournisseur reste JG-004/005.
