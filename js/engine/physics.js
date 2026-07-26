import * as THREE from 'three';

/** Gravity acceleration, m/s². Used by player + bots. */
export const GRAVITY = -22;

/**
 * Highest ledge (m) a capsule steps up onto automatically. Map ramps are
 * shallow staircases of AABBs, so this must clear a single stair rise while
 * staying below crate/wall height (1–2 m).
 */
const STEP_HEIGHT = 0.5;

/**
 * Depth (m) of the resting-contact probe that keeps `onGround` stable while
 * standing still; also the extra drop used to settle onto a ledge after a step-up.
 */
const GROUND_EPS = 0.04;

/** Motions smaller than this (m) are ignored. */
const MIN_MOTION = 1e-8;

/** Rays with |direction|² below this are treated as degenerate. */
const DIR_EPS_SQ = 1e-12;

/** A direction component below this counts as "parallel to the slab". */
const PARALLEL_EPS = 1e-12;

/**
 * Static-world physics: axis-aligned box colliders, capsule movement,
 * and raycasts against the world and against combatants.
 * Conventions: see ARCHITECTURE.md (feet-position capsules, meters, Y-up).
 *
 * Capsules are treated as their bounding AABB for collision (axis-separated
 * integration); combatant raycasts use true vertical cylinders.
 */
export class PhysicsWorld {
  constructor() {
    /** @type {{ box: THREE.Box3, userData: object }[]} */
    this.colliders = [];
  }

  /**
   * Register a static AABB collider. The box is stored by reference.
   * @param {THREE.Box3} box
   * @param {object} [userData] optional tag (e.g. { kind: 'wall' })
   * @returns {object} the stored collider ({ box: THREE.Box3, userData })
   */
  addCollider(box, userData) {
    if (!box || !box.min || !box.max) throw new TypeError('addCollider expects a THREE.Box3');
    const collider = { box, userData: userData || {} };
    this.colliders.push(collider);
    return collider;
  }

  /** Remove all colliders. */
  clearColliders() {
    this.colliders.length = 0;
  }

  /**
   * Move a vertical capsule (feet at `position`) by velocity*dt, resolving
   * collisions against every collider (slide along walls, land on tops,
   * stop at ceilings). Mutates `position` and `velocity` in place
   * (velocity component zeroed on the axis that was blocked). Ledges up to
   * STEP_HEIGHT are stepped up automatically. Does NOT apply gravity —
   * callers integrate GRAVITY into velocity.y themselves.
   * @param {THREE.Vector3} position feet position — mutated
   * @param {THREE.Vector3} velocity m/s — mutated
   * @param {number} radius capsule radius
   * @param {number} height capsule total height
   * @param {number} dt seconds
   * @returns {{ onGround: boolean }}
   */
  moveCapsule(position, velocity, radius, height, dt) {
    // Substep so no single integration step moves more than a fraction of the
    // capsule's own size — prevents tunneling through thin colliders.
    const maxDisp = Math.max(Math.abs(velocity.x), Math.abs(velocity.y), Math.abs(velocity.z)) * dt;
    const maxStep = Math.min(0.25, radius * 0.5, height * 0.5);
    const steps = Math.max(1, Math.min(8, Math.ceil(maxDisp / maxStep)));
    const subDt = dt / steps;
    let onGround = false;
    for (let i = 0; i < steps; i++) {
      if (this._integrate(position, velocity, radius, height, subDt)) onGround = true;
    }
    return { onGround };
  }

