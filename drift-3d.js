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
  /* THE SLAB IS NOT SYMMETRIC. depthCm measures BACKWARD only, from
     z = 0 to the back wall, and a great deal hangs off it: the plane
     the shadows fall on sits exactly there, pageReach counts it, and
     shadowDir was tuned against that distance. Moving it moves the
     shadows. frontCm measures FORWARD, toward the visitor, and hangs
     off nothing: the front wall's position is the only thing that
     reads it. So the room is made roomier by pushing the front wall
     out, never by moving the back one.

     WHY 14, AND WHY NOT THE TALLY'S RATIO. What an elongated body
     needs in order to turn over is not its longest side but the
     DIAGONAL it sweeps while tipping. Measured off the live models:

       tally    5.01 x 5.76 x 6.78   y-z diagonal  8.90
       speaker  6.75 x 11.00 x 6.15  y-z diagonal 12.60

     The old 9 cm room gave the tally 1.01x its diagonal, which is no
     clearance at all. It never showed, because the tally is nearly a
     cube (1.35 longest to shortest) and a cube that cannot quite
     rotate just settles onto another face and looks fine. The speaker
     is 1.79, properly elongated, and when it cannot rotate it grinds
     against both walls at once, which is what "stuck" was. Copying
     the tally's clearance ratio would have landed on 10.1 and changed
     nothing. 4.5 + 14 = 18.5 is 1.47x the speaker's diagonal: room to
     turn through any orientation with margin, chosen over the 16.5
     that merely clears it, because clearing it is not the same as
     feeling free.

     The floor and side walls take max(depthCm, frontCm) + 2t, so they
     follow this on a resize and nothing else needs touching.

     Objects still ARRIVE in the old band (dropPose is unchanged, and
     deliberately so): only a pushed or dragged one comes forward, so
     shadows look as they were tuned until the visitor moves
     something. */
  depthCm: 4.5,         /* to the BACK wall, and the shadow plane */
  frontCm: 14,          /* to the FRONT wall. Applies on a resize */

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
  pagePlainColour: "#ffffff",  /* the page the metal sees where there is
                           no picture of the layout: plain, unchanging,
                           and never redrawn on scroll */
  pageImageBlur: 6,     /* px, applied once at load on a 256 px-wide copy */
  pageReach: 2,         /* how far the reflected page extends around the
                           tally, in multiples of the slab's depth: the
                           page is that far behind it */
  envEvery: 100,        /* ms between reflection updates while
                           scrolling; one exact update when it stops */

  shadows: true,
  shadowOpacity: 0.42,  /* 0 to 1 */
  shadowDir: [0.2, -0.15, -1],   /* light travel: x right, y up, z into page */
  shadowBlur: 8,        /* softness of the edges: 1 sharp, 20+ very soft */
  shadowFps: 60,        /* shadows are three of the four passes a frame
                           costs; halving this saves about a third of the
                           GPU, at the price of a shadow one frame behind
                           a fast object. 0 = every frame */
  shadowMapSize: 512,   /* silhouette resolution; halved on phones. The
                           silhouettes are blurred anyway, so a quarter
                           of the pixels costs a quarter of the work in
                           all three shadow passes */
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
  substeps: 4,          /* physics steps per 1/60 s. A heavy body landing
                           on its own light, pinned ring is too much for
                           one coarse step: the solver overshot and the
                           tally leapt back up to 60-90% of its drop
                           height. Finer steps shrink every correction.
                           (More solver iterations instead made it far
                           worse.) */

  /* MASSES. Every object's mass is set, not derived from its size:
     real proportions made the biggest block ~25x the smallest, and a
     heavy object resting on a light one is exactly what makes a
     solver jitter. The tally is the reference, and sits in the middle
     of the range; a mid-sized block weighs the same, and sizes only
     spread masses between massRange[0] and massRange[1] times it. */
  tallyMass: 68.5,      /* the tally as it was: its hull's volume, cm3 */
  massRange: [0.7, 1.4],
  massMidCm: 2.35,      /* the object size that weighs exactly tallyMass */
  lengthUnit: 5,        /* typical object size in world units (cm), so
                           Rapier's tolerances fit the scene */
  /* SETTLING: OFF. This put still-looking objects to sleep by hand,
     to quieten piles. It did the opposite: a frozen object was woken
     again by whatever was resting on it, froze a second later, and so
     on -- that cycle was the jitter. Worse, freezing one object of a
     pile left Rapier's own grouping inconsistent, so objects sank into
     each other and were driven through the floor. Sleeping is Rapier's
     business; this waits for a number of steps that never arrives, so
     it never touches anything. Lower settleSteps to 60 to bring it
     back for a comparison. */
  settleSteps: Infinity,  /* physics steps before an object is frozen */
  /* THE CABLE (stage one). The connector is a real rigid body; the
     cable is NOT. A jointed chain in Rapier is the classic case that
     never quite settles, and allAsleep() stopping the loop is the
     whole reason this page costs nothing when nobody is touching it.
     So the cable is a Verlet rope stepped by hand: it collides with
     the floor, the walls and the objects ONE WAY (the rope is pushed
     out of them, they are not pushed by it), so no energy ever enters
     the physics world and everything still sleeps. The one real force
     it applies is the leash, on one body, only while taut. */
  /* RESOLUTION, IN CENTIMETRES OF ROPE PER SEGMENT. This is what keeps
     a longer cable behaving like a shorter one: hold the segment length
     fixed and the node count follows the cable, so stiffness, sag, bend
     and settling all stay put and only the amount of rope changes. It
     used to be the other way round -- a fixed ceiling on nodes -- which
     meant every extra centimetre of cable made the segments coarser and
     quietly changed the physics along with the length.

     Lower is finer and costs proportionally more; the cost is linear in
     nodes and there is room, at about 50 microseconds a frame against a
     16,700 budget. Note that self-collision works by keeping nodes a
     diameter apart, so at 3 cm segments and a 5 mm cable it is already
     doing much less than it looks -- going finer is the only thing that
     buys that back. */
  cableSegCm: 3,        /* phone: 4.5 */
  cableNodes: 6,        /* floor: below this there are not enough to pin */
  cableNodesMax: 64,    /* phone: 32. A GUARD, not a setting: it should
                           never bind at any sane length, and if it does
                           the cable has quietly stopped scaling */
  cableSelfGive: 0.7,   /* how hard a crossing is pushed apart per step.
                           Hard separation fights the length constraint
                           and the two ring at each other forever, which
                           would mean the page never sleeps */
  cableTipFree: 2,      /* MINIMUM nodes excused from the connector's own
                           push-out; the real figure is worked out in
                           startCable from the model's length and the
                           segment, because it has to cover the body the
                           cable comes out of. This was a flat 4, with a
                           comment claiming that was really a distance
                           since the segment tracks the thickness -- true
                           until the node count hits cableNodesMax, which
                           a thin cable does. Past that the segment stops
                           shrinking, 4 nodes stops covering the barrel,
                           and the nodes inside it are shoved out while
                           their neighbours are excused. They fight, at
                           over a centimetre a step, and the rope never
                           goes still: the loop never stops and the page
                           never sleeps. */
  cableSelfSkip: 2,     /* neighbours within this many nodes are left to
                           the length and bend constraints: they are
                           MEANT to be touching, and telling them to push
                           apart is telling the rope to explode */
  cablePasses: 10,      /* WHY SO MANY NOW. Four was enough when the only
                           constraint was length. Self-collision needs
                           iterations to converge: at four passes a
                           crammed cable still overlapped itself by 4 mm
                           out of a 6 mm diameter, which reads as passing
                           through; by ten it is under 2 mm, which reads
                           as squeezing. Most of that gain is the rope
                           converging at all -- an under-iterated rope
                           overlaps itself even with collision off */
  cableRadiusCm: 0.25,   /* ALSO THE CLEARANCE it keeps from the floor, the
                           walls and every object, so a thinner cable
                           hugs the floor and a thicker one rides above
                           it. That is correct, but it means a change
                           here looks like more than a change of width */
  cableSmooth: 5,       /* RINGS DRAWN PER SIMULATED SEGMENT. The rope is
                           16 points, so drawing straight through them put
                           a corner at every one -- and the push-out and
                           the floor clamp make that worse by snapping
                           nodes flat onto faces. The curve the cable is
                           drawn along is splined through the nodes
                           instead, which costs only the drawing and is
                           why the simulation can stay coarse. 1 gives
                           the old polyline back */
  cableRadial: 10,      /* sides of the tube. Raised with the spline: a
                           smooth centreline makes the flat sides the most
                           obvious thing left.
                           Went to 10 while it was lacquered, because a
                           sharp highlight runs the length of the tube
                           and shows every facet it crosses; back to 8
                           now that it is satin and thinner, where there
                           is no highlight tight enough to catch them */
  cableColour: "#000000",   /* a shade up from #121215: dropping the gloss
                               took away the highlights that were doing
                               the reading, and it went flat black */
  cableRoughness: 0.7,      /* satin. 0.28 was lacquer, 0.85 was matte flex */
  cableMetalness: 0.9,
  cableClearcoat: 0,     /* just enough second reflection to say rubber
                               rather than felt. 0 removes it entirely */
  cableClearcoatRough: 0, /* and blurred, so it is a sheen and not a line */
  cableShare: 2.1,      /* LENGTH, AS A MULTIPLE OF THE WINDOW'S DIAGONAL,
                           and THE ONE DIAL: node count, spawn height,
                           leash, pinned exit and the drop all derive from
                           it, so this changes how much rope there is and
                           nothing else about how the rope behaves.

                           2.1 is where 4 used to land: cableMaxCm was 70
                           and the length had been sitting against it, so
                           4 and 2.1 were the same cable and anything
                           above 2.1 did nothing at all.

                           It used to be a share of the WIDTH, which made
                           sense only while the cable came in at floor
                           level and ran sideways. Hanging from above,
                           what decides whether the cable is long enough
                           is how far the connector can get from the
                           anchor, and the furthest it can get is the far
                           corner -- so the diagonal is the measure, and
                           it is the right one for the side entry too.

                             1.0  just reaches every corner, pulled taut
                             1.2  reaches them with a little to spare
                             1.5  loose: coils on the floor wherever it is
                             0.7  can only be taken round its own corner

                           Fixed in cm at spawn and never recomputed, so a
                           resize changes the slack and not the cable. */
  cableMinCm: 10,
  cableMaxCm: 200,      /* A GUARD, in cm, not a setting. It was 40 and
                           then 70, and both were low enough that the
                           length sat against the ceiling: cableShare
                           could be changed and nothing happened, which
                           is the worst way for a number to fail. High
                           enough now that only a typo reaches it. */
  cableFrom: "top",     /* "top" or "side": which way the cable comes in.
                           "side" enters at floor level through the right
                           wall and lies along the floor; "top" hangs it
                           down from above the window, so the connector
                           falls and the cable pays out after it. Both
                           enter square to the edge they cross. */
  cableFromShare: 0.82, /* across the window, for "top": 0 at the left
                           edge, 1 at the right */
  cableDropSec: 3,      /* HOW THE CABLE ARRIVES. It used to begin gathered
                           at its anchor, which put a clump of rope just
                           above the top edge: it fell into view as a mass
                           of its own, ahead of the connector it is
                           supposed to be following, and a rope with every
                           node inside every other node is the worst case
                           for all of its constraints at once -- the first
                           frames cost milliseconds rather than
                           microseconds. Instead it spawns STRAIGHT, held
                           out of sight above the window by an anchor
                           lifted its own length, and that anchor comes
                           down over this long. The cable pays out behind
                           the connector, and the slack appears as the
                           anchor arrives. 0 spawns it gathered again. */
  cableOutCm: 3,        /* how far PAST the edge it crosses the anchor sits. The
                           renderer scissors to the window (see VIEWPORT), so
                           this much cable is genuinely clipped away and the
                           rest arrives from somewhere the visitor cannot see */
  cableBendDeg: 30,     /* THE BEND RADIUS. A rope of distance constraints
                           has no opinion about angles, so it will happily
                           turn 85 degrees inside one segment -- which is
                           what the spikes were, and they sat exactly at
                           the node pinned to the connector, where the
                           axis the cable must leave along disagrees with
                           the direction it wants to hang. Real cable
                           cannot do that. Each triple of nodes is held at
                           least this far from doubling back. 180 disables
                           it; below about 30 the cable turns into wire */
  cableBendGive: 0.5,   /* how hard that is enforced per pass. Full
                           strength fights the length constraint and the
                           two of them ring at each other instead of
                           settling */
  /* WHY IT USED TO POUR RATHER THAN LIE. A chain of distance constraints
     has no memory and no grip: every loop you leave in it opens out
     under its own weight, and it arrives flat on the floor like
     something poured. Two things were missing.

     FRICTION. A node touching the floor or a box kept all its sideways
     speed, so a loop simply slid apart. On contact, a share of the
     velocity goes. */
  cableFriction: 0.55,  /* 0 is ice, 1 is glue. This is the SPEED half:
                           it takes away what a node had. On its own it
                           barely grips, because a rope on the floor is
                           not sliding under its own momentum -- it is
                           being dragged by the length constraint, which
                           moves nodes outright and never consults a
                           velocity. Turning this to 1 still left the
                           cable slithering, which is how the other half
                           below came to exist. */
  cableGripCm: 0.15,    /* THE STATIC HALF. How far a node touching
                           something may be dragged in one step before it
                           gives. Under this it does not move at all, so
                           a coil left on the floor stays a coil; over it
                           the excess goes through and the cable slides,
                           but slower. 0 is ice however high friction is;
                           past about 0.2 the rope stops being draggable
                           and starts being nailed down. */

  /* MEMORY, which is what actually makes a cable look like a cable.
     Real cable deforms plastically: bend it and it stays bent, which is
     why a coiled one keeps its hoops on the floor instead of relaxing
     flat. Each triple of nodes remembers how open it was, resists being
     moved away from that, and then slowly accepts wherever it has ended
     up as the new rest shape. Stiffness is the resisting; memory is the
     accepting. Both zero gives back the liquid rope. */
  cableStiff: 0.18,     /* how hard it holds the shape it remembers */
  cableTaut: 0.012,     /* WHERE MEMORY STOPS. A hanging span is under
                           tension and a heap on the floor is not, and
                           tension is exactly what pulls the kinks out of
                           real cable -- which is why the hanging stretch
                           looked wrong kinked while the floor looked
                           right. The rope already knows: the length
                           constraint cannot fully satisfy a loaded
                           segment, so a segment stretched past its
                           nominal by more than this is carrying weight,
                           and there the cable forgets its shape and
                           hangs straight. Raise it and the whole rope
                           keeps its kinks; drop it to 0 and nothing
                           does. */
  cableYieldCm: 0.35,   /* how far a triple may be bent before the change
                           becomes permanent. Below this the cable is a
                           spring and comes back; this is what gives it
                           any shape at all */
  cableMemory: 0.25,    /* and how readily it gives in, past that */

  cableDamp: 0.06,      /* velocity lost per step: what makes it settle */
  cableStillCm: 0.004,  /* under this much movement in ONE step it counts
                           as asleep */
  cableCalmSteps: 45,   /* AND A SECOND OPINION, over three quarters of a
                           second, because the first one is a per-step
                           test and a rope can fail it forever without
                           going anywhere. One node oscillating six
                           hundredths of a millimetre a step -- far too
                           small to see, in the middle of a hanging span,
                           touching nothing -- is enough to keep the loop
                           running for as long as the tab is open. So the
                           rope also remembers where it was this long ago,
                           and if it has not actually GONE anywhere since,
                           it is still, whatever it is doing per step. */
  cableCalmCm: 0.05,    /* ... "anywhere" being this far, about half a
                           millimetre over that whole time */
  cableSettle: 60,      /* steps run before the first paint, so it arrives
                           draped rather than snapping into a curve */
  /* THE LEASH HAS TO BEAT THE HAND. These were 120 and 600, and 600
     cm/s2 is exactly 10g -- the same cap steerDrag puts on the grip via
     gripStrength. A dead tie, so a dragged connector went wherever the
     pointer went and the cable stretched to half again its length
     behind it, like elastic. The leash is now three times the grip, so
     past its length the cable wins and the connector is what gives. */
  cableLeash: 300,      /* cm/s2 per cm of overshoot: 5g per cm */
  cableLeashMax: 1800,  /* ... capped at 30g, against the grip's 10g */
  cableLeashDamp: 10,   /* resists pulling further out, stops the bounce */
  connectorCm: 5.4,     /* an XLR connector's real body length */

  settleDist: 0.25,     /* ... if it moved less than this many cm ... */
  settleAngle: 3,       /* ... and turned less than this many degrees */
  dragGain: 18,
  grabStiffness: 0.4,   /* share of the held point's error corrected per
                           step; higher is stiffer, too high jitters */
  dragMaxPx: 4000,      /* px/s: a flick throws, never teleports */
  gripStrength: 10,     /* the most a hand can push, in multiples of the
                           held object's own weight. Plenty to lift and
                           throw; not enough to crush the pile under it
                           into the floor, which is what an unlimited
                           grip did */
  wallSpeed: 120,       /* cm/s, the fastest a wall may travel while it is
                           DRAGGED. High enough to keep up with a hand,
                           so a wall pushes and bounces things properly
                           rather than lagging behind and stepping */
  wallJump: 25,         /* cm. Past this the window did not move, it
                           JUMPED (maximise, restore, a snapped corner):
                           a wall at a thousand km/h. That is made in one
                           go instead, and whatever ends up outside is
                           carried back in and set down */
  speedMax: 60,         /* cm/s, and a spin of an eighth of that. No
                           object may exceed it, so a wall driven into
                           something bounces it rather than launching it.
                           Below a hard throw (~80) on purpose: throws
                           are capped too, which makes everything feel
                           heavier and more deliberate */
  windowPoll: 250,      /* ms between checks of where the window sits on
                           the screen: nothing reports a window move */
  maxFps: 60,           /* drawing is capped here. A 144 Hz laptop screen
                           was being drawn 144 times a second, each frame
                           costing a scene pass, a shadow pass and two
                           blur passes -- more than twice the work for
                           motion no one can see. The physics still runs
                           in real time, in its own fixed steps. 0 = no
                           cap (draw at the screen's rate) */
  pixelRatioMax: 1.5,   /* screen pixels per CSS pixel. 2 draws ~78% more
                           pixels than 1.5 for a difference you have to
                           look for on a dense screen: the cheapest GPU
                           saving there is */

  /* THE TALLY MODEL */
  modelURL: new URL("models/tally.glb", import.meta.url).href,
  speakerURL: new URL("models/speaker.glb", import.meta.url).href,
  connectorURL: new URL("models/connector.glb", import.meta.url).href,
  speakerCm: 11,        /* its height on the floor: about twice the tally.
                           Not its real 30 cm -- that would stand taller
                           than the window */
  hingeMin: 0,          /* the ring, about its pin, from rest... */
  hingeMax: 230 * DEG,  /* ...to where it would meet the body */
  restDigit: 7,         /* what the wheels show as modelled */
  digitStep: -36 * DEG, /* wheel turn for +1, about its own axle */
  buttonTravel: 0.45,   /* share of the button's length it sinks */

  /* THE PRESS — ms */
  arrivalDelay: 200,    /* after the tally appears, before it presses */
  /* THE SPEAKER. Tap it (press and release without moving) and it plays
     one of its sounds at random; tap again and it stops. Dragging it
     never makes a sound, so moving it out of the way is never noisy.

     WHICH SOUNDS: a browser cannot read a folder, so the list comes
     from sounds/sounds.json -- written by the build from whatever
     sounds/speaker-*.mp3 files exist, so dropping a file in is all it
     takes. Without that file, speaker-1.mp3, speaker-2.mp3 ... are
     tried in turn until one is missing, which covers numbered files
     with no build step at all. */
  speakerList: "sounds/sounds.json",
  speakerProbe: 12,     /* how far the numbered fallback counts */
  speakerSounds: [],    /* filled in at load; a list here overrides both */
  speakerVolume: 0.9,
  speakerPan: 0.85,     /* how far the sound follows it across the window:
                           1 = fully left/right at the edges, 0 = centred
                           always. Costs nothing -- one value per frame */
  speakerPulse: 0.05,   /* how much it breathes with the sound: 0.05 =
                           5% bigger at the loudest. The MODEL only --
                           its collision shape never changes, so a
                           breathing speaker still rests and stacks like
                           a still one */
  levelCurve: 2.5,      /* how sharply the light answers the sound. 1 =
                           follows the loudness; higher = stays dark and
                           snaps on, which reads as a light rather than a
                           dimmer. (Lost when the glare was removed, which
                           left the speaker's glow as "not a number" and
                           turned the whole model black on the first
                           tap.) */
  /* THE LIGHT: simply on or off. It followed the sound's loudness
     before, which meant it spent most of its time near zero and read as
     broken. On while something plays, off when nothing does. */
  speakerGlowOff: 0,
  speakerGlowOn: 1,
  tapSlop: 6,           /* px of movement still counted as a tap, not a
                           drag */
  tapTime: 500,         /* ms, likewise */

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
  audioWaitMax: 900,    /* ms. On a page's first click the browser may
                           still be starting its audio (Firefox takes a
                           few hundred ms); the leave waits for it, but
                           never longer than this -- then it presses
                           silently and goes */

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
  keys:    { size: [7, 3.5, 1], planar: true },
  connector: { size: [1.9, 5.4, 1.9], planar: false }
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

