# Icônes — inventaire et règles

Source unique : **Papicons** (<https://icons.papillon.bzh/>, MIT), vendue dans `packages/icons/svg/` (104 SVG, commit épinglé dans `SOURCE_COMMIT`). Aucune autre bibliothèque, aucun emoji.
Usage : `<Icon name="search" />` (typé : `IconName`). Décorative par défaut ; `label="…"` la rend accessible.

## Icônes utilisées à ce jour (toutes issues du catalogue)
`search`, `home`, `gears`, `menu`, `arrow-left`, `arrow-right`, `plus`, `minus`, `sun`, `moon`, `color-theme`, `palette`, `globe`, `list`, `grid`, `code`, `info`, `sparkles`, `pen`, `cross`, `check`, `alert-circle`.

## Besoins connus SANS équivalent dans Papicons (à traiter en Phase 3+)
Règle du cahier des charges : solution typographique ou élément graphique minimal, **sans** autre bibliothèque.

| Besoin | Solution prévue |
|---|---|
| Italique, barré, H1/H2/H3 | Glyphes typographiques (« *I* », « ~~S~~ », « H1 ») dans un bouton texte ; `bold`/`underline` existent. |
| Citation, séparateur, case à cocher, liste numérotée | Éléments graphiques CSS minimaux (barre verticale, trait, carré/coche) ; `list` pour liste à puces. |
| Tableau, base de données, kanban, galerie | `grid` / `list` du catalogue pour tableau/liste ; formes géométriques simples (colonnes) pour kanban. |
| Image / vidéo / fichier | `gallery`, `camera`, `paper` existent ; vidéo → `play`. |
| Annuler / rétablir | Flèches `arrow-left-down` / `arrow-right-down` ou glyphes ↶ ↷ typographiques. |
| Glisser-déposer (poignée) | Six points CSS (élément graphique minimal). |
| Corbeille, favoris, épingle | `trash`, `star`, `bookmark` existent. |
| Verrou/PIN | `lock`, `unlock`, `password` existent. |

## Hors périmètre volontaire
Les logos de marques tierces du dépôt Papicons (Papillon, Pronote, ÉcoleDirecte, Skolengo, Apple) ne sont pas vendus. Certaines icônes (bus, métro, chaise…) sont vendues car elles font partie du catalogue mais ne sont pas utilisées.

## Logo Slate Ω
Source : `brand/slate-omega.svg` (marque, `currentColor`) et `brand/slate-icon.svg` / `.png` (icône d'application : noir #090909, Ω blanc cassé #F5F4F0). Un seul tracé géométrique (arc + deux pieds), aucun élément intérieur. `features/shell/Logo.tsx` en est la copie en ligne ; les icônes desktop (`src-tauri/icons`) sont générées par `pnpm --filter @slate/desktop exec tauri icon ../../brand/slate-icon.png`.
