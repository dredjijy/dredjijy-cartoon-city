# Cartoon City

Jeu 3D de simulation de vie en navigateur (Three.js).

- Le site publié est la racine du dépôt (`index.html`, `city.js`, packs `.bin`, `tex/`, `veh/`, `x/`, `x2/`, `ui/`).
- Le code source est dans `source/src/main.js`. Rebuild :
  ```
  cd source && npm install && npx esbuild src/main.js --bundle --format=iife --minify --outfile=../city.js
  ```
- Lancer en local : `npx serve .`
- Supabase : exécuter `supabase_saves.sql` dans le SQL Editor du projet.