/* ON A PHONE. Same scene, a few values of its own: a weaker chip, a
   much denser screen, and a hand rather than a pointer. Applied once,
   over C, before anything is built. */
const PHONE = {
  speedMax: 120,        /* faster than on desktop (60): on a small screen
                           the walls are close, and a tightly capped
                           bounce reads as sluggish */
  shadowOpacity: 0.2,
  shadowFps: 30,        /* halves the shadow work, the heaviest part */
  cableNodes: 16,       /* fewer nodes and one fewer pass: the rope is
                           cheap either way, but this is free to give */
  cablePasses: 3
};

const onPhone = () =>
  Math.min(window.screen.width || 9999, window.screen.height || 9999) < 700 ||
  (window.matchMedia && window.matchMedia("(pointer: coarse)").matches &&
   (window.screen.width || 9999) < 900);

if (drift && onPhone()) Object.assign(C, PHONE);

/* -----------------------------------------------------------------
   BOOT
   ----------------------------------------------------------------- */

const reduced = () =>
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let W = 0, H = 0;      /* the window's content area, CSS px */
let SW = 0, SH = 0;    /* the screen: the world is this size, always */
let VX = 0, VY = 0;    /* where the window's content sits on the screen */

/* Where the window's content area starts on the screen. Firefox says
   so exactly; elsewhere it is deduced from the window's outer and
   inner size, which is right to a pixel or two. */
function windowOnScreen() {
  const x = window.mozInnerScreenX !== undefined
    ? window.mozInnerScreenX
    : window.screenX + Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const y = window.mozInnerScreenY !== undefined
    ? window.mozInnerScreenY
    : window.screenY + Math.max(0, window.outerHeight - window.innerHeight);
  /* NOT rounded: rounding made the far wall jump a pixel back and
     forth while the near edge was dragged, and objects resting on it
     twitched with it. */
  return { x, y };
}
let renderer, scene, camera, world, canvas, root;
let wallBodies = [];
let model = null, speakerModel = null, connectorModel = null;   /* the loaded glTF, or null → primitive */
const objects = new Map();      /* id -> { id, kind, parts:[{body,mesh}], half, dispose } */

if (drift) start().catch((err) => {
  /* Progressive enhancement: no WebGL, no WASM, a blocked file --
     the page is still the page. */
  console.warn("drift-3d: not started", err);
  document.documentElement.classList.add("drift-3d-live");   /* drop the picture */
  if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
});

