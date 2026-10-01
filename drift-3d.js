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
  /* THICKNESS COMES FROM THE CONNECTOR, as a share of its length, because
     that is what it physically is: a cable is the size it is because of
     the plug on the end of it. Set from the model at spawn, so changing
     connectorCm carries the cable with it and the two never drift apart.
     0.046 is the ratio the hand-tuned pair had -- a 0.25 cm radius on a
     5.4 cm connector. Raise it for a heavier cable. */
  cableRadiusShare: 0.046,
  cableRadiusCm: 0.25,  /* overwritten from the connector: see above */   /* ALSO THE CLEARANCE it keeps from the floor, the
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
  /* PLUGGING IN. The world is a flat slab seen head on, with no gesture
     that turns a body, so "push the plug into the socket" is not
     something a visitor can actually do. Bringing the connector NEAR
     the socket is, so that is the gesture: within this far, in any
     orientation, and the rest is scripted. */
  /* THE DEPTH ASSIST. The room is seen straight on, so the one axis a
     visitor cannot aim is the one they must get right: two things can
     look as though they are touching while sitting centimetres apart
     through the page, and no amount of dragging closes that, because
     dragging only moves things in the plane of the screen.

     So the closer the plug comes to the socket ACROSS the screen, the
     more its depth and its angle are drawn toward where they need to
     be. It is invisible: nothing moves that anyone can see, because the
     camera has no opinion about depth. It is also not a snap -- the pull
     grows smoothly with nearness, so a connector picked up right next
     to the speaker eases into line rather than jumping into it. */
  plugAssistShare: 3,   /* how far out it starts, as a share of the
                           connector's length. 0 turns it off */
  plugAssistRate: 0.22, /* and how firmly it pulls, per frame, at its
                           strongest. High enough to feel effortless,
                           low enough that it is never a yank */
  /* PULLING IT OUT. The plug resists, then gives: dragging it slides
     the connector along the socket's own axis, and past the threshold
     it comes free. Instant release would make it a magnet rather than a
     plug -- the resistance is the whole feeling. */
  plugPullShare: 0.8,   /* how far it must be DRAGGED, as a share of the
                           connector's length, before it lets go */
  plugSlideShare: 0.17,  /* and how far it visibly comes out of the socket
                           while that happens. Separate on purpose: tied
                           together, the plug was standing clear of the
                           cabinet and plainly unplugged while still
                           attached. Keep this well under plugPullShare
                           and the last of the drag is felt as the socket
                           holding on rather than seen as a gap. */
  plugFlySpeed: 55,     /* HOW HARD IT POPS: cm/s along the socket's axis,
                           so it leaves rather than merely stopping being
                           attached. Gravity here is 60 cm/s2, so this is
                           about a second's worth of fall -- lower it for
                           a plug that drops out, raise it for one that is
                           spat out. 0 simply detaches. */
  plugFlySpin: 60,       /* rad/s of tumble with it, so it does not sail
                           out rigidly like a dart */
  plugClearShare: 0.55, /* HOW FAR CLEAR IT IS SET DOWN when it pops, as a
                           share of its length. A seated connector has its
                           plug inside the cabinet, so a body created
                           exactly where the mesh was is created already
                           overlapping the speaker -- and the solver's
                           answer to two things inside each other is to
                           throw them apart, which took the speaker with
                           it. Pulling it out by hand hid that, because
                           the slide had already moved it most of the way
                           out; the pop on arrival had not, and made a
                           mess. Enough to get the plug out of the socket,
                           and no more. */
  plugArriveForce: 0.55, /* THE POP ON ARRIVAL, as a share of plugFlySpeed.
                           Lower than a pop you asked for, and not only to
                           taste: a page arrives with the speaker asleep,
                           so the solver meets the connector's last
                           overlap all in one step and resolves it with a
                           kick the intended throw then adds to. Waking
                           the speaker first takes most of that out; this
                           is the rest, and the dial if it still leaves
                           with more force than it should. */
  plugMusicGapMs: 0,    /* extra pause between the click and the music, on
                           top of the click's own length. The clip's real
                           duration is read from the file, so this is only
                           for taste: negative overlaps them, positive
                           leaves a beat of silence between. */
  plugPopDelayMs: 260,  /* after a page arrives, how long it stays plugged
                           in before it pops: long enough to register that
                           it was, short enough not to feel like a wait.
                           Then it waits further, until the floor has come
                           to rest -- a connector thrown out of a speaker
                           that is still falling into place goes wherever
                           the two of them happen to be arguing. */
  plugPopWaitMs: 0,  /* ... but not forever, if it never settles */
  plugSnapShare: 0.6,   /* and how close the plug's tip must come, likewise
                           as a share of the connector's length: a reach
                           that made sense for a 5 cm plug would be absurd
                           for a 2 cm one */
  plugSnapCm: 3.2,      /* overwritten from the connector: see above */
  plugSeatMs: 170,      /* and how long it then takes to seat itself */

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
  cableLeashPlugged: 0,
                        /* AND NONE OF IT ONCE IT IS PLUGGED IN, because
                           then the thing on the end of the cable is not a
                           connector but a speaker. The leash works in
                           acceleration and multiplies by mass at the end,
                           so 30g yanks a cabinet exactly as briskly as it
                           tugs a plug -- and a page arriving with the
                           cable a little past its length hauled the
                           speaker up off the floor. A cable can drag a
                           speaker; it should have to work at it. Off
                           entirely for now, because the leash is the ONLY
                           way the cable can push any body at all -- every
                           other constraint moves nodes and nothing else --
                           so if a plugged speaker is still dragged about
                           with this at 0, the cable is not what is doing
                           it and the fault is somewhere else. */
  connectorMatchSpeaker: false, /* SIZE IT AGAINST THE SPEAKER rather than
                           to a height of its own, keeping whatever
                           relative size the two were modelled at. True to
                           the models and wrong on the screen: a real XLR
                           beside a real Genelec is a small thing, and the
                           speaker here is already squeezed from 30 cm
                           into 11, so the honest version came out too
                           small to grab. Off, and connectorCm rules. */
  connectorCm: 3.4,     /* an XLR connector's real body length, and what
                           its size actually is while the above is off */

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
  lockURL: new URL("models/lockbox.glb", import.meta.url).href,
  keysURL: new URL("models/keys.glb", import.meta.url).href,
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
  /* WHICH WAY THE DRIVER POINTS, in the model's own frame. A speaker
     turned away from the room is quieter than one facing it, and the
     visitor can turn it -- so the music follows where it is aimed. The
     SOUNDS DO NOT: the plug's click is a thing happening in the room,
     not something coming out of the cabinet. Blender's forward (-Y)
     leaves the exporter as +Z, which is this; flip the sign if the
     speaker turns out to be loudest with its back to you. */
  speakerFace: [0, 0, 1],
  speakerBackVol: 0.7, /* of full, with the driver pointing dead away */
  speakerTurnEase: 0.06,/* seconds the volume takes to follow a turn, so
                           spinning it is a sweep rather than a staircase */
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
  plugOutSound: "sounds/plug-out.mp3",
  plugSound: "sounds/plug-in.mp3",   /* NOT speaker-*: build_pages.py globs
                                        that prefix into the music pool, and
                                        a click in the shuffle is nobody's
                                        idea of a track */
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
  pressGap: 120,

  /* THE LOCKBOX. One number for its size: everything else -- the
     dials, the door, the reach of the focus view -- follows from it.
     11 cm is the speaker's height, so the two read as the room's big
     objects. That makes it 6.15 wide and 3.14 deep, and its dials
     1.06 cm across: about 52 px on a desktop, still too small to turn
     without bringing it forward.

     WHAT IT COSTS. PXCM caps the tally at 270 px, so 11 cm is 545 px
     -- most of a laptop's viewport before focus mode enlarges
     anything. Fitting the height there is a scale of about 1.2, while
     the same rule on a phone is 2.7. Focus on a desktop is therefore
     mostly centred, straightened and stilled rather than bigger. */
  lockCm: 11,

  /* WHAT THE DIALS SHOW AS MODELLED, like the tally's restDigit. */
  lockRestDigit: 7,

  /* One digit, about the dial's own axle. Ten numerals on a cylinder,
     so 36 degrees; the SIGN is which way the numerals climb, and that
     is in the texture, where no amount of reading the file will find
     it. Flip it if counting up counts down. */
  lockDigitStep: -36 * DEG,

  /* THE HINGE, in the door's own frame. The door's origin is the
     pivot -- at the centre of the case's bottom face, mid-depth,
     which is where the model puts it -- and this is the axis through
     it. The door's geometry is symmetric about x = 0 and offset in y
     and z, so x is the only axis it can be. POSITIVE IS OPEN, checked
     in the browser: +120 swings it forward, as it does in Blender. */
  lockHinge: [1, 0, 0],

  /* THE DOOR IS ITS OWN BODY, joined to the case, exactly as the
     tally's ring is. Two joints, swapped once:

       shut   a FIXED joint. A revolute limited to 0 does not hold
              anything shut -- it holds it at an angle, and the first
              landing on its back would sag it open.
       open   a REVOLUTE one, limited, so it flops and collides.

     The limits are measured against the model, like hingeMin/Max. If
     the door ends up hanging the wrong side of shut, negate both and
     reverse them.

     120 IS ONLY REACHABLE IN THE AIR. The hinge is a millimetre or
     two off the bottom of the case and the door is 7 cm from pivot to
     tip, so a box standing on the floor has its door flat on the
     ground at 90 degrees and 120 would put the tip 3.5 cm under it.
     While it is held forward the room is not touching it and it
     swings the whole way; once it is back on the floor the floor
     decides, and it comes to rest at about 90. Both are true and
     neither is a compromise -- see lockFreeWhileOpen for when the
     door is handed back to the room. */
  lockDoorLimits: [0, 120 * DEG],

  /* THE PUSH IT IS GIVEN AS IT POPS, per unit of the door's mass, so
     resizing the box does not need it retuned.

     ZERO: IT FALLS OPEN ON ITS OWN. The hinge is at the bottom CENTRE
     of the case, so a shut door on an upright box is nearly balanced
     on its own pivot -- but only nearly. Its panel runs from z =
     -0.25 to +0.93 about a pivot at 0, so its weight sits forward of
     the hinge and there is a real torque, about m*g*0.75 cm. It
     hesitates and then falls, which is what a sprung door does and
     what a pushed one does not.

     It is left here as a dial because a box that is NOT upright has
     no such torque, and opening one by hand while it lies on its
     face will do nothing at all without it. */
  lockDoorKick: 0,

  /* The door's share of the case's mass. Light, so a swinging door
     cannot throw the case about. */
  lockDoorShare: 0.25,

  /* ---------------------------------------------------------------
     FOCUS — the box comes forward
     ---------------------------------------------------------------
     Tap a shut box and it flies to the middle of the window, turns
     square to the viewer and grows, while the page blurs behind it
     and the world stops. The camera is ORTHOGRAPHIC, so "closer"
     means nothing: bigger is a scale on the drawn mesh, and the
     bodies do not move at all. Nothing else in the room is scaled.

     THE OTHER OBJECTS ARE VEILED, NOT BLURRED. Blurring them would
     take a second canvas or a photograph layered under this one, and
     the photograph has to follow the canvas in and out of <body>
     whenever mirrored-page puts a transform on it. A white plane
     drawn in the scene, with the box in front of it, costs none of
     that. Swap it for a photograph here if the stillness reads
     wrong. */
  lockFocusFit: 0.8,    /* of the window's height the box fills */
  lockFocusMs: 420,     /* the flight, each way */
  lockVeilZ: 15,        /* the veil. CLEAR OF THE ROOM, not inside it:
                           the front wall stands at frontCm (14), so an
                           object carried forward reaches z = 14 and
                           would otherwise poke through it. Nothing
                           about focus is simulated, so being outside
                           the room costs nothing */

  /* HOW FAR IN FRONT OF THE VEIL THE BOX IS HELD, on top of its own
     swept size. A fixed gap does not work: the box is scaled, and
     turning it sweeps its DIAGONAL, not its depth -- tilted, an 11 cm
     box needs about 5.7 cm of clearance before scaling, and several
     times that on a phone. So the gap is worked out at the moment it
     comes forward and this is only the margin on top. */
  lockFocusGapCm: 1.5,
  lockVeilAlpha: 0.72,  /* white, near the page's own lightbox (0.6) */

  /* SHAKING IT while it is forward: press anywhere but a dial and
     drag. Drawn only -- the world is held, so there is nothing to
     simulate. A spring back to centre, and a limit so it cannot be
     thrown off the screen. */
  lockShakeCm: 2.4,     /* the furthest it will follow the hand */
  lockShakeGain: 0.9,   /* share of the hand's travel it follows: near
                           1, so the box goes where the hand goes */
  lockShakeSpring: 65,  /* stiff, so it arrives under the hand rather
                           than trailing after it */
  lockShakeDamp: 10,    /* against 2*sqrt(65) = 16 for a dead stop, so
                           it overshoots slightly and can be rattled */

  /* IT TURNS WHERE IT IS PULLED. The grab point is a lever on the
     box's middle, so dragging the top sideways leans it and dragging
     through the middle barely turns it at all -- the axis is the
     lever crossed with the hand's travel, which is where a torque
     points. Springs back with the offset. */
  lockShakeTilt: 2.5,   /* radians per unit of lever x travel */
  lockShakeTiltMax: 22 * DEG,

  /* ---------------------------------------------------------------
     THE DIALS — turned by hand, while the box is forward
     ---------------------------------------------------------------
     A drag up or down on a dial turns it. CONTINUOUS, not a digit a
     swipe: the wheel follows the hand, clicks as it passes each
     detent, and settles on the nearest number when let go. Past 9 it
     keeps going into 0 rather than winding back, and there is no
     limit on how far -- spin it hard and it spins.

     A FIXED DISTANCE PER DIGIT, not a share of the dial. The dial is
     about 1 cm across, so its own surface only moves some 20 px a
     digit even enlarged, and tying the gesture to that made it
     twitchy. 30 px is a deliberate gear ratio: the numbers move
     slower than the finger, which reads as weight. */
  lockDialPx: 30,
  lockDialDir: 1,       /* 1 = dragging up counts up. Flip if not */
  lockDialSnapMs: 140,  /* the settle onto the nearest number */

  /* THE NOTCHES. A real combination dial does not turn smoothly: it
     rests in a detent, resists, then falls into the next one. So the
     hand's steady travel is bent before it becomes an angle -- the
     dial lingers on each number and crosses the gap between quickly.
     1 is a smooth wheel; higher notches harder. The curve is exact
     at the halfway point either side, so no amount of it changes
     WHICH number the dial is nearest, only how it gets there. */
  lockDialNotch: 2.6,

  /* THE DETENT'S CLICK, six of them, one picked at random each time a
     number goes by. One sample repeated at this rate reads as a
     machine gun -- the ear catches the repetition long before it
     catches the sound. Six and a little pitch either way is enough
     that a dial spun hard sounds like a dial.

     Any that are missing are simply dropped: the bank is whatever
     loaded, and an empty bank is silence, not an error. Names must
     not begin with "speaker-", which the build globs into the music
     pool. */
  lockWheelSounds: ["sounds/lock-wheel-1.mp3", "sounds/lock-wheel-2.mp3",
                    "sounds/lock-wheel-3.mp3", "sounds/lock-wheel-4.mp3",
                    "sounds/lock-wheel-5.mp3", "sounds/lock-wheel-6.mp3"],
  lockWheelVolume: 0.55,
  lockWheelDetune: 0.07,  /* +/- share of playback rate, per click */

  /* ---------------------------------------------------------------
     THE RATTLE — something is in there
     ---------------------------------------------------------------
     This is the only clue a shut box gives, so it has to be heard --
     but ONLY WHILE IT IS BEING HELD. A box rattling as it tumbles
     across the room on its own, or as things knock into it, is noise
     all afternoon for a hint that is only wanted when someone has
     their hand on it.

     ON REVERSALS, NOT ON SPEED. Carrying it smoothly is silent
     however fast it goes; keys rattle when the direction changes. So
     the velocity is watched for a flip, and how hard the flip was
     sets how loud. Held in the room that velocity is the body's; in
     focus there is no body moving, so it is the shake spring's
     instead -- the same rule reading a different needle.

     It stops for good once the door is open: what was making the
     noise has left. */
  lockRattleSounds: ["sounds/lock-rattle-1.mp3", "sounds/lock-rattle-2.mp3",
                     "sounds/lock-rattle-3.mp3", "sounds/lock-rattle-4.mp3",
                     "sounds/lock-rattle-5.mp3", "sounds/lock-rattle-6.mp3"],
  lockRattleVolume: 0.7,
  lockRattleDetune: 0.08,
  /* BOTH ARE PEAK SPEEDS BEFORE THE TURN, not speeds at it. A
     reversal happens at the instant the box is slowest -- it is
     passing through zero -- so testing the speed there throws away
     exactly the hardest shakes. What throws keys about is how fast it
     was going before it turned round.

     THE HAND'S SPEED, in both places. In the room the body is
     following the hand so its own velocity will do; in focus the
     spring is not -- it chases an offset capped at lockShakeCm, so
     however hard the box is shaken its velocity tops out around 20
     and a threshold above that can never be met. So focus reads the
     POINTER instead, which is what shaking actually is, and both
     needles are then on the same scale: dragMaxPx is 4000 px/s, some
     80 cm/s, and a brisk shake is 10 to 30. */
  /* A SHUT BOX TAKES REAL SHAKING. These are deliberately several
     times the keys': a bunch hanging loose answers a flick, while
     something closed and heavy has to be moved about before whatever
     is inside it shifts. Turning the keys up without turning the box
     down left the two nearly the same, which is most of what made the
     box feel over-eager. */
  lockRattleMinCmS: 14,   /* the gentlest flip that is heard at all */
  lockRattleFullCmS: 70,  /* and the one that is heard at full */
  lockRattleGapMs: 170,   /* and far apart: a shake, not a jingle */
  lockRattleJoltCmS: 22,  /* against the keys' 1.6. An ordinary drag
                             changes the hand's speed by a few cm/s
                             most frames, so at 6 this fired almost
                             continuously and no threshold elsewhere
                             could quieten it */

  /* AND IT DOES NOT RING JUST FOR BEING PICKED UP. A loose bunch
     jingles the moment it is carried off; a box does not announce
     itself when lifted, it answers being shaken. Keys have this on,
     the box has it off, and that difference is most of what makes the
     two read as different objects. */
  lockRattleOnStart: false,

  /* THE LATCH GIVING. One file, not a bank, and no pitch wobble: a
     visitor hears this once per box in their life, so there is
     nothing for repetition to wear out. It plays the moment the
     mechanism lets go -- when the joint is swapped and gravity takes
     the door -- not when the door finishes swinging, so the sound
     leads the movement rather than trailing it. */
  lockOpenSound: "sounds/lock-open.mp3",
  lockOpenVolume: 0.85,

  /* ---------------------------------------------------------------
     THE KEYS — eight bodies on a ring
     ---------------------------------------------------------------
     models/keys.glb: ring_0 the gold hub, key_0..3 hanging off it,
     ring_1 threaded through it, clasp on ring_1, fob on the clasp.
     The file parents all of them to ring_0 as siblings, so what hangs
     from what is said HERE instead -- rename a node in the model and
     this is the list to change with it.

     THE TWO RINGS ARE NOT JOINTED. They are loose in each other, and
     a joint of any kind would pin the crossing to one point on each
     and stop it travelling round. They are held together by being
     threaded -- which only works if neither can pass through the
     other, and that is what the sphere loops below are for. */
  keysCm: 8,
  keysParts: ["ring_0", "key_0", "key_1", "key_2", "key_3",
              "ring_1", "clasp", "fob"],

  /* A RING'S CONVEX HULL IS A SOLID DISC -- hulls fill hollows, and
     everywhere else in this room that is accepted because nothing
     else is a torus. Here it would mean the fob swinging into an
     invisible plate. So each ring is a LOOP OF BALLS instead, laid
     round its own measured circumference.

     THE COUNT IS LOAD-BEARING. The gap between two neighbouring balls
     must be narrower than the other ring's wire is thick, or the
     rings come apart. Measured off the model: wire radius 0.027 of
     the set against a ring radius of 0.293, about 1:11. At 36 the gap
     is a fraction of a millimetre and it holds -- and the wire is
     smoother for a key to slide along, which 28 was not: the
     scalloping between balls was enough to catch one. Fewer is not an
     optimisation, it is a hole. */
  keysRingBalls: 36,

  /* THE TWO RINGS ARE PINNED AFTER ALL, at the point where they
     cross. Threading them is the truthful version -- a real second
     ring travels round the first -- and it has not held: they work
     apart, and then the leash, which corrects by MOVING both bodies,
     can shove one through the other at the very crossing it is
     supposed to protect. A ball joint there swivels every way, which
     is nearly all of what the crossing does; what it gives up is the
     travel, and two rings that pivot freely but keep their crossing
     read the same in motion.

     Set false to go back to threading them. The keys are threaded
     either way -- that works, and they must slide. */
  keysRingJoint: true,

  /* And thin wire moving fast is the tunnelling case. A key through
     the floor would be a nuisance; rings through EACH OTHER come
     apart for good, so both rings sweep their motion. */
  keysCcd: true,

  /* THE WIRE IS THINNER TO THE SOLVER THAN IT IS TO THE EYE. The key
     holes are tight -- the narrowest measures 0.093 cm against a wire
     of 0.070 -- and two hundredths of a centimetre of clearance binds
     rather than slides. Taking the collider in a fifth gives every
     key that much more room, and at this size the difference is well
     under a pixel on screen.

     IT CUTS BOTH WAYS, so it is checked rather than assumed. The gap
     between one ring's balls must stay narrower than the other's wire
     is thick or they come apart, and both shrink together: the rule
     is spacing < 4 x ball radius. ringColliders says so out loud if
     it is ever broken. */
  keysWireShrink: 0.8,

  /* THE KEYS ARE THREADED, NOT PINNED. A revolute held a key to the
     ring and let it turn, which is half of what a key does -- the
     other half is travelling round the wire, and no joint does that:
     a bead on a wire is not a constraint Rapier has.

     So there is no joint at all. Each key's head is a loop of balls
     round its own hole, laid where the metal actually is, and the
     ring's wire is caught inside it by geometry. Nothing then says it
     cannot slide, so it slides -- and nothing says which way it may
     turn, so the twisted-axis problem goes with it.

     THE HOLES ARE NOT CIRCLES. Some are square, and they run from
     0.09 cm to 0.57 across one rim. So the rim is measured PER
     SECTOR: sweep round, take the nearest vertex in each, and put
     that ball there. A square hole gets a square channel. */
  /* THE HEAD IS CUT INTO WEDGES, not lined with balls.

     A loop of balls only ever describes an ANNULUS, and these heads
     are an annulus with a long neck running out to the blade. One
     ball per sector at the furthest point put a ball at the neck's
     tip and NOTHING along its length, so another key's blade went
     straight through it -- meshes inside each other, which no amount
     of friction or overlap can help.

     A wedge of the head is very nearly convex, so its hull is
     accurate; and because the wedges only meet out at the rim, the
     union of them still has the hole in the middle. It follows a
     neck, a square hole, any outline at all. The one error is that
     each wedge's hull cuts the corner across its own inner edge,
     which at twelve wedges is about a seventieth of the hole's
     radius -- well under a tenth of a millimetre here. */
  keysHeadWedges: 12,

  /* WHERE THE HEAD STOPS AND THE NECK BEGINS, as a multiple of the
     head's own radius.

     Wedging the WHOLE head was wrong. A wedge is the convex hull of
     everything in its sector, and one or two sectors hold the neck
     running out to the blade -- so their hulls were not the neck but
     a triangular slab from the rim to the neck's tip, filling the
     empty space either side of it. Two keys jammed on invisible
     triangles while their meshes appeared to pass through each other,
     because in that space one of them has no metal at all.

     So only the ring of the head is wedged, and whatever reaches past
     this is hulled on its own -- a neck is convex, and hulling it
     whole is both accurate and cheap. A head with no neck has nothing
     out there and nothing is built. */
  keysHeadCut: 1.15,

  /* A HOLE THAT IS OPEN TO THE WIRE AND SHUT TO EVERYTHING ELSE.

     The wedges leave a real hole, which is what lets a key thread on
     to the ring -- and a real hole is also something another key's
     blade can go through, after which the two are linked exactly as
     two real keys would be, and will not come apart.

     Those two only contradict each other if every shape has to answer
     to everything. So each key carries ONE MORE collider, a plain
     hull of its head with the hole filled in, which meets other keys
     and the room but never the rings. The wedges keep the hole open
     for the wire; the cap keeps it shut for blades.

     It is weightless -- the wedges already account for the head. */
  keysGroupWorld: 0x0001,
  keysGroupRing: 0x0002,
  keysGroupKey: 0x0004,

  /* The colour the colliders are drawn in when they are asked for.
     One colour for all of them, not Rapier's own per-body shades:
     the question being asked is where the shapes ARE, and a single
     bright line against the room answers it without inviting any
     other reading. */
  colliderColour: 0xff2d95,

  /* THE BALLS OVERLAP, they do not merely touch. Sized to touch, a
     loop is a scalloped surface with a dimple between every pair --
     and a dimple on one key is a seat for a ball on another, so two
     keys laid together mesh like gears and stick. The wire rides the
     same bumps inside a rim instead of sliding along it. Overlapping
     fills the dimples in and costs nothing: the shape only gets
     smoother. */
  keysBallOverlap: 1.4,

  /* AND THEY ARE SLIPPERY. Every ball built here missed the friction
     hullCollider sets, so they all took Rapier's default of 0.5 --
     rope, not metal. Keys on a ring should slide over each other and
     along the wire. */
  keysBallFriction: 0.18,

  /* The blades kept the hull's 0.7 while every ball around them was
     at 0.18, so the flat faces gripped where the round parts slid. */
  keysBladeFriction: 0.25,


  /* A BEAD ON A WIRE, which is the constraint Rapier does not have
     and this writes out by hand.

     Threading alone never held. Contacts must catch the key afresh
     every step, and a hard pull moves it further in one step than the
     solver can resolve -- so the wire ends up outside the hole and
     the key hangs off the ring. The old leash did not help: it capped
     the distance from the key to the ring's CENTRE, and a key sitting
     a centimetre clear of the wire satisfies that perfectly.

     The wire is a circle of known radius in a known plane, so the
     nearest point on it to a key's hole is two lines of arithmetic.
     The key is then simply not allowed further from that point than
     its own hole's play. It may travel anywhere round the circle and
     turn any way it likes -- those are free -- it just cannot leave.

     The play is the hole's narrowest radius less the wire's, times
     this. Above 1 it can rattle loose before being caught; below, it
     is held tighter than the metal really would. */
  keysWirePlay: 0.95,

  /* A LEASH IS NOT A JOINT HERE, and cannot be. Rapier switches off
     contacts between any two bodies it joins -- which is right for the
     clasp and the fob, and fatal for anything held together by being
     threaded. Roped to the hub, a key passed straight through the
     ring and hung at the end of its rope; the two rings did the same.
     The threading never got a chance, because the thing meant to
     catch a failure was causing it.

     So the leash is a few lines of arithmetic instead. And it is a
     LIMIT, not a spring: a spring always stretches, and one stiff
     enough not to is stiff enough to explode. Measured, the spring
     version corrected about 0.15 cm/s a step against the 8 cm/s that
     gravity adds in the same step -- fifty times too weak, and the
     set simply came apart. So past the limit the two are put back ON
     it and the velocity that was separating them is cancelled. No
     stretch, nothing to tune, nothing to blow up. */

  /* THE LEASH BETWEEN THE RINGS, as a share of the two radii added
     together. That sum is the geometric MAXIMUM for two threaded
     rings -- the crossing point lies on both circles, so neither
     centre can be further from it than its own radius. Longer than
     that (it was 1.35) permits a gap wider than being linked at all.
     SHORTER IS WORSE, though: two rings hanging threaded sit at very
     nearly that full distance, so a short rope hauls them together
     every frame and presses the wires into each other -- a way to
     force the crossing through, not to prevent it. Exactly 1 never
     binds while they are linked and catches nothing but a real
     separation. */
  keysRopeSlack: 1.0,

  /* GRABBING ANY PART LIFTS THE WHOLE SET. The hand takes the hub
     wherever it actually landed, so the bunch comes up together and
     the piece that was touched hangs from it. Steering the touched
     part instead means dragging a key on a nearly free hinge: the key
     swings, the joints pass on almost nothing and the set stays on
     the floor. */
  /* THE HAND TAKES WHAT IT TOUCHES. While the keys were PINNED to the
     ring, pulling one only made it swing on its hinge and the set
     stayed put -- so every grab was redirected to the hub. Threaded,
     a key traps the wire inside its own rim and pulls the ring
     directly, and the redirect only made it feel as though the wrong
     thing had moved. Left as a switch because it is the one thing
     that would have to come back if the keys were ever pinned
     again. */
  keysDragHub: false,

  /* HOW MUCH OF THE HAND THE REST OF THE SET FEELS.

     Grab a key and the hand pushes ONE body of about three, which
     then has to tow the other twenty-three through contacts and
     joints. Every link is a step of lag, and the whole bunch feels
     heavier than the tally even though it weighs a good deal less --
     the tally is one rigid body, so the hand moves all of it at once.

     Asking every part for the hand's velocity at FULL strength cures
     that and kills the thing: move them all together and there is no
     relative motion left, so the set goes rigid in the hand. A share
     does not: at a half the parts still swing, knock together and are
     helped along rather than driven.

     BUT NOT UPWARDS. Driving the velocity toward the hand's takes the
     FALL away too -- gravity adds downward speed each step and the
     follow removes its share of that same step, so the keys never
     gather any and the whole set reads as weightless. Gravity acts
     vertically and the lag that feels like weight is sideways, so the
     two are simply separated. Vertical lag is what HANGING looks
     like, and costs nothing to keep. */
  keysFollow: 0.45,
  keysFollowUp: 0.1,

  /* AND IT CHASES A SMOOTHED HAND, NOT THE HAND ITSELF. Chasing the
     instantaneous velocity drags the dangling parts along the moment
     the set is swung -- and the lag it takes away IS the inertia,
     which is the whole of what makes a swung bunch of keys look like
     one.

     Carrying and swinging differ in time, not in direction: carrying
     is a velocity held for a while, a swing is a reversal. So the
     target is averaged over this many seconds. Sustained motion gets
     through and the set keeps up; a swing averages to nearly nothing
     and the keys are left to trail. Longer means livelier and
     heavier, shorter means tighter and deader. */
  keysFollowLag: 0.22,

  /* HOW MUCH OF THE SET'S WEIGHT THE HELD PART MAY PULL AGAINST.

     gripStrength caps the hand at ten times the HELD body's weight,
     which is right for a block: nothing else hangs off it. A key
     weighs about three and has to drag twenty more behind it, so the
     cap bound long before the spring did and the key trailed the
     pointer -- less responsive than everything else in the room,
     while feeling fine once it was moving.

     The whole set's weight was tried here once and was too much: it
     let a fast pull throw one key harder than the ring could follow,
     which showed as the set coming apart on a quick drag. A share
     lifts the cap without that. */
  keysCarry: 0.6,

  /* THE KEYS' OWN RATTLE, five this time, on the same terms as the
     lockbox's: one picked at random, never the same twice running,
     pitch wobbled either way, and fired on a REVERSAL of the hand
     rather than on speed -- carrying a bunch smoothly is quiet, and
     what makes keys jingle is changing direction.

     Set off more easily than the box, because they are not shut in
     anything: a real bunch answers the smallest flick. */
  keysRattleSounds: ["sounds/keys-rattle-1.mp3", "sounds/keys-rattle-2.mp3",
                     "sounds/keys-rattle-3.mp3", "sounds/keys-rattle-4.mp3",
                     "sounds/keys-rattle-5.mp3"],
  keysRattleVolume: 0.7,
  keysRattleDetune: 0.09,
  keysRattleMinCmS: 0.6,  /* against the box's 5: a bunch of keys is
                             not shut inside anything and answers the
                             smallest flick */
  keysRattleFullCmS: 22,  /* and reaches full tilt sooner, so an
                             ordinary carry is audible rather than
                             only a proper shake */
  keysRattleGapMs: 40,    /* close enough together to run into each
                             other, which is what a jingle is */

  /* A JOLT, as well as a reversal: how much the hand's speed may
     change in one frame before it counts.

     A reversal alone is too narrow. Starting, stopping, a small
     jostle, a change of pace mid-drag -- none of those turn the hand
     around, so none of them could make a sound however low the
     threshold went, and the set stayed silent through exactly the
     small movements that ring a real bunch. */
  keysRattleJoltCmS: 1.6,
  keysRattleOnStart: true,  /* see lockRattleOnStart */

  keysMass: 26,         /* the whole set, shared out by size */

  /* NO PART MAY BE MUCH LIGHTER THAN THE REST, as a share of an even
     split. Shared out by bounding box alone the clasp came to 0.50
     against the fob's 4.58 and the hub's 4.22 -- a featherweight
     jointed between two heavies, which is the arrangement the solver
     buzzes on and never settles. It is also unfair to the rings,
     whose boxes are mostly air. */
  keysMinMassShare: 0.45,
  /* DAMPING, and 2.2 was far too much: it bleeds a turn away with a
     time constant under half a second, so the parts resisted moving
     relative to each other and the bunch swung like one welded lump.
     It was set that high to force the set to sleep, and it did not
     even do that -- so the sleeping is a problem to solve on its own
     terms rather than by gluing the thing still. */
  keysLinDamp: 0.15,
  keysAngDamp: 0.6,

  /* ---------------------------------------------------------------
     THE OPENING
     ---------------------------------------------------------------
     Solving it is the one moment the box has, so it is not hurried
     off the screen. The door starts opening while it is still
     forward and large, then it flies home with the door still
     swinging, and lands with it fully open and the keys spilling
     out. The door is DRAWN through all of that -- the world is held,
     so there is no physics until it is back on the floor, and the
     body is placed at whatever angle the drawing reached. */
  lockOpenHoldMs: 900,  /* how long it stays forward once solved, with
                           the door swinging and the keys coming out --
                           all of it real, none of it drawn */
  /* WHERE THE SET SITS IN THE CASE, as shares of the case's own half
     size, so it means the same at any lockCm. x is across (negative
     is the viewer's left), y is up, z is toward the front.

       __drift.objects3d.lock.where(-0.3, 0.1, 0.6)

     The DRAWING in the box and the REAL keys that replace it both
     start here, so moving one moves the other. */
  lockKeysAt: [0, -0.5, 0],

  /* HOW BIG THE SET IS DRAWN IN THE BOX, against its real size.

     THIS IS A LIE AND IT SHOWS AT THE HANDOVER. The drawing becomes a
     real object the moment the box lands, and that object is keysCm
     like every other keyset -- so anything but 1 here means the keys
     change size as they leave. Under a fast pop it is easy to miss,
     and the alternative is to make the real set smaller everywhere
     with keysCm, which changes how it behaves on the floor too. */
  lockKeysScale: 0.75,

  /* HOW THEY LIE IN THE BOX, degrees about the case's own axes. The
     set is 8 cm along its longest side and the case is barely 6
     across, so they cannot lie flat in there -- turned upright they
     fit the 11 cm of its height with room over.

     The DRAWING inside the box and the REAL keys that replace it on
     landing both use this, or the handover would show them jump. */
  lockKeysLieDeg: [0, 0, -90],

  /* AND HOW THE SET IS ARRANGED IN THERE. The model is exported in
     whatever attitude suits STARTING a simulation -- keys splayed,
     everything clear of everything -- and that is not how a bunch
     sits in a box.

     Nothing inside the box is simulated, though: it is a drawing
     until the moment it lands. So each part can simply be turned,
     and no second model is needed. Degrees about each part's own
     axes, added to whatever the model has; anything not named here
     is left as it was exported.

     Pose it by eye and keep the numbers:
       __drift.objects3d.lock.pose("key_1", 0, 0, -20)
       __drift.objects3d.lock.pose()        prints this table back */
  lockKeysPose: {
    key_0: [0, 90, -20],
    key_1: [120, 90, -160],
    key_2: [0, 0, 55],
    key_3: [120, 90, 160],
    ring_1: [0, 0, 0],
    clasp: [0, 0, 0],
    fob: [120, 90, 160]
  },

  /* WHERE EACH ONE SITS ALONG THE RING, in degrees round it. Every
     part hangs off ring_0 and the ring is centred on its own origin,
     so travelling round the wire is one turn about the ring's axis --
     carrying the part's position AND its facing with it, which is
     what keeps a key pointing outward as it moves.

       __drift.objects3d.lock.slide("key_2", 40)

     The axis is taken from ring_0's own geometry, not assumed. */
  lockKeysSlide: {
    key_0: 140, key_1: 110, key_2: 160, key_3: 0,
    ring_1: 0, clasp: 0, fob: 0
  },

  /* THE LEAN. Standing dead upright, the door is nearly balanced on
     its own hinge and falls open slowly and weakly. Tipping the case
     toward the viewer swings the door's weight out over the pivot:
     the panel is tall, so ten degrees turns a good part of its
     HEIGHT into horizontal offset and about doubles the torque --
     0.75 cm of lever becomes about 1.3.

     It is a turn about the HINGE'S OWN AXIS, which is the only axis
     that can help, so it is one rotation and not a second idea.
     Negative leans it away, which slows the door instead. */
  lockOpenTiltDeg: 10,

  /* HOW THEY COME OUT. Given a velocity, NOT born overlapping the
     case and left to be pushed apart: an overlap's impulse depends on
     how deep it happened to be on that frame, so the same spawn is a
     nudge once and a launch the next time. This project has already
     had a connector born inside a speaker fire it across the room.

     The case takes the EQUAL AND OPPOSITE impulse, at the mouth, so
     the box kicks back and turns a little as they leave -- which is
     what really happens when something springs out of a box, and is
     why the movement does not have to be invented.

     cm per second. Forward is out of the mouth in the box's own
     frame; up is up in the room, so they always arc whichever way
     the box is lying. */
  lockKeysOutCmS: 21,
  lockKeysUpCmS: 15,
  lockKeysSpin: 7,      /* radians/s of tumble as they go */

  /* THE RECOIL, on its own. It was worked out FROM the keys' velocity
     before, which made these two dials fight: slowing the keys down
     quietly halved the box's kick as well. Now it is an impulse in
     its own right -- the keys' mass times this, opposite the way they
     went -- so the two can be tuned one at a time.

     Honest momentum would be lockKeysOutCmS itself, and that is very
     nearly invisible: the case is a good deal heavier than the keys,
     so conserving it moves the box about a millimetre. This is a lie
     by a wide margin, and the lie is the point -- the box should be
     seen to jump. */
  lockRecoilCmS: 620,

  /* WHILE IT IS FORWARD, THE ROOM IS NOT TOUCHING IT. In the fiction
     the box is out of the room and in the visitor's hands, but its
     body is still standing on the floor where it was left -- so the
     floor stopped the door halfway, and anything that happened to be
     lying next to it stopped it sooner, invisibly, since none of that
     is drawn where the box appears to be.

     So for as long as it is held: the door's colliders are sensors,
     which lets it swing the full 120 against nothing; and the case is
     locked where it stands, so nothing can shove or tip it while it
     is being drawn somewhere else.

     THEY ARE PUT BACK AT DIFFERENT MOMENTS, and that is the whole
     trick. The DOOR is handed to the room when the flight home
     BEGINS, so it spends those four hundred milliseconds settling
     onto the floor from 120 to about 90 -- read as a door coming to
     rest. Handing it back on landing instead means resolving three
     and a half centimetres of floor in a single frame, and the
     solver's answer to that is to throw the box. The CASE stays
     locked until it lands, so the settling door cannot drag it. */
  lockFreeWhileOpen: true
};

