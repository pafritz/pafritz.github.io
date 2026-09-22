/* ===============================================================
   drift-3d.js — the object layer (§8-10, Appendix A)
   ===============================================================
   Loaded as a module after drift.js. Three.js draws, Rapier
   simulates; both live in vendor/ and resolve through the page's
   importmap, so there is still no build step.

   WHAT IT OWNS
     one fixed canvas, one physics world, one Map of live objects.

   WHAT IT DOES NOT OWN
     the roll. drift-boot.js decides when an object spawns and writes
     a record into state.objects; this file only draws what the
     records say. A record with pose === null has not fallen yet.

   THE PAGE CHANGES UNDER IT, IT DOES NOT CHANGE WITH THE PAGE
     applyDomEvents() rebuilds the document every navigation. This
     layer never touches that cycle: it hangs off the drift:change
     event and re-reads __drift.state each time, because that object
     is replaced -- not mutated -- on a bfcache return and on reset.

   CONTINUITY ACROSS REAL PAGE LOADS
     Every body's position and rotation are written back into its
     record on pagehide, on hide, and whenever the scene falls asleep.
     The next page rebuilds the floor exactly as it was, asleep, and
     only what is new falls. A human reload empties state.objects in
     boot, so the floor clears for free.

   UNITS — REAL CENTIMETRES
     Physics runs in centimetres and every object has a real size:
     the tally model is 5.45 cm tall, a block is a few cm. Pixels per
     centimetre is decided ONCE per device, from the physical screen,
     never from the window (see SCALE), so objects do not grow or
     shrink when the window is resized, and a pile saved on one page
     is the same size on the next.
   =============================================================== */

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { GLTFLoader, RoomEnvironment } from "three/addons";

const drift = window.__drift;
const DEG = Math.PI / 180;

/* -----------------------------------------------------------------
   TUNING — rendering and feel only. Anything about WHEN objects
   appear is in drift-boot.js with the rest of the roll.
   ----------------------------------------------------------------- */

const C = {
  /* SCALE. The tally is tallyPx tall on a large screen, but never
     more than tallyShare of the screen's short side: 270 px on a
     1080p monitor, ~230 on a tablet, ~120 on a phone. */
  tallyPx: 270,
  tallyShare: 0.3,
  tallyCm: 5.45,        /* the model's real height: the ruler */

  gravityPx: 3000,      /* px/s². Set in pixels so a fall across the
                           screen feels the same on every device */
  depthCm: 4.5,         /* half-depth of the slab objects live in */

  /* SHADOWS. The camera looks straight at the page, so the floor is
     seen edge-on and a shadow on it could never be visible. Shadows
     fall instead on the PAGE: an invisible plane at the back of the
     slab that shows nothing but shadow, so objects read as floating
     just above the text. The light comes from the front, a little
     left and above; its direction sets how far shadows are thrown. */
  /* THE PAGE IN THE REFLECTIONS. On project pages, the build's
     low-resolution picture of the layout (miniatures/page-preview.webp,
     starting just under the rule below the nav) is placed behind the
     objects, invisible, casting nothing -- only the metal sees it. */
  pageImage: "miniatures/page-preview.webp",
  pageWidth: 1396,      /* px the picture spans across. null = the page's
                           width. Found with B, then Up / Down (debug) */
  pageFace: "back",     /* where the page sits in the reflections:
                           "back"  behind the objects -- seen only on
                                   edges and surfaces turned away
                           "front" facing them -- seen on everything that
                                   faces the visitor, so the tally darkens
                                   over dark images
                           "both"
                           F cycles them in debug mode, to compare */
  pageImageBlur: 6,     /* px, applied once at load on a 256 px-wide copy */
  pageReach: 2,         /* how far the reflected page extends around the
                           tally, in multiples of the slab's depth: the
                           page is that far behind it */
  envEvery: 100,        /* ms between reflection updates while
                           scrolling; one exact update when it stops */

  shadows: true,
  shadowOpacity: 0.22,  /* 0 to 1 */
  shadowDir: [0.3, -0.15, -1],   /* light travel: x right, y up, z into page */
  shadowBlur: 10,       /* softness of the edges: 1 sharp, 20+ very soft */
  shadowMapSize: 1024,  /* silhouette resolution; halved on phones */
  z: 80,                /* under presence (90) and the lightbox (100) */
  step: 1 / 60,
  maxSteps: 4,
  calmFrames: 20,       /* frames of total stillness before stopping */

  /* STABILITY — found by simulating 60 random drops of the tally.
     A heavy body resting on a light pinned ring is the hardest case
     for the solver; with the defaults a third of the drops never
     came to rest and crept or buzzed on the floor. */
  /* THE TALLY'S FALLS. Each fresh drop (first visit, or a reload
     that cleared the floor) picks one of these at random. Found with
     T / Shift+T in debug mode. An empty list = a new random fall every
     time. They start at rest just above the top of the SCREEN (not the
     window), so each falls the same way on this device whatever the
     window size. On a narrower screen, x is kept inside the walls. */
  tallyDrops: [
    {"x":12.01,"q":[0.4758,-0.2011,-0.642,0.5666],"w":[-2.43,1.69,-0.5],"v":[0,0,0]},
    {"x":15.26,"q":[-0.4109,-0.6433,-0.2503,-0.5956],"w":[-2.18,-2.19,-2.14],"v":[0,0,0]},
    {"x":-7.79,"q":[0.5704,-0.5019,0.108,-0.6412],"w":[1.91,-2.08,0.18],"v":[0,0,0]},
    {"x":-11.85,"q":[0.6607,0.4996,0.5263,0.1922],"w":[-1.67,-0.32,-2.97],"v":[0,0,0]},
    {"x":-1.46,"q":[-0.4148,-0.1404,-0.7881,-0.4327],"w":[0.35,-2.45,-0.9],"v":[0,0,0]},
    {"x":-11.17,"q":[0.6164,0.388,0.6602,0.1834],"w":[-1.11,-2.16,-0.09],"v":[0,0,0]},
    {"x":10.96,"q":[-0.8329,0.0453,-0.4981,0.2367],"w":[0.59,-1.51,1.69],"v":[0,0,0]}
  ],

  solverIterations: 8,  /* Rapier's default is 4 */
  lengthUnit: 5,        /* typical object size in world units (cm), so
                           Rapier's tolerances fit the scene */
  settleSteps: 60,      /* physics steps (one simulated second -- NOT
                           wall-clock time). Any object that moved less
                           than ... */
  settleDist: 0.25,     /* ... cm and ... */
  settleAngle: 3,       /* ... degrees over one window is put to sleep:
                           whatever it was doing, it was not falling */
  dragGain: 18,
  grabStiffness: 0.4,   /* share of the held point's error corrected per
                           step; higher is stiffer, too high jitters */
  dragMaxPx: 4000,      /* px/s: a flick throws, never teleports */
  gripStrength: 10,     /* the most a hand can push, in multiples of the
                           held object's own weight. Plenty to lift and
                           throw; not enough to crush the pile under it
                           into the floor, which is what an unlimited
                           grip did */
  pixelRatioMax: 2,

  /* THE TALLY MODEL */
  modelURL: new URL("models/tally.glb", import.meta.url).href,
  hingeMin: 0,          /* the ring, about its pin, from rest... */
  hingeMax: 230 * DEG,  /* ...to where it would meet the body */
  restDigit: 7,         /* what the wheels show as modelled */
  digitStep: -36 * DEG, /* wheel turn for +1, about its own axle */
  buttonTravel: 0.45,   /* share of the button's length it sinks */

  /* THE PRESS — ms */
  arrivalDelay: 200,    /* after the tally appears, before it presses */
  /* THE PRESS SOUND. One file in sounds/, next to models/, holding the
     whole press (in and back out), started on the frame the button
     starts going in. A missing file is simply silent. */
  sound: "sounds/tally-press.mp3",
  soundVolume: 0.6,       /* 0 to 1 */

  /* LEAVING A PAGE. A new page is not allowed to play sound until it is
     clicked, so the press that counts a link click happens on the page
     being left, inside the click, and the navigation waits for it.
     null = the length of one press; a number = that many ms; 0 = off
     (the press then happens on the next page, silently). Only when
     the sound has loaded -- without it there is nothing to wait for. */
  leaveHold: null,

  pressDown: 90,
  pressUp: 160,
  roll: 220,
  pressGap: 120
};

/* Primitive stand-ins, in cm, full extents. `planar` bodies only
   turn in the plane of the screen, so their face stays toward the
   visitor. */
const SPECIAL = {
  tally:   { size: [4, 5.45, 5], planar: false },  /* only if the model fails */
  speaker: { size: [6, 9, 5], planar: false },
  keys:    { size: [7, 3.5, 1], planar: true }
};

/* -----------------------------------------------------------------
   SCALE — once per device
   screen.* is the physical screen in CSS pixels; it does not change
   when the window does, and its short side survives a rotation.
   ----------------------------------------------------------------- */

const shortSide = Math.min(
  (window.screen && window.screen.width) || window.innerWidth,
  (window.screen && window.screen.height) || window.innerHeight);
const PXCM = Math.min(C.tallyPx, C.tallyShare * shortSide) / C.tallyCm;

/* -----------------------------------------------------------------
   BOOT
   ----------------------------------------------------------------- */

const reduced = () =>
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let W = 0, H = 0;
let renderer, scene, camera, world, bounds, canvas, root;
let model = null;               /* the loaded glTF, or null → primitive */
const objects = new Map();      /* id -> { id, kind, parts:[{body,mesh}], half, dispose } */

