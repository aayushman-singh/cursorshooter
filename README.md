# CURSOR SHOOTER

A 3D first-person shooter that runs entirely in the browser: **you + 2 AI teammates
(blue team) vs 3 AI enemies (red team)**. First team to **20 kills** wins.
Full controller support alongside keyboard/mouse, real textured environments and
sound effects. No build step, no runtime dependencies — just static files
(Three.js r160 is vendored in `vendor/`).

## Run

```bash
npm install     # one-time: installs the 'ws' WebSocket package
npm start       # node server/server.js — serves the client + /ws on :8080
```

Open <http://localhost:8080> in a modern browser (Chrome/Edge/Firefox), click
**START MATCH**. A gamepad connected before or during play is picked up
automatically (indicator appears at the bottom of the HUD). Set `PORT` to
change the port (`PORT=3000 npm start`).

## Multiplayer

CURSOR SHOOTER now plays online: one Node server (`server/server.js`) serves
the static client over HTTP and runs the authoritative match over WebSocket at
`/ws`. Players are auto-balanced onto blue/red teams; the server owns hp, team
scores (first to 20), respawns, and the win/restart flow. The wire protocol is
documented in `server/protocol.md`.

### Rooms

Matches happen in rooms. Leaving the room code empty puts you in the public
**LOBBY** with whoever else is there; entering a code (letters/digits, up to 8
chars) creates or joins a private room — share the code with friends, or send
them a link with it prefilled: `https://<your-host>/?room=CODE`. Rooms are
fully independent matches and are destroyed when the last player leaves.

### Bots

Bots fill each team up to 3 members and are simulated by the longest-connected
player in the room (the "host"). The menu's **FILL WITH BOTS** toggle is the
room creator's choice and sticks for the life of the room — later joiners see
the room's setting in their welcome message.

## Deploy to Render

The repo ships a `render.yaml` blueprint: one web service, Node runtime,
`npm install` build, `node server/server.js` start. Either:

- **Blueprint**: Render dashboard → New → Blueprint → point at this repo, or
- **Manual**: New → Web Service → Node runtime, build command `npm install`,
  start command `node server/server.js`.

Render sets `PORT` automatically; WebSocket traffic on `/ws` works out of the
box on the same URL as the site.

## Controls

| Action | Keyboard / Mouse | Gamepad (standard mapping) |
|--------|------------------|----------------------------|
| Move | WASD | Left stick |
| Look | Mouse | Right stick |
| Fire | Left mouse button | RT |
| Aim | Right mouse button | LT |
| Jump | Space | A |
| Crouch | Ctrl / C | B / R3 |
| Reload | R | X |
| Sprint | Shift | L3 / LB |
| Pause | Esc | Start |
| Menu navigate / confirm | Arrows + Enter, or click | D-pad / stick + A |

## Rules

- Hitscan rifle: 25 dmg, 10 rounds/s, 30-round mag, 1.6s reload, infinite reserve.
- 100 HP, respawn after 3s at a random team spawn with a fresh mag.
- Crouching shrinks your capsule to 0.95m (harder to hit) but slows you to 2.5 m/s;
  you can't stand up under a low ceiling.
- Friendly fire is off (teammates block bullets but take no damage).
- Kill feed, team scores (first to 20), match timer, hitmarkers, damage vignette.

## Project layout

```
index.html            entry page (DOM contract for the HUD)
css/style.css         HUD + menu styling
vendor/three.module.js  Three.js r160 (offline)
assets/textures/      CC0 PBR textures (ambientCG.com): floor, wall, crate (+ normals)
assets/sounds/        CC0 sound effects (Kenney.nl): gunshots, reload, hits, steps, UI
js/engine/renderer.js scene/camera/lights
js/engine/input.js    keyboard/mouse/pointer-lock + Gamepad API
js/engine/physics.js  AABB colliders, capsule movement, raycasts
js/engine/audio.js    WebAudio manager (decode + playback)
js/game/map.js        arena geometry, spawns, bot waypoints
js/game/player.js     first-person controller (walk/sprint/jump/crouch)
js/game/weapons.js    hitscan rifle, tracers, view model
js/game/bots.js       5 AI bots (patrol / engage / strafe / reload)
js/game/hud.js        HUD + menus
js/main.js            bootstrap, game loop, match state machine
server/server.js      multiplayer server (static files + authoritative /ws match)
server/protocol.md    client/server WebSocket protocol
ARCHITECTURE.md       module contract the code was built against
```

## Asset credits (all CC0 — no attribution required)

- Textures: [ambientCG](https://ambientcg.com/) — MetalPlates006 (floor),
  Concrete034 (walls), WoodSiding001 (crates).
- Sounds: [Kenney.nl](https://kenney.nl/) — Digital Audio (gunshots),
  Impact Sounds (hits/reload/footsteps), Interface Sounds (win/lose/click).

## Dev verification

```bash
npm test          # headless 90s logic sim (map/physics/weapons/bots/player/crouch)
node --check js/main.js   # syntax check (project is "type": "module")
```

`sim-test.mjs` runs the real modules headlessly via the tiny committed
`node_modules/three` shim (two hand-written files pointing at `vendor/` —
no packages to install). Full browser smoke testing additionally used
headless Chrome (Puppeteer) from outside the project: menu flow, pointer-lock
play, firing, bot kills, HUD, and rendering all verified.
# cursorshooter
# cursorshooter
