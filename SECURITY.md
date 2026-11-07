# Slate — Sécurité

> Statut : modèle de menaces et exigences (Phase 0). Aucune de ces mesures n'est encore implémentée ; chaque point sera coché avec un test dans la phase concernée.

## 1. Actifs à protéger
Contenus utilisateur (pages, bases, fichiers), identifiants de compte, jetons de session, clés de configuration, intégrité des données, isolation entre espaces.

## 2. Menaces principales
| Menace | Contre-mesure prévue |
|---|---|
| Accès à un autre espace en modifiant un ID/requête | **RLS** sur toutes les tables, tests pgTAP (matrice rôle × table × opération) ; aucun contrôle uniquement côté UI. |
| Contournement des permissions par une automatisation | Exécution avec l'identité du créateur, jamais `service_role` pour des écritures métier ; test dédié. |
| Fuite de secrets | Aucun secret dans le dépôt ; `.env.example` ; `gitleaks` en CI ; seule la clé *anon/publishable* (publique par conception) côté client. |
| XSS via contenu (pages, import Markdown/Notion, HTML collé) | Contenu stocké en JSON structuré, rendu par schéma ProseMirror (pas d'`innerHTML`), sanitisation du collé/importé, **CSP stricte** Tauri, pas de `eval`. |
| Injection SQL | Requêtes paramétrées uniquement (rusqlite, RPC Postgres paramétrées) ; interdiction de SQL dynamique non whitelisté (tri/colonnes par liste blanche). |
| Exécution de code via formules/automatisations | Interpréteur AST maison, fonctions en liste blanche, limites de ressources, pas de `eval`/`Function`. |
| IPC Tauri abusé (WebView compromise) | Capabilities Tauri 2 minimales, commandes explicites et validées, pas de plugin `shell`/`fs` large, accès fichiers via commandes Rust avec chemins contraints. |
| Fichiers malveillants (aperçu, PDF) | Aperçu dans un contexte isolé, pdf.js sans exécution de scripts, limites de taille/type, pas d'ouverture automatique, hash vérifié. |
| Vol de session | Jetons dans le trousseau OS (Keychain/Credential Manager), pas de `localStorage` ; refresh géré ; déconnexion révoque. |
| Brute force du PIN | Argon2id, délai exponentiel persistant, verrouillage temporaire (les compteurs survivent au redémarrage). |
| Invitations détournées | Jeton aléatoire à usage unique, stocké haché, expiration, liaison à l'email, rôle plafonné par l'invitant. |
| Énumération / abus API | Rate limits Supabase Auth, quotas, journalisation. |
| Altération silencieuse des données | Checksums de migrations, `integrity_check`, hash de fichiers, journal d'audit append-only. |
| Chaîne d'approvisionnement | `pnpm audit`, `cargo audit`/`cargo-deny`, lockfiles, revue de licence avant ajout (règle 6). |

## 3. Modèle de permissions

Rôles : `viewer` (lecture) < `editor` (édition) < `admin` (administration : membres, suppression d'espace, paramètres).
- Niveau **espace** (`workspace_member`) + surcharge **page** (`node_permission`).
- Règle d'héritage (à figer en Phase 8) : une page hérite du rôle de son espace ; une surcharge peut **restreindre ou élargir** pour un utilisateur donné ; l'absence de membre d'espace + surcharge de page = accès à cette page seule (partage ciblé).
- Fonctions SQL `STABLE` : `current_role_in(ws)`, `can_access_node(node, min_role)` ; **toutes les policies les utilisent** (une seule source de vérité).
- Les fichiers (Storage) : policies fondées sur le chemin `workspace_id/…` + `file_link` (mêmes règles que l'entité associée).
- Les liens inter-espaces ne révèlent que ce que le lecteur a le droit de voir (titre masqué sinon).

### Règles RLS (non négociables)
1. RLS **activée** sur toute table du schéma exposé ; refus par défaut.
2. Les `INSERT/UPDATE` ont `WITH CHECK` ; interdiction de changer `workspace_id` par UPDATE.
3. Fonctions `SECURITY DEFINER` : minimales, `search_path` figé (`set search_path = ''`), revues individuellement.
4. Vues : `security_invoker = true`.
5. Aucun `user_metadata` modifiable par l'utilisateur dans les décisions d'autorisation.
6. `get_advisors` (sécurité) exécuté après chaque migration ; zéro alerte non justifiée.
7. Realtime privé : autorisation via policies sur `realtime.messages`.

## 4. PIN local (implémenté — voir D-045, D-046)
- 4 ou 6 chiffres, empreinte **Argon2id** (m = 19 Mio, t = 2, p = 1) avec sel aléatoire ; jamais en clair (vérifié dans la base et le WAL), jamais journalisé, jamais renvoyé dans une erreur.
- **Verrou natif** : tant qu'il est actif, le cœur refuse toute commande de données (`locked`) ; seules les commandes `pin_*` répondent. Il se déclenche au démarrage (option), à l'inactivité (1 à 240 min), manuellement (palette, Ctrl/⌘+L, paramètres).
- **Anti-force brute** : 5 essais, puis blocage 30 s doublé à chaque échec (plafond 1 h), persistant ; le bon PIN est refusé pendant le blocage ; un seul chemin de vérification pour déverrouiller, changer, désactiver ou modifier les options.
- Indépendant du mot de passe du compte. PIN oublié : pas de récupération (il faudrait supprimer la ligne `security_local` du fichier de données, ce qui suppose l'accès au disque) — à documenter côté utilisateur.
- **Limites** : verrou d'accès, **pas un chiffrement** (fichier SQLite lisible avec un accès disque, D-009) ; horloge système utilisée pour le blocage ; données déjà chargées conservées en mémoire pendant le verrou.

## 5. Authentification (client implémenté, D-047)
Supabase Auth email + mot de passe via REST ; seule la clé publishable est embarquée. **Refresh token seul** dans le trousseau du système ; jeton d'accès en mémoire ; mot de passe jamais conservé (champ vidé après envoi). Messages d'inscription et de réinitialisation neutres (pas d'énumération). Commandes `vault_*` refusées quand l'application est verrouillée par PIN. Limite : un utilisateur ayant accès à la session du système peut lire le trousseau ; la déconnexion supprime l'entrée locale.

## 6. Journalisation des opérations sensibles
Suppression définitive, restauration, export complet, changement de rôle, invitation, désactivation de PIN, import massif, connexion/déconnexion → `audit_local` (+ `audit_log` serveur append-only, non modifiable par les clients).

## 7. Limites connues (à tenir à jour)
- Pas de chiffrement de bout en bout : le fournisseur cloud (Supabase) peut techniquement lire les données stockées.
- SQLite non chiffrée au repos en v1.
- Les builds non signés déclenchent des avertissements OS (SmartScreen/Gatekeeper).
- La sécurité des intégrations/embeds tiers dépend de l'iframe sandbox ; liste blanche de domaines.
- La confidentialité vis-à-vis d'un administrateur d'espace n'est pas garantie (il peut voir le contenu de l'espace).

## 8. Invitations et partage (implémenté, D-058 à D-060)
- Jeton d'invitation : 256 bits aléatoires, **jamais stocké** (empreinte SHA-256 seule), affiché une fois, usage unique, expiration, lié à l'adresse du compte qui l'accepte ; erreur unique pour tout échec (aucune énumération).
- Fonctions `SECURITY DEFINER` (`create_invitation`, `accept_invitation`, `revoke_invitation`, `list_members`) : appelables par `authenticated` **volontairement** ; chacune contrôle l'identité (JWT) et le rôle, `search_path` figé. Tests : `supabase/tests/invitations.sql` (41 assertions sur le vrai projet).
- Les adresses e-mail des membres d'un espace sont visibles de ses co-membres.
- Le jeton est transmis hors de l'application (pas de SMTP) : quiconque l'intercepte ne peut l'utiliser qu'avec un compte dont l'adresse est celle invitée.
- Lecture seule : appliquée par la RLS ; l'interface n'est qu'un confort. Voir docs/COLLABORATION.md.
- `sync_compact_doc` (SECURITY DEFINER, appelable par `authenticated`, ajoutée avec la purge) : exigence du rôle éditeur dans la fonction, `search_path` figé, suppression limitée à des identifiants vérifiés appartenant à la page et à l'espace. `private.purge_node` n'est appelée que par `sync_push` (qui vérifie le rôle). Tests : `supabase/tests/purge_compaction.sql` (24 assertions).
- Commentaires (`comment_threads`, `comments`) : RLS (lecture viewer, écriture editor, modification d'un message : auteur ou admin), étiquette d'auteur dérivée du jeton, gardes contre le changement d'espace/de fil. `apply_comment_op` s'exécute avec les droits de l'appelant (SECURITY INVOKER). Seuls `private.touch_thread_comments`, `comment_guard` et `thread_guard` sont SECURITY DEFINER (déclencheurs). Tests : `supabase/tests/comments.sql` (24 assertions).
- Présence (Realtime) : canaux privés `doc:<espace>:<page>`, politiques `realtime_doc_receive` (lecteur) et `realtime_doc_send` (éditeur) via `private.realtime_doc_allowed` (SECURITY INVOKER, `search_path` figé). Les messages reçus sont non fiables (voir docs/COLLABORATION.md). Le nom affiché dans la barre de présence est déclaré par le client, non authentifié. Tests : `supabase/tests/realtime_presence.sql` (20 assertions).
- E-mail d'invitation : fonction Edge `send-invitation` (JWT obligatoire, jeton de l'appelant, pas de service_role) + `claim_invitation_email` / `release_invitation_email` (SECURITY DEFINER, appelables par `authenticated` volontairement, rôle administrateur vérifié, même erreur pour jeton inconnu et non-administrateur). Destinataire lu en base, jamais fourni par le client ; plafonds d'envoi ; contenu échappé ; secrets hors dépôt. Le jeton d'invitation figure dans le message envoyé : il ne fonctionne qu'avec le compte de l'adresse invitée, mais l'e-mail transite chez le fournisseur d'envoi. Tests : `supabase/tests/invitation_email.sql` (22 assertions), `sendInvitation.test.ts` (12).
