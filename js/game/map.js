import * as THREE from 'three';

/**
 * Builds the arena: all geometry added to `scene`, every solid registered
 * as an AABB collider via `physics.addCollider`.
 *
 * Layout: 60m x 40m interior bounded by 4m walls, 180° rotational symmetry
 * ((x,z) -> (-x,-z)). Team A (blue accents) holds the -X end, team B (red)
 * the +X end. Each side has an elevated corner platform (deck 2.2m) reached
 * by a stepped ramp — physics only knows AABBs, so ramps are staircases of
 * shallow 0.2m steps that capsules can climb. Crates (1.2m shoot-over /
 * 2.0m full cover) and low walls (1.1m, shoot-over) fill the midfield.
 *
 * @param {THREE.Scene} scene
 * @param {import('../engine/physics.js').PhysicsWorld} physics
 * @returns {{
 *   spawnPoints: { A: THREE.Vector3[], B: THREE.Vector3[] },
 *   spawnYaw: { A: number, B: number },
 *   waypoints: THREE.Vector3[],
 *   bounds: THREE.Box3
 * }}
 *   spawnPoints: feet positions; spawnYaw: facing the arena center (rad, around Y),
 *   using the three.js FPS convention look = (-sin(yaw), 0, -cos(yaw)) — so team A
 *   on -X faces +X with yaw = -PI/2. bounds: playable area box (floor included).
 */
