// Headless integration sim: map + physics + weapons + bots + player controller.
// Runs the real modules for a simulated 90s match and asserts sane behavior.

// Minimal DOM stubs so three's TextureLoader (createElementNS('img')) works
// headless. Images never fire load events — fine for a logic-only sim.
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
  }),
  createElementNS: () => ({
    addEventListener() {}, removeEventListener() {},
    style: {}, src: '',
  }),
};

import * as THREE from 'three';
import { PhysicsWorld, GRAVITY } from './js/engine/physics.js';
import { buildMap } from './js/game/map.js';
import { PlayerController } from './js/game/player.js';
import { WeaponSystem, createViewModel } from './js/game/weapons.js';
import { BotManager } from './js/game/bots.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok:', msg);
}

const scene = new THREE.Scene();
const physics = new PhysicsWorld();
const mapData = buildMap(scene, physics);

assert(mapData.spawnPoints.A.length >= 3 && mapData.spawnPoints.B.length >= 3, 'spawns >= 3 per team');
assert(mapData.waypoints.length >= 15, `waypoints >= 15 (got ${mapData.waypoints.length})`);
assert(Number.isFinite(mapData.spawnYaw.A) && Number.isFinite(mapData.spawnYaw.B), 'spawnYaw finite');

// Player with a scripted fake input (stands still, looks forward).
const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 500);
scene.add(camera);
const fakeInput = {
  consumeLookDelta: () => ({ dx: 0, dy: 0 }),
  getState: () => ({ moveX: 0, moveZ: 0, fire: false, aim: false, sprint: false }),
  wasPressed: () => false,
};
const player = new PlayerController(camera, fakeInput, physics);
const weaponSystem = new WeaponSystem(scene, physics);
player.weapon = weaponSystem.createWeapon(player);
player.spawnAt({ position: mapData.spawnPoints.A[0].clone(), yaw: mapData.spawnYaw.A });

// Exercise the view model too (camera-parented, pure three objects).
const viewModel = createViewModel(camera);
viewModel.kick();
viewModel.setReloading(true);
viewModel.setReloading(false);
viewModel.setVisible(true);

const botManager = new BotManager(scene, physics, mapData, weaponSystem);
const roster = [
  { name: 'Alpha', team: 'A' }, { name: 'Bravo', team: 'A' },
  { name: 'Viper', team: 'B' }, { name: 'Rogue', team: 'B' }, { name: 'Havoc', team: 'B' },
];
botManager.spawnBots(roster);
assert(botManager.bots.length === 5, '5 bots spawned');
assert(botManager.bots.filter(b => b.team === 'A').length === 2, '2 bots on team A');
assert(botManager.bots.every(b => b.weapon && b.mesh), 'bots have weapon + mesh');

const combatants = [player, ...botManager.bots];
const deaths = [];
for (const c of combatants) {
  c.onDeath = (victim, killerId) => deaths.push({ victim: victim.name, killerId });
  c.onDamaged = () => {};
}

function respawn(c) {
  const list = mapData.spawnPoints[c.team];
  const spawn = { position: list[Math.floor(Math.random() * list.length)].clone(), yaw: mapData.spawnYaw[c.team] };
  if (c === player) player.spawnAt(spawn); else botManager.respawnBot(c, spawn);
}

// Simulated 90 seconds at 60 Hz, with main.js-like respawn handling.
const dt = 1 / 60;
const respawns = [];
let playerShots = 0;
for (let frame = 0; frame < 90 * 60; frame++) {
  player.update(dt);
  botManager.update(dt, combatants);
  player.weapon.update(dt);
  weaponSystem.update(dt);
  viewModel.update(dt, false);

  // Player returns fire at the nearest visible enemy every other frame.
  if (player.alive && frame % 2 === 0) {
    const eye = player.getEyePosition();
    let best = null, bestD = Infinity;
    for (const b of botManager.bots) {
      if (!b.alive || b.team === player.team) continue;
      const d = eye.distanceTo(b.position);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best) {
      const target = best.position.clone(); target.y += 1.3;
      const dir = target.sub(eye).normalize();
      const shot = player.weapon.tryFire(eye, dir, combatants);
      if (shot) playerShots++;
    }
  }

  for (let i = respawns.length - 1; i >= 0; i--) {
    respawns[i].t -= dt;
    if (respawns[i].t <= 0) { respawn(respawns[i].c); respawns.splice(i, 1); }
  }
  for (const c of combatants) {
    if (!c.alive && !respawns.some(r => r.c === c)) respawns.push({ c, t: 3 });
    // Invariants every frame:
    if (!Number.isFinite(c.position.x + c.position.y + c.position.z)) {
      assert(false, `${c.name} position went NaN at frame ${frame}`);
      frame = 1e9; break;
    }
  }
}

const inBounds = combatants.every(c =>
  Math.abs(c.position.x) <= 31 && Math.abs(c.position.z) <= 21 && c.position.y > -2 && c.position.y < 10);
assert(inBounds, 'all combatants inside arena bounds after 90s');
assert(deaths.length > 0, `kills happened during sim (got ${deaths.length})`);
assert(playerShots > 0, `player fired shots (got ${playerShots})`);
const playerDeaths = deaths.filter(d => d.victim === 'You').length;
console.log(`sim stats: ${deaths.length} total kills, player died ${playerDeaths}x, player shots ${playerShots}`);
console.log('kill sample:', deaths.slice(0, 5));

// Bot respawn resets state.
const bot = botManager.bots[0];
bot.health = 0; bot.alive = false;
botManager.respawnBot(bot, { position: mapData.spawnPoints[bot.team][0].clone(), yaw: 0 });
assert(bot.alive && bot.health === 100 && bot.weapon.ammo === bot.weapon.magSize, 'respawnBot resets health/alive/ammo');

// Player movement: walk forward for 2s with the real controller + collisions.
// Force a respawn first — the battle above may have left the player dead.
player.spawnAt({ position: mapData.spawnPoints.A[0].clone(), yaw: mapData.spawnYaw.A });
let moved = 0;
const startPos = player.position.clone();
fakeInput.getState = () => ({ moveX: 0, moveZ: 1, fire: false, aim: false, sprint: false });
for (let i = 0; i < 120; i++) player.update(dt);
moved = player.position.distanceTo(startPos);
assert(moved > 3, `player walks forward (moved ${moved.toFixed(1)}m in 2s)`);
assert(player.position.y <= 2.5 && player.position.y > -1, `player y sane (${player.position.y.toFixed(2)})`);

// Crouch: capsule + eye shrink smoothly, then stand back up in the open.
fakeInput.getState = () => ({ moveX: 0, moveZ: 0, fire: false, aim: false, sprint: false, crouch: true });
for (let i = 0; i < 60; i++) player.update(dt);
assert(player.height < 1.1 && player.eyeHeight < 0.9,
  `crouch shrinks capsule (h=${player.height.toFixed(2)}, eye=${player.eyeHeight.toFixed(2)})`);
fakeInput.getState = () => ({ moveX: 0, moveZ: 0, fire: false, aim: false, sprint: false, crouch: false });
for (let i = 0; i < 60; i++) player.update(dt);
assert(player.height > 1.7 && player.eyeHeight > 1.5,
  `stands back up (h=${player.height.toFixed(2)}, eye=${player.eyeHeight.toFixed(2)})`);

console.log(failures === 0 ? '\nALL SIM CHECKS PASSED' : `\n${failures} SIM CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