/* Primitive stand-ins, in cm, full extents. `planar` bodies only
   turn in the plane of the screen, so their face stays toward the
   visitor. */
const SPECIAL = {
  tally:   { size: [4, 5.45, 5], planar: false },  /* only if the model fails */
  speaker: { size: [6, 9, 5], planar: false },
  keys:    { size: [7, 3.5, 1], planar: true },
  connector: { size: [1.9, 5.4, 1.9], planar: false },
  lockbox: { size: [6.15, 11, 3.14], planar: false }  /* the model's own proportions */
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
let model = null, speakerModel = null, connectorModel = null, lockModel = null,
    keysModel = null;
let speakerK = 0;                 /* cm per model unit, from the speaker */   /* the loaded glTF, or null → primitive */
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
  const [, gltf, spk, con, lck, kys] = await Promise.all([
    RAPIER.init(),
    loader.loadAsync(C.modelURL).catch((err) => {
      console.warn("drift-3d: tally model not loaded, using a stand-in", err);
      return null;
    }),
    loader.loadAsync(C.speakerURL).catch((err) => {
      console.warn("drift-3d: speaker model not loaded, using a stand-in", err);
      return null;
    }),
    loader.loadAsync(C.connectorURL).catch(() => null),  /* optional: quiet */
    loader.loadAsync(C.lockURL).catch((err) => {
      console.warn("drift-3d: lockbox model not loaded, using a stand-in", err);
      return null;
    }),
    loader.loadAsync(C.keysURL).catch((err) => {
      console.warn("drift-3d: keys model not loaded, using a stand-in", err);
      return null;
    })
  ]);
  model = gltf;
  speakerModel = spk;
  connectorModel = con;
  lockModel = lck;
  keysModel = kys;


  canvas = document.createElement("canvas");
  canvas.id = "drift-3d-canvas";   /* so the focus blur can skip it */
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
  window.addEventListener("pagehide", () => {
    /* THE SOUND LEAVES WITH THIS PAGE; THE PICTURE ARRIVES WITH THE NEXT.
       Audio cannot cross a page load -- the new document gets a fresh
       context, suspended until it is touched -- so the pop has to sound
       here. But popping here as well put a connector that had visibly
       jumped clear of the speaker into the photograph the next page
       opens on, and then a second, different connector once that page
       came to life. So the record says "plugged in, but pop on
       arrival", the snapshot is taken with it still seated, and the new
       page seats it and then throws it out where it can be watched. */
    const co = plugFor();
    if (co) {
      const rec = recordFor(co.id);
      if (rec) rec.popOnArrival = true;
      playPlugSound("out");
      stopSpeaker();
    }
    /* THE BOX GOES BACK DOWN BEFORE ANYTHING IS WRITTEN OR
       PHOTOGRAPHED. Every click is swallowed while a box is forward,
       so a link click never gets as far as drift.js and onChange
       never runs -- the departures that DO happen in that state are
       back, forward, reload and the address bar, and they all arrive
       here. Left alone, the photograph would catch the box in the air
       at several times its size while the next page rebuilt it on the
       floor from its body. */
    if (focus.o) dropFocus();
    finishPress();
    savePoses();
    snapshot();
  });
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
  loadPlugSound();
  loadLockSounds();
  warmCable();
  drift.objects3d = { objects, world, scene, C, PXCM, snapshot, env, sound,
                      get cable() { return cable; },
                      plugReport, lock: lockDebug, keys: keysDebug,
                      colliders: showColliders };
}

