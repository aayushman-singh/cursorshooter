# CURSOR SHOOTER — multiplayer protocol

JSON text messages over WebSocket at `/ws`. Implemented by `server/server.js`
(authoritative for hp, score, respawns, win) and the browser client (`js/net.js`).

## Connection lifecycle

| Direction | Message | Notes |
|-----------|---------|-------|
| C→S | `{t:'join', name}` | sent right after connect |
| S→C | `{t:'welcome', id, team, host, players:[{id,name,team}], score:{blue,red}}` | `team` is auto-balanced (`'blue'`\|`'red'`); `host`=true for the player who simulates the bots (first connected). `players` is the full roster including the new player. |
| S→C | `{t:'playerJoin', player:{id,name,team}}` | broadcast to others |
| S→C | `{t:'playerLeave', id}` | broadcast; server recalculates bot fill |
| S→C | `{t:'hostUpdate', host:id}` | when the host leaves, the server promotes the longest-connected remaining player |

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
  join/leave, sent to the current host only.
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