async function start() {
  /* The sound first, before waiting for anything: it is what a click on
     this page needs, and physics and the model take about a second. A
     visitor who clicks a link sooner than that used to find no sound
     loaded yet -- so no press on the way out, and a silent one on the
     next page.

     After one `await`, not immediately: start() is called while this
     file is still being read, before `const sound` further down
     exists. Calling loadSounds() synchronously hit that not-yet-
     defined constant; the error landed inside its own try/catch and
     sound was silently switched off. The await lets the file finish
     loading first -- still well before anything else is ready. */
  await null;
  loadSounds();

  const loader = new GLTFLoader();
  const [, gltf, spk, con] = await Promise.all([
    RAPIER.init(),
    loader.loadAsync(C.modelURL).catch((err) => {
      console.warn("drift-3d: tally model not loaded, using a stand-in", err);
      return null;
    }),
    loader.loadAsync(C.speakerURL).catch((err) => {
      console.warn("drift-3d: speaker model not loaded, using a stand-in", err);
      return null;
    }),
    loader.loadAsync(C.connectorURL).catch(() => null)   /* optional: quiet */
  ]);
  model = gltf;
  speakerModel = spk;
  connectorModel = con;


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
  world.timestep = C.step / C.substeps;
  world.numSolverIterations = C.solverIterations;
  world.lengthUnit = C.lengthUnit;

  injectStyle();
  measure();
  sync();

  document.addEventListener("drift:change", onChange);
  window.addEventListener("resize", onResize);
  if (window.visualViewport) {
    /* The address bar sliding in and out is reported here, and nowhere
       else. */
    window.visualViewport.addEventListener("resize", onResize);
    window.visualViewport.addEventListener("scroll", onResize);
  }

  /* Browsers report a resize, but never a window MOVE. Without this,
     dragging the window across the screen would leave the walls
     behind. Cheap: two numbers compared a few times a second, and
     only while the page is on screen. */
  window.setInterval(() => {
    if (document.visibilityState === "hidden" || !canvas) return;
    const vv = window.visualViewport;
    const at = windowOnScreen();
    const x = at.x + (vv ? vv.offsetLeft : 0), y = at.y + (vv ? vv.offsetTop : 0);
    const w = Math.round(vv ? vv.width : (document.documentElement.clientWidth || window.innerWidth));
    const h = Math.round(vv ? vv.height : window.innerHeight);
    if (Math.abs(x - VX) < 0.5 && Math.abs(y - VY) < 0.5 && w === W && h === H) return;
    measure();
    wake();
  }, C.windowPoll);
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
  warmCable();
  drift.objects3d = { objects, world, scene, C, PXCM, snapshot, env, sound,
                      get cable() { return cable; } };
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

/* THE WORLD IS THE SCREEN, THE WINDOW IS A FRAME CUT INTO IT.
   The canvas is allocated once, at screen size, and never resized:
   reallocating its drawing surface on every step of a resize was the
   flicker (for one frame the browser has no image to show). What
   changes when the window moves or is resized is only where the
   canvas is offset, which part of it is drawn, and where the walls
   stand. An object the walls do not touch does not move at all. */
function measure() {
  /* THE VISIBLE AREA, WHICH A PHONE CHANGES AS YOU SCROLL. When the
     address bar slides away the page gets taller, and window.innerHeight
     does not always follow: the floor then sat a bar's height above or
     below the bottom of the screen -- the floor "floating". The visual
     viewport reports what is actually on screen at that moment, bar
     included, so the floor stays on the bottom edge throughout. */
  const vv = window.visualViewport;
  W = Math.round(vv ? vv.width : (document.documentElement.clientWidth || window.innerWidth));
  H = Math.round(vv ? vv.height : window.innerHeight);
  const scr = window.screen || {};
  SW = Math.max(scr.width || 0, W);
  SH = Math.max(scr.height || 0, H);
  const at = windowOnScreen();
  const offX = vv ? vv.offsetLeft : 0, offY = vv ? vv.offsetTop : 0;
  VX = Math.max(0, Math.min(at.x + offX, SW - W));
  VY = Math.max(0, Math.min(at.y + offY, SH - H));

  /* Allocated once (and again only if the screen itself changes). */
  if (canvas.width !== Math.round(SW * renderer.getPixelRatio()) ||
      canvas.height !== Math.round(SH * renderer.getPixelRatio())) {
    renderer.setSize(SW, SH, true);
  }
  canvas.style.left = (-VX).toFixed(2) + "px";
  canvas.style.top = (-VY).toFixed(2) + "px";

  /* The camera covers the whole screen; x = 0 is the screen's left
     edge, y = 0 its bottom. Those never move. */
  camera.left = 0;
  camera.right = SW;
  camera.top = SH;
  camera.bottom = 0;
  camera.updateProjectionMatrix();

  /* Only the window's part of the canvas is drawn. */
  renderer.setScissor(VX, SH - (VY + H), W, H);
  renderer.setScissorTest(true);

  if (shadow) fitShadows();
  buildBounds();
}

function buildBounds() {
  const left = VX / PXCM, right = (VX + W) / PXCM;
  const floorY = (SH - (VY + H)) / PXCM;
  const d = C.depthCm;
  const t = 5;                          /* wall thickness, cm */
  const tall = (H / PXCM) * 4 + 50;     /* far above the window, so a
                                           thrown object comes back */
  const midX = (left + right) / 2, halfX = (right - left) / 2;

  /* The floor and the side walls have to reach as far FORWARD as the
     front wall does, or an object pushed to the front drops through
     the gap where the floor has run out. They are invisible, so
     making them deeper than strictly needed costs nothing: they take
     the larger of the two depths, and stay centred on z = 0 so they
     overhang behind the back wall rather than short of the front. */
  const dz = Math.max(d, C.frontCm) + 2 * t;

  const place = [
    [halfX + 2 * t, t, dz, midX, floorY - t, 0],                           /* floor */
    [t, tall, dz, left - t, floorY + tall - t, 0],                         /* left  */
    [t, tall, dz, right + t, floorY + tall - t, 0],                        /* right */
    [halfX + 2 * t, tall, t, midX, floorY + tall - t, -d - t],             /* back  */
    [halfX + 2 * t, tall, t, midX, floorY + tall - t, C.frontCm + t]       /* front */
  ];

  /* THE WALLS ARE KINEMATIC, AND MOVED, NOT REBUILT.
     Rebuilding them broke every contact for a frame, which is what
     made a resize flicker. And a FIXED wall that is teleported has no
     speed: the physics just found objects overlapping it and eased
     them out, which is how the tally ended up half through the floor
     when the bottom edge was dragged up. A kinematic wall's speed is
     worked out from its movement, so it pushes what is in its way. */
  if (!wallBodies.length) {
    wallBodies = place.map(([hx, hy, hz, x, y, z]) => {
      const b = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(x, y, z)
          .setCcdEnabled(true));        /* a wall swept up fast used to
                                           pass straight through what was
                                           resting on it */
      const c = world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setFriction(0.8), b);
      return { body: b, collider: c, size: [hx, hy, hz], target: { x, y, z } };
    });
  } else {
    place.forEach(([hx, hy, hz, x, y, z], i) => {
      const wall = wallBodies[i];
      if (wall.size[0] !== hx || wall.size[1] !== hy || wall.size[2] !== hz) {
        wall.collider.setShape(new RAPIER.Cuboid(hx, hy, hz));
        wall.size = [hx, hy, hz];
      }
      wall.target = { x, y, z };        /* approached in stepWalls() */
    });
  }

  /* A move is pushed by the walls; a jump is carried. */
  const jumped = wallBodies.some((wall) => {
    const p = wall.body.translation(), t = wall.target;
    return Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z) > C.wallJump;
  });
  for (const o of objects.values()) {
    for (const part of o.parts) part.body.wakeUp();
  }
  if (jumped) {
    for (const wall of wallBodies) wall.body.setTranslation(wall.target, true);
    carryInside();
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

/* What leaveHold would answer, without arming it. */
function peekHold() {
  const was = holding;
  const ms = leaveHold();
  holding = was;
  return ms;
}

/* How long a link click holds the page (see drift.js). A number of
   ms when the audio is already running. When it is not -- the first
   click on this page, and the browser still has to start its audio --
   a promise instead: drift.js waits for it. The press itself waits for
   the audio too (see onChange), so the sound and the button still
   start together, and the page leaves one press later. */
function leaveHold() {
  if (C.leaveHold === 0 || reduced()) return 0;
  if (!tally.o || !tally.view || !sound.buffer || !sound.ctx || sound.ctx.state === "closed") return 0;
  holding = true;
  const ms = C.leaveHold || Math.max(C.pressDown + C.pressUp, C.pressDown * 0.5 + C.roll);
  if (sound.ctx.state === "running") return ms;

  return new Promise((resolve) => {
    let settled = false;
    const go = () => { if (!settled) { settled = true; resolve(); } };
    sound.onAudioReady = () => window.setTimeout(go, ms);
    window.setTimeout(go, C.audioWaitMax + ms);          /* never stuck */
  });
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
      const press = () => {
        tally.waitUntil = 0;
        stepTally(performance.now());
        wake();
        if (sound.onAudioReady) { sound.onAudioReady(); sound.onAudioReady = null; }
      };
      if (sound.ctx && sound.ctx.state !== "running") {
        /* Still inside the click, so resume() is allowed; wait for the
           audio to really run, then press -- or give up and press
           silently, so the page is never kept waiting. */
        let pressed = false;
        const once = () => { if (!pressed) { pressed = true; press(); } };
        tally.waitUntil = Infinity;    /* the animation loop must not press first */
        sound.gestureAt = performance.now();
        sound.ctx.resume().then(once, once);
        window.setTimeout(once, C.audioWaitMax);
      } else {
        press();
      }
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
    /* No picture of the layout here, but the metal should still see a
       page behind it: a plain white one, in the same place. Otherwise
       the tally reflects the bare room on these pages and looks
       different from one page to the next. */
    env.status = "plain white page (not a project page): " + window.location.pathname;
    buildPageFace(true);
    return;
  }
  /* The white page FIRST, before the picture has loaded. Otherwise the
     metal reflects the bare room for as long as the picture takes to
     arrive, and the reflections visibly drop out and come back when a
     project page opens. */
  buildPageFace(true);

  const url = new URL(C.pageImage, window.location.href).href;
  env.status = "loading " + url;
  const img = new Image();
  img.onerror = () => {
    env.status = "picture not found, plain white page instead: " + url;
    console.warn("drift-3d: " + env.status);   /* the white page is already up */
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
      env.lastKey = "";        /* the face is already there: just redraw it */
      requestEnv(true);
    } catch (err) {
      env.status = "loaded, but the reflection setup failed: " + err.message;
      console.warn("drift-3d:", err);
    }
  };
  img.src = url;
}

function buildPageFace(plain) {
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
  env.room.add(env.plane);

  /* PLACED IN WORLD SPACE, NOT THE ROOM'S. RoomEnvironment shifts its
     whole scene 3.5 units down (position.y = -3.5) to sit the room
     around the viewer. A plane added at (0, 0, -0.5) in the room's own
     space ended up 3.5 below the point the reflections are captured
     from -- out of every view, so the page never reached the metal.
     worldToLocal undoes whatever offset the room has. */
  env.room.updateMatrixWorld(true);
  env.plane.position.copy(env.room.worldToLocal(new THREE.Vector3(0, 0, -0.5)));

  if (plain) {
    const ctx = env.faceCanvas.getContext("2d");
    ctx.fillStyle = C.pagePlainColour;
    ctx.fillRect(0, 0, env.faceCanvas.width, env.faceCanvas.height);
    env.faceTex.needsUpdate = true;
  } else {
    drawPageFace();
  }
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
  let sx = W / 2, sy = H / 2;    /* the middle of the window, in px */
  if (tally.o) {
    const p = tally.o.parts[0].body.translation();
    sx = p.x * PXCM - VX;
    sy = SH - p.y * PXCM - VY;
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

function updateEnv() {
  env.due = false;
  env.last = performance.now();
  if (!env.page || !env.cubeCam) return;
  if (!drawPageFace()) return;

  /* Re-render the back face only (index 5, looking toward -z), then
     rebuild the reflections into the same target. */
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(env.cubeRT, 5);
  renderer.render(env.room, env.cubeCam.children[5]);
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
  drawCable();
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

   THE LIGHTBOX, DURING THE MIRROR. Outside body, nothing inside body
   -- the lightbox overlay included -- can be layered above the canvas
   (body is a stacking context). So while a lightbox is open, the
   canvas goes back INTO body, where the page's own lightbox rules
   cover and blur it like every other child of body. Inside the
   mirrored body it would be flipped and no longer fixed, so for that
   time it carries its own scaleX(-1) -- flipped twice is the right
   way round -- and is positioned absolutely, measured so it lands
   exactly where it was on screen. The lightbox locks scrolling, so
   it stays put. When the lightbox closes it goes back out.

   WHEN IT MOVES. Any change to <html>'s data-event or class -- an
   event applied by a click, by the debug picker, by drift.force(),
   by anything -- re-checks the place at once. Waiting for the next
   drift:change is what left the scene mirrored until one more click.
   ----------------------------------------------------------------- */

let canvasOutside = false, placed = "";

function placeCanvas() {
  if (!canvas || !document.body) return;
  const t = getComputedStyle(document.body).transform;
  const mirrored = !!t && t !== "none";
  const open = document.documentElement.classList.contains("lightbox-open");
  const mode = !mirrored ? "body" : open ? "tucked" : "outside";
  canvasOutside = mode === "outside";

  /* The observer also fires for our own hover / grab classes: only act
     when the place actually changes. */
  if (mode === placed) return;
  placed = mode;

  const st = canvas.style;
  const parent = mode === "outside" ? document.documentElement : document.body;
  if (canvas.parentNode !== parent) parent.appendChild(canvas);   /* keeps the GL context */

  if (mode !== "tucked") {
    /* The canvas is screen-sized and offset so its pixels line up with
       the screen, whatever the window's position. */
    st.position = "fixed"; st.left = (-VX).toFixed(2) + "px";
    st.top = (-VY).toFixed(2) + "px"; st.transform = "";
    return;
  }
  st.position = "absolute"; st.top = "0px"; st.transform = "scaleX(-1)";
  /* Measured, not computed: moving `left` inside a mirrored body moves
     the canvas on screen the OTHER way, so find the direction with two
     readings, then solve for the left that puts its edge at 0. */
  st.left = "0px";
  const a0 = canvas.getBoundingClientRect();
  st.left = "10px";
  const a1 = canvas.getBoundingClientRect();
  const dir = (a1.left - a0.left) / 10 || 1;
  st.left = (-a0.left / dir) + "px";
  st.top = (-a0.top) + "px";
}

function watchLightbox() {
  new MutationObserver(placeCanvas)
    .observe(document.documentElement,
             { attributes: true, attributeFilter: ["class", "data-event"] });
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
/* Turning only in the plane of the screen, for the same reason: a
   tumble through the depth is what wedges an object between the front
   and back walls on the way down. Collisions can still tip it any way
   they like once it is in the room. */
function spin(desc) {
  if (reduced()) return;
  desc.setAngvel({ x: 0, y: 0, z: (Math.random() - 0.5) * 6 });
}

function dropPose(half, planar, stagger, lead, tiltDeg) {
  const r = Math.max(half[0], half[1]);
  const left = VX / PXCM, right = (VX + W) / PXCM;
  const span = Math.max(0, right - left - 2 * r - 0.4);
  const x = left + r + 0.2 + Math.random() * span;
  const z = (Math.random() * 2 - 1) * Math.max(0, C.depthCm - half[2]);

  /* From above the top edge; with reduced motion, from a third of
     the way up, so the fall is short. Several at once are stacked in
     the air so they do not spawn inside one another. */
  const floorY = (SH - (VY + H)) / PXCM, screenH = H / PXCM;
  const base = floorY + (reduced() ? screenH * 0.35 : screenH + r);
  const y = base + r + stagger * (r * 2 + 1);

  /* SQUARE TO THE ROOM, AND ONLY TURNED IN THE PLANE OF THE SCREEN.
     Objects used to arrive at any angle, which makes a deep one (the
     speaker is 6 cm through, in a room 9 cm deep) stick out further
     than its own thickness and wedge between the front and back walls,
     high above the window where nobody can see it. Upright, it can
     never take more depth than it has. */
  const q = new THREE.Quaternion();

  /* SOMETHING WITH A RIGHT WAY UP arrives that way up. A connector falls
     plug first, the way a dropped plug does and the way its cable
     wants -- tail uppermost, so the cable leaves the top of it instead
     of being laid over the end that is leading the fall. The shape says
     which of its own axes leads and how far it may stray; everything
     else keeps the rule below. */
  if (lead) {
    q.setFromUnitVectors(lead, DOWN);
    const tilt = (tiltDeg === undefined ? 60 : tiltDeg) * Math.PI / 180;
    const axis = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1,
                                   Math.random() * 2 - 1);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    /* sqrt so the angles are spread evenly over the cone rather than
       bunched at its middle */
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(
      axis.normalize(), Math.sqrt(Math.random()) * tilt));
    return { p: [x, y, z], q: [q.x, q.y, q.z, q.w] };
  }

  q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (Math.random() - 0.5) * 0.8);
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
  const center = new THREE.Vector3(SW / 2, SH / 2, 0);
  cam.position.copy(center).addScaledVector(dir, -2000);
  cam.lookAt(center);
  cam.left = -SW / 2 - pad; cam.right = SW / 2 + pad;   /* around its centre */
  cam.bottom = -SH / 2 - pad; cam.top = SH / 2 + pad;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  shadow.planeMat.uniforms.shadowMatrix.value
    .multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

  plane.scale.set(SW / PXCM + 20, SH / PXCM + 20, 1);
  plane.position.set(SW / PXCM / 2, SH / PXCM / 2, -C.depthCm);
}

/* Steps 1 and 2 above; call before rendering the scene. */
let shadowAt = 0;

function drawShadows(now) {
  if (!shadow) return;
  if (C.shadowFps && now !== undefined) {
    if (now - shadowAt < 1000 / C.shadowFps - 1) return;   /* keep the last one */
    shadowAt = now;
  }
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
  if (cable && cable.id === o.id) stopCable();
}

/* -----------------------------------------------------------------
   GENERIC OBJECTS AND PRIMITIVE SPECIALS — one body each
   ----------------------------------------------------------------- */

/* Mass from volume (cm3): size only nudges it around the tally's. */
function massFor(volume) {
  const size = Math.cbrt(Math.max(volume, 1e-6));
  const k = Math.pow(size / C.massMidCm, 0.7);
  return C.tallyMass * Math.min(C.massRange[1], Math.max(C.massRange[0], k));
}

function build(rec, stagger) {
  const shape = shapeOf(rec);
  if (!shape) return null;

  const pose = rec.pose ||
    dropPose(shape.half, shape.planar, stagger, shape.dropLead, shape.dropTilt);
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
    shape.collider(hx, hy, hz).setFriction(0.7).setRestitution(0.15)
      .setMass(massFor(rec.kind === "cylinder"
        ? Math.PI * hx * hx * hy * 2          /* half extents: r, h/2, r */
        : 8 * hx * hy * hz)),
    body);
  if (rec.rest) body.sleep();

  tag(shape.mesh, rec.id, 0);
  root.add(shape.mesh);

  const made = { id: rec.id, kind: rec.kind, parts: [{ body, mesh: shape.mesh }],
                 half: shape.half, dispose: shape.dispose, shape: shape };
  /* A speaker arrives silent, so it arrives unlit: the model's own
     emission would otherwise have it glowing from the moment it lands. */
  if (rec.kind === "speaker") setSpeakerGlow(made, 0);
  if (rec.kind === "connector") startCable(made, rec);
  return made;
}

