import * as THREE from 'three';
import { Engine } from './engine/renderer.js';
import { InputManager } from './engine/input.js';
import { PhysicsWorld, GRAVITY } from './engine/physics.js';
import { AudioManager } from './engine/audio.js';
import { buildMap } from './game/map.js';
import { PlayerController } from './game/player.js';
import { WeaponSystem, createViewModel } from './game/weapons.js';
import { BotManager } from './game/bots.js';
import { HUD } from './game/hud.js';

/** Kills needed to win the match (ARCHITECTURE.md: first to 20). */
const WIN_KILLS = 20;
/** Seconds before a dead combatant respawns. */
const RESPAWN_TIME = 3;
/** Bot roster: Alpha/Bravo on team A with the player, Viper/Rogue/Havoc on B. */
const BOT_ROSTER = [
  { name: 'Alpha', team: 'A' },
  { name: 'Bravo', team: 'A' },
  { name: 'Viper', team: 'B' },
  { name: 'Rogue', team: 'B' },
  { name: 'Havoc', team: 'B' },
];
/** Sound manifest: CC0 assets (Kenney.nl) vendored under assets/sounds/. */
const SOUNDS = {
  shoot: 'assets/sounds/shoot.ogg',
  shootBot: 'assets/sounds/shoot-bot.ogg',
  reload: 'assets/sounds/reload.ogg',
  hit: 'assets/sounds/hit.ogg',
  death: 'assets/sounds/death.ogg',
  win: 'assets/sounds/win.ogg',
  lose: 'assets/sounds/lose.ogg',
  click: 'assets/sounds/click.ogg',
  step0: 'assets/sounds/step0.ogg',
  step1: 'assets/sounds/step1.ogg',
  step2: 'assets/sounds/step2.ogg',
  step3: 'assets/sounds/step3.ogg',
};

/**
 * Bootstrap + match orchestration (see ARCHITECTURE.md "Match flow"):
 *
 * - Construct: Engine(#game-canvas), InputManager(#game-canvas), PhysicsWorld,
 *   HUD(#app) + hud.wireInput(input), map via buildMap(scene, physics),
 *   PlayerController, WeaponSystem, BotManager.
 * - Teams: player + bots Alpha/Bravo = 'A'; bots Viper/Rogue/Havoc = 'B'.
 *   Every combatant gets weaponSystem.createWeapon(combatant) (bots get theirs
 *   inside BotManager) and onDeath/onDamaged handlers from here.
 * - Match state machine: 'start' | 'playing' | 'paused' | 'gameover'.
 *   start menu (Start button + controls subtitle) → pointer lock → playing.
 *   Esc/Start-button/pointer-lock loss → paused (Resume, Restart).
 *   Kill → killer's team +1, killfeed, hitmarker for the player's shots,
 *   damage flash when the player is hurt, respawn after 3s at a random
 *   own-team spawn. First team to 20 kills → gameover (VICTORY/DEFEAT,
 *   Play again → full reset).
 * - Loop: requestAnimationFrame; dt = clamp(elapsed, 0, 0.05); order:
 *   input.update → (playing ? player/bots/weapons updates + firing : nothing)
 *   → hud.update → engine.render.
 * - Player firing each frame from input state (fire held = auto fire) using
 *   player.getEyePosition()/getLookDirection(), viewModel.kick() + input.rumble
 *   on successful shots, weapon.reload() on 'reload' press, HUD ammo/health
 *   sync every frame, respawn countdown shown via setCenterMessage while dead.
 * - Expose nothing else; call startGame() on DOMContentLoaded (or immediately
 *   if the document is already parsed).
 */
