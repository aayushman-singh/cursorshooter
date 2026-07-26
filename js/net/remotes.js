import * as THREE from 'three';
import { buildBotMesh } from '../game/bots.js';
import { teamToLocal } from './net.js';

/** Seconds of render delay behind the newest snapshot (smooths the 12Hz stream). */
const INTERP_DELAY = 0.12;
/** Snapshots kept per remote combatant. */
const MAX_SNAPS = 20;

const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 0.95;
const STAND_EYE = 1.6;
const CROUCH_EYE = 0.8;

function wrapAngle(a) {
  return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/** Billboarded name tag sprite, team-colored like the killfeed. */
function makeNameTag(name, team) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '600 34px "Hanken Grotesk", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = team === 'B' ? '#ef5350' : '#4fc3f7';
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  sprite.scale.set(1.8, 0.45, 1);
  sprite.position.y = 2.1;
  return sprite;
}

/**
 * Owns the visual/proxy representation of everyone the local client does NOT
 * simulate: remote human players (from {t:'states'}) and, on non-host clients,
 * the bots (from relayed {t:'bots'}).
 *
 * Each proxy implements just enough of the Combatant interface for
 * physics.raycastCombatants (position/radius/height/alive/team/id) so the local
 * player's hitscan can claim hits against them; applyDamage is assigned by
 * main.js as a network hit-claim shim. Rendering interpolates ~0.12s behind
 * the newest snapshot.
 */