function injectStyle() {
  const style = document.createElement("style");
  style.textContent =
    "html.drift-3d-hover,html.drift-3d-hover *{cursor:grab!important}" +
    "html.drift-3d-grabbing,html.drift-3d-grabbing *{cursor:grabbing!important;" +
    "-webkit-user-select:none!important;user-select:none!important}" +
    /* FOCUS. The page blurs and stops scrolling, exactly as the
       site's own lightbox does -- but this is drift's class, not
       page.js's, so the two never collide and style.css is not
       touched. The canvas is skipped by id: everything else in the
       room is veiled inside the scene, and the box must stay sharp.
       Outside body (mirrored-page) the canvas is not a child of body
       at all, so this selector misses it there too. */
    "html.drift-focus{overflow:hidden}" +
    "html.drift-focus body>*:not(#drift-3d-canvas){filter:blur(6px)}";
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
  /* THE BOX GOES BACK DOWN ON A RESIZE. It is held in the middle of
     the window at a scale worked out from the window's height, and
     the walls move under the frozen world -- so a resize would leave
     it the wrong size in the wrong place over a picture that is no
     longer true. */
  if (focus.o) exitFocus();
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
  /* THE PAGE IS GOING AND THE BOX IS IN THE AIR. It is held in the
     middle of the window at several times its size, and that is what
     the handover photograph would catch -- while the next page
     restores it from its body, which never left the floor. Put it
     down now, with no flight: there is no time for one. */
  if (focus.o) dropFocus();
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
    const o = rec.kind === "tally" ? buildTally(rec, dropping)
            : rec.kind === "lockbox" ? buildLockbox(rec, dropping)
            : rec.kind === "keys" ? buildKeys(rec, dropping)
            : build(rec, dropping);
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
  /* NEITHER THE VEIL NOR THE BOX IN FRONT OF IT CASTS ONE. The veil
     is screen-sized, so its silhouette would black out the floor;
     the box is held in the air at four times its size and would drag
     a shadow across the room with it. */
  const unlit = focusMeshes();
  unlit.forEach((m) => { m.visible = false; });
  scene.overrideMaterial = s.silhouette;
  const env = scene.environment;
  scene.environment = null;
  renderer.setRenderTarget(s.a);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, s.cam);
  scene.environment = env;
  scene.overrideMaterial = null;
  unlit.forEach((m) => { m.visible = true; });
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
  /* A plugged connector has no parts and its mesh hangs off the
     speaker's, so neither loop above would have found it. */
  if (o.plugged && o.mesh && o.mesh.parent) o.mesh.parent.remove(o.mesh);
  if (plugging && (plugging.co === o || plugging.sp === o)) plugging = null;
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

/* The body and its collider, from a description. Shared with popPlug,
   which has to build the same body a second time when the connector
   stops being part of the speaker and becomes an object again. */
function bodyFor(shape, desc, kind) {
  const body = world.createRigidBody(desc);
  const [hx, hy, hz] = shape.half;
  world.createCollider(
    shape.collider(hx, hy, hz).setFriction(0.7).setRestitution(0.15)
      .setMass(massFor(kind === "cylinder"
        ? Math.PI * hx * hx * hy * 2          /* half extents: r, h/2, r */
        : 8 * hx * hy * hz)),
    body);
  return body;
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

  const body = bodyFor(shape, desc, rec.kind);

  /* A CONNECTOR THAT ARRIVES PLUGGED IN TOUCHES NOTHING. Its saved pose
     is the seated one, with its plug inside the speaker's collider, and
     world.step() runs before checkPlug gets the chance to seat it -- so
     the solver met a deep overlap on the very first frame and did what
     it does with two things inside each other, which was to fire the
     speaker across the room. The body exists only long enough to be
     taken away again; it has no business colliding with anything in the
     meantime. */
  if (rec.kind === "connector" && rec.plugged) {
    for (let i = 0; i < body.numColliders(); i++) body.collider(i).setSensor(true);
  }

  if (rec.rest) body.sleep();

  tag(shape.mesh, rec.id, 0);
  root.add(shape.mesh);

  const made = { id: rec.id, kind: rec.kind, parts: [{ body, mesh: shape.mesh }],
                 half: shape.half, dispose: shape.dispose, shape: shape };
  /* A speaker arrives silent, so it arrives unlit: the model's own
     emission would otherwise have it glowing from the moment it lands. */
  if (rec.kind === "speaker") setSpeakerGlow(made, 0);
  if (rec.kind === "connector") {
    sizeToConnector(shape.half[1] * 2);
    if (rec.plugged) made.wantsPlug = true;
  }
  if (rec.kind === "connector") startCable(made, rec);
  return made;
}

const box = (hx, hy, hz) => RAPIER.ColliderDesc.cuboid(hx, hy, hz);

