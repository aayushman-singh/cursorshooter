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
 * All match state is PER-ROOM: a join names a room (normalized to uppercase
 * [A-Z0-9], max 8 chars, default 'LOBBY'); the first join creates the room and
 * its `bots` flag becomes the room's permanent setting; the room is destroyed
 * when its last player leaves. Rooms are fully independent matches.
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
const DEFAULT_ROOM = 'LOBBY';

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

// ---- state ----------------------------------------------------------------
/** All connected players, joined or not.
 * @type {Map<string, {ws: import('ws').WebSocket, name: string, room: object|null, team: 'blue'|'red'|null, hp: number, alive: boolean, state: object|null, respawnTimer: NodeJS.Timeout|null}>} */
const players = new Map();
/** @type {Map<string, {id: string, botsEnabled: boolean, players: Map<string, object>, bots: Map<string, object>, score: {blue: number, red: number}, hostId: string|null, matchOver: boolean, restartTimer: NodeJS.Timeout|null}>} */
const rooms = new Map();
let nextPlayerNum = 1;

function normalizeRoom(raw) {
  if (typeof raw !== 'string') return DEFAULT_ROOM;
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return clean || DEFAULT_ROOM;
}

function createRoom(id, botsEnabled) {
  const room = {
    id,
    botsEnabled,
    players: new Map(), // id -> player (same objects as the global map)
    bots: new Map(),    // bot id -> {team, p, yaw, hp, alive}
    score: { blue: 0, red: 0 },
    hostId: null,
    matchOver: false,
    restartTimer: null,
  };
  rooms.set(id, room);
  return room;
}

function destroyRoom(room) {
  if (room.restartTimer) clearTimeout(room.restartTimer);
  for (const p of room.players.values()) {
    if (p.respawnTimer) clearTimeout(p.respawnTimer);
  }
  rooms.delete(room.id);
}

// ---- helpers (all room-scoped) --------------------------------------------
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const [id, p] of room.players) {
    if (id !== exceptId && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function teamCounts(room) {
  let blue = 0, red = 0;
  for (const p of room.players.values()) {
    if (p.team === 'blue') blue++;
    else if (p.team === 'red') red++;
  }
  return { blue, red };
}

function roster(room) {
  return [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, team: p.team }));
}

function spawnPoint(team) {
  const list = SPAWNS[team];
  return list[Math.floor(Math.random() * list.length)];
}

/** Team of any combatant id within a room: roster lookup, else bot id prefix. */
function teamOf(room, id) {
  const p = room.players.get(id);
  if (p) return p.team;
  if (typeof id === 'string') {
    if (id.startsWith('bot-blue-')) return 'blue';
    if (id.startsWith('bot-red-')) return 'red';
  }
  return null;
}

/** Bots fill each team up to TEAM_SIZE total members (unless the room's
 *  creator disabled bots); host simulates them. */
function sendBotConfig(room) {
  const host = room.hostId && room.players.get(room.hostId);
  if (!host) return;
  const { blue, red } = teamCounts(room);
  send(host.ws, {
    t: 'botConfig',
    blue: room.botsEnabled ? Math.max(0, TEAM_SIZE - blue) : 0,
    red: room.botsEnabled ? Math.max(0, TEAM_SIZE - red) : 0,
  });
}

function pickHost(room) {
  room.hostId = room.players.size ? room.players.keys().next().value : null;
  if (room.hostId) broadcast(room, { t: 'hostUpdate', host: room.hostId });
}

function checkWin(room) {
  if (room.matchOver) return;
  const winner = room.score.blue >= WIN_SCORE ? 'blue' : room.score.red >= WIN_SCORE ? 'red' : null;
  if (!winner) return;
  room.matchOver = true;
  broadcast(room, { t: 'end', winner, score: { ...room.score } });
  room.restartTimer = setTimeout(() => {
    room.restartTimer = null;
    if (!rooms.has(room.id)) return; // room died while waiting
    room.score.blue = 0;
    room.score.red = 0;
    room.matchOver = false;
    for (const [id, p] of room.players) {
      if (p.respawnTimer) { clearTimeout(p.respawnTimer); p.respawnTimer = null; }
      p.hp = MAX_HP;
      p.alive = true;
      broadcast(room, { t: 'hp', id, hp: p.hp });
    }
    broadcast(room, { t: 'restart', score: { ...room.score } });
  }, RESTART_MS);
}

function killPlayer(room, victimId, victim, killerId) {
  victim.alive = false;
  victim.hp = 0;
  const killerTeam = teamOf(room, killerId);
  if (killerTeam && killerTeam !== victim.team) room.score[killerTeam]++;
  broadcast(room, {
    t: 'dead',
    victim: victimId,
    killer: killerId,
    victimTeam: victim.team,
    killerTeam,
  });
  broadcast(room, { t: 'hp', id: victimId, hp: 0 });
  checkWin(room);
  victim.respawnTimer = setTimeout(() => {
    victim.respawnTimer = null;
    if (room.players.get(victimId) !== victim || room.matchOver) return;
    victim.hp = MAX_HP;
    victim.alive = true;
    broadcast(room, { t: 'hp', id: victimId, hp: victim.hp });
    broadcast(room, { t: 'respawn', id: victimId, p: spawnPoint(victim.team) });
  }, RESPAWN_MS);
}

