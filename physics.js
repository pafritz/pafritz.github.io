/* ===========================
   PAUL FRITZ — PHYSICS OVERLAY
   Three.js + Rapier instancing
   100 objects fall, pile up, stop.
   Transparent overlay over the site.
   =========================== */

async function initPhysics() {

  // Load Three.js and Rapier from CDN
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
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,        // transparent background
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // ---- SCENE ----
  const scene = new THREE.Scene();
  // No background — transparent

  // ---- CAMERA ----
  // Frontal orthographic-like perspective, looking straight ahead
  const fov = 60;
  const camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);

  // ---- LIGHTS ----
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(10, 20, 10);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  scene.add(dirLight);

  // ---- WORLD DIMENSIONS ----
  // Calculate visible world height at z=0
  const visibleHeight = 2 * Math.tan((fov * Math.PI / 180) / 2) * 30;
  const visibleWidth = visibleHeight * (window.innerWidth / window.innerHeight);
  const groundY = -visibleHeight / 2;
  const spawnY = visibleHeight / 2 + 2; // just above top of screen

  // ---- RAPIER WORLD ----
  const gravity = { x: 0.0, y: -20.0, z: 0.0 };
  const world = new RAPIER.World(gravity);

  // ---- INVISIBLE GROUND ----
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, groundY - 0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(visibleWidth, 0.5, 10), groundBody);

  // Invisible left/right walls to keep things in view
  const wallL = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-visibleWidth / 2 - 0.5, 0, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, visibleHeight * 2, 10), wallL);
  const wallR = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(visibleWidth / 2 + 0.5, 0, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, visibleHeight * 2, 10), wallR);

  // ---- OBJECT TYPES ----
  const OBJECT_COUNT = 100;
  const objectTypes = ['box', 'sphere', 'cylinder'];

  // Material — simple, slightly transparent white/light grey
  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.1 }),
    new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.4, metalness: 0.2 }),
    new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5, metalness: 0.1 }),
  ];

  // Store meshes and bodies
  const objects = [];
  let spawnedCount = 0;
  let lastSpawnTime = 0;
  const SPAWN_INTERVAL = 150; // ms between spawns

  function spawnObject() {
    const type = objectTypes[Math.floor(Math.random() * objectTypes.length)];
    const size = 0.4 + Math.random() * 0.8;
    const mat = materials[Math.floor(Math.random() * materials.length)];

    let geometry, colliderDesc;

    if (type === 'box') {
      const w = size, h = size * (0.6 + Math.random() * 0.8), d = size * (0.6 + Math.random() * 0.4);
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

    // Random horizontal position within visible width
    const x = (Math.random() - 0.5) * visibleWidth * 0.8;
    const z = (Math.random() - 0.5) * 2; // slight z spread for depth

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, spawnY, z)
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
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- ANIMATION LOOP ----
  const clock = new THREE.Clock();
  const quaternion = new THREE.Quaternion();

  function animate(time) {
    requestAnimationFrame(animate);

    // Spawn objects over time
    if (spawnedCount < OBJECT_COUNT && time - lastSpawnTime > SPAWN_INTERVAL) {
      spawnObject();
      spawnedCount++;
      lastSpawnTime = time;
    }

    // Step physics
    world.step();

    // Sync Three.js meshes with Rapier bodies
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

// Start physics after page load
window.addEventListener('load', () => {
  // Small delay so the page renders first
  setTimeout(initPhysics, 500);
});
