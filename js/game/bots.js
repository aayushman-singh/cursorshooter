import * as THREE from 'three';
import { GRAVITY } from '../engine/physics.js';

// --- AI tuning ---
const WALK_SPEED = 4.5;        // m/s, matches the "bot walk" convention
const ENGAGE_RANGE = 15;       // approach beyond this distance, strafe inside it
const REACTION_TIME = 0.25;    // s between acquiring a target and opening fire
const AIM_ERROR = 0.035;       // ~2° of human-like aim scatter (per-axis)
const REAIM_MIN = 0.35;        // s between aim-error re-rolls (min/max)
const REAIM_MAX = 0.75;
const LOS_MEMORY = 0.75;       // keep a target this long after LOS breaks
const TURN_SPEED = 12;         // rad/s yaw tracking
const WP_REACH = 1.5;          // waypoint arrival radius (horizontal, m)
const AIM_HEIGHT = 1.35;       // chest height bots aim at

const TEAM_COLORS = { A: 0x2f6bff, B: 0xd8342c };

// Scratch vectors shared by the (strictly sequential) per-bot AI steps.
const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function wrapAngle(a) {
  return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

/** Step `current` yaw toward `target` yaw by at most `maxStep` radians. */
function yawToward(current, target, maxStep) {
  const diff = wrapAngle(target - current);
  return current + Math.max(-maxStep, Math.min(maxStep, diff));
}

/** Yaw whose forward (-sin yaw, 0, -cos yaw) points along (dx, dz). */
function dirToYaw(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/**
 * Team-colored bot body: capsule-ish torso + head (with a dark visor marking
 * the facing direction) + a small gun box. The group faces -Z at yaw 0, so
 * `group.rotation.y = bot.yaw` matches the (dx, dz) → yaw convention above.
 */
function buildBotMesh(team) {
  const group = new THREE.Group();
  const teamMat = new THREE.MeshLambertMaterial({ color: TEAM_COLORS[team] ?? 0x888888 });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x1c1e22 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.72, 4, 12), teamMat);
  body.position.y = 0.7; // spans 0 → 1.4

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), teamMat);
  head.position.y = 1.58; // top at 1.8 == combatant height

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.09, 0.12), darkMat);
  visor.position.set(0, 1.58, -0.17);

  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.75), darkMat);
  gun.position.set(0.24, 1.28, -0.42);

  for (const m of [body, head, visor, gun]) {
    m.castShadow = true;
    group.add(m);
  }
  return group;
}

/**
 * Creates and drives the 5 bots (2 team-A teammates, 3 team-B enemies).
 * Each bot implements the Combatant interface (see ARCHITECTURE.md).
 */
export class BotManager {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../engine/physics.js').PhysicsWorld} physics
   * @param {ReturnType<import('./map.js').buildMap>} mapData
   * @param {import('./weapons.js').WeaponSystem} weaponSystem
   */
  constructor(scene, physics, mapData, weaponSystem) {
    this.scene = scene;
    this.physics = physics;
    this.mapData = mapData;
    this.weaponSystem = weaponSystem;
    /** @type {object[]} all bots (Combatants) */
    this.bots = [];
  }

