/* ===============================================================
   drift.js — deferred runtime
   ===============================================================
   Everything that does not need to happen before first paint:
   counting navigations, recording interaction timestamps for the
   reload heuristic, and (later) the three.js layer.

   Two classes of navigation, because they behave differently:

     PAGE-LOAD   internal link, back, forward
                 the document unloads; counter and roll are written
                 to storage and the next page reads them in boot.

     IN-PLACE    external link, new-tab click, lightbox open
                 the document stays; the counter changes, the roll
                 happens here, and the drift is re-applied live.
   =============================================================== */

(function () {
  "use strict";

  var drift = window.__drift;
  if (!drift) return;              /* boot script blocked or failed */

  var state = drift.state;

  /* Flush interaction timestamps at most this often. localStorage is
     synchronous and does not need per-event traffic. */
  var FLUSH_INTERVAL = 5000;
  var flushTimer = null;
  var dirty = false;

  function save() {
    drift.write(state);
    dirty = false;
  }

  function saveSoon() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = window.setTimeout(function () {
      flushTimer = null;
      if (dirty) save();
    }, FLUSH_INTERVAL);
  }

  /* ---------------------------------------------------------------
     COUNT
     --------------------------------------------------------------- */

  function increment(willUnload) {
    state.counter += 1;
    state.reloadCount = 0;         /* any navigation breaks the streak (§3) */
    state.pendingNav = !!willUnload;

    drift.rollNavigation(state);
    save();                        /* synchronous: may be about to unload */

    /* On a page-load navigation the next document paints the result.
       Repainting this one first would show the change on the page
       being left, which is exactly the flash we are avoiding. */
    if (!willUnload) {
      drift.applyDrift(state);
      renderDebug();
    }
  }

  function markInteraction() {
    state.lastInteractionAt = Date.now();
    saveSoon();
  }

  /* ---------------------------------------------------------------
     LINKS
     Capture phase on document, so this does not depend on the order
     drift.js and page.js happen to be evaluated in.
     --------------------------------------------------------------- */

  function isModifiedClick(event) {
    return event.metaKey || event.ctrlKey || event.shiftKey ||
           event.altKey || event.button !== 0;
  }

  document.addEventListener("click", function (event) {
    var anchor = event.target.closest && event.target.closest("a[href]");

    if (anchor) {
      var href = anchor.getAttribute("href");

      /* Same-page hash links are not navigation. This is the
         back-to-top link in page.js. */
      if (!href || href.charAt(0) === "#") return;

      var url;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch (err) {
        return;
      }

      var sameOrigin = url.origin === window.location.origin;
      var samePage = sameOrigin &&
                     url.pathname === window.location.pathname &&
                     url.search === window.location.search;

      /* A hash link written as a full path. Still not navigation. */
      if (samePage && url.hash) return;

      var newTab = anchor.target === "_blank" || isModifiedClick(event);

      markInteraction();

      /* Same-origin and staying in this tab: the document unloads.
         Otherwise this document survives and must show the change
         when the visitor comes back to the tab. */
      increment(sameOrigin && !newTab);
      return;
    }

    /* Lightbox open counts; closing does not. page.js makes every
       <img> in <main> a trigger, so mirror that test exactly. An
       image wrapped in a link was already handled above. */
    var img = event.target;
    if (img && img.tagName === "IMG" && img.closest("main")) {
      markInteraction();
      increment(false);
    }
  }, true);

  /* ---------------------------------------------------------------
     BACK / FORWARD OUT OF THE BFCACHE
     A restored page does not re-run boot, so the increment and roll
     happen here. They land one frame after the restored paint; that
     is unavoidable and only affects back/forward.
     --------------------------------------------------------------- */

  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;

    /* Storage may have moved on in another tab. */
    state = drift.state = drift.read();
    state.counter += 1;
    state.reloadCount = 0;
    drift.rollNavigation(state);
    save();
    drift.applyDrift(state);
    renderDebug();
  });

  /* ---------------------------------------------------------------
     RELOAD-DETECTION SIGNALS (§12)
     --------------------------------------------------------------- */

  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (name) {
    window.addEventListener(name, markInteraction, { passive: true });
  });

  var scrollTimer = null;
  window.addEventListener("scroll", function () {
    if (scrollTimer) return;
    scrollTimer = window.setTimeout(function () {
      scrollTimer = null;
      markInteraction();
    }, 250);
  }, { passive: true });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      /* Fires both for a real backgrounding and as part of the
         teardown before an unload. Boot tells them apart by the age
         of this stamp — see isHumanReload in drift-boot.js. */
      state.lastHiddenAt = Date.now();
      save();                      /* may not get another chance */
    } else {
      state.lastVisibleAt = Date.now();
      saveSoon();
    }
  });

  /* pagehide is the last reliable point on iOS; unload is not. */
  window.addEventListener("pagehide", function () {
    if (dirty) save();
  });

  /* ---------------------------------------------------------------
     FONT LOADER
     ---------------------------------------------------------------
     Strict eligibility: a font event can only pick a face that is
     already downloaded, so the variant always renders instantly and
     there is never a visible swap mid-event.

     document.fonts is per-document and starts empty on every page,
     so a font fetched on the previous page would look unavailable
     here. The confirmed list is therefore persisted in state and
     re-resolved on each page — a cache hit, a few milliseconds, and
     font-display: swap covers those milliseconds with Termes.
     --------------------------------------------------------------- */

  var TRICKLE_GATE = 3;        /* start fetching this early */
  var TRICKLE_PAUSE = 400;     /* ms between files, so images win */

  function fontQueue() {
    /* Below the rare gate, commons only — a rare face fetched early
       is wasted data for a visitor who never reaches n=55. At or
       past it, one of each first, then alternate. */
    var commons = drift.FONTS.common.slice();
    var rares = drift.FONTS.rare.slice();

    if (state.counter < drift.T.rareGate) return commons;

    var out = [];
    while (commons.length || rares.length) {
      if (commons.length) out.push(commons.shift());
      if (rares.length) out.push(rares.shift());
    }
    return out;
  }

  function markReady(id) {
    if (!state.fontsReady) state.fontsReady = [];
    if (state.fontsReady.indexOf(id) !== -1) return;
    state.fontsReady.push(id);
    saveSoon();
  }

  function loadFont(entry) {
    /* Asking for the family triggers the @font-face fetch. No link
       tags, no preload — the CSS rule is enough. */
    return document.fonts.load('1em "' + entry.family + '"')
      .then(function (faces) {
        if (faces && faces.length) markReady(entry.id);
      })
      .catch(function () { /* a missing file just stays ineligible */ });
  }

  function startFontLoading() {
    if (!document.fonts || !document.fonts.load) return;

    var queue = fontQueue();
    var i = 0;

    /* A returning visitor already past the gate can have an event
       fire on the very next navigation with nothing cached. They
       have demonstrated depth, so skip the idle wait. */
    var urgent = state.counter >= drift.T.eventGate;

    function next() {
      if (i >= queue.length) return;
      var entry = queue[i++];

      if ((state.fontsReady || []).indexOf(entry.id) !== -1) {
        next();                                  /* already have it */
        return;
      }

      loadFont(entry).then(function () {
        window.setTimeout(next, urgent ? 0 : TRICKLE_PAUSE);
      });
    }

    if (urgent) {
      next();
    } else if (state.counter >= TRICKLE_GATE) {
      /* Wait for images and the rest of the page to settle first. */
      if (window.requestIdleCallback) {
        window.requestIdleCallback(next, { timeout: 3000 });
      } else {
        window.setTimeout(next, 1200);
      }
    }
  }

  if (document.readyState === "complete") {
    startFontLoading();
  } else {
    window.addEventListener("load", startFontLoading);
  }

  /* ---------------------------------------------------------------
     DEBUG READOUT
     Enable with ?drift=debug (sticky for the tab session) or
     localStorage.setItem("pf.drift.debug", "1").
     --------------------------------------------------------------- */

  var debugEl = null;

  function renderDebug() {
    if (!debugEl) return;

    var roll = state.lastRoll;
    var lines = [];

    var verdict = "";
    if (drift.navigationType === "reload") {
      verdict = drift.didReset ? " · HUMAN → RESET" : " · EVICTION → kept";
    }

    lines.push("n " + state.counter +
               " · " + drift.navigationType +
               verdict +
               " · reloads " + state.reloadCount);

    if (state.counter < drift.T.eventGate) {
      lines.push("GATED · events open at n " + drift.T.eventGate);
    } else {
      lines.push("spawn " + drift.pSpawn(state.counter).toFixed(2) +
                 " · remove " +
                 (state.counter < drift.T.breakingPoint
                   ? drift.pRemove(state.counter).toFixed(2) + " each"
                   : drift.T.postFlipRemoval.toFixed(2) + " once  [FLIPPED]"));
    }

    if (roll && !roll.gated) {
      lines.push("roll: " +
                 (roll.spawned ? "+" + roll.spawned + " (" + roll.tier + ")" : "no spawn") +
                 (roll.removed.length ? "  −" + roll.removed.join(" −") : "") +
                 (roll.expired.length ? "  ×" + roll.expired.join(" ×") : ""));
    }

    lines.push("active [" + state.events.length + "]: " +
               (state.events.map(function (e) {
                  return e.id +
                         (e.variant ? ":" + e.variant : "") +
                         (e.level ? " L" + e.level : "");
                }).join(", ") || "—"));

    var ready = (state.fontsReady || []).length;
    var totalFonts = drift.FONTS.common.length + drift.FONTS.rare.length;
    lines.push("fonts " + ready + "/" + totalFonts + " ready");

    debugEl.textContent = lines.join("\n");
  }

  if (drift.DEBUG) {
    debugEl = document.createElement("div");
    debugEl.setAttribute("data-drift-debug", "");
    debugEl.style.cssText =
      "position:fixed;bottom:0;left:0;z-index:9999;" +
      "font:11px/1.5 ui-monospace,monospace;background:#000;color:#0f0;" +
      "padding:4px 7px;pointer-events:none;white-space:pre;";
    document.body.appendChild(debugEl);
    renderDebug();
    console.log("drift debug on — __drift.help() for commands");
  }

  /* ---------------------------------------------------------------
     CONSOLE HELPERS
     --------------------------------------------------------------- */

  /* ---------------------------------------------------------------
     CONSOLE HELPERS
     All of these vanish when DEBUG_ALLOWED is false in drift-boot.js.
     Flip that one constant before launch.
     --------------------------------------------------------------- */

  if (!drift.DEBUG_ALLOWED) return;

  drift.save = save;

  /* Turn the readout on or off without editing a URL. */
  drift.debugOn = function () {
    try { window.localStorage.setItem("pf.drift.debug", "1"); } catch (err) {}
    window.location.reload();
  };

  drift.debugOff = function () {
    try {
      window.localStorage.removeItem("pf.drift.debug");
      window.sessionStorage.removeItem("pf.drift.debug");
    } catch (err) {}
    window.location.reload();
  };

  drift.reset = function () {
    state = drift.state = drift.defaults();
    save();
    drift.applyDrift(state);
    renderDebug();
  };

  /* Jump the counter without clicking, to inspect a deep state. */
  drift.jump = function (n) {
    state.counter = n;
    save();
    drift.applyDrift(state);
    renderDebug();
  };

  /* ---------------------------------------------------------------
     HELP
     One table, printed by __drift.help(). Add a row here whenever a
     new helper is added below, or it will not be discoverable.
     --------------------------------------------------------------- */

  var HELP = [
    ["state", null, null],
    ["__drift.state", "the whole persisted state object"],
    ["__drift.state.counter", "current counter value"],
    ["__drift.reset()", "counter to 0, events and objects cleared"],
    ["__drift.jump(n)", "set the counter directly, without navigating"],

    ["events", null, null],
    ["__drift.eventList()", "print every event as a force() command, and copy"],
    ["__drift.force(id)", "turn one event on by hand"],
    ["__drift.forceAll()", "every registered event at once — finds collisions"],
    ["__drift.clear()", "remove all active events"],
    ["__drift.variants(id)", "cycle through one event's variants"],
    ["__drift.EVENTS", "the raw event registry"],

    ["fonts", null, null],
    ["__drift.fontList()", "print every font id, and copy the list"],
    ["__drift.tryFont(id)", "download and apply one face immediately"],
    ["__drift.fontsAll()", "mark all fonts eligible without downloading"],

    ["tuning", null, null],
    ["__drift.T", "every tuning constant — editable live"],
    ["__drift.simulate(n)", "run n navigations against a throwaway state"],
    ["__drift.pSpawn(n)", "spawn probability at counter n"],
    ["__drift.pRemove(n)", "per-event removal chance at counter n"],

    ["debug", null, null],
    ["__drift.box(false)", "hide the readout, keep the helpers"],
    ["__drift.box()", "show it again"],
    ["__drift.debugOn()", "enable debug (persists, reloads)"],
    ["__drift.debugOff()", "disable it and clear the flags"],
    ["?drift=debug", "same as debugOn, via the URL"],
    ["?drift=off", "same as debugOff, via the URL"]
  ];

  drift.help = function () {
    var pad = 0;
    HELP.forEach(function (row) {
      if (row[1] && row[0].length > pad) pad = row[0].length;
    });

    var out = [];
    HELP.forEach(function (row) {
      if (row[1] === null) {
        out.push("");
        out.push("  " + row[0].toUpperCase());
      } else {
        out.push("  " + row[0] + Array(pad - row[0].length + 3).join(" ") +
                 "  " + row[1]);
      }
    });

    console.log(out.join("\n"));
    console.log("");
    console.log("  Gates: events " + drift.T.eventGate +
                " · breaking point " + drift.T.breakingPoint +
                " · rares " + drift.T.rareGate);
    console.log("  Set DEBUG_ALLOWED = false in drift-boot.js before launch.");
  };

  /* Hide or show the readout without touching the debug flags, so
     the helpers stay available and the setting survives. Useful for
     looking at the page properly mid-test. */
  drift.box = function (on) {
    if (!debugEl) {
      console.log("no readout — run __drift.debugOn() first");
      return;
    }
    on = (on !== false);
    debugEl.style.display = on ? "" : "none";
    console.log("readout " + (on ? "shown" : "hidden") +
                " (flags untouched — helpers still work)");
  };

  /* Step through one event's variants, one call at a time. The
     fastest way to eyeball a whole pool — call it repeatedly. */
  var cycleAt = {};
  drift.variants = function (id) {
    var def = drift.EVENTS[id];
    if (!def) {
      console.warn("no such event: " + id, Object.keys(drift.EVENTS));
      return;
    }
    var pool = (typeof def.variants === "function")
      ? def.variants(state) : def.variants;

    if (!pool || !pool.length) {
      console.warn(id + " has no variants" +
                   (typeof def.variants === "function"
                     ? " available — try __drift.fontsAll()" : ""));
      return;
    }

    cycleAt[id] = (cycleAt[id] === undefined) ? 0 : (cycleAt[id] + 1) % pool.length;
    var v = pool[cycleAt[id]];

    state.events = state.events.filter(function (e) { return e.id !== id; });
    state.events.push({
      id: id,
      tier: def.tier,
      life: def.tier === "rare" ? drift.T.rareLifeMax : null,
      variant: v
    });
    drift.applyDrift(state);
    renderDebug();
    console.log(id + " -> " + v +
                "  (" + (cycleAt[id] + 1) + "/" + pool.length + ")");
  };

  /* Print every registered event as a ready-to-run force() command,
     grouped by tier, and put the list on the clipboard. Mirrors
     fontList(). */
  drift.eventList = function () {
    var lines = [];

    ["common", "rare"].forEach(function (tier) {
      var ids = Object.keys(drift.EVENTS).filter(function (id) {
        return drift.EVENTS[id].tier === tier;
      });
      if (!ids.length) return;

      lines.push("/* " + tier + " */");

      var pad = 0;
      ids.forEach(function (id) {
        if (id.length > pad) pad = id.length;
      });

      ids.forEach(function (id) {
        var def = drift.EVENTS[id];
        var notes = [];

        var gate = (typeof def.gate === "number") ? def.gate
                 : (tier === "rare" ? drift.T.rareGate : drift.T.eventGate);
        notes.push("gate " + gate);
        if (def.weight && def.weight !== 1) notes.push("weight " + def.weight);
        if (def.level) notes.push("levels");
        if (def.variants) notes.push("variants");
        if (def.excludes) notes.push("excludes " + def.excludes.join("/"));

        var cmd = '__drift.force("' + id + '")';
        var gap = Array(pad - id.length + 3).join(" ");
        lines.push(cmd + gap + "  // " + notes.join(", "));
      });

      lines.push("");
    });

    var text = lines.join("\n");
    console.log(text);

    try {
      navigator.clipboard.writeText(text);
      console.log("(copied to clipboard)");
    } catch (err) {
      console.log("(clipboard blocked — select the text above)");
    }

    return Object.keys(drift.EVENTS);
  };

  /* Print every font id, grouped by pool, and put a copy-pasteable
     list on the clipboard. */
  drift.fontList = function () {
    var lines = [];

    ["common", "rare"].forEach(function (pool) {
      lines.push("/* " + pool + " */");
      drift.FONTS[pool].forEach(function (f) {
        lines.push('__drift.tryFont("' + f.id + '")   // ' + f.family);
      });
      lines.push("");
    });

    var text = lines.join("\n");
    console.log(text);

    try {
      navigator.clipboard.writeText(text);
      console.log("(copied to clipboard)");
    } catch (err) {
      console.log("(clipboard blocked — select the text above)");
    }

    return drift.FONTS.common.concat(drift.FONTS.rare)
      .map(function (f) { return f.id; });
  };

  /* Force every font to be eligible without downloading, so events
     can be tested before the trickle finishes. */
  drift.fontsAll = function () {
    state.fontsReady = drift.FONTS.common.concat(drift.FONTS.rare)
      .map(function (f) { return f.id; });
    save();
    console.log(state.fontsReady.length + " fonts marked ready");
  };

  /* Preview one face immediately, bypassing the roll. */
  drift.tryFont = function (id) {
    var all = drift.FONTS.common.concat(drift.FONTS.rare);
    var entry = all.filter(function (f) { return f.id === id; })[0];
    if (!entry) {
      console.warn("no such font: " + id, all.map(function (f) { return f.id; }));
      return;
    }
    var pool = drift.FONTS.common.indexOf(entry) !== -1 ? "common" : "rare";
    var ev = pool === "common" ? "font-change" : "font-weird";

    document.fonts.load('1em "' + entry.family + '"').then(function () {
      state.events = state.events.filter(function (e) {
        return e.id !== "font-change" && e.id !== "font-weird";
      });
      state.events.push({ id: ev, tier: pool === "common" ? "common" : "rare",
                          life: null, variant: id });
      drift.applyDrift(state);
      renderDebug();
      console.log(ev + " -> " + id + " (" + entry.family + ")");
    });
  };

  /* Turn an event on by hand, to look at it without waiting for the
     roll. Not persisted deliberately — the next navigation's roll
     will remove it like any other. */
  drift.force = function (id) {
    var def = drift.EVENTS[id];
    if (!def) {
      console.warn("no such event: " + id,
                   "registered:", Object.keys(drift.EVENTS));
      return;
    }

    var existing = state.events.filter(function (e) { return e.id === id; })[0];

    /* A leveling event forced again climbs, like a real re-roll. */
    if (existing) {
      if (!def.level) return;
      existing.level = (existing.level || 1) + 1;
      drift.applyDrift(state);
      renderDebug();
      return;
    }

    var record = {
      id: id,
      tier: def.tier,
      life: def.tier === "rare" ? drift.T.rareLifeMax : null
    };
    if (def.level) record.level = 1;

    /* Resolve variants the same way the roll does, so forcing an
       event is not a different code path from spawning one. */
    if (def.variants) {
      var pool = (typeof def.variants === "function")
        ? def.variants(state) : def.variants;

      if (!pool || !pool.length) {
        console.warn(id + " has no eligible variants. " +
                     "For fonts, run __drift.fontsAll() first.");
        return;
      }
      record.variant = pool[Math.floor(Math.random() * pool.length)];
    }

    state.events.push(record);
    drift.applyDrift(state);
    renderDebug();
  };

  drift.clear = function () {
    state.events = [];
    drift.applyDrift(state);
    renderDebug();
  };

  /* Every registered event at once — the worst case, and the only
     way to see whether two of them fight. */
  drift.forceAll = function () {
    Object.keys(drift.EVENTS).forEach(drift.force);
  };

  /* Run the roll many times against a throwaway state and report how
     the active set behaves at each depth. This is how the tuning
     constants get checked without clicking two hundred links. */
  drift.simulate = function (steps, sampleEvery) {
    steps = steps || 120;
    sampleEvery = sampleEvery || 10;

    var sim = drift.defaults();
    var rows = [];

    for (var i = 1; i <= steps; i++) {
      sim.counter = i;
      drift.rollNavigation(sim);
      if (i % sampleEvery === 0) {
        rows.push({
          n: i,
          active: sim.events.length,
          pSpawn: +drift.pSpawn(i).toFixed(2),
          mode: i < drift.T.breakingPoint ? "per-event" : "single"
        });
      }
    }
    console.table(rows);
    return rows;
  };
})();
