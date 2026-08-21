/* ===============================================================
   drift-boot.js — runs BEFORE first paint. Keep it small.
   ===============================================================
   Loaded synchronously in <head>, above the stylesheet links, so
   the page is already drifted when it is first painted.

   The per-navigation roll (§7) lives here, not in drift.js, for
   the same reason: an event decided after first paint would show
   the page changing instead of arriving changed.

   Responsibilities:
     1. read persisted state
     2. classify how this page was reached
     3. resolve the counter for this page view
     4. roll spawn / tier / removal
     5. write counter and active events onto <html>
   =============================================================== */

(function () {
  "use strict";

  var KEY = "pf.drift.v1";
  var VERSION = 1;

  /* ---------------------------------------------------------------
     TUNING
     Tuned for a casual visit of 5-10 navigations. Lightbox opens
     count, so an engaged visitor climbs three to five times faster
     than page count — these want re-checking against real data.
     --------------------------------------------------------------- */

  var T = {
    /* SPAWN? — probability an event occurs this navigation. */
    spawnBase:   0.12,
    spawnSlope:  0.02,
    spawnMax:    0.85,

    /* REMOVE? — per-event chance, decaying toward zero. */
    removeBase:  0.55,
    removeDecay: 28,

    /* The mode flip (§6). Below it, every active event rolls to be
       removed and the set self-corrects. Above it, one check per
       navigation regardless of how many are active, so the set can
       only grow. This is the main dial in the whole system. */
    breakingPoint:   32,
    postFlipRemoval: 0.35,

    /* Gates. */
    rareGate:      55,
    rareRamp:      35,     /* counters above rareGate to reach full weight */
    rareWeightMax: 0.22,

    uncommonBase: 0.12,
    uncommonMax:  0.28,
    uncommonRamp: 55,

    rareLifeMin: 2,
    rareLifeMax: 3
  };

  /* ---------------------------------------------------------------
     EVENT REGISTRY
     One entry per event; drift.css keys off the id. Step 3 fills
     this out. For now it holds the single test event.
     --------------------------------------------------------------- */

  var EVENTS = {
    "link-shift": { tier: "common" }
  };

  /* How long after the last interaction a reload still reads as a
     deliberate human refresh. Generous on purpose: the failure we
     care about (§12) is wiping a real visitor's progress. */
  var FOREGROUND_WINDOW = 2 * 60 * 60 * 1000;

  /* A hide younger than this was part of a page teardown, not a
     backgrounding. Reload boots are near-instant; OS tab evictions
     are not. */
  var TEARDOWN_WINDOW = 3000;

  function defaults() {
    return {
      v: VERSION,
      counter: 0,
      events: [],            /* [{ id, tier, life }] */
      objects: [],           /* spawned bodies — step 4 */
      reloadCount: 0,
      lastInteractionAt: 0,
      lastHiddenAt: 0,
      lastVisibleAt: 0,
      pendingNav: false,
      lastRoll: null,        /* diagnostic only */
      updatedAt: 0
    };
  }

  function read() {
    var raw;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch (err) {
      return defaults();
    }
    if (!raw) return defaults();

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return defaults();
    }
    if (!parsed || parsed.v !== VERSION) return defaults();

    var base = defaults();
    for (var k in base) {
      if (Object.prototype.hasOwnProperty.call(parsed, k)) {
        base[k] = parsed[k];
      }
    }
    /* An event removed from the registry must not linger in a
       returning visitor's saved state. */
    base.events = (base.events || []).filter(function (e) {
      return e && EVENTS[e.id];
    });
    return base;
  }

  function write(state) {
    state.updatedAt = Date.now();
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (err) {}
  }

  /* ---------------------------------------------------------------
     THE ROLL (§7) — spawn? → which tier? → remove?
     --------------------------------------------------------------- */

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  function pSpawn(n) {
    return Math.min(T.spawnMax, T.spawnBase + T.spawnSlope * n);
  }

  function pRemove(n) {
    return T.removeBase * Math.exp(-n / T.removeDecay);
  }

  function rollTier(n) {
    var rare = 0;
    if (n >= T.rareGate) {
      rare = T.rareWeightMax * clamp01((n - T.rareGate) / T.rareRamp);
    }
    var uncommon = T.uncommonBase +
                   (T.uncommonMax - T.uncommonBase) * clamp01(n / T.uncommonRamp);

    var r = Math.random();
    if (r < rare) return "rare";
    if (r < rare + uncommon) return "uncommon";
    return "common";
  }

  function activeIds(state) {
    return state.events.map(function (e) { return e.id; });
  }

  /* Pick an event of this tier that is not already active. */
  function pickEvent(state, tier) {
    var active = activeIds(state);
    var pool = [];
    for (var id in EVENTS) {
      if (EVENTS[id].tier === tier && active.indexOf(id) === -1) pool.push(id);
    }
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function rollNavigation(state) {
    var n = state.counter;
    var log = { n: n, spawned: null, tier: null, removed: [], expired: [] };
    var justSpawned = null;
    var i, e;

    /* 1 · SPAWN? ------------------------------------------------- */
    if (Math.random() < pSpawn(n)) {
      var tier = rollTier(n);
      log.tier = tier;

      if (tier === "uncommon") {
        /* The object trigger (§5). Objects are step 4; for now this
           is recorded and nothing drops. It is deliberately NOT an
           event — objects never enter the removal pass (§4). */
        log.spawned = "(object)";

      } else {
        var id = pickEvent(state, tier);
        if (id) {
          var life = null;
          if (tier === "rare") {
            life = T.rareLifeMin +
                   Math.floor(Math.random() * (T.rareLifeMax - T.rareLifeMin + 1));
          }
          state.events.push({ id: id, tier: tier, life: life });
          justSpawned = id;
          log.spawned = id;
        }
        /* else: everything of that tier is already active. */
      }
    }

    /* 2 · REMOVE? ------------------------------------------------ */
    /* Commons only. Rare events self-expire on their lifespan
       instead; objects are not in this list at all.

       The event spawned this navigation is exempt. Without that, an
       event can appear and vanish inside one page view — a roll the
       visitor can never see, which just wastes spawns. */

    var survivors = [];

    if (n < T.breakingPoint) {
      /* Per-event roll. Removals scale with the size of the active
         set, so it self-corrects toward a low equilibrium. */
      var p = pRemove(n);
      for (i = 0; i < state.events.length; i++) {
        e = state.events[i];
        if (e.tier === "common" && e.id !== justSpawned && Math.random() < p) {
          log.removed.push(e.id);
        } else {
          survivors.push(e);
        }
      }
    } else {
      /* Past the flip: ONE check per navigation, regardless of how
         many events are active. Once spawn outpaces this, the set
         can only grow. */
      var victim = null;
      if (Math.random() < T.postFlipRemoval) {
        var eligible = state.events.filter(function (ev) {
          return ev.tier === "common" && ev.id !== justSpawned;
        });
        if (eligible.length) {
          victim = eligible[Math.floor(Math.random() * eligible.length)].id;
        }
      }
      for (i = 0; i < state.events.length; i++) {
        e = state.events[i];
        if (e.id === victim) {
          log.removed.push(e.id);
        } else {
          survivors.push(e);
        }
      }
    }
    state.events = survivors;

    /* 3 · RARE LIFESPANS ----------------------------------------- */
    state.events = state.events.filter(function (ev) {
      if (ev.tier !== "rare" || ev.id === justSpawned) return true;
      ev.life -= 1;
      if (ev.life <= 0) {
        log.expired.push(ev.id);
        return false;
      }
      return true;
    });

    state.lastRoll = log;
    return log;
  }

  /* ---------------------------------------------------------------
     APPLY
     One space-separated token list on <html>. drift.css matches it
     with [data-event~="id"], which is why ids must not contain
     spaces.
     --------------------------------------------------------------- */

  function applyDrift(state) {
    var root = document.documentElement;
    root.setAttribute("data-drift", String(state.counter));
    root.style.setProperty("--drift-count", String(state.counter));
    root.setAttribute("data-event", activeIds(state).join(" "));
  }

  /* ---------------------------------------------------------------
     §12 — human refresh, or an OS reload of an evicted tab?
     The strongest signal is which happened last: the visitor
     interacting, or the tab being hidden.
     --------------------------------------------------------------- */

  function isHumanReload(state) {
    var now = Date.now();

    /* No recorded interaction. Either storage is fresh or the
       visitor never touched the page — no progress worth
       protecting, so treat it as a human refresh. */
    if (!state.lastInteractionAt) return true;

    /* Browsers fire visibilitychange → hidden as part of the
       teardown for ANY unload, reloads included. That hide lands
       milliseconds before the document dies, so at boot it is only
       a few hundred ms old. A genuine backgrounding is seconds or
       hours old by the time the OS reloads the tab. The age of the
       hide is what separates them. */
    var hidden = state.lastHiddenAt || 0;
    var teardownHide = hidden && (now - hidden) < TEARDOWN_WINDOW;

    /* And if the tab was shown again after being hidden, the hide
       is not the last thing that happened to it. */
    var returnedToTab = hidden && (state.lastVisibleAt || 0) > hidden;

    var wasBackgrounded = hidden > state.lastInteractionAt &&
                          !teardownHide &&
                          !returnedToTab;

    if (wasBackgrounded) return false;

    return (now - state.lastInteractionAt) < FOREGROUND_WINDOW;
  }

  function navigationType() {
    try {
      var entries = window.performance.getEntriesByType("navigation");
      if (entries && entries[0] && entries[0].type) return entries[0].type;
    } catch (err) {}
    try {
      var legacy = window.performance && window.performance.navigation;
      if (legacy) {
        if (legacy.type === 1) return "reload";
        if (legacy.type === 2) return "back_forward";
      }
    } catch (err) {}
    return "navigate";
  }

  /* ---------------------------------------------------------------
     RESOLVE THIS PAGE VIEW
     --------------------------------------------------------------- */

  var state = read();
  var type = navigationType();
  var reset = false;

  if (type === "reload") {
    if (isHumanReload(state)) {
      /* The deliberate clean-slate path (§2). reloadCount survives
         and climbs — it is what the easter egg counts (§3). */
      state.counter = 0;
      state.events = [];
      state.objects = [];
      state.lastRoll = null;
      state.reloadCount = (state.reloadCount || 0) + 1;
      reset = true;
    }
    /* else: OS tab eviction. Restore untouched, roll nothing. */

  } else if (type === "back_forward") {
    state.counter += 1;
    state.reloadCount = 0;
    rollNavigation(state);

  } else {
    /* "navigate": an internal link click was already counted and
       rolled before unload, or this is a direct arrival. Neither
       rolls again here. */
    state.reloadCount = 0;
  }

  state.pendingNav = false;
  write(state);
  applyDrift(state);

  window.__drift = {
    KEY: KEY,
    VERSION: VERSION,
    T: T,
    EVENTS: EVENTS,
    state: state,
    navigationType: type,
    didReset: reset,
    defaults: defaults,
    read: read,
    write: write,
    rollNavigation: rollNavigation,
    applyDrift: applyDrift,
    pSpawn: pSpawn,
    pRemove: pRemove
  };
})();
