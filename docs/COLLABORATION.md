# Collaboration : inviter des personnes dans un espace

> Statut : serveur et local testés ; l'enchaînement complet avec **deux vrais comptes** n'a pas été exécuté (voir « Non vérifié »).

## Ce que c'est
Un **administrateur** d'un espace invite une personne par **adresse e-mail** avec un **rôle** (lecteur, éditeur, administrateur). L'application peut envoyer l'invitation **par e-mail** (si l'envoi est configuré, voir ci-dessous) ; dans tous les cas elle affiche un **jeton**, une seule fois, que l'administrateur peut transmettre lui-même. La personne invitée se connecte avec l'adresse invitée, colle le jeton dans *Compte → Partage → Rejoindre un espace*, et l'espace apparaît dans le sélecteur de la barre latérale. L'édition à plusieurs passe par la synchronisation existante (passage toutes les ~15 s) ; sur une page ouverte, le texte et les curseurs des autres arrivent en direct (voir « Présence en direct »).

## Serveur (`supabase/migrations/20261107000004_invitations.sql`)
- Table `workspace_invitations` : le jeton (64 caractères hexadécimaux) **n'est jamais stocké**, seulement son empreinte SHA-256. Il n'est renvoyé qu'une fois, à la création.
- `create_invitation(workspace, email, role, ttl)` : administrateurs seulement ; 50 invitations en attente au plus ; durée de vie bornée.
- `accept_invitation(token)` : l'adresse du jeton de session (JWT) doit être celle de l'invitation ; **une seule erreur générique** pour tous les échecs (jeton inconnu, expiré, révoqué, déjà utilisé, mauvaise adresse) afin de ne rien révéler ; jamais de rétrogradation d'un membre existant par invitation.
- `revoke_invitation(id)`, `list_members(workspace)` (adresses visibles des co-membres de l'espace), liste des invitations réservée aux administrateurs (RLS).
- Les rôles sont appliqués par la RLS (voir SECURITY.md) : un lecteur ne peut pas écrire, même en contournant l'interface.

## Local
- `sync_state` est **par espace** (activation, rôle, curseurs). Un interrupteur général reste dans `sync_settings`.
- Les opérations locales sont regroupées par espace ; celles d'un espace où l'on est lecteur sont conservées mais **jamais envoyées**.
- Accès retiré (rôle absent côté serveur) : la synchronisation de cet espace s'arrête, **les données locales restent** et passent en lecture seule.
- Interface : sélecteur d'espace (si plusieurs), section Partage (membres, rôles, invitations, révocation, jeton à copier), lecture seule pour les lecteurs (éditeur, création, renommage, déplacement, suppression masqués ou désactivés).

## Limites
- L'e-mail n'est envoyé que si l'envoi est configuré ; sinon (ou en cas d'échec) le jeton circule hors de l'application, à la charge de l'administrateur.
- Latence ~15 s pour tout ce qui n'est pas la page ouverte (arborescence, bases, commentaires).
- Textes fusionnés (Yjs) ; autres champs : le plus récent gagne (horloge d'appareil, sensible à la dérive).
- Lecture seule côté interface = confort ; la garantie réelle est la RLS serveur. Un lecteur dont les modifications locales seraient forcées (fichier SQLite modifié) verrait ces opérations rester non envoyées.
- Retirer un membre ne supprime pas les copies déjà présentes sur ses appareils.
- La purge définitive n'est pas propagée.
- Un administrateur peut promouvoir un autre membre administrateur.

## Non vérifié
- Aucun essai avec un **second compte réel** (création de compte et e-mail de confirmation à faire par l'utilisateur).
- Réception sur un second appareil, lignes de bases de données saisies via l'interface.
- Rendu visuel du sélecteur d'espace et de la section Partage (testés par composants, pas inspectés à l'écran).

## Présence en direct (curseurs, présents, texte)
- **Transport** : canal Realtime PRIVÉ par page, sujet `doc:<espace>:<page>`, messages « broadcast » éphémères. Client minimal maison (`features/realtime/socket.ts`) : jeton de l'utilisateur, reconnexion progressive, nouvelle jonction avec jeton renouvelé.
- **Autorisation** (serveur, `…_realtime_presence.sql`) : politiques sur `realtime.messages` — recevoir : lecteur et plus ; envoyer : éditeur et plus ; la page doit exister dans l'espace nommé par le sujet ; seule l'extension `broadcast`. Un lecteur voit les curseurs et le texte arriver mais **n'apparaît pas** et n'envoie rien.
- **Contenu** : les mises à jour Yjs locales sont regroupées (80 ms) et diffusées ; à l'arrivée sur la page on demande ce qui manque (`hello`). C'est une **accélération** : les mêmes mises à jour passent aussi par le journal de synchronisation ; perdre un message direct ne perd jamais de contenu. Une mise à jour venue du serveur ou du direct n'est jamais rediffusée (pas d'écho).
- **Curseurs** : awareness Yjs ; positions relatives (elles suivent le texte). Identité visuelle monochrome : le repère est le **nom** (étiquette), affiché comme texte.
- **Entrées hostiles** : tout message est borné (256 Kio), décodé strictement, vérifié dans un état jetable avant d'être appliqué, et ne peut jamais réécrire notre propre état ; une erreur est ignorée sans jamais atteindre l'éditeur.
- **Limites** : le nom affiché est déclaré par le client (non authentifié : un éditeur peut se faire passer pour un autre dans la barre de présence — les commentaires, eux, portent l'identité vérifiée par le serveur) ; un éditeur peut diffuser du texte à tout moment, comme il pourrait l'écrire dans le journal ; la présence n'est attachée qu'à l'ouverture de la page (activer la synchronisation sur une page déjà ouverte demande de la rouvrir) ; il faut une connexion ; les limites de débit du projet Supabase (messages par seconde) s'appliquent.
- **Vérifié sur le vrai service** : avec la clé publique seule (sans compte), une jonction réelle au canal d'une page est refusée par NOTRE politique (« Unauthorized: You do not have permissions to read from this Channel topic ») : le format des trames, l'URL et l'autorisation des canaux privés sont bien ceux du service. Constaté aussi : à la toute première utilisation, le service peut répondre `MissingPartition` (il crée la partition du jour à la demande) ; le client réessaie donc quelques fois (1,5 s, 5 s, 15 s) avant d'abandonner.
- **Non vérifié** : aucun échange réel avec un compte (texte et curseurs entre deux clients), aucune mesure de latence (le transport est testé avec un faux WebSocket, la logique avec un réseau en boucle, l'autorisation en SQL sur la fonction que les politiques appellent — le rôle de test ne peut pas écrire dans `realtime.messages`).

## Envoi des invitations par e-mail
**État** : code et fonction serveur déployés ; **l'envoi n'est PAS actif tant que vous n'avez pas configuré un fournisseur** (voir plus bas). Sans configuration l'application le dit (« L'envoi d'e-mails n'est pas configuré sur ce projet ») et le jeton reste à transmettre à la main. Jamais de faux « envoyé ».

### Fonctionnement et garanties
- Fonction Edge `send-invitation` (`supabase/functions/send-invitation/`, JWT obligatoire). Elle agit avec **le jeton de l'appelant** : aucun `service_role`, aucun pouvoir propre.
- Le **destinataire n'est jamais fourni par le client** : il est lu dans l'invitation par `claim_invitation_email`, qui vérifie aussi que l'appelant est administrateur de l'espace et que l'invitation est en attente. Une personne ne peut donc pas faire envoyer un message à une adresse de son choix.
- Limites : 3 envois par invitation, 1 par minute. Un envoi refusé par le fournisseur rend la réservation (`release_invitation_email`).
- Le message est un modèle fixe (fr/en) ; le nom d'espace et le nom de l'invitant sont échappés (HTML) et nettoyés (pas de saut de ligne dans l'objet). Il contient le jeton : celui-ci n'est utilisable qu'avec un compte dont l'adresse est celle invitée.
- Rien n'est réservé tant que l'envoi n'est pas configuré. Ni clé, ni jeton, ni adresse dans les réponses d'erreur.
- « Envoyé » signifie que le **fournisseur a accepté le message**, pas qu'il est arrivé en boîte de réception.

### À faire par vous (je ne peux ni créer le compte ni connaître la clé)
1. Créer un compte chez [Resend](https://resend.com) et **vérifier un domaine d'envoi** (sans domaine vérifié, Resend n'envoie qu'à l'adresse du titulaire du compte, ce qui ne sert qu'à tester).
2. Créer une clé d'API Resend limitée à l'envoi.
3. Définir deux secrets de la fonction, **dans le tableau de bord Supabase (Edge Functions → Secrets) ou avec la CLI**, jamais dans le dépôt :
   ```bash
   supabase secrets set RESEND_API_KEY=… MAIL_FROM="Slate <invitations@votre-domaine.fr>" --project-ref jmqpsoqibxyyktkqensh
   ```
4. Dans Slate : Compte → Partage → créer une invitation vers une adresse que vous contrôlez ; le message doit indiquer « E-mail remis au service d'envoi ».

### Limites
- Un seul fournisseur (Resend) ; changer de fournisseur = modifier `handler.ts`.
- Pas de suivi de réception, de rebond ou d'ouverture.
- Aucun envoi réel n'a été effectué ni vérifié (pas de clé) ; le chemin « non configuré » a été vérifié sur le service déployé, les chemins d'envoi, de refus et de limite par des tests avec un faux fournisseur.

## Partage d'un dossier ou d'une page précis
**État** : serveur, synchronisation et interface faits ; 41 assertions SQL passent sur le vrai projet ; **jamais essayé avec deux vrais comptes**.

- **Menu « Partager… »** (clic sur ⋯ d'un élément de l'arbre, ou menu Affichage d'une page) : réservé aux **administrateurs** de l'espace. On invite une adresse e-mail comme **lecteur** ou **éditeur** (jamais administrateur) ; le jeton s'utilise comme celui d'un espace entier (Compte → Partage → Rejoindre un espace, ou coller le message copié).
- **L'invité n'est pas membre de l'espace.** Il voit et modifie seulement l'élément partagé **et ses descendants**, et rien d'autre : pas les autres pages, pas leurs titres (le serveur ne les lui envoie pas), pas les membres. L'élément partagé apparaît **à la racine** chez lui (le dossier qui le contient lui est masqué). Un invité arrivé par une invitation sur un élément est affiché dans le sélecteur d'espace comme « (partagé) ».
- **Ce qu'un invité éditeur peut faire** : écrire dans les pages, créer des sous-pages et sous-dossiers, commenter, éditer les bases du partage. **Ce qu'il ne peut pas faire** : déplacer ou supprimer l'élément qu'on lui a partagé, créer à la racine ou dans un autre dossier, purger définitivement, inviter. Un lecteur invité ne peut rien écrire.
- **Retirer l'accès** : l'administrateur retire la personne depuis la même fenêtre ; son accès cesse immédiatement côté serveur (lecture, écriture et canal de présence). Les copies déjà présentes sur ses appareils restent chez elle (comme pour un membre retiré).
- **Garanties techniques** : un seul point de décision `private.node_access(nœud, rôle)` (rôle de membre OU partage sur le nœud ou un ancêtre, profondeur bornée) utilisé par toutes les règles RLS (pages, contenu, bases, commentaires, présence). Un membre garde exactement les mêmes droits qu'avant.
- **Limites** : si un élément partagé est déplacé hors de son dossier par un administrateur, l'invité garde l'accès à cet élément (le partage est attaché à l'élément) ; le contenu déjà synchronisé chez un invité n'est pas rappelé quand on retire son accès ; les commentaires d'un élément partagé sont visibles de tous ceux qui y ont accès.