export function buildMap(scene, physics) {
  // Interior half-extents (m). X is the team axis: A at -X, B at +X.
  const HX = 30, HZ = 20;
  const WALL_H = 4, WALL_T = 0.6;
  const DECK = 2.2;                 // platform deck height
  const STEP_RISE = 0.2, STEP_RUN = 0.4;

  // ---- materials ------------------------------------------------------
  // Real CC0 textures (ambientCG.com) with graceful flat-color fallbacks if
  // a file fails to load. Phong so the normal maps add depth.
  const texLoader = new THREE.TextureLoader();
  function tex(url, repX, repY, srgb) {
    const t = texLoader.load(url, undefined, undefined, () => {});
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repX, repY);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  function texMat(colorUrl, normalUrl, repX, repY, fallbackColor, emissiveLift = 0) {
    const m = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 8 });
    m.map = tex(colorUrl, repX, repY, true);
    m.normalMap = tex(normalUrl, repX, repY, false);
    m.normalScale.set(0.7, 0.7);
    if (emissiveLift > 0) {
      // Re-use the color map as a dim self-light so dark textures (wood)
      // don't read as black boxes on faces turned away from the sun.
      m.emissiveMap = m.map;
      m.emissive.setScalar(emissiveLift);
    }
    texLoader.load(colorUrl, undefined, undefined, () => {
      // Texture missing: drop the dead maps so the fallback color shows.
      m.map = null;
      m.normalMap = null;
      m.emissiveMap = null;
      m.color.set(fallbackColor);
      m.needsUpdate = true;
    });
    return m;
  }
  const mat = {
    floor: texMat('assets/textures/floor.jpg', 'assets/textures/floor-normal.jpg', HX + 1, HZ + 1, 0x2e3644),
    wall: texMat('assets/textures/wall.jpg', 'assets/textures/wall-normal.jpg', 15, 1, 0x4a5468),
    wallSide: texMat('assets/textures/wall.jpg', 'assets/textures/wall-normal.jpg', 10, 1, 0x4a5468),
    rib: new THREE.MeshLambertMaterial({ color: 0x566179 }),
    crateA: texMat('assets/textures/crate.jpg', 'assets/textures/crate-normal.jpg', 1, 1, 0x8a7c55, 0.35),
    crateB: texMat('assets/textures/crate.jpg', 'assets/textures/crate-normal.jpg', 1, 1, 0x6f7a68, 0.35),
    lowWall: texMat('assets/textures/wall.jpg', 'assets/textures/wall-normal.jpg', 2, 1, 0x747b87),
    deck: texMat('assets/textures/wall.jpg', 'assets/textures/wall-normal.jpg', 2, 2, 0x4d586c),
    step: texMat('assets/textures/wall.jpg', 'assets/textures/wall-normal.jpg', 1, 0.5, 0x45506a),
    accentA: new THREE.MeshLambertMaterial({ color: 0x0d1f4a, emissive: 0x2a5cff }),
    accentB: new THREE.MeshLambertMaterial({ color: 0x4a0d12, emissive: 0xff3540 }),
    line: new THREE.MeshLambertMaterial({ color: 0x4a5470, emissive: 0x1c2334 }),
  };

  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  /**
   * Box resting with its base at yBase. When `kind` is given a matching AABB
   * collider is registered; kind === null means decorative trim (no collider).
   */
  function box(x, yBase, z, w, h, d, material, kind = null) {
    const mesh = new THREE.Mesh(unitBox, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, yBase + h / 2, z);
    mesh.castShadow = kind !== null;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (kind) {
      physics.addCollider(new THREE.Box3(
        new THREE.Vector3(x - w / 2, yBase, z - d / 2),
        new THREE.Vector3(x + w / 2, yBase + h, z + d / 2)
      ), { kind });
    }
    return mesh;
  }

  // ---- floor + boundary walls -----------------------------------------
  box(0, -0.5, 0, 2 * HX + 2, 0.5, 2 * HZ + 2, mat.floor, 'floor');
  box(-HX - WALL_T / 2, 0, 0, WALL_T, WALL_H, 2 * (HZ + WALL_T), mat.wallSide, 'wall');
  box(HX + WALL_T / 2, 0, 0, WALL_T, WALL_H, 2 * (HZ + WALL_T), mat.wallSide, 'wall');
  box(0, 0, -HZ - WALL_T / 2, 2 * HX, WALL_H, WALL_T, mat.wall, 'wall');
  box(0, 0, HZ + WALL_T / 2, 2 * HX, WALL_H, WALL_T, mat.wall, 'wall');

  // Wall ribs (decor) break up the long side walls.
  for (const rx of [-22.5, -15, -7.5, 7.5, 15, 22.5]) {
    box(rx, 0, -HZ + 0.08, 0.4, WALL_H, 0.18, mat.rib);
    box(rx, 0, HZ - 0.08, 0.4, WALL_H, 0.18, mat.rib);
  }

  // Team-colored glow panels + corner posts on the two end walls.
  for (const [side, accent] of [[-1, mat.accentA], [1, mat.accentB]]) {
    box(side * (HX - 0.06), 1.5, 0, 0.1, 1.0, 2 * HZ - 1, accent);
    box(side * (HX - 0.06), 0, -HZ + 0.5, 0.12, WALL_H, 0.7, accent);
    box(side * (HX - 0.06), 0, HZ - 0.5, 0.12, WALL_H, 0.7, accent);
  }

  // Thin center line on the floor (decor, marks the symmetry axis).
  box(0, 0.005, 0, 0.3, 0.02, 2 * HZ - 0.5, mat.line);

  // ---- platforms + stepped ramps ---------------------------------------
  // Platform A fills the (-X,-Z) corner; its ramp descends toward center (+X).
  // Platform B is the 180° mirror. Steps rise 0.2m each — capsule-climbable.
  box(-26.5, 0, -15.5, 7, DECK, 7, mat.deck, 'platform');
  box(26.5, 0, 15.5, 7, DECK, 7, mat.deck, 'platform');
  const nSteps = Math.round(DECK / STEP_RISE) - 1; // 10 steps, top 0.2 below deck
  for (let i = 0; i < nSteps; i++) {
    const top = DECK - STEP_RISE * (i + 1);
    const cx = -23 + STEP_RUN * (i + 0.5);
    box(cx, 0, -15.5, STEP_RUN, top, 3.2, mat.step, 'step');
    box(-cx, 0, 15.5, STEP_RUN, top, 3.2, mat.step, 'step');
  }

  // Team glow trim around the deck rims (split around the ramp mouth).
  for (const [s, accent] of [[-1, mat.accentA], [1, mat.accentB]]) {
    box(s * 26.5, DECK, s * 18.92, 7.1, 0.06, 0.16, accent);           // far Z edge
    box(s * 26.5, DECK, s * 12.08, 7.1, 0.06, 0.16, accent);           // near Z edge
    box(s * 29.92, DECK, s * 15.5, 0.16, 0.06, 7.1, accent);           // back X edge
    box(s * 23.08, DECK, s * 18.05, 0.16, 0.06, 1.9, accent);          // ramp-side stubs
    box(s * 23.08, DECK, s * 12.95, 0.16, 0.06, 1.9, accent);
  }

  // ---- cover (crates + low walls), 180° symmetric -----------------------
  box(0, 0, 0, 2.5, 2.2, 2.5, mat.crateB, 'crate');              // center block
  box(4, 0, -3, 1.2, 1.2, 1.2, mat.crateA, 'crate');
  box(-4, 0, 3, 1.2, 1.2, 1.2, mat.crateA, 'crate');
  box(0, 0, -7, 5, 1.2, 0.6, mat.lowWall, 'lowwall');
  box(0, 0, 7, 5, 1.2, 0.6, mat.lowWall, 'lowwall');
  box(-16, 0, 0, 2.4, 2.0, 2.4, mat.crateB, 'crate');            // tall stacks
  box(16, 0, 0, 2.4, 2.0, 2.4, mat.crateB, 'crate');
  box(-10, 0, -8, 1.2, 1.2, 1.2, mat.crateA, 'crate');
  box(10, 0, 8, 1.2, 1.2, 1.2, mat.crateA, 'crate');
  box(-10, 0, 8, 1.2, 1.2, 1.2, mat.crateB, 'crate');
  box(10, 0, -8, 1.2, 1.2, 1.2, mat.crateB, 'crate');
  box(-20, 0, -5, 0.5, 1.1, 3.5, mat.lowWall, 'lowwall');        // spawn-side cover
  box(20, 0, 5, 0.5, 1.1, 3.5, mat.lowWall, 'lowwall');
  box(-20, 0, 5, 0.5, 1.1, 3.5, mat.lowWall, 'lowwall');
  box(20, 0, -5, 0.5, 1.1, 3.5, mat.lowWall, 'lowwall');

  // ---- spawns -----------------------------------------------------------
  const spawnsA = [[-27, -8], [-27, 8], [-26, 0], [-22, 12]];
  const spawnPoints = {
    A: spawnsA.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    B: spawnsA.map(([x, z]) => new THREE.Vector3(-x, 0, -z)), // 180° mirror
  };
  for (const [list, accent] of [[spawnPoints.A, mat.accentA], [spawnPoints.B, mat.accentB]]) {
    for (const p of list) box(p.x, 0.005, p.z, 1.8, 0.04, 1.8, accent); // decor pad
  }

  // ---- waypoints (22: open floor + both decks; >=1m from any solid) -----
  const wp = [
    [-26, 0], [26, 0],
    [-20, -10], [20, 10], [-20, 10], [20, -10],
    [-12, 0], [12, 0],
    [-12, -14], [12, 14], [-12, 14], [12, -14],
    [0, -14], [0, 14], [0, -3.5], [0, 3.5],
    [-6, -17], [6, 17],
    [-18, -15.5], [18, 15.5],                       // ramp bases
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  wp.push(new THREE.Vector3(-26.5, DECK, -15.5));   // deck A (ramp runs to its base wp)
  wp.push(new THREE.Vector3(26.5, DECK, 15.5));     // deck B

  const bounds = new THREE.Box3(
    new THREE.Vector3(-HX, -0.5, -HZ),
    new THREE.Vector3(HX, WALL_H, HZ)
  );

  // Yaw 0 looks down -Z: A (-X side) faces +X with -PI/2, B faces -X with PI/2.
  const spawnYaw = { A: -Math.PI / 2, B: Math.PI / 2 };

  return { spawnPoints, spawnYaw, waypoints: wp, bounds };
}
