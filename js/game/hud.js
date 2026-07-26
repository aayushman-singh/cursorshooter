/**
 * DOM HUD + full-screen menus. Manipulates ONLY the fixed elements listed in
 * ARCHITECTURE.md "DOM contract" (index.html owns the markup, css/style.css
 * owns the styles — this module toggles classes and textContent only;
 * the only nodes it may create are .kf-entry divs inside #killfeed and
 * <button class="menu-btn"> inside #menu-buttons).
 *
 * Team A = blue/friendly, team B = red/enemy.
 */

// Killfeed lifecycle (seconds) and capacity. KF_FADE_TIME matches the
// .kf-entry.kf-fade CSS opacity transition.
const KF_MAX = 6;
const KF_LIFETIME = 4.0;
const KF_FADE_TIME = 0.5;

const HITMARKER_TIME = 0.25; // visible window (the .hm-flash pop runs 0.18s)
const VIGNETTE_HOLD = 0.09;  // class removed after this; CSS fades it out over 0.4s
const CM_FADE_TIME = 0.6;    // matches the .cm-fade CSS transition

export class HUD {
  /**
   * @param {HTMLElement} root the #app element
   */
  constructor(root) {
    const $ = (sel) => {
      const el = root.querySelector(sel);
      if (!el) throw new Error(`HUD: required element "${sel}" missing under #app`);
      return el;
    };

    this.el = {
      hud: $('#hud'),
      hitmarker: $('#hitmarker'),
      vignette: $('#damage-vignette'),
      healthFill: $('#health-bar-fill'),
      healthText: $('#health-text'),
      ammoMag: $('#ammo-mag'),
      ammoReserve: $('#ammo-reserve'),
      reloadHint: $('#reload-hint'),
      scoreA: $('#score-a'),
      scoreB: $('#score-b'),
      timer: $('#match-timer'),
      killfeed: $('#killfeed'),
      centerMessage: $('#center-message'),
      gamepad: $('#gamepad-indicator'),
      menu: $('#menu'),
      menuTitle: $('#menu-title'),
      menuSubtitle: $('#menu-subtitle'),
      menuButtons: $('#menu-buttons'),
      menuHint: $('#menu-hint'),
    };

    /** @type {import('../engine/input.js').InputManager|null} */
    this.input = null;
    this._onMenuAction = null;

    // Timed-effect state (seconds, counted down in update()).
    this._hmTimer = 0;
    this._hmKill = false;   // sticky red styling for the current flash window
    this._dvTimer = 0;
    this._cmTimer = 0;      // 0 = sticky or hidden
    this._cmFading = false;

    /** @type {{ el: HTMLElement, age: number, fading: boolean }[]} */
    this._kfEntries = [];

    // Menu navigation state.
    this._menuVisible = false;
    this._menuScreen = null;
    /** @type {HTMLButtonElement[]} */
    this._menuButtons = [];
    this._menuIndex = 0;

    this._onKeyDown = (e) => this._handleKeyDown(e);
    window.addEventListener('keydown', this._onKeyDown);
  }

  /** Show the in-game HUD layer. */
  showHUD() {
    this.el.hud.classList.remove('hidden');
  }

  /** Hide the in-game HUD layer. */
  hideHUD() {
    this.el.hud.classList.add('hidden');
  }

  /** @param {number} health 0..100 — updates bar width, .hp-low under 35, and text */
  setHealth(health) {
    const h = Math.max(0, Math.min(100, health));
    this.el.healthFill.style.width = `${h}%`;
    this.el.healthFill.classList.toggle('hp-low', h < 35);
    this.el.healthText.textContent = String(Math.round(h));
  }

  /** @param {number} mag @param {number|string} reserve (Infinity shown as ∞) */
  setAmmo(mag, reserve) {
    this.el.ammoMag.textContent = String(mag);
    this.el.ammoReserve.textContent =
      reserve === Infinity || reserve === 'Infinity' ? '∞' : String(reserve);
  }

  /** @param {boolean} isReloading toggles #reload-hint */
  setReloading(isReloading) {
    this.el.reloadHint.classList.toggle('hidden', !isReloading);
  }

  /** @param {number} a team A kills @param {number} b team B kills */
  setScore(a, b) {
    this.el.scoreA.textContent = String(a);
    this.el.scoreB.textContent = String(b);
  }