  /**
   * Create the bots and their meshes at sensible initial positions
   * (any own-team spawn point). Does NOT assign spawn ownership — main.js
   * may immediately reposition via respawnBot.
   * @param {{ name: string, team: 'A'|'B' }[]} roster
   * @returns {object[]} this.bots
   */
  spawnBots(roster) {
    this.bots = roster.map((entry, i) => {
      const bot = {
        // --- Combatant interface ---
        id: `bot-${i + 1}`,
        name: entry.name,
        team: entry.team,
        isBot: true,
        alive: true,
        health: 100,
        maxHealth: 100,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        radius: 0.4,
        height: 1.8,
        eyeHeight: 1.6,
        weapon: null,      // set below (created here via weaponSystem)
        onDeath: () => {}, // assigned by main.js
        onDamaged: () => {},
        applyDamage: null, // set below (needs the closed-over bot object)
        // --- bot-only state ---
        yaw: 0,
        mesh: buildBotMesh(entry.team),
        target: null,
        losTimer: 0,
        reactTimer: 0,
        reaimTimer: 0,
        aimErrX: 0,
        aimErrY: 0,
        waypoint: null,
        strafeSign: Math.random() < 0.5 ? -1 : 1,
        strafeTimer: 1,
      };

      bot.applyDamage = (amount, fromId) => {
        if (!bot.alive) return;
        bot.health = Math.max(0, bot.health - amount);
        bot.onDamaged(amount, fromId);
        if (bot.health <= 0) {
          bot.alive = false;
          bot.velocity.set(0, 0, 0);
          bot.mesh.visible = false;
          bot.onDeath(bot, fromId);
        }
      };

      bot.weapon = this.weaponSystem.createWeapon(bot);

      // Sensible initial placement; main.js may immediately reposition.
      const spawns = this.mapData.spawnPoints[bot.team];
      const spawnPos = spawns.length > 0 ? spawns[i % spawns.length] : new THREE.Vector3();
      bot.position.copy(spawnPos);
      bot.yaw = this.mapData.spawnYaw[bot.team] || 0;
      bot.mesh.position.copy(bot.position);
      bot.mesh.rotation.y = bot.yaw;
      this.scene.add(bot.mesh);

      return bot;
    });
    return this.bots;
  }

  /**
   * Per-frame AI for every living bot: targeting, movement, aiming, firing.
   * Dead bots are skipped (main.js respawns them via respawnBot).
   * @param {number} dt seconds
   * @param {object[]} combatants every combatant (player + all bots)
   */
  update(dt, combatants) {
    for (const bot of this.bots) {
      if (!bot.alive) continue;

      // BotManager owns bot weapon timers (cooldown/reload); main.js only
      // drives the player's weapon.
      bot.weapon.update(dt);

      this._think(bot, dt, combatants);

      // Integrate: horizontal velocity was set by _think; add gravity and
      // resolve against the world like the player does.
      bot.velocity.y += GRAVITY * dt;
      this.physics.moveCapsule(bot.position, bot.velocity, bot.radius, bot.height, dt);

      bot.mesh.position.copy(bot.position);
      bot.mesh.rotation.y = bot.yaw;
    }
  }

  /**
   * Reset a bot at a spawn point: health, alive, position, velocity, ammo,
   * AI state; mesh visible again.
   * @param {object} bot
   * @param {{ position: THREE.Vector3, yaw: number }} spawn
   */
  respawnBot(bot, spawn) {
    bot.alive = true;
    bot.health = bot.maxHealth;
    bot.position.copy(spawn.position);
    bot.velocity.set(0, 0, 0);
    bot.yaw = spawn.yaw || 0;

    bot.weapon.ammo = bot.weapon.magSize;
    bot.weapon.isReloading = false;
    bot.weapon.cooldown = 0;

    bot.target = null;
    bot.losTimer = 0;
    bot.reactTimer = 0;
    bot.reaimTimer = 0;
    bot.aimErrX = 0;
    bot.aimErrY = 0;
    bot.waypoint = null;
    bot.strafeSign = Math.random() < 0.5 ? -1 : 1;
    bot.strafeTimer = 1;

    bot.mesh.visible = true;
    bot.mesh.position.copy(bot.position);
    bot.mesh.rotation.y = bot.yaw;
  }