function shapeOf(rec) {
  switch (rec.kind) {
    case "block":    return block(rec);
    case "cylinder": return cylinder(rec);
    case "tally":    return primitiveTally();
    case "speaker":  return speakerModel ? speakerShape() : speaker();
    case "keys":     return keys();
    case "connector": return connectorModel ? connectorShape() : connector();
    case "lockbox":  return lockboxStandIn();   /* the model takes buildLockbox */
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
function modelShape(gltf, heightCm, fixedK) {
  const src = gltf.scene.clone(true);
  src.updateMatrixWorld(true);
  const bb0 = new THREE.Box3().setFromObject(src);
  const size = bb0.getSize(new THREE.Vector3());
  /* fixedK: scale by a factor rather than to a height, for a model that
     has to keep its size RELATIVE to another one. See connectorShape. */
  const k = fixedK || heightCm / (size.y || 1);   /* model units -> cm */

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
/* HOW MANY CENTIMETRES ONE MODEL UNIT IS, taken from the speaker. Every
   model here is scaled to its own target height, which is right for
   things that have no relationship to each other and wrong for two that
   do: a connector sized to its own 5.4 cm beside a speaker squeezed from
   30 cm into 11 comes out nearly three times too big for it, however
   carefully they were built to scale together. */
function speakerScale() {
  if (!speakerModel) return 0;
  if (speakerK) return speakerK;
  const src = speakerModel.scene;
  src.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
  speakerK = C.speakerCm / (size.y || 1);
  return speakerK;
}

/* The speaker, plus wherever its socket is. Read once, like the
   connector's empties, and kept in the body's own frame. Without the
   empty there is a fallback at the middle of the back face, which is
   where an XLR socket lives on most cabinets -- good enough to plug
   into, and replaced the moment the model carries a real one. */
function speakerShape() {
  const shape = modelShape(speakerModel, C.speakerCm);
  shape.mesh.updateMatrixWorld(true);
  const node = shape.mesh.getObjectByName("socket");
  if (node) {
    shape.socketLocal = node.getWorldPosition(new THREE.Vector3());
    shape.socketQuat = node.getWorldQuaternion(new THREE.Quaternion());
  } else {
    console.warn('drift-3d: speaker.glb has no "socket" empty; ' +
      "guessing the middle of its back face");
    shape.socketLocal = new THREE.Vector3(0, 0, -shape.half[2]);
    shape.socketQuat = new THREE.Quaternion();
  }
  return shape;
}

function connectorShape() {
  /* Scaled by the speaker's factor when there is one, so the two keep
     whatever relative size they were modelled at. connectorCm is only
     the fallback, for a connector with no speaker to measure against. */
  const k = C.connectorMatchSpeaker ? speakerScale() : 0;
  const shape = modelShape(connectorModel, C.connectorCm, k);
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

/* -----------------------------------------------------------------
   THE KEYS
   ---------------------------------------------------------------
   Eight bodies, and the joints between them are read from the rest
   pose rather than written down: every part's origin sits where it
   hangs from the thing above it, so the origin IS the anchor on the
   child's side and the parent's side is the same point read in the
   parent's frame. The lockbox door was built the same way. No empties
   are needed and no axis is hard-coded.

   WHAT HANGS FROM WHAT:

     ring_0  the gold hub, the root
       key_0..3   revolute at each key's hole, about the ring's
                  tangent there -- a key on a ring flops like a page
       ring_1     NOT JOINTED. Threaded, and held by its collider
     ring_1
       clasp      spherical: it swivels every way
     clasp
       fob        spherical, for the same reason
   ----------------------------------------------------------------- */

function buildKeys(rec, stagger) {
  if (!keysModel) return build(rec, stagger);

  const src = keysModel.scene.clone(true);
  src.updateMatrixWorld(true);

  const names = C.keysParts;
  const found = names.map((n) => src.getObjectByName(n));
  if (!found[0]) {
    console.warn('drift-3d: keys.glb has no "' + names[0] + '"');
    return build(rec, stagger);
  }

  /* MODEL UNITS TO CENTIMETRES, off the longest side of the whole
     set, so keysCm means what it says however it is modelled. */
  const box = new THREE.Box3().setFromObject(src);
  const span = box.getSize(new THREE.Vector3());
  const k = C.keysCm / Math.max(span.x, span.y, span.z, 1e-6);
  const centre = box.getCenter(new THREE.Vector3());

  /* READ EVERYTHING BEFORE TOUCHING ANYTHING. ring_0 is the parent of
     all seven others in the file, and both of the obvious orders are
     wrong:

       build ring_0 first and its container's updateMatrixWorld
       rewrites the world matrix of every child WHILE THEY ARE STILL
       ITS CHILDREN -- so each later part is then decomposed from a
       matrix that already has the scale baked into it;

       and hullPoints() walks descendants, so the hub's collider comes
       out as the hull of the whole set while the keys still hang off
       it -- the same trap the lockbox door set, answered the same
       way.

     So: every world transform is taken first, then every node is cut
     loose, and only then is anything built. */
  const rest = names.map((name, i) => {
    const n = found[i];
    if (!n) { console.warn("drift-3d: keys.glb has no " + name); return null; }
    const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    n.matrixWorld.decompose(wp, wq, ws);
    return { name, node: n, wp, wq, ws };
  });
  for (const r of rest) if (r && r.node.parent) r.node.parent.remove(r.node);

  /* Container (physics pose, cm) > scale > the node, with the node's
     own transform flattened into the two groups. Its place in the set
     is kept as `p` and `q`: that is what the joints are read from. */
  const bits = [];
  for (const r of rest) {
    if (!r) continue;
    const n = r.node;
    const mesh = new THREE.Group();
    const scale = new THREE.Group();
    scale.scale.copy(r.ws).multiplyScalar(k);
    n.position.set(0, 0, 0);
    /* THE PART'S OWN TURN GOES IN THE MESH, NOT IN THE BODY, so every
       body in the set shares the set's orientation.

       Rapier's revolute takes ONE axis and reads it as a local
       direction in BOTH bodies, which is only the same direction if
       the two agree on which way is up. The lockbox door did -- case
       and door were both square -- and it worked there. A key carries
       its own rotation from the model, so the hub's tangent meant
       something different inside each key and every one of those
       joints was fighting a twist it could never satisfy.

       Baked here, the frames agree, one axis is unambiguous, and the
       collider still matches what is drawn, because the points are
       taken after the turn. */
    n.quaternion.copy(r.wq);
    n.scale.set(1, 1, 1);
    scale.add(n);
    mesh.add(scale);
    mesh.updateMatrixWorld(true);

    /* A KEY IS TWO SHAPES, so its geometry is taken twice: the head
       without the blade, and the blade alone. Hulled together they
       would be one paddle with the hole filled in, and a filled hole
       cannot have a wire inside it. */
    /* Only a key has one. getObjectByName matches the NODE ITSELF as
       well as its children, so without this the clasp and the fob
       each found themselves and were built as keys. */
    const blade = r.name.indexOf("key_") === 0
      ? n.getObjectByName(r.name.replace("key_", "blade_")) : null;
    /* All three in the CONTAINER's frame, named, not inferred. */
    bits.push({ name: r.name, node: n, mesh, blade, q: r.wq,
                p: r.wp.clone().sub(centre).multiplyScalar(k),
                pts: pointsIn(mesh, n, null),
                head: blade ? pointsIn(mesh, n, blade) : null,
                bladePts: blade ? pointsIn(mesh, blade, null) : null });
  }

  const half = [span.x * k / 2, span.y * k / 2, span.z * k / 2];
  const fresh = !rec.pose;
  const pose = rec.pose || dropPose(half, false, stagger);
  if (fresh) {
    /* NO SPIN ON SPAWN, unlike a loose block: spin() turns one body,
       and turning the hub while seven jointed parts sit still is a
       jolt through every joint on the first step. It arrives in the
       shape it was modelled in and falls from there. */
    rec.pose = pose;
    rec.rest = false;
    rec.parts = null;
  }
  const P0 = new THREE.Vector3(pose.p[0], pose.p[1], pose.p[2]);
  const Q0 = new THREE.Quaternion(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);

  /* Mass shared out by size, so a key weighs more than the clasp and
     none of them is the featherweight in a stack of heavies. */
  const vol = bits.map((b) => {
    const bb = new THREE.Box3().setFromArray(b.pts).getSize(new THREE.Vector3());
    return Math.max(1e-4, bb.x * bb.y * bb.z);
  });
  /* Floored, then renormalised so the set still weighs keysMass. */
  const even = 1 / bits.length;
  let volAll = vol.reduce((a, v) => a + v, 0);
  for (let i = 0; i < vol.length; i++) {
    vol[i] = Math.max(vol[i] / volAll, even * C.keysMinMassShare);
  }
  volAll = vol.reduce((a, v) => a + v, 0);

  const parts = [];
  bits.forEach((b, i) => {
    const saved = rec.parts && rec.parts[i];
    let bp;
    if (saved) {
      bp = saved;
    } else {
      const p = b.p.clone().applyQuaternion(Q0).add(P0);
      bp = { p: [p.x, p.y, p.z], q: pose.q.slice() };   /* all share it */
    }
    const desc = bodyDesc(bp, false);
    desc.setLinearDamping(C.keysLinDamp);
    desc.setAngularDamping(C.keysAngDamp);
    /* Rings AND keys sweep their motion now: both are held by nothing
       but geometry, and a thin thing that tunnels comes apart for
       good rather than bouncing oddly once. */
    if (C.keysCcd) desc.setCcdEnabled(true);
    const body = world.createRigidBody(desc);

    const mass = C.keysMass * (vol[i] / volAll);
    if (b.name.indexOf("ring") === 0) ringColliders(body, b.pts, mass);
    else if (b.blade) keyColliders(body, b, mass);
    else world.createCollider(hullCollider(b.pts).setMass(mass), body);

    parts.push({ body, mesh: b.mesh, name: b.name });
  });

  const at = (name) => parts.findIndex((part) => part.name === name);
  const bitAt = (name) => bits[at(name)];
  const joints = [];
  const leashes = [];
  let rope = null;

  /* THE KEYS HAVE NO JOINTS. They hang on the ring because they are
     threaded on to it, which is the only way a thing that both turns
     AND travels can be held. All they get is a leash, so one posted
     through its own rim by a hard throw is not lost for good. */
  const hub = bitAt("ring_0"), hubPart = parts[at("ring_0")];
  const ringInfo = hub ? ringAbout(hub.pts) : null;
  const ring1Info = bitAt("ring_1") ? ringAbout(bitAt("ring_1").pts) : null;
  for (const name of names) {
    if (name.indexOf("key_") !== 0) continue;
    const b = bitAt(name), part = parts[at(name)];
    if (!b || !part || !hubPart || !ringInfo) continue;
    /* The narrowest point of this key's own hole, less the wire, is
       how far its centre may stray from the wire before it is caught.
       A key whose hole was never measured gets the ring's own wire as
       a floor, so it is held rather than free. */
    const rim = (b.built && b.built.rim && b.built.rim[0]) || ringInfo.wire * 2;
    const wire = ringInfo.wire * C.keysWireShrink;
    leashes.push({ kind: "wire",
                   ring: hubPart.body, key: part.body,
                   normal: ringInfo.normal.clone(), radius: ringInfo.radius,
                   play: Math.max(0.01, (rim - wire) * C.keysWirePlay) });
  }

  /* THE CLASP AND THE FOB swivel every way, so both are balls. */
  joints.push(ballJoint(parts[at("ring_1")], parts[at("clasp")], bitAt("ring_1"), bitAt("clasp")));
  joints.push(ballJoint(parts[at("clasp")], parts[at("fob")], bitAt("clasp"), bitAt("fob")));

  /* AND A LEASH BETWEEN THE RINGS. Nothing holds them together but
     being threaded, which is right -- but if a bad frame ever does
     squeeze them apart the set falls in half with no way back. A rope
     at a little over the two radii never binds while they behave and
     catches that one case. */
  const r0 = parts[at("ring_0")], r1 = parts[at("ring_1")];
  if (r0 && r1 && ringInfo) {
    rope = (ringInfo.radius + (ring1Info ? ring1Info.radius : 0)) * C.keysRopeSlack;
    if (C.keysRingJoint) {
      /* At the crossing: halfway along the line between the centres,
         which for two rings of a size is where their wires meet. */
      const hub0 = bitAt("ring_0"), hub1 = bitAt("ring_1");
      const mid = hub1.p.clone().sub(hub0.p).multiplyScalar(0.5);
      const j = world.createImpulseJoint(
        RAPIER.JointData.spherical({ x: mid.x, y: mid.y, z: mid.z },
                                   { x: -mid.x, y: -mid.y, z: -mid.z }),
        r0.body, r1.body, true);
      j.setContactsEnabled(false);
      joints.push(j);
    } else {
      leashes.push({ a: r0.body, b: r1.body, max: rope });
    }
  }

  if (rec.rest) parts.forEach((part) => part.body.sleep());
  parts.forEach((part, i) => { tag(part.mesh, rec.id, i); root.add(part.mesh); });

  return { id: rec.id, kind: "keys", parts, half, joints, leashes, rope,
           built: bits.map((b) => b.built && Object.assign({ name: b.name }, b.built)),
           rings: [ringInfo, ring1Info],
           /* NO dragMass. It let the hand tow the set by its hub; with
              the hub drag gone it only inflated the grip cap on
              whatever part is actually held, so a fast pull could
              throw one key harder than the ring could follow through
              contact -- the offset that shows on a quick drag. */
           dispose: () => {} };
}

/* WHAT THE SET ACTUALLY BUILT. The rings coming apart should be
   impossible -- the gaps between one ring's balls are meant to be far
   narrower than the other's wire is thick -- so this prints the
   numbers the build really used rather than the ones it was designed
   around.

     __drift.objects3d.keys.show()

   `gap` under `wire` means they cannot pass. `apart` against `max`
   says whether they are still threaded: at or above max they are
   hanging off the rope, already separated. */
const keysDebug = {
  o() {
    for (const o of objects.values()) if (o.kind === "keys") return o;
    return null;
  },
  /* THE RECORD REMEMBERS EVERY PART'S POSE, so a set that once came
     apart stays apart across reloads -- the saved poses are restored
     before any new code can place them threaded. This throws the
     record away and drops a fresh one. */
  respawn() {
    const state = drift.state;
    state.objects = (state.objects || []).filter((r) => r.kind !== "keys");
    drift.write(state);
    sync();
    return drift.drop ? drift.drop("keys") : "dropped the record; now drop(\"keys\")";
  },
  /* Straight to the sound, no shaking: tells a missing file apart
     from a rattle that is never triggered. */
  rattle(n) {
    const bank = sound.keysRattle || [];
    if (!bank.length) return "no keys-rattle files loaded";
    playKeysRattle(n == null ? 1 : n);
    return bank.length + " in the bank";
  },
  show() {
    const o = keysDebug.o();
    if (!o) return 'no keys -- __drift.objects3d.keys.respawn()';
    const idx = (n) => o.parts.findIndex((part) => part.name === n);
    const i0 = idx("ring_0"), i1 = idx("ring_1");
    if (i0 < 0 || i1 < 0) return "the set has no rings: " +
      o.parts.map((part) => part.name).join(",");
    const r0 = o.rings && o.rings[0], r1 = o.rings && o.rings[1];
    const a = o.parts[i0].body.translation(), b = o.parts[i1].body.translation();
    const apart = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const N = Math.max(8, C.keysRingBalls | 0);
    const gap = r0
      ? (2 * Math.PI * r0.radius) / N - 2 * r0.wire * C.keysWireShrink : null;
    return {
      parts: o.parts.map((part) =>
        part.name + " " + part.body.mass().toFixed(2)).join(", "),
      ring0: r0 ? "R " + r0.radius.toFixed(3) + "  wire " + r0.wire.toFixed(3) : "?",
      ring1: r1 ? "R " + r1.radius.toFixed(3) + "  wire " + r1.wire.toFixed(3) : "?",
      balls: N,
      gap: gap == null ? "?" : gap.toFixed(3) + " cm between balls",
      wire: r1 ? (2 * r1.wire * C.keysWireShrink).toFixed(3) + " cm thick to the solver" : "?",
      passes: gap != null && r1
        ? (gap > 2 * r1.wire * C.keysWireShrink ? "YES -- they can come apart" : "no") : "?",
      /* WHERE EACH KEY IS RELATIVE TO THE WIRE. A key threaded on the
         ring has its hole centre sitting ON the wire, so this is near
         zero; a key that has come off reads the distance it has
         strayed. This is the number that says whether the threading
         is doing anything at all. */
      keys: o.parts.filter((part) => part.name.indexOf("key_") === 0)
        .map((part) => {
          const kp = part.body.translation();
          const dx = kp.x - a.x, dy = kp.y - a.y, dz = kp.z - a.z;
          const off = Math.abs(Math.hypot(dx, dy, dz) - (r0 ? r0.radius : 0));
          return part.name + " " + off.toFixed(2) + "cm off wire, " +
                 part.body.numColliders() + " colliders";
        }).join("; "),
      holes: (o.built || []).map((b2) =>
        b2 && b2.axis ? b2.name + " plane " + b2.axis + " rim " +
          b2.rim[0].toFixed(3) + ".." + b2.rim[b2.rim.length - 1].toFixed(3) +
          " in " + b2.wedges + " wedges" : "-").join("; "),
      apart: apart.toFixed(3) + " cm",
      max: r0 && r1 ? (r0.radius + r1.radius).toFixed(3) + " cm" : "?",
      rope: o.rope == null ? "none" : o.rope.toFixed(3) + " cm",
      ccd: o.parts[i0].body.isCcdEnabled() + "/" + o.parts[i1].body.isCcdEnabled(),
      asleep: o.parts.every((part) => part.body.isSleeping())
    };
  }
};

/* A ring, measured from its own points: which way it faces, how big
   it is, and how thick its wire is. Its normal is its thinnest
   direction -- it is a disc with a hole. */
function ringAbout(pts) {
  const bb = new THREE.Box3().setFromArray(pts);
  const s = bb.getSize(new THREE.Vector3());
  const n = s.x <= s.y && s.x <= s.z ? 0 : (s.y <= s.z ? 1 : 2);
  const a = (n + 1) % 3, c = (n + 2) % 3;
  let lo = Infinity, hi = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const r = Math.hypot(pts[i + a], pts[i + c]);
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  const normal = new THREE.Vector3();
  normal.setComponent(n, 1);
  return { normal, axis: n, a, c, radius: (lo + hi) / 2, wire: (hi - lo) / 2 };
}

/* The loop of balls. See keysRingBalls: the gaps between them are
   what keeps the other ring from slipping through. */
/* Rapier packs both halves into one number: memberships above,
   filter below. Two colliders meet only if each is in the other's
   filter. */
function groups(member, filter) {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

const KEYS_ALL = 0xffff;

function ringColliders(body, pts, mass) {
  const r = ringAbout(pts);
  const N = Math.max(8, C.keysRingBalls | 0);
  const rad = Math.max(0.005, r.wire * C.keysWireShrink);

  /* The escape test, in the open: neighbouring balls stand
     (2 pi R / N) apart, and the other ring's wire is 2 x rad thick.
     It passes if the gap between two balls is the wider of the two,
     which is spacing < 4 x rad. */
  const spacing = (2 * Math.PI * r.radius) / N;
  if (spacing >= 4 * rad) {
    console.warn("drift-3d: the key rings can come apart -- balls " +
      spacing.toFixed(3) + " cm apart, wire " + (2 * rad).toFixed(3) +
      " cm thick. Raise keysRingBalls to at least " +
      Math.ceil((2 * Math.PI * r.radius) / (4 * rad)) +
      ", or raise keysWireShrink.");
  }

  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const at = [0, 0, 0];
    at[r.a] = Math.cos(t) * r.radius;
    at[r.c] = Math.sin(t) * r.radius;
    world.createCollider(
      RAPIER.ColliderDesc.ball(rad)
        .setTranslation(at[0], at[1], at[2])
        .setFriction(C.keysBallFriction).setRestitution(0)
        /* A ring meets everything; only the caps refuse IT. */
        .setCollisionGroups(groups(C.keysGroupRing, KEYS_ALL))
        .setMass(mass / N), body);
  }
}

/* A KEY: a loop of balls round its hole, and a hull for its blade.
   The hole is measured per sector off the head's own points, so its
   real shape is what gets built -- square, round or nicked. */
function keyColliders(body, b, mass) {
  b.built = { balls: 0 };

  /* MEASURED IN THE KEY'S OWN FRAME, NOT THE SET'S. The hole is a
     circle in the head's plane, and that plane is found from the
     thinnest side of the bounding box -- which only names a plane if
     the plane is square to the axes. It is for the rings, whose
     rotations are identity; it is not for a key, which carries its
     own turn on the ring, baked into its mesh. So the turn is undone
     before anything is measured. The POINTS FED TO THE HULLS are the
     original ones, still turned: only the sorting is done straight. */
  const turn = b.q ? b.q.clone() : new THREE.Quaternion();
  const back = turn.clone().invert();
  const v3 = new THREE.Vector3();
  const flat = [];
  for (let i = 0; i < b.head.length; i += 3) {
    v3.set(b.head[i], b.head[i + 1], b.head[i + 2]).applyQuaternion(back);
    flat.push(v3.x, v3.y, v3.z);
  }

  const bb = new THREE.Box3().setFromArray(flat);
  const sz = bb.getSize(new THREE.Vector3());
  const n = sz.x <= sz.y && sz.x <= sz.z ? 0 : (sz.y <= sz.z ? 1 : 2);
  const a = (n + 1) % 3, c = (n + 2) % 3;
  const W = Math.max(6, C.keysHeadWedges | 0);
  const sector = (u, v) => {
    let k = Math.floor(((Math.atan2(v, u) + Math.PI * 2) % (Math.PI * 2)) /
                       (Math.PI * 2 / W));
    return k >= W ? W - 1 : k;
  };

  /* HOW FAR OUT THE RING OF THE HEAD REACHES. The furthest point in
     each sector, and the middle of those: a neck shows up as one or
     two sectors far beyond the rest, and the middle is not moved by
     them. */
  const far = new Array(W).fill(0);
  for (let i = 0; i < flat.length; i += 3) {
    const r = Math.hypot(flat[i + a], flat[i + c]);
    const k = sector(flat[i + a], flat[i + c]);
    if (r > far[k]) far[k] = r;
  }
  const mid = far.slice().sort((x, y) => x - y)[W >> 1] || 0;
  const cut = mid * C.keysHeadCut;

  const wedge = [];
  for (let i = 0; i < W; i++) wedge.push([]);
  const neck = [], disc = [];
  const rim = new Array(W).fill(Infinity);

  for (let i = 0; i < flat.length; i += 3) {
    const u = flat[i + a], v = flat[i + c];
    const r = Math.hypot(u, v);
    const px = b.head[i], py = b.head[i + 1], pz = b.head[i + 2];
    if (r > cut) { neck.push(px, py, pz); continue; }
    const k = sector(u, v);
    if (r < rim[k]) rim[k] = r;
    wedge[k].push(px, py, pz);
    disc.push(px, py, pz);
  }

  let made = 0;
  const share = mass / (W + 2);
  for (let i = 0; i < W; i++) {
    if (wedge[i].length < 12) continue;      /* too few points to hull */
    world.createCollider(hullCollider(wedge[i])
      .setFriction(C.keysBallFriction).setRestitution(0)
      .setCollisionGroups(groups(C.keysGroupKey, KEYS_ALL))
      .setMass(share), body);
    made += 1;
  }

  if (!made) {          /* nothing hulled: better a solid key than none */
    world.createCollider(hullCollider(b.pts).setMass(mass), body);
    b.built = { axis: "xyz".charAt(n), wedges: 0 };
    return;
  }

  /* The neck, whole. Convex, so a hull is the shape rather than an
     approximation of it. */
  if (neck.length >= 12) {
    world.createCollider(hullCollider(neck)
      .setFriction(C.keysBladeFriction)
      .setCollisionGroups(groups(C.keysGroupKey, KEYS_ALL))
      .setMass(share), body);
  }

  if (b.bladePts && b.bladePts.length >= 12) {
    world.createCollider(hullCollider(b.bladePts)
      .setFriction(C.keysBladeFriction)
      .setCollisionGroups(groups(C.keysGroupKey, KEYS_ALL))
      .setMass(share), body);
  }

  /* THE CAP: the RING of the head hulled whole, so the hole is filled
     -- the ring only, never the neck, or it would be the same
     triangular slab again. It meets other keys and the room and
     refuses the rings, which is what lets a hole the wire passes
     through still be solid to anything else. Weightless: the wedges
     already weigh the head. */
  if (disc.length >= 12) {
    world.createCollider(hullCollider(disc)
      .setFriction(C.keysBladeFriction)
      .setCollisionGroups(groups(C.keysGroupKey,
                                 C.keysGroupWorld | C.keysGroupKey))
      .setDensity(0), body);
  }

  const seen = rim.filter((r) => isFinite(r)).sort((x, y) => x - y);
  b.built = { axis: "xyz".charAt(n), wedges: made,
              rim: seen.length ? seen : [0],
              cut,
              mean: seen.length ? seen.reduce((x, y) => x + y, 0) / seen.length : 0 };
}

function ballJoint(parentPart, childPart, parentBit, childBit) {
  if (!parentPart || !childPart || !parentBit || !childBit) return null;
  const a = childBit.p.clone().sub(parentBit.p);
  const j = world.createImpulseJoint(
    RAPIER.JointData.spherical({ x: a.x, y: a.y, z: a.z }, { x: 0, y: 0, z: 0 }),
    parentPart.body, childPart.body, true);
  j.setContactsEnabled(false);
  return j;
}

/* -----------------------------------------------------------------
   THE LOCKBOX
   ---------------------------------------------------------------
   models/lockbox.glb, three deep:

     body                the case
       door              the front, hinged about its own origin
         digit_1 .. _4   the dials, so they swing with the door

   TWO BODIES, like the tally: the case and the door, joined at the
   door's own origin. Which joint depends on whether it is open, and
   that is the whole mechanism -- see C.lockDoorLimits.

   THE DIALS ARE NUMBERED FROM THE ONES: digit_1 is the 9 of 1829 and
   digit_4 the 1, so wheel index i is node i + 1. digit_0 .. digit_3
   are accepted too, in case the model is ever renumbered.

   restDigit 7 and the -36 degrees of lockDigitStep were both read off
   the model's own texture: the numerals wrap the rim once, 0 at the
   top of the image through 9, and at the front face the UV lands in
   the middle of row 7. Changing the texture changes both.
   ----------------------------------------------------------------- */

function buildLockbox(rec, stagger) {
  /* No model, no moving parts: the stand-in is one plain body and
     cannot be opened. Better a dull box than no box. */
  if (!lockModel) return build(rec, stagger);

  const src = lockModel.scene.clone(true);
  src.updateMatrixWorld(true);
  const bodyNode = src.getObjectByName("body");
  const doorNode = src.getObjectByName("door");
  if (!bodyNode) {
    console.warn('drift-3d: lockbox.glb has no "body"');
    return build(rec, stagger);
  }
  if (!doorNode) console.warn('drift-3d: lockbox.glb has no "door"');

  /* MODEL UNITS TO CENTIMETRES, from the whole model shut, so the
     case and the door are scaled by the one factor. */
  const whole = new THREE.Box3().setFromObject(src);
  const k = C.lockCm / (whole.getSize(new THREE.Vector3()).y || 1);

  /* The model's origin is at its foot. Left there, `half` below would
     measure from the foot and the box would be dropped, and clamped
     to the walls, as though it were twice its height. So the case is
     shifted onto its own middle, and the door's anchor with it. */
  const centre = whole.getCenter(new THREE.Vector3());
  const bodyInv = bodyNode.matrixWorld.clone().invert();

  /* Where the door hangs, read BEFORE it is detached. */
  let anchor = new THREE.Vector3();
  const relQ = new THREE.Quaternion();
  if (doorNode) {
    const rel = bodyInv.clone().multiply(doorNode.matrixWorld);
    const t = new THREE.Vector3();
    rel.decompose(t, relQ, new THREE.Vector3());
    anchor = t.sub(centre).multiplyScalar(k);      /* cm, the case's frame */
    bodyNode.remove(doorNode);   /* so the case's hull is the case alone */
  }

  /* THE CASE — container (physics pose, cm) > scale > model node */
  const bodyMesh = new THREE.Group();
  const bodyScale = new THREE.Group();
  bodyScale.scale.setScalar(k);
  bodyNode.position.copy(centre).multiplyScalar(-1);
  bodyNode.quaternion.identity();
  bodyScale.add(bodyNode);
  bodyMesh.add(bodyScale);
  bodyMesh.updateMatrixWorld(true);
  const bodyPts = hullPoints(bodyNode);

  const bb = new THREE.Box3().setFromArray(bodyPts);
  const half = [Math.max(-bb.min.x, bb.max.x), Math.max(-bb.min.y, bb.max.y),
                Math.max(-bb.min.z, bb.max.z)];

  const fresh = !rec.pose;
  const pose = rec.pose || dropPose(half, false, stagger);
  const desc = bodyDesc(pose, false);
  if (fresh) {
    spin(desc, false);
    rec.pose = pose;
    rec.rest = false;
    rec.ring = null;           /* the door's pose rides in rec.ring */
  }
  const body = world.createRigidBody(desc);
  const mass = massFor(8 * half[0] * half[1] * half[2]);
  world.createCollider(hullCollider(bodyPts).setMass(mass), body);

  const parts = [{ body, mesh: bodyMesh }];
  const axis = new THREE.Vector3().fromArray(C.lockHinge).normalize()
    .applyQuaternion(relQ);
  let joint = null, view = null;

  /* THE DOOR — its body's origin IS the hinge, so the joint's anchor
     on this side is zero, exactly as the tally's ring. */
  if (doorNode) {
    const doorMesh = new THREE.Group();
    const doorScale = new THREE.Group();
    doorScale.scale.setScalar(k);
    doorNode.position.set(0, 0, 0);
    doorNode.quaternion.copy(relQ);
    doorScale.add(doorNode);
    doorMesh.add(doorScale);
    doorMesh.updateMatrixWorld(true);
    const doorPts = hullPoints(doorNode);

    let dpose = rec.ring;
    if (!dpose) dpose = doorPose(pose, anchor);
    const ddesc = bodyDesc(dpose, false);
    if (fresh) {
      /* BORN MOVING WITH THE CASE. A fixed joint corrects a mismatch
         at once and hard, so a door created still beside a spinning
         case is a jolt on the first step -- the same trap the ring's
         pin sets, and the same answer: the case's own spin, carried
         out to where the door is. */
      const w0 = desc.angvel || { x: 0, y: 0, z: 0 };
      const v0 = desc.linvel || { x: 0, y: 0, z: 0 };
      const lv = new THREE.Vector3(w0.x, w0.y, w0.z).cross(anchor)
        .add(new THREE.Vector3(v0.x, v0.y, v0.z));
      ddesc.setLinvel(lv.x, lv.y, lv.z);
      ddesc.setAngvel({ x: w0.x, y: w0.y, z: w0.z });
    }
    const doorBody = world.createRigidBody(ddesc);
    world.createCollider(
      hullCollider(doorPts).setMass(mass * C.lockDoorShare), doorBody);

    joint = doorJoint(body, doorBody, anchor, axis, !!rec.open);
    parts.push({ body: doorBody, mesh: doorMesh });
    view = lockView(doorMesh);
  }

  if (rec.rest) parts.forEach((part) => part.body.sleep());
  parts.forEach((part, i) => { tag(part.mesh, rec.id, i); root.add(part.mesh); });

  /* THE DIALS START SOMEWHERE, as a real one left on a shelf does.
     Never on the answer: a box that spawns already solved is a bad
     joke, and the red letters would be pointing at nothing. */
  if (!rec.wheels) rec.wheels = rollWheels(drift.state.code);
  if (view) view.digits(rec.wheels);
  /* `turn` is the CONTINUOUS angle of each dial, in digits; `wheels`
     is what it reads, 0-9. They agree except while one is being
     turned, and after a spin turn can be any number at all -- 13 and
     3 are the same picture, a whole revolution apart. */

  /* Model resources are shared with the cached glTF, so nothing here
     is disposed: a rebuild after a reset reuses them. */
  return { id: rec.id, kind: "lockbox", parts, half, dispose: () => {},
           open: !!rec.open, wheels: rec.wheels.slice(),
           turn: rec.wheels.slice(), anchor, axis, joint, view };
}

/* Where the door's body goes, given the case's pose. */
function doorPose(pose, anchor) {
  const q = new THREE.Quaternion(...pose.q);
  const at = anchor.clone().applyQuaternion(q)
    .add(new THREE.Vector3(...pose.p));
  return { p: [at.x, at.y, at.z], q: pose.q.slice() };
}

/* SHUT IS FIXED, OPEN IS REVOLUTE. Contacts between the two are off
   either way: they interpenetrate by design, the case's hull being
   solid where the door sits inside it. */
function doorJoint(caseBody, doorBody, anchor, axis, open) {
  const a1 = { x: anchor.x, y: anchor.y, z: anchor.z };
  const a2 = { x: 0, y: 0, z: 0 };
  let j;
  if (open) {
    j = world.createImpulseJoint(
      RAPIER.JointData.revolute(a1, a2, { x: axis.x, y: axis.y, z: axis.z }),
      caseBody, doorBody, true);
    j.setLimits(C.lockDoorLimits[0], C.lockDoorLimits[1]);
  } else {
    const I = { x: 0, y: 0, z: 0, w: 1 };
    j = world.createImpulseJoint(
      RAPIER.JointData.fixed(a1, I, a2, I), caseBody, doorBody, true);
  }
  j.setContactsEnabled(false);
  return j;
}

/* Four random dials, never the code itself. wheels[0] is the ones, so
   the number as read across the box is wheels reversed. */
function rollWheels(code) {
  const reads = (w) => w[3] + "" + w[2] + w[1] + w[0];
  let w;
  do {
    w = [0, 0, 0, 0].map(() => Math.floor(Math.random() * 10));
  } while (code && reads(w) === String(code));
  return w;
}

/* THE POP. The joint is swapped, not the colliders: rebuilding a
   collider mid-flight breaks every contact it had for a frame, and
   this project has paid for that lesson once already. Where the door
   ends up is wherever physics leaves it -- there is no animation. */
function openLock(o) {
  if (!o || o.open || !o.joint || !o.parts[1]) return false;
  const a = o.axis, d = o.parts[1].body;
  world.removeImpulseJoint(o.joint, true);
  o.joint = doorJoint(o.parts[0].body, d, o.anchor, a, true);
  o.open = true;
  o.parts.forEach((part) => part.body.wakeUp());
  const K = C.lockDoorKick * d.mass();
  d.applyTorqueImpulse({ x: a.x * K, y: a.y * K, z: a.z * K }, true);
  saveLock(o);
  wake();
  return true;
}

/* WHAT WAS INSIDE. A record is written and the floor is re-synced, so
   the keys are built by the same path as everything else -- the only
   difference is that their pose is given rather than dropped from the
   ceiling, so they arrive at the box's mouth instead of falling past
   it. Once only: a box cannot be emptied twice.

   (The keys are still the primitive ring-and-two-keys. The model
   comes later.) */
function spawnKeys(o, local) {
  const state = drift.state;
  if (!state.objects) state.objects = [];
  if (state.objects.some((r) => r.kind === "keys")) return;

  const b = o.parts[0].body;
  const p = b.translation(), q = b.rotation();
  const Q = new THREE.Quaternion(q.x, q.y, q.z, q.w);
  /* At the mouth, in the BOX'S OWN frame, so it is the mouth wherever
     the box is lying: low in the case, at the front, just inside the
     lip. From there they are pushed out by the swinging door and by
     gravity -- nothing throws them. */
  const at = (local || keysAtIn(o)).clone()
    .applyQuaternion(Q).add(new THREE.Vector3(p.x, p.y, p.z));

  /* The same turn the drawing used, or they would jump at handover. */
  const lie = Q.clone().multiply(keysLieQuat());
  const id = "keys-" + Date.now().toString(36);
  state.objects.push({
    v: 2, id, kind: "keys", at: state.counter, rest: false,
    pose: { p: [at.x, at.y, at.z], q: [lie.x, lie.y, lie.z, lie.w] }
  });
  drift.write(state);
  sync();                       /* built by the ordinary path */

  const made = objects.get(id);
  if (made) ejectKeys(o, made, at, Q);
  return made || null;
}

/* THE POP. Out of the mouth and up, with the case shoved the other
   way at the point they left it -- an impulse at a point, so the box
   turns as well as jumps. */
function ejectKeys(o, keys, at, Q) {
  const k = keys.parts[0] && keys.parts[0].body;
  const b = o.parts[0].body;
  if (!k || !b) return;

  const v = new THREE.Vector3(0, 0, 1).applyQuaternion(Q)
    .multiplyScalar(C.lockKeysOutCmS)
    .add(new THREE.Vector3(0, C.lockKeysUpCmS, 0));
  k.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
  k.setAngvel({ x: (Math.random() - 0.5) * C.lockKeysSpin,
                y: (Math.random() - 0.5) * C.lockKeysSpin,
                z: (Math.random() - 0.5) * C.lockKeysSpin }, true);

  /* Opposite the way they went, at the mouth they left by -- an
     impulse at a POINT, so the box turns as well as jumps. Its size
     is its own dial: see lockRecoilCmS. */
  const back = v.clone().normalize().multiplyScalar(-k.mass() * C.lockRecoilCmS);
  b.wakeUp();
  b.applyImpulseAtPoint({ x: back.x, y: back.y, z: back.z },
                        { x: at.x, y: at.y, z: at.z }, true);
  wake();
}

/* Only ever by hand, for looking at it: nothing in the site shuts a
   box that has been opened. The door is put back where it belongs
   first -- a fixed joint created across a gap holds the gap. */
function shutLock(o) {
  if (!o || !o.open || !o.parts[1]) return false;
  world.removeImpulseJoint(o.joint, true);
  const b = o.parts[0].body, d = o.parts[1].body;
  const p = b.translation(), q = b.rotation();
  const home = doorPose({ p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] }, o.anchor);
  d.setTranslation({ x: home.p[0], y: home.p[1], z: home.p[2] }, true);
  d.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  d.setLinvel({ x: 0, y: 0, z: 0 }, true);
  d.setAngvel({ x: 0, y: 0, z: 0 }, true);
  o.joint = doorJoint(b, d, o.anchor, o.axis, false);
  o.open = false;
  saveLock(o);
  wake();
  return true;
}

/* Written at once rather than waiting for the floor to settle: a page
   can be left between the pop and the next rest. */
function saveLock(o) {
  const state = drift.state;
  const rec = (state.objects || []).find((r) => r.id === o.id);
  if (!rec) return;
  rec.open = !!o.open;
  rec.wheels = o.wheels.slice();
  drift.write(state);
}

/* The dials. Their axes come from the geometry, not from constants,
   so a re-export at a different orientation still works -- the same
   reasoning as tallyView, and the same localSize() to do it. */
function lockView(node) {
  const wheels = [0, 1, 2, 3].map((i) => {
    const n = node.getObjectByName("digit_" + (i + 1)) ||
              node.getObjectByName("digit_" + i);
    if (!n) {
      console.warn("drift-3d: lockbox.glb has no digit_" + (i + 1));
      return null;
    }
    /* The axle is the wheel's thinnest direction: it is a disc. */
    const s = localSize(n);
    const axis = s.x <= s.y && s.x <= s.z ? new THREE.Vector3(1, 0, 0)
               : s.y <= s.z ? new THREE.Vector3(0, 1, 0)
                            : new THREE.Vector3(0, 0, 1);
    return { node: n, axis, q0: n.quaternion.clone() };
  });

  const q = new THREE.Quaternion();
  return {
    /* values[i] is a CONTINUOUS turn for wheel i, counted in digits
       from the ones. Unbounded on purpose: 9 to 10 rolls forward into
       0 rather than back through 8, and a hard spin keeps spinning. */
    digits(values) {
      wheels.forEach((w, i) => {
        if (!w) return;
        q.setFromAxisAngle(w.axis, (values[i] - C.lockRestDigit) * C.lockDigitStep);
        w.node.quaternion.copy(w.q0).multiply(q);
      });
    },
    wheels
  };
}

/* -----------------------------------------------------------------
   FOCUS — the box comes forward
   ---------------------------------------------------------------
   A tap on a shut box holds the world still and brings the box to
   the middle of the window, square to the viewer and enlarged. The
   page blurs (drift's own class, not page.js's lightbox), the rest
   of the room is veiled by a white plane drawn in the scene, and the
   box is drawn in front of that plane.

   NOTHING MOVES THAT IS NOT DRAWN. The bodies are asleep and the
   world is not stepped, so the box's own body stays exactly where it
   was standing -- which is what lets it be set back down in its
   place with nothing remembered. The mesh is driven from here
   instead, and handed back to its body on the way out.

   THE CAMERA IS ORTHOGRAPHIC, so coming forward cannot make anything
   bigger. The size is a scale on the mesh, worked out from the
   window's height. On a desktop the box is already most of the
   viewport at rest, so that scale is modest; on a phone it is
   several times. Only this box is scaled: nothing else in the room
   changes size.
   ----------------------------------------------------------------- */

const focus = { o: null, going: 0, t: 0, last: 0,
                from: null, to: null, cur: null, shake: null,
                dial: null, snap: null, solving: null, live: false,
                group: null, ghost: null, home: null,
                off: new THREE.Vector3(), vel: new THREE.Vector3(),
                rot: new THREE.Vector3(), rotVel: new THREE.Vector3() };
const ZERO3 = new THREE.Vector3();
let veil = null, focusFailed = false, colliderLines = null;

/* Slow at both ends: it is a considered movement, not a snap. */
const easeInOut = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/* The middle of the WINDOW, not of the screen: the window is the
   frame the visitor is looking through. */
function windowCentre() {
  return new THREE.Vector3((VX + W / 2) / PXCM,
                           (SH - (VY + H / 2)) / PXCM, 0);
}

function makeVeil() {
  if (!veil) {
    veil = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
                                    opacity: C.lockVeilAlpha,
                                    depthWrite: false, toneMapped: false }));
    veil.visible = false;
    /* INVISIBLE IS NOT ENOUGH. Raycaster tests layers, not visible, so
       a hidden mesh is still hit -- and this one stands in front of
       the whole room, so every hit() found the veil, failed to find a
       driftId on it and returned null. Nothing on the floor could be
       picked up again until a page change rebuilt the module. */
    veil.raycast = () => {};
    root.add(veil);
  }
  /* The whole screen, with a little over: the window can sit anywhere
     on it and the veil must reach the edges either way. */
  veil.scale.set(SW / PXCM + 4, SH / PXCM + 4, 1);
  veil.position.set(SW / PXCM / 2, SH / PXCM / 2, C.lockVeilZ);
  return veil;
}