  /** @param {number} seconds elapsed match time — rendered m:ss */
  setTimer(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    this.el.timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Append a killfeed entry "Killer ☠ Victim" (names colored by team),
   * fading and removing it after ~4s. Cap the feed at ~6 entries.
   * @param {{ killer: string, victim: string, killerTeam: 'A'|'B', victimTeam: 'A'|'B' }} entry
   */
  addKillFeed(entry) {
    const el = document.createElement('div');
    el.className = 'kf-entry';

    const killer = document.createElement('span');
    killer.className = entry.killerTeam === 'B' ? 'team-b' : 'team-a';
    killer.textContent = entry.killer;

    const sep = document.createElement('span');
    sep.className = 'kf-x';
    sep.textContent = '☠';

    const victim = document.createElement('span');
    victim.className = entry.victimTeam === 'B' ? 'team-b' : 'team-a';
    victim.textContent = entry.victim;

    el.append(killer, sep, victim);
    this.el.killfeed.appendChild(el);
    this._kfEntries.push({ el, age: 0, fading: false });

    // Cap the feed: over-limit oldest entries are dropped immediately.
    while (this._kfEntries.length > KF_MAX) {
      this._kfEntries.shift().el.remove();
    }
  }

  /**
   * Flash the crosshair hitmarker (red when kill=true). Auto-hides.
   * @param {boolean} kill
   */
  showHitmarker(kill) {
    const hm = this.el.hitmarker;
    if (kill) this._hmKill = true; // red stays until the flash window ends
    hm.classList.toggle('hm-kill', this._hmKill);
    hm.classList.remove('hidden');
    // Restart the pop animation on every hit.
    hm.classList.remove('hm-flash');
    void hm.offsetWidth; // force reflow so the animation re-triggers
    hm.classList.add('hm-flash');
    this._hmTimer = HITMARKER_TIME;
  }

  /** Red edge flash (#damage-vignette .dv-flash) when the local player is hurt. */
  showDamageFlash() {
    this.el.vignette.classList.add('dv-flash');
    this._dvTimer = VIGNETTE_HOLD;
  }

  /**
   * Big centered announcement text.
   * @param {string} text
   * @param {number} [seconds] auto-hide after this long; 0/undefined = sticky
   * @param {string} [styleClass] '', 'cm-win' or 'cm-lose'
   */
  setCenterMessage(text, seconds, styleClass) {
    const cm = this.el.centerMessage;
    this._cmTimer = 0;
    this._cmFading = false;
    cm.classList.remove('cm-win', 'cm-lose', 'cm-fade');

    if (!text) {
      cm.classList.add('hidden');
      cm.textContent = '';
      return;
    }

    cm.textContent = text;
    if (styleClass) cm.classList.add(styleClass);
    cm.classList.remove('hidden');

    if (seconds > 0) this._cmTimer = seconds;
  }

  /** @param {boolean} connected show/hide #gamepad-indicator */
  setGamepadConnected(connected) {
    this.el.gamepad.classList.toggle('hidden', !connected);
  }

  /**
   * Show a full-screen menu, rebuilding #menu-buttons from data.buttons.
   * 'start' and 'gameover' should also fill title/subtitle/hint from data.
   * Keyboard (arrows+Enter) and controller (input.getMenuNav + 'activate')
   * move a .mb-focused selection; activation fires the onMenuAction callback.
   * @param {'start'|'pause'|'gameover'} screen
   * @param {{ title?: string, subtitle?: string, hint?: string,
   *   buttons: { id: string, label: string }[] }} data
   */
  showMenu(screen, data) {
    const { menu, menuTitle, menuSubtitle, menuButtons, menuHint } = this.el;
    const buttons = (data && data.buttons) || [];

    if (data) {
      if (data.title !== undefined) {
        menuTitle.textContent = data.title;
        // Team-colored title glow on the game-over screen.
        menuTitle.classList.toggle('mn-red', /red team|defeat/i.test(data.title));
        menuTitle.classList.toggle('mn-blue', /blue team|victory/i.test(data.title));
      }
      if (data.subtitle !== undefined) menuSubtitle.textContent = data.subtitle;
      if (data.hint !== undefined) menuHint.textContent = data.hint;
    }

    menuButtons.replaceChildren();
    this._menuButtons = buttons.map((b, i) => {
      const btn = document.createElement('button');
      btn.className = 'menu-btn';
      btn.dataset.action = b.id;
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        // Drop DOM focus so a later Enter can't re-trigger this button's click
        // alongside the 'activate' handling in update().
        btn.blur();
        this._setFocus(i);
        this._fireMenuAction(b.id);
      });
      btn.addEventListener('mouseenter', () => this._setFocus(i));
      menuButtons.appendChild(btn);
      return btn;
    });

