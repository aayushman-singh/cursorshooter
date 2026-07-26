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
import { NetClient, teamToLocal, teamToProtocol, roomFromQuery } from './net/net.js';
import { RemoteManager, prettifyBotId } from './net/remotes.js';

/** Kills needed to win the match (ARCHITECTURE.md: first to 20). */
const WIN_KILLS = 20;
/** Seconds before a dead combatant respawns. */
const RESPAWN_TIME = 3;
/** Network send rate for state/bot streams (Hz). */
const NET_HZ = 12;
/** Offline bot roster: Alpha/Bravo on team A with the player, Viper/Rogue/Havoc on B. */
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

/** Round to 2 decimals to keep state/bot payloads small. */
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Bootstrap + match orchestration (see ARCHITECTURE.md "Match flow"), now with
 * two modes:
 *
 * - OFFLINE (original): player + 2 bot teammates vs 3 enemy bots, all damage
 *   and scoring applied locally, first to 20 wins.
 * - ONLINE (FIND MATCH): NetClient connects to ws(s)://<host>/ws. The local
 *   player still simulates its own physics and streams {t:'state'} ~12Hz;
 *   remote players render via RemoteManager from {t:'states'}; all damage is
 *   claimed with {t:'hit'} and applied authoritatively by the server
 *   ({t:'hp'}/{t:'dead'}/{t:'respawn'} drive HUD/death/respawn). The host
 *   client runs the BotManager AI for the server's botConfig and streams
 *   {t:'bots'} ~12Hz; non-host clients render bots from the relay instead.
 *   Scores/end/restart come from the server. If the connect fails, the menu
 *   shows an error and PLAY OFFLINE still works exactly like the original.
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
  const remotes = new RemoteManager(engine.scene);
  player.weapon = weaponSystem.createWeapon(player);

  // --- Audio (CC0 Kenney sounds; unlocks on the first user gesture) ---------
  const audio = new AudioManager();
  audio.loadAll(SOUNDS);
  /** Footstep cadence while the player moves on the ground. */
  let stepTimer = 0;
  let stepIdx = 0;

  // --- Match state ----------------------------------------------------------
  let state = 'start'; // 'start' | 'playing' | 'paused' | 'gameover'
  const scores = { A: 0, B: 0 }; // online: A = blue, B = red
  let matchTime = 0;
  /** @type {{ combatant: object, t: number }[]} pending respawns (offline) */
  const respawns = [];
  /** @type {{ bot: object, t: number }[]} host-side bot respawns (online) */
  const botRespawns = [];
  /** Online self-death countdown (display only; the server respawns us). */
  let selfRespawnTimer = 0;

  // --- Network state --------------------------------------------------------
  let mode = 'offline'; // 'offline' | 'online'
  /** @type {NetClient|null} */
  let net = null;
  let isHost = true; // offline: we simulate all bots
  let botConfig = null; // last { blue, red } from the server
  let roomId = ''; // normalized room from welcome ('' = offline)
  let roomBots = true; // the room's actual bot setting (welcome.bots)
  let connecting = false;
  let netTimer = 0; // 12Hz stream accumulator

  /** Everyone the local raycast/AI can hit: player + local bots + remote proxies. */
  function getCombatants() {
    return [player, ...botManager.bots, ...remotes.combatants];
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
      respawnPlayerLocal();
    } else {
      botManager.respawnBot(c, spawn);
    }
  }

  /** Local player at a fresh own-team spawn with a fresh mag. */
  function respawnPlayerLocal() {
    player.spawnAt(randomSpawn(player.team));
    player.weapon.ammo = player.weapon.magSize;
    player.weapon.isReloading = false;
    player.weapon.cooldown = 0;
  }

  // --- Combatant wiring -------------------------------------------------------
  function assignCombatantHandlers(c) {
    c.onDeath = (victim, killerId) => {
      if (mode === 'offline') handleDeath(victim, killerId);
    };
    c.onDamaged = (amount, fromId) => {
      if (mode === 'offline') handleDamaged(c, amount, fromId);
    };
  }

  /** Enemy/teammate gunfire, attenuated by distance to the player. */
  function hookBotWeapon(bot) {
    bot.weapon.onShot = (origin) => {
      const d = origin.distanceTo(player.position);
      audio.play('shootBot', { volume: 0.55 * Math.max(0, 1 - d / 55), jitter: 0.08 });
      // Bot tracers stay local: the server's {t:'shoot'} relay always carries
      // the sender's player id, so relayed bot shots would render at the host.
    };
  }

  /**
   * Online: the server applies all damage authoritatively, so a local raycast
   * hit becomes a hit CLAIM instead of local health loss. fromId is the
   * shooter: the local player (plain claim) or a host bot (from: botId).
   */
  function shimOnlineDamage(c) {
    c.applyDamage = (amount, fromId) => {
      if (!c.alive || !net) return;
      net.sendHit(c.id, amount, fromId === player.id ? undefined : fromId);
      if (fromId === player.id) {
        // Non-lethal feedback now; lethal flashes red via the {t:'dead'} broadcast.
        hud.showHitmarker(false);
        audio.play('hit', { volume: 0.45, jitter: 0.05 });
      }
    };
  }

  function prepareOfflineBots() {
    for (const bot of botManager.bots) {
      assignCombatantHandlers(bot);
      hookBotWeapon(bot);
    }
  }

  // --- Combat callbacks (offline scoring; online comes from the server) ------
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
    const killer = getCombatants().find((c) => c.id === killerId) || null;
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
    // Offline respawns (original behavior).
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
    // Online host: respawn server-killed bots after 3s (streamed via {t:'bots'}).
    for (let i = botRespawns.length - 1; i >= 0; i--) {
      const r = botRespawns[i];
      r.t -= dt;
      if (r.t <= 0) {
        botRespawns.splice(i, 1);
        botManager.respawnBot(r.bot, randomSpawn(r.bot.team));
      }
    }
    // Online self: countdown until the server's {t:'respawn'} arrives.
    if (selfRespawnTimer > 0) {
      selfRespawnTimer -= dt;
      if (!player.alive && selfRespawnTimer > 0) {
        hud.setCenterMessage(`RESPAWN IN ${Math.ceil(selfRespawnTimer)}`, selfRespawnTimer, '');
      }
    }
  }

  // --- Network: handlers ------------------------------------------------------
  /** Display name for killfeed: roster → local bots → proxies → prettified id. */
  function displayName(id) {
    if (!id) return '?';
    if (id === player.id) return player.name;
    if (net) {
      const info = net.players.get(id);
      if (info) return info.name;
    }
    const bot = botManager.bots.find((b) => b.id === id);
    if (bot) return bot.name;
    const proxy = remotes.get(id);
    if (proxy) return proxy.name;
    return prettifyBotId(id);
  }

  function addRemotePlayer(p) {
    const proxy = remotes.addPlayer({
      id: p.id,
      name: p.name || 'Player',
      team: teamToLocal(p.team),
    });
    shimOnlineDamage(proxy);
  }

  /** Host: spawn/remove bots so each team fills to 3 members (server botConfig).
   *  Rooms created with bots off always get an empty roster. */
  function applyBotConfig(cfg) {
    if (!roomBots) cfg = { blue: 0, red: 0 };
    const roster = [];
    for (let i = 0; i < (cfg.blue || 0); i++) {
      roster.push({ id: `bot-blue-${i}`, name: `Blue Bot ${i}`, team: 'A' });
    }
    for (let i = 0; i < (cfg.red || 0); i++) {
      roster.push({ id: `bot-red-${i}`, name: `Red Bot ${i}`, team: 'B' });
    }
    botManager.syncRoster(roster);
    for (const bot of botManager.bots) {
      if (!bot._netReady) {
        bot._netReady = true;
        assignCombatantHandlers(bot);
        hookBotWeapon(bot);
        shimOnlineDamage(bot);
      }
    }
  }

  function handleRemoteShoot(id) {
    if (!id || id === player.id) return;
    const m = remotes.getMuzzle(id);
    if (!m) return;
    weaponSystem.spawnRemoteShot(m.origin, m.dir);
    const d = m.origin.distanceTo(player.position);
    audio.play('shootBot', { volume: 0.55 * Math.max(0, 1 - d / 55), jitter: 0.08 });
  }

  function onHp(msg) {
    if (msg.id === player.id) {
      if (msg.hp < player.health) hud.showDamageFlash();
      player.health = msg.hp;
      return;
    }
    // Host reconciles its local bot state from server-authoritative hp.
    const bot = botManager.bots.find((b) => b.id === msg.id);
    if (bot) {
      bot.health = msg.hp;
      return;
    }
    remotes.setHp(msg.id, msg.hp);
  }

  function onDead(msg) {
    const killerTeam = teamToLocal(msg.killerTeam);
    const victimTeam = teamToLocal(msg.victimTeam);
    if (killerTeam !== victimTeam) {
      scores[killerTeam] += 1;
      hud.setScore(scores.A, scores.B);
    }
    hud.addKillFeed({
      killer: displayName(msg.killer),
      victim: displayName(msg.victim),
      killerTeam,
      victimTeam,
    });
    if (msg.killer === player.id) {
      hud.showHitmarker(true);
      audio.play('hit', { volume: 0.8, rate: 0.7 }); // kill confirm
    }
    if (msg.victim === player.id) {
      player.alive = false;
      player.health = 0;
      player.velocity.set(0, 0, 0);
      selfRespawnTimer = RESPAWN_TIME;
      input.rumble(0.6, 0.8, 200);
      audio.play('death', { volume: 0.7 });
      return;
    }
    const bot = isHost ? botManager.bots.find((b) => b.id === msg.victim) : null;
    if (bot) {
      bot.alive = false;
      bot.health = 0;
      bot.velocity.set(0, 0, 0);
      bot.mesh.visible = false;
      botRespawns.push({ bot, t: RESPAWN_TIME });
      return;
    }
    remotes.markDead(msg.victim);
  }

  function onRespawn(msg) {
    if (msg.id === player.id) {
      selfRespawnTimer = 0;
      hud.setCenterMessage('');
      const p = msg.p || [0, 0, 0];
      player.spawnAt({
        position: new THREE.Vector3(p[0], p[1], p[2]),
        yaw: mapData.spawnYaw[player.team],
      });
      player.weapon.ammo = player.weapon.magSize;
      player.weapon.isReloading = false;
      player.weapon.cooldown = 0;
    } else {
      remotes.markAlive(msg.id);
    }
  }

  function onEnd(msg) {
    state = 'gameover';
    botRespawns.length = 0;
    selfRespawnTimer = 0;
    if (msg.score) {
      scores.A = msg.score.blue;
      scores.B = msg.score.red;
    }
    hud.setScore(scores.A, scores.B);
    input.exitPointerLock();
    hud.hideHUD();
    const won = teamToLocal(msg.winner) === player.team;
    audio.play(won ? 'win' : 'lose', { volume: 0.8 });
    hud.showMenu('gameover', {
      title: msg.winner === 'blue' ? 'BLUE TEAM WINS' : 'RED TEAM WINS',
      subtitle: `Final score — Blue ${scores.A} : ${scores.B} Red`,
      hint:
        (won ? 'Your team dominated the arena.' : 'The enemy team took the arena.') +
        '\nNext match starts shortly…',
      buttons: [{ id: 'leave', label: 'LEAVE MATCH' }],
    });
  }

  function onRestart(msg) {
    scores.A = msg.score ? msg.score.blue : 0;
    scores.B = msg.score ? msg.score.red : 0;
    matchTime = 0;
    respawns.length = 0;
    botRespawns.length = 0;
    selfRespawnTimer = 0;
    // The HUD exposes no killfeed-clear API; its entries are the only children
    // of #killfeed and self-expire otherwise, so removing them here is safe.
    document.getElementById('killfeed').replaceChildren();
    hud.setScore(scores.A, scores.B);
    hud.setTimer(0);
    hud.setCenterMessage('');
    respawnPlayerLocal();
    if (isHost) {
      for (const bot of botManager.bots) botManager.respawnBot(bot, randomSpawn(bot.team));
    }
    remotes.resetAll();
    hud.hideMenu();
    hud.showHUD();
    viewModel.setReloading(false);
    viewModel.setVisible(true);
    state = 'playing';
    input.requestPointerLock();
  }

  function wireNet(client) {
    client.on('playerJoin', (msg) => addRemotePlayer(msg.player));
    client.on('playerLeave', (msg) => remotes.removePlayer(msg.id));
    client.on('hostUpdate', (msg) => {
      isHost = msg.host === player.id;
      if (isHost) {
        // We simulate now: drop the relayed bot proxies and apply the config.
        remotes.clearBots();
        if (botConfig) applyBotConfig(botConfig);
      }
    });
    client.on('botConfig', (msg) => {
      botConfig = { blue: msg.blue || 0, red: msg.red || 0 };
      if (isHost) applyBotConfig(botConfig);
    });
    client.on('states', (msg) => remotes.applyStates(msg.players));
    client.on('bots', (msg) => {
      if (!isHost) remotes.applyBots(msg.bots);
    });
    client.on('shoot', (msg) => handleRemoteShoot(msg.id));
    client.on('hp', onHp);
    client.on('dead', onDead);
    client.on('respawn', onRespawn);
    client.on('end', onEnd);
    client.on('restart', onRestart);
    client.on('close', () => {
      if (net === client) leaveToMenu('Connection lost.');
    });
  }

  // --- Network: streams (~12Hz while the world runs) ---------------------------
  function updateNetStreams(dt) {
    if (mode !== 'online' || !net) return;
    netTimer -= dt;
    if (netTimer > 0) return;
    netTimer = 1 / NET_HZ;

    const s = input.getState();
    net.sendState(
      [r2(player.position.x), r2(player.position.y), r2(player.position.z)],
      Math.round(player.yaw * 1000) / 1000,
      Math.round(player.pitch * 1000) / 1000,
      player.height < 1.4, // crouched (capsule below the stand/crouch midpoint)
      player.alive && s.fire
    );

    if (isHost) {
      net.sendBots(
        botManager.bots.map((b) => ({
          id: b.id,
          team: teamToProtocol(b.team),
          p: [r2(b.position.x), r2(b.position.y), r2(b.position.z)],
          yaw: Math.round(b.yaw * 1000) / 1000,
          hp: b.health,
          alive: b.alive,
        }))
      );
    }
  }

  // --- Network: connect / teardown ---------------------------------------------
  function setupOnline(client, welcome, name) {
    net = client;
    mode = 'online';
    player.id = welcome.id;
    player.name = name;
    player.team = teamToLocal(welcome.team);
    shimOnlineDamage(player);
    isHost = !!welcome.host;
    roomId = welcome.room || 'LOBBY';
    roomBots = welcome.bots !== false; // trust the room's setting, not our request
    scores.A = welcome.score ? welcome.score.blue : 0;
    scores.B = welcome.score ? welcome.score.red : 0;
    matchTime = 0;
    respawns.length = 0;
    botRespawns.length = 0;
    selfRespawnTimer = 0;
    botConfig = null;
    botManager.despawnBots(); // offline menu-preview bots go away
    remotes.clearAll();
    for (const p of welcome.players || []) {
      if (p.id !== player.id) addRemotePlayer(p);
    }
    document.getElementById('killfeed').replaceChildren();
    hud.setScore(scores.A, scores.B);
    hud.setTimer(0);
    respawnPlayerLocal();
    hud.setHealth(player.health);
    hud.setAmmo(player.weapon.ammo, player.weapon.reserveAmmo);
    hud.setReloading(false);
    hud.setMenuError('');
    hud.setRoom(roomId);
    enterPlaying();
  }

  async function findMatch() {
    if (connecting) return;
    connecting = true;
    const name = hud.getPlayerName();
    const room = hud.getRoomCode();
    const bots = hud.getBotsEnabled();
    hud.setMenuError('Connecting…');
    const client = new NetClient();
    // Wire handlers BEFORE the welcome resolves so a botConfig/playerJoin
    // flushed immediately after welcome can never be missed.
    wireNet(client);
    try {
      const welcome = await client.connect(name, { room, bots });
      setupOnline(client, welcome, name);
    } catch {
      client.close();
      hud.setMenuError('No server found — try PLAY OFFLINE vs bots.');
    }
    connecting = false;
  }

  /** Drop back to the offline start menu (LEAVE MATCH / connection lost). */
  function leaveToMenu(errorMsg) {
    if (net) {
      const client = net;
      net = null; // null first so the async 'close' event is ignored
      client.close();
    }
    mode = 'offline';
    isHost = true;
    botConfig = null;
    roomId = '';
    roomBots = true;
    remotes.clearAll();
    delete player.applyDamage; // drop the shim, restoring the prototype method
    player.id = 'player';
    player.name = 'You';
    player.team = 'A';
    state = 'start';
    botManager.spawnBots(BOT_ROSTER); // fresh, unshimmed offline preview bots
    prepareOfflineBots();
    resetMatch();
    hud.hideHUD();
    hud.setRoom('');
    hud.showMenu('start', startMenuData());
    hud.setMenuError(errorMsg || '');
  }

  // --- Reset / state transitions --------------------------------------------
  function startMenuData() {
    return {
      title: 'CURSOR SHOOTER',
      subtitle:
        'Online 3v3 — first to 20 kills wins, bots fill empty slots.\n' +
        'WASD move · Mouse look · LMB fire · RMB aim · Space jump · Ctrl crouch · ' +
        'R reload · Shift sprint · Esc pause. Gamepad fully supported (B / R3 crouches).',
      hint: 'Pick a callsign and FIND MATCH, or PLAY OFFLINE vs bots.',
      buttons: [
        { id: 'find', label: 'FIND MATCH' },
        { id: 'offline', label: 'PLAY OFFLINE' },
      ],
    };
  }

  function resetMatch() {
    scores.A = 0;
    scores.B = 0;
    matchTime = 0;
    respawns.length = 0;
    botRespawns.length = 0;
    selfRespawnTimer = 0;
    for (const c of getCombatants()) {
      const w = c.weapon;
      if (w) {
        w.ammo = w.magSize;
        w.reserveAmmo = Infinity;
        w.isReloading = false;
        w.cooldown = 0;
      }
      respawnCombatant(c);
    }
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
    if (mode === 'online') {
      const where = roomId && roomId !== 'LOBBY' ? `Room ${roomId}` : 'Public lobby';
      hud.showMenu('pause', {
        title: 'PAUSED',
        subtitle: `${where} · Score — Blue ${scores.A} : ${scores.B} Red`,
        hint: 'The match goes on without you — resume to keep fighting.',
        buttons: [
          { id: 'resume', label: 'RESUME' },
          { id: 'leave', label: 'LEAVE MATCH' },
        ],
      });
    } else {
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
    if (state === 'start' && id === 'find') {
      findMatch();
    } else if (state === 'start' && id === 'offline') {
      resetMatch();
      enterPlaying();
    } else if (state === 'paused' && id === 'resume') {
      resumeGame();
    } else if (id === 'leave' && mode === 'online') {
      leaveToMenu();
    } else if (mode === 'offline' && (state === 'paused' || state === 'gameover') && id === 'restart') {
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
          getCombatants()
        );
        if (shot) {
          viewModel.kick();
          input.rumble(0.25, 0.45, 60);
          audio.play('shoot', { volume: 0.5, jitter: 0.06 });
          if (mode === 'online' && net) net.sendShoot();
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
      player.weapon.update(dt);
      updatePlayerCombat(dt);
      syncHud();
    }

    // World simulation: full speed while playing; online the world keeps
    // running behind the pause/gameover menus (remote players don't freeze).
    if (state === 'playing' || (mode === 'online' && state !== 'start')) {
      const combatants = getCombatants();
      if (isHost) botManager.update(dt, combatants);
      weaponSystem.update(dt);
      remotes.update(dt);
      updateRespawns(dt);
      updateNetStreams(dt);
    }

    hud.setGamepadConnected(input.isGamepadConnected());
    hud.update(dt);
    engine.render(dt);
  }

  // --- Boot ----------------------------------------------------------------------
  botManager.spawnBots(BOT_ROSTER); // menu-preview bots (also the offline roster)
  prepareOfflineBots();
  assignCombatantHandlers(player);
  resetMatch(); // place everyone at spawns behind the start menu
  hud.setRoomCode(roomFromQuery()); // ?room=CODE prefill (shareable links)
  hud.showMenu('start', startMenuData());
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startGame);
} else {
  startGame();
}