const box = (hx, hy, hz) => RAPIER.ColliderDesc.cuboid(hx, hy, hz);

function shapeOf(rec) {
  switch (rec.kind) {
    case "block":    return block(rec);
    case "cylinder": return cylinder(rec);
    case "tally":    return primitiveTally();
    case "speaker":  return speakerModel ? modelShape(speakerModel, C.speakerCm) : speaker();
    case "keys":     return keys();
    case "connector": return connectorModel ? connectorShape() : connector();
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

/* A WHOLE MODEL AS ONE OBJECT. Scaled to the height asked for, centred
   on its own middle (the model's origin is at its foot), and given the
   convex hull of everything in it as its collision shape. Used for the
   speaker; anything else exported the same way would work too. */
function modelShape(gltf, heightCm) {
  const src = gltf.scene.clone(true);
  src.updateMatrixWorld(true);
  const bb0 = new THREE.Box3().setFromObject(src);
  const size = bb0.getSize(new THREE.Vector3());
  const k = heightCm / (size.y || 1);          /* model units -> cm */

  const mesh = new THREE.Group();              /* the body's frame */
  const inner = new THREE.Group();
  inner.scale.setScalar(k);
  inner.add(src);
  mesh.add(inner);
  mesh.updateMatrixWorld(true);
  const centre = bb0.getCenter(new THREE.Vector3()).multiplyScalar(k);
  inner.position.set(-centre.x, -centre.y, -centre.z);
  mesh.updateMatrixWorld(true);

  const pts = hullPoints(src);
  const bb = new THREE.Box3().setFromArray(pts);
  const half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5).toArray();
  return {
    mesh, half, planar: false,
    collider: () => RAPIER.ColliderDesc.convexHull(new Float32Array(pts)) ||
                    RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]),
    dispose: () => {}            /* geometry and textures are shared */
  };
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
/* THE REAL CONNECTOR. Scaled by connectorCm off its glTF Y, like every
   other model here, and then asked for its two empties by name.

   The empties carry no geometry, so hullPoints() skips them and
   Box3.setFromObject() cannot see them: they change neither the
   collider nor the scale, wherever they sit. What they give us is a
   point and an orientation in the body's own frame, read once here
   and never looked up again. */
function connectorShape() {
  const shape = modelShape(connectorModel, C.connectorCm);
  shape.mesh.updateMatrixWorld(true);

  /* MODELLED THE WRONG WAY UP? The scale comes off Y alone, so a
     connector lying along X arrives with its DIAMETER set to
     connectorCm and comes out several times too big, with nothing on
     screen to say why. Cheaper to say so here. */
  const [hx, hy, hz] = shape.half;
  if (hy < hx || hy < hz) {
    console.warn("drift-3d: connector.glb is not longest along glTF Y " +
      "(" + (hx * 2).toFixed(1) + " x " + (hy * 2).toFixed(1) + " x " +
      (hz * 2).toFixed(1) + " cm). Model it standing up: Blender +Z is glTF +Y.");
  }

  /* TWO empties for the cable end. "cable" is where it leaves the
     shell; "cable_in" is a little deeper inside, and is where the rope
     actually ends. The line between them is the direction the first
     segment leaves along. Without cable_in the end pivots freely, which
     is the old behaviour, so it warns rather than failing. */
  shape.gripLocal = emptyAt(shape.mesh, "cable", new THREE.Vector3(0, -hy, 0));
  shape.gripInLocal = emptyAt(shape.mesh, "cable_in", null);
  if (!shape.gripInLocal) {
    console.warn('drift-3d: connector.glb has no "cable_in" empty, so the ' +
      "cable end will pivot freely. Add one a few mm inside the shell, " +
      'behind "cable", to fix which way the cable leaves.');
  }
  shape.plugLocal = emptyAt(shape.mesh, "plug", new THREE.Vector3(0, hy, 0));
  shape.plugQuat = emptyFacing(shape.mesh, "plug");

  /* WHICH END LEADS THE FALL, read from the model rather than assumed:
     the way from where the cable ends to where the plug mates. However
     the connector is modelled, that is the end that goes down. */
  shape.dropLead = shape.plugLocal.clone().sub(shape.gripInLocal || shape.gripLocal);
  shape.dropLead = shape.dropLead.lengthSq() > 1e-8
    ? shape.dropLead.normalize() : new THREE.Vector3(0, 1, 0);
  shape.dropTilt = 60;
  return shape;
}

/* An empty's position in the body's own frame. The mesh is unparented
   at this point, so its world space IS the body's local space. */
function emptyAt(mesh, name, fallback) {
  const node = mesh.getObjectByName(name);
  if (!node) {
    if (fallback) {
      console.warn('drift-3d: connector.glb has no "' + name + '" empty; ' +
        "falling back to the end of its bounding box");
    }
    return fallback;   /* null asks the caller to say its own piece */
  }
  return node.getWorldPosition(new THREE.Vector3());
}

function emptyFacing(mesh, name) {
  const node = mesh.getObjectByName(name);
  return node ? node.getWorldQuaternion(new THREE.Quaternion())
              : new THREE.Quaternion();
}

/* Stand-in XLR connector, until models/connector.glb exists: a barrel,
   a collar and a nose, built along Y so the long axis matches what
   modelShape() will measure (glTF Y) when the real model arrives.
   Swapping it in is then one line in shapeOf().

   The two empties the model will carry are hard-coded here as
   gripLocal (where the cable leaves, at the tail) and plugLocal (where
   it mates, at the nose). When the GLB lands they come from
   getObjectByName("cable") and getObjectByName("plug") instead, and
   nothing else in the cable code changes. */
function connector() {
  const [sx, sy, sz] = SPECIAL.connector.size;
  const group = new THREE.Group();
  const shell = material("#2b2b2e", { roughness: 0.35, metalness: 0.9 });
  const dark = material("#101012", { roughness: 0.6, metalness: 0.2 });

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(sx / 2, sx / 2, sy * 0.62, 16), shell);
  barrel.position.y = -sy * 0.15;
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(sx / 2 * 1.12, sx / 2 * 1.12, sy * 0.1, 16), shell);
  collar.position.y = sy * 0.2;
  const nose = new THREE.Mesh(
    new THREE.CylinderGeometry(sx / 2 * 0.86, sx / 2 * 0.86, sy * 0.28, 16), dark);
  nose.position.y = sy * 0.36;
  const tail = new THREE.Mesh(
    new THREE.CylinderGeometry(sx / 2 * 0.55, sx / 2 * 0.7, sy * 0.16, 12), dark);
  tail.position.y = -sy * 0.46;
  group.add(barrel, collar, nose, tail);

  return { mesh: group, half: [sx / 2, sy / 2, sz / 2], planar: false,
           collider: box, dispose: owned(group),
           gripLocal: new THREE.Vector3(0, -sy / 2, 0),          /* it leaves here */
           gripInLocal: new THREE.Vector3(0, -sy / 2 + 0.9, 0),  /* it ends here */
           plugLocal: new THREE.Vector3(0, sy / 2, 0),
           dropLead: new THREE.Vector3(0, 1, 0),                 /* plug first */
           dropTilt: 60 };
}

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
  const span = Math.max(0, W / 2 / PXCM - reach - 0.2);   /* x stays measured from the middle */
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
  /* drop.x is measured from the middle of the window, as the saved
     falls were recorded; the world's origin is the left wall. */
  const span = Math.max(0, W / 2 / PXCM - reach - 0.2);
  const x = (VX + W / 2) / PXCM + Math.max(-span, Math.min(span, drop.x || 0));
  /* The start height comes from the screen, so it does not change
     when the window is smaller than the screen: the floor is still the
     window's bottom edge, the fall is the same, only less of it is in
     view. */
  const floorY = (SH - (VY + H)) / PXCM;
  const y = floorY + (reduced() ? H / PXCM * 0.35 : SH / PXCM + reach) + reach;
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
  world.createCollider(hullCollider(bodyPts).setMass(C.tallyMass), body);

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

const sound = { ctx: null, gain: null, buffer: null, gestureAt: 0, status: "not started",
                played: 0, skipped: "" };

function loadSounds() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!C.sound) { sound.status = "switched off (C.sound is empty)"; return; }
  if (!AC) { sound.status = "this browser has no Web Audio"; return; }

  try { sound.ctx = new AC(); } catch (err) { sound.status = "could not create audio: " + err.message; return; }
  const url = new URL(C.sound, import.meta.url).href;
  sound.status = "loading " + url;
  sound.gain = sound.ctx.createGain();
  sound.gain.gain.value = C.soundVolume;
  sound.gain.connect(sound.ctx.destination);

  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error("file not found (" + r.status + ")");
      return r.arrayBuffer();
    })
    .then((data) => new Promise((ok, fail) =>
      sound.ctx.decodeAudioData(data, ok, (e) => fail(new Error("could not decode the file")))))
    .then((buffer) => {
      sound.buffer = buffer;
      sound.status = "ready, " + buffer.duration.toFixed(2) + " s";
    })
    .catch((err) => {
      sound.status = err.message + ": " + url;
      console.warn("drift-3d: sound " + sound.status);
    });

  /* Unlocked on each real interaction. Only there: calling this at
     load also stamped the load as a "gesture", so for the page's
     first second a blocked context was treated as just-clicked. */
  const unlock = () => {
    sound.gestureAt = performance.now();
    if (sound.ctx.state === "suspended") sound.ctx.resume().catch(() => {});
  };
  for (const type of ["pointerdown", "keydown", "touchend"]) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
}

function playSound() {
  if (!sound.buffer || !sound.ctx) { sound.skipped = "not loaded (" + sound.status + ")"; return; }
  /* Right after a click the context may still be resuming: start
     anyway, it plays the moment it is running. Any other time a
     suspended context means sound is blocked -- skip, rather than
     queue clicks that would all burst out at the first interaction. */
  const justClicked = performance.now() - (sound.gestureAt || -1e9) < 1000;
  if (sound.ctx.state !== "running" && !(sound.ctx.state === "suspended" && justClicked)) {
    sound.skipped = "blocked: audio " + sound.ctx.state + ", no click on this page yet";
    return;
  }
  if (sound.ctx.state === "suspended") sound.ctx.resume().catch(() => {});
  const src = sound.ctx.createBufferSource();
  src.buffer = sound.buffer;
  src.connect(sound.gain);
  src.start();
  sound.played += 1;
  sound.skipped = "";
}

/* -----------------------------------------------------------------
   THE SPEAKER
   ---------------------------------------------------------------
   Tap: play one of the sounds at random. Tap again: stop. While it
   plays, the model breathes and its light comes up with the sound's
   own loudness, read from the audio itself rather than from a timer,
   so the two always agree.

   The MODEL is scaled, never the body: the collision shape, the mass
   and everything resting on it are untouched.
   ----------------------------------------------------------------- */

const speaker3d = { id: null, src: null, analyser: null, gain: null, pan: null,
                    data: null, level: 0, buffers: new Map(), listing: null };

function toggleSpeaker(o) {
  if (speaker3d.id === o.id) { stopSpeaker(); return; }
  if (!sound.ctx) return;
  if (!C.speakerSounds.length) {
    /* Not listed yet: find them, then act on this same tap. */
    findSpeakerSounds().then((found) => { if (found.length) toggleSpeaker(o); });
    return;
  }

  sound.gestureAt = performance.now();          /* a tap is a gesture */
  if (sound.ctx.state === "suspended") sound.ctx.resume().catch(() => {});

  const url = C.speakerSounds[Math.floor(Math.random() * C.speakerSounds.length)];
  loadSpeakerSound(url).then((buffer) => {
    if (!buffer) return;
    stopSpeaker();
    const ctx = sound.ctx;
    speaker3d.gain = ctx.createGain();
    speaker3d.gain.gain.value = C.speakerVolume;
    speaker3d.analyser = ctx.createAnalyser();
    speaker3d.analyser.fftSize = 256;
    speaker3d.data = new Uint8Array(speaker3d.analyser.frequencyBinCount);
    speaker3d.src = ctx.createBufferSource();
    speaker3d.src.buffer = buffer;
    speaker3d.src.connect(speaker3d.analyser);
    /* THE SOUND COMES FROM WHERE IT IS: carry it to the left of the
       window and the sound goes left with it. */
    speaker3d.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (speaker3d.pan) {
      speaker3d.analyser.connect(speaker3d.pan);
      speaker3d.pan.connect(speaker3d.gain);
    } else {
      speaker3d.analyser.connect(speaker3d.gain);
    }
    speaker3d.gain.connect(ctx.destination);
    speaker3d.src.onended = () => { if (speaker3d.src) stopSpeaker(); };
    speaker3d.src.start();
    speaker3d.id = o.id;
    if (document.querySelector("[data-drift-debug]")) {
      console.log("drift-3d: speaker playing " + url + " (" +
                  buffer.duration.toFixed(1) + " s)");
    }
    wake();                                     /* it has something to show */
  });
}

function stopSpeaker() {
  if (speaker3d.src && document.querySelector("[data-drift-debug]")) {
    console.log("drift-3d: speaker stopped");
  }
  if (speaker3d.src) {
    try { speaker3d.src.onended = null; speaker3d.src.stop(); } catch (err) {}
  }
  speaker3d.src = null;
  speaker3d.analyser = null;
  speaker3d.pan = null;
  speaker3d.id = null;
  speaker3d.level = 0;
  showSpeaker(0);        /* with id cleared above, this puts the light out */
}

