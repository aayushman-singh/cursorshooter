import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* Module-level scratch vectors: single-threaded, never held across    */
/* calls — avoids per-shot allocation churn.                           */
/* ------------------------------------------------------------------ */
const _dir = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

const TRACER_POOL_SIZE = 24;
const TRACER_LIFE = 0.07; // seconds
const TRACER_OPACITY = 0.85;

const FLASH_POOL_SIZE = 10;

const SPARK_POOL_SIZE = 48;
const SPARK_GRAVITY = -12; // m/s², lighter than gameplay gravity

/**
 * Owns all transient weapon visuals: tracer lines, muzzle flashes, impact sparks.
 * Effects are cheap (THREE.Line / small meshes with lifetimes) and pooled or
 * disposed properly — no leaks over a long match.
 */
export class WeaponSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../engine/physics.js').PhysicsWorld} physics
   */
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;

    // --- Tracer pool: one 2-point line each, faded out over TRACER_LIFE. ---
    this._tracers = [];
    this._tracerIdx = 0;
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.frustumCulled = false; // positions change every reuse
      scene.add(line);
      this._tracers.push({ line, life: 0, maxLife: TRACER_LIFE });
    }

    // --- Flash pool: additive sprites, shared by muzzle flashes and impact pops. ---
    this._flashes = [];
    this._flashIdx = 0;
    for (let i = 0; i < FLASH_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        color: 0xffc766,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this._flashes.push({ sprite, life: 0, maxLife: 0.05, grow: 0 });
    }

    // --- Spark pool: tiny tumbling boxes with velocity + gravity. ---
    this._sparks = [];
    this._sparkIdx = 0;
    const sparkGeo = new THREE.BoxGeometry(0.02, 0.02, 0.02);
    for (let i = 0; i < SPARK_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffa63d,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(sparkGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this._sparks.push({ mesh, vel: new THREE.Vector3(), life: 0, maxLife: 0.3 });
    }
  }

  /**
   * Create a hitscan rifle for a combatant.
   * @param {object} owner Combatant-interface object (see ARCHITECTURE.md)
   * @param {{ damage?: number, fireInterval?: number, magSize?: number,
   *   reloadTime?: number, range?: number, spread?: number }} [opts]
   *   Defaults: damage 25, fireInterval 0.1, magSize 30, reloadTime 1.6,
   *   range 120, spread 0.012 (radians cone half-angle, hip fire).
   * @returns {Weapon}
   */
  createWeapon(owner, opts = {}) {
    return new Weapon(owner, opts, this);
  }

  /**
   * Advance effect lifetimes (tracers fade, sparks fall). Call once per frame.
   * @param {number} dt seconds
   */
  update(dt) {
    for (const t of this._tracers) {
      if (!t.line.visible) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.life = 0;
        t.line.visible = false;
        t.line.material.opacity = 0;
        continue;
      }
      t.line.material.opacity = TRACER_OPACITY * (t.life / t.maxLife);
    }

    for (const f of this._flashes) {
      if (!f.sprite.visible) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.life = 0;
        f.sprite.visible = false;
        f.sprite.material.opacity = 0;
        continue;
      }
      f.sprite.material.opacity = f.life / f.maxLife;
      f.sprite.scale.addScalar(f.grow * dt); // quick expansion while fading
    }

    for (const s of this._sparks) {
      if (!s.mesh.visible) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.life = 0;
        s.mesh.visible = false;
        s.mesh.material.opacity = 0;
        continue;
      }
      s.vel.y += SPARK_GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += dt * 9;
      s.mesh.rotation.y += dt * 7;
      s.mesh.material.opacity = s.life / s.maxLife;
    }
  }

  /* ---------------- internal effect spawners (used by Weapon) ---------------- */

  /**
   * Visual-only shot for a remote (networked) combatant: tracer, muzzle
   * flash, and world impact effects — but no spread, ammo, or damage.
   * Called from main.js on {t:'shoot'} relays.
   * @param {THREE.Vector3} origin muzzle/eye position
   * @param {THREE.Vector3} direction normalized aim direction
   * @param {number} [range] max tracer length when nothing is hit
   */
  spawnRemoteShot(origin, direction, range = 120) {
    _dir.copy(direction).normalize();
    const worldHit = this.physics.raycastWorld(origin, _dir, range);
    if (worldHit) {
      _p.copy(worldHit.point);
      this._spawnSparks(_p, worldHit.normal, 4, 0xffa63d);
    } else {
      _p.copy(origin).addScaledVector(_dir, range);
    }
    const dist = _p.distanceTo(origin);
    _n.copy(origin).addScaledVector(_dir, Math.min(0.35, dist * 0.5));
    this._spawnTracer(_n, _p);
    _n.copy(origin).addScaledVector(_dir, Math.min(0.55, dist * 0.5));
    _n.y -= 0.12; // reads as gun-level rather than eye-level
    this._spawnFlash(_n, 0.28, 0xffc766, 0.045);
  }

  /** Round-robin reuse: the oldest effect is recycled when the pool is saturated. */
  _spawnTracer(from, to) {
    const t = this._tracers[this._tracerIdx];
    this._tracerIdx = (this._tracerIdx + 1) % TRACER_POOL_SIZE;
    const attr = t.line.geometry.getAttribute('position');
    attr.setXYZ(0, from.x, from.y, from.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    t.life = t.maxLife;
    t.line.material.opacity = TRACER_OPACITY;
    t.line.visible = true;
  }

  _spawnFlash(pos, scale, colorHex, life = 0.05) {
    const f = this._flashes[this._flashIdx];
    this._flashIdx = (this._flashIdx + 1) % FLASH_POOL_SIZE;
    f.sprite.position.copy(pos);
    f.sprite.scale.setScalar(scale);
    f.sprite.material.color.setHex(colorHex);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.material.opacity = 1;
    f.maxLife = life;
    f.life = life;
    f.grow = scale * 6;
    f.sprite.visible = true;
  }

  _spawnSparks(pos, normal, count, colorHex) {
    for (let i = 0; i < count; i++) {
      const s = this._sparks[this._sparkIdx];
      this._sparkIdx = (this._sparkIdx + 1) % SPARK_POOL_SIZE;
      s.mesh.position.copy(pos);
      // Outward along the surface normal plus random sideways jitter.
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0);
      _v.normalize();
      s.vel.copy(normal)
        .multiplyScalar(1.2 + Math.random() * 2.4)
        .addScaledVector(_v, 0.6 + Math.random() * 1.6);
      s.maxLife = 0.22 + Math.random() * 0.18;
      s.life = s.maxLife;
      s.mesh.material.color.setHex(colorHex);
      s.mesh.material.opacity = 1;
      s.mesh.visible = true;
    }
  }
}

