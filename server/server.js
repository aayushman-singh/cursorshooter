/**
 * CURSOR SHOOTER — multiplayer server.
 *
 * Single Node process that:
 *   1. serves the static client (index.html, /js, /css, /assets, /vendor) over HTTP
 *   2. handles WebSocket connections at /ws (JSON text messages, see protocol.md)
 *
 * Authoritative for: rosters/team balance, host assignment, hp, team scores,
 * respawns, win condition. Bots are simulated by the designated "host" client;
 * the server tracks bot hp (seeded from host 'bots' messages) and applies
 * human-hit damage to bots itself.
 *
 * Plain Node ESM, no build step. Only dependency: 'ws'.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8080;

// ---- game rules -----------------------------------------------------------
const MAX_HP = 100;
const HIT_DMG = 25;
const RESPAWN_MS = 3000;
const WIN_SCORE = 20;
const RESTART_MS = 5000;
const RELAY_HZ = 12;
const TEAM_SIZE = 3; // humans + bots per team

// Fixed spawn points (feet positions), mirrored from js/game/map.js.
// Blue = team A (-X end), red = team B (+X end).
const SPAWNS = {
  blue: [[-27, 0, -8], [-27, 0, 8], [-26, 0, 0], [-22, 0, 12]],
  red: [[27, 0, 8], [27, 0, -8], [26, 0, 0], [22, 0, -12]],
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---- match state ----------------------------------------------------------
/** @type {Map<string, {ws: import('ws').WebSocket, name: string, team: 'blue'|'red'|null, hp: number, alive: boolean, state: object|null, respawnTimer: NodeJS.Timeout|null}>} */
const players = new Map();
/** Bot state, seeded/updated from host 'bots' messages. id -> {team, p, yaw, hp, alive} */
const bots = new Map();
const score = { blue: 0, red: 0 };
let hostId = null;
let matchOver = false;
let nextPlayerNum = 1;

// ---- helpers --------------------------------------------------------------
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function teamCounts() {
  let blue = 0, red = 0;
  for (const p of players.values()) {
    if (p.team === 'blue') blue++;
    else if (p.team === 'red') red++;
  }
  return { blue, red };
}

function roster() {
  return [...players.entries()]
    .filter(([, p]) => p.team !== null) // connected but not yet joined
    .map(([id, p]) => ({ id, name: p.name, team: p.team }));
}

function spawnPoint(team) {
  const list = SPAWNS[team];
  return list[Math.floor(Math.random() * list.length)];
}

/** Team of any combatant id: player roster lookup, else bot id prefix. */
function teamOf(id) {
  const p = players.get(id);
  if (p) return p.team; // null until that player sends 'join'
  if (typeof id === 'string') {
    if (id.startsWith('bot-blue-')) return 'blue';
    if (id.startsWith('bot-red-')) return 'red';
  }
  return null;
}

/** Bots fill each team up to TEAM_SIZE total members; host simulates them. */
function sendBotConfig() {
  const host = hostId && players.get(hostId);
  if (!host) return;
  const { blue, red } = teamCounts();
  send(host.ws, {
    t: 'botConfig',
    blue: Math.max(0, TEAM_SIZE - blue),
    red: Math.max(0, TEAM_SIZE - red),
  });
}

function pickHost() {
  hostId = players.size ? players.keys().next().value : null;
  if (hostId) broadcast({ t: 'hostUpdate', host: hostId });
}

function checkWin() {
  if (matchOver) return;
  const winner = score.blue >= WIN_SCORE ? 'blue' : score.red >= WIN_SCORE ? 'red' : null;
  if (!winner) return;
  matchOver = true;
  broadcast({ t: 'end', winner, score: { ...score } });
  setTimeout(() => {
    score.blue = 0;
    score.red = 0;
    matchOver = false;
    for (const [id, p] of players) {
      if (p.respawnTimer) { clearTimeout(p.respawnTimer); p.respawnTimer = null; }
      p.hp = MAX_HP;
      p.alive = true;
      broadcast({ t: 'hp', id, hp: p.hp });
    }
    broadcast({ t: 'restart', score: { ...score } });
  }, RESTART_MS);
}

function killPlayer(victimId, victim, killerId) {
  victim.alive = false;
  victim.hp = 0;
  const killerTeam = teamOf(killerId);
  if (killerTeam && killerTeam !== victim.team) score[killerTeam]++;
  broadcast({
    t: 'dead',
    victim: victimId,
    killer: killerId,
    victimTeam: victim.team,
    killerTeam,
  });
  broadcast({ t: 'hp', id: victimId, hp: 0 });
  checkWin();
  victim.respawnTimer = setTimeout(() => {
    victim.respawnTimer = null;
    if (!players.has(victimId) || matchOver) return;
    victim.hp = MAX_HP;
    victim.alive = true;
    broadcast({ t: 'hp', id: victimId, hp: victim.hp });
    broadcast({ t: 'respawn', id: victimId, p: spawnPoint(victim.team) });
  }, RESPAWN_MS);
}

