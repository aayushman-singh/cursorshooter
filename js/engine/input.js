/**
 * Unified keyboard/mouse (pointer lock) + Gamepad API input.
 *
 * Gamepad (standard mapping): left stick move, right stick look,
 * RT(7) fire, LT(6) aim, A(0) jump + menu-activate, X(2) reload,
 * L3(10) or LB(4) sprint, Start(9) pause. Deadzone 0.15,
 * right-stick look ≈ 2.6 rad/s at full deflection.
 *
 * Mouse: movement accumulates into the look delta, LMB fire, RMB aim,
 * Space jump, R reload, Shift sprint, Esc pause (via pointer-lock loss).
 *
 * See ARCHITECTURE.md for the full contract.
 */

const DEADZONE = 0.15;
const PAD_LOOK_SPEED = 2.6; // rad/s at full right-stick deflection
const PAD_LOOK_SCALE = 500; // gamepad radians → mouse-pixel-equivalent units
const NAV_THRESHOLD = 0.5; // stick deflection that counts as a menu-nav impulse
const TRIGGER_THRESHOLD = 0.5; // analog LT/RT value treated as "pressed"

// Standard-mapping button indices.
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_LB = 4;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_START = 9;
const BTN_L3 = 10;
const BTN_R3 = 11;
const BTN_D_UP = 12;
const BTN_D_DOWN = 13;
const BTN_D_LEFT = 14;
const BTN_D_RIGHT = 15;