/**
 * Hitscan rifle shared by the player and all bots.
 * Public fields (set from opts at construction):
 *   owner, damage, fireInterval, magSize, reloadTime, range, spread,
 *   ammo (in mag), reserveAmmo (Infinity), isReloading (bool),
 *   cooldown (seconds until next allowed shot)
 *
 * Constructed via WeaponSystem.createWeapon — the third constructor param
 * is the owning WeaponSystem, used for physics raycasts and effect spawns.
 */
export class Weapon {
  constructor(owner, opts = {}, system = null) {
    this.owner = owner;
    this.damage = opts.damage !== undefined ? opts.damage : 25;
    this.fireInterval = opts.fireInterval !== undefined ? opts.fireInterval : 0.1;
    this.magSize = opts.magSize !== undefined ? opts.magSize : 30;
    this.reloadTime = opts.reloadTime !== undefined ? opts.reloadTime : 1.6;
    this.range = opts.range !== undefined ? opts.range : 120;
    this.spread = opts.spread !== undefined ? opts.spread : 0.012;

    this.ammo = this.magSize;
    this.reserveAmmo = Infinity;
    this.isReloading = false;
    this.cooldown = 0;

    this._reloadTimer = 0;
    this._system = system;

    /**
     * Optional callback fired after every successful shot:
     * (origin: THREE.Vector3, endPoint: THREE.Vector3) => void.
     * main.js uses it for gunshot audio.
     */
    this.onShot = null;
  }