function applyDamage(shooterId, msg) {
  if (matchOver) return;
  const target = msg.target;
  if (typeof target !== 'string' || !target) return;
  // Bot-originated hit (host claims a bot shot a human).
  const shooterTeam = msg.from ? teamOf(msg.from) : teamOf(shooterId);
  const targetTeam = teamOf(target);
  if (!shooterTeam || !targetTeam) return;
  if (shooterTeam === targetTeam) return; // friendly fire ignored
  // Clamp: one hit can never do more than the rifle's 25 dmg.
  let dmg = Number(msg.dmg);
  if (!Number.isFinite(dmg) || dmg <= 0) return;
  dmg = Math.min(dmg, HIT_DMG);
  const killerId = msg.from || shooterId;

  const victimPlayer = players.get(target);
  if (victimPlayer) {
    if (!victimPlayer.alive) return;
    victimPlayer.hp = Math.max(0, victimPlayer.hp - dmg);
    if (victimPlayer.hp <= 0) {
      killPlayer(target, victimPlayer, killerId);
    } else {
      broadcast({ t: 'hp', id: target, hp: victimPlayer.hp });
    }
    return;
  }

  const bot = bots.get(target);
  if (bot && bot.alive) {
    bot.hp = Math.max(0, bot.hp - dmg);
    if (bot.hp <= 0) {
      bot.alive = false;
      if (shooterTeam !== bot.team) score[shooterTeam]++;
      broadcast({ t: 'dead', victim: target, killer: killerId, victimTeam: bot.team, killerTeam: shooterTeam });
      broadcast({ t: 'hp', id: target, hp: 0 });
      checkWin();
      // Host respawns the bot after 3s and re-includes it (alive:true, full hp).
    } else {
      broadcast({ t: 'hp', id: target, hp: bot.hp });
    }
  }
}

// ---- websocket message handling -------------------------------------------
const handlers = {
  join(ws, id, msg) {
    const p = players.get(id);
    p.name = String(msg.name || id).slice(0, 24);
    const { blue, red } = teamCounts();
    p.team = blue <= red ? 'blue' : 'red';
    send(ws, {
      t: 'welcome',
      id,
      team: p.team,
      host: id === hostId,
      players: roster(),
      score: { ...score },
    });
    broadcast({ t: 'playerJoin', player: { id, name: p.name, team: p.team } }, id);
    sendBotConfig();
  },

  state(ws, id, msg) {
    const p = players.get(id);
    if (!Array.isArray(msg.p) || msg.p.length !== 3) return;
    p.state = {
      id,
      p: msg.p.map(Number),
      yaw: Number(msg.yaw) || 0,
      pitch: Number(msg.pitch) || 0,
      crouch: !!msg.crouch,
      firing: !!msg.firing,
    };
  },

  shoot(ws, id) {
    broadcast({ t: 'shoot', id }, id);
  },

  hit(ws, id, msg) {
    applyDamage(id, msg);
  },

  bots(ws, id, msg) {
    if (id !== hostId || !Array.isArray(msg.bots)) return;
    for (const b of msg.bots) {
      if (!b || typeof b.id !== 'string') continue;
      const prev = bots.get(b.id);
      const alive = b.alive !== false;
      // Server owns bot hp: full hp on first sighting or host respawn
      // (dead -> alive), otherwise keep the server-computed value (human
      // hits are already decremented here; the host's copy lags behind).
      const hp = !prev || (alive && !prev.alive) ? MAX_HP : prev.hp;
      if (alive && prev && !prev.alive) broadcast({ t: 'hp', id: b.id, hp });
      bots.set(b.id, {
        team: teamOf(b.id),
        p: Array.isArray(b.p) ? b.p.map(Number) : [0, 0, 0],
        yaw: Number(b.yaw) || 0,
        hp,
        alive,
      });
    }
    // Relay verbatim to all non-host clients.
    broadcast({ t: 'bots', bots: msg.bots }, id);
  },
};

// ---- http + ws wiring -----------------------------------------------------
const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const id = `p${nextPlayerNum++}`;
  players.set(id, { ws, name: id, team: null, hp: MAX_HP, alive: true, state: null, respawnTimer: null });
  if (!hostId) {
    hostId = id;
    broadcast({ t: 'hostUpdate', host: hostId });
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // malformed JSON: ignore
    }
    if (!msg || typeof msg.t !== 'string') return;
    const handler = handlers[msg.t];
    if (handler) {
      try {
        handler(ws, id, msg);
      } catch (err) {
        console.error(`handler error (${msg.t}, ${id}):`, err);
      }
    }
  });

  ws.on('close', () => {
    const p = players.get(id);
    if (!p) return;
    if (p.respawnTimer) clearTimeout(p.respawnTimer);
    players.delete(id);
    broadcast({ t: 'playerLeave', id });
    if (id === hostId) {
      hostId = null;
      bots.clear(); // bot simulation moves to the new host
      pickHost();
    }
    sendBotConfig();
  });

  ws.on('error', () => ws.close());
});

// ~12Hz state relay: each player gets everyone else's latest state.
setInterval(() => {
  for (const [id, p] of players) {
    if (!p.ws || p.ws.readyState !== p.ws.OPEN) continue;
    const others = [];
    for (const [oid, op] of players) {
      if (oid !== id && op.state) others.push(op.state);
    }
    send(p.ws, { t: 'states', players: others });
  }
}, 1000 / RELAY_HZ);

server.listen(PORT, () => {
  console.log(`cursor-shooter server listening on :${PORT} (static + /ws)`);
});