  /**
   * One integration substep: horizontal axes first (with step-up assist),
   * then the vertical axis, then a resting-contact probe. Mutates
   * position/velocity. Returns the grounded flag for this substep.
   */
  _integrate(position, velocity, radius, height, dt) {
    let onGround = false;

    // Horizontal axes, one at a time — motion along the other axis is left
    // untouched when one is blocked, which is what produces wall sliding.
    for (let i = 0; i < 2; i++) {
      const axis = i === 0 ? 'x' : 'z';
      const delta = velocity[axis] * dt;
      if (Math.abs(delta) < MIN_MOTION) continue;
      const dir = delta > 0 ? 1 : -1;
      const start = position[axis];
      position[axis] = start + delta;
      if (!this._resolveAxis(position, radius, height, axis, dir)) continue;

      // Blocked. Retry from a STEP_HEIGHT lift so shallow stairs (ramps) and
      // low ledges can be climbed; accept only if the retry gets strictly
      // further AND settles onto support. Otherwise stay at the contacted face.
      const reached = position[axis];
      const baseY = position.y;
      position.y = baseY + STEP_HEIGHT;
      this._resolveAxis(position, radius, height, 'y', 1); // a ceiling may clamp the lift
      position[axis] = start + delta;
      this._resolveAxis(position, radius, height, axis, dir);
      const stepped = position[axis];
      position.y = baseY - GROUND_EPS; // settle back down; resolve snaps onto a ledge top
      const landed = this._resolveAxis(position, radius, height, 'y', -1);

      if (landed && Math.abs(stepped - start) > Math.abs(reached - start) + 1e-4) {
        onGround = true;
        if (velocity.y < 0) velocity.y = 0;
      } else {
        position[axis] = reached;
        position.y = baseY;
        velocity[axis] = 0;
      }
    }

    // Vertical axis: land on tops, stop at ceilings.
    const dy = velocity.y * dt;
    if (Math.abs(dy) >= MIN_MOTION) {
      const dir = dy > 0 ? 1 : -1;
      position.y += dy;
      if (this._resolveAxis(position, radius, height, 'y', dir)) {
        if (dir < 0) onGround = true;
        velocity.y = 0;
      }
    }

    // Resting-contact probe: keeps onGround stable while standing still,
    // when velocity.y is exactly 0 and the vertical resolve never fires.
    if (!onGround && velocity.y <= 0) {
      let support = -Infinity;
      for (let i = 0; i < this.colliders.length; i++) {
        const box = this.colliders[i].box;
        if (position.x - radius < box.max.x && position.x + radius > box.min.x &&
            position.z - radius < box.max.z && position.z + radius > box.min.z &&
            box.max.y <= position.y + 1e-4 && box.max.y > support) {
          support = box.max.y;
        }
      }
      if (support > -Infinity && position.y - support <= GROUND_EPS) {
        position.y = support;
        velocity.y = 0;
        onGround = true;
      }
    }

    return onGround;
  }

  /**
   * Snap the capsule out of every collider along one axis, opposite to the
   * direction of motion `dir` (+1/-1). The pre-move position is
   * collision-free and only this axis changed, so resolving to the first
   * contacted face resolves all penetrations from this move at once.
   * @returns {boolean} true if contact occurred
   */
  _resolveAxis(position, radius, height, axis, dir) {
    let contact = false;
    let best = dir > 0 ? Infinity : -Infinity;
    for (let i = 0; i < this.colliders.length; i++) {
      const box = this.colliders[i].box;
      if (!this._overlaps(box, position.x, position.y, position.z, radius, height)) continue;
      const candidate = axis === 'y'
        ? (dir > 0 ? box.min.y - height : box.max.y)
        : (dir > 0 ? box.min[axis] - radius : box.max[axis] + radius);
      if (dir > 0 ? candidate < best : candidate > best) best = candidate;
      contact = true;
    }
    if (contact) position[axis] = best;
    return contact;
  }

  /** Strict AABB overlap between the capsule's bounding box and a collider. */
  _overlaps(box, px, py, pz, radius, height) {
    return px - radius < box.max.x && px + radius > box.min.x &&
           py < box.max.y && py + height > box.min.y &&
           pz - radius < box.max.z && pz + radius > box.min.z;
  }

