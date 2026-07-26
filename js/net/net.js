/**
 * WebSocket client for online matches (see the shared protocol contract).
 * JSON text messages at ws(s)://<host>/ws; override the endpoint with the
 * ?server= query param (full ws:// URL or host[:port]).
 *
 * Protocol teams are 'blue' | 'red'; the local game uses 'A' | 'B'.
 * Use teamToLocal/teamToProtocol at the boundary.
 */

/** Protocol team → local team letter. */
export function teamToLocal(t) {
  return t === 'red' ? 'B' : 'A';
}

/** Local team letter → protocol team. */
export function teamToProtocol(t) {
  return t === 'B' ? 'red' : 'blue';
}

export class NetClient {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    this.id = null;
    this.team = null;      // protocol team: 'blue' | 'red'
    this.host = false;     // true when this client simulates the bots
    /** @type {Map<string, { id: string, name: string, team: string }>} roster */
    this.players = new Map();
    this.score = { blue: 0, red: 0 };
    /** @type {Map<string, Function[]>} */
    this._handlers = new Map();
  }

  /**
   * Resolve the WebSocket URL: ?server= override, else same origin at /ws.
   * @returns {string}
   */
  static serverUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const override = new URLSearchParams(location.search).get('server');
    if (override) {
      if (/^wss?:\/\//.test(override)) return override;
      return `${proto}://${override}/ws`;
    }
    return `${proto}://${location.host}/ws`;
  }

  /**
   * @param {string} type message type ('welcome', 'states', 'dead', …)
   * @param {(msg: object) => void} cb
   */
  on(type, cb) {
    if (!this._handlers.has(type)) this._handlers.set(type, []);
    this._handlers.get(type).push(cb);
  }

  _emit(type, msg) {
    const cbs = this._handlers.get(type);
    if (cbs) for (const cb of cbs) cb(msg);
  }

  /**
   * Connect, send {t:'join', name}, and resolve with the welcome message.
   * Rejects on socket error, close-before-welcome, or timeout.
   * @param {string} name
   * @param {number} [timeoutMs]
   * @returns {Promise<object>} the welcome message
   */
  connect(name, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error('connection timed out')), timeoutMs);
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(err);
      };

      let ws;
      try {
        ws = new WebSocket(NetClient.serverUrl());
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      this.ws = ws;

      ws.onopen = () => this.send({ t: 'join', name });
      ws.onerror = () => fail(new Error('connection failed'));
      ws.onclose = () => {
        if (!settled) fail(new Error('connection closed'));
        else this._emit('close', { t: 'close' });
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return; // ignore malformed frames
        }
        // Roster/host bookkeeping the rest of the client can rely on.
        if (msg.t === 'welcome') {
          this.id = msg.id;
          this.team = msg.team;
          this.host = !!msg.host;
          this.score = msg.score || { blue: 0, red: 0 };
          this.players.clear();
          for (const p of msg.players || []) this.players.set(p.id, p);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(msg);
          }
        } else if (msg.t === 'playerJoin') {
          this.players.set(msg.player.id, msg.player);
        } else if (msg.t === 'playerLeave') {
          this.players.delete(msg.id);
        } else if (msg.t === 'hostUpdate') {
          this.host = msg.host === this.id;
        }
        this._emit(msg.t, msg);
      };
    });
  }

  /** Send a JSON message if the socket is open; silently drops otherwise. */
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Local player state, ~12Hz: {t:'state', p:[x,y,z], yaw, pitch, crouch, firing}. */
  sendState(p, yaw, pitch, crouch, firing) {
    this.send({ t: 'state', p, yaw, pitch, crouch, firing });
  }

  /** A round was fired; the server relays it to the others for tracer/sound. */
  sendShoot() {
    this.send({ t: 'shoot' });
  }

  /** Hit claim: target is a player id or bot id; `from` set for bot shooters. */
  sendHit(target, dmg, from) {
    const msg = { t: 'hit', target, dmg };
    if (from) msg.from = from;
    this.send(msg);
  }

  /** Host only, ~12Hz: bots:[{id, team, p, yaw, hp, alive}]. */
  sendBots(bots) {
    this.send({ t: 'bots', bots });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = null;
    }
  }
}