  /** Decide velocity, yaw, and firing for one bot this frame. */
  _think(bot, dt, combatants) {
    // Validate the current target; allow a short memory after LOS breaks so
    // bots don't flicker between targets when someone ducks behind cover.
    let target = bot.target;
    let visible = false;
    if (target) {
      if (!target.alive) {
        target = bot.target = null;
      } else {
        visible = this._canSee(bot, target);
        if (visible) {
          bot.losTimer = LOS_MEMORY;
        } else {
          bot.losTimer -= dt;
          if (bot.losTimer <= 0) target = bot.target = null;
        }
      }
    }

    // Acquire the nearest visible enemy when we have no target.
    if (!target) {
      target = this._acquire(bot, combatants);
      if (target) {
        bot.target = target;
        bot.reactTimer = REACTION_TIME;
        bot.losTimer = LOS_MEMORY;
        visible = true;
      }
    }
    if (bot.reactTimer > 0) bot.reactTimer -= dt;

    let vx = 0;
    let vz = 0;

    if (target) {
      const dx = target.position.x - bot.position.x;
      const dz = target.position.z - bot.position.z;
      const dist = Math.hypot(dx, dz) || 1e-4;

      // Always face the enemy while engaging.
      bot.yaw = yawToward(bot.yaw, dirToYaw(dx, dz), TURN_SPEED * dt);

      if (dist > ENGAGE_RANGE) {
        // Far: close the distance head-on.
        vx = (dx / dist) * WALK_SPEED;
        vz = (dz / dist) * WALK_SPEED;
      } else {
        // In range: strafe sideways, flipping direction every couple of
        // seconds so bots are harder to track.
        bot.strafeTimer -= dt;
        if (bot.strafeTimer <= 0) {
          bot.strafeSign *= -1;
          bot.strafeTimer = 1.2 + Math.random() * 1.2;
        }
        vx = (-dz / dist) * bot.strafeSign * WALK_SPEED * 0.85;
        vz = (dx / dist) * bot.strafeSign * WALK_SPEED * 0.85;
      }

      if (visible && bot.reactTimer <= 0) this._fire(bot, target, dt, combatants);
    } else {
      // Idle: patrol between random waypoints, facing the travel direction.
      const wps = this.mapData.waypoints;
      if (wps.length > 0) {
        if (!bot.waypoint) {
          let wp = wps[(Math.random() * wps.length) | 0];
          if (wps.length > 1) {
            while (wp === bot.lastWaypoint) wp = wps[(Math.random() * wps.length) | 0];
          }
          bot.waypoint = bot.lastWaypoint = wp;
        }
        const dx = bot.waypoint.x - bot.position.x;
        const dz = bot.waypoint.z - bot.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < WP_REACH) {
          bot.waypoint = null;
        } else {
          vx = (dx / dist) * WALK_SPEED;
          vz = (dz / dist) * WALK_SPEED;
          bot.yaw = yawToward(bot.yaw, dirToYaw(dx, dz), TURN_SPEED * dt);
        }
      }
    }

    bot.velocity.x = vx;
    bot.velocity.z = vz;

    if (bot.weapon.ammo === 0 && !bot.weapon.isReloading) bot.weapon.reload();
  }

  /** Fire at the target's chest with periodically re-rolled aim error. */
  _fire(bot, target, dt, combatants) {
    bot.reaimTimer -= dt;
    if (bot.reaimTimer <= 0) {
      bot.reaimTimer = REAIM_MIN + Math.random() * (REAIM_MAX - REAIM_MIN);
      bot.aimErrX = (Math.random() * 2 - 1) * AIM_ERROR;
      bot.aimErrY = (Math.random() * 2 - 1) * AIM_ERROR;
    }

    // Fresh vectors per shot: the weapon/effects code may retain them.
    const eye = bot.position.clone();
    eye.y += bot.eyeHeight;
    const aim = target.position.clone();
    aim.y += AIM_HEIGHT;
    const dir = aim.sub(eye).normalize();

    // Apply the aim error as a small sideways/up nudge (a few degrees).
    _right.crossVectors(dir, _up).normalize();
    dir.addScaledVector(_right, bot.aimErrX).addScaledVector(_up, bot.aimErrY).normalize();

    // Rate of fire and friendly-fire rules are enforced inside tryFire.
    bot.weapon.tryFire(eye, dir, combatants);
  }

  /** Eye-to-eye line of sight: no wall between bot and target. */
  _canSee(bot, target) {
    _eye.copy(bot.position);
    _eye.y += bot.eyeHeight;
    _aim.copy(target.position);
    _aim.y += target.eyeHeight;
    _dir.subVectors(_aim, _eye);
    const dist = _dir.length();
    if (dist < 1e-4) return true;
    _dir.divideScalar(dist);
    const hit = this.physics.raycastWorld(_eye, _dir, dist);
    return !hit || hit.distance >= dist - 0.3;
  }

  /** Nearest living enemy with clear line of sight, or null. */
  _acquire(bot, combatants) {
    let best = null;
    let bestD2 = Infinity;
    for (const c of combatants) {
      if (c === bot || !c.alive || c.team === bot.team) continue;
      const d2 = bot.position.distanceToSquared(c.position);
      if (d2 < bestD2 && this._canSee(bot, c)) {
        best = c;
        bestD2 = d2;
      }
    }
    return best;
  }
}
