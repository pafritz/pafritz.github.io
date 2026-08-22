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

  /* ---------------------------------------------------------------
     DEBUG
     Set DEBUG_ALLOWED to false before launch. That one line disables
     the readout and the console helpers outright — no URL or storage
     flag can bring them back.
     --------------------------------------------------------------- */

  var DEBUG_ALLOWED = true;

  function debugActive() {
    if (!DEBUG_ALLOWED) return false;
    try {
      var q = window.location.search;
      if (q.indexOf("drift=off") !== -1) {
        window.sessionStorage.removeItem("pf.drift.debug");
        window.localStorage.removeItem("pf.drift.debug");
        return false;
      }
      if (q.indexOf("drift=debug") !== -1) {
        window.sessionStorage.setItem("pf.drift.debug", "1");
      }
      return window.sessionStorage.getItem("pf.drift.debug") === "1" ||
             window.localStorage.getItem("pf.drift.debug") === "1";
    } catch (err) {
      return false;
    }
  }

  var DEBUG = debugActive();

  var KEY = "pf.drift.v1";
  var VERSION = 1;

  /* ---------------------------------------------------------------
     TUNING
     Tuned for a casual visit of 5-10 navigations. Lightbox opens
     count, so an engaged visitor climbs three to five times faster
     than page count — these want re-checking against real data.
     --------------------------------------------------------------- */

  var T = {
    /* Nothing rolls below this. A short visit sees no events at
       all — the hard-placed tally object (§10) is what tells that
       visitor the page is intentional rather than broken. Objects
       and events both wait; scripted furniture does not. */
    eventGate: 10,

    /* SPAWN? — probability an event occurs this navigation.
       Measured in depth past the gate, not raw counter, so the
       curve starts where the events start. */
    spawnBase:   0.12,
    spawnSlope:  0.02,
    spawnMax:    0.85,

    /* REMOVE? — per-event chance, decaying toward zero. Also
       measured in depth. */
    removeBase:  0.55,
    removeDecay: 28,

    /* The mode flip (§6). Below it, every active event rolls to be
       removed and the set self-corrects. Above it, one check per
       navigation regardless of how many are active, so the set can
       only grow. This is the main dial in the whole system.

       Absolute counter values, not depth. With the gate at 10 that
       leaves 22 navigations of "changes come and go" before things
       start sticking — a short escalation on purpose. */
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
     One entry per event. Every field except `tier` is optional.

       tier      "common" | "rare"          required
       weight    relative pick odds          default 1
       gate      own counter threshold       default: tier's gate
       excludes  ids that cannot co-exist    default none
       level     true if intensity climbs    default false
       variants  array of ids, or a function default none

     A variants function receives (state) and returns the array of
     ids eligible right now. Fonts use that: only faces already
     downloaded are pickable, so a variant is never chosen that the
     browser cannot render immediately.
     --------------------------------------------------------------- */

  var EVENTS = {
    "link-shift": { tier: "common" },

    "font-change": {
      tier: "common",
      weight: 2,
      variants: function (state) { return loadedFonts(state, "common"); }
    },

    /* Bullets. --marker is disc by default, so every variant here is
       a real non-default. The numbered ones read as the markup being
       different rather than the styling — a bulleted list quietly
       becoming ordered.

       `none` is the quietest and the most disruptive: it affects the
       nav, and a list with no markers stops reading as a list. */
    "marker": {
      tier: "common",
      variants: ["circle", "square", "none", "decimal",
                 "lower-roman", "upper-alpha"]
    },

    "bg-drift": {
      tier: "common",
      variants: ["paper", "bone", "linen"]
    },

    "link-decoration": {
      tier: "common",
      variants: ["overline", "dotted", "double", "wavy"]
    },

    "visited-shift": { tier: "common", weight: 0.5 },

    "type-metrics": {
      tier: "common",
      variants: ["smaller", "larger", "tracked"]
    },

    "cursor": {
      tier: "common",
      variants: ["crosshair", "help", "text", "progress"]
    },

    /* §5 — the ~2 degree text skew, and the reason --skew has been
       sitting declared but unwired in style.css since the start.

       `uniform` tilts every block the same way. `scatter` runs a
       repeating nth-child cycle so the angles look unrelated: CSS
       cannot generate randomness, and nobody counts paragraphs.
       `subtle` is half a degree, barely nameable. */
    "skew": {
      tier: "common",
      variants: ["subtle", "uniform", "scatter"]
    },

    /* Louder than the rest — it flips the page from accidental to
       authored, which contradicts the note in style.css on purpose.
       Gated above the others; move to rare if it reads too strong.

       `justify` is the no-flag-edge one: every line ends at the
       same point. Only reads on paragraphs long enough to wrap. */
    "align": {
      tier: "common",
      gate: 20,
      variants: ["center", "right", "justify"]
    },

    "font-weird": {
      tier: "rare",
      weight: 2,
      variants: function (state) { return loadedFonts(state, "rare"); }
    },

    /* Overrides `marker` by source order in drift.css, and peels
       back to it when the rare expires. */
    "marker-weird": {
      tier: "rare",
      variants: ["dagger", "reference", "negation", "cross", "arrow",
                 "middot", "dash", "cjk", "hebrew"]
    }
  };

  /* ---------------------------------------------------------------
     FONT POOLS
     Keys are the variant ids written to data-v-font-change; values
     are the CSS font-family names declared in drift.css. Order is
     download order, so the quietest faces arrive first.

     Weights bias the pick within the pool — the near-Times serifs
     should come up more often than the monospaces, or a casual
     visitor's first font event is as likely to be Roboto Mono as
     Literata.
     --------------------------------------------------------------- */

  var FONTS = {
    common: [
      { id: "literata",         family: "Literata",         weight: 3 },
      { id: "andada-pro",       family: "Andada Pro",       weight: 3 },
      { id: "eb-garamond",      family: "EB Garamond",      weight: 3 },
      { id: "fenix",            family: "Fenix",            weight: 2 },
      { id: "google-sans-flex", family: "Google Sans Flex", weight: 1 },
      { id: "roboto-mono",      family: "Roboto Mono",      weight: 1 },
      { id: "cutive-mono",      family: "Cutive Mono",      weight: 1 }
    ],
    rare: [
      { id: "josefin-slab",           family: "Josefin Slab" },
      { id: "castoro-titling",        family: "Castoro Titling" },
      { id: "italiana",               family: "Italiana" },
      { id: "cherry-swash",           family: "Cherry Swash" },
      { id: "bevan",                  family: "Bevan" },
      { id: "special-elite",          family: "Special Elite" },
      { id: "doto",                   family: "Doto" },
      { id: "lacquer",                family: "Lacquer" },
      { id: "bigelow-rules",          family: "Bigelow Rules" },
      { id: "homemade-apple",         family: "Homemade Apple" },
      { id: "mountains-of-christmas", family: "Mountains of Christmas" },
      { id: "unifraktur-maguntia",    family: "UnifrakturMaguntia" }
    ]
  };

  /* Ids the loader has confirmed are downloaded and renderable.
     Persisted, because document.fonts is per-document and starts
     empty on every page — a font fetched on the previous page would
     otherwise look unavailable here. */
  function loadedFonts(state, pool) {
    var ready = state.fontsReady || [];
    var out = [];
    for (var i = 0; i < FONTS[pool].length; i++) {
      if (ready.indexOf(FONTS[pool][i].id) !== -1) out.push(FONTS[pool][i].id);
    }
    return out;
  }

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
      events: [],            /* [{ id, tier, life, variant, level }] */
      objects: [],           /* spawned bodies — step 4 */
      fontsReady: [],        /* font ids confirmed downloaded */
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

  /* Navigations past the gate. Zero for anyone who has not reached
     it, which is what makes pSpawn zero below the gate. */
  function depth(n) {
    return Math.max(0, n - T.eventGate);
  }

  function pSpawn(n) {
    if (n < T.eventGate) return 0;
    return Math.min(T.spawnMax, T.spawnBase + T.spawnSlope * depth(n));
  }

  function pRemove(n) {
    return T.removeBase * Math.exp(-depth(n) / T.removeDecay);
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

  function findEvent(state, id) {
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id === id) return state.events[i];
    }
    return null;
  }

  /* An event's own gate, falling back to its tier's. */
  function gateOf(id) {
    var def = EVENTS[id];
    if (typeof def.gate === "number") return def.gate;
    if (def.tier === "rare") return T.rareGate;
    return T.eventGate;
  }

  /* Resolve a variants entry to the ids available right now. Static
     arrays pass through; functions are asked. */
  function variantsOf(state, id) {
    var v = EVENTS[id].variants;
    if (!v) return null;
    return (typeof v === "function") ? v(state) : v;
  }

  function pickWeighted(items, weightOf) {
    var total = 0, i;
    for (i = 0; i < items.length; i++) total += weightOf(items[i]);
    if (total <= 0) return null;

    var r = Math.random() * total;
    for (i = 0; i < items.length; i++) {
      r -= weightOf(items[i]);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  function pickFontVariant(pool, ids) {
    var entries = [];
    for (var i = 0; i < FONTS[pool].length; i++) {
      if (ids.indexOf(FONTS[pool][i].id) !== -1) entries.push(FONTS[pool][i]);
    }
    var chosen = pickWeighted(entries, function (e) { return e.weight || 1; });
    return chosen ? chosen.id : null;
  }

  /* Which pool a font event draws from. */
  function fontPoolOf(id) {
    return id === "font-weird" ? "rare" : "common";
  }

  /* Pick an event of this tier that is eligible right now. */
  function pickEvent(state, tier, n) {
    var active = activeIds(state);
    var pool = [];

    for (var id in EVENTS) {
      var def = EVENTS[id];
      if (def.tier !== tier) continue;

      /* Already active, and not a leveling event that can climb. */
      if (active.indexOf(id) !== -1 && !def.level) continue;

      /* Its own gate, which may differ from its tier's. */
      if (n < gateOf(id)) continue;

      /* Mutual exclusion — sideways vs vertical, and similar. */
      if (def.excludes && def.excludes.some(function (other) {
        return active.indexOf(other) !== -1;
      })) continue;

      /* A variant event with nothing available cannot spawn. Fonts
         use this: no downloaded face means no font event, rather
         than an event that renders as Times. */
      var variants = variantsOf(state, id);
      if (variants && !variants.length) continue;

      pool.push(id);
    }

    if (!pool.length) return null;
    return pickWeighted(pool, function (i) { return EVENTS[i].weight || 1; });
  }

  /* Add the event, or advance it if it is already active and levels. */
  function spawnEvent(state, id, tier) {
    var def = EVENTS[id];
    var existing = findEvent(state, id);

    if (existing && def.level) {
      existing.level = (existing.level || 1) + 1;
      return { id: id, leveled: existing.level };
    }
    if (existing) return null;

    var record = { id: id, tier: tier, life: null };

    if (tier === "rare") {
      record.life = T.rareLifeMin +
        Math.floor(Math.random() * (T.rareLifeMax - T.rareLifeMin + 1));
    }
    if (def.level) record.level = 1;

    var variants = variantsOf(state, id);
    if (variants && variants.length) {
      record.variant = (id === "font-change" || id === "font-weird")
        ? pickFontVariant(fontPoolOf(id), variants)
        : variants[Math.floor(Math.random() * variants.length)];
    }

    state.events.push(record);
    return { id: id, leveled: 0, variant: record.variant };
  }

  function rollNavigation(state) {
    var n = state.counter;
    var log = { n: n, spawned: null, tier: null, removed: [], expired: [], gated: false };
    var justSpawned = null;
    var i, e;

    /* 0 · GATE ---------------------------------------------------- */
    /* Below the gate nothing rolls at all: no spawn, and no removal
       pass either. There is nothing active to remove, and running
       the pass would be dead work on every early navigation. */
    if (n < T.eventGate) {
      log.gated = true;
      state.lastRoll = log;
      return log;
    }

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
        var id = pickEvent(state, tier, n);
        if (id) {
          var result = spawnEvent(state, id, tier);
          if (result) {
            justSpawned = id;
            log.spawned = id +
              (result.variant ? ":" + result.variant : "") +
              (result.leveled ? " (L" + result.leveled + ")" : "");
          }
        }
        /* else: nothing of that tier is eligible — all active, all
           gated, or all excluded. Nothing spawns. */
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
    var i, e;

    root.setAttribute("data-drift", String(state.counter));
    root.style.setProperty("--drift-count", String(state.counter));
    root.setAttribute("data-event", activeIds(state).join(" "));

    /* Clear any variant/level attributes from a previous state, so
       applyDrift stays idempotent and safe to call on an already
       rendered page (the in-place navigations depend on that). */
    var stale = root.getAttributeNames().filter(function (name) {
      return name.indexOf("data-v-") === 0 || name.indexOf("data-l-") === 0;
    });
    for (i = 0; i < stale.length; i++) root.removeAttribute(stale[i]);

    for (i = 0; i < state.events.length; i++) {
      e = state.events[i];
      if (e.variant) root.setAttribute("data-v-" + e.id, e.variant);
      if (e.level) root.setAttribute("data-l-" + e.id, String(e.level));
    }
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
    DEBUG_ALLOWED: DEBUG_ALLOWED,
    DEBUG: DEBUG,
    T: T,
    EVENTS: EVENTS,
    FONTS: FONTS,
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
