/* ===========================
   PAUL FRITZ — PHYSICS OVERLAY
   Three.js + Rapier
   Frontal box, telephoto camera (20° FOV)
   100 objects fall and pile up.
   =========================== */

async function initPhysics() {

  const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js');
  const RAPIER = await import('https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js');
  await RAPIER.init();

  // ---- CANVAS OVERLAY ----
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
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

  // ---- CAMERA — telephoto 20° FOV ----
  const FOV = 20;
  const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 500);

  // ---- LIGHTS ----
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 20, 10);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  scene.add(dirLight);

  // ---- BOX DIMENSIONS ----
  // The visible box at z=0 covers exactly the screen.
  // Box depth: ~3 units (room for 2-2.5 objects deep)
  const BOX_DEPTH = 3;
  const BOX_HEIGHT_EXTRA = 60; // box extends far above screen for spawning

  // Physics world (recreated on resize)
  let world, groundBody, wallBodies = [];
  let visibleHeight, visibleWidth, groundY, spawnY, camDist;

  function computeDimensions() {
    const aspect = window.innerWidth / window.innerHeight;
    // Distance camera needs to be so visible height = world height
    // We fix world height = 20 units, compute cam distance
    visibleHeight = 20;
    visibleWidth = visibleHeight * aspect;
    camDist = visibleHeight / (2 * Math.tan((FOV * Math.PI / 180) / 2));
    groundY = -visibleHeight / 2;
    spawnY = visibleHeight / 2 + 5;
    camera.position.set(0, 0, camDist);
    camera.lookAt(0, 0, 0);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  }

  function buildPhysicsWorld() {
    // Destroy old world if exists
    if (world) world.free();
    wallBodies = [];

    world = new RAPIER.World({ x: 0, y: -20, z: 0 });

    const hw = visibleWidth / 2;
    const hh = BOX_HEIGHT_EXTRA;
    const hd = BOX_DEPTH / 2;
    const wallThickness = 0.5;

    // Ground
    const g = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, groundY - wallThickness, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(hw + 1, wallThickness, hd + 1), g);
    wallBodies.push(g);

    // Left wall
    const wl = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-hw - wallThickness, groundY + hh, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(wallThickness, hh, hd + 1), wl);
    wallBodies.push(wl);

    // Right wall
    const wr = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(hw + wallThickness, groundY + hh, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(wallThickness, hh, hd + 1), wr);
    wallBodies.push(wr);

    // Front wall (z+)
    const wf = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, groundY + hh, hd + wallThickness));
    world.createCollider(RAPIER.ColliderDesc.cuboid(hw + 1, hh, wallThickness), wf);
    wallBodies.push(wf);

    // Back wall (z-)
    const wb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, groundY + hh, -hd - wallThickness));
    world.createCollider(RAPIER.ColliderDesc.cuboid(hw + 1, hh, wallThickness), wb);
    wallBodies.push(wb);
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

  function spawnObject() {
    const type = objectTypes[Math.floor(Math.random() * objectTypes.length)];
    const size = 0.4 + Math.random() * 0.8;
    const mat = materials[Math.floor(Math.random() * materials.length)];

    let geometry, colliderDesc;
    const hd = BOX_DEPTH / 2;

    if (type === 'box') {
      const w = size, h = size * (0.6 + Math.random() * 0.8), d = size * (0.4 + Math.random() * 0.3);
      geometry = new THREE.BoxGeometry(w * 2, h * 2, d * 2);
      colliderDesc = RAPIER.ColliderDesc.cuboid(w, h, d).setRestitution(0.3).setFriction(0.8);
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

    // Spawn within box bounds
    const x = (Math.random() - 0.5) * visibleWidth * 0.85;
    const z = (Math.random() - 0.5) * (BOX_DEPTH * 0.7);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, spawnY + Math.random() * 5, z)
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

  // ---- RESIZE ----
  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    computeDimensions();
    // Rebuild walls — objects keep their bodies but walls adjust
    buildPhysicsWorld();
  });

  // ---- INIT ----
  computeDimensions();
  buildPhysicsWorld();

  // ---- ANIMATION LOOP ----
  const quaternion = new THREE.Quaternion();

  function animate(time) {
    requestAnimationFrame(animate);

    if (spawnedCount < OBJECT_COUNT && time - lastSpawnTime > SPAWN_INTERVAL) {
      spawnObject();
      spawnedCount++;
      lastSpawnTime = time;
    }

    world.step();

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
