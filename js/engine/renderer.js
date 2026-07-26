import * as THREE from 'three';

/** Classic sky blue, used for both the clear color and the distance fog. */
const SKY_COLOR = 0x87ceeb;
/** Eye height in meters — matches Combatant.eyeHeight (ARCHITECTURE.md). */
const EYE_HEIGHT = 1.6;

/**
 * Owns the WebGL renderer, scene, camera, lights, sky and fog.
 * Conventions: see ARCHITECTURE.md (meters, Y-up, dt in seconds).
 */
export class Engine {
  /**
   * Sets up: WebGLRenderer (antialias, shadows, sRGB), Scene (sky color + fog),
   * PerspectiveCamera (fov 75, near 0.1, far 500) at eye height,
   * hemisphere + directional light (with shadows), and a window resize listener.
   * @param {HTMLCanvasElement} canvas the #game-canvas element
   */
  constructor(canvas) {
    /** @type {THREE.WebGLRenderer} */
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    /** @type {THREE.Scene} */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_COLOR);
    // Linear distance fog in the sky color: geometry fades into the horizon.
    this.scene.fog = new THREE.Fog(SKY_COLOR, 50, 250);

    /** @type {THREE.PerspectiveCamera} */
    this.camera = new THREE.PerspectiveCamera(
      75, window.innerWidth / window.innerHeight, 0.1, 500
    );
    this.camera.position.set(0, EYE_HEIGHT, 0);
    // The first-person view model (weapons.js) is parented to the camera,
    // so the camera must live in the scene graph for its children to render.
    this.scene.add(this.camera);

    // Soft ambient fill: blue-ish sky above, warm bounce from the ground.
    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b6257, 1.5);
    this.scene.add(hemi);

    // Sun: warm key light, the only shadow caster.
    const sun = new THREE.DirectionalLight(0xfff2e0, 3.0);
    sun.position.set(40, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // Ortho frustum sized to blanket the arena around the origin.
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.scene.add(sun.target); // keep the (origin) target's matrixWorld updated

    /** Seconds accumulated across frames, for ambient animation. */
    this._elapsed = 0;

    window.addEventListener('resize', () => this.onResize());
  }

  /**
   * Render one frame (also advance any ambient animation).
   * @param {number} dt seconds since last frame
   */
  render(dt) {
    this._elapsed += dt;
    this.renderer.render(this.scene, this.camera);
  }

  /** Re-sync renderer size + camera aspect with the window. */
  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
  }
}