if (drift) start().catch((err) => {
  /* Progressive enhancement: no WebGL, no WASM, a blocked file --
     the page is still the page. */
  console.warn("drift-3d: not started", err);
  document.documentElement.classList.add("drift-3d-live");   /* drop the picture */
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
});

async function start() {
  const [, gltf] = await Promise.all([
    RAPIER.init(),
    new GLTFLoader().loadAsync(C.modelURL).catch((err) => {
      console.warn("drift-3d: tally model not loaded, using a stand-in", err);
      return null;
    })
  ]);
  model = gltf;

  canvas = document.createElement("canvas");
  canvas.setAttribute("data-drift-keep", "");   /* sideways must not wrap it */
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:fixed;left:0;top:0;display:block;pointer-events:none;" +
    "z-index:" + C.z + ";";

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, C.pixelRatioMax));

  /* A DIRECT CHILD OF BODY, appended last. Anything drift wraps is
     transformed, and a transformed ancestor turns position:fixed
     into position:absolute. */
  document.body.appendChild(canvas);
  watchLightbox();

  scene = new THREE.Scene();

  /* The environment the metal reflects: a generated room, plus -- on
     project pages -- the page itself behind the objects (PAGE IN THE
     REFLECTIONS, below). */
  setupEnvironment();

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-0.6, 1, 0.8);
  scene.add(sun);

  /* Orthographic, straight on, the camera in CSS pixels with the
     origin at the bottom centre of the viewport. Objects live in
     `root`, in centimetres, scaled up by PXCM. */
  camera = new THREE.OrthographicCamera(0, 1, 1, 0, -4000, 4000);
  camera.position.set(0, 0, 2000);
  root = new THREE.Group();
  root.scale.setScalar(PXCM);
  scene.add(root);
  if (C.shadows) setupShadows();

  world = new RAPIER.World({ x: 0, y: -C.gravityPx / PXCM, z: 0 });
  world.timestep = C.step;
  world.numSolverIterations = C.solverIterations;
  world.lengthUnit = C.lengthUnit;

  injectStyle();
  loadSounds();
  measure();
  sync();

  document.addEventListener("drift:change", onChange);
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onScrollEnv, { passive: true });
  window.addEventListener("pagehide", () => { finishPress(); savePoses(); snapshot(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { savePoses(); pause(); }
    else wake();
  });
  bindPointer();

  drift.drop = debugDrop;
  drift.tallyDrop = debugTallyDrop;
  drift.leaveHold = leaveHold;
  bindDropKeys();
  loadPageImage();
  drift.objects3d = { objects, world, scene, C, PXCM, snapshot, env };
}

function injectStyle() {
  const style = document.createElement("style");
  style.textContent =
    "html.drift-3d-hover,html.drift-3d-hover *{cursor:grab!important}" +
    "html.drift-3d-grabbing,html.drift-3d-grabbing *{cursor:grabbing!important;" +
    "-webkit-user-select:none!important;user-select:none!important}";
  document.head.appendChild(style);
}

/* -----------------------------------------------------------------
   VIEWPORT
   The floor is the bottom of the screen and the walls are its
   edges, so a resize moves the room -- and only the room. Anything
   left outside the new walls is put back inside.
   ----------------------------------------------------------------- */

function measure() {
  W = document.documentElement.clientWidth || window.innerWidth;
  H = window.innerHeight;

  renderer.setSize(W, H, true);
  camera.left = -W / 2;
  camera.right = W / 2;
  camera.top = H;
  camera.bottom = 0;
  camera.updateProjectionMatrix();

  if (shadow) fitShadows();
  buildBounds();
}

function buildBounds() {
  if (bounds) world.removeRigidBody(bounds);
  bounds = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  const w = W / 2 / PXCM;
  const d = C.depthCm;
  const t = 5;                          /* wall thickness, cm */
  const tall = (H / PXCM) * 4 + 50;     /* far above the screen, so a
                                           thrown object comes back */
  const add = (hx, hy, hz, x, y, z) => world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z).setFriction(0.8), bounds);

  add(w + 2 * t, t, d + 2 * t, 0, -t, 0);            /* floor */
  add(t, tall, d + 2 * t, -w - t, tall - t, 0);       /* left  */
  add(t, tall, d + 2 * t,  w + t, tall - t, 0);       /* right */
  add(w + 2 * t, tall, t, 0, tall - t, -d - t);       /* back  */
  add(w + 2 * t, tall, t, 0, tall - t,  d + t);       /* front */

  for (const o of objects.values()) {
    for (const part of o.parts) {
      const p = part.body.translation();
      const lim = Math.max(0, w - o.half[0]);
      if (Math.abs(p.x) > lim) {
        part.body.setTranslation({ x: Math.sign(p.x) * lim, y: p.y + 0.5, z: p.z }, true);
      }
      part.body.wakeUp();
    }
  }
}

let resizeFrame = 0;
function onResize() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    measure();
    wake();
    requestEnv(true);
  });
}

/* -----------------------------------------------------------------
   SYNC — make the scene match state.objects
   ----------------------------------------------------------------- */

/* How long a link click holds the page (see drift.js). */
function leaveHold() {
  if (C.leaveHold === 0 || reduced()) return 0;
  if (!tally.o || !tally.view || !sound.buffer || !sound.ctx || sound.ctx.state === "closed") return 0;
  holding = true;
  return C.leaveHold || Math.max(C.pressDown + C.pressUp, C.pressDown * 0.5 + C.roll);
}
let holding = false;

/* On the way out, a press still in progress is finished, so the
   picture handed to the next page -- and the value saved -- already
   show the new number, and the next page has nothing left to press. */
function finishPress() {
  const a = tally.anim;
  if (!a || !tally.view) return;
  tally.shown = a.from + 1;
  tally.anim = null;
  tally.view.press(0);
  showDigits(tally.shown);
}

function onChange(event) {
  const detail = event.detail || {};
  if (detail.willUnload) {
    /* Held by drift.js: press NOW, still inside the click, so the
       sound is allowed and starts with the button. Otherwise the page
       is simply going; pagehide saves. */
    if (holding) {
      holding = false;
      tally.waitUntil = 0;
      stepTally(performance.now());
      wake();
    }
    return;
  }

  /* A reset or a debug jump is not a click: the tally snaps to the
     number instead of pressing its way there. */
  if (detail.kind !== "nav" && tally.shown !== null) {
    tally.shown = drift.state.counter;
    tally.anim = null;
    showDigits(tally.shown);
  }
  sync();
}

/* -----------------------------------------------------------------
   PAGE IN THE REFLECTIONS
   ---------------------------------------------------------------
   Reflections come from a cube map: the surroundings seen from one
   point, as six square pictures (right, left, up, down, front, back).
   Five of them are the generated room, drawn ONCE. The sixth, the
   back -- the direction behind the objects, which a metal surface
   reflects wherever it turns away from the viewer: its edges, the
   round sides -- is the page:

     - the page picture, blurred once at load (free afterwards);
     - cropped to the part of the page around the tally, the size the
       page would cover if it really stood a slab's depth behind it;
     - drawn onto one plane in the room scene, and only that one face
       is re-rendered, then turned into reflections (PMREM).

   Aligned to the layout: the picture's top edge is the bottom of the
   rule under the nav, its width the page's width; everything is
   measured from the DOM at update time, in page coordinates, so it
   follows scrolling exactly.

   Updated while scrolling at most every envEvery ms, once more when
   scrolling stops (always exact at rest), and when the tally moves.
   Never while nothing changes. Not part of the visible scene: it
   cannot be seen, block anything or cast a shadow.
   ----------------------------------------------------------------- */

const env = { status: "", width: 0, pmrem: null, room: null, cubeRT: null, cubeCam: null, target: null,
              plane: null, faceCanvas: null, faceTex: null, page: null,
              due: false, last: 0, endTimer: 0, lastKey: "" };

function setupEnvironment() {
  env.pmrem = new THREE.PMREMGenerator(renderer);
  env.room = new RoomEnvironment();
  scene.environment = env.pmrem.fromScene(env.room, 0.04).texture;
}

function isProjectPage() {
  return /\/(works|exhibitions)\/[^/]+\/(index\.html)?$/.test(window.location.pathname);
}

function loadPageImage() {
  if (!C.pageImage) { env.status = "switched off (C.pageImage is empty)"; return; }
  if (!isProjectPage()) {
    env.status = "not treated as a project page: " + window.location.pathname;
    return;
  }
  const url = new URL(C.pageImage, window.location.href).href;
  env.status = "loading " + url;
  const img = new Image();
  img.onerror = () => {
    env.status = "picture not found: " + url;
    console.warn("drift-3d: " + env.status);
  };
  img.onload = () => {
    /* Blur once, on a copy wide enough for the blur to be smooth. */
    const w = 256, h = Math.round(w * img.naturalHeight / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.filter = "blur(" + C.pageImageBlur + "px)";
    ctx.drawImage(img, 0, 0, w, h);
    env.page = { canvas: c, raw: img };
    env.status = "loaded " + url + " (" + img.naturalWidth + " x " + img.naturalHeight + ")";
    try {
      buildPageFace();
      requestEnv(true);
    } catch (err) {
      env.status = "loaded, but the reflection setup failed: " + err.message;
      console.warn("drift-3d:", err);
    }
  };
  img.src = url;
}

function buildPageFace() {
  env.cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  env.cubeCam = new THREE.CubeCamera(0.05, 100, env.cubeRT);

  env.faceCanvas = document.createElement("canvas");
  env.faceCanvas.width = env.faceCanvas.height = 256;
  env.faceTex = new THREE.CanvasTexture(env.faceCanvas);
  env.faceTex.colorSpace = THREE.SRGBColorSpace;

  /* One plane filling exactly the back face: a 90° view at distance d
     sees a square 2d wide. Unlit, so the room's light does not tint
     the page. */
  env.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: env.faceTex, toneMapped: false }));
  env.plane.position.set(0, 0, -0.5);
  env.room.add(env.plane);

  /* The same page, facing the objects from the front: what a mirror
     held up to the page would show, so it reads reversed, as any
     reflection does. */
  env.front = new THREE.Mesh(env.plane.geometry, env.plane.material);
  env.front.position.set(0, 0, 0.5);
  env.front.rotation.y = Math.PI;
  env.room.add(env.front);
  env.face = C.pageFace;
  applyPageFace();

  drawPageFace();
  env.cubeCam.update(renderer, env.room);          /* all six, once */
  env.target = env.pmrem.fromCubemap(env.cubeRT.texture);
  scene.environment = env.target.texture;
}