/* The list, once per page: the build's sounds.json, or numbered files
   until one is missing. */
function findSpeakerSounds() {
  if (speaker3d.listing) return speaker3d.listing;
  speaker3d.listing = fetch(new URL(C.speakerList, import.meta.url))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no list"))))
    .then((list) => (Array.isArray(list) ? list : list.speaker || []))
    .then((list) => list.map((name) =>
      (name.indexOf("/") === -1 ? "sounds/" + name : name)))
    .catch(() => probeSpeakerSounds())
    .then((list) => {
      C.speakerSounds = list;
      if (!list.length) console.warn("drift-3d: no speaker sounds found in sounds/");
      return list;
    });
  return speaker3d.listing;
}

function probeSpeakerSounds() {
  const found = [];
  const step = (n) => {
    if (n > C.speakerProbe) return found;
    const url = "sounds/speaker-" + n + ".mp3";
    return fetch(new URL(url, import.meta.url), { method: "HEAD" })
      .then((r) => {
        if (!r.ok) return found;
        found.push(url);
        return step(n + 1);
      })
      .catch(() => found);
  };
  return Promise.resolve(step(1));
}

function loadSpeakerSound(url) {
  if (speaker3d.buffers.has(url)) return Promise.resolve(speaker3d.buffers.get(url));
  return fetch(new URL(url, import.meta.url))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("not found"))))
    .then((data) => new Promise((ok, fail) => sound.ctx.decodeAudioData(data, ok, fail)))
    .then((buffer) => { speaker3d.buffers.set(url, buffer); return buffer; })
    .catch((err) => {
      console.warn("drift-3d: speaker sound " + url + " -- " + err.message);
      speaker3d.buffers.set(url, null);
      return null;
    });
}

/* How loud it is right now, 0 to 1, smoothed so the model breathes
   rather than flickers. */
function speakerLevel() {
  if (!speaker3d.analyser) return 0;
  speaker3d.analyser.getByteTimeDomainData(speaker3d.data);
  let peak = 0;
  for (let i = 0; i < speaker3d.data.length; i++) {
    peak = Math.max(peak, Math.abs(speaker3d.data[i] - 128) / 128);
  }
  const target = Math.min(1, peak * 1.6);
  /* Fast up, fast down: a light that fades away slowly reads as a
     dimmer being turned, not as a speaker. */
  speaker3d.level += (target - speaker3d.level) * (target > speaker3d.level ? 0.7 : 0.35);
  return speaker3d.level;
}

/* Applied to the drawn model only. */
function showSpeaker(level) {
  const o = objects.get(speaker3d.id) ||
            [...objects.values()].find((x) => x.kind === "speaker");
  if (!o) return;

  /* Where it is across the window, -1 to 1, into the panner. */
  if (speaker3d.pan && speaker3d.id) {
    const p = o.parts[0].body.translation();
    const across = ((p.x * PXCM - VX) / Math.max(1, W)) * 2 - 1;
    const target = Math.max(-1, Math.min(1, across)) * C.speakerPan;
    const now = speaker3d.pan.pan;
    now.value += (target - now.value) * 0.2;      /* no clicks on a throw */
  }

  /* The model still breathes with the sound; the light does not. */
  o.parts[0].mesh.scale.setScalar(1 + C.speakerPulse * level);
  setSpeakerGlow(o, speaker3d.id ? 1 : 0);
}

function setSpeakerGlow(o, lit) {
  const glow = C.speakerGlowOff + (C.speakerGlowOn - C.speakerGlowOff) * lit;
  o.parts[0].mesh.traverse((n) => {
    if (!n.isMesh) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) {
      if (m && m.emissive !== undefined) m.emissiveIntensity = glow;
    }
  });
}

/* -----------------------------------------------------------------
   THE CABLE
   ---------------------------------------------------------------
   A Verlet rope, stepped by hand, outside Rapier entirely. See the
   cable block in C for why it is not a jointed chain.

   WHAT IT IS. A line of nodes in centimetres, in root's space, each
   holding its current and previous position. Gravity moves them, a
   few passes of a distance constraint pull them back to the segment
   length, and the two ends are pinned: node 0 to the anchor on the
   left wall, the last node to the connector's tail.

   WHAT TOUCHES WHAT. The rope is pushed out of the floor, the walls
   and every object, and pushes none of them back. The single force
   that goes the other way is the leash: past its length the cable
   pulls on the CONNECTOR, one body, and only while that body is
   awake, so a rope stretched taut around a sleeping object can never
   hold the loop open.

   WHAT IS SAVED. Nothing but the length, on the record. The rope is
   derived from two endpoints, so the next page rebuilds it from the
   connector's restored pose and drapes it with cableSettle steps
   before the first paint. Twenty saved poses would have been twenty
   chances to disagree with the photograph taken as the last page
   left.
   ----------------------------------------------------------------- */

let cable = null;

/* SCRATCH, AND WHO OWNS WHAT. _cA and _cG hold the two pinned ends for
   a whole step and are touched by nothing else: sharing them with the
   push-out was a bug once, and a silent one, because the anchor only
   moved on the steps where the rope happened to be inside something. */
const DOWN = new THREE.Vector3(0, -1, 0);

const _cA = new THREE.Vector3();     /* the anchor, for one step */
const _cA1 = new THREE.Vector3();    /* ... and the node one segment in */
const _cG = new THREE.Vector3();     /* the connector's tip, for one step */
const _cG1 = new THREE.Vector3();    /* ... and the node one segment out */
const _cC = new THREE.Vector3();     /* clampCable's own copy of the anchor */
const _cv = new THREE.Vector3();     /* push-out: the node, box-local */
const _cw = new THREE.Vector3();     /* push-out: a candidate way out */
const _cq = new THREE.Quaternion();
const _cqi = new THREE.Quaternion();
const _cgq = new THREE.Quaternion(); /* gripPoint only */
const _ct = new THREE.Vector3();     /* drawCable only */
const _cn = new THREE.Vector3();
const _cb = new THREE.Vector3();

function startCable(made, rec) {
  stopCable();

  /* Fixed in cm at spawn, stored on the record: a resize then changes
     the slack, not the cable. A visitor who narrows the window gets a
     cable that drapes more, not a shorter one. */
  if (!(rec.len > 0)) {
    const across = W / PXCM, down = H / PXCM;
    const corner = Math.sqrt(across * across + down * down);
    rec.len = Math.max(C.cableMinCm, Math.min(C.cableMaxCm, C.cableShare * corner));
  }

  /* HOW MANY NODES: whatever it takes to keep segments at cableSegCm.
     The count follows the length so the rope's behaviour does not, which
     is the whole point -- one dial changes how much cable there is, and
     nothing else about it. */
  const want = Math.round(rec.len / Math.max(0.2, C.cableSegCm)) + 1;
  const n = Math.max(6, C.cableNodes | 0,
                     Math.min(C.cableNodesMax | 0, want));
  const shape = made.shape || {};

  /* The TIP is the deeper point, inside the shell, so the open end of
     the tube is hidden by the model instead of showing as a hole at
     the join. gripDir is the way out of it, as a unit vector in the
     body's own frame; without a second point there is no direction to
     be had and the old single pin is used instead. */
  const tip = (shape.gripInLocal || shape.gripLocal ||
               new THREE.Vector3(0, -made.half[1], 0)).clone();
  let dir = null, exit = 0;
  if (shape.gripInLocal && shape.gripLocal) {
    dir = shape.gripLocal.clone().sub(shape.gripInLocal);
    /* THE GAP BETWEEN THE TWO EMPTIES IS THE EXIT LENGTH, and it was
       being thrown away: only the direction was read, and exactly one
       segment was held to it. A segment is not a fixed distance -- it
       shrinks as the cable gets thinner, because the node count is
       derived from the thickness -- so on a thin cable that one held
       segment stopped short of leaving the shell, the first free node
       was still inside the model, and the cable swung out through the
       SIDE of the connector instead of its end. Modelling it is the
       author's business: the cable leaves straight for as far as the
       two empties are apart, however many nodes that takes. */
    exit = dir.length();
    dir = exit > 1e-4 ? dir.divideScalar(exit) : null;
  }

  const cb = {
    id: rec.id,
    part: made.parts[0],
    grip: tip,
    gripDir: dir,
    n: n,
    len: rec.len,
    seg: rec.len / (n - 1),
    nodes: new Float32Array(n * 3),
    prev: new Float32Array(n * 3),
    still: false,
    move: 1,
    lift: 0,                        /* how far the anchor is still above home */
    rest: new Float32Array(n),      /* the span each triple remembers */
    last: new Float32Array(n * 3),  /* where it was when this step began */
    mark: new Float32Array(n * 3),  /* ... and where it was a while ago */
    markAge: 0,
    touch: new Uint8Array(n),       /* what met something this step */
    restInit: false,
    free: new Uint8Array(n).fill(1)
  };
  /* Enough nodes to cover that exit, and never so many that the rope
     has nothing left to hang with. */
  cb.pins = dir ? Math.max(2, Math.min(Math.floor(n / 3),
                  Math.round(exit / cb.seg) + 1)) : 1;
  cb.exit = exit;
  cb.free[0] = cb.free[1] = 0;
  for (let i = 0; i < cb.pins; i++) cb.free[n - 1 - i] = 0;

  const A = cableAnchor(_cA);
  const G = _cG;
  tipPoints(cb, G, _cG1);

  /* WHERE IT WAS, if the last page left a note. Shifted by however far
     the anchor has moved, since that follows the window and the window
     may not be where it was. Arriving in the shape it left in is the
     whole point: anything else shows as a jump at the handover. */
  const saved = rec.cable;
  const fits = saved && Array.isArray(saved.p) && saved.p.length === n * 3;
  if (fits) {
    const ox = A.x - saved.a[0], oy = A.y - saved.a[1], oz = A.z - saved.a[2];
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      cb.nodes[j] = saved.p[j] + ox;
      cb.nodes[j + 1] = saved.p[j + 1] + oy;
      cb.nodes[j + 2] = saved.p[j + 2] + oz;
    }
  } else {
    /* A NEW CABLE SPAWNS STRAIGHT, laid back from the connector along
       the way in, with the anchor lifted its whole length so all of it
       is out of sight above the window. See cableDropSec. */
    cb.lift = C.cableDropSec > 0 ? rec.len : 0;
    const E = cableEntry(_cG1);
    const gap = cb.lift ? cb.seg : C.cableOutCm / n;
    for (let i = 0; i < n; i++) {
      const j = (n - 1 - i) * 3, d = i * gap;
      cb.nodes[j] = G.x - E.x * d;
      cb.nodes[j + 1] = G.y - E.y * d;
      cb.nodes[j + 2] = G.z - E.z * d;
    }
  }
  cb.prev.set(cb.nodes);

  /* JUST THE PINNED EXIT, PLUS ONE. It was briefly the whole length of
     the connector, on the theory that excusing extra nodes is free. It
     is not: an excused node can sit inside the model while the node
     next to it is being shoved out, and those two fight at over a
     centimetre a step and never stop -- the same deadlock, moved. Now
     that the exit is pinned the rope leaves the body cleanly on its
     own, so the exemption only has to cover the part that is meant to
     be inside. */
  cb.tipFree = Math.min(n - 4, Math.max(C.cableTipFree | 0, cb.pins + 1));

  buildCableMesh(cb);
  cable = cb;
  /* A restored rope takes a few steps to take up the slack the rounding
     lost. A NEW one takes none at all: settling it first is exactly what
     put it on screen before it had fallen. */
  const steps = fits ? 4 : 0;
  for (let i = 0; i < steps; i++) stepCable(C.step, true);
  drawCable();
}

function stopCable() {
  if (!cable) return;
  root.remove(cable.mesh);
  cable.mesh.geometry.dispose();   /* the material is shared: see cableMaterial */
  cable = null;
}

/* WHERE THE CABLE COMES IN, and which way it points as it does.
   Derived every step rather than stored, so it follows the window the
   way the walls do, and it sits OUTSIDE the edge it crosses: the
   renderer scissors to the window, so that stretch is clipped and the
   cable reads as arriving from somewhere the visitor cannot see. */
function cableAnchor(out) {
  const floorY = (SH - (VY + H)) / PXCM;
  /* Lifted while a new cable is arriving: see cableDropSec. */
  const up = cable ? cable.lift : 0;
  if (C.cableFrom === "side") {
    return out.set((VX + W) / PXCM + C.cableOutCm + up, floorY + C.cableRadiusCm, 0);
  }
  return out.set((VX + W * C.cableFromShare) / PXCM,
                 (SH - VY) / PXCM + C.cableOutCm + up, 0);
}

/* The way it enters: square to whichever edge it crosses, which is what
   makes it read as passing through a wall rather than being tied to a
   point on one. The second pinned node sits one segment along this. */
function cableEntry(out) {
  return C.cableFrom === "side" ? out.set(-1, 0, 0) : out.set(0, -1, 0);
}

/* WHERE THE CABLE MEETS THE CONNECTOR, as TWO points rather than one.

   Pinning a single node leaves the last segment free to pivot around
   it, so the cable waves about its own attachment and reads as
   resting against the connector rather than plugged into it. There is
   no orientation constraint to reach for: in a position solver the
   only way to fix which way a segment points is to fix where its
   other end is. So two nodes are pinned, and the segment between them
   is carried rigidly by the body.

   The two empties give a DIRECTION, not a distance. Segment length is
   len / (nodes - 1), computed from the window at spawn, so it is not
   a number anyone could author in Blender: empties 1.2 cm apart would
   leave the length constraint fighting the pins on every pass, which
   is exactly the sort of quarrel that stops a rope settling and keeps
   the page awake. The inner point is taken as given and the outer one
   is placed one segment along the line between them. */
function tipPoints(cb, tip, dir) {
  const p = cb.part.body.translation(), q = cb.part.body.rotation();
  _cgq.set(q.x, q.y, q.z, q.w);
  tip.copy(cb.grip).applyQuaternion(_cgq);
  tip.set(p.x + tip.x, p.y + tip.y, p.z + tip.z);
  if (!cb.gripDir) return false;
  dir.copy(cb.gripDir).applyQuaternion(_cgq);
  return true;
}