// Keys whose browser default (page scroll etc.) must be suppressed.
const PREVENT_DEFAULT = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** Per-axis deadzone with rescale so full deflection still reaches ±1. */
function applyDeadzone(v) {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return (Math.sign(v) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE)));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class InputManager {
  /**
   * @param {HTMLElement} lockTarget the element that requests pointer lock (#game-canvas)
   */
  constructor(lockTarget) {
    this.lockTarget = lockTarget;

    this._keys = new Set(); // e.code of currently held keys
    this._keyEdges = new Set(); // e.code latched on keydown, consumed by update()
    this._mouse = new Set(); // mouse buttons currently held (only tracked while locked)
    this._mouseEdges = new Set(); // mouse buttons latched on mousedown, consumed by update()

    this._lookDX = 0; // accumulated look delta (mouse px / pad px-equivalent)
    this._lookDY = 0;

    this._state = { moveX: 0, moveZ: 0, fire: false, aim: false, sprint: false, crouch: false };
    this._edges = { jump: false, reload: false, pause: false, fire: false, activate: false };
    this._menuNav = { x: 0, y: 0 };
    this._prevNavX = 0;
    this._prevNavY = 0;

    this._pad = null; // Gamepad snapshot from the last update()
    this._prevPadButtons = []; // pressed flags from the previous update()
    this._wasLocked = false;
    this._lockLostCallbacks = [];

    window.addEventListener('keydown', (e) => {
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._keys.add(e.code);
      this._keyEdges.add(e.code);
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    // Dropping focus can swallow keyup/mouseup — clear to avoid stuck inputs.
    window.addEventListener('blur', () => {
      this._keys.clear();
      this._mouse.clear();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._keys.clear();
        this._mouse.clear();
      }
    });

    // While pointer locked, all mouse events are retargeted to the locked element.
    lockTarget.addEventListener('mousedown', (e) => {
      if (!this.isPointerLocked()) return;
      this._mouse.add(e.button);
      this._mouseEdges.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this._mouse.delete(e.button));
    lockTarget.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked()) return;
      this._lookDX += e.movementX || 0;
      this._lookDY += e.movementY || 0;
    });
    lockTarget.addEventListener('contextmenu', (e) => e.preventDefault()); // RMB = aim

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.lockTarget;
      if (!locked && this._wasLocked) {
        this._mouse.clear();
        for (const cb of this._lockLostCallbacks) {
          try {
            cb();
          } catch (err) {
            console.error('input: pointer-lock-lost callback failed', err);
          }
        }
      }
      this._wasLocked = locked;
    });
    // Request failures also surface as rejected promises; nothing to do here.
    document.addEventListener('pointerlockerror', () => {});

    // Prompt connect/disconnect feedback (update() re-polls every frame anyway).
    window.addEventListener('gamepadconnected', () => {
      this._pad = this._readGamepad();
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this._pad && this._pad.index === e.gamepad.index) {
        this._pad = null;
        this._prevPadButtons.length = 0;
      }
    });
  }

  /**
   * Poll keyboard state + gamepads. Call ONCE per frame before any reads.
   * Computes edge-triggered presses for this frame.
   * @param {number} dt seconds
   */
  update(dt) {
    const pad = this._readGamepad();
    this._pad = pad;

    const kb = (code) => this._keys.has(code);
    const btn = (i) => {
      const b = pad && pad.buttons[i];
      return !!b && (b.pressed || b.value > TRIGGER_THRESHOLD);
    };
    const padEdge = (i) => btn(i) && !this._prevPadButtons[i];

    // Sticks (deadzoned + rescaled). ly/ry are positive = stick down.
    let lx = 0;
    let ly = 0;
    if (pad && pad.axes) {
      lx = applyDeadzone(pad.axes[0] || 0);
      ly = applyDeadzone(pad.axes[1] || 0);
      const rx = applyDeadzone(pad.axes[2] || 0);
      const ry = applyDeadzone(pad.axes[3] || 0);
      // Gamepad look contributes radians * ~500 so the consumer's mouse
      // sensitivity (~rad/px) yields ≈ 2.6 rad/s at full deflection.
      this._lookDX += rx * PAD_LOOK_SPEED * PAD_LOOK_SCALE * dt;
      this._lookDY += ry * PAD_LOOK_SPEED * PAD_LOOK_SCALE * dt;
    }

    // Merged held state. moveZ: +1 forward (W / stick up → axis negative).
    const s = this._state;
    s.moveX = clamp((kb('KeyD') ? 1 : 0) - (kb('KeyA') ? 1 : 0) + lx, -1, 1);
    s.moveZ = clamp((kb('KeyW') ? 1 : 0) - (kb('KeyS') ? 1 : 0) - ly, -1, 1);
    s.fire = this._mouse.has(0) || btn(BTN_RT);
    s.aim = this._mouse.has(2) || btn(BTN_LT);
    s.sprint = kb('ShiftLeft') || kb('ShiftRight') || btn(BTN_L3) || btn(BTN_LB);
    s.crouch = kb('ControlLeft') || kb('ControlRight') || kb('KeyC') || btn(BTN_B) || btn(BTN_R3);

    // Edge-triggered presses: keyboard/mouse edges are latched by events
    // (survive sub-frame taps), pad edges come from frame-to-frame transition.
    this._edges.jump = this._keyEdges.has('Space') || padEdge(BTN_A);
    this._edges.reload = this._keyEdges.has('KeyR') || padEdge(BTN_X);
    this._edges.pause = this._keyEdges.has('Escape') || padEdge(BTN_START);
    this._edges.fire = this._mouseEdges.has(0) || padEdge(BTN_RT);
    this._edges.activate = this._keyEdges.has('Enter') || padEdge(BTN_A);

    // Menu navigation (controller only — d-pad / left stick; keyboard arrows
    // are handled by the HUD's own keydown listener): one impulse when a
    // direction goes from free to held.
    let navX = 0;
    let navY = 0;
    if (btn(BTN_D_LEFT) || lx <= -NAV_THRESHOLD) navX = -1;
    else if (btn(BTN_D_RIGHT) || lx >= NAV_THRESHOLD) navX = 1;
    if (btn(BTN_D_UP) || ly <= -NAV_THRESHOLD) navY = -1;
    else if (btn(BTN_D_DOWN) || ly >= NAV_THRESHOLD) navY = 1;
    this._menuNav.x = navX !== 0 && navX !== this._prevNavX ? navX : 0;
    this._menuNav.y = navY !== 0 && navY !== this._prevNavY ? navY : 0;
    this._prevNavX = navX;
    this._prevNavY = navY;

    // Snapshot pad buttons for next frame's edges; clear one-frame latches.
    if (pad) {
      for (let i = 0; i < pad.buttons.length; i++) this._prevPadButtons[i] = btn(i);
      this._prevPadButtons.length = pad.buttons.length;
    } else {
      this._prevPadButtons.length = 0;
    }
    this._keyEdges.clear();
    this._mouseEdges.clear();
  }

  /**
   * Analog / held state for this frame (merged keyboard + gamepad).
   * moveX: -1 (left) .. 1 (right strafe). moveZ: -1 (back) .. 1 (forward).
   * crouch: Ctrl / C / gamepad B / R3 held.
   * @returns {{ moveX: number, moveZ: number, fire: boolean, aim: boolean, sprint: boolean, crouch: boolean }}
   */
  getState() {
    const s = this._state;
    return { moveX: s.moveX, moveZ: s.moveZ, fire: s.fire, aim: s.aim, sprint: s.sprint, crouch: s.crouch };
  }

  /**
   * Accumulated look delta since the last call, then resets the accumulator.
   * Mouse deltas are raw pixels; gamepad contributes radians*~500 equivalent.
   * The consumer multiplies by its own sensitivity.
   * @returns {{ dx: number, dy: number }} (positive dx = look right, positive dy = look down)
   */
  consumeLookDelta() {
    const delta = { dx: this._lookDX, dy: this._lookDY };
    this._lookDX = 0;
    this._lookDY = 0;
    return delta;
  }

  /**
   * Edge-triggered: true only on the frame the action went down.
   * @param {'jump'|'reload'|'pause'|'fire'|'activate'} action
   *   ('fire' edge is for semi-auto use; 'activate' = gamepad A / Enter, for menus)
   * @returns {boolean}
   */
  wasPressed(action) {
    return !!this._edges[action];
  }

  /** @returns {boolean} true if a gamepad is currently connected */
  isGamepadConnected() {
    return this._pad !== null;
  }

  /**
   * Rumble the gamepad if the browser/pad supports it (no-op otherwise).
   * @param {number} strong 0..1 strong motor
   * @param {number} weak 0..1 weak motor
   * @param {number} ms duration
   */
  rumble(strong, weak, ms) {
    const pad = this._pad;
    if (!pad) return;
    const duration = Math.max(0, ms | 0);
    const s = clamp(strong || 0, 0, 1);
    const w = clamp(weak || 0, 0, 1);
    try {
      const actuator = pad.vibrationActuator;
      if (actuator && typeof actuator.playEffect === 'function') {
        const p = actuator.playEffect('dual-rumble', {
          duration,
          strongMagnitude: s,
          weakMagnitude: w,
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else if (pad.hapticActuators && pad.hapticActuators[0] && typeof pad.hapticActuators[0].pulse === 'function') {
        // Legacy Firefox API.
        pad.hapticActuators[0].pulse(Math.max(s, w), duration);
      }
    } catch (_) {
      // Rumble unsupported — stay silent.
    }
  }

  /** Request pointer lock on the target (must be called from a user gesture). */
  requestPointerLock() {
    if (this.isPointerLocked()) return;
    try {
      const p = this.lockTarget.requestPointerLock();
      // Chrome returns a promise (rejects if re-requested too soon after Esc).
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // Older engines throw synchronously — ignore, caller can retry.
    }
  }

  /** Exit pointer lock. */
  exitPointerLock() {
    if (this.isPointerLocked()) document.exitPointerLock();
  }

  /** @returns {boolean} true while the pointer is locked to the target */
  isPointerLocked() {
    return document.pointerLockElement === this.lockTarget;
  }

  /**
   * Register a callback fired whenever pointer lock is lost (Esc etc.) — used to auto-pause.
   * @param {() => void} cb
   */
  onPointerLockLost(cb) {
    if (typeof cb === 'function') this._lockLostCallbacks.push(cb);
  }

  /**
   * For controller menu navigation: returns -1/0/+1 edge impulses for this frame.
   * @returns {{ x: number, y: number }} (y: +1 = down, -1 = up; x: +1 = right, -1 = left)
   */
  getMenuNav() {
    return { x: this._menuNav.x, y: this._menuNav.y };
  }

  /**
   * First connected gamepad, preferring standard mapping. Re-polled each
   * update() because browsers hand out fresh/snapshot Gamepad objects.
   * @returns {Gamepad|null}
   * @private
   */
  _readGamepad() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return null;
    }
    const pads = navigator.getGamepads() || [];
    let fallback = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || p.connected === false) continue;
      if (p.mapping === 'standard') return p;
      if (!fallback) fallback = p;
    }
    return fallback;
  }
}