/* -----------------------------------------------------------------
   THE COLLIDERS, DRAWN
   ---------------------------------------------------------------
   __drift.objects3d.colliders(true) and they appear over the room in
   one colour; false and they go. This is RAPIER'S OWN account of the
   shapes, not a redrawing of what the build meant to make -- which is
   the whole point, because every collider bug so far has been the
   difference between those two.

   Drawn over everything, depth test off: a shape hidden inside the
   mesh it belongs to is exactly the case worth seeing.
   ----------------------------------------------------------------- */

function showColliders(on) {
  if (on === false) {
    if (colliderLines) {
      root.remove(colliderLines);
      colliderLines.geometry.dispose();
      colliderLines.material.dispose();
      colliderLines = null;
    }
    wake();
    return "off";
  }
  if (typeof world.debugRender !== "function") {
    return "this build of Rapier has no debugRender";
  }
  if (!colliderLines) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
    colliderLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: C.colliderColour, depthTest: false, transparent: true,
      opacity: 0.85, toneMapped: false }));
    colliderLines.renderOrder = 999;
    colliderLines.frustumCulled = false;   /* it moves; never cull it */
    colliderLines.raycast = () => {};      /* and never let it be picked */
    root.add(colliderLines);
  }
  wake();
  return "on";
}

function stepColliderLines() {
  if (!colliderLines) return;
  const buf = world.debugRender();
  const g = colliderLines.geometry;
  const have = g.attributes.position;
  if (!have || have.array.length !== buf.vertices.length) {
    g.setAttribute("position", new THREE.BufferAttribute(buf.vertices, 3));
  } else {
    have.array.set(buf.vertices);
    have.needsUpdate = true;
  }
  g.setDrawRange(0, buf.vertices.length / 3);
  g.computeBoundingSphere();
}

/* What the shadow pass must not see. */
function focusMeshes() {
  const out = [];
  if (colliderLines) out.push(colliderLines);   /* or the room goes black */
  if (veil && veil.visible) out.push(veil);
  if (focus.o) focus.o.parts.forEach((part) => out.push(part.mesh));
  return out;
}

function enterFocus(o) {
  if (focus.o || !o || o.kind !== "lockbox" || o.open) return false;
  makeVeil().visible = true;

  const b = o.parts[0].body;
  const p = b.translation(), q = b.rotation();
  focus.o = o;
  focus.going = 1;
  focus.t = 0;
  focus.last = performance.now();
  focus.shake = null;
  focus.dial = null;
  focus.snap = null;
  focus.solving = null;
  focus.live = false;
  focus.group = [o];
  focus.ghost = null;
  focus.home = null;
  focus.off.set(0, 0, 0);
  focus.vel.set(0, 0, 0);
  focus.rot.set(0, 0, 0);
  focus.rotVel.set(0, 0, 0);
  focus.from = { p: new THREE.Vector3(p.x, p.y, p.z),
                 q: new THREE.Quaternion(q.x, q.y, q.z, q.w), s: 1 };
  /* WHERE IT REALLY WAS. Solving stands the case up so that gravity
     agrees with the drawing, which overwrites the only record of how
     it had been lying -- and then it landed standing, in more or less
     the focus attitude, instead of going back where it came from.
     Kept here, and flown back to, so an opened box returns exactly as
     an unopened one does. */
  focus.home = { p: focus.from.p.clone(), q: focus.from.q.clone() };
  const s = (H * C.lockFocusFit) / (C.lockCm * PXCM);
  /* Far enough forward that turning it cannot push a corner through
     the veil: half its height and half its depth make the radius it
     sweeps about its own middle. */
  const swept = Math.hypot(o.half[1], o.half[2]) * s;
  focus.to = { p: windowCentre().setZ(C.lockVeilZ + swept + C.lockFocusGapCm),
               q: new THREE.Quaternion(), s };
  focus.cur = { p: focus.from.p.clone(), q: focus.from.q.clone(), s: 1 };

  /* NOTHING TOUCHES THEIR SLEEP. The world is not stepped while the
     box is forward, which is all the holding still that is needed --
     and a body put to sleep by hand does not wake on its own, so a
     box tapped while it was moving stayed frozen where it was for
     good. That rule is in the notes for a reason and this broke it. */
  o.parts.forEach((part) => part.body.wakeUp());
  document.documentElement.classList.add("drift-focus");
  document.documentElement.classList.remove("drift-3d-hover");
  wake();
  return true;
}

/* Back to wherever the body has been waiting. Nothing has moved, so
   there is no saved pose to restore -- the body itself is the record.
   Leaving mid-flight is fine: it turns round from where it is. */
function exitFocus() {
  if (!focus.o || focus.going < 0) return false;
  /* HOME IS WHERE IT WAS PICKED UP FROM, not where its body is now.
     The two are the same unless it was solved, which stands the case
     up -- and an opened box must come back exactly as an unopened one
     does: same place, same attitude, only with its door open and its
     keys out. */
  const b = focus.o.parts[0].body;
  const p = b.translation(), q = b.rotation();
  const home = focus.home ||
    { p: new THREE.Vector3(p.x, p.y, p.z),
      q: new THREE.Quaternion(q.x, q.y, q.z, q.w) };
  focus.from = { p: focus.cur.p.clone(), q: focus.cur.q.clone(), s: focus.cur.s };
  focus.to = { p: home.p.clone(), q: home.q.clone(), s: 1 };
  /* THE DOOR STAYS OUT OF THE ROOM UNTIL IT LANDS. It cannot settle
     during the flight any more: what stops it depends on how the case
     is lying, and the case is not put back in its real attitude until
     the flight ends. So the overlap is resolved on landing, in one
     frame, which is a real cost -- if it hops, lockDoorLimits coming
     down is the answer. */
  focus.going = -1;
  focus.t = 0;
  focus.shake = null;
  document.documentElement.classList.remove("drift-focus");
  wake();
  return true;
}

/* Straight down, no flight: the page is leaving. Everything the exit
   tween would have done, done at once. */
function dropFocus() {
  const o = focus.o;
  if (!o) return;
  o.parts.forEach((part) => {
    part.mesh.scale.setScalar(1);
    part.body.wakeUp();
  });
  (focus.group || [o]).forEach((g) => g.parts.forEach((part) => {
    part.mesh.scale.setScalar(1);
    part.body.wakeUp();
  }));
  if (focus.live) {
    sendHome(o, focus.home);     /* same order as the landing: unlocked */
    freeDoor(o, false);
    holdCase(o, false);
  }
  dropKeysGhost(o, true);        /* the page is going: make them real now */
  focus.home = null;
  focus.o = null; focus.cur = null; focus.going = 0; focus.group = null;
  focus.dial = null; focus.snap = null; focus.shake = null;
  focus.solving = null; focus.live = false;
  focus.off.set(0, 0, 0); focus.vel.set(0, 0, 0);
  focus.rot.set(0, 0, 0); focus.rotVel.set(0, 0, 0);
  if (veil) veil.visible = false;
  document.documentElement.classList.remove("drift-focus");
  wake();
}

function stepFocus(now) {
  if (!focus.o) return;
  const dt = Math.min(0.05, Math.max(0, (now - focus.last) / 1000));
  focus.last = now;

  focus.t = Math.min(1, focus.t + (dt * 1000) / Math.max(1, C.lockFocusMs));
  const e = easeInOut(focus.t);
  focus.cur.p.lerpVectors(focus.from.p, focus.to.p, e);
  focus.cur.q.copy(focus.from.q).slerp(focus.to.q, e);
  focus.cur.s = focus.from.s + (focus.to.s - focus.from.s) * e;

  /* THE SHAKE. A spring chasing where the hand has pulled it, and
     chasing zero once the hand lets go. Drawn only: the world is
     held, so there is nothing here that could disturb it. */
  const want = focus.shake ? focus.shake.want : ZERO3;
  const k = C.lockShakeSpring, c = C.lockShakeDamp;
  focus.vel.x += ((want.x - focus.off.x) * k - focus.vel.x * c) * dt;
  focus.vel.y += ((want.y - focus.off.y) * k - focus.vel.y * c) * dt;
  focus.off.addScaledVector(focus.vel, dt);

  /* The same spring again, on the turn. Held as a rotation VECTOR --
     axis times angle -- because that adds and springs like a
     position; quaternions do not. */
  const spin = focus.shake ? focus.shake.spin : ZERO3;
  focus.rotVel.x += ((spin.x - focus.rot.x) * k - focus.rotVel.x * c) * dt;
  focus.rotVel.y += ((spin.y - focus.rot.y) * k - focus.rotVel.y * c) * dt;
  focus.rotVel.z += ((spin.z - focus.rot.z) * k - focus.rotVel.z * c) * dt;
  focus.rot.addScaledVector(focus.rotVel, dt);

  stepSnap(dt);

  /* SOLVED: held forward a moment longer while the door swings and
     the keys come out for real, then it goes home. Nothing is drawn
     by hand here -- this is only the clock. */
  if (focus.solving) {
    focus.solving.t += (dt * 1000) / Math.max(1, C.lockOpenHoldMs);
    if (focus.solving.t >= 1) {
      focus.solving = null;
      exitFocus();
    }
  }

  drawFocus(focus.o, focus.cur, focus.off);

  if (focus.t >= 1 && focus.going < 0) {
    const done = focus.o;
    focus.group.forEach((g) => g.parts.forEach((part) => {
      part.mesh.scale.setScalar(1);
      part.body.wakeUp();
    }));
    focus.group = null;
    /* IN THIS ORDER. The case is put back, then handed to the room,
       and only then do the keys become real and shove it. A locked
       body ignores impulses outright, so ejecting while it was still
       held made the recoil do nothing at all -- no matter what
       lockRecoilCmS said. */
    if (focus.live) {
      sendHome(done, focus.home);
      freeDoor(done, false);
      holdCase(done, false);
    }
    dropKeysGhost(done, true);     /* they exist, where they were drawn */
    focus.live = false;
    focus.home = null;
    done.parts.forEach((part) => {
      part.mesh.scale.setScalar(1);
      part.body.wakeUp();          /* whatever it was doing, it resumes */
    });
    focus.o = null;
    focus.cur = null;
    focus.going = 0;
    if (veil) veil.visible = false;
    wake();
  }
}

/* The case and its door move as one rigid thing here: focus is only
   ever entered shut, so the door's place on the case is fixed, and
   its offset is scaled along with everything else. */
/* THE LENS. The case is drawn wherever the flight has put it; every
   other part in the group is drawn at its own pose RELATIVE TO THE
   CASE BODY, carried through the same move, turn and scale.

   That one rule covers all of it. Shut and held, the door's relative
   pose is the shut one and nothing appears to happen. Solved and
   live, the door swings and the keys fall out under real physics and
   the lens simply shows them bigger and in the middle of the window.
   There is no animation anywhere in here to disagree with the
   simulation, because there is no animation. */
function drawFocus(o, cur, off) {
  const P = cur.p.clone().add(off);

  /* The shake's turn, on top of wherever the flight has it. */
  const a = focus.rot.length();
  const Q = a > 1e-6
    ? new THREE.Quaternion()
        .setFromAxisAngle(focus.rot.clone().divideScalar(a), a)
        .multiply(cur.q)
    : cur.q.clone();

  const ref = o.parts[0].body;
  const rp = ref.translation(), rq = ref.rotation();
  const refP = new THREE.Vector3(rp.x, rp.y, rp.z);
  const refQi = new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w).invert();

  const caseMesh = o.parts[0].mesh;
  caseMesh.position.copy(P);
  caseMesh.quaternion.copy(Q);
  caseMesh.scale.setScalar(cur.s);

  for (const g of focus.group) {
    for (const part of g.parts) {
      if (part === o.parts[0]) continue;
      const p = part.body.translation(), q = part.body.rotation();
      const rel = new THREE.Vector3(p.x, p.y, p.z).sub(refP)
        .applyQuaternion(refQi).multiplyScalar(cur.s);
      part.mesh.position.copy(P).add(rel.applyQuaternion(Q));
      part.mesh.quaternion.copy(Q).multiply(
        refQi.clone().multiply(new THREE.Quaternion(q.x, q.y, q.z, q.w)));
      part.mesh.scale.setScalar(cur.s);
    }
  }

  const g = focus.ghost;
  if (g) {
    g.shape.mesh.position.copy(P)
      .add(g.local.clone().multiplyScalar(cur.s).applyQuaternion(Q));
    g.shape.mesh.quaternion.copy(Q).multiply(keysLieQuat());
    g.shape.mesh.scale.setScalar(cur.s);
  }
}

/* `at` is the point actually touched, in cm. Kept as a share of the
   box's drawn height so the lever means the same thing at any size:
   about +/- 0.5 at the ends, 0 through the middle. */
/* The hand's travel, bent so the dial sits in its notches. Exact at
   the detents and at the halfway points, monotonic in between, so it
   is a reshaping of the journey and never of the destination. */
function detented(x) {
  const n = Math.round(x), f = x - n;
  const p = Math.max(1, C.lockDialNotch);
  return n + Math.sign(f) * Math.pow(Math.abs(f) * 2, p) / 2;
}

/* What the dials are showing, given where they have been turned to. */
function dialsShown(o) {
  return o.turn.map(detented);
}

/* -----------------------------------------------------------------
   TURNING A DIAL
   ---------------------------------------------------------------
   Which dial was struck is answered by the mesh the ray hit: the
   model's own node names climb from the ones column, so walking up
   from the mesh to the first `digit_n` ancestor and finding it in
   the view gives the index with nothing hard-coded.
   ----------------------------------------------------------------- */

function dialIndex(o, node) {
  if (!o || !o.view || !node) return -1;
  let n = node;
  while (n) {
    for (let i = 0; i < o.view.wheels.length; i++) {
      const w = o.view.wheels[i];
      if (w && w.node === n) return i;
    }
    n = n.parent;
  }
  return -1;
}

function startDial(i, e) {
  focus.dial = { i, y0: e.clientY, from: focus.o.turn[i],
                 last: Math.round(focus.o.turn[i]), clicks: 0 };
}

function stepDial(e) {
  const d = focus.dial, o = focus.o;
  if (!d || !o) return;
  o.turn[d.i] = d.from +
    ((d.y0 - e.clientY) / Math.max(1, C.lockDialPx)) * C.lockDialDir;
  o.view.digits(dialsShown(o));

  /* A detent is passed whenever the nearest number changes. The sound
     hangs here (step 5); the count is what proves it is firing. */
  const at = Math.round(o.turn[d.i]);
  if (at !== d.last) { d.last = at; d.clicks += 1; playWheelClick(); }
}

/* Let go and it settles onto the nearest number -- from wherever it
   is, so a dial left between two does not snap through the one it
   was nearest. */
function endDial() {
  const d = focus.dial, o = focus.o;
  focus.dial = null;
  if (!d || !o) return;
  focus.snap = { i: d.i, from: o.turn[d.i], to: Math.round(o.turn[d.i]), t: 0 };
}

function stepSnap(dt) {
  const sn = focus.snap, o = focus.o;
  if (!sn || !o) return;
  sn.t = Math.min(1, sn.t + (dt * 1000) / Math.max(1, C.lockDialSnapMs));
  const e = easeInOut(sn.t);
  o.turn[sn.i] = sn.from + (sn.to - sn.from) * e;
  o.view.digits(dialsShown(o));
  if (sn.t < 1) return;

  /* SETTLED. What it reads is the turn folded into ten, so a dial
     spun four times round still reads a single digit. */
  o.wheels[sn.i] = ((sn.to % 10) + 10) % 10;
  focus.snap = null;
  saveLock(o);

  /* THE ANSWER. Checked when a dial comes to rest, never while one is
     moving: the code would otherwise be found in passing on the way
     to somewhere else. It leaves on its own and the door pops as it
     lands -- popping while it is still held forward would happen
     where the door is drawn rigid to the case and nothing would be
     seen of it. */
  if (lockSolved(o) && !focus.solving) solved(o);
}

/* THE ANSWER. Nothing from here on is animated: the joint is swapped
   for a real one, the keys are given a body, and the world starts
   stepping again while the box is still held forward. What the
   visitor sees is that same physics seen through the focus lens --
   moved, enlarged and square to them.

   IT IS STOOD UPRIGHT FIRST. Gravity acts in the body's frame, not
   in the drawing's, so a box really lying on its back would swing its
   door sideways across a screen that shows it standing. Straightening
   the body is what makes the two agree; the visible price is that a
   solved box lands upright rather than however it was lying. */
function solved(o) {
  standUp(o);
  freeDoor(o, true);
  holdCase(o, true);
  openLock(o);                  /* a real joint; gravity does the rest */
  playClip(sound.lockOpen, C.lockOpenVolume);
  makeKeysGhost(o);

  /* THE DRAWING LEANS WITH IT. The lens shows the door and the keys
     at their poses RELATIVE to the case body, so if the drawn case
     stayed square while the real one leaned, everything inside it
     would be out by the lean. Re-aimed rather than snapped: the same
     tween that brought it forward turns it those ten degrees. */
  focus.from = { p: focus.cur.p.clone(), q: focus.cur.q.clone(), s: focus.cur.s };
  focus.to = { p: focus.cur.p.clone(), q: uprightQuat(o), s: focus.cur.s };
  focus.t = 0;

  focus.live = true;
  focus.solving = { t: 0 };
  wake();
}

/* WHAT IS INSIDE, BEFORE IT IS ANYTHING. While the box is forward the
   keys are a drawing and nothing else: no body, no collider, nothing
   the solver can see. They sit still in the case's own frame and are
   carried by the lens like everything else, so the door swings past
   them and they simply wait.

   They become real when the box lands, at exactly the place the
   drawing had them -- see dropKeysGhost. Doing it the other way
   round, giving them a body up here, meant a solver working on two
   objects that are drawn several times their size in the middle of
   the window while really being somewhere else entirely, and keys
   wider than the case they are born inside. */
function makeKeysGhost(o) {
  if (focus.ghost) return;
  const shape = keysModel ? keysGhostMesh() : keys();
  shape.mesh.scale.setScalar(1);
  root.add(shape.mesh);
  focus.ghost = { shape, local: keysAtIn(o) };
}