function stepCable(dt, quiet) {
  const cb = cable;
  if (!cb || !cb.part) return;

  const n = cb.n, nodes = cb.nodes, prev = cb.prev, free = cb.free;
  const g = -(C.gravityPx / PXCM) * dt * dt;
  const keep = 1 - C.cableDamp;
  cb.last.set(nodes);

  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const vx = (nodes[j] - prev[j]) * keep;
    const vy = (nodes[j + 1] - prev[j + 1]) * keep;
    const vz = (nodes[j + 2] - prev[j + 2]) * keep;
    prev[j] = nodes[j]; prev[j + 1] = nodes[j + 1]; prev[j + 2] = nodes[j + 2];
    nodes[j] += vx;
    nodes[j + 1] += vy + g;
    nodes[j + 2] += vz;
  }

  if (cb.lift > 0) {
    const y = cb.part.body.translation().y;
    const fell = cb.fellFrom === undefined ? 0 : Math.max(0, cb.fellFrom - y);
    cb.fellFrom = y;
    cb.lift -= Math.max(fell, (cb.len / C.cableDropSec) * dt);
    if (cb.lift < 0) cb.lift = 0;
  }

  const A = cableAnchor(_cA);
  const A1 = cableEntry(_cA1);                  /* square to the edge it crosses */
  A1.set(A.x + A1.x * cb.seg, A.y + A1.y * cb.seg, A.z + A1.z * cb.seg);
  const G = _cG, D = _cG1;
  const twoEnded = tipPoints(cb, G, D);

  /* ORDER MATTERS, AND COST 14% OF THE CABLE'S LENGTH TO GET WRONG.
     Self-collision pushes nodes apart; the length constraint pulls them
     together. Whichever runs last wins, and with collision last a SLACK
     rope sat 14% longer than it should have -- more passes did not help,
     because the two were simply taking turns. Collision first, length
     last: the rope keeps its length and a crossing is resolved on the
     next pass instead of this one, which nobody can see. */
  for (let pass = 0; pass < C.cablePasses; pass++) {
    pinEnds(cb, A, A1, G, D, twoEnded);
    if (C.cableSelfGive > 0) selfCollide(cb);
    for (let i = 0; i < n - 1; i++) {
      /* PINNED NODES ARE NOT MOVED, the way bend and self-collision
         already had it. This pass used to shove them like any others
         and leave pinEnds to put them back next time round -- so every
         pass corrected the first free node against a pinned position
         that was, at that moment, wrong. Where one end is pinned the
         whole correction goes to the other; where both are, there is
         nothing to correct and the segment is whatever the model says
         it is. */
      const fa = free[i], fb = free[i + 1];
      if (!fa && !fb) continue;
      const a = i * 3, b = a + 3;
      let dx = nodes[b] - nodes[a];
      let dy = nodes[b + 1] - nodes[a + 1];
      let dz = nodes[b + 2] - nodes[a + 2];
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      const f = ((L - cb.seg) / L) * 0.5;
      const sa = fa ? (fb ? 1 : 2) : 0, sb = fb ? (fa ? 1 : 2) : 0;
      dx *= f; dy *= f; dz *= f;
      nodes[a] += dx * sa; nodes[a + 1] += dy * sa; nodes[a + 2] += dz * sa;
      nodes[b] -= dx * sb; nodes[b + 1] -= dy * sb; nodes[b + 2] -= dz * sb;
    }
    if (C.cableBendDeg < 180) bendCable(cb);
    /* INSIDE THE PASSES, not once at the end. Run last and alone, the
       push-out got the final word and the length constraint spent the
       next step dragging the node back in -- fine for a rope lying on
       something, a limit cycle for one threaded THROUGH it, with
       neighbours on both sides pulling the other way. In here the two
       negotiate, and what comes out satisfies both approximately
       instead of each in turn. */
    pushCableOut();
    /* AND THE WALLS WITH IT. The floor clamp has to sit beside the
       push-out, not after the whole loop: left until last it shoved
       nodes back into the very box they had just been cleared of, which
       is the same mistake as letting the floor beat the push-out
       inside a single call. */
    clampCable();
  }


  /* The ends are pinned LAST: a rope whose end has drifted off the
     connector it is attached to looks broken, and no amount of
     correct physics behind it would read as anything else. */
  pinEnds(cb, A, A1, G, D, twoEnded);
  rubCable(cb);
  /* AND RESOLVE ONCE MORE. Static friction refuses displacement, and it
     cannot be allowed to refuse the one displacement that matters: it
     was dragging nodes back INTO the boxes the push-out had just
     cleared them from. Grip may slow a cable down; it may not put it
     back inside a speaker. */
  pushCableOut();
  clampCable();
  rememberShape(cb);

  if (!quiet) leash(cb, A, G);

  /* AGAINST WHERE IT BEGAN THE STEP, not against prev. prev is not a
     record of the past by the time we get here: friction drags it
     toward the present, and the collision pass after it moves the nodes
     again, so their difference stays wide open on a rope that is in
     fact completely motionless. That reported a still cable as moving,
     forever, and the loop never stopped -- a stillness test that cannot
     see stillness is worse than none. */
  const last = cb.last;
  let move = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const dx = nodes[j] - last[j];
    const dy = nodes[j + 1] - last[j + 1];
    const dz = nodes[j + 2] - last[j + 2];
    const m = dx * dx + dy * dy + dz * dz;
    if (m > move) move = m;
  }
  cb.move = Math.sqrt(move);
  cb.still = cb.move < C.cableStillCm;

  /* THE SECOND OPINION. See cableCalmSteps. */
  if (!cb.still && ++cb.markAge >= C.cableCalmSteps) {
    let drift = 0;
    for (let i = 0; i < n * 3; i += 3) {
      const dx = nodes[i] - cb.mark[i];
      const dy = nodes[i + 1] - cb.mark[i + 1];
      const dz = nodes[i + 2] - cb.mark[i + 2];
      const m = dx * dx + dy * dy + dz * dz;
      if (m > drift) drift = m;
    }
    if (Math.sqrt(drift) < C.cableCalmCm) cb.still = true;
    cb.mark.set(nodes);
    cb.markAge = 0;
  } else if (cb.still) {
    cb.mark.set(nodes);
    cb.markAge = 0;
  }

  /* Asleep means asleep: the residual velocity is thrown away rather
     than left to trickle through the damping for another few hundred
     frames of a loop that has nothing else to do. */
  if (cb.still) prev.set(nodes);
}

/* BEND RESISTANCE, as a minimum span across every three nodes rather
   than an angle. Two nodes either side of a third, with segments of
   equal length, sit 2*seg*cos(angle/2) apart; hold them no closer than
   that and the middle node cannot fold past the angle. It is one more
   distance constraint, which is the only shape this solver knows, so it
   costs a square root per node and nothing else.

   PINNED NODES ARE NOT MOVED. The worst corner in the rope sits at the
   node pinned to the connector, and the only way to soften it is to
   move its free neighbour further out; pushing the pin itself would
   just unpin the cable from the model. Where one side is pinned the
   whole correction goes to the other. */
function bendCable(cb) {
  const n = cb.n, nodes = cb.nodes, free = cb.free;
  /* THE SEGMENTS IT ACTUALLY HAS, not the ones it is supposed to have.
     Taking the span from the nominal length looked right and did
     nothing: a cable held past its length is stretched, its segments
     run nearly twice their nominal, and every triple was already wider
     apart than a threshold built for the unstretched rope. Law of
     cosines on the two real segments instead. */
  const cosBend = Math.cos(C.cableBendDeg * Math.PI / 180);
  for (let i = 1; i < n - 1; i++) {
    const b = i * 3, a = b - 3, c = b + 3;
    const fa = free[i - 1], fc = free[i + 1];
    if (!fa && !fc) continue;
    const u = Math.sqrt((nodes[b] - nodes[a]) * (nodes[b] - nodes[a]) +
      (nodes[b + 1] - nodes[a + 1]) * (nodes[b + 1] - nodes[a + 1]) +
      (nodes[b + 2] - nodes[a + 2]) * (nodes[b + 2] - nodes[a + 2]));
    const v = Math.sqrt((nodes[c] - nodes[b]) * (nodes[c] - nodes[b]) +
      (nodes[c + 1] - nodes[b + 1]) * (nodes[c + 1] - nodes[b + 1]) +
      (nodes[c + 2] - nodes[b + 2]) * (nodes[c + 2] - nodes[b + 2]));
    const minSpan = Math.sqrt(Math.max(0, u * u + v * v + 2 * u * v * cosBend));
    let dx = nodes[c] - nodes[a], dy = nodes[c + 1] - nodes[a + 1],
        dz = nodes[c + 2] - nodes[a + 2];
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (L < 1e-6) continue;

    /* HOLD THE REMEMBERED SHAPE, BUT ONLY WHERE IT IS SLACK. Two-sided
       where it applies, unlike the limit below: it resists opening out
       as much as closing up, which is the whole difference between
       cable and liquid. Under tension it does not apply at all, and the
       span hangs as straight as its weight makes it. */
    const taut = u > cb.seg * (1 + C.cableTaut) || v > cb.seg * (1 + C.cableTaut);
    let target = L;
    /* NOT WHILE IT IS STILL ARRIVING. A cable being paid out has no
       shape worth remembering, and holding it to one during the drop
       was by far the most expensive thing this file does: the worst
       frame after a spawn ran to six milliseconds against fifty
       microseconds settled, because the memory drove the rope into
       configurations that were then costly for every other constraint
       in turn. Off until the anchor is home. */
    if (cb.restInit && C.cableStiff > 0 && !taut && cb.lift <= 0) target = cb.rest[i];
    if (target < minSpan) target = minSpan;     /* never tighter than the bend */
    if (L >= minSpan && Math.abs(L - target) < 1e-6) continue;
    const span = L >= minSpan ? target : minSpan;
    const give = L >= minSpan ? C.cableStiff : C.cableBendGive;
    const f = ((span - L) / L) * 0.5 * give;
    const sa = fa ? (fc ? 1 : 2) : 0, sc = fc ? (fa ? 1 : 2) : 0;
    dx *= f; dy *= f; dz *= f;
    nodes[a] -= dx * sa; nodes[a + 1] -= dy * sa; nodes[a + 2] -= dz * sa;
    nodes[c] += dx * sc; nodes[c + 1] += dy * sc; nodes[c + 2] += dz * sc;
  }
}

/* THE ROPE AGAINST ITSELF. Every pair of nodes far enough apart along
   the cable to be allowed to meet, held at least a diameter apart.

   WHAT THIS CANNOT DO is stop one SEGMENT crossing another: the test is
   between points, so a fast enough flick can carry the cable through
   itself between two steps with no two nodes ever close. Segment
   against segment, with continuous detection, is the real answer and is
   far more than this is worth. Overlapping beads make it rare, which is
   the whole reason the node count is derived from the thickness.

   Pinned nodes are not moved, so a crossing against the four held ends
   is resolved entirely by the free side. */
function selfCollide(cb) {
  const n = cb.n, nodes = cb.nodes, free = cb.free;
  const d = 2 * C.cableRadiusCm, dd = d * d;
  const skip = (C.cableSelfSkip | 0) + 1;
  for (let i = 0; i < n - skip; i++) {
    const a = i * 3, fa = free[i];
    for (let j = i + skip; j < n; j++) {
      const fb = free[j];
      if (!fa && !fb) continue;
      const b = j * 3;
      let dx = nodes[b] - nodes[a], dy = nodes[b + 1] - nodes[a + 1],
          dz = nodes[b + 2] - nodes[a + 2];
      const L2 = dx * dx + dy * dy + dz * dz;
      if (L2 >= dd || L2 < 1e-12) continue;
      const L = Math.sqrt(L2);
      const f = ((d - L) / L) * 0.5 * C.cableSelfGive;
      const sa = fa ? (fb ? 1 : 2) : 0, sb = fb ? (fa ? 1 : 2) : 0;
      dx *= f; dy *= f; dz *= f;
      nodes[a] -= dx * sa; nodes[a + 1] -= dy * sa; nodes[a + 2] -= dz * sa;
      nodes[b] += dx * sb; nodes[b + 1] += dy * sb; nodes[b + 2] += dz * sb;
    }
  }
}

/* Node 1 and node n-2 are pinned as well as the ends themselves, which
   is what stops either end pivoting: see tipPoints. The wall end comes
   straight in along -x, the way a cable leaves a panel. */
function pinEnds(cb, A, A1, G, D, twoEnded) {
  const nodes = cb.nodes, n = cb.n, seg = cb.seg;
  nodes[0] = A.x; nodes[1] = A.y; nodes[2] = A.z;
  nodes[3] = A1.x; nodes[4] = A1.y; nodes[5] = A1.z;
  const pins = twoEnded ? cb.pins : 1;
  for (let i = 0; i < pins; i++) {
    /* NO FURTHER OUT THAN THE MODEL ASKED FOR. Spaced a segment apart,
       a coarse rope put the second pin 3 cm along the connector's axis
       where the empties wanted 0.9 -- a rigid stick at the junction,
       swinging on every turn of the body. The pinned stretch covers the
       exit and stops; the length constraint leaves it alone because
       both its ends are pinned. */
    const j = (n - 1 - i) * 3, d = Math.min(i * seg, cb.exit);
    nodes[j] = G.x + D.x * d;
    nodes[j + 1] = G.y + D.y * d;
    nodes[j + 2] = G.z + D.z * d;
  }
}

/* FRICTION, ONCE A STEP, for whatever touched something during it.

   A node's velocity here is only where it was last step, so dragging
   prev toward it takes that share of the speed away. The subtlety is
   the once: charging it inside every constraint pass, which is where it
   started, removes so much speed that the rope can never reach
   equilibrium at all -- it creeps under gravity instead, a hair each
   step, forever, and the page never sleeps. Contact is collected during
   the passes and paid for here. */