/* Page coordinates (px from the document's top-left) of the rectangle
   the picture covers. */
function pageRect() {
  const rule = document.querySelector("nav + hr") || document.querySelector("hr");
  const top = rule ? rule.getBoundingClientRect().bottom + window.scrollY : 0;
  const width = env.width || C.pageWidth || document.documentElement.clientWidth;
  const height = width * env.page.canvas.height / env.page.canvas.width;
  return { left: 0, top, width, height };
}

/* Crop the page around the tally into the back face. */
function drawPageFace() {
  const ctx = env.faceCanvas.getContext("2d");
  const r = pageRect();

  /* Where the tally is on the page (or the middle of the window). */
  let sx = W / 2, sy = H / 2;
  if (tally.o) {
    const p = tally.o.parts[0].body.translation();
    sx = W / 2 + p.x * PXCM;
    sy = H - p.y * PXCM;
  }
  const cx = sx + window.scrollX, cy = sy + window.scrollY;
  const half = C.depthCm * PXCM * C.pageReach;

  const key = [Math.round(cx), Math.round(cy), Math.round(r.top), r.width].join(",");
  if (key === env.lastKey) return false;           /* nothing moved */
  env.lastKey = key;

  /* Page px -> picture px */
  const k = env.page.canvas.width / r.width;
  ctx.fillStyle = "#fff";                          /* outside the picture: the page */
  ctx.fillRect(0, 0, 256, 256);
  ctx.drawImage(env.page.canvas,
    (cx - half - r.left) * k, (cy - half - r.top) * k, half * 2 * k, half * 2 * k,
    0, 0, 256, 256);
  env.faceTex.needsUpdate = true;
  return true;
}

function applyPageFace() {
  env.plane.visible = env.face !== "front";
  env.front.visible = env.face !== "back";
}

/* Debug: F cycles back -> front -> both, redrawing all six faces. */
function cyclePageFace() {
  if (!env.page || !env.cubeCam) { showInfo("F: no page picture — " + (env.status || "not started")); return; }
  const order = ["back", "front", "both"];
  env.face = order[(order.indexOf(env.face) + 1) % order.length];
  applyPageFace();
  env.lastKey = "";
  drawPageFace();
  env.cubeCam.update(renderer, env.room);
  env.pmrem.fromCubemap(env.cubeRT.texture, env.target);
  if (!running) renderOnce();
  showInfo("page in the reflections: " + env.face + '\nto keep it: pageFace: "' + env.face + '" in C');
}

function updateEnv() {
  env.due = false;
  env.last = performance.now();
  if (!env.page || !env.cubeCam) return;
  if (!drawPageFace()) return;

  /* Re-render the back face only (index 5, looking toward -z), then
     rebuild the reflections into the same target. */
  const prev = renderer.getRenderTarget();
  /* Faces 4 (+z, front) and 5 (-z, back); only the ones showing the
     page change. */
  if (env.face !== "front") {
    renderer.setRenderTarget(env.cubeRT, 5);
    renderer.render(env.room, env.cubeCam.children[5]);
  }
  if (env.face !== "back") {
    renderer.setRenderTarget(env.cubeRT, 4);
    renderer.render(env.room, env.cubeCam.children[4]);
  }
  renderer.setRenderTarget(prev);
  env.pmrem.fromCubemap(env.cubeRT.texture, env.target);

  if (!running) renderOnce();
}

/* Throttled while things change; `final` forces an exact update now. */
function requestEnv(final) {
  if (!env.page) return;
  const now = performance.now();
  if (final || now - env.last >= C.envEvery) { updateEnv(); return; }
  if (!env.due) {
    env.due = true;
    window.setTimeout(updateEnv, C.envEvery - (now - env.last));
  }
}

function onScrollEnv() {
  requestEnv(false);
  window.clearTimeout(env.endTimer);
  env.endTimer = window.setTimeout(() => requestEnv(true), 120);   /* scroll stopped */
}

/* CHECKING THE ALIGNMENT BY EYE. In debug mode, B shows the page
   picture itself, unblurred and half transparent, exactly where the
   reflections assume it is. It should sit on the page's images. */
function togglePageOverlay() {
  let el = document.getElementById("drift-3d-page-check");
  if (el) { el.remove(); return; }
  if (!env.page) { showInfo("B: no page picture — " + (env.status || "not started")); return; }
  el = document.createElement("img");
  el.id = "drift-3d-page-check";
  el.src = env.page.raw.src;
  el.setAttribute("data-drift-debug", "");
  document.documentElement.appendChild(el);   /* outside body: no drift transform */
  placePageOverlay();
  showInfo("B: page picture shown — " + env.status +
           "\n\u2191 bigger  \u2193 smaller  (Shift: finer)  B hide");
}

function placePageOverlay() {
  const el = document.getElementById("drift-3d-page-check");
  if (!el) return false;
  const r = pageRect();
  el.style.cssText =
    "position:absolute;z-index:9998;pointer-events:none;opacity:0.5;" +
    "image-rendering:pixelated;left:" + r.left + "px;top:" + r.top + "px;" +
    "width:" + r.width + "px;height:" + r.height + "px;max-width:none;max-height:none";
  return true;
}

/* Up / Down while the picture is shown: scale it from its top-left
   corner, 1% a press (0.1% with Shift). The reflections follow. */
function scalePage(bigger, fine) {
  if (!placePageOverlay()) return;
  const now = pageRect().width;
  const step = fine ? 0.001 : 0.01;
  env.width = Math.max(10, now * (bigger ? 1 + step : 1 - step));
  placePageOverlay();
  requestEnv(true);
  const win = document.documentElement.clientWidth;
  showInfo("width " + Math.round(env.width) + " px — window " + win + " px (x" +
           (env.width / win).toFixed(3) + ")\nto keep it: pageWidth: " +
           Math.round(env.width) + " in C");
}

function renderOnce() {
  drawShadows();
  renderer.render(scene, camera);
}

/* -----------------------------------------------------------------
   WHERE THE CANVAS LIVES
   ---------------------------------------------------------------
   Normally the last child of body, where its z-index interleaves with
   the page's own layers (under presence and the lightbox).

   mirrored-page is the one event that puts a transform ON BODY
   (drift.css: `html[data-event~="mirrored-page"] body { transform:
   scaleX(-1) }`). A transformed body mirrors everything inside it and
   stops position:fixed working for its descendants -- drift.css's
   own comment names the fix: the canvas must live outside <body>. So
   while body has a transform, the canvas moves out to be the last
   child of <html>, and moves back when the transform is gone.

   The cost while it is outside: body is then a stacking context, so
   nothing inside it can be layered above the canvas -- including the
   lightbox overlay. So while it is outside, an open lightbox hides
   the objects.
   ----------------------------------------------------------------- */

let canvasOutside = false;

function placeCanvas() {
  if (!canvas || !document.body) return;
  const t = getComputedStyle(document.body).transform;
  canvasOutside = !!t && t !== "none";
  const parent = canvasOutside ? document.documentElement : document.body;
  if (canvas.parentNode !== parent) parent.appendChild(canvas);   /* keeps the GL context */
  hideForLightbox();
}

function hideForLightbox() {
  const open = document.documentElement.classList.contains("lightbox-open");
  canvas.style.visibility = canvasOutside && open ? "hidden" : "";
}

function watchLightbox() {
  new MutationObserver(hideForLightbox)
    .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

function sync() {
  placeCanvas();
  requestEnv(true);          /* an event may have moved the layout */
  const state = drift.state;
  if (!Array.isArray(state.objects)) state.objects = [];

  /* Records from before sizes were in centimetres. */
  state.objects = state.objects.filter((r) => r && r.v === 2);

  /* §10 — the tally, scripted, outside every roll. Missing means a
     fresh browser or a reload that just cleared the floor. */
  if (!state.objects.some((r) => r.kind === "tally")) {
    state.objects.push({ v: 2, id: "tally", kind: "tally", at: state.counter,
                         pose: null, rest: false });
    drift.write(state);
  }

  const present = new Set();
  let dropping = 0;

  for (const rec of state.objects) {
    present.add(rec.id);
    if (objects.has(rec.id)) continue;
    const falling = !rec.pose;
    const o = rec.kind === "tally" ? buildTally(rec, dropping) : build(rec, dropping);
    if (!o) continue;              /* a kind this file cannot draw yet */
    if (falling) dropping += 1;
    objects.set(rec.id, o);
  }

  for (const [id, o] of objects) {
    if (!present.has(id)) { destroy(o); objects.delete(id); }
  }

  wake();
}

/* -----------------------------------------------------------------
   SHARED BODY PLUMBING
   ----------------------------------------------------------------- */

function bodyDesc(pose, planar) {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setCanSleep(true)
    .setCcdEnabled(true)
    .setLinearDamping(0.05)
    .setAngularDamping(0.35)
    .setTranslation(pose.p[0], pose.p[1], pose.p[2])
    .setRotation({ x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] });
  if (planar) desc.enabledRotations(false, false, true);
  return desc;
}

