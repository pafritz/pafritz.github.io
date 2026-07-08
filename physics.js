/* ===========================
   PAUL FRITZ — PHYSICS OVERLAY
   Three.js + Rapier
   Kinematic walls that follow window resize smoothly
   =========================== */

async function initPhysics() {

  const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js');
  const RAPIER = await import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js');
  await RAPIER.init();

  // ---- CANVAS OVERLAY ----
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100%;
    height: 100%;
    height: 100dvh;
    pointer-events: none;
    z-index: 500;
  `;
  document.body.appendChild(canvas);

  // ---- RENDERER ----
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // ---- SCENE ----
  const scene = new THREE.Scene();

  // ---- CAMERA — 20° FOV telephoto ----
  const FOV = 20;
  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 500);

  // ---- LIGHTS ----
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 20, 10);
  dirLight.castShadow = true;
  scene.add(dirLight);

  // ---- WORLD ----
  const BOX_DEPTH = 3;
  const WORLD_HEIGHT = 20;
  const WALL_THICKNESS = 0.5;
  const BOX_HEIGHT_EXTRA = 60;

  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });

  // Current box dims (updated every frame from window size)
  let dims = computeDims();

  function computeDims() {
    const aspect = window.innerWidth / window.innerHeight;
    const viewH = window.visualViewport?.height || window.innerHeight;
    const viewW = window.innerWidth;
    const visH = WORLD_HEIGHT;
    const visW = visH * (viewW / viewH);
    const camDist = visH / (2 * Math.tan((FOV * Math.PI / 180) / 2));
    const groundY = -visH / 2;
    const spawnY = visH / 2 + 5;
    return { visH, visW, camDist, groundY, spawnY, aspect: viewW / viewH };
  }

  function updateCamera(d) {
    camera.position.set(0, 0, d.camDist);
    camera.lookAt(0, 0, 0);
    camera.aspect = d.aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.visualViewport?.height || window.innerHeight);
    shadowPlane.position.y = d.groundY;
  }

  // ---- KINEMATIC WALLS ----
  // 5 walls: ground, left, right, front, back
  function createKinematicWall() {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    return body;
  }

  const wallGround = createKinematicWall();
  const wallLeft   = createKinematicWall();
  const wallRight  = createKinematicWall();
  const wallFront  = createKinematicWall();
  const wallBack   = createKinematicWall();

  // Colliders attached once — half-extents updated via setNextKinematicTranslation
  // Unfortunately Rapier doesn't let us resize colliders, so we use large fixed extents
  // and only animate position. For the ground/ceiling we make them very wide.
  const hd = BOX_DEPTH / 2;
  const bigW = 200; // large enough for any window size
  const bigH = BOX_HEIGHT_EXTRA;

  world.createCollider(RAPIER.ColliderDesc.cuboid(bigW, WALL_THICKNESS, hd + WALL_THICKNESS), wallGround);
  world.createCollider(RAPIER.ColliderDesc.cuboid(WALL_THICKNESS, bigH, hd + WALL_THICKNESS), wallLeft);
  world.createCollider(RAPIER.ColliderDesc.cuboid(WALL_THICKNESS, bigH, hd + WALL_THICKNESS), wallRight);
  world.createCollider(RAPIER.ColliderDesc.cuboid(bigW, bigH, WALL_THICKNESS), wallFront);
  world.createCollider(RAPIER.ColliderDesc.cuboid(bigW, bigH, WALL_THICKNESS), wallBack);

  function updateWalls(d) {
    const hw = d.visW / 2;
    const centerY = d.groundY + BOX_HEIGHT_EXTRA;

    wallGround.setNextKinematicTranslation({ x: 0, y: d.groundY - WALL_THICKNESS, z: 0 });
    wallLeft.setNextKinematicTranslation({   x: -hw - WALL_THICKNESS, y: centerY, z: 0 });
    wallRight.setNextKinematicTranslation({  x:  hw + WALL_THICKNESS, y: centerY, z: 0 });
    wallFront.setNextKinematicTranslation({  x: 0, y: centerY, z:  hd + WALL_THICKNESS });
    wallBack.setNextKinematicTranslation({   x: 0, y: centerY, z: -hd - WALL_THICKNESS });
  }

  // ---- MATERIALS ----
  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1 }),
    new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.4, metalness: 0.2 }),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5, metalness: 0.1 }),
  ];

  // ---- OBJECTS ----
  const OBJECT_COUNT = 100;
  const objectTypes = ['box', 'sphere', 'cylinder'];
  const objects = [];
  let spawnedCount = 0;
  let lastSpawnTime = 0;
  const SPAWN_INTERVAL = 150;

  function spawnObject(d) {
    const type = objectTypes[Math.floor(Math.random() * objectTypes.length)];
    const size = 0.4 + Math.random() * 0.8;
    const mat = materials[Math.floor(Math.random() * materials.length)];

    let geometry, colliderDesc;

    if (type === 'box') {
      const w = size, h = size * (0.6 + Math.random() * 0.8), dep = size * (0.3 + Math.random() * 0.3);
      geometry = new THREE.BoxGeometry(w * 2, h * 2, dep * 2);
      colliderDesc = RAPIER.ColliderDesc.cuboid(w, h, dep).setRestitution(0.3).setFriction(0.8);
    } else if (type === 'sphere') {
      const r = size * 0.6;
      geometry = new THREE.SphereGeometry(r, 16, 16);
      colliderDesc = RAPIER.ColliderDesc.ball(r).setRestitution(0.5).setFriction(0.5);
    } else {
      const r = size * 0.4;
      const h = size * 0.9;
      geometry = new THREE.CylinderGeometry(r, r, h * 2, 12);
      colliderDesc = RAPIER.ColliderDesc.cylinder(h, r).setRestitution(0.2).setFriction(0.9);
    }

    const x = (Math.random() - 0.5) * d.visW * 0.85;
    const z = (Math.random() - 0.5) * (BOX_DEPTH * 0.7);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, d.spawnY + Math.random() * 5, z)
      .setRotation({ x: Math.random(), y: Math.random(), z: Math.random(), w: 1 })
      .setLinearDamping(0.1)
      .setAngularDamping(0.3);

    const body = world.createRigidBody(bodyDesc);
    world.createCollider(colliderDesc, body);

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    objects.push({ mesh, body });
  }

  // ---- SHADOW PLANE ----
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: 0.25 })
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  // ---- POINTER INTERACTION ----
  // pointer-events: auto so we can capture touch/mouse
  canvas.style.pointerEvents = 'auto';

  const pointer = { x: null, y: null, active: false };
  const FORCE_RADIUS = 10;   // world units
  const FORCE_STRENGTH = 5;

  function screenToWorld(clientX, clientY, d) {
    // Convert screen coords to world coords at z=0
    const nx = (clientX / window.innerWidth) * 2 - 1;
    const ny = -(clientY / (window.visualViewport?.height || window.innerHeight)) * 2 + 1;
    const worldX = nx * d.visW / 2;
    const worldY = ny * d.visH / 2;
    return { x: worldX, y: worldY };
  }

  canvas.addEventListener('mousemove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  });

  canvas.addEventListener('mouseleave', () => {
    pointer.active = false;
  });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault(); // prevent scroll only during move
    const t = e.touches[0];
    pointer.x = t.clientX;
    pointer.y = t.clientY;
    pointer.active = true;
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    pointer.active = false;
  });

  // Pass taps through to the site below
  canvas.addEventListener('click', (e) => {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el) el.click();
    canvas.style.pointerEvents = 'auto';
  });

  function applyForceField(d) {
    if (!pointer.active || pointer.x === null) return;
    const wp = screenToWorld(pointer.x, pointer.y, d);

    for (const obj of objects) {
      const pos = obj.body.translation();
      const dx = pos.x - wp.x;
      const dy = pos.y - wp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < FORCE_RADIUS && dist > 0.01) {
        const falloff = 1 - dist / FORCE_RADIUS;
        const force = falloff * falloff * FORCE_STRENGTH;
        obj.body.applyImpulse(
          { x: (dx / dist) * force, y: (dy / dist) * force, z: 0 },
          true
        );
      }
    }
  }

  // ---- RESIZE ----
  let lastWidth = window.innerWidth;
  const onResize = () => {
    // Always recompute — visualViewport handles address bar correctly
    dims = computeDims();
    lastWidth = window.innerWidth;
  };
  window.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);

  // ---- INIT ----
  updateCamera(dims);
  updateWalls(dims);

  // ---- ANIMATION LOOP ----
  const quaternion = new THREE.Quaternion();

  function animate(time) {
    requestAnimationFrame(animate);

    // Recompute dims every frame — walls follow smoothly
    updateCamera(dims);
    updateWalls(dims);

    // Spawn
    if (spawnedCount < OBJECT_COUNT && time - lastSpawnTime > SPAWN_INTERVAL) {
      spawnObject(dims);
      spawnedCount++;
      lastSpawnTime = time;
    }

    applyForceField(dims);
    world.step();

    // Sync meshes
    for (const obj of objects) {
      const pos = obj.body.translation();
      const rot = obj.body.rotation();
      obj.mesh.position.set(pos.x, pos.y, pos.z);
      quaternion.set(rot.x, rot.y, rot.z, rot.w);
      obj.mesh.quaternion.copy(quaternion);
    }

    renderer.render(scene, camera);
  }

  animate(0);
}

window.addEventListener('load', () => setTimeout(initPhysics, 500));
