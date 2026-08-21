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
     DEBUG READOUT
     Enable with ?drift=debug (sticky for the tab session) or
     localStorage.setItem("pf.drift.debug", "1").
     --------------------------------------------------------------- */

  var debugEl = null;

  function debugEnabled() {
    try {
      if (window.location.search.indexOf("drift=debug") !== -1) {
        window.sessionStorage.setItem("pf.drift.debug", "1");
      }
      return window.sessionStorage.getItem("pf.drift.debug") === "1" ||
             window.localStorage.getItem("pf.drift.debug") === "1";
    } catch (err) {
      return false;
    }
  }

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

    lines.push("spawn " + drift.pSpawn(state.counter).toFixed(2) +
               " · remove " +
               (state.counter < drift.T.breakingPoint
                 ? drift.pRemove(state.counter).toFixed(2) + " each"
                 : drift.T.postFlipRemoval.toFixed(2) + " once  [FLIPPED]"));

    if (roll) {
      lines.push("roll: " +
                 (roll.spawned ? "+" + roll.spawned + " (" + roll.tier + ")" : "no spawn") +
                 (roll.removed.length ? "  −" + roll.removed.join(" −") : "") +
                 (roll.expired.length ? "  ×" + roll.expired.join(" ×") : ""));
    }

    lines.push("active [" + state.events.length + "]: " +
               (state.events.map(function (e) { return e.id; }).join(", ") || "—"));

    debugEl.textContent = lines.join("\n");
  }

  if (debugEnabled()) {
    debugEl = document.createElement("div");
    debugEl.setAttribute("data-drift-debug", "");
    debugEl.style.cssText =
      "position:fixed;bottom:0;left:0;z-index:9999;" +
      "font:11px/1.5 ui-monospace,monospace;background:#000;color:#0f0;" +
      "padding:4px 7px;pointer-events:none;white-space:pre;";
    document.body.appendChild(debugEl);
    renderDebug();
  }

  /* ---------------------------------------------------------------
     CONSOLE HELPERS
     --------------------------------------------------------------- */

  drift.save = save;

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