/* A spin on the way in -- unless the visitor asked for less motion,
   in which case it arrives low and still (§14). */
function spin(desc, planar) {
  if (reduced()) return;
  const s = () => (Math.random() - 0.5) * 6;
  desc.setAngvel(planar ? { x: 0, y: 0, z: s() } : { x: s(), y: s(), z: s() });
}

function dropPose(half, planar, stagger) {
  const r = Math.max(half[0], half[1]);
  const span = Math.max(0, W / 2 / PXCM - r - 0.2);
  const x = (Math.random() * 2 - 1) * span;
  const z = (Math.random() * 2 - 1) * Math.max(0, C.depthCm - half[2]);

  /* From above the top edge; with reduced motion, from a third of
     the way up, so the fall is short. Several at once are stacked in
     the air so they do not spawn inside one another. */
  const screenH = H / PXCM;
  const base = reduced() ? screenH * 0.35 : screenH + r;
  const y = base + r + stagger * (r * 2 + 1);

  const q = new THREE.Quaternion();
  if (planar) {
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (Math.random() - 0.5) * 0.8);
  } else {
    q.setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
  }
  return { p: [x, y, z], q: [q.x, q.y, q.z, q.w] };
}

function tag(mesh, id, part) {
  mesh.traverse((node) => {
    node.userData.driftId = id;
    node.userData.part = part;
  });
}

/* -----------------------------------------------------------------
   SHADOWS — drawn, not lit
   ---------------------------------------------------------------
   No shadow maps. three.js shadow maps compare depths, and on a plane
   that should show NOTHING where no object is, their small errors
   show as a faint grey grain over the whole screen. Instead:

     1. draw every object as a flat silhouette, seen along the light's
        direction, into a small offscreen image;
     2. blur that image, two quick passes (across, then down);
     3. the page plane shows that image as pure alpha, projected the
        same way the silhouettes were drawn.

   Where no object is, the image is exactly empty, so the plane is
   exactly transparent. The blur is a plain Gaussian of any width.
   Redrawn only while the loop runs, i.e. while something moves.
   ----------------------------------------------------------------- */

let shadow = null;

const QUAD_VS = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/* Separable Gaussian, 17 taps, spread to cover the requested radius. */
const BLUR_FS = `
  uniform sampler2D map;
  uniform vec2 dir;
  varying vec2 vUv;
  void main() {
    float a = 0.0, total = 0.0;
    for (int i = -8; i <= 8; i++) {
      float x = float(i) / 8.0;
      float w = exp(-x * x * 4.0);
      a += texture2D(map, vUv + dir * float(i)).a * w;
      total += w;
    }
    gl_FragColor = vec4(0.0, 0.0, 0.0, a / total);
  }`;

