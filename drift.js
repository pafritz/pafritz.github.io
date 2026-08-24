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
      applyDomEvents();
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
    applyDomEvents();
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
    stopLineShuffle();
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
     TEXT ENGINE
     ---------------------------------------------------------------
     Shared machinery for every event that decorates the page's text
     rather than overriding a token. One owner, so two active events
     never fight over the same text nodes.

     It only ever replaces TEXT nodes. Elements are untouched, which
     matters: page.js binds the lightbox to every <img> in main at
     load, and those listeners must survive.

     Teardown restores the original text and calls normalize(), so
     the DOM returns to exactly what the generator produced.
     --------------------------------------------------------------- */

  var TEXT = (function () {

    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1 };

    function collect() {
      var out = [];
      var walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null, false);
      var node;

      while ((node = walker.nextNode())) {
        var parent = node.parentNode;
        if (!parent || SKIP[parent.nodeName]) continue;
        if (!node.nodeValue) continue;

        /* Never touch our own debug readout, the lightbox overlay
           page.js appends, or anything already wrapped. */
        if (parent.closest("[data-drift-debug], .lightbox-overlay, [data-drift-text]")) {
          continue;
        }
        out.push(node);
      }
      return out;
    }

    /* One flat string across every text node, plus a map from each
       character back to the node and offset it came from. Matching
       against the flat string means a sequence can run across
       element boundaries — through an <em>, into the next
       paragraph — which is the whole point. */
    function flatten(nodes) {
      var text = "";
      var map = [];
      for (var n = 0; n < nodes.length; n++) {
        var value = nodes[n].nodeValue;
        for (var i = 0; i < value.length; i++) map.push([n, i]);
        text += value;
      }
      return { text: text, map: map };
    }

    /* Letters the page can be MADE to supply.

       English letter frequencies are wildly uneven: z is 0.07% and
       e is 12.7%, so a single z costs roughly 1400 characters of
       text to find while an e costs eight. Without this, "zero zero
       zero zero" needs about 5900 characters to spell and "twenty
       ten" needs 200 -- a 30x difference in difficulty decided
       entirely by which code a visitor was handed.

       So when the wanted letter is not within reach, a nearby
       lookalike is ALTERED into it: the page's `s` is rewritten as
       a `z`, and the word around it becomes "zeries". The red
       letters therefore always spell the code exactly.

       That is the right trade because the code is functional -- it
       opens the lock. A misread code is a broken puzzle; a typo in
       a caption is just the page being slightly wrong, which is
       what this site is impersonating anyway.

       Nothing is inserted. A character is transformed in place, so
       the word length, the line breaks and the layout are all
       unchanged, and teardown restores the original letter exactly.

       Pairs are chosen to look like plausible slips: voiced against
       unvoiced, or shapes that already trade places in handwriting
       and in other languages. */

    var SUBSTITUTES = {
      z: ["s"],           /* z 0.07%  <- s 6.3%   "series" -> "zeries" */
      x: ["s", "k"],      /* x 0.15%                                   */
      v: ["f", "u"],      /* v 0.98%  <- f 2.2%   "after" -> "avter"   */
      w: ["v", "u", "m"], /* w 2.4%                                    */
      y: ["i", "v"],      /* y 2%     <- i 7%     "in" -> "yn"         */
      g: ["k", "q"],      /* g 2%                                      */
      f: ["t"],           /* f 2.2%   <- t 9.1%                        */
      h: ["b", "k"],      /* h 6.1%                                    */
      u: ["v", "n"]       /* u 2.8%                                    */
    };

    /* How far ahead a real letter may be before a nearer substitute
       is preferred. Beyond this the sequence has visibly stopped
       tracking the text and starts to read as coincidence. */
    var REACH = 500;

    /* Walk the needle one character at a time, each match strictly
       after the last, never wrapping around.

       Per letter: take the real one if it is within reach; else the
       nearest substitute within reach; else the real one however
       far ahead it is; else stop. Returns however many it managed
       -- a short page simply runs out, which is fine. */
    function findSequence(hay, needle) {
      var found = [];
      var at = 0;
      var H = hay.toLowerCase();
      var N = needle.toLowerCase();

      for (var k = 0; k < N.length; k++) {
        var want = N[k];
        var limit = at + REACH;

        var idx = H.indexOf(want, at);
        var swapped = false;

        if (idx === -1 || idx > limit) {
          var alts = SUBSTITUTES[want] || [];
          var nearest = -1;

          for (var a = 0; a < alts.length; a++) {
            var j = H.indexOf(alts[a], at);
            if (j !== -1 && j <= limit && (nearest === -1 || j < nearest)) {
              nearest = j;
            }
          }

          /* A substitute close by beats the real letter far away. */
          if (nearest !== -1) {
            idx = nearest;
            swapped = true;
          }
        }

        if (idx === -1) break;
        found.push({ at: idx, swapped: swapped });
        at = idx + 1;
      }
      return found;
    }

    /* Match the case of the letter being replaced, so a capital at
       the start of a sentence stays a capital. */
    function matchCase(letter, model) {
      return (model === model.toUpperCase() && model !== model.toLowerCase())
        ? letter.toUpperCase()
        : letter;
    }

    function wrapChar(node, offset, mark, wanted) {
      var target = node.splitText(offset);
      target.splitText(1);

      var original = target.nodeValue;
      var shown = original;

      /* The wanted letter is not what the page had, so change the
         page. The original is kept on the span; teardown puts it
         back, so the DOM returns to exactly what the generator
         produced. */
      if (wanted && wanted !== original.toLowerCase()) {
        shown = matchCase(wanted, original);
      }

      var span = document.createElement("span");
      span.setAttribute("data-drift-text", mark);
      if (shown !== original) span.setAttribute("data-drift-was", original);
      span.appendChild(document.createTextNode(shown));

      target.parentNode.replaceChild(span, target);
      return span;
    }

    /* Wrap a block's inline contents in a single span.

       Different from the character wrapping above: nothing is split
       and no text is altered, the existing child nodes are simply
       moved into a wrapper. That matters because an inline element
       paints its background across each of its LINE FRAGMENTS,
       spaces included, ending ragged where the text ends on the
       last line. A block element's background would fill the whole
       box instead, tail and all, which reads as a filled rectangle
       rather than as redacted text.

       Nodes are moved, never recreated, so any listener bound to a
       descendant survives — page.js binds the lightbox to every
       <img> in main at load and those must keep working. */
    /* Elements that only mean anything as a DIRECT child of their
       parent. A <legend> renders as the fieldset's frame title only
       while it is a direct child; move it inside a span and it stops
       being a legend and drops into the content flow, taking the
       frame's title with it. <summary> behaves the same way inside
       <details>.

       These stay where they are and the wrapper takes everything
       else. */
    var STRUCTURAL = { LEGEND: 1, SUMMARY: 1, CAPTION: 1 };

    function wrapBlock(block, mark) {
      if (block.querySelector("[data-drift-block]")) return null;

      var wrapper = document.createElement("span");
      wrapper.setAttribute("data-drift-block", mark);

      var kids = [].slice.call(block.childNodes);
      var moved = 0;

      for (var i = 0; i < kids.length; i++) {
        var kid = kids[i];
        if (kid.nodeType === 1 && STRUCTURAL[kid.nodeName]) continue;
        wrapper.appendChild(kid);
        moved++;
      }

      if (!moved) return null;

      /* Structural children kept their positions, so appending the
         wrapper leaves a legend first and the wrapped content after
         it, which is the original order. */
      block.appendChild(wrapper);
      return wrapper;
    }

    return {
      /* Wrap every matching block. Returns how many were wrapped.

         Processed in REVERSE document order, innermost first. Two
         selectors can match a parent and its child -- credits are a
         .project-credits containing .line-break-line elements, and
         style.css makes those display: block. A block-level child
         inside an inline wrapper breaks the inline background, so
         the bar cannot paint across it and the credits stay bare.

         Going backwards, the child wraps first and wrapBlock then
         refuses the parent because it already contains a wrapper.
         The innermost element that actually forms line boxes is the
         one that gets painted. */
      /* Wrap every word in the matching blocks.

         Whitespace stays as text nodes between the spans, so word
         spacing, line breaking and justification all behave exactly
         as before. Only the words themselves become elements.

         Capped: wrapping is O(words), and a long project page
         should not pay an unbounded cost for one rare event. */
      words: function (selector, mark, limit) {
        limit = limit || 4000;

        var blocks = document.querySelectorAll(selector);
        var count = 0;

        for (var b = 0; b < blocks.length && count < limit; b++) {
          var block = blocks[b];
          if (block.closest("[data-drift-debug], .lightbox-overlay")) continue;

          /* Collect first -- the walker would otherwise trip over
             the nodes being replaced underneath it. */
          var texts = [];
          var walker = document.createTreeWalker(
            block, NodeFilter.SHOW_TEXT, null, false);
          var node;
          while ((node = walker.nextNode())) {
            if (!node.parentNode || SKIP[node.parentNode.nodeName]) continue;
            if (node.parentNode.closest("[data-drift-word]")) continue;
            if (node.nodeValue && node.nodeValue.trim()) texts.push(node);
          }

          for (var i = 0; i < texts.length && count < limit; i++) {
            var text = texts[i];
            var parts = text.nodeValue.split(/(\s+)/);
            var frag = document.createDocumentFragment();

            for (var p = 0; p < parts.length; p++) {
              if (!parts[p]) continue;

              if (/^\s+$/.test(parts[p])) {
                frag.appendChild(document.createTextNode(parts[p]));
              } else {
                var span = document.createElement("span");
                span.setAttribute("data-drift-word", mark);
                span.appendChild(document.createTextNode(parts[p]));
                frag.appendChild(span);
                count++;
              }
            }
            text.parentNode.replaceChild(frag, text);
          }
        }
        return count;
      },

      /* Group the wrapped words into the lines the browser actually
         produced.

         Lines are not elements -- they are the output of reflow, and
         measuring is the only way to find them. Words sharing a
         vertical position are on the same line.

         Rounded to the nearest pixel, because subpixel variation
         within one line is normal. Keyed per block as well, so two
         blocks whose lines happen to align are not merged. */
      lines: function () {
        var spans = document.querySelectorAll("span[data-drift-word]");
        var groups = [];
        var index = {};
        var seq = 0;

        for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          var rect = span.getBoundingClientRect();
          if (!rect.width && !rect.height) continue;      /* hidden */

          var block = span.parentElement;
          while (block && getComputedStyle(block).display === "inline") {
            block = block.parentElement;
          }
          if (!block) block = document.body;

          var key = block.getAttribute("data-drift-blockid");
          if (!key) {
            key = String(seq++);
            block.setAttribute("data-drift-blockid", key);
          }

          var line = key + "@" + Math.round(rect.top);
          if (!index[line]) {
            index[line] = [];
            groups.push(index[line]);
          }
          index[line].push(span);
        }
        return groups;
      },

      blocks: function (selector, mark) {
        var blocks = document.querySelectorAll(selector);
        var count = 0;

        for (var i = blocks.length - 1; i >= 0; i--) {
          var block = blocks[i];

          if (block.closest("[data-drift-debug], .lightbox-overlay")) continue;
          if (block.hasAttribute("data-drift-block")) continue;
          if (block.closest("[data-drift-block]")) continue;
          if (!block.textContent || !block.textContent.trim()) continue;

          if (wrapBlock(block, mark)) count++;
        }
        return count;
      },

      /* Colour every occurrence of one whole word.

         Links are skipped: the point is a word in body text taking
         on a link-like colour without being clickable, and a real
         link doing that is just a link.

         Matched per text node rather than across the flattened
         page, because a word only means anything unbroken -- and a
         word split across an <em> boundary is not a word anyone
         reads as one. */
      word: function (word, mark) {
        if (!word) return 0;

        var nodes = collect();
        var escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var pattern = new RegExp("\\b" + escaped + "\\b", "gi");
        var count = 0;

        for (var n = 0; n < nodes.length; n++) {
          var node = nodes[n];
          if (node.parentNode.closest("a")) continue;

          var hits = [];
          var m;
          pattern.lastIndex = 0;
          while ((m = pattern.exec(node.nodeValue)) !== null) {
            hits.push({ at: m.index, length: m[0].length });
            if (m.index === pattern.lastIndex) pattern.lastIndex++;
          }
          if (!hits.length) continue;

          /* Descending, so an earlier offset stays valid after a
             later split. */
          for (var h = hits.length - 1; h >= 0; h--) {
            var tail = node.splitText(hits[h].at);
            tail.splitText(hits[h].length);

            var span = document.createElement("span");
            span.setAttribute("data-drift-text", mark);
            span.appendChild(document.createTextNode(tail.nodeValue));
            tail.parentNode.replaceChild(span, tail);
            count++;
          }
        }
        return count;
      },

      /* Colour the characters of `needle` in order across the page.
         Returns how many were placed. */
      sequence: function (needle, mark) {
        var nodes = collect();
        if (!nodes.length) return { placed: 0, altered: 0, reading: "" };

        var flat = flatten(nodes);
        var hits = findSequence(flat.text, needle);
        if (!hits.length) return { placed: 0, altered: 0, reading: "" };

        var swaps = 0;
        var i;

        /* Descending, so splitting a node never invalidates an
           earlier offset in that same node. */
        for (i = hits.length - 1; i >= 0; i--) {
          var where = flat.map[hits[i].at];
          wrapChar(nodes[where[0]], where[1], mark, needle.charAt(i));
        }
        for (i = 0; i < hits.length; i++) if (hits[i].swapped) swaps++;

        /* The reading is always the code itself now -- altered
           letters are rewritten, not accepted as near-misses. */
        return {
          placed: hits.length,
          altered: swaps,
          reading: needle.slice(0, hits.length)
        };
      },

      teardown: function () {
        /* Word spans first, then blocks, then characters. Each layer
           can contain the next, so unwrapping outside-in would leave
           orphans behind. */
        var words = document.querySelectorAll("span[data-drift-word]");
        for (var w = 0; w < words.length; w++) {
          var word = words[w];
          var owner = word.parentNode;
          if (!owner) continue;
          owner.replaceChild(document.createTextNode(word.textContent), word);
          owner.normalize();
        }

        var tagged = document.querySelectorAll("[data-drift-blockid]");
        for (var t = 0; t < tagged.length; t++) {
          tagged[t].removeAttribute("data-drift-blockid");
        }

        /* Blocks next: unwrapping moves children back out, and a
           character span may be sitting inside one. */
        var wrappers = document.querySelectorAll("span[data-drift-block]");
        for (var w = 0; w < wrappers.length; w++) {
          var wrap = wrappers[w];
          var host = wrap.parentNode;
          if (!host) continue;
          while (wrap.firstChild) host.insertBefore(wrap.firstChild, wrap);
          host.removeChild(wrap);
        }

        var spans = document.querySelectorAll("span[data-drift-text]");
        for (var i = 0; i < spans.length; i++) {
          var span = spans[i];
          var parent = span.parentNode;
          if (!parent) continue;

          /* An altered letter goes back to what it was, not to what
             it was showing. */
          var text = span.hasAttribute("data-drift-was")
            ? span.getAttribute("data-drift-was")
            : span.textContent;

          parent.replaceChild(document.createTextNode(text), span);
          parent.normalize();
        }
      }
    };
  })();

  /* ---------------------------------------------------------------
     DOM EVENTS
     Run after applyDrift, since they need a body to work on. Torn
     down and rebuilt each time rather than diffed: the page is
     freshly generated on every load anyway, and diffing text
     positions would cost more than redoing them.
     --------------------------------------------------------------- */

  /* The code is read as two pairs -- 1799 becomes "seventeen
     ninety nine", 0068 becomes "zero zero sixty eight".

     This is how a person actually reads a four-dial lock out loud,
     and it solves two problems at once.

     Truncation. "nine four six" gives no way to tell whether it is
     946, 9460, or the start of 9467. A pair carries its own
     grammar: "seventeen ninety" is visibly missing a unit, so the
     visitor knows they only got part of it and should keep looking.

     Leading zeros. Reading the whole number would turn 0068 into
     "sixty eight" and lose the padding. Pairs keep every dial.

     It is also the shortest of the three readings, so it truncates
     least often. */

  var ONES = ["zero", "one", "two", "three", "four", "five",
              "six", "seven", "eight", "nine"];
  var TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen",
               "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  var TENS = ["", "", "twenty", "thirty", "forty", "fifty",
              "sixty", "seventy", "eighty", "ninety"];

  /* 0-99. A leading zero is spoken, so 07 is "zero seven" and not
     "seven" -- the dial is what is being read, not the value. */
  function pairToWords(n) {
    if (n < 10) return "zero " + ONES[n];
    if (n < 20) return TEENS[n - 10];
    var t = TENS[Math.floor(n / 10)];
    var o = n % 10;
    return o ? t + " " + ONES[o] : t;
  }

  function codeAsWords(code) {
    return pairToWords(parseInt(code.slice(0, 2), 10)) + " " +
           pairToWords(parseInt(code.slice(2, 4), 10));
  }

  /* What the engine actually hunts for: the same words with the
     spaces removed, since it matches letters, not words. */
  function codeAsLetters(code) {
    return codeAsWords(code).replace(/\s+/g, "");
  }

  /* A small seeded generator, so a line event re-applied on the
     same page view (a lightbox open re-runs the whole DOM pass)
     produces the same angles rather than reshuffling under the
     visitor. The seed lives on the event record, so it also
     survives across navigations while the event is active. */
  function seeded(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* THE MARKED WORDS
     ---------------------------------------------------------------
     Every occurrence of these takes a muted navy -- close enough to
     the link blue that it reads as a link which will not click,
     which is a sharper wrongness than any colour that reads as
     decoration.

     ALWAYS ON. Not an event: it does not roll, it does not expire,
     and it is not gated. It is part of how the site looks.

     The one cost of living here rather than in build_pages.py is
     that it lands a frame after first paint, so the word is black
     for an instant. Navy against black is a soft enough change that
     it does not register, which is why this is worth the simplicity
     of keeping the whole feature in one file.

     A list rather than one word, so a page missing one still shows
     another. All of them are marked, not one picked at random: a
     single instance reads as an accident, several read as a rule,
     and a rule is what makes a visitor try clicking.

     Phrases work too -- "the work" matches the phrase and not "the
     working", because the boundaries apply at each end. Longer
     entries are matched first, so a phrase beats a word inside it.

     __drift.tryWord("x") or __drift.tryWord(["x","y"]) previews any
     of it live. */
  var MARKED_WORDS = ["work"];

  /* SKEW-LINES SHUFFLE
     ---------------------------------------------------------------
     The angles are re-rolled roughly once a second while the event
     is active, so the page keeps twitching rather than settling.
     Everything else in this system is a static difference between
     states; this one moves, deliberately.

     Which means prefers-reduced-motion applies. Continuous movement
     of body text is exactly the case that flag exists for, so under
     it the lines are skewed once and then left alone -- the same
     end state, without the travel.

     Only the custom property is rewritten on each tick. No
     re-wrapping, no re-measuring: the line groups are already known
     and nothing has reflowed. */

  var SHUFFLE_INTERVAL = 1000;
  var lineTimer = null;

  function reducedMotion() {
    return window.matchMedia &&
           window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function shuffleLines(groups, rand) {
    rand = rand || Math.random;
    var k = drift.intensityAt(state.counter);

    for (var g = 0; g < groups.length; g++) {
      /* Ramped like every other angle: soft near the gate, full at
         depth. The per-line factor keeps some lines nearly straight
         so the page reads as uneven rather than as uniformly
         tilted. */
      var mag = (0.6 + (3.4 - 0.6) * k) * (0.4 + rand() * 0.6);
      var deg = (rand() < 0.5 ? -mag : mag).toFixed(2) + "deg";

      for (var s = 0; s < groups[g].length; s++) {
        groups[g][s].style.setProperty("--line-skew", deg);
      }
    }
  }

  function stopLineShuffle() {
    if (lineTimer) {
      window.clearInterval(lineTimer);
      lineTimer = null;
    }
  }

  function startLineShuffle(groups) {
    stopLineShuffle();
    if (reducedMotion() || !groups.length) return;

    lineTimer = window.setInterval(function () {
      /* The spans may have been torn down by a later pass. */
      if (!document.querySelector("span[data-drift-word]")) {
        stopLineShuffle();
        return;
      }
      shuffleLines(groups);
    }, SHUFFLE_INTERVAL);
  }

  /* ROTATE-LINES
     ---------------------------------------------------------------
     A line tipping as a rigid strip, not each word tilting on its
     own axis. That distinction is the whole event: rotating every
     word about its own centre gives a wavy row of tilted words,
     which reads as damage. A line that turns as one piece reads as
     a strip of paper lifted at one end.

     Getting there from per-word spans is trigonometry. For a
     rotation by t about a pivot P, a word whose centre sits at
     offset (dx, dy) from P must END UP at R(dx, dy) + P. Rotating
     the word in place leaves its centre where it was, so the
     difference has to be made up with a translation:

         tx = dx*cos(t) - dy*sin(t) - dx
         ty = dx*sin(t) + dy*cos(t) - dy

     Applied as `translate(tx, ty) rotate(t)` with the origin at the
     word's centre: the rotate happens first about that centre, then
     the translate carries it to where the rigid strip would have
     put it.

     The pivot is the left edge of the line at its vertical middle,
     so a line lifts from its start rather than swinging about the
     middle of the column.

     NOT animated, unlike skew-lines. This one moves words far
     enough that a per-second reshuffle would be a strobe rather
     than a twitch. */

  function rotateLines(groups, rand) {
    rand = rand || Math.random;

    for (var g = 0; g < groups.length; g++) {
      var line = groups[g];
      var rects = [];
      var minLeft = Infinity, minTop = Infinity, maxBottom = -Infinity;
      var i;

      for (i = 0; i < line.length; i++) {
        var r = line[i].getBoundingClientRect();
        rects.push(r);
        if (r.left < minLeft) minLeft = r.left;
        if (r.top < minTop) minTop = r.top;
        if (r.bottom > maxBottom) maxBottom = r.bottom;
      }
      if (!rects.length || minLeft === Infinity) continue;

      /* Pivot: start of the line, vertically centred. */
      var px = minLeft;
      var py = (minTop + maxBottom) / 2;

      /* Per-line magnitude, both directions. Some lines land nearly
         flat so the page reads as uneven rather than as a fan. */
      var mag = 0.3 + rand() * 1.1;
      var deg = rand() < 0.5 ? -mag : mag;
      var t = deg * Math.PI / 180;
      var cos = Math.cos(t), sin = Math.sin(t);

      for (i = 0; i < line.length; i++) {
        var rect = rects[i];
        var dx = rect.left + rect.width / 2 - px;
        var dy = rect.top + rect.height / 2 - py;

        var tx = dx * cos - dy * sin - dx;
        var ty = dx * sin + dy * cos - dy;

        var style = line[i].style;
        style.setProperty("--line-tx", tx.toFixed(2) + "px");
        style.setProperty("--line-ty", ty.toFixed(2) + "px");
        style.setProperty("--line-rotate", deg.toFixed(2) + "deg");
      }
    }
  }

  function applyDomEvents() {
    /* The timer holds references to spans this teardown destroys. */
    stopLineShuffle();
    TEXT.teardown();

    var active = {};
    state.events.forEach(function (e) { active[e.id] = e; });

    /* Always on, before any event is considered. Longest first, so
       a phrase beats a word contained in it. */
    var words = (drift.markedWords || MARKED_WORDS).slice().sort(function (a, b) {
      return b.length - a.length;
    });
    var marked = 0;
    for (var w = 0; w < words.length; w++) {
      marked += TEXT.word(words[w], "marked-word");
    }
    if (drift.DEBUG && marked) {
      console.log("marked-word  " + marked + " marked");
    }

    /* Blocks to redact. Images are excluded — bars over the writing
       with the photographs still visible is the point; blacking out
       the work as well would just be a dark page.

       The nav and the title ARE included. By the depth this fires
       the visitor knows where they are, and it expires after two or
       three navigations, so clicking blind for a moment is part of
       it rather than a trap. */
    /* Innermost-first, so listing both a container and its
       block-level children is safe: the children win. */
    /* Blocks the line events work on -- prose, the title, the nav,
       captions and credits.

       The nav is included for both, skew-lines included. At these
       angles the twitch is small enough that a link stays where a
       hand expects it, and the shift is a fraction of the target's
       own size. Worth remembering it is a judgment call rather than
       a free one: this is the only event that moves something a
       visitor is trying to click. */
    var LINE_BLOCKS = "main p, .project-intro, .home-intro, " +
                      ".project-credits, h1, nav li, .project-title, " +
                      "figcaption, .credits-label";

    var REDACT = "h1, main p, figcaption, nav li, .project-title, " +
                 ".project-intro, .credits-label, .home-intro, " +
                 ".back, .to-top, main > ul li, footer, " +
                 ".project-credits, .project-credits .line-break-line";

    /* skew-lines — every line at its own angle.

       Lines are discovered by measuring, not by markup, so this can
       only run after layout. It also means anything that reflows the
       page invalidates the grouping: a font arriving, a resize, the
       lightbox opening. The rare tier's short lifespan is what makes
       that acceptable -- it does not live long enough to drift far
       out of register, and a brief mismatch mid-resize reads as part
       of the piece. */
    /* LINE EVENTS
       ---------------------------------------------------------
       skew-lines and rotate-lines share one wrapping pass and one
       measurement, for two reasons.

       They would otherwise fight: both wrap the same words, so
       whichever ran first would claim them and the other's rules
       would never match. Wrapping under a neutral mark lets both
       apply, and drift.css composes the two transforms when both
       are active.

       And measuring must happen BEFORE either transform lands. Run
       separately, the second event would measure rectangles the
       first had already moved, and its geometry would be built on
       a page that no longer exists. */

    var lineSkew = active["skew-lines"];
    var lineRotate = active["rotate-lines"];

    if (lineSkew || lineRotate) {
      TEXT.words(LINE_BLOCKS, "line");
      var groups = TEXT.lines();          /* measured untransformed */

      if (lineRotate) {
        if (!lineRotate.seed) {
          lineRotate.seed = Math.floor(Math.random() * 1e9);
          save();
        }
        rotateLines(groups, seeded(lineRotate.seed));
      }

      if (lineSkew) {
        if (!lineSkew.seed) {
          lineSkew.seed = Math.floor(Math.random() * 1e9);
          save();
        }
        shuffleLines(groups, seeded(lineSkew.seed));
        startLineShuffle(groups);
      }

      if (drift.DEBUG) {
        console.log("line events  " + groups.length + " lines: " +
                    [lineSkew && "skew", lineRotate && "rotate"]
                      .filter(Boolean).join(" + ") +
                    (lineSkew && reducedMotion() ? "  (static)" : ""));
      }
    }

    if (active["redaction"]) {
      var bars = TEXT.blocks(REDACT, "redaction");
      if (drift.DEBUG) console.log("redaction  " + bars + " blocks barred");
    }

    if (active["red-letters"]) {
      var want = codeAsLetters(state.code);
      var got = TEXT.sequence(want, "red-letters");
      if (drift.DEBUG) {
        console.log("red-letters  " + got.placed + "/" + want.length +
                    " placed, " + got.altered + " letters altered in the page" +
                    "\n  code   " + state.code + " = " + codeAsWords(state.code) +
                    "\n  reads  " + got.reading);
      }
    }
  }

  /* Events whose output was measured against a layout, and is only
     valid until that layout changes. */
  var LAYOUT_DEPENDENT = ["skew-lines", "rotate-lines"];

  function needsRemeasure() {
    return state.events.some(function (e) {
      return LAYOUT_DEPENDENT.indexOf(e.id) !== -1;
    });
  }

  /* Lines are found by measuring, so anything that reflows the page
     invalidates the grouping: a resize, a late webfont, the browser
     chrome collapsing on a phone. Re-run the pass, debounced, but
     only when something actually depends on it -- re-wrapping every
     word on every resize frame would be absurd.

     The seed lives on the event record, so re-measuring produces the
     same character of angles rather than reshuffling the page. */
  var remeasureTimer = null;
  window.addEventListener("resize", function () {
    if (!needsRemeasure()) return;
    if (remeasureTimer) window.clearTimeout(remeasureTimer);
    remeasureTimer = window.setTimeout(function () {
      remeasureTimer = null;
      applyDomEvents();
    }, 250);
  });

  /* A webfont arriving mid-session reflows everything the same way. */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      if (needsRemeasure()) applyDomEvents();
    });
  }

  drift.applyDomEvents = applyDomEvents;
  drift.TEXT = TEXT;

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
                   : drift.T.postFlipRemoval.toFixed(2) + " once  [FLIPPED]") +
                 " · intensity " + drift.intensityAt(state.counter).toFixed(2));
    }

    if (roll && !roll.gated) {
      lines.push("roll: " +
                 (roll.spawned ? "+" + roll.spawned + " (" + roll.tier + ")" : "no spawn") +
                 (roll.removed.length ? "  −" + roll.removed.join(" −") : "") +
                 (roll.expired.length ? "  ×" + roll.expired.join(" ×") : ""));
    }

    lines.push("active [" + state.events.length + "]: " +
               (state.events.map(function (e) {
                  var v = e.variant ? ":" + e.variant : "";
                  if (e.variants) {
                    v = ":" + Object.keys(e.variants).map(function (k) {
                      return e.variants[k];
                    }).join("/");
                  }
                  return e.id + v + (e.level ? " L" + e.level : "");
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
    var code = state.code;          /* the code is not progress */
    state = drift.state = drift.defaults();
    state.code = code;
    save();
    drift.applyDrift(state);
    applyDomEvents();
    renderDebug();
  };

  /* Jump the counter without clicking, to inspect a deep state. */
  drift.jump = function (n) {
    state.counter = n;
    save();
    drift.applyDrift(state);
    applyDomEvents();
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
    ["__drift.force(id)", "turn an event on; call again to step through it"],
    ["__drift.forceAll()", "every registered event at once — finds collisions"],
    ["__drift.clear()", "remove all active events"],
    ["__drift.EVENTS", "the raw event registry"],

    ["code", null, null],
    ["__drift.state.code", "this browser's lock combination"],
    ["__drift.showCode()", "print the code and how it spells out"],
    ["__drift.newCode()", "roll a fresh one"],

    ["fonts", null, null],
    ["__drift.fontList()", "print every font id, and copy the list"],
    ["__drift.tryFont(id)", "download and apply one face immediately"],
    ["__drift.tryWord(w)", "preview the marked word on any word or list"],
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
        if (def.variants) {
          var vv = def.variants;
          notes.push((!Array.isArray(vv) && typeof vv !== "function")
            ? "axes: " + Object.keys(vv).join("+")
            : "variants");
        }
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
  /* Turn an event on, and step it forward every time it is called
     again. First call gives the first combination; each repeat
     advances to the next and re-rolls any numeric properties, so
     calling force twice on skew shows a genuinely different angle
     rather than doing nothing. */
  var cycleAt = {};

  function variantCombos(def, st) {
    var v = def.variants;
    if (!v) return [{}];

    if (Array.isArray(v) || typeof v === "function") {
      var flat = (typeof v === "function") ? v(st) : v;
      return (flat || []).map(function (x) { return { _single: x }; });
    }

    var combos = [{}];
    Object.keys(v).forEach(function (axis) {
      var pool = (typeof v[axis] === "function") ? v[axis](st) : v[axis];
      var next = [];
      combos.forEach(function (base) {
        (pool || []).forEach(function (val) {
          var copy = {};
          for (var k in base) copy[k] = base[k];
          copy[axis] = val;
          next.push(copy);
        });
      });
      combos = next;
    });
    return combos;
  }

  drift.force = function (id) {
    var def = drift.EVENTS[id];
    if (!def) {
      console.warn("no such event: " + id, Object.keys(drift.EVENTS));
      return;
    }

    var combos = variantCombos(def, state);
    if (!combos.length) {
      console.warn(id + " has no variants available" +
                   (typeof def.variants === "function"
                     ? " — try __drift.fontsAll()" : ""));
      return;
    }

    var already = state.events.some(function (e) { return e.id === id; });

    /* Already on? advance. Otherwise start at the first combination. */
    cycleAt[id] = already
      ? ((cycleAt[id] === undefined ? 0 : cycleAt[id]) + 1) % combos.length
      : (cycleAt[id] === undefined ? 0 : cycleAt[id]);

    var combo = combos[cycleAt[id]];

    var record = {
      id: id,
      tier: def.tier,
      life: def.tier === "rare" ? drift.T.rareLifeMax : null
    };

    /* A leveling event forced again climbs, as a real re-roll does. */
    var prev = state.events.filter(function (e) { return e.id === id; })[0];
    if (def.level) record.level = prev ? (prev.level || 1) + 1 : 1;

    var label = [];
    if (combo._single !== undefined) {
      record.variant = combo._single;
      label.push(combo._single);
    } else if (Object.keys(combo).length) {
      record.variants = combo;
      Object.keys(combo).forEach(function (k) {
        label.push(k + "=" + combo[k]);
      });
    }

    /* Numeric properties are re-rolled on every call, so repeating
       force on the same combination still changes what you see.

       Goes through boot's rollProps rather than calling def.props
       directly, so forcing an event uses the same code path as
       spawning one — including the depth-scaled intensity. */
    var rolled = drift.rollProps(state, id, record);
    if (rolled) {
      record.props = rolled;
      Object.keys(rolled).forEach(function (p) {
        if (rolled[p] !== "0deg") {
          label.push(p.replace("--", "") + " " + rolled[p]);
        }
      });
    }

    state.events = state.events.filter(function (e) { return e.id !== id; });
    state.events.push(record);
    drift.applyDrift(state);
    applyDomEvents();
    renderDebug();

    console.log(id + "  " + label.join("  ") +
                (combos.length > 1
                  ? "   (" + (cycleAt[id] + 1) + "/" + combos.length + ")"
                  : ""));
  };

  /* Kept as an alias — force() does the cycling now. */
  drift.variants = function (id) { return drift.force(id); };

  /* Preview any word without editing the file. Session only --
     MARKED_WORDS in drift.js is the real setting. */
  drift.tryWord = function (word) {
    drift.markedWords = (typeof word === "string") ? [word] : word;
    applyDomEvents();
    renderDebug();
  };

  drift.showCode = function () {
    var words = codeAsWords(state.code);
    console.log("code    " + state.code);
    console.log("reads   " + words);
    console.log("hunts   " + codeAsLetters(state.code) +
                "  (" + codeAsLetters(state.code).length + " letters)");
    return state.code;
  };

  drift.newCode = function () {
    state.code = String(Math.floor(Math.random() * 10000));
    while (state.code.length < 4) state.code = "0" + state.code;
    save();
    applyDomEvents();
    return drift.showCode();
  };

  drift.clear = function () {
    state.events = [];
    drift.applyDrift(state);
    applyDomEvents();
    renderDebug();
  };

  /* Hide or show the readout without touching the debug flags, so
     the helpers stay available and the setting survives. Useful for
     looking at the page properly mid-test. */
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

  /* ---------------------------------------------------------------
     FIRST RUN
     Last, so everything above is defined. DOM events need a body,
     which is why they run here and not in boot; drift.js is
     deferred, so the document is already parsed by this point.
     --------------------------------------------------------------- */

  try {
    applyDomEvents();
  } catch (err) {
    /* A DOM event must never take the rest of the runtime with it.
       The page keeps working; only that event is missing. */
    console.error("drift: DOM events failed", err);
  }
})();