/* The spot in the case, from shares of its half size. */
function keysAtIn(o) {
  const a = C.lockKeysAt || [0, 0, 0];
  return new THREE.Vector3(a[0] * o.half[0], a[1] * o.half[1], a[2] * o.half[2]);
}

/* THE REAL SET, DRAWN AND NOTHING ELSE. One group, no bodies, no
   joints, no threading: it is a picture of what is in the box, and
   it becomes an object only when the box lands. Scaled and centred
   the same way buildKeys does it, so the picture and the thing that
   replaces it are the same size. */
function keysGhostMesh() {
  const src = keysModel.scene.clone(true);
  poseKeys(src);
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src);
  const span = box.getSize(new THREE.Vector3());
  const k = (C.keysCm * (C.lockKeysScale || 1)) /
            Math.max(span.x, span.y, span.z, 1e-6);
  const centre = box.getCenter(new THREE.Vector3());

  const inner = new THREE.Group();
  inner.scale.setScalar(k);
  src.position.copy(centre).multiplyScalar(-1);
  inner.add(src);

  const mesh = new THREE.Group();
  mesh.add(inner);
  return { mesh, src, dispose: () => {} };
}

/* Turn each named part by the angles in lockKeysPose, on top of
   whatever the model gave it. Only ever used on the DRAWING inside
   the box, so nothing here has to agree with any collider. */
function poseKeys(src) {
  const turns = C.lockKeysPose || {};
  const slides = C.lockKeysSlide || {};

  /* The ring's axis, from the ring itself: it is a disc, so its axis
     is its thinnest direction. */
  const axis = new THREE.Vector3(0, 0, 1);
  const hub = src.getObjectByName("ring_0");
  if (hub) {
    const bb = new THREE.Box3();
    hub.traverse((m) => {
      if (m.isMesh && m.geometry) {
        m.geometry.computeBoundingBox();
        bb.union(m.geometry.boundingBox);
      }
    });
    const sz = bb.getSize(new THREE.Vector3());
    axis.set(0, 0, 0).setComponent(
      sz.x <= sz.y && sz.x <= sz.z ? 0 : (sz.y <= sz.z ? 1 : 2), 1);
  }

  const names = new Set(Object.keys(turns).concat(Object.keys(slides)));
  for (const name of names) {
    const node = src.getObjectByName(name);
    if (!node) continue;
    if (!node.userData.poseBase) {
      node.userData.poseBase = node.quaternion.clone();
      node.userData.poseBaseAt = node.position.clone();
    }

    /* ROUND THE RING FIRST, then the part's own turn on top. Doing it
       the other way would spin the key about the ring's axis where it
       stands, which is a different thing entirely. */
    const round = new THREE.Quaternion().setFromAxisAngle(
      axis, (slides[name] || 0) * DEG);
    node.position.copy(node.userData.poseBaseAt).applyQuaternion(round);

    const d = turns[name] || [0, 0, 0];
    node.quaternion.copy(node.userData.poseBase)
      .premultiply(round)
      .multiply(new THREE.Quaternion().setFromEuler(
        new THREE.Euler(d[0] * DEG, d[1] * DEG, d[2] * DEG)));
  }
}

/* The turn that lays them in the case, shared by the drawing and the
   real thing. */
function keysLieQuat() {
  const d = C.lockKeysLieDeg || [0, 0, 0];
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(d[0] * DEG, d[1] * DEG, d[2] * DEG));
}

/* `real` = the box has landed, so they stop being a drawing and
   become an object, in the world, where they were last drawn. */
function dropKeysGhost(o, real) {
  const g = focus.ghost;
  focus.ghost = null;
  if (!g) return;
  root.remove(g.shape.mesh);
  g.shape.dispose();
  if (real && o) spawnKeys(o, g.local);
}

/* Square to the room and leaning toward the viewer, in place. The
   door goes with it, hinge and all, or the joint would spend its
   first step dragging the door across the case. */
function standUp(o) {
  const b = o.parts[0].body, d = o.parts[1] && o.parts[1].body;
  const p = b.translation();
  const Q = uprightQuat(o);
  const q = { x: Q.x, y: Q.y, z: Q.z, w: Q.w };
  const still = { x: 0, y: 0, z: 0 };
  b.setRotation(q, true);
  b.setLinvel(still, true);
  b.setAngvel(still, true);
  if (!d) return;
  const at = o.anchor.clone().applyQuaternion(Q)
    .add(new THREE.Vector3(p.x, p.y, p.z));
  d.setRotation(q, true);
  d.setTranslation({ x: at.x, y: at.y, z: at.z }, true);
  d.setLinvel(still, true);
  d.setAngvel(still, true);
}

/* BACK WHERE IT WAS LYING, door and all. The case is put on the pose
   it was picked up from and the door is carried with it -- its own
   turn about the hinge is whatever it swung to, and that is kept, so
   the box arrives exactly as it left except that it is open. */
function sendHome(o, home) {
  if (!o || !home) return;
  const b = o.parts[0].body, d = o.parts[1] && o.parts[1].body;
  const was = b.rotation();
  const wasQ = new THREE.Quaternion(was.x, was.y, was.z, was.w);
  const still = { x: 0, y: 0, z: 0 };

  b.setTranslation({ x: home.p.x, y: home.p.y, z: home.p.z }, true);
  b.setRotation({ x: home.q.x, y: home.q.y, z: home.q.z, w: home.q.w }, true);
  b.setLinvel(still, true);
  b.setAngvel(still, true);
  if (!d) return;

  /* The door's turn relative to the case, kept across the move. */
  const dq = d.rotation();
  const rel = wasQ.clone().invert()
    .multiply(new THREE.Quaternion(dq.x, dq.y, dq.z, dq.w));
  const now = home.q.clone().multiply(rel);
  const at = o.anchor.clone().applyQuaternion(home.q).add(home.p);
  d.setTranslation({ x: at.x, y: at.y, z: at.z }, true);
  d.setRotation({ x: now.x, y: now.y, z: now.z, w: now.w }, true);
  d.setLinvel(still, true);
  d.setAngvel(still, true);
}

/* The door, out of the room and back into it. */
function freeDoor(o, free) {
  if (!C.lockFreeWhileOpen || !o || !o.parts[1]) return;
  const d = o.parts[1].body;
  for (let i = 0; i < d.numColliders(); i++) d.collider(i).setSensor(free);
  d.wakeUp();
}

/* The case, held where it stands. Locked rather than made kinematic:
   reversible in one call, and it keeps its joint and its mass exactly
   as they were. */
function holdCase(o, held) {
  if (!C.lockFreeWhileOpen || !o) return;
  const b = o.parts[0].body;
  b.lockTranslations(held, true);
  b.lockRotations(held, true);
  if (!held) return;
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

function uprightQuat(o) {
  return new THREE.Quaternion()
    .setFromAxisAngle(o.axis, C.lockOpenTiltDeg * DEG);
}

function lockSolved(o) {
  const c = String(drift.state.code || "");
  if (c.length !== 4) return false;
  return o.wheels[3] + "" + o.wheels[2] + o.wheels[1] + o.wheels[0] === c;
}

function startShake(e, at) {
  const lever = new THREE.Vector3();
  if (at && focus.cur) {
    lever.copy(at).sub(focus.cur.p).sub(focus.off)
      .divideScalar(Math.max(1e-6, C.lockCm * focus.cur.s));
  }
  focus.shake = { x: e.clientX, y: e.clientY, lever,
                  want: new THREE.Vector3(), spin: new THREE.Vector3() };
}

function stepShake(e) {
  if (!focus.shake) return;
  const lim = C.lockShakeCm, g = C.lockShakeGain;
  const dx = (e.clientX - focus.shake.x) / PXCM;
  const dy = -(e.clientY - focus.shake.y) / PXCM;
  focus.shake.want.set(Math.max(-lim, Math.min(lim, dx * g)),
                       Math.max(-lim, Math.min(lim, dy * g)), 0);

  /* Lever x travel: where a torque points. Grab the top and pull
     sideways and it leans; pull through the middle and it slides
     without turning. */
  const spin = focus.shake.lever.clone()
    .cross(new THREE.Vector3(dx, dy, 0))
    .multiplyScalar(C.lockShakeTilt);
  const m = spin.length();
  if (m > C.lockShakeTiltMax) spin.multiplyScalar(C.lockShakeTiltMax / m);
  focus.shake.spin.copy(spin);
}

/* Stand-in, only if models/lockbox.glb fails to load: a plain block of
   the right proportions, so a missing file is a dull box rather than
   nothing at all. It has no door and cannot be opened. */
function lockboxStandIn() {
  const [sx, sy, sz] = SPECIAL.lockbox.size;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz),
                              material("#6d6f72", { roughness: 0.5, metalness: 0.6 }));
  return { mesh, half: [sx / 2, sy / 2, sz / 2], planar: false,
           collider: box, dispose: owned(mesh) };
}

/* BY HAND, from the console:

     __drift.objects3d.lock.show()        what it found, and its state
     __drift.objects3d.lock.open()        pop the door
     __drift.objects3d.lock.shut()        put it back
     __drift.objects3d.lock.digit(0, 9)   wheel 0 (the ones) to 9
     __drift.objects3d.lock.code()        set the dials to the answer

   The dials are saved from here, so what you set survives a page
   change. The door's state is saved too. */
const lockDebug = {
  o() {
    for (const o of objects.values()) if (o.kind === "lockbox") return o;
    return null;
  },
  digit(i, n) {
    const o = lockDebug.o();
    if (!o || !o.view) return 'no lockbox with dials -- __drift.drop("lockbox")';
    o.wheels[i] = n;
    o.turn[i] = n;
    o.view.digits(dialsShown(o));
    saveLock(o);
    wake();
    return o.wheels.slice();
  },
  code() {
    const o = lockDebug.o();
    if (!o || !o.view) return "no lockbox with dials";
    const c = String(drift.state.code);
    [0, 1, 2, 3].forEach((i) => { o.wheels[i] = +c.charAt(3 - i); o.turn[i] = o.wheels[i]; });
    o.view.digits(dialsShown(o));
    saveLock(o);
    wake();
    return o.wheels.slice();
  },
  /* Straight to the sound, with no shaking and no detector: tells a
     missing file apart from a rattle that is never triggered. */
  rattle(n) {
    const bank = sound.rattle || [];
    if (!bank.length) return "no lock-rattle files loaded";
    playRattle(n == null ? 1 : n);
    return bank.length + " in the bank";
  },
  /* A FRESH BOX, shut, with its record thrown away. Once one is open
     it stays open, so posing wants a new one. */
  respawn() {
    const state = drift.state;
    state.objects = (state.objects || []).filter((r) => r.kind !== "lockbox");
    drift.write(state);
    sync();
    return drift.drop ? drift.drop("lockbox") : 'now __drift.drop("lockbox")';
  },

  /* HOLD IT OPEN FOR POSING. Everything the right combination does --
     stood up, door released, keys inside -- but without the clock
     that sends it home again, so it stays forward until you click
     away. This is the only way to see the set in the box for longer
     than a second. */
  stage() {
    const o = lockDebug.o();
    if (!o) return 'no lockbox -- __drift.objects3d.lock.respawn()';
    if (o.open) return "that one is already open -- lock.respawn() first";
    if (!focus.o && !enterFocus(o)) return "could not bring it forward";

    /* STRAIGHT TO THE FRONT. Marking the flight finished is not the
       same as finishing it: focus.cur is what everything downstream
       reads, and solved() takes ITS value as the pose to lean from.
       Left on the floor at life size, that is where the box stood up
       and opened -- never coming forward at all. */
    focus.t = 1;
    focus.cur.p.copy(focus.to.p);
    focus.cur.q.copy(focus.to.q);
    focus.cur.s = focus.to.s;

    solved(o);
    focus.solving = null;     /* and never start the clock home */
    return 'posing. lock.pose("key_1", 0, 0, -20) to turn a part, ' +
           "lock.pose() to print the table, click outside to finish.";
  },

  /* HOW BIG IT IS DRAWN IN THERE, against its real size. */
  scale(n) {
    C.lockKeysScale = n == null ? 1 : n;
    const g = focus.ghost;
    if (g && g.shape && g.shape.mesh) {
      /* rebuilt rather than rescaled: the pose lives inside it */
      const o = lockDebug.o();
      root.remove(g.shape.mesh);
      g.shape.dispose();
      g.shape = keysModel ? keysGhostMesh() : keys();
      root.add(g.shape.mesh);
      if (o) g.local = keysAtIn(o);
      wake();
    }
    return C.lockKeysScale;
  },

  /* MOVE THE WHOLE SET IN THE CASE. Shares of its half size: x
     across, y up, z toward the front. */
  where(x, y, z) {
    C.lockKeysAt = [x || 0, y || 0, z || 0];
    const o = lockDebug.o();
    if (focus.ghost && o) { focus.ghost.local = keysAtIn(o); wake(); }
    return C.lockKeysAt;
  },

  /* SLIDE ONE ROUND THE RING, in degrees. */
  slide(name, deg) {
    if (!C.lockKeysSlide) C.lockKeysSlide = {};
    C.lockKeysSlide[name] = deg || 0;
    const g = focus.ghost;
    if (g && g.shape && g.shape.src) { poseKeys(g.shape.src); wake(); }
    return C.lockKeysSlide[name];
  },

  /* POSE THE SET INSIDE THE BOX, by eye, while it is on screen. With
     no arguments it prints BOTH tables to paste into C. */
  pose(name, x, y, z) {
    if (name == null) {
      const t = C.lockKeysPose || {}, u = C.lockKeysSlide || {};
      return "lockKeysPose: {\n" + Object.keys(t).map((k) =>
        "    " + k + ": [" + t[k].join(", ") + "]").join(",\n") +
        "\n  },\n  lockKeysSlide: {\n" + Object.keys(u).map((k) =>
        "    " + k + ": " + u[k]).join(",\n") + "\n  },\n" +
        "  lockKeysAt: [" + (C.lockKeysAt || []).join(", ") + "],\n" +
        "  lockKeysScale: " + (C.lockKeysScale == null ? 1 : C.lockKeysScale) + ",";
    }
    if (!C.lockKeysPose) C.lockKeysPose = {};
    C.lockKeysPose[name] = [x || 0, y || 0, z || 0];
    const g = focus.ghost;
    if (g && g.shape && g.shape.src) {
      poseKeys(g.shape.src);
      wake();
      return C.lockKeysPose[name];
    }
    return "set, but nothing is in the box to show it -- " +
           'lock.focus() then lock.code() to open one';
  },
  focus() { return enterFocus(lockDebug.o()) || "already forward, open, or no lockbox"; },
  blur() { return exitFocus() || "not forward"; },
  open() {
    const o = lockDebug.o();
    if (!openLock(o)) return "already open, or no lockbox";
    spawnKeys(o);
    return true;
  },
  shut() { return shutLock(lockDebug.o()) || "already shut, or no lockbox"; },
  show() {
    const o = lockDebug.o();
    if (!o) return "no lockbox on the floor";
    return {
      open: o.open,
      wheels: o.wheels.join(","),
      reads: o.wheels[3] + "" + o.wheels[2] + o.wheels[1] + o.wheels[0],
      code: drift.state.code,
      hinge: "axis " + o.axis.toArray().map((v) => v.toFixed(2)).join(",") +
             "  anchor " + o.anchor.toArray().map((v) => v.toFixed(2)).join(","),
      dials: o.view ? o.view.wheels.filter(Boolean).length + " of 4" : "none"
    };
  }
};

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

/* POINTS IN A NAMED FRAME, optionally skipping one subtree.

   hullPoints() takes the container to be node.parent.parent, which is
   true of a top-level part -- key, scale group, container -- and NOT
   of anything deeper. A blade is a child of its key, so its
   grandparent is the SCALE GROUP: asked for its points that way it
   returned them unscaled, about one and a half times too large and in
   the wrong place. Every key has been carrying an invisible slab
   where its blade should be. So the frame is passed in here rather
   than guessed at. */