  /**
   * Attempt a single shot from `origin` along `direction`.
   * Returns null (no effect) when cooling down, reloading, or mag is empty.
   * On a shot: decrements ammo, applies `spread` as a random cone, raycasts
   * world (physics.raycastWorld) and combatants (physics.raycastCombatants,
   * excluding the owner and — per friendly-fire-off — never damaging same-team),
   * damages the hit enemy via combatant.applyDamage(damage, owner.id),
   * and spawns tracer + impact effects from `origin` to the final point.
   * @param {THREE.Vector3} origin muzzle/eye position
   * @param {THREE.Vector3} direction normalized aim direction
   * @param {object[]} combatants all combatants in the match
   * @returns {{ hit: object|null, point: THREE.Vector3 } | null}
   *   hit: the damaged enemy combatant or null; point: where the shot ended
   */
  tryFire(origin, direction, combatants) {
    if (this.cooldown > 0 || this.isReloading || this.ammo <= 0) return null;
    this.cooldown = this.fireInterval;
    this.ammo -= 1;

    // Random cone spread: uniform over the cone's solid angle, built on an
    // orthonormal basis around the (copied, never mutated) aim direction.
    _dir.copy(direction).normalize();
    _ref.set(0, 1, 0);
    if (Math.abs(_dir.y) > 0.99) _ref.set(1, 0, 0); // near-vertical aim
    _u.crossVectors(_ref, _dir).normalize();
    _v.crossVectors(_dir, _u);
    const ang = Math.random() * Math.PI * 2;
    const rad = this.spread * Math.sqrt(Math.random());
    _dir
      .addScaledVector(_u, Math.cos(ang) * rad)
      .addScaledVector(_v, Math.sin(ang) * rad)
      .normalize();

    const sys = this._system;
    const worldHit = sys.physics.raycastWorld(origin, _dir, this.range);
    // Walls block bullets: only look for combatants closer than the wall hit.
    const maxDist = worldHit ? worldHit.distance : this.range;
    const cHit = sys.physics.raycastCombatants(origin, _dir, maxDist, combatants, this.owner.id);

    let hit = null;
    const point = new THREE.Vector3();
    if (cHit) {
      point.copy(cHit.point);
      if (cHit.combatant.team !== this.owner.team) {
        cHit.combatant.applyDamage(this.damage, this.owner.id);
        hit = cHit.combatant;
        _n.copy(_dir).negate(); // flesh "normal": back toward the shooter
        sys._spawnSparks(point, _n, 5, 0xc7352b);
        sys._spawnFlash(point, 0.16, 0xff8866, 0.05);
      }
      // Same-team hit: friendly fire is off — the body blocks the shot, no damage.
    } else if (worldHit) {
      point.copy(worldHit.point);
      sys._spawnSparks(point, worldHit.normal, 6, 0xffa63d);
      sys._spawnFlash(point, 0.2, 0xffe0a8, 0.06);
    } else {
      point.copy(origin).addScaledVector(_dir, this.range);
    }

    // Start short effects slightly ahead of the eye so they don't sit on the
    // camera near plane; clamp for point-blank hits.
    const dist = point.distanceTo(origin);
    const ahead = Math.min(0.35, dist * 0.5);
    _p.copy(origin).addScaledVector(_dir, ahead);
    sys._spawnTracer(_p, point);
    // World-space muzzle flash only for bots: the local player gets the
    // subtler view-model flash via kick() — both together read as a strobe.
    if (this.owner.isBot) {
      _p.copy(origin).addScaledVector(_dir, Math.min(0.55, dist * 0.5));
      _p.y -= 0.12; // reads as gun-level rather than eye-level
      sys._spawnFlash(_p, 0.28, 0xffc766, 0.045);
    }

    if (this.onShot) this.onShot(origin, point);

    return { hit, point };
  }

  /**
   * Begin a reload if not already reloading and mag isn't full.
   * After reloadTime seconds (in update), mag refills from reserveAmmo.
   */
  reload() {
    if (this.isReloading || this.ammo >= this.magSize || this.reserveAmmo <= 0) return;
    this.isReloading = true;
    this._reloadTimer = this.reloadTime;
  }

  /**
   * Advance cooldown + reload timers.
   * @param {number} dt seconds
   */
  update(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.isReloading) {
      this._reloadTimer -= dt;
      if (this._reloadTimer <= 0) {
        const need = this.magSize - this.ammo;
        const take = Math.min(need, this.reserveAmmo);
        this.ammo += take;
        this.reserveAmmo -= take; // no-op while reserveAmmo is Infinity
        this.isReloading = false;
        this._reloadTimer = 0;
      }
    }
  }
}

/**
 * First-person view model: a simple rifle built from boxes, parented to the
 * camera, with procedural sway/bob while moving, recoil `kick()` on shots,
 * and a reload dip animation. Not a Combatant weapon — pure visuals.
 * @param {THREE.PerspectiveCamera} camera
 * @returns {{
 *   update: (dt: number, moving: boolean) => void,
 *   kick: () => void,
 *   setReloading: (b: boolean) => void,
 *   setVisible: (b: boolean) => void
 * }}
 */
