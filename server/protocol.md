# CURSOR SHOOTER — multiplayer protocol

JSON text messages over WebSocket at `/ws`. Implemented by `server/server.js`
(authoritative for hp, score, respawns, win) and the browser client (`js/net.js`).

## Rooms

All game state is per-room: roster, team balance, host, score, hp, bot hp, and
every relay/broadcast is scoped to the sender's room. A room is created by the
first join that names it and destroyed when its last player leaves; rooms are
fully independent matches.

- `join` gains two optional fields:
  - `room` (string) — normalized server-side to uppercase `[A-Z0-9]`, max 8
    chars; empty, missing, or all-invalid → `'LOBBY'`.
  - `bots` (boolean, default `true`) — only the room CREATOR's value applies;
    it becomes the room's permanent setting.
- `welcome` gains two fields:
  - `room` — the normalized room id actually joined.
  - `bots` — the ROOM's actual setting (a later joiner's `bots` is ignored).
- Rooms with `bots:false` always get `botConfig {blue:0, red:0}`; rooms with
  `bots:true` use the fill-each-team-to-3 behavior below.

## Connection lifecycle

| Direction | Message | Notes |
|-----------|---------|-------|
| C→S | `{t:'join', name, room?, bots?}` | sent right after connect; one join per connection |
| S→C | `{t:'welcome', id, team, host, room, bots, players:[{id,name,team}], score:{blue,red}}` | `team` is auto-balanced (`'blue'`\|`'red'`); `host`=true for the player who simulates the bots (first in the room). `players` is the room roster including the new player. |
| S→C | `{t:'playerJoin', player:{id,name,team}}` | broadcast to others in the room |
| S→C | `{t:'playerLeave', id}` | broadcast in the room; server recalculates bot fill |
| S→C | `{t:'hostUpdate', host:id}` | when the host leaves, the server promotes the longest-connected remaining player in the room |

## Gameplay (all players)

- C→S `{t:'state', p:[x,y,z], yaw, pitch, crouch, firing}` — ~12Hz.
- S→C `{t:'states', players:[{id,p,yaw,pitch,crouch,firing}]}` — relayed ~12Hz,
  excludes the recipient's own id.
- C→S `{t:'shoot'}` → S→C `{t:'shoot', id}` relayed to others (tracer/sound only).
- C→S `{t:'hit', target, dmg}` — `target` is a player id or bot id string; the
  shooter's client raycasts and claims the hit; the server applies damage.
- S→C `{t:'hp', id, hp}` — broadcast on any hp change (player or bot id).
- S→C `{t:'dead', victim, killer, victimTeam, killerTeam}` — broadcast; victim
  may be a player or bot id. Killer's team +1 (killing a bot counts).
- First team to 20: S→C `{t:'end', winner, score}`, then after 5s the server
  resets hp/score and broadcasts `{t:'restart', score:{blue:0,red:0}}`.
- Dead players: S→C `{t:'respawn', id, p:[x,y,z]}` after 3s with a team spawn
  point (fixed coordinates duplicated from `js/game/map.js`).

## Bots (host-authoritative)

- S→host `{t:'botConfig', blue:N, red:M}` — bots fill each team up to 3 total
  members (e.g. 2 blue + 1 red humans → `blue:1, red:2`). Recalculated on every
  join/leave, sent to the room's current host only. Always `{blue:0, red:0}`
  in rooms where the creator disabled bots.
- Host C→S `{t:'bots', bots:[{id,team,p,yaw,hp,alive}]}` ~12Hz; ids like
  `'bot-blue-0'`. Relayed verbatim to non-host clients.
- Bot hits a human: host sends `{t:'hit', target, dmg, from:botId}`; damage is
  applied the same way as human hits.
- Human kills a bot: human sends `{t:'hit', target:botId, dmg}`. The server owns
  bot hp (full hp on first sighting and on host respawn, i.e. dead→alive in a
  `bots` message) and broadcasts `hp`/`dead` for bots. The host respawns dead
  bots after 3s and re-includes them with `alive:true`, full hp.

## Rules enforced server-side

100 hp · 25 dmg max per hit · 3s respawn · friendly fire dropped (target team ==
shooter team; shooter team from roster, bot team from id prefix) · first to 20 wins.

Malformed JSON and unknown message types are ignored; disconnects clean up the
roster, promote a new host, and recalculate bot fill.