function rubCable(cb) {
  const mu = C.cableFriction, grip = C.cableGripCm;
  const n = cb.n, nodes = cb.nodes, prev = cb.prev, free = cb.free, touch = cb.touch;
  for (let i = 0; i < n; i++) {
    if (!touch[i]) continue;
    touch[i] = 0;
    if (!free[i]) continue;
    const j = i * 3;

    /* STATIC FIRST: put the node back toward where it began the step,
       by up to grip. Everything that moves this rope moves it by
       writing positions -- gravity through the integrator, the length
       constraint, the memory, the leash pulling from the far end -- so
       the only thing that can resist being dragged is refusing the
       displacement itself. Under the budget the node simply does not
       move. */
    if (grip > 0) {
      const dx = nodes[j] - prev[j], dy = nodes[j + 1] - prev[j + 1],
            dz = nodes[j + 2] - prev[j + 2];
      const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L > 1e-9) {
        const back = L < grip ? 1 : grip / L;
        nodes[j] -= dx * back;
        nodes[j + 1] -= dy * back;
        nodes[j + 2] -= dz * back;
      }
    }

    /* THEN THE SPEED, on whatever movement survived. */
    if (mu > 0) {
      prev[j] += (nodes[j] - prev[j]) * mu;
      prev[j + 1] += (nodes[j + 1] - prev[j + 1]) * mu;
      prev[j + 2] += (nodes[j + 2] - prev[j + 2]) * mu;
    }
  }
}

/* WHAT IT REMEMBERS, drifting toward where it actually is. On the first
   step it simply takes the shape it arrived in, so a restored page does
   not spend its first second springing out of a shape nobody chose. */
function rememberShape(cb) {
  const n = cb.n, nodes = cb.nodes, rest = cb.rest;
  /* Nothing is remembered until the cable has finished arriving, and
     then what it takes is the shape it arrived in. */
  const first = !cb.restInit || cb.lift > 0;
  const yieldAt = C.cableYieldCm;
  for (let i = 1; i < n - 1; i++) {
    const a = (i - 1) * 3, c = (i + 1) * 3;
    const dx = nodes[c] - nodes[a], dy = nodes[c + 1] - nodes[a + 1],
          dz = nodes[c + 2] - nodes[a + 2];
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (first) { rest[i] = L; continue; }
    /* YIELD. The first version let what it remembers drift toward where
       it is at a fixed rate, which is not memory at all: it converges on
       the present and the force decays to nothing, so the cable held no
       shape whatever. Real plastic deformation has a threshold. Inside
       it the cable is a spring and returns; past it the shape is
       permanently given up, and only by the excess. */
    const err = L - rest[i];
    if (err > yieldAt) rest[i] += (err - yieldAt) * C.cableMemory;
    else if (err < -yieldAt) rest[i] += (err + yieldAt) * C.cableMemory;
  }
  cb.restInit = true;
}

/* ONE WAY. Each node is pushed out along the shallowest axis of any
   box it is inside; the box never hears about it. Objects are boxes
   here even when their collider is a hull, which for a cable lying
   over them is close enough and costs one quaternion each. */
function pushCableOut() {
  const cb = cable, nodes = cb.nodes, free = cb.free, n = cb.n, r = C.cableRadiusCm;
  const floorMin = (SH - (VY + H)) / PXCM + r;

  for (const o of objects.values()) {
    /* ITS OWN CONNECTOR IS NOT SKIPPED, only the nodes at the tip. */
    const own = o.id === cb.id;
    const last = own ? Math.max(0, n - cb.tipFree) : n;
    if (last <= 0) continue;
    const h0 = o.half[0] + r, h1 = o.half[1] + r, h2 = o.half[2] + r;
    const far = Math.sqrt(h0 * h0 + h1 * h1 + h2 * h2);
    for (const part of o.parts) {
      const p = part.body.translation(), q = part.body.rotation();
      _cq.set(q.x, q.y, q.z, q.w);
      _cqi.copy(_cq).invert();
      for (let i = 0; i < last; i++) {
        /* PINNED NODES ARE NOT PUSHED. They are placed by the connector,
           not by the rope, and this runs AFTER the last pinEnds -- so
           anything moved here stays moved. With the connector resting on
           another object its pinned tip sits inside that object's box,
           was shoved out of it, and the cable was left hanging off the
           end of its own connector until the connector moved away. */
        if (!free[i]) continue;
        const j = i * 3;
        const ox = nodes[j] - p.x, oy = nodes[j + 1] - p.y, oz = nodes[j + 2] - p.z;
        if (Math.abs(ox) > far || Math.abs(oy) > far || Math.abs(oz) > far) continue;
        _cv.set(ox, oy, oz).applyQuaternion(_cqi);
        const ax0 = Math.abs(_cv.x), ax1 = Math.abs(_cv.y), ax2 = Math.abs(_cv.z);
        if (ax0 >= h0 || ax1 >= h1 || ax2 >= h2) continue;

        /* THREE WAYS OUT, AND THE FLOOR HAS A VETO. The shallowest is
           usually right, but for a block resting on the floor it is
           often straight down, and then the floor clamp puts the node
           back inside on the same step -- which is how a cable ends up
           sawing through a box forever. Take the shallowest way out
           that leaves the node above the floor; if every way out is
           below it, take whichever comes out highest. */
        let bestAxis = -1, bestDepth = Infinity, topAxis = 0, topY = -Infinity;
        for (let a = 0; a < 3; a++) {
          const cur = a === 0 ? _cv.x : a === 1 ? _cv.y : _cv.z;
          const h = a === 0 ? h0 : a === 1 ? h1 : h2;
          const depth = h - Math.abs(cur);
          const snap = cur < 0 ? -h : h;
          _cw.copy(_cv);
          if (a === 0) _cw.x = snap; else if (a === 1) _cw.y = snap; else _cw.z = snap;
          _cw.applyQuaternion(_cq);
          const wy = p.y + _cw.y;
          if (wy > topY) { topY = wy; topAxis = a; }
          if (wy >= floorMin && depth < bestDepth) { bestDepth = depth; bestAxis = a; }
        }

        const a = bestAxis >= 0 ? bestAxis : topAxis;
        const cur = a === 0 ? _cv.x : a === 1 ? _cv.y : _cv.z;
        const h = a === 0 ? h0 : a === 1 ? h1 : h2;
        const snap = cur < 0 ? -h : h;
        if (a === 0) _cv.x = snap; else if (a === 1) _cv.y = snap; else _cv.z = snap;
        _cv.applyQuaternion(_cq);
        nodes[j] = p.x + _cv.x;
        nodes[j + 1] = p.y + _cv.y;
        nodes[j + 2] = p.z + _cv.z;
        cb.touch[i] = 1;
      }
    }
  }
}

function clampCable() {
  const cb = cable, nodes = cb.nodes, r = C.cableRadiusCm;
  const floorY = (SH - (VY + H)) / PXCM + r;
  /* WHATEVER SIDE THE ANCHOR IS ON, the cable has to be able to reach
     it: the last stretch is meant to lie outside the window, where the
     scissor hides it, so the bound is taken from the anchor rather than
     assumed to be the right wall. There is no ceiling at all -- a cable
     hanging in from above needs the room over the window. */
  const An = cableAnchor(_cC);
  const left = Math.min(VX / PXCM + r, An.x);
  const right = Math.max((VX + W) / PXCM - r, An.x);
  const back = -C.depthCm + r, front = C.frontCm - r;
  /* NOTHING GRIPS ABOVE THE WINDOW. The room's walls run far higher than
     the window does, so slack paid out from an anchor overhead pressed
     against one out of sight, friction took hold, and the cable hung
     there: caught on something the visitor cannot see, with a third of
     it stranded above the top edge. The walls still stop it wandering --
     removed altogether, the slack swings like a pendulum with nothing
     to damp it and the rope never settles at all -- but above the edge
     they are frictionless, so the cable slides down them instead of
     sticking to them. */
  const ceiling = (SH - VY) / PXCM;

  for (let i = 0; i < cb.n; i++) {
    if (!cb.free[i]) continue;      /* the model places these, not the room */
    const j = i * 3;
    const seen = nodes[j + 1] <= ceiling;
    let touched = false;
    if (nodes[j] < left) { nodes[j] = left; touched = true; }
    else if (nodes[j] > right) { nodes[j] = right; touched = true; }
    if (nodes[j + 1] < floorY) { nodes[j + 1] = floorY; touched = true; }
    if (nodes[j + 2] < back) { nodes[j + 2] = back; touched = true; }
    else if (nodes[j + 2] > front) { nodes[j + 2] = front; touched = true; }

    if (touched && seen) cb.touch[i] = 1;
  }
}

/* THE ONE FORCE THAT GOES THE OTHER WAY. Past its length the cable
   pulls the connector back, as a spring with enough damping that it
   does not bounce. Guarded on the body being awake: a taut rope must
   never be a reason the page keeps drawing. */
function leash(cb, A, G) {
  const body = cb.part.body;
  if (body.isSleeping()) return;
  let dx = A.x - G.x, dy = A.y - G.y, dz = A.z - G.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const over = dist - cb.len;
  if (over <= 0 || dist < 1e-6) return;

  dx /= dist; dy /= dist; dz /= dist;
  const v = body.linvel();
  const out = -(v.x * dx + v.y * dy + v.z * dz);   /* + means pulling away */
  let a = over * C.cableLeash + Math.max(0, out) * C.cableLeashDamp;
  if (a > C.cableLeashMax) a = C.cableLeashMax;
  const k = body.mass() * a * C.step;
  body.applyImpulse({ x: dx * k, y: dy * k, z: dz * k }, true);
}

/* A tube built ONCE: rings of vertices around each node, with a fixed
   index buffer. Every frame rewrites positions and normals in place.
   Rebuilding a TubeGeometry instead would allocate and free a mesh
   sixty times a second, which is how you get a stutter that profiles
   as garbage collection and reads as physics. */
/* MADE ONCE AND KEPT. Every material is a shader program, and a program
   the renderer has not seen before is compiled the first time it is
   drawn -- which is a hitch of real milliseconds in a browser, at the
   worst possible moment, as the cable appears. Kept across spawns so
   the cost is paid at most once; and where there is no clearcoat to
   justify it, made STANDARD rather than PHYSICAL so it can share the
   program the glTF models already use, and there is likely nothing to
   compile at all. Change a colour or a roughness and it takes effect on
   the next frame; only clearcoat crossing zero rebuilds it. */
let cableMat = null, cableMatCoat = -1;

function cableMaterial() {
  const coat = C.cableClearcoat > 0 ? 1 : 0;
  if (cableMat && cableMatCoat === coat) {
    cableMat.color.set(C.cableColour);
    cableMat.roughness = C.cableRoughness;
    cableMat.metalness = C.cableMetalness;
    if (coat) {
      cableMat.clearcoat = C.cableClearcoat;
      cableMat.clearcoatRoughness = C.cableClearcoatRough;
    }
    return cableMat;
  }
  if (cableMat) cableMat.dispose();
  const spec = {
    color: C.cableColour,
    roughness: C.cableRoughness,
    metalness: C.cableMetalness,
    side: THREE.DoubleSide
  };
  if (coat) {
    spec.clearcoat = C.cableClearcoat;
    spec.clearcoatRoughness = C.cableClearcoatRough;
    cableMat = new THREE.MeshPhysicalMaterial(spec);
  } else {
    cableMat = new THREE.MeshStandardMaterial(spec);
  }
  cableMatCoat = coat;
  return cableMat;
}

/* PAID AT LOAD, NOT AT SPAWN. A material is a shader program, and a
   program the renderer has not drawn before is compiled and linked the
   first time it is -- milliseconds, in one frame, at whatever moment
   that happens to be. Spawning the cable out of sight does not help:
   the freeze is a long FRAME, and a long frame stops the whole page
   whether or not the thing causing it can be seen.

   So it is drawn here instead, during boot, where a hitch costs nothing
   because nothing is moving yet: two triangles with the cable's own
   material, compiled and thrown away. If the freeze at spawn was the
   compile, this is where it goes now. If it survives this, it was never
   the compile, and the next place to look is the geometry. */
function warmCable() {
  try {
    if (!renderer || !scene || !camera) return;
    /* POSITION AND NORMAL ONLY, like the tube: a program is chosen partly
       by what the geometry carries, so warming a plane (which brings a
       uv set the tube has not got) can compile something other than the
       thing that will actually be drawn. */
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    const warm = new THREE.Mesh(g, cableMaterial());
    warm.frustumCulled = false;
    warm.position.set(0, -1e5, 0);        /* nowhere anyone is looking */
    scene.add(warm);
    if (renderer.compile) renderer.compile(scene, camera);
    /* AND THE SHADOW PASS, which draws everything again through an
       override material: a second program, and one the cable has never
       been through either. */
    if (shadow && renderer.compile) {
      scene.overrideMaterial = shadow.silhouette;
      renderer.compile(scene, camera);
      scene.overrideMaterial = null;
    }
    scene.remove(warm);
    g.dispose();
  } catch (err) {
    /* a warm-up that fails is not worth a broken page */
  }
}

function buildCableMesh(cb) {
  const R = Math.max(3, C.cableRadial | 0);
  const smooth = Math.max(1, C.cableSmooth | 0);
  const rings = (cb.n - 1) * smooth + 1;
  cb.radial = R;
  cb.smooth = smooth;
  cb.rings = rings;
  cb.path = new Float32Array(rings * 3);
  cb.pos = new Float32Array(rings * R * 3);
  cb.nrm = new Float32Array(rings * R * 3);
  const idx = new (rings * R > 65535 ? Uint32Array : Uint16Array)((rings - 1) * R * 6);
  let w = 0;
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < R; k++) {
      const a = i * R + k, b = i * R + ((k + 1) % R);
      const c = a + R, d = b + R;
      idx[w++] = a; idx[w++] = c; idx[w++] = b;
      idx[w++] = b; idx[w++] = c; idx[w++] = d;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(cb.pos, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(cb.nrm, 3));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geom, cableMaterial());
  mesh.frustumCulled = false;      /* its bounds change every frame */
  cb.mesh = mesh;
  cb.ring = new THREE.Vector3();
  root.add(mesh);
}