export function createViewModel(camera) {
  const group = new THREE.Group();
  camera.add(group);

  // Unlit, unfogged, depth-test-off: always readable and never clips into walls.
  function part(w, h, d, color, x, y, z, rx = 0) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color, fog: false, depthTest: false, depthWrite: false })
    );
    mesh.position.set(x, y, z);
    if (rx !== 0) mesh.rotation.x = rx;
    mesh.renderOrder = 999;
    group.add(mesh);
    return mesh;
  }

  part(0.055, 0.085, 0.42, 0x2b2f36, 0, 0, -0.1);            // receiver
  part(0.05, 0.055, 0.26, 0x33373f, 0, 0.004, -0.36);        // handguard
  part(0.026, 0.026, 0.3, 0x1b1d21, 0, 0.012, -0.5);         // barrel
  part(0.036, 0.036, 0.06, 0x14161a, 0, 0.012, -0.63);       // muzzle brake
  part(0.042, 0.15, 0.07, 0x23262c, 0, -0.105, -0.05, 0.12); // magazine
  part(0.045, 0.12, 0.06, 0x23262c, 0, -0.095, 0.09, 0.35);  // grip
  part(0.045, 0.075, 0.2, 0x2b2f36, 0, -0.012, 0.17);        // stock
  part(0.02, 0.03, 0.03, 0x14161a, 0, 0.058, 0.02);          // rear sight
  part(0.012, 0.028, 0.018, 0x14161a, 0, 0.038, -0.42);      // front sight

  // Camera-facing muzzle flash quad at the barrel tip, flashed by kick().
  // Kept small and dim — a big additive quad at 10 rps strobes the screen.
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.1, 0.1),
    new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      fog: false,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  flash.position.set(0, 0.012, -0.68);
  flash.renderOrder = 1000;
  flash.visible = false;
  group.add(flash);

  const BASE_POS = new THREE.Vector3(0.2, -0.2, -0.45);
  const BASE_ROT_Y = -0.04; // slight inward cant
  group.position.copy(BASE_POS);
  group.rotation.y = BASE_ROT_Y;

  const FLASH_DURATION = 0.035;
  let bobT = 0;         // ever-advancing phase clock
  let bobWeight = 0;    // smoothed 0..1 from `moving`
  let recoil = 0;       // decaying kick impulse
  let reloadWeight = 0; // smoothed 0..1 from `reloading`
  let reloading = false;
  let flashTime = 0;

  function update(dt, moving) {
    bobT += dt;
    bobWeight += ((moving ? 1 : 0) - bobWeight) * Math.min(1, dt * 7);
    reloadWeight += ((reloading ? 1 : 0) - reloadWeight) * Math.min(1, dt * 6);
    recoil *= Math.exp(-11 * dt);
    if (recoil < 0.001) recoil = 0;

    const step = bobT * 9; // stride phase
    const swayX = Math.sin(step) * 0.012 * bobWeight;
    const bobY = -Math.abs(Math.sin(step)) * 0.01 * bobWeight; // two dips per stride
    const idleY = Math.sin(bobT * 1.8) * 0.0025 * (1 - bobWeight); // breathing

    group.position.set(
      BASE_POS.x + swayX,
      BASE_POS.y + bobY + idleY - reloadWeight * 0.17,
      BASE_POS.z + recoil * 0.075
    );
    // Positive rotation.x raises the -Z-pointing muzzle (recoil); negative dips it (reload).
    group.rotation.set(
      recoil * 0.13 - reloadWeight * 0.55 + bobY * 1.2,
      BASE_ROT_Y + swayX * 1.5,
      reloadWeight * 0.32
    );

    if (flashTime > 0) {
      flashTime -= dt;
      const k = Math.max(0, flashTime / FLASH_DURATION);
      flash.material.opacity = k * 0.55; // capped peak: feedback, not a strobe
      flash.visible = k > 0;
    } else if (flash.visible) {
      flash.visible = false;
    }
  }

  function kick() {
    recoil = Math.min(recoil + 0.55, 1.2); // accumulates under auto fire, capped
    flashTime = FLASH_DURATION;
    flash.rotation.z = Math.random() * Math.PI * 2;
    const s = 0.8 + Math.random() * 0.3;
    flash.scale.set(s, s, s);
  }

  function setReloading(b) {
    reloading = !!b;
  }

  function setVisible(b) {
    group.visible = !!b;
  }

  return { update, kick, setReloading, setVisible };
}