const PLANE_VS = `
  uniform mat4 shadowMatrix;
  varying vec4 vShadow;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vShadow = shadowMatrix * world;
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;

const PLANE_FS = `
  uniform sampler2D map;
  uniform float opacity;
  varying vec4 vShadow;
  void main() {
    vec2 uv = vShadow.xy / vShadow.w * 0.5 + 0.5;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(map, uv).a * opacity * inside);
  }`;

function setupShadows() {
  const small = Math.min(window.screen.width || W, window.screen.height || H) < 700;
  const size = small ? C.shadowMapSize / 2 : C.shadowMapSize;
  const rt = () => new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
  const a = rt(), b = rt();

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
  const silhouette = new THREE.MeshBasicMaterial({ color: 0x000000 });

  const blurMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, dir: { value: new THREE.Vector2() } },
    vertexShader: QUAD_VS, fragmentShader: BLUR_FS,
    depthTest: false, depthWrite: false
  });
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat);
  quad.frustumCulled = false;          /* drawn straight to clip space */
  quadScene.add(quad);

  const planeMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: a.texture }, opacity: { value: C.shadowOpacity },
                shadowMatrix: { value: new THREE.Matrix4() } },
    vertexShader: PLANE_VS, fragmentShader: PLANE_FS,
    transparent: true, depthWrite: false
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
  plane.renderOrder = -1;
  plane.raycast = () => {};            /* never grabbed, never hovered */
  root.add(plane);

  shadow = { a, b, cam, silhouette, blurMat, quadScene, plane, planeMat, size,
             dir: new THREE.Vector3(...C.shadowDir).normalize(),
             radius: small ? C.shadowBlur / 2 : C.shadowBlur };
}

/* Sized to the window: the plane covers it, the silhouette camera sees
   all of it (in px -- the camera lives in the scene, not in root). */
function fitShadows() {
  const { cam, plane, dir } = shadow;
  const pad = C.depthCm * PXCM * 2;
  const center = new THREE.Vector3(0, H / 2, 0);
  cam.position.copy(center).addScaledVector(dir, -2000);
  cam.lookAt(center);
  cam.left = -W / 2 - pad; cam.right = W / 2 + pad;
  cam.bottom = -H / 2 - pad; cam.top = H / 2 + pad;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  shadow.planeMat.uniforms.shadowMatrix.value
    .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

  plane.scale.set(W / PXCM + 20, H / PXCM + 20, 1);
  plane.position.set(0, H / PXCM / 2, -C.depthCm);
}

/* Steps 1 and 2 above; call before rendering the scene. */
function drawShadows() {
  if (!shadow) return;
  const s = shadow;
  const prevTarget = renderer.getRenderTarget();

  s.plane.visible = false;
  scene.overrideMaterial = s.silhouette;
  const env = scene.environment;
  scene.environment = null;
  renderer.setRenderTarget(s.a);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, s.cam);
  scene.environment = env;
  scene.overrideMaterial = null;
  s.plane.visible = true;

  /* Blur a -> b across, b -> a down. Radius in texels, 8 taps a side. */
  const k = s.radius / 8 / s.size;
  s.blurMat.uniforms.map.value = s.a.texture;
  s.blurMat.uniforms.dir.value.set(k, 0);
  renderer.setRenderTarget(s.b);
  renderer.clear();
  renderer.render(s.quadScene, camera);
  s.blurMat.uniforms.map.value = s.b.texture;
  s.blurMat.uniforms.dir.value.set(0, k);
  renderer.setRenderTarget(s.a);
  renderer.clear();
  renderer.render(s.quadScene, camera);

  renderer.setRenderTarget(prevTarget);
}

function destroy(o) {
  for (const part of o.parts) {
    world.removeRigidBody(part.body);   /* takes its joints with it */
    root.remove(part.mesh);
  }
  o.dispose();          /* three.js frees nothing on its own (§15) */
  if (drag && drag.id === o.id) drag = null;
  if (o.kind === "tally") tally.o = null;
}

/* -----------------------------------------------------------------
   GENERIC OBJECTS AND PRIMITIVE SPECIALS — one body each
   ----------------------------------------------------------------- */

function build(rec, stagger) {
  const shape = shapeOf(rec);
  if (!shape) return null;

  const pose = rec.pose || dropPose(shape.half, shape.planar, stagger);
  const desc = bodyDesc(pose, shape.planar);
  if (!rec.pose) {
    spin(desc, shape.planar);
    /* Written straight away, so leaving mid-fall does not drop it
       twice: the next page restores it in the air and it carries on. */
    rec.pose = pose;
    rec.rest = false;
  }

  const body = world.createRigidBody(desc);
  const [hx, hy, hz] = shape.half;
  world.createCollider(
    shape.collider(hx, hy, hz).setFriction(0.7).setRestitution(0.15).setDensity(1),
    body);
  if (rec.rest) body.sleep();

  tag(shape.mesh, rec.id, 0);
  root.add(shape.mesh);

  return { id: rec.id, kind: rec.kind, parts: [{ body, mesh: shape.mesh }],
           half: shape.half, dispose: shape.dispose };
}

const box = (hx, hy, hz) => RAPIER.ColliderDesc.cuboid(hx, hy, hz);

function shapeOf(rec) {
  switch (rec.kind) {
    case "block":    return block(rec);
    case "cylinder": return cylinder(rec);
    case "tally":    return primitiveTally();
    case "speaker":  return speaker();
    case "keys":     return keys();
    default:         return null;
  }
}

function material(colour, extra) {
  return new THREE.MeshStandardMaterial(
    Object.assign({ color: colour, roughness: 0.75, metalness: 0 }, extra || {}));
}

function owned(mesh, extras) {
  return () => {
    mesh.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) node.material.dispose();
    });
    (extras || []).forEach((x) => x.dispose());
  };
}

function block(rec) {
  const [sx, sy, sz] = rec.size || [2, 2, 2];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz),
                              material(rec.colour || "#808080"));
  return { mesh, half: [sx / 2, sy / 2, sz / 2], planar: false,
           collider: box, dispose: owned(mesh) };
}

function cylinder(rec) {
  const [d, h] = rec.size || [2, 3];
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(d / 2, d / 2, h, 28),
                              material(rec.colour || "#808080"));
  return { mesh, half: [d / 2, h / 2, d / 2], planar: false,
           collider: (hx, hy) => RAPIER.ColliderDesc.cylinder(hy, hx),
           dispose: owned(mesh) };
}

/* THE SPEAKER — a black cabinet, a woofer and a tweeter. Plays
   while held: not built yet. */
function speaker() {
  const [sx, sy, sz] = SPECIAL.speaker.size;
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material("#1e1e1e")));
  const cone = (r, y) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.2, 28),
                             material("#3a3a3a", { roughness: 0.9 }));
    m.rotation.x = Math.PI / 2;
    m.position.set(0, y, sz / 2 + 0.1);
    return m;
  };
  group.add(cone(2, -1.4), cone(0.9, 2.8));
  return { mesh: group, half: [sx / 2, sy / 2, sz / 2], planar: false,
           collider: box, dispose: owned(group) };
}

/* THE KEYS — a ring and two keys. What they open is still open. */
function keys() {
  const [sx, sy, sz] = SPECIAL.keys.size;
  const group = new THREE.Group();
  const brass = material("#b8963e", { roughness: 0.35, metalness: 0.8 });
  const steel = material("#9aa0a6", { roughness: 0.35, metalness: 0.8 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.22, 10, 28), steel);
  ring.position.x = -sx / 2 + 1.3;
  group.add(ring);
  const key = (mat, y, tilt) => {
    const k = new THREE.Group();
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.4, 20), mat);
    bow.rotation.x = Math.PI / 2;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.5, 0.3), mat);
    shaft.position.x = 2.4;
    const bit = new THREE.Mesh(new THREE.BoxGeometry(1, 0.7, 0.3), mat);
    bit.position.set(3.6, -0.5, 0);
    k.add(bow, shaft, bit);
    k.position.set(-sx / 2 + 2.6, y, 0);
    k.rotation.z = tilt;
    return k;
  };
  group.add(key(brass, 0.4, 0.12), key(steel.clone(), -0.6, -0.18));
  return { mesh: group, half: [sx / 2, sy / 2, sz / 2], planar: true,
           collider: box, dispose: owned(group) };
}

/* Stand-in tally, only if models/tally.glb fails to load: a grey box
   with the counter drawn on its face. */
function primitiveTally() {
  const [sx, sy, sz] = SPECIAL.tally.size;
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz),
                           material("#a9a9a9", { roughness: 0.3, metalness: 1 })));
  const c = document.createElement("canvas");
  c.width = 256; c.height = 92;
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(sx * 0.8, sx * 0.29),
                              new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  face.position.set(0, 0, sz / 2 + 0.05);
  group.add(face);
  tally.view = {
    digits(values) {
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#1a1a1a"; ctx.fillRect(0, 0, 256, 92);
      ctx.font = "bold 64px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = "#f4f4f4"; ctx.fillRect(i * 85 + 6, 8, 73, 76);
        ctx.fillStyle = "#111";
        ctx.fillText(String(Math.round(values[2 - i]) % 10), i * 85 + 42, 49);
      }
      texture.needsUpdate = true;
    },
    press() {}
  };
  return { mesh: group, half: [sx / 2, sy / 2, sz / 2], planar: true,
           collider: box, dispose: owned(group, [texture]) };
}

/* -----------------------------------------------------------------
   THE TALLY (§10) — the model, two bodies and a hinge
   ---------------------------------------------------------------
   From models/tally.glb:
     body      the counter itself, one body, a convex-hull collider
       button    child, pushed along its own -Y on each count
       digit_0-2 children, the wheels; digit_0 is the ones
     ring      its own body, pinned to the body at its origin by a
               hinge about its local Blender Y (glTF -Z), 0°-230°

   The ring's body is created with the SAME orientation as the
   tally's, and its modelled tilt is baked into its mesh and
   collider. Both frames then agree at rest, which is what a Rapier
   revolute joint assumes, and the hinge angle is 0 exactly as
   modelled.

   The model is in metres. Everything here is in centimetres.
   ----------------------------------------------------------------- */

const tally = {
  o: null,          /* the live object */
  view: null,       /* { digits(values), press(amount) } */
  shown: null,      /* the integer the wheels show */
  anim: null,
  waitUntil: 0
};

/* A FALL, as data: where across the screen (cm from the centre), how
   it is turned, how it spins (rad/s) and any push (cm/s). Everything
   else -- start height, the physics -- is fixed, so the same data
   gives the same fall. Rounded, so it can be pasted back in. */
function randomTallyDrop(reach) {
  const span = Math.max(0, W / 2 / PXCM - reach - 0.2);
  const r2 = (v) => Math.round(v * 100) / 100;
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
  const s = () => r2((Math.random() - 0.5) * 6);
  return {
    x: r2((Math.random() * 2 - 1) * span),
    q: [q.x, q.y, q.z, q.w].map((v) => Math.round(v * 1e4) / 1e4),
    w: [s(), s(), s()],
    v: [0, 0, 0]
  };
}

function tallyDropPose(drop, reach) {
  const span = Math.max(0, W / 2 / PXCM - reach - 0.2);
  const x = Math.max(-span, Math.min(span, drop.x || 0));   /* a narrow screen */
  /* The start height comes from the screen, so it does not change
     when the window is smaller than the screen: the floor is still the
     window's bottom edge, the fall is the same, only less of it is in
     view. */
  const screenTall = Math.max(H, (window.screen && window.screen.availHeight) || H) / PXCM;
  const y = (reduced() ? H / PXCM * 0.35 : screenTall + reach) + reach;
  const q = new THREE.Quaternion(...drop.q).normalize();
  return { p: [x, y, drop.z || 0], q: [q.x, q.y, q.z, q.w] };
}

function buildTally(rec, stagger) {
  if (!model) {
    const o = build(rec, stagger);
    if (o) startTally(o, rec);
    return o;
  }

  const src = model.scene.clone(true);
  src.updateMatrixWorld(true);
  const bodyNode = src.getObjectByName("body");
  const ringNode = src.getObjectByName("ring");
  if (!bodyNode) return null;

  /* BODY — container (physics pose, cm) > ×100 (m→cm) > body node */
  const bodyMesh = new THREE.Group();
  const bodyScale = new THREE.Group();
  bodyScale.scale.setScalar(100);
  const bodyInv = bodyNode.matrixWorld.clone().invert();
  bodyNode.position.set(0, 0, 0);
  bodyNode.quaternion.identity();
  bodyScale.add(bodyNode);
  bodyMesh.add(bodyScale);
  bodyMesh.updateMatrixWorld(true);
  const bodyPts = hullPoints(bodyNode);

  /* Half extents, for dropping and wall clamping. */
  const bb = new THREE.Box3().setFromArray(bodyPts);
  const half = [Math.max(-bb.min.x, bb.max.x), Math.max(-bb.min.y, bb.max.y),
                Math.max(-bb.min.z, bb.max.z)];

  /* FREE IN EVERY DIRECTION. It tumbles, lands on whatever side it
     lands on, and the window faces the visitor only when it happens
     to -- turning it over by hand is part of reading it. Dropped at a
     random orientation, so its reach is the same along every axis. */
  const reach = Math.max(half[0], half[1], half[2]);
  const fresh = !rec.pose;
  let pose = rec.pose;
  let drop = null;
  if (fresh) {
    const list = C.tallyDrops || [];
    drop = rec.drop ||
           (list.length ? list[Math.floor(Math.random() * list.length)] : randomTallyDrop(reach));
    rec.drop = drop;
    pose = tallyDropPose(drop, reach);
    rec.pose = pose; rec.rest = false; rec.ring = null;
  }
  /* Damped more than a loose block: its body is round, and without it
     it rolls back and forth on the floor for many seconds. */
  const desc = bodyDesc(pose, false).setAngularDamping(1);
  const still = reduced();
  const v0 = new THREE.Vector3(...(fresh && !still ? (drop.v || [0, 0, 0]) : [0, 0, 0]));
  const w0 = new THREE.Vector3(...(fresh && !still ? drop.w : [0, 0, 0]));
  if (fresh) {
    desc.setLinvel(v0.x, v0.y, v0.z);
    desc.setAngvel({ x: w0.x, y: w0.y, z: w0.z });
  }
  const body = world.createRigidBody(desc);
  world.createCollider(hullCollider(bodyPts).setDensity(1), body);

  const parts = [{ body, mesh: bodyMesh }];

  /* RING — its own body, same frame as the tally's */
  if (ringNode) {
    /* Where the ring sits and how it is turned, relative to the body. */
    const rel = bodyInv.clone().multiply(ringNode.matrixWorld);
    const anchorM = new THREE.Vector3(), relQ = new THREE.Quaternion();
    rel.decompose(anchorM, relQ, new THREE.Vector3());
    const anchor = anchorM.multiplyScalar(100);          /* cm, body frame */
    const axis = new THREE.Vector3(0, 0, -1).applyQuaternion(relQ);

    const ringMesh = new THREE.Group();
    const ringScale = new THREE.Group();
    ringScale.scale.setScalar(100);
    ringNode.position.set(0, 0, 0);
    ringNode.quaternion.copy(relQ);
    ringScale.add(ringNode);
    ringMesh.add(ringScale);
    ringMesh.updateMatrixWorld(true);
    const ringPts = hullPoints(ringNode);

    let rpose = rec.ring;
    if (!rpose) {
      const bq = new THREE.Quaternion(...pose.q);
      const at = anchor.clone().applyQuaternion(bq)
        .add(new THREE.Vector3(...pose.p));
      rpose = { p: [at.x, at.y, at.z], q: pose.q.slice() };
    }
    /* Damped harder than a loose object, so it swings and settles
       instead of rocking on its pin for seconds. */
    const ringDesc = bodyDesc(rpose, false).setAngularDamping(1);
    if (fresh) {
      /* Moving WITH the body from the first step, as if one object --
         otherwise the pin yanks it into motion on step one. */
      const r = new THREE.Vector3(...rpose.p).sub(new THREE.Vector3(...pose.p));
      const lv = w0.clone().cross(r).add(v0);
      ringDesc.setLinvel(lv.x, lv.y, lv.z);
      ringDesc.setAngvel({ x: w0.x, y: w0.y, z: w0.z });
    }
    const ring = world.createRigidBody(ringDesc);
    world.createCollider(hullCollider(ringPts).setDensity(1), ring);

    const joint = world.createImpulseJoint(
      RAPIER.JointData.revolute(
        { x: anchor.x, y: anchor.y, z: anchor.z }, { x: 0, y: 0, z: 0 },
        { x: axis.x, y: axis.y, z: axis.z }),
      body, ring, true);
    joint.setLimits(C.hingeMin, C.hingeMax);
    /* They touch at the pin by design; the limits keep them apart
       everywhere else. */
    joint.setContactsEnabled(false);

    parts.push({ body: ring, mesh: ringMesh });
    if (rec.rest) ring.sleep();
  }
  if (rec.rest) body.sleep();

  parts.forEach((part, i) => { tag(part.mesh, rec.id, i); root.add(part.mesh); });

  tally.view = tallyView(bodyNode);

  /* Model resources are shared with the cached glTF, reused if the
     tally is rebuilt after a reset -- so nothing is disposed here. */
  const o = { id: rec.id, kind: "tally", parts, half, reach, dispose: () => {} };
  startTally(o, rec);
  return o;
}

/* Every vertex under `node`, in the frame of the container two
   levels up (the part's physics frame), in cm. */
function hullPoints(node) {
  const container = node.parent.parent;
  const inv = container.matrixWorld.clone().invert();
  const out = [];
  const v = new THREE.Vector3();
  node.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    const M = inv.clone().multiply(m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M);
      out.push(v.x, v.y, v.z);
    }
  });
  return out;
}

function hullCollider(points) {
  return (RAPIER.ColliderDesc.convexHull(new Float32Array(points)) ||
          RAPIER.ColliderDesc.ball(1))
    .setFriction(0.7).setRestitution(0.15);
}

/* Size of a node's own geometry in its own frame. A node exported
   with several materials arrives as a Group of meshes, not a Mesh. */
function localSize(node) {
  const box = new THREE.Box3();
  node.updateMatrixWorld(true);
  const inv = node.matrixWorld.clone().invert();
  node.traverse((m) => {
    if (!m.isMesh) return;
    m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld)));
  });
  return box.getSize(new THREE.Vector3());
}

/* The moving parts of the model. */
function tallyView(bodyNode) {
  const wheels = [0, 1, 2].map((i) => {
    const node = bodyNode.getObjectByName("digit_" + i);
    if (!node) return null;
    /* The axle is the wheel's thinnest direction. */
    const s = localSize(node);
    const axis = s.z <= s.x && s.z <= s.y ? new THREE.Vector3(0, 0, 1)
               : s.x <= s.y ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    return { node, axis, q0: node.quaternion.clone() };
  });

  const button = bodyNode.getObjectByName("button");
  let press = () => {};
  if (button) {
    const len = localSize(button).y;
    const p0 = button.position.clone();
    const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(button.quaternion)
      .multiplyScalar(len * C.buttonTravel);
    press = (t) => button.position.copy(p0).addScaledVector(dir, t);
  }

  const q = new THREE.Quaternion();
  return {
    /* values[i] is a continuous digit for wheel i, so 9 → 10 rolls
       forward into 0 rather than back through 8, 7, 6... */
    digits(values) {
      wheels.forEach((w, i) => {
        if (!w) return;
        q.setFromAxisAngle(w.axis, (values[i] - C.restDigit) * C.digitStep);
        w.node.quaternion.copy(w.q0).multiply(q);
      });
    },
    press
  };
}

/* -----------------------------------------------------------------
   THE PRESS
   On a page reached by a click, the tally arrives one behind -- n-1
   -- and presses once, shortly after, to reach n. However fast the
   visitor clicks, each page is at most one press behind. Clicks
   that do not leave the page (lightbox, new tab) press on the spot,
   and several in a row press faster until caught up.
   ----------------------------------------------------------------- */

function digitsOf(n) {
  const m = ((n % 1000) + 1000) % 1000;
  return [m % 10, Math.floor(m / 10) % 10, Math.floor(m / 100)];
}

function showDigits(n) {
  if (tally.view) tally.view.digits(digitsOf(n));
}

function startTally(o, rec) {
  tally.o = o;
  const n = drift.state.counter;

  /* rec.shown is what the wheels showed when the last page was left.
     Behind the counter means a click happened since: arrive at n-1
     and press. Level with it means nothing was counted -- a return
     visit, an OS tab reload -- so there is nothing to press. */
  const saved = typeof rec.shown === "number" ? rec.shown : n;
  tally.shown = (saved < n && !reduced()) ? n - 1 : n;
  tally.anim = null;
  tally.waitUntil = performance.now() + C.arrivalDelay;
  showDigits(tally.shown);
  if (tally.view) tally.view.press(0);
}

const ease = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const clamp01 = (t) => t < 0 ? 0 : (t > 1 ? 1 : t);

/* Called every frame; true while there is something to animate. */
function stepTally(now) {
  if (!tally.o || tally.shown === null) return false;
  const target = drift.state.counter;

  if (tally.shown > target || reduced()) {
    if (tally.shown !== target) { tally.shown = target; showDigits(target); }
    tally.anim = null;
    return false;
  }
  if (tally.shown === target && !tally.anim) return false;

  if (!tally.anim) {
    /* No waiting for it to be still: it presses wherever it is,
       mid-fall or mid-swing, like one in a moving hand. */
    if (now < tally.waitUntil) return true;
    tally.anim = { from: tally.shown, start: now, k: target - tally.shown > 1 ? 0.6 : 1 };
    playSound();
  }

  const a = tally.anim;
  const down = C.pressDown * a.k, up = C.pressUp * a.k, roll = C.roll * a.k;
  const t = now - a.start;

  tally.view.press(ease(t < down ? t / down : 1 - clamp01((t - down) / up)));

  /* The wheels turn while the button is going in, like the real
     mechanism. Only the wheels whose digit changes move. */
  const r = ease(clamp01((t - down * 0.5) / roll));
  const from = digitsOf(a.from), to = digitsOf(a.from + 1);
  tally.view.digits(from.map((d, i) => (to[i] === d ? d : d + r)));

  if (t >= Math.max(down + up, down * 0.5 + roll)) {
    tally.shown = a.from + 1;
    tally.anim = null;
    tally.view.press(0);
    showDigits(tally.shown);
    tally.waitUntil = now + C.pressGap * a.k;
  }
  return true;
}

/* -----------------------------------------------------------------
   SOUND
   Web Audio rather than <audio>: the files are decoded once, ahead of
   time, so a click starts on the same frame as the button, with no
   delay and no overlap problems when presses come quickly.

   BROWSERS BLOCK SOUND until the visitor interacts with the page -- a
   click, a tap, a key. A page reached by a link has had none yet, so
   the press that plays as it appears is usually silent; the first
   interaction on the page unlocks sound for every press after it.
   Blocked or missing, it is skipped without an error.
   ----------------------------------------------------------------- */

const sound = { ctx: null, gain: null, buffer: null, gestureAt: 0 };

function loadSounds() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!C.sound || !AC) return;

  try { sound.ctx = new AC(); } catch (err) { return; }
  sound.gain = sound.ctx.createGain();
  sound.gain.gain.value = C.soundVolume;
  sound.gain.connect(sound.ctx.destination);

  fetch(new URL(C.sound, import.meta.url))
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((data) => data && new Promise((ok, fail) =>
      sound.ctx.decodeAudioData(data, ok, fail)))        /* old Safari: callbacks */
    .then((buffer) => { if (buffer) sound.buffer = buffer; })
    .catch(() => {});

  /* Try now (some browsers allow it), and again on the first real
     interaction, which always does. */
  const unlock = () => {
    sound.gestureAt = performance.now();
    if (sound.ctx.state === "suspended") sound.ctx.resume().catch(() => {});
  };
  unlock();
  for (const type of ["pointerdown", "keydown", "touchend"]) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
}

function playSound() {
  if (!sound.buffer || !sound.ctx) return;
  /* Right after a click the context may still be resuming: start
     anyway, it plays the moment it is running. Any other time a
     suspended context means sound is blocked -- skip, rather than
     queue clicks that would all burst out at the first interaction. */
  const justClicked = performance.now() - (sound.gestureAt || -1e9) < 1000;
  if (sound.ctx.state !== "running" && !(sound.ctx.state === "suspended" && justClicked)) return;
  if (sound.ctx.state === "suspended") sound.ctx.resume().catch(() => {});
  const src = sound.ctx.createBufferSource();
  src.buffer = sound.buffer;
  src.connect(sound.gain);
  src.start();
}

/* -----------------------------------------------------------------
   SETTLING
   Rapier sleeps a body only when its speed stays tiny. A tally lying
   on its own pinned ring never quite gets there: the joint and the
   floor contact keep correcting each other, and it buzzes or creeps
   a fraction of a millimetre at a time -- visible as jitter at this
   scale. So, once per window, compare every awake object with where
   it was one window ago. Barely moved and barely turned means it is
   resting in all but name: put all its parts to sleep together.
   Anything that hits it later wakes it as usual.
   ----------------------------------------------------------------- */

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

/* Counted in SIMULATED time on purpose. The first frames of a page
   can take most of a second each (shaders compiling, the model's
   textures uploading), and each frame simulates at most a few steps.
   Measured in wall-clock time, a freshly dropped tally had barely
   started to fall after "one second" -- and was put to sleep in mid
   air, until something (a resize) woke it. */
let simSteps = 0;

/* THE NET. Whatever still gets through -- a hard throw into a corner,
   a stack pressed at a bad angle -- is caught: any object whose centre
   ends up below the floor, beyond a side wall or out of the slab is
   put back just inside, still, with all its parts moved together so
   the tally keeps its ring. Checked every step; it costs a few
   comparisons per object and almost never fires. */
function rescue() {
  const w = W / 2 / PXCM, d = C.depthCm;
  for (const o of objects.values()) {
    const p = o.parts[0].body.translation();
    const reach = o.reach || Math.max(o.half[0], o.half[1], o.half[2]);
    let dx = 0, dy = 0, dz = 0;
    if (p.y < -0.5) dy = reach + 0.2 - p.y;
    if (Math.abs(p.x) > w + 0.5) dx = Math.sign(p.x) * Math.max(0, w - reach) - p.x;
    if (Math.abs(p.z) > d + 0.5) dz = -p.z;
    if (!dx && !dy && !dz) continue;
    for (const part of o.parts) {
      const q = part.body.translation();
      part.body.setTranslation({ x: q.x + dx, y: q.y + dy, z: q.z + dz }, true);
      part.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      part.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }
}

function settle() {
  for (const o of objects.values()) {
    if (drag && drag.id === o.id) { o.ref = null; continue; }
    if (o.parts.every((p) => p.body.isSleeping())) { o.ref = null; continue; }

    if (o.ref && simSteps - o.ref.step < C.settleSteps) continue;

    const poses = o.parts.map((p) => ({ t: p.body.translation(), q: p.body.rotation() }));
    if (o.ref) {
      const still = poses.every((now2, i) => {
        const was = o.ref.poses[i];
        const d = Math.hypot(now2.t.x - was.t.x, now2.t.y - was.t.y, now2.t.z - was.t.z);
        _qa.set(now2.q.x, now2.q.y, now2.q.z, now2.q.w);
        _qb.set(was.q.x, was.q.y, was.q.z, was.q.w);
        return d < C.settleDist && _qa.angleTo(_qb) < C.settleAngle * DEG;
      });
      if (still) {
        for (const p of o.parts) {
          p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
          p.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
          p.body.sleep();
        }
        o.ref = null;
        continue;
      }
    }
    o.ref = { step: simSteps, poses };
  }
}

/* -----------------------------------------------------------------
   HANDOFF — the picture of the floor, both ways
   ---------------------------------------------------------------
   Leaving: photograph the objects and keep the picture for the next
   page, where drift-boot.js paints it before first paint.
   Arriving: once the real canvas has drawn its first frame, hide the
   picture. One frame later, so the canvas is on screen first and the
   swap is invisible.
   ----------------------------------------------------------------- */

const SNAP = "pf.drift.snap";
let live = false;

function goLive() {
  live = true;
  requestAnimationFrame(() => {
    document.documentElement.classList.add("drift-3d-live");
  });
}

function snapshot() {
  try {
    if (!renderer || !objects.size) { window.sessionStorage.removeItem(SNAP); return; }

    /* Only the part of the screen with objects in it: the picture is
       stored as text, and most of the canvas is empty. */
    const box = new THREE.Box3(), part = new THREE.Box3();
    root.updateMatrixWorld(true);
    for (const o of objects.values()) {
      for (const p of o.parts) box.union(part.setFromObject(p.mesh));
    }
    if (box.isEmpty()) { window.sessionStorage.removeItem(SNAP); return; }

    /* Shadows reach past the objects: add where each box corner's
       shadow lands on the page plane. */
    if (shadow) {
      const zb = -C.depthCm * PXCM, d = shadow.dir, c = new THREE.Vector3();
      const corners = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) corners.push([x, y, z]);
      for (const [x, y, z] of corners) {
        const t = (zb - z) / d.z;
        box.expandByPoint(c.set(x + d.x * t, y + d.y * t, zb));
      }
    }

    const pad = shadow ? 10 + C.shadowBlur * 3 : 6;   /* soft shadow edges */
    const left = Math.max(0, Math.floor(box.min.x + W / 2 - pad));
    const right = Math.min(W, Math.ceil(box.max.x + W / 2 + pad));
    const bottom = Math.max(0, Math.floor(box.min.y - pad));
    const top = Math.min(H, Math.ceil(box.max.y + pad));
    const w = right - left, h = top - bottom;
    if (w <= 0 || h <= 0) { window.sessionStorage.removeItem(SNAP); return; }

    /* MEASURED, NOT ASSUMED. The picture is placed by what the canvas
       ACTUALLY occupies on screen right now, and cut by what its
       drawing buffer ACTUALLY holds -- not by W, H and the pixel
       ratio, which is what the canvas is supposed to be. Anything
       that makes the two differ (a stylesheet rule on canvas, a zoom
       somewhere up the tree, buffer rounding) used to show up as a
       picture slightly the wrong size. */
    const el = renderer.domElement;
    const rect = el.getBoundingClientRect();
    const onX = rect.width / W, onY = rect.height / H;       /* screen px per scene px */
    const bufX = el.width / W, bufY = el.height / H;         /* buffer px per scene px */

    /* Draw, then copy in the same task, while the drawing buffer is
       still valid -- no preserveDrawingBuffer needed. */
    drawShadows();
    renderer.render(scene, camera);
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(w * bufX));
    crop.height = Math.max(1, Math.round(h * bufY));
    crop.getContext("2d").drawImage(el,
      left * bufX, (H - top) * bufY, w * bufX, h * bufY,
      0, 0, crop.width, crop.height);

    /* WebP where the browser can encode it; Safari falls back to PNG. */
    const url = crop.toDataURL("image/webp", 0.92);

    /* Where it sits, in the terms boot uses: from the centre of the
       fixed containing block, and up from its bottom edge. */
    const html = document.documentElement;
    const screenLeft = rect.left + left * onX;
    const screenBottom = rect.top + (H - bottom) * onY;

    window.sessionStorage.setItem(SNAP, JSON.stringify({
      iw: window.innerWidth, sw: window.screen.width, sh: window.screen.height,
      x: round(screenLeft - html.clientWidth / 2, 100),
      b: round(html.clientHeight - screenBottom, 100),
      w: round(w * onX, 100), h: round(h * onY, 100),
      url
    }));

    /* For checking by hand: run __drift.objects3d.snapshot(), then
       read __drift.objects3d.lastSnap. */
    drift.objects3d.lastSnap = {
      W, H, canvasOnScreen: [rect.width, rect.height],
      buffer: [el.width, el.height], pixelRatio: renderer.getPixelRatio(),
      clientWidth: html.clientWidth, clientHeight: html.clientHeight
    };
  } catch (err) {
    /* Quota, a tainted canvas, anything: no picture, and the next
       page simply shows the floor a moment late. */
    try { window.sessionStorage.removeItem(SNAP); } catch (e) {}
  }
}

/* -----------------------------------------------------------------
   LOOP
   Runs only while something moves. Once every body is asleep and
   the tally has caught up, the poses are saved and the loop stops:
   a settled floor costs nothing.
   ----------------------------------------------------------------- */

let running = false, last = 0, acc = 0, calm = 0;

function wake() {
  if (running || document.visibilityState === "hidden" || !renderer) return;
  running = true;
  calm = 0;
  last = performance.now();
  requestAnimationFrame(frame);
}

function pause() { running = false; }

function frame(now) {
  if (!running) return;

  /* Clamped both ways: a rAF timestamp can be slightly EARLIER than
     the performance.now() taken in wake(). */
  acc += Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  let n = 0;
  while (acc >= C.step && n < C.maxSteps) {
    steerDrag();
    world.step();
    simSteps += 1;
    rescue();
    acc -= C.step;
    n += 1;
  }
  if (n === C.maxSteps) acc = 0;
  settle();

  for (const o of objects.values()) {
    for (const part of o.parts) {
      const p = part.body.translation();
      const q = part.body.rotation();
      part.mesh.position.set(p.x, p.y, p.z);
      part.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }
  const animating = stepTally(now);
  requestEnv(false);         /* the tally moved: throttled, and a no-op if not */
  drawShadows();
  renderer.render(scene, camera);
  if (!live) goLive();

  if (!drag && !animating && allAsleep()) {
    calm += 1;
    if (calm >= C.calmFrames) {
      running = false;
      requestEnv(true);      /* come to rest: exact */
      savePoses();
      return;
    }
  } else {
    calm = 0;
  }
  requestAnimationFrame(frame);
}

function allAsleep() {
  for (const o of objects.values()) {
    for (const part of o.parts) if (!part.body.isSleeping()) return false;
  }
  return true;
}

/* -----------------------------------------------------------------
   PERSISTENCE
   Written into the records of the CURRENT state object, looked up by
   id, never through a reference held from earlier. Centimetres.
   ----------------------------------------------------------------- */

const round = (v, k) => Math.round(v * k) / k;

function poseOf(body) {
  const p = body.translation();
  const q = body.rotation();
  return {
    p: [round(p.x, 1000), round(p.y, 1000), round(p.z, 1000)],
    q: [round(q.x, 1e5), round(q.y, 1e5), round(q.z, 1e5), round(q.w, 1e5)]
  };
}

function savePoses() {
  if (!world) return;
  const state = drift.state;
  if (!Array.isArray(state.objects)) return;

  for (const rec of state.objects) {
    const o = objects.get(rec.id);
    if (!o) continue;
    rec.pose = poseOf(o.parts[0].body);
    if (o.parts[1]) rec.ring = poseOf(o.parts[1].body);
    if (o.kind === "tally" && tally.shown !== null) rec.shown = tally.shown;
    rec.rest = o.parts.every((part) => part.body.isSleeping());
  }
  drift.write(state);
}

/* -----------------------------------------------------------------
   HOLDING
   The canvas never takes pointer events -- the page under it has
   to stay clickable everywhere an object is not. Instead the window
   is watched in the capture phase, and a press that lands on an
   object is claimed:

     touchstart  preventDefault, so the page does not scroll and no
                 click is synthesised
     click       swallowed at the window, before drift.js sees it on
                 the document, so grabbing an object that sits on a
                 link neither follows the link nor counts

   Grabbing the ring holds the ring; the tally hangs from it.
   ----------------------------------------------------------------- */

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;
let swallowClick = false;
let hoverQueued = false, hoverX = 0, hoverY = 0;

function toWorld(clientX, clientY) {
  return { x: (clientX - W / 2) / PXCM, y: (H - clientY) / PXCM };
}

function hit(clientX, clientY) {
  if (!objects.size) return null;
  if (document.documentElement.classList.contains("lightbox-open")) return null;
  ndc.set((clientX / W) * 2 - 1, -(clientY / H) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const found = ray.intersectObject(root, true)[0];
  if (!found) return null;
  const o = objects.get(found.object.userData.driftId);
  if (!o) return null;
  const part = o.parts[found.object.userData.part || 0] || o.parts[0];
  /* The exact point touched, in cm: the scene is in px, root scales. */
  const point = found.point.clone().divideScalar(PXCM);
  return { o, part, index: o.parts.indexOf(part), point };
}

function bindPointer() {
  const html = document.documentElement;

  window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const h = hit(e.clientX, e.clientY);
    if (!h) return;

    /* Held BY THE POINT TOUCHED, stored in the body's own frame, so
       it stays the same spot on the object as it turns. */
    const b = h.part.body;
    const p = b.translation(), q = b.rotation();
    const local = h.point.clone()
      .sub(new THREE.Vector3(p.x, p.y, p.z))
      .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w).invert());
    drag = { id: h.o.id, part: h.index, pointer: e.pointerId,
             local, tx: h.point.x, ty: h.point.y };
    swallowClick = true;
    h.o.parts.forEach((part) => part.body.wakeUp());
    html.classList.add("drift-3d-grabbing");
    e.preventDefault();          /* no text selection, no focus */
    wake();
  }, { capture: true });

  window.addEventListener("touchstart", (e) => {
    if (drag) e.preventDefault();
  }, { capture: true, passive: false });

  window.addEventListener("pointermove", (e) => {
    if (drag && e.pointerId === drag.pointer) {
      const at = toWorld(e.clientX, e.clientY);
      drag.tx = at.x;
      drag.ty = at.y;
      return;
    }
    if (e.pointerType !== "mouse") return;
    hoverX = e.clientX; hoverY = e.clientY;
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      html.classList.toggle("drift-3d-hover", !!hit(hoverX, hoverY));
    });
  }, { passive: true });

  const release = (e) => {
    if (!drag || (e && e.pointerId !== drag.pointer)) return;
    drag = null;
    html.classList.remove("drift-3d-grabbing");
    /* The click that follows this pointerup is ours. If none comes,
       forget the flag soon after. */
    window.setTimeout(() => { swallowClick = false; }, 400);
  };
  window.addEventListener("pointerup", release, { capture: true });
  window.addEventListener("pointercancel", release, { capture: true });

  window.addEventListener("click", (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, { capture: true });
}

/* Each physics step, pull the HELD POINT toward the pointer with an
   impulse applied at that point -- not the body's centre. Gravity
   keeps acting, so the object hangs from where it was grabbed and
   swings round it: take the tally by a corner and it turns, which is
   how the window gets turned toward the visitor. Velocity, never
   position, so it still collides, and letting go mid-swing throws. */
const _q = new THREE.Quaternion(), _r = new THREE.Vector3();

function steerDrag() {
  if (!drag) return;
  const o = objects.get(drag.id);
  const part = o && o.parts[drag.part];
  if (!part) { drag = null; return; }

  const body = part.body;
  const p = body.translation(), q = body.rotation();
  _r.copy(drag.local).applyQuaternion(_q.set(q.x, q.y, q.z, q.w));
  const P = { x: p.x + _r.x, y: p.y + _r.y, z: p.z + _r.z };

  /* How the held point is moving now: the body's velocity plus its
     spin carried out to the point. */
  const v = body.linvel(), w = body.angvel();
  const vx = v.x + w.y * _r.z - w.z * _r.y;
  const vy = v.y + w.z * _r.x - w.x * _r.z;
  const vz = v.z + w.x * _r.y - w.y * _r.x;

  const max = C.dragMaxPx / PXCM;
  let dx = (drag.tx - P.x) * C.dragGain;
  let dy = (drag.ty - P.y) * C.dragGain;
  const speed = Math.hypot(dx, dy);
  if (speed > max) { dx *= max / speed; dy *= max / speed; }
  const dz = -P.z * 4;                /* drift back to the middle of the slab */

  const k = body.mass() * C.grabStiffness;
  let jx = (dx - vx) * k, jy = (dy - vy) * k, jz = (dz - vz) * k;

  /* A FIRM GRIP, NOT AN INFINITE ONE. Uncapped, pointing below the
     floor pressed the held object down with tens of times its weight,
     every step, and whatever was underneath was squeezed into and
     eventually through the floor. Capped at gripStrength x weight. */
  const limit = body.mass() * (C.gravityPx / PXCM) * C.gripStrength * C.step;
  const j = Math.hypot(jx, jy, jz);
  if (j > limit) { const f = limit / j; jx *= f; jy *= f; jz *= f; }
  body.applyImpulseAtPoint({ x: jx, y: jy, z: jz }, P, true);

  const w2 = body.angvel();
  body.setAngvel({ x: w2.x * 0.97, y: w2.y * 0.97, z: w2.z * 0.97 }, true);
}

/* -----------------------------------------------------------------
   DEBUG — __drift.drop("keys"), or __drift.drop() for a real roll.
   ----------------------------------------------------------------- */

/* __drift.tallyDrop()        drop the tally again, a new random fall
   __drift.tallyDrop({...})   drop it again with these parameters
   Prints the parameters and copies them to the clipboard: paste them
   into the C.tallyDrops list to make it one of the falls. */
function debugTallyDrop(params) {
  const state = drift.state;
  state.objects = state.objects.filter((r) => r.kind !== "tally");
  state.objects.push({ v: 2, id: "tally-" + Date.now().toString(36), kind: "tally",
                       at: state.counter, pose: null, rest: false,
                       drop: params || randomTallyDrop(tally.o ? tally.o.reach : 3) });
  drift.write(state);
  sync();
  const rec = state.objects.find((r) => r.kind === "tally");
  const text = JSON.stringify(rec.drop);
  console.log("tally drop: " + text);
  try { navigator.clipboard.writeText(text); } catch (err) {}
  return rec.drop;
}

/* WITHOUT THE CONSOLE — so the window can stay full screen while
   choosing. In debug mode (?drift=debug):
     T         a new random fall
     Shift+T   the last fall again
   The values are copied to the clipboard and shown bottom-right. */
let lastDrop = null;

function bindDropKeys() {
  window.addEventListener("keydown", (e) => {
    if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey &&
        document.querySelector("[data-drift-debug]")) {
      togglePageOverlay();
      return;
    }
    if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey &&
        document.querySelector("[data-drift-debug]")) {
      cyclePageFace();
      return;
    }
    /* Arrow keys, not [ ]: they are in the same place on every
       keyboard layout (AZERTY included). They do not scroll while the
       picture is shown -- use the wheel or the scrollbar. */
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") &&
        document.getElementById("drift-3d-page-check")) {
      e.preventDefault();
      scalePage(e.key === "ArrowUp", e.shiftKey);
      return;
    }
    if (e.key !== "t" && e.key !== "T") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!document.querySelector("[data-drift-debug]")) return;   /* debug mode only */
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    lastDrop = debugTallyDrop(e.shiftKey && lastDrop ? lastDrop : undefined);
    showDrop(lastDrop, e.shiftKey);
  });
}

function showDrop(drop, replay) {
  showInfo((replay ? "replayed" : "new fall") + " (copied) — T new, Shift+T again\n" +
           JSON.stringify(drop));
}

function showInfo(text) {
  let el = document.getElementById("drift-3d-drop");
  if (!el) {
    el = document.createElement("div");
    el.id = "drift-3d-drop";
    el.setAttribute("data-drift-debug", "");       /* drift leaves it alone */
    el.setAttribute("data-drift-keep", "");
    el.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:9999;max-width:min(90vw,520px);" +
      "font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;background:#000;color:#fff;" +
      "padding:6px 8px;white-space:pre-wrap;word-break:break-all;pointer-events:none";
    document.body.appendChild(el);
  }
  el.textContent = text;
  window.clearTimeout(showInfo.timer);
  showInfo.timer = window.setTimeout(() => el.remove(), 12000);
}

function debugDrop(kind) {
  const state = drift.state;
  const got = drift.spawnObject(state, kind);
  if (!got) {
    console.log("drift-3d: nothing dropped" +
      (kind ? " (" + kind + " is a special already on the floor)" : ""));
    return;
  }
  drift.write(state);
  sync();
  return got;
}
