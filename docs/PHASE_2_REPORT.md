# Rapport de Phase 2 — Identité et interface principale

Date : 2026-11-06. Machine : macOS 13.7.8 Intel.

## Terminé (vérifié)
- **Design system** : tokens clair/sombre (neutres, contrastes AA), accent configurable (8 présets + sélecteur libre, texte d'accent calculé par contraste), densité, échelle de texte (90–120 %), police (Inter embarquée / système / serif), `prefers-reduced-motion` respecté, focus visible.
- **Icônes Papicons** : 104 SVG MIT vendus (commit épinglé), composant `<Icon>` typé et accessible, générateur reproductible, licence conservée, inventaire des manques (`docs/DESIGN_ICONS.md`).
- **Kit UI accessible** (Radix + Tailwind) : Button, IconButton (nom accessible obligatoire), Dialog, Menu, Switch, Segmented, Tooltip, Kbd, EmptyState, Toaster (erreurs persistantes), ErrorBoundary, lignes de paramètres.
- **Shell** : barre latérale compacte (masquer/afficher, redimensionnement souris + clavier, largeur persistée), navigation avec historique précédent/suivant, accueil, indicateur de mode (« Local · invité »).
- **Palette de commandes** (⌘/Ctrl+K) : recherche floue insensible aux accents, navigation clavier, historique des commandes persisté, 18 commandes toutes câblées.
- **Raccourcis personnalisables** : capture, détection de conflits entre commandes, combinaisons réservées refusées, réinitialisation, persistance.
- **Paramètres** : Apparence, Langue et formats (aperçu `Intl` date/heure/nombre/fuseau), Raccourcis, Système et licences.
- **Persistance réelle** des préférences en SQLite (3 commandes IPC validées, liste blanche de clés), mise à jour optimiste avec annulation et toast d'erreur en cas d'échec.
- Français/Anglais : bascule immédiate, 121 clés en parité.

## Tests exécutés (résultats)
| Suite | Résultat |
|---|---|
| `cargo test` | 22 passés / 0 échec (dont 5 nouveaux sur les préférences : clés refusées, injection SQL, persistance après réouverture) |
| Vitest `@slate/desktop` | 46 passés / 0 échec (modèle, store, raccourcis, recherche, navigation, **intégration UI complète** : palette, paramètres, langue, barre latérale, remappage, échec d'écriture) |
| Vitest `@slate/icons` | 3 passés |
| axe (a11y) | 0 violation sur : accueil, palette, les 4 onglets de paramètres |
| clippy `-D warnings`, ESLint, Prettier, tsc, i18n | 0 erreur |
| Vérification visuelle (navigateur intégré, IPC simulé) | palette, paramètres, thèmes clair/sombre, changement d'accent : conformes |

## Défauts trouvés et corrigés pendant la phase
1. `aria-label` sur un `span` sans rôle (composant `Kbd`) — signalé par axe, corrigé.
2. Commandes IPC `settings_*` **non enregistrées** dans Tauri (détecté grâce aux warnings « jamais utilisé ») — corrigé ; sans cela l'app réelle n'aurait pas pu sauvegarder une préférence.
3. Règles globales hors `@layer base` empêchant `focus-visible:outline-none` (halo rogné dans la palette) — corrigé.
4. `border-radius` forcé sur tout élément focalisé (déformait les pastilles d'accent) — retiré.

## Non fait / partiel / limites (à ne pas présumer terminé)
- **Profils de configuration** : non implémentés.
- **Raccourcis « personnalisables »** : OK pour les 19 commandes actuelles ; pas de raccourci par commande contextuelle (rien de contextuel n'existe encore).
- **Barre latérale « personnalisable »** : seulement largeur + masquage ; sections (favoris, récents, espaces) arrivent avec les pages (Phase 3).
- **Fonctions de la palette** : seulement des commandes ; recherche de contenu, création de page/tâche/base : phases suivantes.
- **Menu** et **Switch** : composants prêts mais non utilisés ni testés isolément.
- **Vérification dans la vraie fenêtre Tauri** : voir ci-dessous ; l'interaction (clics/raccourcis) n'a été exercée que dans le navigateur intégré avec un IPC simulé et dans jsdom. Aucun test e2e natif.
- Windows / Apple Silicon : toujours non testés ; CI inchangée et jamais exécutée.
- Le bundle JS dépasse 500 Ko (non splitté) : à traiter avec le chargement progressif (Phase 3+).
- Logo : toujours l'approximation provisoire du Ω (fichier source attendu).
- Contraste du texte sur l'accent : les 8 présets atteignent ≥ 4,5:1 (test automatisé) ; l'indigo par défaut a été assombri (`#4f63d8`) car l'ancien (`#5b6ee1`) plafonnait à 4,49:1. Une couleur personnalisée n'est pas garantie : seul le meilleur des deux textes (blanc/noir) est choisi.

## Prochaine étape recommandée
Spike éditeur (Tiptap + Yjs) puis Phase 3 (espaces, dossiers, pages, éditeur, autosave fiable, recherche FTS5).