export function startGame() {
  const canvas = document.getElementById('game-canvas');
  const app = document.getElementById('app');

  // --- Subsystems ---------------------------------------------------------
  const engine = new Engine(canvas);
  const input = new InputManager(canvas);
  const physics = new PhysicsWorld();
  const hud = new HUD(app);
  hud.wireInput(input);
  const mapData = buildMap(engine.scene, physics);
  const player = new PlayerController(engine.camera, input, physics);
  const weaponSystem = new WeaponSystem(engine.scene, physics);
  const viewModel = createViewModel(engine.camera);
  const botManager = new BotManager(engine.scene, physics, mapData, weaponSystem);
  botManager.spawnBots(BOT_ROSTER);
  player.weapon = weaponSystem.createWeapon(player);

  const combatants = [player, ...botManager.bots];

  // --- Audio (CC0 Kenney sounds; unlocks on the first user gesture) ---------
  const audio = new AudioManager();
  audio.loadAll(SOUNDS);
  // Enemy/teammate gunfire, attenuated by distance to the player.
  for (const bot of botManager.bots) {
    bot.weapon.onShot = (origin) => {
      const d = origin.distanceTo(player.position);
      audio.play('shootBot', { volume: 0.55 * Math.max(0, 1 - d / 55), jitter: 0.08 });
    };
  }
  /** Footstep cadence while the player moves on the ground. */
  let stepTimer = 0;
  let stepIdx = 0;

  // --- Match state ----------------------------------------------------------
  let state = 'start'; // 'start' | 'playing' | 'paused' | 'gameover'
  const scores = { A: 0, B: 0 };
  let matchTime = 0;
  /** @type {{ combatant: object, t: number }[]} pending respawns */
  const respawns = [];

  for (const c of combatants) {
    c.onDeath = (victim, killerId) => handleDeath(victim, killerId);
    c.onDamaged = (amount, fromId) => handleDamaged(c, amount, fromId);
  }

  // --- Spawning -------------------------------------------------------------
  function randomSpawn(team) {
    const list = mapData.spawnPoints[team];
    const p = list[Math.floor(Math.random() * list.length)];
    // Clone so consumers can never alias the map's canonical spawn vectors.
    return { position: p.clone(), yaw: mapData.spawnYaw[team] };
  }

  function respawnCombatant(c) {
    const spawn = randomSpawn(c.team);
    if (c === player) {
      player.spawnAt(spawn);
      // Fresh mag on respawn (bots get the same inside respawnBot).
      player.weapon.ammo = player.weapon.magSize;
      player.weapon.isReloading = false;
      player.weapon.cooldown = 0;
    } else {
      botManager.respawnBot(c, spawn);
    }
  }

  // --- Combat callbacks -----------------------------------------------------
  function handleDamaged(victim, amount, fromId) {
    if (victim === player) {
      hud.showDamageFlash();
    } else if (fromId === 'player' && victim.alive) {
      // Non-lethal hit by the local player; lethal hits flash red via handleDeath.
      hud.showHitmarker(false);
      audio.play('hit', { volume: 0.45, jitter: 0.05 });
    }
  }

  function handleDeath(victim, killerId) {
    const killer = combatants.find((c) => c.id === killerId) || null;
    const scored = killer && killer.team !== victim.team;
    if (scored) {
      scores[killer.team] += 1;
      hud.setScore(scores.A, scores.B);
    }
    hud.addKillFeed({
      killer: killer ? killer.name : killerId,
      victim: victim.name,
      killerTeam: killer ? killer.team : victim.team,
      victimTeam: victim.team,
    });
    if (killerId === 'player') {
      hud.showHitmarker(true);
      audio.play('hit', { volume: 0.8, rate: 0.7 }); // kill confirm
    }
    if (victim === player) {
      input.rumble(0.6, 0.8, 200);
      audio.play('death', { volume: 0.7 });
    }

    if (scored && scores[killer.team] >= WIN_KILLS) {
      gameOver(killer.team);
      return;
    }
    respawns.push({ combatant: victim, t: RESPAWN_TIME });
  }

  function updateRespawns(dt) {
    for (let i = respawns.length - 1; i >= 0; i--) {
      const r = respawns[i];
      r.t -= dt;
      if (r.combatant === player && r.t > 0) {
        // seconds = remaining time, so the message self-hides at respawn.
        hud.setCenterMessage(`RESPAWN IN ${Math.ceil(r.t)}`, r.t, '');
      }
      if (r.t <= 0) {
        respawns.splice(i, 1);
        respawnCombatant(r.combatant);
      }
    }
  }

  // --- Reset / state transitions --------------------------------------------
  function resetMatch() {
    scores.A = 0;
    scores.B = 0;
    matchTime = 0;
    respawns.length = 0;
    for (const c of combatants) {
      const w = c.weapon;
      if (w) {
        w.ammo = w.magSize;
        w.reserveAmmo = Infinity;
        w.isReloading = false;
        w.cooldown = 0;
      }
      respawnCombatant(c);
    }
    // The HUD exposes no killfeed-clear API; its entries are the only children
    // of #killfeed and self-expire otherwise, so removing them here is safe.
    document.getElementById('killfeed').replaceChildren();
    hud.setScore(0, 0);
    hud.setTimer(0);
    hud.setHealth(player.health);
    hud.setAmmo(player.weapon.ammo, player.weapon.reserveAmmo);
    hud.setReloading(false);
    viewModel.setReloading(false);
    viewModel.setVisible(true);
  }

  function enterPlaying() {
    state = 'playing';
    hud.hideMenu();
    hud.showHUD();
    input.requestPointerLock();
  }

  function pauseGame() {
    state = 'paused';
    input.exitPointerLock();
    hud.showMenu('pause', {
      title: 'PAUSED',
      subtitle: `Score — Blue ${scores.A} : ${scores.B} Red`,
      hint: 'Resume to keep fighting, or Restart for a fresh match.',
      buttons: [
        { id: 'resume', label: 'RESUME' },
        { id: 'restart', label: 'RESTART' },
      ],
    });
  }

  function resumeGame() {
    state = 'playing';
    hud.hideMenu();
    input.requestPointerLock();
  }

  function gameOver(winnerTeam) {
    state = 'gameover';
    respawns.length = 0;
    input.exitPointerLock();
    hud.hideHUD();
    const won = winnerTeam === 'A';
    audio.play(won ? 'win' : 'lose', { volume: 0.8 });
    hud.showMenu('gameover', {
      title: won ? 'BLUE TEAM WINS' : 'RED TEAM WINS',
      subtitle: `Final score — Blue ${scores.A} : ${scores.B} Red`,
      hint: won ? 'Your team dominated the arena.' : 'The enemy team took the arena.',
      buttons: [{ id: 'restart', label: 'PLAY AGAIN' }],
    });
  }

  // --- Input / menu wiring ----------------------------------------------------
  hud.onMenuAction((id) => {
    audio.unlock();
    audio.play('click', { volume: 0.5 });
    if (state === 'start' && id === 'start') {
      resetMatch();
      enterPlaying();
    } else if (state === 'paused' && id === 'resume') {
      resumeGame();
    } else if ((state === 'paused' || state === 'gameover') && id === 'restart') {
      resetMatch();
      enterPlaying();
    }
  });

  // Esc / pointer-lock loss while playing auto-pauses.
  input.onPointerLockLost(() => {
    if (state === 'playing') pauseGame();
  });

  // Recover if a lock request was rejected (e.g. non-gesture activation):
  // clicking the canvas mid-match re-requests it.
  canvas.addEventListener('click', () => {
    audio.unlock();
    if (state === 'playing' && !input.isPointerLocked()) input.requestPointerLock();
  });

  // --- Per-frame gameplay -----------------------------------------------------
  function updatePlayerCombat(dt) {
    const s = input.getState();
    if (player.alive) {
      if (s.fire) {
        const shot = player.weapon.tryFire(
          player.getEyePosition(),
          player.getLookDirection(),
          combatants
        );
        if (shot) {
          viewModel.kick();
          input.rumble(0.25, 0.45, 60);
          audio.play('shoot', { volume: 0.5, jitter: 0.06 });
        }
      }
      if (input.wasPressed('reload')) {
        const wasReloading = player.weapon.isReloading;
        player.weapon.reload();
        if (!wasReloading && player.weapon.isReloading) {
          audio.play('reload', { volume: 0.6 });
        }
      }
    }
    viewModel.setReloading(player.weapon.isReloading);
    viewModel.setVisible(player.alive);
    viewModel.update(dt, player.alive && (s.moveX !== 0 || s.moveZ !== 0));

    // Footsteps: stride cadence scaled by actual ground speed, silent airborne.
    const groundSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    if (player.alive && player.onGround && groundSpeed > 0.5) {
      stepTimer -= dt * (groundSpeed / 5);
      if (stepTimer <= 0) {
        stepTimer = 0.42;
        audio.play(`step${stepIdx}`, { volume: 0.22, jitter: 0.1 });
        stepIdx = (stepIdx + 1) % 4;
      }
    } else {
      stepTimer = 0;
    }
  }

  function syncHud() {
    hud.setHealth(player.health);
    hud.setAmmo(player.weapon.ammo, player.weapon.reserveAmmo);
    hud.setReloading(player.weapon.isReloading);
    hud.setTimer(matchTime);
  }

  // --- Main loop ----------------------------------------------------------------
  let lastTime = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(Math.max((now - lastTime) / 1000, 0), 0.05);
    lastTime = now;

    input.update(dt);

    if (input.wasPressed('pause')) {
      if (state === 'playing') pauseGame();
      else if (state === 'paused') resumeGame();
    }

    if (state === 'playing') {
      matchTime += dt;
      player.update(dt);
      botManager.update(dt, combatants);
      player.weapon.update(dt);
      weaponSystem.update(dt);
      updateRespawns(dt);
      updatePlayerCombat(dt);
      syncHud();
    }

    hud.setGamepadConnected(input.isGamepadConnected());
    hud.update(dt);
    engine.render(dt);
  }

  // --- Boot ----------------------------------------------------------------------
  resetMatch(); // place everyone at spawns behind the start menu
  hud.showMenu('start', {
    title: 'KIMI SHOOTER',
    subtitle:
      'Blue team (you + 2 bots) vs Red team (3 bots) — first to 20 kills wins. ' +
      'WASD move · Mouse look · LMB fire · RMB aim · Space jump · Ctrl crouch · ' +
      'R reload · Shift sprint · Esc pause. Gamepad fully supported (B / R3 crouches).',
    hint: 'Click START, or press Enter / gamepad A.',
    buttons: [{ id: 'start', label: 'START MATCH' }],
  });
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startGame);
} else {
  startGame();
}