function applyDamage(room, shooterId, msg) {
  if (room.matchOver) return;
  const target = msg.target;
  if (typeof target !== 'string' || !target) return;
  // Bot-originated hit (host claims a bot shot a human).
  const shooterTeam = msg.from ? teamOf(room, msg.from) : teamOf(room, shooterId);
  const targetTeam = teamOf(room, target);
  if (!shooterTeam || !targetTeam) return;
  if (shooterTeam === targetTeam) return; // friendly fire ignored
  // Clamp: one hit can never do more than the rifle's 25 dmg.
  let dmg = Number(msg.dmg);
  if (!Number.isFinite(dmg) || dmg <= 0) return;
  dmg = Math.min(dmg, HIT_DMG);
  const killerId = msg.from || shooterId;

  const victimPlayer = room.players.get(target);
  if (victimPlayer) {
    if (!victimPlayer.alive) return;
    victimPlayer.hp = Math.max(0, victimPlayer.hp - dmg);
    if (victimPlayer.hp <= 0) {
      killPlayer(room, target, victimPlayer, killerId);
    } else {
      broadcast(room, { t: 'hp', id: target, hp: victimPlayer.hp });
    }
    return;
  }

  const bot = room.bots.get(target);
  if (bot && bot.alive) {
    bot.hp = Math.max(0, bot.hp - dmg);
    if (bot.hp <= 0) {
      bot.alive = false;
      if (shooterTeam !== bot.team) room.score[shooterTeam]++;
      broadcast(room, { t: 'dead', victim: target, killer: killerId, victimTeam: bot.team, killerTeam: shooterTeam });
      broadcast(room, { t: 'hp', id: target, hp: 0 });
      checkWin(room);
      // Host respawns the bot after 3s and re-includes it (alive:true, full hp).
    } else {
      broadcast(room, { t: 'hp', id: target, hp: bot.hp });
    }
  }
}

// ---- websocket message handling -------------------------------------------
const handlers = {
  join(ws, id, msg) {
    const p = players.get(id);
    if (p.room) return; // already joined; one room per connection
    const roomId = normalizeRoom(msg.room);
    const room = rooms.get(roomId) || createRoom(roomId, msg.bots !== false);
    p.name = String(msg.name || id).slice(0, 24);
    p.room = room;
    room.players.set(id, p);
    if (!room.hostId) {
      room.hostId = id;
      broadcast(room, { t: 'hostUpdate', host: id });
    }
    const { blue, red } = teamCounts(room);
    p.team = blue <= red ? 'blue' : 'red'; // joining player not yet counted
    send(ws, {
      t: 'welcome',
      id,
      team: p.team,
      host: id === room.hostId,
      room: room.id,
      bots: room.botsEnabled,
      players: roster(room),
      score: { ...room.score },
    });
    broadcast(room, { t: 'playerJoin', player: { id, name: p.name, team: p.team } }, id);
    sendBotConfig(room);
  },

  state(ws, id, msg) {
    const p = players.get(id);
    if (!p.room || !Array.isArray(msg.p) || msg.p.length !== 3) return;
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
    const p = players.get(id);
    if (!p.room) return;
    broadcast(p.room, { t: 'shoot', id }, id);
  },

  hit(ws, id, msg) {
    const p = players.get(id);
    if (!p.room) return;
    applyDamage(p.room, id, msg);
  },

  bots(ws, id, msg) {
    const p = players.get(id);
    const room = p.room;
    if (!room || id !== room.hostId || !Array.isArray(msg.bots)) return;
    for (const b of msg.bots) {
      if (!b || typeof b.id !== 'string') continue;
      const prev = room.bots.get(b.id);
      const alive = b.alive !== false;
      // Server owns bot hp: full hp on first sighting or host respawn
      // (dead -> alive), otherwise keep the server-computed value (human
      // hits are already decremented here; the host's copy lags behind).
      const hp = !prev || (alive && !prev.alive) ? MAX_HP : prev.hp;
      if (alive && prev && !prev.alive) broadcast(room, { t: 'hp', id: b.id, hp });
      room.bots.set(b.id, {
        team: teamOf(room, b.id),
        p: Array.isArray(b.p) ? b.p.map(Number) : [0, 0, 0],
        yaw: Number(b.yaw) || 0,
        hp,
        alive,
      });
    }
    // Relay verbatim to all non-host clients.
    broadcast(room, { t: 'bots', bots: msg.bots }, id);
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
  players.set(id, { ws, name: id, room: null, team: null, hp: MAX_HP, alive: true, state: null, respawnTimer: null });

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
    players.delete(id);
    if (p.respawnTimer) clearTimeout(p.respawnTimer);
    const room = p.room;
    if (!room) return; // never joined a room
    room.players.delete(id);
    broadcast(room, { t: 'playerLeave', id });
    if (id === room.hostId) {
      room.hostId = null;
      room.bots.clear(); // bot simulation moves to the new host
      pickHost(room);
    }
    if (room.players.size === 0) {
      destroyRoom(room);
      return;
    }
    sendBotConfig(room);
  });

  ws.on('error', () => ws.close());
});

// ~12Hz state relay, per room: each player gets everyone else's latest state.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const [id, p] of room.players) {
      if (p.ws.readyState !== p.ws.OPEN) continue;
      const others = [];
      for (const [oid, op] of room.players) {
        if (oid !== id && op.state) others.push(op.state);
      }
      send(p.ws, { t: 'states', players: others });
    }
  }
}, 1000 / RELAY_HZ);

server.listen(PORT, () => {
  console.log(`cursor-shooter server listening on :${PORT} (static + /ws)`);
});
