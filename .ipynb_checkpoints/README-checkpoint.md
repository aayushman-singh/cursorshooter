# CURSOR SHOOTER

A 3D first-person shooter that runs entirely in the browser: **you + 2 AI teammates
(blue team) vs 3 AI enemies (red team)**. First team to **20 kills** wins.
Full controller support alongside keyboard/mouse, real textured environments and
sound effects. No build step, no runtime dependencies — just static files
(Three.js r160 is vendored in `vendor/`).

## Run

```bash
cd /workspace/proj/devvid
python3 -m http.server 8080     # or: npm start
```

Open <http://localhost:8080> in a modern browser (Chrome/Edge/Firefox), click
**START MATCH**. A gamepad connected before or during play is picked up
automatically (indicator appears at the bottom of the HUD).

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
