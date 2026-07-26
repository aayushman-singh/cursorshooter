# ARCHITECTURE.md — CURSOR SHOOTER (module contract)

Browser FPS: **player + 2 bot teammates (team A, blue) vs 3 enemy bots (team B, red)**.
First team to **20 kills** wins. Respawn after 3s. Vanilla ES modules + Three.js r160
(vendored at `vendor/three.module.js`). **No build step, no other dependencies.**
Textures (ambientCG, CC0) and sounds (Kenney.nl, CC0) are vendored under `assets/`.

## Hard rules for implementers

1. Each module has a **stub file whose exported signatures are NORMATIVE** — implement the
   bodies, do NOT change any export name, signature, or add/remove exports.
2. Touch **only your own file(s)**. Never edit another module, `index.html`, or `css/style.css`.
3. `import * as THREE from 'three'` (importmap in `index.html` maps it to the vendored build).
   Import other project modules only via the exact relative paths used in the stubs.
4. Must stay dependency-free and run from a plain static server (`python3 -m http.server`).

## Conventions

- Meters, **Y-up**, right-handed. `dt` is always **seconds** (already clamped to ≤ 0.05 by main loop).
- **`Combatant.position` is the FEET position** (THREE.Vector3, mutated in place, never reassigned
  after construction). Eye/muzzle height = `position.y + eyeHeight`.
- Combatant dimensions: `radius 0.4`, `height 1.8`, `eyeHeight 1.6`, `maxHealth 100`.
- Teams are the strings `'A'` (player's team) and `'B'`.
- The **Combatant interface** (player and every bot implement it):
  ```js
  {
    id: string,            // 'player' for the human, 'bot-1'… for bots
    name: string, team: 'A'|'B', isBot: boolean,
    alive: boolean, health: number, maxHealth: 100,
    position: THREE.Vector3,   // feet, mutated in place
    velocity: THREE.Vector3,
    radius: 0.4, height: 1.8, eyeHeight: 1.6,
    applyDamage(amount, fromId),        // reduces health, fires callbacks below
    onDeath: (victim, killerId) => {},  // assigned by main.js
    onDamaged: (amount, fromId) => {},  // assigned by main.js / used for hitmarkers
    weapon: Weapon                       // set by main.js / BotManager
  }
  ```
- Friendly fire: **off**. `Weapon.tryFire` must not damage same-team combatants.
- Bots' guns use the same `Weapon` class as the player (shared hitscan logic).

## Files / ownership

| File | Owner agent | Purpose |
|------|-------------|---------|
| `js/engine/renderer.js` | 1 | `Engine` — renderer, scene, camera, lights, sky/fog |
| `js/engine/input.js` | 2 | `InputManager` — keyboard/mouse (pointer lock) + Gamepad API |
| `js/engine/physics.js` | 3 | `PhysicsWorld`, `GRAVITY` — AABB colliders, capsule movement, raycasts |
| `js/engine/audio.js` | — | `AudioManager` — WebAudio decode + playback of the CC0 sound set |
| `js/game/map.js` | 4 | `buildMap(scene, physics)` — arena geometry, colliders, spawns, waypoints |
| `js/game/player.js` | 5 | `PlayerController` — FPS movement/look, health (Combatant) |
| `js/game/weapons.js` | 6 | `WeaponSystem`, `Weapon`, `createViewModel` — hitscan rifle + effects |
| `js/game/bots.js` | 7 | `BotManager` — 5 AI bots (Combatants with meshes + weapons) |
| `js/game/hud.js` | 8 | `HUD` — HUD updates + menus over the fixed DOM |
| `js/main.js` | 9 | `startGame` — bootstrap, loop, match state machine, scoring |

## DOM contract (fixed in `index.html`; hud.js manipulates ONLY these)

- Containers: `#app`, `#game-canvas` (canvas), `#hud`, `#menu`.
- HUD elements: `#crosshair`, `#hitmarker` (toggle `.hidden`, `.hm-flash`, `.hm-kill`),
  `#damage-vignette` (`.dv-flash`), `#health-bar-fill` (width %, `.hp-low` under 35),
  `#health-text`, `#ammo-mag`, `#ammo-reserve`, `#reload-hint` (`.hidden`),
  `#score-a`, `#score-b`, `#match-timer`, `#killfeed` (append `.kf-entry` divs,
  use `.team-a`/`.team-b` spans for names, `.kf-x` for the "☠/›" separator, `.kf-fade` to fade),
  `#center-message` (`.hidden`, `.cm-win`, `.cm-lose`, `.cm-fade`), `#gamepad-indicator` (`.hidden`).
- Menu: `#menu` (`.hidden`), `#menu-title` (`.mn-red` for defeat styling), `#menu-subtitle`,
  `#menu-buttons` (HUD creates `<button class="menu-btn" data-action="…">`; `.mb-focused` marks
  the controller-focused button), `#menu-hint`.
- HUD code must never add/remove top-level DOM nodes outside `#menu-buttons` and `#killfeed`.

## Gamepad mapping (standard mapping, implemented in input.js)

- Left stick: move (strafe/forward). Right stick: look.
- RT (button 7): fire. LT (button 6): aim. A (0): jump. X (2): reload.
- B (1) or R3 (11): crouch (keyboard: Ctrl or C). L3 (10) or LB (4): sprint.
- Start (9): pause. A (0) also activates menu buttons,
  d-pad/stick navigates menus. Stick deadzone 0.15, right-stick look speed ~2.6 rad/s at full deflection.

## Match flow (main.js)

1. `start` menu (title, subtitle with controls, buttons: Start). Click/press → pointer lock + `playing`.
2. `playing`: loop runs; Esc / Start / pointer-lock loss → `paused` menu (Resume, Restart).
3. Kill → `onDeath(victim, killerId)`: killer's team score++, killfeed entry, respawn timer 3 s
   at a random own-team spawn. First to 20 → `gameover` menu (VICTORY/DEFEAT, Play again).
4. Restart resets health, ammo, scores, positions, killfeed, timer.
