import * as THREE from 'three';
import { GRAVITY } from '../engine/physics.js';

/** Movement speeds, m/s (ARCHITECTURE.md). */
const WALK_SPEED = 5;
const SPRINT_SPEED = 7.5;
const CROUCH_SPEED = 2.5;
const JUMP_SPEED = 7;
/** Capsule/eye dimensions standing vs crouched (m). */
const STAND_HEIGHT = 1.8, STAND_EYE = 1.6;
const CROUCH_HEIGHT = 0.95, CROUCH_EYE = 0.8;
/** Radians per unit of consumeLookDelta() (mouse pixel / gamepad equivalent). */
const LOOK_SENSITIVITY = 0.0023;
/** Pitch clamp, ±87° in radians. */
const MAX_PITCH = THREE.MathUtils.degToRad(87);

const _up = new THREE.Vector3(0, 1, 0);
const _probe = new THREE.Vector3();

/**
 * First-person controller for the human player. Implements the Combatant
 * interface (see ARCHITECTURE.md): id 'player', team 'A', isBot false,
 * feet position, radius 0.4, height 1.8, eyeHeight 1.6, maxHealth 100.
 *
 * Movement: walk 5 m/s, sprint 7.5 m/s, crouch 2.5 m/s (capsule shrinks to
 * 0.95m, eye to 0.8m, blocked from standing under low ceilings), jump ~7 m/s,
 * GRAVITY from physics.js, capsule moved via physics.moveCapsule. Mouse/gamepad
 * look drives the camera (yaw on the player, pitch clamped to ±~87°).
 */
export class PlayerController {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('../engine/input.js').InputManager} input
   * @param {import('../engine/physics.js').PhysicsWorld} physics
   */
  constructor(camera, input, physics) {
    // Required public fields (Combatant interface):
    this.id = 'player';
    this.name = 'You';
    this.team = 'A';
    this.isBot = false;
    this.alive = true;
    this.health = 100;
    this.maxHealth = 100;
    /** @type {THREE.Vector3} feet position — mutate in place, never reassign */
    this.position = new THREE.Vector3();
    /** @type {THREE.Vector3} */
    this.velocity = new THREE.Vector3();
    this.radius = 0.4;
    this.height = 1.8;
    this.eyeHeight = 1.6;
    /** @type {import('./weapons.js').Weapon|null} assigned by main.js */
    this.weapon = null;
    /** @type {(victim: object, killerId: string) => void} assigned by main.js */
    this.onDeath = () => {};
    /** @type {(amount: number, fromId: string) => void} assigned by main.js */
    this.onDamaged = () => {};

    /** @type {THREE.PerspectiveCamera} */
    this.camera = camera;
    /** @type {import('../engine/input.js').InputManager} */
    this.input = input;
    /** @type {import('../engine/physics.js').PhysicsWorld} */
    this.physics = physics;

    /** Look state: yaw around Y (on the player), pitch around X (on the camera). */
    this.yaw = 0;
    this.pitch = 0;
    /** Ground contact as reported by the last moveCapsule call. */
    this.onGround = false;

    // YXZ: yaw applied outside pitch, so looking up/down never rolls the view.
    this.camera.rotation.order = 'YXZ';
    this._syncCamera();
  }

  /**
   * Place the player at a spawn and reset velocity/health/alive.
   * @param {{ position: THREE.Vector3, yaw: number }} spawn
   */
  spawnAt(spawn) {
    this.position.copy(spawn.position);
    this.velocity.set(0, 0, 0);
    this.yaw = spawn.yaw || 0;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.onGround = false;
    this.height = STAND_HEIGHT;
    this.eyeHeight = STAND_EYE;
    this._syncCamera();
  }

  /**
   * Per-frame: read input (move/look/jump), integrate movement, move the camera.
   * No-op (except camera sync) while !alive.
   * @param {number} dt seconds
   */
  update(dt) {
    const look = this.input.consumeLookDelta();
    if (!this.alive) {
      // Delta is still consumed above so it can't pile up while dead.
      this._syncCamera();
      return;
    }

    // Look: positive dx = right (yaw decreases), positive dy = down (pitch decreases).
    this.yaw -= look.dx * LOOK_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.dy * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);

    // Wish direction in world space from yaw (forward = -Z at yaw 0).
    const { moveX, moveZ, sprint, crouch } = this.input.getState();

    // Crouch: shrink the capsule + drop the eye. Standing back up requires
    // headroom — a low ceiling keeps the player crouched.
    const crouched = crouch || !this._headroom();
    const targetH = crouched ? CROUCH_HEIGHT : STAND_HEIGHT;
    const targetE = crouched ? CROUCH_EYE : STAND_EYE;
    const ease = Math.min(1, dt * 10);
    this.height += (targetH - this.height) * ease;
    this.eyeHeight += (targetE - this.eyeHeight) * ease;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wishX = moveX * cos - moveZ * sin;
    const wishZ = -moveX * sin - moveZ * cos;
    const wishLen = Math.hypot(wishX, wishZ);
    const speed = crouched ? CROUCH_SPEED : sprint ? SPRINT_SPEED : WALK_SPEED;
    if (wishLen > 1e-4) {
      const scale = speed / Math.max(wishLen, 1); // normalize diagonals, keep analog < 1
      this.velocity.x = wishX * scale;
      this.velocity.z = wishZ * scale;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }

    if (this.onGround && this.input.wasPressed('jump')) {
      this.velocity.y = JUMP_SPEED;
    }
    this.velocity.y += GRAVITY * dt;

    const result = this.physics.moveCapsule(this.position, this.velocity, this.radius, this.height, dt);
    this.onGround = result.onGround;

    this._syncCamera();
  }

  /**
   * Reduce health; when it reaches 0: alive=false, call this.onDeath(this, fromId).
   * Always call this.onDamaged(amount, fromId) (main.js uses it for HUD flash).
   * @param {number} amount
   * @param {string} fromId attacker id
   */
  applyDamage(amount, fromId) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.onDamaged(amount, fromId);
    if (this.health <= 0) {
      this.alive = false;
      this.velocity.set(0, 0, 0);
      this.onDeath(this, fromId);
    }
  }

  /** @returns {THREE.Vector3} world eye position (new vector each call is fine) */
  getEyePosition() {
    return new THREE.Vector3(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** @returns {THREE.Vector3} normalized look direction (new vector each call) */
  getLookDirection() {
    const cosPitch = Math.cos(this.pitch);
    return new THREE.Vector3(
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch
    );
  }

  /** Push feet position + yaw/pitch onto the camera. */
  _syncCamera() {
    this.camera.position.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;
  }

  /**
   * True if the capsule can expand back to standing height from its current
   * height (no collider in the way above the head).
   */
  _headroom() {
    if (this.height >= STAND_HEIGHT - 0.01) return true;
    _probe.set(this.position.x, this.position.y + this.height - 0.05, this.position.z);
    return !this.physics.raycastWorld(_probe, _up, STAND_HEIGHT - this.height + 0.1);
  }
}