    this._menuScreen = screen;
    this._menuIndex = 0;
    this._applyFocus();
    this._menuVisible = true;
    menu.classList.remove('hidden');
  }

  /** Hide the menu overlay. */
  hideMenu() {
    this._menuVisible = false;
    this.el.menu.classList.add('hidden');
    this.el.menuButtons.replaceChildren();
    this._menuButtons = [];
    this._menuIndex = 0;
  }

  /**
   * @param {(actionId: string) => void} cb called with the activated button's id
   */
  onMenuAction(cb) {
    this._onMenuAction = cb;
  }

  /**
   * Per-frame housekeeping: timed fades (hitmarker, vignette, center message),
   * killfeed expiry, and controller/keyboard menu navigation.
   * Needs the InputManager for menu nav — receive it here (set this.input first
   * via the wireInput method below).
   * @param {number} dt seconds
   */
  update(dt) {
    // Hitmarker auto-hide.
    if (this._hmTimer > 0) {
      this._hmTimer -= dt;
      if (this._hmTimer <= 0) {
        this._hmKill = false;
        this.el.hitmarker.classList.add('hidden');
        this.el.hitmarker.classList.remove('hm-flash', 'hm-kill');
      }
    }

    // Damage vignette: hold briefly, then let the CSS transition fade it out.
    if (this._dvTimer > 0) {
      this._dvTimer -= dt;
      if (this._dvTimer <= 0) this.el.vignette.classList.remove('dv-flash');
    }

    // Center message auto-hide: fade out first, then hide.
    if (this._cmTimer > 0) {
      this._cmTimer -= dt;
      if (this._cmTimer <= 0) {
        if (!this._cmFading) {
          this._cmFading = true;
          this._cmTimer = CM_FADE_TIME;
          this.el.centerMessage.classList.add('cm-fade');
        } else {
          this._cmFading = false;
          this.el.centerMessage.classList.add('hidden');
          this.el.centerMessage.classList.remove('cm-fade');
          this.el.centerMessage.textContent = '';
        }
      }
    }

    // Killfeed expiry.
    for (let i = this._kfEntries.length - 1; i >= 0; i--) {
      const kf = this._kfEntries[i];
      kf.age += dt;
      if (!kf.fading && kf.age >= KF_LIFETIME - KF_FADE_TIME) {
        kf.fading = true;
        kf.el.classList.add('kf-fade');
      }
      if (kf.age >= KF_LIFETIME) {
        kf.el.remove();
        this._kfEntries.splice(i, 1);
      }
    }

    if (this.input) {
      // Keep the indicator in sync even if main.js never calls the setter.
      this.setGamepadConnected(this.input.isGamepadConnected());

      // Controller menu navigation (keyboard arrows handled via keydown;
      // Enter reaches us through input's 'activate' = gamepad A / Enter).
      if (this._menuVisible) {
        const nav = this.input.getMenuNav();
        if (nav.y !== 0) this._moveFocus(nav.y);
        if (this.input.wasPressed('activate')) this._activateFocused();
      }
    }
  }

  /**
   * Give the HUD access to input for controller menu navigation.
   * Called once by main.js after constructing both.
   * @param {import('../engine/input.js').InputManager} input
   */
  wireInput(input) {
    this.input = input;
  }

  // ---------------------------------------------------------------- private

  /** Arrow-key menu navigation; active only while a menu is visible. */
  _handleKeyDown(e) {
    if (!this._menuVisible || this._menuButtons.length === 0) return;
    switch (e.code) {
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        this._moveFocus(-1);
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        this._moveFocus(1);
        break;
      // Enter is deliberately NOT handled here: InputManager reports it via
      // wasPressed('activate'), so handling it too would fire actions twice.
    }
  }

  _moveFocus(dir) {
    const n = this._menuButtons.length;
    if (n === 0) return;
    this._menuIndex = ((this._menuIndex + dir) % n + n) % n;
    this._applyFocus();
  }

  _setFocus(index) {
    if (index < 0 || index >= this._menuButtons.length) return;
    this._menuIndex = index;
    this._applyFocus();
  }

  _applyFocus() {
    this._menuButtons.forEach((btn, i) => {
      btn.classList.toggle('mb-focused', i === this._menuIndex);
    });
  }

  _activateFocused() {
    const btn = this._menuButtons[this._menuIndex];
    if (btn) this._fireMenuAction(btn.dataset.action);
  }

  _fireMenuAction(actionId) {
    if (this._onMenuAction) this._onMenuAction(actionId);
  }
}
