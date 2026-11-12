# Publier une version et mises à jour automatiques

## Principe
- L'application installée cherche une nouvelle version dans `https://github.com/HigHollows/Slate/releases/latest/download/latest.json` (au démarrage puis toutes les 6 h, désactivable dans Réglages → Système et licences, ou à la demande).
- Une mise à jour n'est **jamais installée sans clic**. Elle est **vérifiée par signature** avec la clé publique de `tauri.conf.json` avant installation : une archive modifiée ou non signée est refusée. Après installation, Slate redémarre.
- Les versions antérieures à l'arrivée de ce système (0.1.2 et avant) n'ont pas le module : il faut installer une fois à la main une version qui l'a, puis les suivantes arrivent toutes seules.

## Une seule fois : le secret de signature (à faire par vous)
La paire de clés a été générée sur le Mac de développement :
- clé **publique** : dans `tauri.conf.json` (`plugins.updater.pubkey`), sans danger ;
- clé **privée** : `~/.tauri/slate-updater.key` (**sans mot de passe**), jamais dans le dépôt. **Sauvegardez-la** (gestionnaire de mots de passe) : si elle est perdue, plus aucune mise à jour ne pourra être signée pour les installations existantes.

Pour que GitHub signe les mises à jour, ajoutez la clé privée comme secret du dépôt :
1. Copiez-la : `pbcopy < ~/.tauri/slate-updater.key`
2. [github.com/HigHollows/Slate/settings/secrets/actions](https://github.com/HigHollows/Slate/settings/secrets/actions) → **New repository secret**
3. Nom : `TAURI_SIGNING_PRIVATE_KEY` ; valeur : coller. (Pas de mot de passe : ne créez pas `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.)

Sans ce secret, le workflow construit quand même les installateurs, mais sans fichiers de mise à jour (un avertissement le signale).

## Publier
1. Augmenter la version (`tauri.conf.json`, `Cargo.toml`, `package.json`, `apps/desktop/package.json`, `Cargo.lock`).
2. Pousser sur `main`, puis une étiquette : `git tag -a v0.1.4 -m "Slate 0.1.4" && git push origin v0.1.4`.
3. Le workflow « Release » construit Windows (.exe), macOS Apple Silicon et Intel (.dmg + archives de mise à jour), signe, **publie** la version et joint `latest.json`.
4. Les applications installées proposent la mise à jour (badge « Mise à jour disponible » dans la barre latérale).

Le contenu cloud (URL et clé publique Supabase) est intégré via les variables de dépôt `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` (Settings → Secrets and variables → Actions → Variables).

## Limites
- **Non vérifié de bout en bout** : il faut deux versions publiées signées pour voir une installation réelle. Les tests couvrent la logique, l'interface et la configuration, pas le téléchargement signé.
- Builds **non signés par un certificat** (Apple / Windows) : avertissements du système au premier lancement (les mises à jour, elles, sont signées).
- Windows : l'installation passe par l'installateur NSIS (mode « passif »).