/* CENTRIPETAL CATMULL-ROM THROUGH THE NODES, written into cb.path.

   Centripetal, not uniform, and the difference is not cosmetic. Uniform
   parameterisation assumes the control points are evenly spaced; it was
   tempting to assume that here, since the length constraint is trying to
   hold the nodes a fixed distance apart. But it only TRIES: a cable held
   past its length is stretched unevenly, and a bunched one has nodes
   almost on top of each other. Feed either to a uniform curve and it
   overshoots into a cusp, and the drawn cable turns a corner SHARPER
   than the polyline it was meant to smooth -- measured at 163 degrees
   against the 89 it came from. Centripetal knots are the standard
   guarantee against exactly that, and cost one square root per span.

   The ends repeat their neighbour rather than inventing a control point,
   so the curve arrives straight at the connector and at the wall, which
   is the whole reason for pinning two nodes at each end. */
function splinePath(cb) {
  const n = cb.n, m = cb.smooth, nodes = cb.nodes, path = cb.path;
  if (m === 1) { path.set(nodes); return; }

  const knot = (a, b) => {
    const dx = nodes[b] - nodes[a], dy = nodes[b + 1] - nodes[a + 1],
          dz = nodes[b + 2] - nodes[a + 2];
    /* alpha = 0.5, so the fourth root of the squared distance. The floor
       keeps a doubled-up pair from dividing by zero. */
    return Math.max(1e-4, Math.pow(dx * dx + dy * dy + dz * dz, 0.25));
  };

  let w = 0;
  for (let i = 0; i < n - 1; i++) {
    const i0 = (i > 0 ? i - 1 : 0) * 3, i1 = i * 3;
    const i2 = (i + 1) * 3, i3 = (i + 2 < n ? i + 2 : n - 1) * 3;
    const t0 = 0, t1 = t0 + knot(i0, i1), t2 = t1 + knot(i1, i2),
          t3 = t2 + knot(i2, i3);

    for (let k = 0; k < m; k++) {
      const t = t1 + (t2 - t1) * (k / m);
      for (let a = 0; a < 3; a++) {
        const p0 = nodes[i0 + a], p1 = nodes[i1 + a],
              p2 = nodes[i2 + a], p3 = nodes[i3 + a];
        const a1 = ((t1 - t) * p0 + (t - t0) * p1) / (t1 - t0);
        const a2 = ((t2 - t) * p1 + (t - t1) * p2) / (t2 - t1);
        const a3 = ((t3 - t) * p2 + (t - t2) * p3) / (t3 - t2);
        const b1 = ((t2 - t) * a1 + (t - t0) * a2) / (t2 - t0);
        const b2 = ((t3 - t) * a2 + (t - t1) * a3) / (t3 - t1);
        path[w + a] = ((t2 - t) * b1 + (t - t1) * b2) / (t2 - t1);
      }
      w += 3;
    }
  }
  const last = (n - 1) * 3;
  path[w] = nodes[last]; path[w + 1] = nodes[last + 1]; path[w + 2] = nodes[last + 2];
}

function drawCable() {
  const cb = cable;
  if (!cb || !cb.mesh) return;
  splinePath(cb);
  const rings = cb.rings, R = cb.radial, path = cb.path, r = C.cableRadiusCm;
  const pos = cb.pos, nrm = cb.nrm;

  for (let i = 0; i < rings; i++) {
    const a = Math.max(0, i - 1) * 3, b = Math.min(rings - 1, i + 1) * 3;
    _ct.set(path[b] - path[a], path[b + 1] - path[a + 1], path[b + 2] - path[a + 2]);
    if (_ct.lengthSq() < 1e-12) _ct.set(1, 0, 0);
    _ct.normalize();

    /* The ring is carried along the rope rather than rebuilt from a
       fixed up-vector: that is what stops the tube spinning where the
       cable happens to point straight up. */
    if (i === 0) {
      _cn.set(0, 0, 1).cross(_ct);
      if (_cn.lengthSq() < 1e-6) _cn.set(0, 1, 0).cross(_ct);
    } else {
      _cn.copy(cb.ring).addScaledVector(_ct, -cb.ring.dot(_ct));
      if (_cn.lengthSq() < 1e-9) _cn.set(0, 1, 0).cross(_ct);
    }
    _cn.normalize();
    cb.ring.copy(_cn);
    _cb.crossVectors(_ct, _cn);

    const jx = path[i * 3], jy = path[i * 3 + 1], jz = path[i * 3 + 2];
    for (let k = 0; k < R; k++) {
      const ang = (k / R) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const nx = _cn.x * ca + _cb.x * sa;
      const ny = _cn.y * ca + _cb.y * sa;
      const nz = _cn.z * ca + _cb.z * sa;
      const o = (i * R + k) * 3;
      nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
      pos[o] = jx + nx * r;
      pos[o + 1] = jy + ny * r;
      pos[o + 2] = jz + nz * r;
    }
  }
  cb.mesh.geometry.attributes.position.needsUpdate = true;
  cb.mesh.geometry.attributes.normal.needsUpdate = true;
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

/* A ceiling on speed. Nothing here creates motion; it only refuses to
   let a wall hand an object more than a hard throw's worth of it, which
   is the difference between a bounce and a catapult. */
function capSpeeds() {
  for (const o of objects.values()) {
    for (const part of o.parts) {
      const b = part.body;
      if (b.isSleeping()) continue;
      const v = b.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > C.speedMax) {
        const k = C.speedMax / speed;
        b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, false);
      }
      const w = b.angvel();
      const spin = Math.hypot(w.x, w.y, w.z);
      if (spin > C.speedMax / 8) {
        const k = (C.speedMax / 8) / spin;
        b.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, false);
      }
    }
  }
}

/* The walls are led to where the window now is, a little each physics
   step. Called inside the sub-step loop for a reason: setting the
   whole frame's movement at once made each wall cover it in a single
   quarter-step, so the physics read it as four times the speed of the
   hand dragging it -- and objects were launched. */
function stepWalls(dt) {
  const max = C.wallSpeed * dt;
  for (const wall of wallBodies) {
    const p = wall.body.translation(), t = wall.target;
    const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) continue;
    if (d > C.wallJump) { wall.body.setTranslation(t, true); continue; }
    const k = d > max ? max / d : 1;
    wall.body.setNextKinematicTranslation(
      { x: p.x + dx * k, y: p.y + dy * k, z: p.z + dz * k });
  }
}

/* After a jump, put back what the new frame left outside -- set down
   where it stands, not thrown. */
function carryInside() {
  const left = VX / PXCM, right = (VX + W) / PXCM;
  const floorY = (SH - (VY + H)) / PXCM;
  for (const o of objects.values()) {
    const p = o.parts[0].body.translation();
    const r = o.reach || Math.max(o.half[0], o.half[1], o.half[2]);
    const x = Math.min(Math.max(p.x, left + r), Math.max(left + r, right - r));
    const y = Math.max(p.y, floorY + r);
    if (x === p.x && y === p.y) continue;
    const dx = x - p.x, dy = y - p.y;
    for (const part of o.parts) {
      const q = part.body.translation();
      part.body.setTranslation({ x: q.x + dx, y: q.y + dy, z: q.z }, true);
      part.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      part.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }
}

/* THE NET. Whatever still gets through -- a hard throw into a corner,
   a stack pressed at a bad angle -- is caught: any object whose centre
   ends up below the floor, beyond a side wall or out of the slab is
   put back just inside, still, with all its parts moved together so
   the tally keeps its ring. Checked every step; it costs a few
   comparisons per object and almost never fires. */
function rescue() {
  const left = VX / PXCM, right = (VX + W) / PXCM;
  const floorY = (SH - (VY + H)) / PXCM;
  const back = -C.depthCm, front = C.frontCm;
  for (const o of objects.values()) {
    const p = o.parts[0].body.translation();
    const reach = o.reach || Math.max(o.half[0], o.half[1], o.half[2]);
    let dx = 0, dy = 0, dz = 0;
    if (p.y < floorY - 0.5) dy = floorY + reach + 0.2 - p.y;
    if (p.x < left - 0.5) dx = left + reach - p.x;
    else if (p.x > right + 0.5) dx = Math.max(left, right - reach) - p.x;
    /* THE SLAB IS ASYMMETRIC, so this cannot test |z| and cannot put
       what it catches back at z = 0: an object resting perfectly well
       at the front of the room would read as escaped and be
       yanked to the middle. Each face is tested on its own, and what
       is caught is set down just inside THAT face, where it was. */
    if (p.z < back - 0.5) dz = back + 0.2 - p.z;
    else if (p.z > front + 0.5) dz = front - 0.2 - p.z;
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
  /* In the SAME frame as the first render, not the next one. A frame
     later and the picture was still on screen while the canvas had
     already drawn: two floors, two shadows, one dark frame. Hidden
     here, both changes reach the screen together. */
  document.documentElement.classList.add("drift-3d-live");
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
    /* AND THE CABLE, which is not one of the objects: it is a mesh of
       its own on root, so this box used to be drawn around the objects
       alone and the photograph came out cut off -- the cable present
       for the few centimetres that happened to fall inside the crop and
       simply absent beyond it, until the live canvas took over a moment
       later. It is also much the widest thing in the scene, so it
       enlarges the picture more than anything else here. */
    if (cable && cable.mesh) box.union(part.setFromObject(cable.mesh));
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
    const left = Math.max(0, Math.floor(box.min.x - pad));
    const right = Math.min(SW, Math.ceil(box.max.x + pad));
    const bottom = Math.max(0, Math.floor(box.min.y - pad));
    const top = Math.min(SH, Math.ceil(box.max.y + pad));
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
    const onX = rect.width / SW, onY = rect.height / SH;     /* screen px per scene px */
    const bufX = el.width / SW, bufY = el.height / SH;       /* buffer px per scene px */

    /* Draw, then copy in the same task, while the drawing buffer is
       still valid -- no preserveDrawingBuffer needed. */
    drawShadows();
    renderer.render(scene, camera);
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(w * bufX));
    crop.height = Math.max(1, Math.round(h * bufY));
    crop.getContext("2d").drawImage(el,
      left * bufX, (SH - top) * bufY, w * bufX, h * bufY,
      0, 0, crop.width, crop.height);

    /* WebP where the browser can encode it; Safari falls back to PNG. */
    const url = crop.toDataURL("image/webp", 0.92);

    /* Where it sits, in the terms boot uses: from the centre of the
       fixed containing block, and up from its bottom edge. */
    const html = document.documentElement;
    const screenLeft = rect.left + left * onX;
    const screenBottom = rect.top + (SH - bottom) * onY;

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

let running = false, last = 0, acc = 0, calm = 0, drawnAt = 0;

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

  /* Skip this turn if the last drawing was too recent: the screen may
     refresh far faster than anything here needs to be redrawn. */
  if (C.maxFps && now - drawnAt < 1000 / C.maxFps - 1) {
    requestAnimationFrame(frame);
    return;
  }
  drawnAt = now;

  /* Clamped both ways: a rAF timestamp can be slightly EARLIER than
     the performance.now() taken in wake(). */
  acc += Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  let n = 0;
  while (acc >= C.step && n < C.maxSteps) {
    steerDrag();
    for (let k = 0; k < C.substeps; k++) {
      stepWalls(C.step / C.substeps);
      world.step();
      capSpeeds();
    }
    simSteps += 1;
    rescue();
    stepCable(C.step);
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
  drawCable();
  const animating = stepTally(now);
  if (speaker3d.id) showSpeaker(speakerLevel());
  requestEnv(false);         /* the tally moved: throttled, and a no-op if not */
  drawShadows(now);
  renderer.render(scene, camera);
  if (!live) goLive();

  if (!drag && !animating && !speaker3d.id && allAsleep()) {
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
  /* A rope still swinging over sleeping objects is the one thing that
     would otherwise be drawn wrong the moment the loop stopped. */
  if (cable && !cable.still) return false;
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
    /* THE CABLE GOES WITH IT. It was left to rebuild itself from its two
       ends, on the argument that a rope derived from two points cannot
       disagree with itself. It can: once it has friction and a memory of
       its own shape, where it settles depends on how it got there, so
       the next page draped it somewhere else and the handover showed as
       a jump. Two dozen points, to two decimals, against that. */
    if (o.kind === "connector" && cable && cable.id === rec.id) {
      const A = cableAnchor(_cA), p = [];
      for (let i = 0; i < cable.nodes.length; i++) p.push(round(cable.nodes[i], 100));
      rec.cable = { a: [round(A.x, 100), round(A.y, 100), round(A.z, 100)], p: p };
    }
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
  return { x: (VX + clientX) / PXCM, y: (SH - (VY + clientY)) / PXCM };
}

function hit(clientX, clientY) {
  if (!objects.size) return null;
  if (document.documentElement.classList.contains("lightbox-open")) return null;
  ndc.set(((VX + clientX) / SW) * 2 - 1, -(((VY + clientY) / SH) * 2 - 1));
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
             local, tx: h.point.x, ty: h.point.y,
             fromX: e.clientX, fromY: e.clientY, at: performance.now(),
             moved: false };
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
      if (Math.hypot(e.clientX - drag.fromX, e.clientY - drag.fromY) > C.tapSlop) {
        drag.moved = true;
      }
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

    /* A TAP, NOT A DRAG: pressed and let go without moving. The one
       gesture a visitor already makes, so the speaker needs no button
       of its own -- and carrying it around stays silent. */
    const held = performance.now() - drag.at;
    const tap = !drag.moved && held < C.tapTime;
    if (document.querySelector("[data-drift-debug]")) {
      console.log("drift-3d: release on " + (objects.get(drag.id) || {}).kind +
                  " -- " + (tap ? "TAP" : "drag") +
                  ", moved " + (drag.moved ? ">" + C.tapSlop : "<=" + C.tapSlop) +
                  " px, held " + Math.round(held) + " ms");
    }
    if (tap) {
      const o = objects.get(drag.id);
      if (o && o.kind === "speaker") toggleSpeaker(o);
    }
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
    if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey && !e.altKey &&
        document.querySelector("[data-drift-debug]")) {
      showInfo("sound: " + sound.status +
               "\naudio: " + (sound.ctx ? sound.ctx.state : "none") +
               "\nplayed on this page: " + sound.played +
               (sound.skipped ? "\nlast skipped: " + sound.skipped : "") +
               "\nleave hold: " + (drift.leaveHold ? peekHold() + " ms" : "n/a"));
      return;
    }
    if ((e.key === "b" || e.key === "B") && !e.ctrlKey && !e.metaKey && !e.altKey &&
        document.querySelector("[data-drift-debug]")) {
      togglePageOverlay();
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
