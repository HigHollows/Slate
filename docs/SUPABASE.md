# Backend cloud — projet Supabase « Slate »

| | |
|---|---|
| Projet | `Slate` (réf. `jmqpsoqibxyyktkqensh`), organisation « Drumo-Daw-Project » (plan gratuit, 0 €/mois) |
| Région | `eu-west-3` (Paris) |
| URL | `https://jmqpsoqibxyyktkqensh.supabase.co` |
| Clé côté application | clé **publishable** (publique par conception, protégée par la RLS) — fichier local `apps/desktop/.env` (ignoré par Git) |

**Jamais** de `service_role`, de mot de passe de base ou de clé secrète dans le dépôt ni dans l'application. Les deux autres projets du compte (« Drumo », « CrackLess ») n'appartiennent pas à Slate et n'ont pas été touchés.

## Migrations appliquées
| Version | Contenu |
|---|---|
| `20261107000001_core` | `profiles` (créé automatiquement à l'inscription), `workspaces`, `workspace_members` (rôles viewer/editor/admin), `nodes`, RLS sur toutes les tables, fonctions d'autorisation dans le schéma non exposé `private`, protection du dernier administrateur, immuabilité de `owner_id` / `workspace_id`, cohérence parent/espace. |

Les fichiers sont dans `supabase/migrations/` (source de vérité versionnée) et ont été appliqués au projet par la migration MCP `core`.

## Tests
`supabase/tests/rls_core.sql` : **40 assertions exécutées** sur le projet réel (trois utilisateurs fictifs, tout est annulé par une exception volontaire finale ; vérifié ensuite : 0 utilisateur, 0 espace, 0 nœud). Couvre : non-membre sans accès (lecture/écriture/suppression), lecteur, éditeur, administrateur, usurpation de propriétaire ou de `created_by`, ajout de soi-même, espaces isolés, parent d'un autre espace, dernier administrateur, profils (visibles seulement entre co-membres), `anon` sans aucun droit, suppression en cascade.
Conseiller de sécurité Supabase après migration : **0 alerte**.

## Limites actuelles
- Aucun client ne parle encore à ce backend : **l'application ne se connecte pas au cloud** (pas d'inscription/connexion, pas de synchronisation, pas de collaboration). Seul le schéma d'accès est en place et testé.
- Schéma volontairement minimal : pas encore de contenu de pages, de bases, de tâches, de fichiers (Storage), d'opérations de synchronisation, de mises à jour Yjs, d'invitations, de commentaires. Ils arrivent avec leurs modules, chacun avec ses politiques RLS et ses tests.
- Les favoris sont personnels : ils ne seront pas un champ de `nodes` côté cloud (table dédiée par utilisateur à venir).
- Plan gratuit : pause automatique après inactivité, quotas réduits (voir `MASTER_PLAN.md`).
- Confirmation d'e-mail et réinitialisation du mot de passe : à configurer dans Supabase Auth (envoi d'e-mails par défaut limité) lors de l'étape comptes.

## Comptes dans l'application (implémenté)

- Client REST GoTrue maison (`features/account/authClient.ts`), pas de `supabase-js` ; seule la clé publishable est embarquée (`apps/desktop/.env`, ignoré par Git).
- Session : seul le **refresh token** est stocké dans le trousseau du système (Rust, crate `keyring`, service `app.slate.desktop`) ; le jeton d'accès reste en mémoire et est renouvelé ~60 s avant expiration. Hors ligne, la session est conservée et une reconnexion est tentée toutes les 30 s ; un jeton révoqué vide le trousseau.
- Inscription : la confirmation par e-mail est requise ; l'interface affiche un message neutre (pas d'énumération de comptes).
- Non vérifié : une inscription réelle (elle créerait un vrai utilisateur) ; seuls les tests avec client simulé et la lecture de `/auth/v1/settings` ont été exécutés.
- Non disponible : synchronisation, migration invité → compte, partage (l'interface le dit).
