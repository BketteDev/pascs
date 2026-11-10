# notCsSource

A browser shooter in the style of Counter-Strike: Source: three.js client, Node server running the game at 128 Hz over WebSockets,
bots, bomb / hostage modes, LAN play.

**No game content is included.** Maps, textures, models, sounds and fonts are converted from your own installs of Counter-Strike: Source,
CS:GO and Garry's Mod by the build tools, and stay on your machines (they are Valve's; don't commit or share them).

## Build the assets (Windows PC with the games installed)

```
npm install
npm run build        # maps, weapons, player models, sounds -> public/maps, public/weapons, public/players, public/sound, public/ui
```

Paths to the games are set in `tools/content.mjs` and `package.json`.

## Run locally

```
cp server.config.example.json server.config.json   # set map, team size, admin password (F4 menu)
npm start                                           # http://localhost:6767
npm test
```

## Deploy with Portainer

1. Copy the built asset folders `public/maps`, `public/sound`, `public/players`, `public/weapons`, `public/ui` to the Docker host,
   e.g. `/opt/notcssource/assets/{maps,sound,players,weapons,ui}`.
2. Portainer: **Stacks > Add stack > Repository**, this repo, compose path `docker-compose.yml`.
3. Environment variables: `ADMIN_PASSWORD` (required), and optionally `ASSETS_DIR` (default `/opt/notcssource/assets`), `MAP`
   (default `de_dust2`), `TEAM_SIZE` (default 5), `PORT` (default 6767).
4. Deploy, then open `http://<host>:6767`.

The server gzips map data on first request (cached in `.gzcache`) and revalidates files by ETag, so loads after the first are quick.
Weaker PCs: Options > Video > Render scale and Low texture quality.