function pointsIn(container, node, skip) {
  const inv = container.matrixWorld.clone().invert();
  const out = [];
  const v = new THREE.Vector3();
  node.traverse((m) => {
    if (!m.isMesh) return;
    if (skip) for (let a = m; a; a = a.parent) if (a === skip) return;
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

/* ONE FETCH FOR ALL THE SHORT SOUNDS. Every one of them wants the
   same thing -- get it, decode it, keep it, and if any of that fails
   say so once and stay silent -- so it is written once. A missing
   file is never an error worth stopping for: a connector that seats
   in silence is better than one that throws. */
function grabSound(path, keep) {
  if (!sound.ctx || !path) return;
  const url = new URL(path, import.meta.url).href;
  fetch(url)
    .then((r) => { if (!r.ok) throw new Error("not found (" + r.status + ")"); return r.arrayBuffer(); })
    .then((data) => new Promise((ok, fail) => sound.ctx.decodeAudioData(data, ok, fail)))
    .then(keep)
    .catch((err) => console.warn("drift-3d: " + path + " " + err.message));
}

/* AND ONE WAY TO PLAY THEM. The gate is the same everywhere: right
   after a click the context may still be resuming, so start anyway
   and it sounds the moment it is running; at any other time a
   suspended context means audio is blocked, and the clip is dropped
   rather than queued -- queued ones all burst out together at the
   first interaction. */
function playClip(buffer, volume, rate) {
  if (!buffer || !sound.ctx) return;
  const justActed = performance.now() - (sound.gestureAt || -1e9) < 1000;
  if (sound.ctx.state !== "running" &&
      !(sound.ctx.state === "suspended" && justActed)) return;
  if (sound.ctx.state === "suspended") sound.ctx.resume().catch(() => {});
  const src = sound.ctx.createBufferSource();
  src.buffer = buffer;
  if (rate) src.playbackRate.value = rate;
  if (volume != null && volume !== 1) {
    const g = sound.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(sound.gain);
  } else {
    src.connect(sound.gain);
  }
  src.start();
}

function loadPlugSound() {
  if (!sound.ctx || sound.plugAsked) return;
  sound.plugAsked = true;
  grabSound(C.plugSound, (b) => { sound.plug = b; });
  grabSound(C.plugOutSound, (b) => { sound.plugOut = b; });
}

function playPlugSound(which) {
  playClip(which === "out" ? sound.plugOut : sound.plug);
}

/* THE DIAL'S BANK. Whatever loads, in the order it arrives -- the
   bank is not indexed by anything, so a missing file just makes it
   smaller and six becomes five. */
function loadLockSounds() {
  if (!sound.ctx || sound.lockAsked) return;
  sound.lockAsked = true;
  sound.wheel = [];
  sound.wheelLast = -1;
  sound.rattle = [];
  sound.rattleLast = -1;
  sound.keysRattle = [];
  sound.keysLast = -1;
  for (const path of C.lockWheelSounds || []) {
    grabSound(path, (b) => { sound.wheel.push(b); });
  }
  for (const path of C.lockRattleSounds || []) {
    grabSound(path, (b) => { sound.rattle.push(b); });
  }
  for (const path of C.keysRattleSounds || []) {
    grabSound(path, (b) => { sound.keysRattle.push(b); });
  }
  grabSound(C.lockOpenSound, (b) => { sound.lockOpen = b; });
}

/* THE HAND'S OWN SPEED, measured once and used everywhere. It was
   read off the body when the box was carried about the room and off
   the shake spring when it was held forward, and neither answered
   the question the rattle is asking. The body lags: the drag is a
   spring, so by the time the BODY's velocity flips, most of the
   swing has already been absorbed and the box reports a mild turn
   where the hand made a hard one. The spring lags worse. What shakes
   keys is what the hand did, so that is what is measured.

   Smoothed, because pointer events arrive unevenly and a short gap
   makes a wild number: each reading is half of the new one. */
const hand = { x: 0, y: 0, t: 0, vel: new THREE.Vector3() };

function trackHand(e) {
  const now = performance.now();
  const gap = now - hand.t;
  if (gap > 0 && gap < 250) {
    hand.vel.lerp(new THREE.Vector3(((e.clientX - hand.x) / PXCM) * 1000 / Math.max(8, gap),
                                    (-(e.clientY - hand.y) / PXCM) * 1000 / Math.max(8, gap),
                                    0), 0.5);
  }
  hand.x = e.clientX; hand.y = e.clientY; hand.t = now;
}

const rattle = { prev: new THREE.Vector3(), at: 0, peak: 0 };

const lockVoice = { play: (x) => playRattle(x),
                    min: () => C.lockRattleMinCmS,
                    full: () => C.lockRattleFullCmS,
                    gap: () => C.lockRattleGapMs,
                    jolt: () => C.lockRattleJoltCmS,
                    onStart: () => C.lockRattleOnStart };
const keysVoice = { play: (x) => playKeysRattle(x),
                    min: () => C.keysRattleMinCmS,
                    full: () => C.keysRattleFullCmS,
                    gap: () => C.keysRattleGapMs,
                    jolt: () => C.keysRattleJoltCmS,
                    onStart: () => C.keysRattleOnStart };
const rattleDv = new THREE.Vector3();

/* THE LEASHES. Slack costs nothing -- inside its limit a pair is not
   touched at all. At the limit the pair is put back ON it, sharing
   the move by inverse mass so the light one goes further, and the
   part of their velocity that was carrying them apart is taken away.
   A limit, not a spring: it cannot stretch and there is no stiffness
   to get wrong. */
function stepLeashes() {
  for (const o of objects.values()) {
    if (!o.leashes) continue;
    for (const L of o.leashes) {
      if (L.kind === "wire") { stepWire(L); continue; }
      const pa = L.a.translation(), pb = L.b.translation();
      const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
      const d = Math.hypot(dx, dy, dz);
      if (d <= L.max || d < 1e-6) continue;

      const nx = dx / d, ny = dy / d, nz = dz / d;
      const over = d - L.max;
      const wa = 1 / Math.max(1e-6, L.a.mass());
      const wb = 1 / Math.max(1e-6, L.b.mass());
      const w = wa + wb;

      L.a.setTranslation({ x: pa.x + nx * over * (wa / w),
                           y: pa.y + ny * over * (wa / w),
                           z: pa.z + nz * over * (wa / w) }, true);
      L.b.setTranslation({ x: pb.x - nx * over * (wb / w),
                           y: pb.y - ny * over * (wb / w),
                           z: pb.z - nz * over * (wb / w) }, true);

      /* And take away the speed that opened the gap, or it opens
         again on the very next step and the pair buzzes on the
         limit. */
      const va = L.a.linvel(), vb = L.b.linvel();
      const sep = (vb.x - va.x) * nx + (vb.y - va.y) * ny + (vb.z - va.z) * nz;
      if (sep <= 0) continue;
      const ja = sep * (wa / w), jb = sep * (wb / w);
      L.a.setLinvel({ x: va.x + nx * ja, y: va.y + ny * ja, z: va.z + nz * ja }, true);
      L.b.setLinvel({ x: vb.x - nx * jb, y: vb.y - ny * jb, z: vb.z - nz * jb }, true);
    }
  }
}

/* THE BEAD ON ITS WIRE. The key's centre is taken into the ring's own
   frame, dropped onto the ring's plane and pushed out to the ring's
   radius -- that is the nearest point on the wire. Anything within
   `play` of it is left alone; beyond, the pair is moved until it is
   not, and the speed that was carrying them apart is cancelled.
   Nothing here stops the key travelling round the wire or turning on
   it: those are what a key on a ring does. */
const wireA = new THREE.Vector3(), wireB = new THREE.Vector3();
const wireQ = new THREE.Quaternion();

function stepWire(L) {
  const rp = L.ring.translation(), rq = L.ring.rotation();
  const kp = L.key.translation();
  wireQ.set(rq.x, rq.y, rq.z, rq.w);

  /* the key's centre, in the ring's frame */
  wireA.set(kp.x - rp.x, kp.y - rp.y, kp.z - rp.z)
    .applyQuaternion(wireQ.clone().invert());

  /* onto the ring's plane, out to its radius: the nearest wire point */
  const along = wireA.dot(L.normal);
  wireB.copy(wireA).addScaledVector(L.normal, -along);
  if (wireB.lengthSq() < 1e-10) return;        /* dead on the axis */
  wireB.setLength(L.radius);

  const off = wireA.sub(wireB);                /* wireA is now the offset */
  const d = off.length();
  if (d <= L.play || d < 1e-9) return;

  off.divideScalar(d).applyQuaternion(wireQ);  /* the way out, in the world */
  const over = d - L.play;
  const wk = 1 / Math.max(1e-6, L.key.mass());
  const wr = 1 / Math.max(1e-6, L.ring.mass());
  const w = wk + wr;

  L.key.setTranslation({ x: kp.x - off.x * over * (wk / w),
                         y: kp.y - off.y * over * (wk / w),
                         z: kp.z - off.z * over * (wk / w) }, true);
  L.ring.setTranslation({ x: rp.x + off.x * over * (wr / w),
                          y: rp.y + off.y * over * (wr / w),
                          z: rp.z + off.z * over * (wr / w) }, true);

  const vk = L.key.linvel(), vr = L.ring.linvel();
  const sep = (vk.x - vr.x) * off.x + (vk.y - vr.y) * off.y + (vk.z - vr.z) * off.z;
  if (sep <= 0) return;
  const jk = sep * (wk / w), jr = sep * (wr / w);
  L.key.setLinvel({ x: vk.x - off.x * jk, y: vk.y - off.y * jk,
                    z: vk.z - off.z * jk }, true);
  L.ring.setLinvel({ x: vr.x + off.x * jr, y: vr.y + off.y * jr,
                     z: vr.z + off.z * jr }, true);
}

function stepRattle(now) {
  /* A hand that has stopped moving is still, not still-moving: with
     no event for a moment the last reading would otherwise stand for
     ever and the next twitch would read as a reversal against it. */
  if (now - hand.t > 90) hand.vel.set(0, 0, 0);

  /* WHICH THING IS IN HAND, and so which bank, how easily it is set
     off and how loud. Everything else about it is the same: the same
     needle, the same reversal, the same peak. */
  let voice = null;
  if (focus.shake && focus.o && !focus.o.open) {
    voice = lockVoice;
  } else if (drag) {
    const o = objects.get(drag.id);
    if (o && o.kind === "lockbox" && !o.open) voice = lockVoice;
    else if (o && o.kind === "keys") voice = keysVoice;
  }
  const v = voice ? hand.vel : null;

  /* Nothing in hand: forget the heading and the peak, so picking it
     up again does not read the first frame as a reversal against a
     stale one. */
  if (!v) { rattle.prev.set(0, 0, 0); rattle.peak = 0; return; }

  const prev = rattle.prev;
  rattle.peak = Math.max(rattle.peak, v.length());

  /* TURNING ROUND or CHANGING PACE sets it off: either is a jolt to
     something hanging loose, and only the turn is a swing.

     AND, FOR THE KEYS ALONE, simply starting to move. A loose bunch
     jingles the moment it is carried off -- that is not a reversal
     and need not be a sharp change, it is the end of being still. A
     box does not announce itself when lifted, so it has this off: see
     lockRattleOnStart. */
  const dv = rattleDv.copy(v).sub(prev).length();
  const woke = voice.onStart() &&
               prev.length() < voice.min() && v.length() >= voice.min();
  const turned = prev.dot(v) < 0;
  const jolted = dv > voice.jolt();

  /* And whichever was bigger decides how loud: a hard swing is judged
     by the speed it carried, a small jostle by how suddenly it came. */
  const drive = Math.max(rattle.peak, dv);

  if ((woke || turned || jolted) && drive > voice.min() &&
      now - rattle.at > voice.gap()) {
    rattle.at = now;
    voice.play(Math.min(1, drive / Math.max(1, voice.full())));
    rattle.peak = 0;         /* the next rattle is about the next move */
  }
  prev.copy(v);
}

/* ONE PICKED AT RANDOM, NEVER THE SAME TWICE RUNNING, and the pitch
   nudged either way. Pure random repeats about one time in five, and
   a repeat is the one thing the ear catches at this rate. */
function playFromBank(bank, mark, volume, detune, strength) {
  if (!bank || !bank.length) return;
  let i = Math.floor(Math.random() * bank.length);
  if (bank.length > 1 && i === sound[mark]) i = (i + 1) % bank.length;
  sound[mark] = i;
  /* UP FROM THE RECORDING, never below it. A rate under 1 does not
     read as a different take of the same sound -- it reads as a
     slower, duller, heavier one, and a bank that wanders both ways
     sounds as though it is mostly sagging. So the recording is the
     floor and the variation is all above it. */
  playClip(bank[i], volume * strength, 1 + Math.random() * detune);
}

function playRattle(strength) {
  playFromBank(sound.rattle, "rattleLast",
               C.lockRattleVolume, C.lockRattleDetune, strength);
}

function playKeysRattle(strength) {
  playFromBank(sound.keysRattle, "keysLast",
               C.keysRattleVolume, C.keysRattleDetune, strength);
}

/* NEVER THE SAME ONE TWICE RUNNING. Pure random repeats about one
   time in six, and a repeat is the one thing the ear notices. */
function playWheelClick() {
  const bank = sound.wheel;
  if (!bank || !bank.length) return;
  let i = Math.floor(Math.random() * bank.length);
  if (bank.length > 1 && i === sound.wheelLast) i = (i + 1) % bank.length;
  sound.wheelLast = i;
  /* Upward only, for the reason in playFromBank. */
  playClip(bank[i], C.lockWheelVolume, 1 + Math.random() * C.lockWheelDetune);
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
  startSpeaker(o);
}

/* AFTER THE CLICK, NOT UNDER IT. The two played together and the music
   swallowed the sound of the plug going in, which is the one moment the
   click has to sell. Waits out the clip's own length, read from the
   decoded buffer rather than guessed at, so re-recording the sound
   shorter or longer needs no number changed here.

   Held by a timer, which means it can be overtaken: pull the plug back
   out inside that second and the music must never arrive. */
let musicTimer = 0;

function startSpeakerAfterClick(sp) {
  clearTimeout(musicTimer);
  musicTimer = 0;
  const clip = sound.plug ? sound.plug.duration * 1000 : 0;
  const wait = Math.max(0, clip + C.plugMusicGapMs);
  if (!wait) { startSpeaker(sp); return; }
  musicTimer = setTimeout(() => {
    musicTimer = 0;
    /* Still plugged into this same speaker, and it still exists. */
    const co = plugFor();
    if (co && co.speakerId === sp.id && objects.has(sp.id)) startSpeaker(sp);
  }, wait);
}

/* Start it, whatever asked. The plug asks; nothing else does yet. */
function startSpeaker(o) {
  if (!o || speaker3d.id === o.id) return;
  if (!sound.ctx) return;
  if (!C.speakerSounds.length) {
    /* Not listed yet: find them, then act on this same request. */
    findSpeakerSounds().then((found) => { if (found.length) startSpeaker(o); });
    return;
  }

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
    /* WHEN THE TRACK ENDS, THE PLUG COMES OUT. stopSpeaker clears this
       handler before stopping, so it only ever fires on a real ending --
       and plugging back in draws another track at random, so the way to
       hear a different one is to plug it in again. */
    speaker3d.src.onended = () => {
      if (!speaker3d.src) return;
      stopSpeaker();
      if (plugFor()) popPlug(true, false);
    };
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
  clearTimeout(musicTimer);       /* a track still waiting its turn is cancelled */
  musicTimer = 0;
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
  /* AIMED AT THE ROOM OR AWAY FROM IT. Eased rather than linear, so most
     of the change happens as it comes round to face you rather than
     being spread evenly over half a turn. */
  if (speaker3d.gain && speaker3d.id && o.parts.length && sound.ctx) {
    const q = o.parts[0].body.rotation();
    _face.set(C.speakerFace[0], C.speakerFace[1], C.speakerFace[2])
         .applyQuaternion(_faceQ.set(q.x, q.y, q.z, q.w));
    const t = Math.max(0, Math.min(1, (_face.z + 1) / 2));   /* 1 = facing us */
    const eased = t * t * (3 - 2 * t);
    const vol = C.speakerVolume * (C.speakerBackVol + (1 - C.speakerBackVol) * eased);
    speaker3d.gain.gain.setTargetAtTime(vol, sound.ctx.currentTime, C.speakerTurnEase);
  }

  if (speaker3d.pan && speaker3d.id && o.parts.length) {
    const p = o.parts[0].body.translation();
    const across = ((p.x * PXCM - VX) / Math.max(1, W)) * 2 - 1;
    const target = Math.max(-1, Math.min(1, across)) * C.speakerPan;
    const now = speaker3d.pan.pan;
    now.value += (target - now.value) * 0.2;      /* no clicks on a throw */
  }

  /* The model still breathes with the sound; the light does not. */
  if (!o.parts.length) return;
  const beat = 1 + C.speakerPulse * level;
  o.parts[0].mesh.scale.setScalar(beat);
  /* AND THE PLUG DOES NOT BREATHE WITH IT. A seated connector is a
     child of this mesh, so it inherited the pulse and grew and shrank
     with the cabinet -- which a plugged connector plainly does not do.
     Undone here rather than by hanging it somewhere else, because
     being a child is what makes it follow the speaker for free. */
  if (o.plug && o.plug.mesh) o.plug.mesh.scale.setScalar(1 / beat);
  setSpeakerGlow(o, speaker3d.id ? 1 : 0);
}

function setSpeakerGlow(o, lit) {
  const glow = C.speakerGlowOff + (C.speakerGlowOn - C.speakerGlowOff) * lit;
  if (!o.parts.length) return;
  o.parts[0].mesh.traverse((n) => {
    if (!n.isMesh) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) {
      if (m && m.emissive !== undefined) m.emissiveIntensity = glow;
    }
  });
}

/* EVERYTHING MEASURED AGAINST THE PLUG, worked out once the connector's
   real size is known -- which is the only moment it IS known, since it
   may come from a model, from connectorCm, or from the speaker's scale.

   These are the two that are genuinely about the connector. The rope's
   own numbers are not: cableSegCm is resolution and cost, cableOutCm is
   about the window, and cableGripCm and cableYieldCm are about how the
   floor and the cable behave rather than how thick it is. They stay put
   on purpose. If the connector's size changes a great deal, though, the
   bend limit is the one worth a second look: a thinner cable should turn
   a tighter corner than a thick one, and cableBendDeg will not have
   noticed. */
function sizeToConnector(lengthCm) {
  if (!(lengthCm > 0)) return;
  C.cableRadiusCm = lengthCm * C.cableRadiusShare;
  C.plugSnapCm = lengthCm * C.plugSnapShare;
  C.plugAssistCm = lengthCm * C.plugAssistShare;
  C.plugPullCm = lengthCm * C.plugPullShare;
  C.plugSlideCm = lengthCm * C.plugSlideShare;
  C.plugClearCm = lengthCm * C.plugClearShare;
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
  /* Pinned to the speaker means plugged in: see cableLeashPlugged. */
  const share = cb.id && objects.get(cb.id) && !objects.get(cb.id).parts.length
    ? C.cableLeashPlugged : 1;
  let dx = A.x - G.x, dy = A.y - G.y, dz = A.z - G.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const over = dist - cb.len;
  if (over <= 0 || dist < 1e-6) return;

  dx /= dist; dy /= dist; dz /= dist;
  const v = body.linvel();
  const out = -(v.x * dx + v.y * dy + v.z * dz);   /* + means pulling away */
  let a = (over * C.cableLeash + Math.max(0, out) * C.cableLeashDamp) * share;
  if (a > C.cableLeashMax * share) a = C.cableLeashMax * share;
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
   THE PLUG
   ---------------------------------------------------------------
   Bring the connector near the speaker's socket and it seats itself.

   WHY IT IS SCRIPTED. The room is 18 cm deep, seen straight on, and a
   body can only be dragged in the plane of the screen: there is no
   gesture that turns a connector to face a socket, and the socket
   itself points away from the visitor. So the gesture is proximity,
   with no orientation asked for, and the last 3 cm are theatre.

   WHAT SEATING DOES. The connector stops being a body at all: its
   rigid body is removed, its mesh becomes a child of the speaker's,
   and it is retagged so that touching it touches the speaker.

   AN OBJECT WITH NO PARTS still has to be tolerated everywhere, and
   "everywhere" turned out to include places that do not walk the array
   but index straight into it: rescue() and carryInside() both take
   o.parts[0].body of every object in the map, and threw the moment the
   first connector seated -- which kills the frame, and with it the
   requestAnimationFrame that would have drawn the next one, so the
   whole layer stops. They skip it now, as does hit(). The cable is re-pointed at the speaker and carries on
   without noticing, because all it ever wanted was a body and an
   offset.
   ----------------------------------------------------------------- */

let plugging = null;      /* the seat animation, while one is running */
let plugFailed = false;   /* report once, not sixty times a second */
let plugBlocked = false;  /* just popped: do not seat it straight back in */
let popSoon = 0;          /* arrived plugged in, and owes the page a pop */

function socketPose(sp, pos, quat) {
  const b = sp.parts[0].body, p = b.translation(), q = b.rotation();
  quat.set(q.x, q.y, q.z, q.w);
  pos.copy(sp.shape.socketLocal).applyQuaternion(quat);
  pos.set(p.x + pos.x, p.y + pos.y, p.z + pos.z);
  quat.multiply(sp.shape.socketQuat);
}

/* Where the connector must sit, in the SPEAKER's own frame, for its
   plug to land in the socket: the socket's transform with the plug's
   undone. Both come from empties, so if they are authored to coincide
   when mated this is the whole of the arithmetic. */
function seatOffset(co, sp, pos, quat) {
  const pq = co.shape.plugQuat || new THREE.Quaternion();
  quat.copy(sp.shape.socketQuat).multiply(pq.clone().invert());
  pos.copy(co.shape.plugLocal).applyQuaternion(quat).multiplyScalar(-1)
     .add(sp.shape.socketLocal);
}

function plugTip(co, out) {
  const b = co.parts[0].body, p = b.translation(), q = b.rotation();
  out.copy(co.shape.plugLocal).applyQuaternion(_pq.set(q.x, q.y, q.z, q.w));
  return out.set(p.x + out.x, p.y + out.y, p.z + out.z);
}

const _pp = new THREE.Vector3();
const _pp2 = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _pq2 = new THREE.Quaternion();
const _face = new THREE.Vector3();
const _faceQ = new THREE.Quaternion();
const _pp3 = new THREE.Vector3();
const _pq3 = new THREE.Quaternion();
const _pq4 = new THREE.Quaternion();

function connectorObject() {
  for (const o of objects.values()) if (o.kind === "connector") return o;
  return null;
}
function speakerObject() {
  for (const o of objects.values()) if (o.kind === "speaker") return o;
  return null;
}

/* Close enough yet? Called once a frame; does nothing at all unless
   both are on the floor and the connector is still loose. */
function checkPlug(now) {
  if (popSoon && now >= popSoon) {
    if (allAsleep() || now >= popSoon + C.plugPopWaitMs) {
      popSoon = 0;
      popPlug(true, false, C.plugArriveForce);
    }
    return;
  }
  if (plugging) { stepPlug(now); return; }
  const co = connectorObject(), sp = speakerObject();
  if (!co || !sp || !co.parts.length || !co.shape || !sp.shape) return;
  if (!sp.shape.socketLocal || !co.shape.plugLocal) return;

  /* A PAGE THAT ARRIVES PLUGGED IN is plugged in, without the little
     film of it seating itself: the visitor did that on the last page
     and does not need to watch it again. */
  if (co.wantsPlug) {
    seatPlug(co, sp, true);
    const rec = recordFor(co.id);
    if (rec && rec.popOnArrival) {
      rec.popOnArrival = false;
      popSoon = now + C.plugPopDelayMs;   /* long enough to be seen seated */
    }
    return;
  }

  socketPose(sp, _pp, _pq2);
  plugTip(co, _pp2);
  if (plugBlocked) {
    /* Out of range at last: it may plug in again. */
    if (_pp2.distanceTo(_pp) > C.plugSnapCm * 1.6) plugBlocked = false;
    return;
  }
  assistPlug(co, sp, _pp, _pp2);
  if (_pp2.distanceTo(_pp) > C.plugSnapCm) return;

  const b = co.parts[0].body, p = b.translation(), q = b.rotation();
  plugging = {
    co: co, sp: sp, start: now,
    fromP: new THREE.Vector3(p.x, p.y, p.z),
    fromQ: new THREE.Quaternion(q.x, q.y, q.z, q.w)
  };
  if (drag && drag.id === co.id) drag = null;   /* it is out of your hands now */
}

/* Depth and angle, eased toward the socket as the plug comes near it
   ACROSS the screen -- which is the only distance the visitor can
   actually judge. Only while they are holding it: a connector that
   drifted into line on its own would be a mystery. */
function assistPlug(co, sp, socket, tip) {
  if (!(C.plugAssistCm > 0) || !drag || drag.id !== co.id) return;

  const dx = tip.x - socket.x, dy = tip.y - socket.y;
  const across = Math.sqrt(dx * dx + dy * dy);
  if (across > C.plugAssistCm) return;

  let w = 1 - across / C.plugAssistCm;
  w = w * w * (3 - 2 * w) * C.plugAssistRate;        /* eased, then scaled */

  /* Where the body would have to be for the plug to be seated. */
  seatOffset(co, sp, _pp3, _pq3);
  const sb = sp.parts[0].body, s0 = sb.translation(), sq = sb.rotation();
  _pq4.set(sq.x, sq.y, sq.z, sq.w);
  _pp3.applyQuaternion(_pq4);
  _pp3.set(s0.x + _pp3.x, s0.y + _pp3.y, s0.z + _pp3.z);
  _pq3.premultiply(_pq4);

  const b = co.parts[0].body, p = b.translation(), q = b.rotation();

  /* DEPTH ONLY. The plane of the screen stays entirely the visitor's:
     pulling x or y would feel like the object fighting the hand, while
     pulling z cannot be seen at all. */
  b.setTranslation({ x: p.x, y: p.y, z: p.z + (_pp3.z - p.z) * w }, true);

  _pq4.set(q.x, q.y, q.z, q.w).slerp(_pq3, w);
  b.setRotation({ x: _pq4.x, y: _pq4.y, z: _pq4.z, w: _pq4.w }, true);

  const v = b.linvel();
  b.setLinvel({ x: v.x, y: v.y, z: v.z * (1 - w) }, true);

  plugTip(co, tip);                       /* it has moved: re-measure */
}

function stepPlug(now) {
  const a = plugging, co = a.co, sp = a.sp;
  if (!objects.has(co.id) || !objects.has(sp.id) || !co.parts.length) {
    plugging = null; return;
  }
  const t = Math.min(1, (now - a.start) / Math.max(1, C.plugSeatMs));
  const e = t * t * (3 - 2 * t);          /* ease, so it arrives rather than stops */

  /* Where it is going, right now: the speaker may still be moving. */
  seatOffset(co, sp, _pp, _pq);
  const sb = sp.parts[0].body, sp0 = sb.translation(), sq0 = sb.rotation();
  _pq2.set(sq0.x, sq0.y, sq0.z, sq0.w);
  _pp2.copy(_pp).applyQuaternion(_pq2);
  _pp2.set(sp0.x + _pp2.x, sp0.y + _pp2.y, sp0.z + _pp2.z);
  _pq.premultiply(_pq2);

  const b = co.parts[0].body;
  b.setTranslation({ x: a.fromP.x + (_pp2.x - a.fromP.x) * e,
                     y: a.fromP.y + (_pp2.y - a.fromP.y) * e,
                     z: a.fromP.z + (_pp2.z - a.fromP.z) * e }, true);
  const q = a.fromQ.clone().slerp(_pq, e);
  b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);

  if (t >= 1) { seatPlug(co, sp); plugging = null; }
}

/* IT STOPS BEING A BODY. Everything that walks o.parts skips an object
   with none, so this needs no special case anywhere else -- only
   savePoses, which has a pose to not save. */
function seatPlug(co, sp, quiet) {
  seatOffset(co, sp, _pp, _pq);

  world.removeRigidBody(co.parts[0].body);
  const mesh = co.parts[0].mesh;
  root.remove(mesh);
  mesh.position.copy(_pp);
  mesh.quaternion.copy(_pq);
  sp.parts[0].mesh.add(mesh);
  /* TAGGED AS THE SPEAKER, so dragging it drags the pair, but marked as
     the plug so that pulling it can be told from carrying the cabinet. */
  tag(mesh, sp.id, 0);
  mesh.traverse((n) => { n.userData.plug = true; });

  co.parts = [];
  co.plugged = true;
  co.seatP = _pp.clone();       /* where it sits, in the speaker's frame */
  co.seatQ = _pq.clone();
  sp.plug = co;                 /* so the pulse can leave it alone */
  co.mesh = mesh;
  co.speakerId = sp.id;

  const rec = recordFor(co.id);
  /* The pose it had is stale the moment it seats, but leaving it is
     safer than clearing it: a record with no pose is a record that gets
     dropped from the ceiling. savePoses writes the real one. */
  if (rec) rec.plugged = true;

  /* IT IS PLUGGED IN, SO IT PLAYS. Seating counts as the gesture the
     audio context has been waiting for: the visitor dragged it here.

     Except when a page merely arrives holding a plugged-in record. That
     seat is bookkeeping, not an act: nobody did anything, the browser
     would refuse the sound anyway, and the connector is about to be
     thrown out again -- which briefly started a track and then stopped
     it, on every page load. */
  if (!quiet) {
    sound.gestureAt = performance.now();
    playPlugSound("in");
    startSpeakerAfterClick(sp);
  }

  /* THE CABLE FOLLOWS, and does not notice: it wants a body and an
     offset, and both simply become the speaker's. */
  if (cable && cable.id === co.id) {
    /* KEPT, NOT INVERTED LATER. Undoing this transform when it pops out
       would work and would be exactly the sort of arithmetic that is
       subtly wrong and invisible; the originals cost two vectors. */
    cable.gripWas = cable.grip.clone();
    cable.dirWas = cable.gripDir ? cable.gripDir.clone() : null;
    cable.part = sp.parts[0];
    cable.grip = cable.grip.clone().applyQuaternion(_pq).add(_pp);
    if (cable.gripDir) cable.gripDir = cable.gripDir.clone().applyQuaternion(_pq);
  }
  wake();
}

/* PULLING IT OUT. A seated connector is not a body, so this is not the
   ordinary drag: the pointer's distance from the socket slides the mesh
   along the socket's own axis, and past plugPullShare it comes free.
   Dragging the CABINET still moves the speaker as before -- only the
   plug's own silhouette pulls. */
let pulling = null;

function startPull(co, sp, point) {
  pulling = { co: co, sp: sp, fromX: point.x, fromY: point.y, out: 0 };
}

/* THE PULL IS MEASURED ACROSS THE SCREEN, and spent along the socket's
   axis. It has to be: the socket faces into the page, so the direction
   the plug actually travels is the one direction a pointer cannot move
   in -- projecting the drag onto it gave almost nothing and the plug
   never came out however hard it was pulled. So any direction of drag
   counts, and what it buys is depth. The same bargain as the assist. */
function stepPull(point) {
  const a = pulling;
  if (!a || !objects.has(a.co.id) || !objects.has(a.sp.id) || !a.co.plugged) {
    pulling = null; return;
  }
  const d = Math.hypot(point.x - a.fromX, point.y - a.fromY);
  const limit = C.plugPullCm;
  a.out = Math.min(d, C.plugSlideCm);

  /* OUT of the socket is AWAY from the plug, which sits at +Y in the
     connector's own frame -- so -Y. Written the other way round first,
     which drove it into the cabinet instead of out of it. */
  _pp3.set(0, -1, 0).applyQuaternion(a.co.seatQ);
  a.co.mesh.position.copy(a.co.seatP).addScaledVector(_pp3, a.out);

  if (d >= limit) popPlug(true, false);
}

/* IT COMES FREE: the reverse of seating, with a shove. "clear" moves it
   far enough out that it cannot immediately plug itself back in -- only
   needed when there will be no frames to keep it apart, which is the
   page change. */
function popPlug(thrown, clear, force) {
  const co = pulling ? pulling.co : plugFor();
  if (!co || !co.plugged) { pulling = null; return; }
  const sp = objects.get(co.speakerId);
  const slid = pulling ? pulling.out : 0;
  pulling = null;

  const mesh = co.mesh;
  mesh.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  mesh.matrixWorld.decompose(p, q, sc);
  p.divideScalar(PXCM);                 /* root is in px; bodies are in cm */

  const away = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
  /* Out of the socket before it becomes solid, less whatever the pull
     has already slid it. */
  p.addScaledVector(away, Math.max(0, C.plugClearCm - slid));
  if (clear) p.addScaledVector(away, C.plugSnapCm * 2);

  if (mesh.parent) mesh.parent.remove(mesh);
  mesh.scale.setScalar(1);
  root.add(mesh);
  tag(mesh, co.id, 0);
  mesh.traverse((n) => { n.userData.plug = false; });

  const body = bodyFor(co.shape,
    bodyDesc({ p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] }, co.shape.planar),
    co.kind);
  for (let i = 0; i < body.numColliders(); i++) body.collider(i).setSensor(false);
  /* PUT THE MESH WHERE THE BODY IS, now rather than on the next frame.
     Left at the origin it was drawn inside the speaker, which is what
     the page-change snapshot caught: pagehide pops it and photographs
     the scene immediately, with no frame in between to sync them. */
  mesh.position.copy(p);
  mesh.quaternion.copy(q);

  co.parts = [{ body: body, mesh: mesh }];
  co.plugged = false;
  co.wantsPlug = false;
  if (sp) {
    sp.plug = null;
    /* AWAKE BEFORE IT IS SHOVED. A sleeping body meets the whole of a
       penetration in the step it is woken by, and answers it in one
       shove; awake, it has been resolving contacts all along and takes
       this one in its stride. It is why the same pop was gentle by hand
       and violent on a page that had just loaded. */
    sp.parts.forEach((part) => part.body.wakeUp());
  }

  if (thrown) {
    const v = C.plugFlySpeed * (force === undefined ? 1 : force);
    body.setLinvel({ x: away.x * v, y: away.y * v, z: away.z * v }, true);
    const w = C.plugFlySpin;
    if (w) body.setAngvel({ x: (Math.random() - 0.5) * w, y: (Math.random() - 0.5) * w,
                            z: (Math.random() - 0.5) * w }, true);
  }

  const rec = recordFor(co.id);
  if (rec) { rec.plugged = false; rec.rest = false; }

  if (cable && cable.id === co.id && cable.gripWas) {
    cable.part = co.parts[0];
    cable.grip = cable.gripWas.clone();
    cable.gripDir = cable.dirWas ? cable.dirWas.clone() : cable.gripDir;
  }

  /* SUPPRESSED UNTIL IT HAS LEFT. The moment it pops it is still well
     inside plugSnapCm, so without this it would seat again on the very
     next frame and never come off at all. */
  plugBlocked = true;

  sound.gestureAt = performance.now();
  playPlugSound("out");
  stopSpeaker();                /* the cable was carrying the music */
  wake();
}

/* What the cable and the plug think is going on, for when watching is
   not enough. __drift.objects3d.plugReport() */
function plugReport() {
  const cb = cable;
  if (!cb) return "no cable";
  const A = cableAnchor(new THREE.Vector3());
  const G = new THREE.Vector3(), D = new THREE.Vector3();
  tipPoints(cb, G, D);
  const co = objects.get(cb.id);
  const plugged = !!(co && !co.parts.length);
  return {
    plugged: plugged,
    pinnedTo: plugged ? "speaker" : "connector",
    cableLen: +cb.len.toFixed(2),
    anchorToTip: +A.distanceTo(G).toFixed(2),
    taut: A.distanceTo(G) > cb.len,
    leashShare: plugged ? C.cableLeashPlugged : 1,
    grip: cb.grip.toArray().map((v) => +v.toFixed(2)),
    tip: G.toArray().map((v) => +v.toFixed(2)),
    lift: +cb.lift.toFixed(2)
  };
}

function plugFor() {
  for (const o of objects.values()) if (o.plugged) return o;
  return null;
}

function recordFor(id) {
  const list = drift.state && drift.state.objects;
  if (!Array.isArray(list)) return null;
  for (const r of list) if (r.id === id) return r;
  return null;
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
    if (!o.parts.length) continue;    /* plugged in: not a body, see THE PLUG */
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
    if (!o.parts.length) continue;    /* plugged in: not a body, see THE PLUG */
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
  /* THE WORLD IS HELD while a box is forward: no stepping, no walls,
     no cable, no settling. Everything stays exactly where it was, so
     the box can be set back down in its own place afterwards without
     anything having to be remembered. The loop itself keeps running
     -- the flight and the dials still have to be drawn. */
  if (focus.o && !focus.live) {
    acc = 0;
  } else {
    while (acc >= C.step && n < C.maxSteps) {
      steerDrag();
      stepLeashes();
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
  }

  for (const o of objects.values()) {
    /* Anything the focus is holding is drawn by stepFocus instead --
       through the lens, not at its own place on the floor. */
    if (focus.group && focus.group.indexOf(o) >= 0) continue;
    for (const part of o.parts) {
      const p = part.body.translation();
      const q = part.body.rotation();
      part.mesh.position.set(p.x, p.y, p.z);
      part.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }
  /* GUARDED, for the reason checkPlug is: frame() does not catch, so
     one exception here means requestAnimationFrame is never called
     again and the whole layer dies mid-frame. */
  try {
    stepFocus(now);
    stepRattle(now);
  } catch (err) {
    if (!focusFailed) { focusFailed = true; console.error("drift-3d: focus failed", err); }
    (focus.group || []).forEach((g) => g.parts.forEach((part) => {
      part.mesh.scale.setScalar(1);
      part.body.wakeUp();
    }));
    focus.o = null;
    focus.cur = null;
    if (focus.live && focus.o) { freeDoor(focus.o, false); holdCase(focus.o, false); }
    focus.group = null;
    focus.live = false;
    dropKeysGhost(null, false);
    if (veil) veil.visible = false;
    document.documentElement.classList.remove("drift-focus");
  }
  /* GUARDED, BECAUSE A THROW HERE STOPS EVERYTHING. frame() does not
     catch, so an exception anywhere in it means requestAnimationFrame
     is never called again and the whole layer dies mid-frame -- which
     reads as the page freezing. Seating is the newest code in the
     file; it should not be able to take the rest of it down. */
  try {
    checkPlug(now);
  } catch (err) {
    if (!plugFailed) { plugFailed = true; console.error("drift-3d: plug failed", err); }
    plugging = null;
  }
  drawCable();
  const animating = stepTally(now);
  if (speaker3d.id) showSpeaker(speakerLevel());
  requestEnv(false);         /* the tally moved: throttled, and a no-op if not */
  stepColliderLines();
  drawShadows(now);
  renderer.render(scene, camera);
  if (!live) goLive();

  /* A connector seating itself is an animation like the tally's press:
     the loop must not stop in the middle of it. */
  if (!drag && !animating && !plugging && !speaker3d.id && !focus.o && allAsleep()) {
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

/* The rope's own shape, for whichever of the two paths above is taking
   this object. It was left to rebuild itself from its two ends, on the
   argument that a rope derived from two points cannot disagree with
   itself. It can: once it has friction and a memory of its own shape,
   where it settles depends on how it got there, so the next page draped
   it somewhere else and the handover showed as a jump. Two dozen points,
   to two decimals, against that. */
function saveCable(o, rec) {
  if (o.kind !== "connector" || !cable || cable.id !== rec.id) return;
  const A = cableAnchor(_cA), p = [];
  for (let i = 0; i < cable.nodes.length; i++) p.push(round(cable.nodes[i], 100));
  rec.cable = { a: [round(A.x, 100), round(A.y, 100), round(A.z, 100)], p: p };
}

function savePoses() {
  if (!world) return;
  const state = drift.state;
  if (!Array.isArray(state.objects)) return;

  for (const rec of state.objects) {
    const o = objects.get(rec.id);
    if (!o) continue;
    if (!o.parts.length) {
      /* PLUGGED IN, and so not a body to read a pose from -- but it still
         needs one. Saved as null, the next page found a record with no
         pose, decided it was a new object and dropped it from above the
         window: born in mid-air with the cable's restored nodes lying
         down by the speaker, which is a stretch of the cable's whole
         length on the first frame. The rope went berserk, and the moment
         it was seated the far end of it was the speaker and it hauled
         that up too. Taken off the mesh instead, which is where the
         seated connector actually is. */
      rec.plugged = true;
      rec.rest = true;
      /* AND ITS CABLE, which used to be skipped by the very "continue"
         below: the save sat after it, so a plugged connector went to the
         next page with no rope recorded at all. There it was rebuilt
         from nothing -- gathered at an anchor lifted its own full length
         and paying out taut as it came down -- which is why the cable
         went tight on a page change only while it was plugged in. */
      saveCable(o, rec);
      if (o.mesh) {
        o.mesh.updateMatrixWorld(true);
        const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
        o.mesh.matrixWorld.decompose(wp, wq, ws);
        wp.divideScalar(PXCM);
        rec.pose = {
          p: [round(wp.x, 1000), round(wp.y, 1000), round(wp.z, 1000)],
          q: [round(wq.x, 1e5), round(wq.y, 1e5), round(wq.z, 1e5), round(wq.w, 1e5)]
        };
      }
      continue;
    }
    rec.pose = poseOf(o.parts[0].body);
    if (o.parts[1]) rec.ring = poseOf(o.parts[1].body);
    /* MORE THAN TWO, and every one of them needs remembering: an
       articulated set rebuilt from one pose comes back in its modelled
       shape, so a bunch of keys that had fanned out on the floor would
       silently gather itself up again on every page. */
    if (o.parts.length > 2) rec.parts = o.parts.map((part) => poseOf(part.body));
    if (o.kind === "tally" && tally.shown !== null) rec.shown = tally.shown;
    if (o.kind === "lockbox" && o.wheels) { rec.open = !!o.open; rec.wheels = o.wheels.slice(); }
    saveCable(o, rec);
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
  if (!o || !o.parts.length) return null;
  const part = o.parts[found.object.userData.part || 0] || o.parts[0];
  /* The exact point touched, in cm: the scene is in px, root scales. */
  const point = found.point.clone().divideScalar(PXCM);
  return { o, part, index: o.parts.indexOf(part), point,
           node: found.object,          /* which mesh: the dials need it */
           plug: !!found.object.userData.plug };
}

function bindPointer() {
  const html = document.documentElement;

  window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;

    /* WHILE A BOX IS FORWARD there are only two gestures: press on it
       and it can be shaken, press anywhere else and it goes back
       down. The click is swallowed either way -- leaving the box must
       never follow a link that happened to be under the pointer, and
       must never count. */
    if (focus.o) {
      const on = hit(e.clientX, e.clientY);
      swallowClick = true;
      e.preventDefault();
      if (on && on.o === focus.o) {
        const i = dialIndex(focus.o, on.node);
        if (i >= 0) startDial(i, e);
        else { startShake(e, on.point); html.classList.add("drift-3d-grabbing"); }
      } else {
        exitFocus();
      }
      wake();
      return;
    }

    const h = hit(e.clientX, e.clientY);
    if (!h) return;

    /* THE PLUG IS NOT THE CABINET. Its meshes are tagged as the
       speaker's, so that the pair moves as one when carried -- but
       touching the plug itself pulls it out instead of dragging the
       speaker around by it. */
    if (h.plug && h.o.plug) {
      startPull(h.o.plug, h.o, h.point);
      swallowClick = true;
      html.classList.add("drift-3d-grabbing");
      e.preventDefault();
      wake();
      return;
    }

    /* Held BY THE POINT TOUCHED, stored in the body's own frame, so
       it stays the same spot on the object as it turns. */
    const b = h.part.body;
    const p = b.translation(), q = b.rotation();
    const local = h.point.clone()
      .sub(new THREE.Vector3(p.x, p.y, p.z))
      .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w).invert());
    /* WHICH BODY THE HAND ACTUALLY STEERS. Normally the one touched.
       For a set that hangs together -- the keys -- it is the hub, and
       the touched point is re-expressed in the hub's frame so it
       still lifts from where the hand landed. */
    let part = h.index, hold = local;
    if (C.keysDragHub && h.o.kind === "keys" && h.o.parts[0] &&
        h.index !== 0) {
      const hb = h.o.parts[0].body;
      const hp = hb.translation(), hq = hb.rotation();
      hold = h.point.clone()
        .sub(new THREE.Vector3(hp.x, hp.y, hp.z))
        .applyQuaternion(new THREE.Quaternion(hq.x, hq.y, hq.z, hq.w).invert());
      part = 0;
    }

    drag = { id: h.o.id, part, pointer: e.pointerId,
             local: hold, tx: h.point.x, ty: h.point.y,
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
    trackHand(e);
    if (focus.dial) { stepDial(e); wake(); return; }
    if (focus.shake) { stepShake(e); wake(); return; }
    if (focus.o) return;
    if (pulling) { stepPull(toWorld(e.clientX, e.clientY)); return; }
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
    if (drag) {
      const held = objects.get(drag.id);
      if (held) held.followV = null;   /* the next grab starts from rest */
    }
    if (focus.dial) {
      endDial();
      wake();
      return;
    }
    if (focus.shake) {
      focus.shake = null;           /* the spring takes it back */
      html.classList.remove("drift-3d-grabbing");
      wake();
      return;
    }
    if (pulling) {
      /* Let go short of the threshold and it simply seats again: the
         plug was never out, only stretched. */
      if (pulling.co && pulling.co.mesh && pulling.co.seatP) {
        pulling.co.mesh.position.copy(pulling.co.seatP);
      }
      pulling = null;
      html.classList.remove("drift-3d-grabbing");
      wake();
      return;
    }
    if (!drag || (e && e.pointerId !== drag.pointer)) {
      /* NOTHING WAS BEING DRAGGED, so the branches below never run --
         and one of them is the only thing that clears swallowClick.
         Leaving focus sets that flag with no drag behind it, and if
         no click follows the press (preventDefault often sees to
         that) it stays set and every later click on the page is
         eaten: dead links, dead lightbox, until a page change builds
         the module again. */
      if (swallowClick) window.setTimeout(() => { swallowClick = false; }, 400);
      return;
    }

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
      /* THE TAP IS THE LOCKBOX'S. Music belongs to the cable now:
         plug it in and it plays. A tap on a shut box brings it
         forward; on an open one it does nothing, because there is
         nothing left to do with it but carry it about. */
      if (o && o.kind === "lockbox" && !o.open) {
        drag = null;
        html.classList.remove("drift-3d-grabbing");
        enterFocus(o);
        window.setTimeout(() => { swallowClick = false; }, 400);
        return;
      }
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

  /* A SET IS HELD BY ONE PART AND CARRIED BY ALL OF THEM, and the
     way that works changed underneath this. Two things used to live
     here and both are gone:

       sizing the held part's pull by the whole set's weight, which
       drove a small ring at ten times its own scale -- a correction
       bigger than the error, overshooting every step, joints shaking;

       and cancelling most of the other parts' gravity so that ring
       could tow them, which made the whole bunch weightless: lift it
       and the keys kept whatever angle they had.

     Both existed because the keys were PINNED and pulling one only
     made it swing. Threaded, a key traps the wire in its own rim and
     pulls the ring directly, so the ordinary grab below is the whole
     of it. */

  /* THE REST OF THE SET IS HELPED ALONG. See keysFollow: a share of
     the hand's pull, at each part's own mass so none is overdriven,
     and at its centre so no spin is forced on it. */
  if (o.kind === "keys" && C.keysFollow > 0 && o.parts.length > 1) {
    if (!o.followV) o.followV = new THREE.Vector3(dx, dy, dz);
    const a = 1 - Math.exp(-C.step / Math.max(0.01, C.keysFollowLag));
    o.followV.x += (dx - o.followV.x) * a;
    o.followV.y += (dy - o.followV.y) * a;
    o.followV.z += (dz - o.followV.z) * a;

    const fv = o.followV;
    const g = C.grabStiffness * C.keysFollow;
    const gUp = C.grabStiffness * C.keysFollowUp;
    for (const p2 of o.parts) {
      if (p2 === part) continue;
      const b2 = p2.body, m2 = b2.mass(), v2 = b2.linvel();
      b2.applyImpulse({ x: (fv.x - v2.x) * m2 * g,
                        y: (fv.y - v2.y) * m2 * gUp,
                        z: (fv.z - v2.z) * m2 * g }, true);
    }
  }

  const k = body.mass() * C.grabStiffness;
  let jx = (dx - vx) * k, jy = (dy - vy) * k, jz = (dz - vz) * k;

  /* A FIRM GRIP, NOT AN INFINITE ONE. Uncapped, pointing below the
     floor pressed the held object down with tens of times its weight,
     every step, and whatever was underneath was squeezed into and
     eventually through the floor. Capped at gripStrength x weight. */
  let carrying = body.mass();
  if (o.kind === "keys" && o.parts.length > 1) {
    let rest = 0;
    for (const p2 of o.parts) if (p2 !== part) rest += p2.body.mass();
    carrying += rest * C.keysCarry;
  }
  const limit = carrying * (C.gravityPx / PXCM) * C.gripStrength * C.step;
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