export class RemoteManager {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<string, object>} remote player proxies by id */
    this.players = new Map();
    /** @type {Map<string, object>} remote bot proxies by id (non-host only) */
    this.bots = new Map();
  }

  /** Every proxy with at least one snapshot (i.e. actually placed in the world). */
  get combatants() {
    const out = [];
    for (const p of this.players.values()) if (p.snaps.length > 0) out.push(p);
    for (const b of this.bots.values()) if (b.snaps.length > 0) out.push(b);
    return out;
  }

  /** @returns {object|null} player or bot proxy by id */
  get(id) {
    return this.players.get(id) || this.bots.get(id) || null;
  }

  /**
   * Add a remote human player. Team is a LOCAL letter ('A'|'B').
   * @param {{ id: string, name: string, team: 'A'|'B' }} info
   * @returns {object} the proxy
   */
  addPlayer(info) {
    const existing = this.players.get(info.id);
    if (existing) return existing;
    const proxy = this._createProxy(info.id, info.name, info.team, false);
    this.players.set(info.id, proxy);
    return proxy;
  }

  removePlayer(id) {
    const proxy = this.players.get(id);
    if (!proxy) return;
    this._disposeProxy(proxy);
    this.players.delete(id);
  }

  /**
   * Non-host only: reconcile bot proxies with a relayed {t:'bots'} snapshot
   * (protocol teams), pushing an interpolation snapshot per bot.
   * @param {{ id: string, team: string, p: number[], yaw: number, hp: number, alive: boolean }[]} bots
   */
  applyBots(bots) {
    const seen = new Set();
    for (const b of bots || []) {
      seen.add(b.id);
      let proxy = this.bots.get(b.id);
      if (!proxy) {
        proxy = this._createProxy(b.id, prettifyBotId(b.id), teamToLocal(b.team), true);
        this.bots.set(b.id, proxy);
      }
      proxy.health = b.hp;
      proxy.alive = !!b.alive;
      this._pushSnap(proxy, b.p, b.yaw || 0, 0);
    }
    for (const [id, proxy] of this.bots) {
      if (!seen.has(id)) {
        this._disposeProxy(proxy);
        this.bots.delete(id);
      }
    }
  }

  /** Drop all bot proxies (called when this client becomes the bot host). */
  clearBots() {
    for (const proxy of this.bots.values()) this._disposeProxy(proxy);
    this.bots.clear();
  }

  /** Drop every proxy (leaving the match / going offline). */
  clearAll() {
    for (const proxy of this.players.values()) this._disposeProxy(proxy);
    this.players.clear();
    this.clearBots();
  }

  /** Remote player snapshots from {t:'states'} (already excludes the local id). */
  applyStates(players) {
    for (const s of players || []) {
      const proxy = this.players.get(s.id);
      if (!proxy || !s.p) continue;
      proxy.crouch = !!s.crouch;
      this._pushSnap(proxy, s.p, s.yaw || 0, s.pitch || 0);
    }
  }

  setHp(id, hp) {
    const proxy = this.get(id);
    if (proxy) proxy.health = hp;
  }

  /** Immediate local feedback for a {t:'dead'} broadcast (streams catch up after). */
  markDead(id) {
    const proxy = this.get(id);
    if (!proxy) return;
    proxy.alive = false;
    proxy.health = 0;
    proxy.mesh.visible = false;
  }

  /** Undo markDead on a {t:'respawn'} broadcast. */
  markAlive(id) {
    const proxy = this.get(id);
    if (!proxy) return;
    proxy.alive = true;
    proxy.health = proxy.maxHealth;
  }

  /** Match restart: everyone back to alive/full hp; streams fix positions. */
  resetAll() {
    for (const proxy of [...this.players.values(), ...this.bots.values()]) {
      proxy.alive = true;
      proxy.health = proxy.maxHealth;
    }
  }

  /**
   * Eye position + look direction of a remote combatant, for {t:'shoot'}
   * tracer/sound effects. Bot snapshots carry no pitch — they aim level.
   * @returns {{ origin: THREE.Vector3, dir: THREE.Vector3 } | null}
   */
  getMuzzle(id) {
    const proxy = this.get(id);
    if (!proxy || proxy.snaps.length === 0) return null;
    const origin = proxy.position.clone();
    origin.y += proxy.crouch ? CROUCH_EYE : STAND_EYE;
    const cosPitch = Math.cos(proxy.pitch);
    const dir = new THREE.Vector3(
      -Math.sin(proxy.yaw) * cosPitch,
      Math.sin(proxy.pitch),
      -Math.cos(proxy.yaw) * cosPitch
    );
    return { origin, dir };
  }

  /**
   * Advance interpolation for every proxy. Call once per frame.
   * @param {number} dt seconds
   */
  update(dt) {
    const rt = performance.now() / 1000 - INTERP_DELAY;
    for (const proxy of [...this.players.values(), ...this.bots.values()]) {
      this._interpolate(proxy, rt, dt);
    }
  }

  // ---------------------------------------------------------------- private

  _createProxy(id, name, team, isBot) {
    const mesh = buildBotMesh(team);
    if (!isBot) mesh.add(makeNameTag(name, team));
    mesh.visible = false; // until the first snapshot arrives
    this.scene.add(mesh);
    return {
      // --- Combatant interface (raycast target only) ---
      id,
      name,
      team,
      isBot,
      isRemote: true,
      alive: true,
      health: 100,
      maxHealth: 100,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      radius: 0.4,
      height: STAND_HEIGHT,
      eyeHeight: STAND_EYE,
      weapon: null,
      onDeath: () => {},
      onDamaged: () => {},
      applyDamage: () => {}, // main.js replaces this with a net hit-claim shim
      // --- remote-only state ---
      yaw: 0,
      pitch: 0,
      crouch: false,
      /** @type {{ time: number, x: number, y: number, z: number, yaw: number, pitch: number }[]} */
      snaps: [],
      mesh,
    };
  }

  _pushSnap(proxy, p, yaw, pitch) {
    proxy.snaps.push({
      time: performance.now() / 1000,
      x: p[0], y: p[1], z: p[2],
      yaw, pitch,
    });
    if (proxy.snaps.length > MAX_SNAPS) proxy.snaps.shift();
  }

  _interpolate(proxy, rt, dt) {
    const snaps = proxy.snaps;
    if (snaps.length === 0) return;

    // Newest snap at or before the render time, plus the one after it.
    let a = snaps[0];
    let b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].time <= rt) {
        a = snaps[i];
        b = snaps[i + 1] || snaps[i];
        break;
      }
    }
    const span = b.time - a.time;
    const t = span > 1e-4 ? Math.min(1, Math.max(0, (rt - a.time) / span)) : 1;

    proxy.position.set(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t
    );
    proxy.yaw = lerpAngle(a.yaw, b.yaw, t);
    proxy.pitch = lerpAngle(a.pitch, b.pitch, t);

    // Crouch: shrink the raycast cylinder + squash the mesh to match.
    const targetH = proxy.crouch ? CROUCH_HEIGHT : STAND_HEIGHT;
    const ease = Math.min(1, dt * 10);
    proxy.height += (targetH - proxy.height) * ease;
    proxy.eyeHeight = proxy.crouch ? CROUCH_EYE : STAND_EYE;

    proxy.mesh.position.copy(proxy.position);
    proxy.mesh.rotation.y = proxy.yaw;
    proxy.mesh.scale.y = proxy.height / STAND_HEIGHT;
    proxy.mesh.visible = proxy.alive;
  }

  _disposeProxy(proxy) {
    this.scene.remove(proxy.mesh);
    proxy.mesh.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
  }
}

/** 'bot-blue-0' → 'Blue Bot 0' (fallback display name for killfeed/tags). */
export function prettifyBotId(id) {
  const m = /^bot-(blue|red)-(\d+)$/.exec(id);
  if (!m) return id;
  return `${m[1] === 'blue' ? 'Blue' : 'Red'} Bot ${m[2]}`;
}