  /**
   * Raycast against static world colliders (slab method per AABB).
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction normalized
   * @param {number} maxDist
   * @returns {{ point: THREE.Vector3, normal: THREE.Vector3, distance: number } | null}
   *   closest hit or null
   */
  raycastWorld(origin, direction, maxDist) {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = direction.x, dy = direction.y, dz = direction.z;
    if (dx * dx + dy * dy + dz * dz < DIR_EPS_SQ) return null;

    let bestT = Infinity;
    let bestNx = 0, bestNy = 0, bestNz = 0;

    for (let c = 0; c < this.colliders.length; c++) {
      const box = this.colliders[c].box;
      let tmin = -Infinity, tmax = Infinity;
      let nx = 0, ny = 0, nz = 0;
      let miss = false;

      // X slab
      if (Math.abs(dx) < PARALLEL_EPS) {
        if (ox < box.min.x || ox > box.max.x) miss = true;
      } else {
        const inv = 1 / dx;
        let t1 = (box.min.x - ox) * inv;
        let t2 = (box.max.x - ox) * inv;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; nx = s; ny = 0; nz = 0; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) miss = true;
      }
      // Y slab
      if (!miss) {
        if (Math.abs(dy) < PARALLEL_EPS) {
          if (oy < box.min.y || oy > box.max.y) miss = true;
        } else {
          const inv = 1 / dy;
          let t1 = (box.min.y - oy) * inv;
          let t2 = (box.max.y - oy) * inv;
          let s = -1;
          if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
          if (t1 > tmin) { tmin = t1; nx = 0; ny = s; nz = 0; }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) miss = true;
        }
      }
      // Z slab
      if (!miss) {
        if (Math.abs(dz) < PARALLEL_EPS) {
          if (oz < box.min.z || oz > box.max.z) miss = true;
        } else {
          const inv = 1 / dz;
          let t1 = (box.min.z - oz) * inv;
          let t2 = (box.max.z - oz) * inv;
          let s = -1;
          if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
          if (t1 > tmin) { tmin = t1; nx = 0; ny = 0; nz = s; }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) miss = true;
        }
      }
      if (miss || tmax < 0) continue;

      const t = tmin > 0 ? tmin : 0; // tmin < 0 → origin inside the box
      if (t <= maxDist && t < bestT) {
        bestT = t;
        if (tmin > 0) { bestNx = nx; bestNy = ny; bestNz = nz; }
        else { bestNx = -dx; bestNy = -dy; bestNz = -dz; } // inside: face the ray
      }
    }

    if (bestT === Infinity) return null;
    const normal = new THREE.Vector3(bestNx, bestNy, bestNz).normalize();
    return {
      point: new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT),
      normal,
      distance: bestT,
    };
  }

  /**
   * Raycast against combatants. Each combatant is a vertical cylinder:
   * axis through combatant.position (feet), spanning y ∈ [feet, feet+height],
   * radius combatant.radius. Skips combatants with `alive === false` and `excludeId`.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction normalized
   * @param {number} maxDist
   * @param {object[]} combatants Combatant-interface objects (see ARCHITECTURE.md)
   * @param {string} [excludeId] id to skip (the shooter)
   * @returns {{ combatant: object, point: THREE.Vector3, distance: number } | null}
   *   closest hit or null
   */
  raycastCombatants(origin, direction, maxDist, combatants, excludeId) {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = direction.x, dy = direction.y, dz = direction.z;
    if (dx * dx + dy * dy + dz * dz < DIR_EPS_SQ) return null;

    let hit = null;
    let bestT = Infinity;
    for (let i = 0; i < combatants.length; i++) {
      const c = combatants[i];
      if (!c || c.alive === false || !c.position) continue;
      if (excludeId !== undefined && c.id === excludeId) continue;
      const t = rayCylinder(
        ox, oy, oz, dx, dy, dz,
        c.position.x, c.position.z,
        c.position.y, c.position.y + c.height,
        c.radius,
      );
      if (t !== null && t <= maxDist && t < bestT) {
        bestT = t;
        hit = c;
      }
    }
    if (!hit) return null;
    return {
      combatant: hit,
      point: new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT),
      distance: bestT,
    };
  }
}

/**
 * Ray vs finite vertical cylinder (axis through (cx, cz), y ∈ [y0, y1],
 * radius r). Infinite-cylinder intersection in XZ clipped to the y slab,
 * which covers side hits and cap hits uniformly. Returns the smallest
 * non-negative hit distance along the (normalized) ray, or null; an origin
 * inside the cylinder reports 0.
 */
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, y0, y1, r) {
  const fx = ox - cx, fz = oz - cz;
  const a = dx * dx + dz * dz;

  if (a < PARALLEL_EPS) {
    // Ray parallel to the cylinder axis — only the caps can be hit.
    if (fx * fx + fz * fz > r * r) return null;
    if (Math.abs(dy) < PARALLEL_EPS) return oy >= y0 && oy <= y1 ? 0 : null;
    let tEnter = (y0 - oy) / dy;
    let tExit = (y1 - oy) / dy;
    if (tEnter > tExit) { const t = tEnter; tEnter = tExit; tExit = t; }
    if (tExit < 0) return null;
    return tEnter > 0 ? tEnter : 0;
  }

  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const inv2a = 1 / (2 * a);
  let tEnter = (-b - sqrtDisc) * inv2a;
  let tExit = (-b + sqrtDisc) * inv2a;

  let tyEnter, tyExit;
  if (Math.abs(dy) < PARALLEL_EPS) {
    if (oy < y0 || oy > y1) return null;
    tyEnter = -Infinity; tyExit = Infinity;
  } else {
    tyEnter = (y0 - oy) / dy;
    tyExit = (y1 - oy) / dy;
    if (tyEnter > tyExit) { const t = tyEnter; tyEnter = tyExit; tyExit = t; }
  }
  tEnter = Math.max(tEnter, tyEnter);
  tExit = Math.min(tExit, tyExit);
  if (tEnter > tExit || tExit < 0) return null;
  return tEnter > 0 ? tEnter : 0;
}
