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

      /* AN INJECTED LINK IS DESTROYED BY THE ROLL ITS OWN CLICK
         TRIGGERS. increment() re-applies the drift synchronously,
         and the first thing that does is tear the text engine down
         -- so the anchor is replaced by a plain text node while the
         click is still being dispatched, and an element removed
         from the document mid-dispatch cannot be relied on to
         perform its default action.

         Deferred by a tick: the new tab opens, then the page
         drifts. The counter still moves on the click, which is what
         "clicking these counts as navigation" means. */
      if (anchor.hasAttribute("data-drift-link")) {
        window.setTimeout(function () { increment(false); }, 0);
        return;
      }

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
    window.addEventListener("load", function () {
      startFontLoading();
      });
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

    /* Combining marks, above and below. Zero-width by definition:
       each one attaches to the character before it rather than
       occupying a cell of its own, which is why a word can grow a
       tower without the line getting any wider.

       Mixed above and below on purpose. Above only reads as an
       accent gone wrong; both at once reads as the word coming
       apart, which is the difference between a typo and an
       instability. */
    var ZALGO = [
      /* above */
      "\u0300", "\u0301", "\u0302", "\u0303", "\u0304", "\u0306",
      "\u0307", "\u0308", "\u030A", "\u030B", "\u030C", "\u0311",
      "\u0313", "\u0315", "\u031A", "\u0342", "\u0350", "\u0357",
      /* below */
      "\u0316", "\u0317", "\u0318", "\u0319", "\u031C", "\u031D",
      "\u031E", "\u031F", "\u0320", "\u0323", "\u0324", "\u0325",
      "\u0326", "\u0329", "\u032A", "\u032B", "\u032D", "\u032E",
      "\u0330", "\u0331", "\u0332", "\u0339", "\u033A", "\u0345"
    ];

    /* Marks rolled per character rather than fixed, so text frays
       unevenly instead of growing a uniform fringe. Whitespace is
       left bare: a combining mark on a space attaches to nothing
       and drifts into the gap between words. */
    function fray(text, stack, rand) {
      var out = "";
      for (var c = 0; c < text.length; c++) {
        out += text.charAt(c);
        if (/\s/.test(text.charAt(c))) continue;

        var many = Math.round(rand() * stack);
        for (var k = 0; k < many; k++) {
          out += ZALGO[Math.floor(rand() * ZALGO.length)];
        }
      }
      return out;
    }

    /* A word stripped of the punctuation around it, which is what
       gets searched. "dialogue," searches dialogue; a token with no
       letters or digits at all returns "" and is left alone. */
    function term(word) {
      return word.replace(/^[^0-9A-Za-z\u00C0-\u024F]+/, "")
                 .replace(/[^0-9A-Za-z\u00C0-\u024F]+$/, "");
    }

    /* The visible text keeps its punctuation; only the query is
       cleaned. A new tab, so the visitor never loses the page they
       were on -- and because the document surviving is what lets
       the click register as a navigation and re-drift in place. */
    function anchor(word, mark) {
      var a = document.createElement("a");
      a.setAttribute("data-drift-link", mark);
      a.href = "https://en.wikipedia.org/wiki/Special:Search?search=" +
               encodeURIComponent(term(word));
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.appendChild(document.createTextNode(word));
      return a;
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
      /* Wrap every occurrence of the given characters.

         Case-sensitive: "A" and "a" are different letters here,
         because a mirror that works on one may not work on the
         other. The caller passes exactly what it wants.

         Italic text is skipped. Mirroring a slanted letter makes it
         lean the wrong way, which is instantly visible and reads as
         a rendering fault rather than as a letter that is subtly
         wrong -- the opposite of what this is for. */
      letters: function (chars, mark, limit) {
        limit = limit || 2000;

        var wanted = {};
        for (var w = 0; w < chars.length; w++) wanted[chars[w]] = true;

        var nodes = collect();
        var italic = new WeakMap();
        var count = 0;

        for (var n = 0; n < nodes.length && count < limit; n++) {
          var node = nodes[n];
          var parent = node.parentElement;
          if (!parent) continue;

          if (!italic.has(parent)) {
            var style = window.getComputedStyle(parent).fontStyle;
            italic.set(parent, style !== "normal");
          }
          if (italic.get(parent)) continue;

          var value = node.nodeValue;
          var hits = [];
          for (var i = 0; i < value.length; i++) {
            if (wanted[value.charAt(i)]) hits.push(i);
          }
          if (!hits.length) continue;

          /* Descending, so an earlier offset survives a later
             split of the same node. */
          for (var h = hits.length - 1; h >= 0 && count < limit; h--) {
            var tail = node.splitText(hits[h]);
            tail.splitText(1);

            var span = document.createElement("span");
            span.setAttribute("data-drift-text", mark);
            span.appendChild(document.createTextNode(tail.nodeValue));
            tail.parentNode.replaceChild(span, tail);
            count++;
          }
        }
        return count;
      },

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

      /* Wrap a contiguous run of words the page already has, rather
         than one named in advance. Every other method here matches
         text given to it; a selection is a run of whatever happens
         to be under it, which is a different question.

         WITHIN ONE TEXT NODE, deliberately. A real selection crosses
         element boundaries freely, and reproducing that would mean
         one span per fragment and a run of separate highlights that
         only line up by luck. Held to a single node, the run is one
         inline box, and box-decoration-break gives it a clean
         rectangle per line the way a real selection has.

         Takes a generator so the phrase holds still: without one it
         would jump to somewhere else on the page every time a
         lightbox opened.

         Returns how many words were wrapped, 0 if no node on the
         page was long enough. */
      run: function (mark, minWords, maxWords, rand) {
        rand = rand || Math.random;

        var nodes = collect().filter(function (node) {
          /* Prose only. A highlighted link reads as a link being
             hovered, and a highlighted nav item as the page telling
             the visitor where they are -- both are the interface
             working, which is the opposite of the effect. */
          if (node.parentNode.closest("a, nav, [data-drift-furniture]")) return false;
          var words = node.nodeValue.match(/\S+/g);
          return words && words.length >= minWords;
        });
        if (!nodes.length) return 0;

        var node = nodes[Math.floor(rand() * nodes.length)];
        var value = node.nodeValue;

        var at = [];
        var re = /\S+/g;
        var m;
        while ((m = re.exec(value)) !== null) {
          at.push({ from: m.index, to: m.index + m[0].length });
        }

        var want = minWords + Math.floor(rand() * (maxWords - minWords + 1));
        if (want > at.length) want = at.length;

        var start = Math.floor(rand() * (at.length - want + 1));
        var from = at[start].from;
        var to = at[start + want - 1].to;

        /* Split twice: the run becomes its own node, with the text
           before and after it left as ordinary siblings. */
        var tail = node.splitText(from);
        tail.splitText(to - from);

        var span = document.createElement("span");
        span.setAttribute("data-drift-text", mark);
        span.appendChild(document.createTextNode(tail.nodeValue));
        tail.parentNode.replaceChild(span, tail);

        return want;
      },

      /* Turn words into working links to a Wikipedia search.

         REAL ANCHORS, not spans dressed as links. style.css already
         styles `a`, so an injected link needs no CSS of its own and
         is indistinguishable from one the generator wrote -- which
         is the point. It is also why they stay keyboard-focusable
         rather than getting the form furniture's tabindex -1: the
         furniture is debris that does nothing, and these actually
         go somewhere.

         MARKED data-drift-link, NOT data-drift-text. collect() skips
         anything inside a data-drift-text wrapper, so marking them
         as text would hide every linked word from red-letters, and
         under `super-hyperlink` that is the entire page -- the code
         would have nowhere left to spell itself.

         Special:Search rather than a direct article URL, because
         most words have no article at that exact title. A search
         always resolves to something, and lands on the article
         itself when one matches.

         limit 1 picks one word; anything higher takes every word it
         can reach. Returns how many were linked. */
      link: function (mark, limit, rand) {
        rand = rand || Math.random;

        var nodes = collect().filter(function (node) {
          /* Never inside an existing link -- a real link rewritten
             to point at Wikipedia is the site breaking its own
             navigation, not a word quietly becoming clickable.

             And never in the nav, for the sharper version of the
             same problem. The generator renders the current page's
             own nav entry as plain text rather than as a link,
             which makes it the one piece of navigation this can
             reach -- so "Selected Works" would stop being the
             page you are on and start being a Wikipedia search,
             while every entry around it still navigates. The title
             is left alone deliberately: it is prose on the home
             page and already a link everywhere else. */
          if (node.parentNode.closest("a, nav, [data-drift-furniture]")) return false;
          return /\S/.test(node.nodeValue);
        });
        if (!nodes.length) return 0;

        if (limit === 1) {
          /* One word, and one worth searching: a three-letter floor
             keeps it off "a", "of" and "is", where a Wikipedia
             search returns a disambiguation page and the joke is
             just noise. */
          var pool = [];
          for (var n = 0; n < nodes.length; n++) {
            var re = /\S+/g;
            var m;
            while ((m = re.exec(nodes[n].nodeValue)) !== null) {
              if (term(m[0]).length >= 3) {
                pool.push({ node: nodes[n], at: m.index, length: m[0].length });
              }
            }
          }
          if (!pool.length) return 0;

          var pick = pool[Math.floor(rand() * pool.length)];
          var tail = pick.node.splitText(pick.at);
          tail.splitText(pick.length);
          tail.parentNode.replaceChild(anchor(tail.nodeValue, mark), tail);
          return 1;
        }

        var count = 0;
        for (var i = 0; i < nodes.length; i++) {
          var text = nodes[i];
          var parts = text.nodeValue.split(/(\s+)/);
          var frag = document.createDocumentFragment();

          for (var p = 0; p < parts.length; p++) {
            if (!parts[p]) continue;

            if (/^\s+$/.test(parts[p]) || !term(parts[p])) {
              /* Whitespace and bare punctuation stay as they are.
                 An em dash linking to a Wikipedia search for nothing
                 would be the one link on the page that is obviously
                 automatic. */
              frag.appendChild(document.createTextNode(parts[p]));
            } else {
              frag.appendChild(anchor(parts[p], mark));
              count++;
            }
          }
          text.parentNode.replaceChild(frag, text);
        }
        return count;
      },

      /* Stack combining marks on one word.

         THE TEXT IS REWRITTEN, not styled, so the original is kept
         on data-drift-was and teardown restores it -- the same
         mechanism red-letters uses when it turns an s into a z. A
         page that has been zalgoed and then cleaned is byte for
         byte what the generator produced.

         ONE WORD, not the page. The marks stack ABOVE and BELOW the
         line box without taking part in layout, so a whole
         paragraph of them collides with everything around it
         unpredictably. One word overflows into the line above and
         below it and stops there.

         Three-letter floor, for the same reason the link event has
         one: marks on "a" or "of" read as a font bug rather than as
         a word coming apart.

         Returns the word as it was, or "" if nothing suitable was
         on the page. */
      zalgo: function (mark, stack, rand) {
        rand = rand || Math.random;

        var nodes = collect().filter(function (node) {
          if (node.parentNode.closest("[data-drift-furniture], [data-drift-facts]")) {
            return false;
          }
          return /\S/.test(node.nodeValue);
        });

        var pool = [];
        for (var n = 0; n < nodes.length; n++) {
          var re = /\S+/g;
          var m;
          while ((m = re.exec(nodes[n].nodeValue)) !== null) {
            if (m[0].replace(/[^0-9A-Za-z\u00C0-\u024F]/g, "").length >= 3) {
              pool.push({ node: nodes[n], at: m.index, length: m[0].length });
            }
          }
        }
        if (!pool.length) return "";

        var pick = pool[Math.floor(rand() * pool.length)];
        var tail = pick.node.splitText(pick.at);
        tail.splitText(pick.length);

        var word = tail.nodeValue;

        var span = document.createElement("span");
        span.setAttribute("data-drift-text", mark);
        span.setAttribute("data-drift-was", word);
        span.appendChild(document.createTextNode(fray(word, stack, rand)));
        tail.parentNode.replaceChild(span, tail);

        return word;
      },

      /* The whole page, rather than one word.

         RUN LAST, after every other text event, and that ordering
         is what makes it survivable. collect() skips anything
         already inside a data-drift-text wrapper, so the marked
         word, the selection and — the one that matters — the letters
         spelling the lock combination are all passed over and stay
         legible. The code reads straight through the noise, which
         is the only thing on the page that still does.

         One span per TEXT NODE, not per character. A paragraph is a
         handful of nodes, so a page costs a few dozen spans rather
         than a few thousand, and the original text rides on
         data-drift-was exactly as the single-word version does.

         Returns how many nodes were rewritten. */
      zalgoAll: function (mark, stack, rand) {
        rand = rand || Math.random;

        var nodes = collect().filter(function (node) {
          if (node.parentNode.closest("[data-drift-furniture], [data-drift-facts]")) {
            return false;
          }
          if (!/\S/.test(node.nodeValue)) return false;

          /* ALREADY FRAYED? Leave it. Marks compound: fraying text
             that carries marks already gives every existing mark
             marks of its own, and a few passes of that is a page
             the browser cannot lay out.

             A ratio rather than a test for any mark at all, because
             real text legitimately carries combining accents -- a
             decomposed Vietnamese or French title would otherwise
             be skipped forever. A third of a string being marks is
             not a language, it is a second pass. */
          var marks = (node.nodeValue.match(/[\u0300-\u036F]/g) || []).length;
          return marks / node.nodeValue.length < 0.3;
        });

        for (var n = 0; n < nodes.length; n++) {
          var node = nodes[n];
          var was = node.nodeValue;

          var span = document.createElement("span");
          span.setAttribute("data-drift-text", mark);
          span.setAttribute("data-drift-was", was);
          span.appendChild(document.createTextNode(fray(was, stack, rand)));

          node.parentNode.replaceChild(span, node);
        }

        return nodes.length;
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
        /* Word spans first, then blocks, then characters -- each
           layer can contain the next, so unwrapping outside-in would
           leave orphans behind.

           MOVED OUT, NOT FLATTENED. Using textContent here would
           collapse everything inside a word span into one text
           node, destroying any character span sitting in it along
           with the data-drift-was that holds the original text. The
           line events wrap every word, and they wrap words that
           other events have already rewritten -- so flattening
           turned a zalgoed word into permanently zalgoed TEXT,
           which the next pass then zalgoed again. Marks multiplied
           on every re-apply until the page could not be drawn.

           An altered letter had the same fault more quietly: the
           s-for-z swap became permanent instead of restoring. */
        var words = document.querySelectorAll("span[data-drift-word]");
        for (var w = 0; w < words.length; w++) {
          var word = words[w];
          var owner = word.parentNode;
          if (!owner) continue;
          while (word.firstChild) owner.insertBefore(word.firstChild, word);
          owner.removeChild(word);
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

        /* Injected links last. A red letter can be sitting inside
           one, so the text spans have to come out first or this
           would unwrap an anchor whose contents are still wrapped
           and leave the character spans stranded as siblings. */
        var links = document.querySelectorAll("a[data-drift-link]");
        for (var k = 0; k < links.length; k++) {
          var link = links[k];
          var owns = link.parentNode;
          if (!owns) continue;
          owns.replaceChild(document.createTextNode(link.textContent), link);
          owns.normalize();
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
         flat so the page reads as uneven rather than as a fan.

         Deliberately NOT scaled by the counter. intensityFull is
         aligned with rareGate, so a rare is already at full
         intensity the moment it can fire at all -- any ramp here
         would do nothing. A fixed range is the honest version: rare
         events are the same strength whenever they appear. */
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

  /* MIRRORED LETTERS
     ---------------------------------------------------------------
     One letter, everywhere it appears, flipped horizontally.

     The pool is the near-symmetric letters. Mirroring a `b` gives
     something that reads as a `d` and looks like a typo; mirroring a
     `W` gives a `W` whose stroke stress has swapped sides -- thin
     where it should be thick. The letter stays perfectly legible and
     is simply, unnameably wrong, which is a far better failure than
     an obviously reversed glyph.

     Case matters. `A` works in caps but a lowercase `a` is not
     symmetric at all. `l` works lowercase, where it is nearly a bare
     stem, but a capital `L` would flip into something absurd. The
     rest work in both cases.

     ALL of them at once, everywhere they appear. One letter at a
     time would read as a single damaged glyph; the whole set
     flipped reads as a typeface that was cut wrong -- which is what
     the site is impersonating. */

  var MIRROR_LETTERS = [
    "W", "w",
    "V", "v",
    "U", "u",
    "M", "m",
    "A",             /* caps only -- lowercase a is not symmetric */
    "l"              /* lowercase only -- capital L is not        */
  ];

  /* FORM FURNITURE
     ---------------------------------------------------------------
     Orphaned controls: a checkbox attached to nothing, a slider
     with no label, a submit button that submits nothing.

     Two placements, decided per control in drift-boot.js.

     IN THE FLOW -- inserted between two of main's children, so it
     pushes the text down and takes part in the layout like any
     other block. This is what a low counter produces.

     ESCAPED -- absolutely positioned against the document at
     z-index -1. That single value does all the work: above the
     page background, below every element's content. It can never
     cover an image, because where it overlaps one it disappears
     behind it and sticks out at the edge; and text stays perfectly
     readable with the control peeking out around the words.

     THEY WORK. A checkbox ticks, a slider drags, a select opens, a
     date input raises the browser's calendar. They are real
     controls doing exactly what real controls do -- attached to
     nothing, saving nothing, submitting nowhere. Inert furniture
     would just be a picture of furniture.

     Still out of the tab order and still aria-hidden: a keyboard
     visitor should not have to tab through debris, and a screen
     reader should not announce a form that does not exist. Mouse
     only, by choice.

     FURNITURE AVOIDS IMAGES, INFESTATION DOES NOT. At low counts
     there are few enough controls that losing one behind a
     photograph is a waste, so their positions are nudged clear.
     Past the rare threshold there are thirty of them and a few
     half-swallowed by an image is the better picture.
     --------------------------------------------------------------- */

  /* Where the images are, in page coordinates. Measured at
     placement, not rolled in boot -- boot runs before layout and
     cannot know. */
  function imageBoxes() {
    var out = [];
    var nodes = document.querySelectorAll("main img, main .image-shell, main .video-embed");
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;
      out.push({
        top: r.top + window.scrollY,
        left: r.left + window.scrollX,
        bottom: r.bottom + window.scrollY,
        right: r.right + window.scrollX
      });
    }
    return out;
  }

  /* Roughly what a control occupies. A range slider is the widest
     of them; better to reserve too much than to clip one. */
  var CONTROL_BOX = { w: 150, h: 44 };

  function clearOfImages(topPct, leftPct, boxes, pageW, pageH) {
    var top = (topPct / 100) * pageH;
    var left = (leftPct / 100) * pageW;

    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (left < b.right && left + CONTROL_BOX.w > b.left &&
          top < b.bottom && top + CONTROL_BOX.h > b.top) {
        return false;
      }
    }
    return true;
  }

  var CONTROLS = drift.CONTROLS;

  /* A colour with a free hue and a held saturation and lightness,
     returned as the #rrggbb that <input type="color"> requires --
     it rejects anything else and falls back to black, which is the
     look being avoided.

     Takes the generator rather than calling Math.random, so two
     controls on a page differ from each other but neither changes
     when the page is re-measured. */
  function rolledColour(rand) {
    var h = rand() * 360;
    var s = 0.45 + rand() * 0.3;
    var l = 0.38 + rand() * 0.24;

    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;

    var rgb = h < 60  ? [c, x, 0] :
              h < 120 ? [x, c, 0] :
              h < 180 ? [0, c, x] :
              h < 240 ? [0, x, c] :
              h < 300 ? [x, 0, c] : [c, 0, x];

    return "#" + rgb.map(function (v) {
      var byte = Math.round((v + m) * 255);
      return (byte < 16 ? "0" : "") + byte.toString(16);
    }).join("");
  }

  function makeControl(kind, rand) {
    var el;

    /* Called without one by anything that wants a one-off control
       outside a placement pass. */
    rand = rand || Math.random;

    if (kind === "select") {
      /* Blank options: a dropdown that opens onto nothing is
         stranger than one full of words. */
      el = document.createElement("select");
      for (var o = 0; o < 3; o++) el.appendChild(document.createElement("option"));

    } else if (kind === "textarea") {
      el = document.createElement("textarea");
      el.rows = 2;
      el.cols = 12;

    } else if (kind === "progress") {
      el = document.createElement("progress");
      el.value = Math.random();

    } else if (kind === "meter") {
      el = document.createElement("meter");
      el.value = Math.random();

    } else if (kind === "radio") {
      /* A CLUSTER, not a single button. One radio on its own cannot
         demonstrate what a radio is -- the behaviour only exists
         between them. Two to four sharing a name, so picking one
         releases the rest. */
      var group = document.createDocumentFragment();
      var name = "drift-radio-" + Math.random().toString(36).slice(2, 8);
      var many = 2 + Math.floor(Math.random() * 3);

      for (var r = 0; r < many; r++) {
        var button = document.createElement("input");
        button.type = "radio";
        button.name = name;
        button.setAttribute("tabindex", "-1");
        button.setAttribute("aria-hidden", "true");
        group.appendChild(button);
        if (r < many - 1) group.appendChild(document.createTextNode(" "));
      }
      return group;

    } else if (kind === "color") {
      /* A picker showing a colour somebody already chose.

         The UA default is #000000, and a black swatch reads as
         empty -- as the control's off state rather than as a value.
         Any other colour reads as a decision, which is the whole
         point of a control attached to nothing: it is not waiting
         for input, it is holding an answer to a question that was
         never asked.

         Rolled through HSL and converted, rather than three random
         bytes. Random bytes give muddy browns most of the time,
         because most of the RGB cube is mud. A free hue at held
         saturation and lightness gives a colour that looks picked
         from a picker -- which is where it is sitting. */
      el = document.createElement("input");
      el.type = "color";
      el.value = rolledColour(rand);

    } else if (kind === "button") {
      el = document.createElement("button");
      el.type = "button";

    } else if (kind === "datalist") {
      /* A text field offering completions for a form that does not
         exist. The only control here that proposes rather than
         states -- which implies something knows what you were about
         to type.

         Returned as a fragment, because the <datalist> has to be in
         the document for the input's `list` attribute to find it. */
      var frag = document.createDocumentFragment();
      var id = "drift-list-" + Math.random().toString(36).slice(2, 8);

      var list = document.createElement("datalist");
      list.id = id;
      for (var s = 0; s < drift.SUGGESTIONS.length; s++) {
        var opt = document.createElement("option");
        opt.value = drift.SUGGESTIONS[s];
        list.appendChild(opt);
      }

      var field = document.createElement("input");
      field.type = "text";
      field.setAttribute("list", id);
      field.setAttribute("tabindex", "-1");
      field.setAttribute("aria-hidden", "true");

      frag.appendChild(list);
      frag.appendChild(field);
      return frag;

    } else if (kind === "submit") {
      /* Labelled, so it reads unmistakably as form furniture. The
         UA default is "Submit" but only when the attribute is
         absent, and setting .value at all replaces it -- so it is
         stated explicitly. */
      el = document.createElement("input");
      el.type = "submit";
      el.value = "Submit";

    } else if (kind === "submit-blank") {
      /* The same control stripped of its label: a tiny empty
         button, which is its own kind of wrong. */
      el = document.createElement("input");
      el.type = "submit";
      el.value = "";

    } else if (kind === "image") {
      /* Pointed at a source that cannot decode, so the browser
         draws its own broken-image icon.

         An ABSENT src is not enough -- browsers disagree on whether
         that renders anything at all, which is why nothing showed.
         An invalid data URL fails locally, every time, with no
         network request and no 404 in anyone's log. */
      el = document.createElement("input");
      el.type = "image";
      el.src = "data:image/gif;base64,!";
      el.alt = "";

    } else {
      el = document.createElement("input");
      el.type = kind;
    }

    /* Out of the tab order and unannounced, but fully usable with a
       mouse. Not disabled: a disabled control renders greyed out,
       which reads as broken rather than as orphaned. */
    el.setAttribute("tabindex", "-1");
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  /* ---------------------------------------------------------------
     THE FACTS (did-you-know, did-you-know-madness)

     facts.json is harvested from Wikipedia's Did You Know archives
     by harvest_facts.py and committed. Nothing is fetched from
     Wikipedia at runtime.

     LOADED ONLY WHEN ONE OF THE TWO EVENTS IS ACTIVE, and the
     promise is cached, so a visitor who never reaches the gate
     never makes the request. That is the same contract drift.css
     holds to: nothing happens at rest.

     The request is resolved against drift.js's own src rather than
     the page URL, because a project page lives two directories down
     and a bare "facts.json" would resolve to works/foo/facts.json.
     --------------------------------------------------------------- */

  var factsPromise = null;

  function factsURL() {
    var tag = document.querySelector('script[src*="drift.js"]');
    return new URL("facts.json", tag ? tag.src : window.location.href).href;
  }

  function loadFacts() {
    if (!factsPromise) {
      factsPromise = window.fetch(factsURL())
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (data) {
          return (data && data.facts) || [];
        })
        .catch(function () {
          /* Missing or malformed: the event does nothing. It is one
             box of trivia, not something worth a broken page over. */
          return [];
        });
    }
    return factsPromise;
  }

  /* A <fieldset> with a <legend>, which is a component the generator
     already emits and style.css already styles -- so an injected box
     is the same object as an authored one, with no CSS of its own
     beyond where it sits. */
  function factBox(text) {
    var set = document.createElement("fieldset");
    var legend = document.createElement("legend");
    legend.appendChild(document.createTextNode("Did you know"));

    var body = document.createElement("p");
    body.appendChild(document.createTextNode(text));

    set.appendChild(legend);
    set.appendChild(body);
    return set;
  }

  function clearFacts() {
    /* The head wrapper holds the real nav and the real title, so it
       is UNWRAPPED rather than removed -- deleting it would take the
       page's navigation with it. Its own children go back where they
       were, in order, before the wrapper goes. */
    var heads = document.querySelectorAll("[data-drift-facts-head]");
    for (var h = 0; h < heads.length; h++) {
      var head = heads[h];
      var host = head.parentNode;
      if (!host) continue;

      var column = head.querySelector("[data-drift-facts-column]");
      if (column) {
        while (column.firstChild) host.insertBefore(column.firstChild, head);
      }
      host.removeChild(head);
    }

    var nodes = document.querySelectorAll("[data-drift-facts]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  /* Draw n distinct indices. Without replacement, because the rare
     shows up to twenty at once and two identical boxes on one screen
     would read as a bug rather than as an infestation.

     INDICES, STORED ON THE RECORD. The facts were previously derived
     from the seed at render time, which meant anything that rebuilt
     the record silently dealt a new hand -- so the box changed its
     fact on navigations where the event had not changed at all. The
     choice is state, so it is kept as state, and it changes when the
     event re-rolls and at no other time. */
  function drawIndices(total, n, rand) {
    var pool = [];
    for (var i = 0; i < total; i++) pool.push(i);

    var out = [];
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
    }
    return out;
  }

  function placeFacts(record) {
    loadFacts().then(function (facts) {
      if (!facts.length) return;

      /* The fetch outlived the state it was started for: the event
         was removed, or a navigation re-applied everything while
         this was in flight. Identity rather than id, so a record
         replaced by a re-roll counts as gone too. */
      if (findActive(record.id) !== record) return;

      /* THE COUNTER IS THE SEED, which is the whole behaviour in one
         line: it moves on every navigation and on nothing else, so
         the box shows a new fact each time the visitor goes
         anywhere and holds still through a resize, a lightbox, or
         any other re-render at the same count.

         Deriving it rather than storing it is deliberate. A stored
         pick would have to be cleared by something, and the only
         honest thing to clear it on is the navigation that the
         counter already represents.

         Two generators off the same number: one for what is shown,
         one for where. Sharing one would make the positions depend
         on how many boxes were drawn. */
      var pick = seeded((state.counter * 2654435761) >>> 0);
      var rand = seeded((state.counter * 40503 + 17) >>> 0);

      var many = record.id === "did-you-know"
        ? 1
        : 5 + Math.floor(pick() * 16);                   /* 5 to 20 */

      var chosen = drawIndices(facts.length, many, pick).map(function (i) {
        return facts[i];
      });

      if (record.id === "did-you-know") {
        var nav = document.querySelector("nav");
        if (!nav) return;

        var one = factBox(chosen[0]);
        one.setAttribute("data-drift-facts", record.id);

        /* A WRAPPER, because the back link and the nav are siblings
           of body and the box has to share a container with both.

           THE TITLE STAYS OUT OF IT. Inside, a wrapped box would
           land above the name; outside, the name keeps the top of
           the page to itself and the box wraps underneath it and
           above the back link, which is the order asked for. It
           also means the box never rises alongside the name at full
           width -- it belongs to the navigation block, not to the
           masthead.

           Nodes are MOVED, never recreated, so the back link keeps
           any listener bound to it. Teardown puts them back. */
        var head = document.createElement("div");
        head.setAttribute("data-drift-facts", record.id);
        head.setAttribute("data-drift-facts-head", "");

        var column = document.createElement("div");
        column.setAttribute("data-drift-facts-column", "");

        var back = document.querySelector("body > .back");
        nav.parentNode.insertBefore(head, nav);

        /* Moved in DOCUMENT ORDER -- nav, then back -- and left that
           way. The visitor sees back above nav, but that is CSS
           `order` in the column rather than a move, so teardown
           restores exactly what the generator wrote. */
        column.appendChild(nav);
        if (back) column.appendChild(back);

        head.appendChild(column);
        head.appendChild(one);

        /* THE NAV'S BOTTOM MARGIN IS INSIDE THE COLUMN, so aligning
           the two bottom edges hangs the box lower than the last
           link by exactly that margin -- which is why the box met
           the rule while "About" kept its distance from it.

           Measured rather than guessed: style.css owns that spacing
           and may change it. The value is in px and does not follow
           a later resize, which is acceptable for a gap that is one
           constant deep. */
        var list = nav.querySelector("ul") || nav;
        var overhang = column.getBoundingClientRect().bottom -
                       list.getBoundingClientRect().bottom;
        if (overhang > 0) one.style.marginBottom = overhang.toFixed(1) + "px";
        return;
      }

      var layer = document.createElement("div");
      layer.setAttribute("data-drift-facts", record.id);
      layer.setAttribute("data-drift-facts-layer", "");

      /* Twenty fieldsets announced one after another is not an
         effect, it is a screen reader being held hostage. The single
         common box stays readable; these are scenery. */
      layer.setAttribute("aria-hidden", "true");

      for (var i = 0; i < chosen.length; i++) {
        var slot = document.createElement("div");
        slot.setAttribute("data-drift-facts-item", "");
        slot.style.top = (rand() * 92).toFixed(2) + "%";
        slot.style.left = (rand() * 78).toFixed(2) + "%";
        slot.appendChild(factBox(chosen[i]));
        layer.appendChild(slot);
      }

      document.body.appendChild(layer);
    });
  }

  function findActive(id) {
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].id === id) return state.events[i];
    }
    return null;
  }


  function clearFurniture() {
    var nodes = document.querySelectorAll("[data-drift-furniture]");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
  }

  /* A small seeded generator so the controls hold still. Without it
     every re-measure -- a lightbox opening, a resize -- would
     reshuffle them, and furniture that rearranges itself while you
     look at it is an animation rather than debris. */
  function furnitureRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* How tall the page is TO A VISITOR.

     Usually that is just the document height. The exception is a
     page that clips: scrollHeight still reports content overflowing
     a hidden box, and measuring it there would buy furniture for
     screens nobody can reach.

     Computed overflow rather than a class, so the measure follows
     the page and not the file -- `vertical` sets the home page to
     overflow: visible and height: auto, at which point it genuinely
     is several screens tall and genuinely should carry more.

     THE LIGHTBOX LOCK IS NOT THE PAGE'S SHAPE. page.js clips the
     document while an image is open, and opening an image is one of
     the ways the counter increments -- so a placement pass can run
     with the page held clipped by something about to be released.
     Measured naively, every project page looks like a single screen
     for exactly as long as a lightbox is open. So the lock is
     ignored and the document is measured as it will be a moment
     later. */
  function visibleHeight() {
    var docEl = document.documentElement;

    /* THE LIGHTBOX LOCK IS NOT THE PAGE'S SHAPE. page.js clips the
       document while an image is open, and opening an image is one
       of the ways the counter increments -- so a placement pass can
       run with the page held clipped by something that is about to
       be released. Measured naively, every project page looks like
       the home page for exactly as long as a lightbox is open, and
       every control escapes.

       So the lock is ignored and the document is measured as it
       will be a moment later. */
    var locked = docEl.classList.contains("lightbox-open");

    var clipped = !locked && (
      window.getComputedStyle(docEl).overflowY === "hidden" ||
      window.getComputedStyle(document.body).overflowY === "hidden");

    if (clipped) return window.innerHeight;

    return Math.max(document.body.scrollHeight,
                    docEl.scrollHeight,
                    window.innerHeight);
  }

  function placeFurniture(spec, mark, avoidImages, minimum) {
    if (!spec || (!spec.count && !spec.density)) return 0;

    var main = document.querySelector("main") || document.body;

    var pageW = document.documentElement.scrollWidth;
    var pageH = visibleHeight();

    /* A flat count is placed as asked. A density is per screen, so
       it is multiplied by how many the page measured -- which is how
       form-infestation fills a long page in proportion to itself
       while form-furniture stays the same handful everywhere. */
    var count = spec.count
      ? spec.count
      : Math.round(spec.density * Math.max(1, pageH / window.innerHeight));
    if (minimum) count = Math.max(count, minimum);
    if (!count) return 0;

    var rand = furnitureRandom(spec.seed || 1);
    var boxes = avoidImages ? imageBoxes() : [];

    /* In-flow controls sit between two of main's children, and only
       there. The nav is deliberately excluded: it is the one part
       of the page that has to keep working as navigation, and a
       control inserted between two list items reads as an entry
       that lost its label -- which is the joke, but it also widens
       the list, reflows the rule under it, and on a narrow screen
       pushes a real link onto a second row. The loose controls can
       still land over it; they just do not displace it. */
    var flowTargets = [].slice.call(main.children);

    var onTop = null;
    var placed = 0;

    for (var i = 0; i < count; i++) {
      var kind = CONTROLS[Math.floor(rand() * CONTROLS.length)];
      var control = makeControl(kind, rand);

      var inFlow = rand() >= spec.escape;
      if (inFlow) {
        /* IN THE FLOW -- it takes part in the layout and pushes the
           text down, like any other block. */
        var holder = document.createElement("div");
        holder.setAttribute("data-drift-furniture", mark);
        holder.appendChild(control);

        rand();   /* was the nav/main choice. Drawn still, so the
                     seeded sequence is unchanged by its removal. */
        if (flowTargets.length) {
          var at = flowTargets[Math.floor(rand() * flowTargets.length)];
          main.insertBefore(holder, at);
        } else {
          main.appendChild(holder);
        }
        placed++;
        continue;
      }

      /* ESCAPED. One layer, above the content, so every control is
         clickable -- painting behind the page and receiving clicks
         are mutually exclusive, and being usable matters more than
         peeking out from under a photograph. */
      if (!onTop) {
        onTop = document.createElement("div");
        onTop.setAttribute("data-drift-furniture", mark);
        onTop.setAttribute("data-drift-furniture-layer", "");
        document.body.appendChild(onTop);
      }
      var layer = onTop;

      var top = rand() * 96;
      var left = rand() * 92;

      /* Nudge clear of the images. Ten tries, then place it anyway:
         on a page that is mostly photographs there may be nowhere
         clear, and a control behind an image beats a control
         missing.

         Not written back, so the position is re-checked against
         whatever page it lands on -- and a resize can push an image
         over a control that was clear. That is right: it should look
         like the layout moved underneath them, because it did. */
      if (avoidImages && boxes.length) {
        for (var tries = 0; tries < 10; tries++) {
          if (clearOfImages(top, left, boxes, pageW, pageH)) break;
          top = rand() * 96;
          left = rand() * 92;
        }
      }

      var slot = document.createElement("span");
      slot.setAttribute("data-drift-furniture-item", "");
      slot.style.top = top.toFixed(2) + "%";
      slot.style.left = left.toFixed(2) + "%";
      slot.appendChild(control);
      layer.appendChild(slot);
      placed++;
    }

    return placed;
  }

  /* ---------------------------------------------------------------
     sideways

     The page reads left to right instead of top to bottom, and the
     visitor scrolls exactly as they always did.

     THE SCROLL IS REAL. A tall spacer gives the document the height
     it would have had, and the strip is translated horizontally by
     whatever scrollY reports. Nothing is intercepted, so the wheel,
     trackpad inertia, iOS momentum, the spacebar, Page Down, arrow
     keys, find-in-page and the keyboard all work without a line of
     code each. Faking the scroll instead would mean reimplementing
     every one of them, badly.

     ONE COLUMN WIDE, matching the content column. The first column
     is therefore pixel-identical to the page as it renders now, and
     what would have scrolled off the bottom becomes the next column
     to the right. The masthead does not move: only main becomes a
     strip, below the rule, exactly where it already was.

     THIS PUTS A TRANSFORM ON A WRAPPER INSIDE main, which the rest
     of the file avoids, because a transform makes an element a
     containing block for fixed-position descendants and will
     capture the three.js overlay when that exists. Deliberate here,
     as in mirrored-page, and stated for the same reason.
     --------------------------------------------------------------- */

  var sideways = null;
  var OVER_MAX = 140;

  function stopSideways() {
    if (!sideways) return;

    window.removeEventListener("scroll", sideways.onScroll);
    window.removeEventListener("resize", sideways.onResize);
    window.removeEventListener("wheel", sideways.onWheel);
    if (sideways.frame) window.cancelAnimationFrame(sideways.frame);

    /* Children move back out; the wrappers never held anything of
       their own, so the document is left exactly as it was. */
    var strip = sideways.strip;
    var main = sideways.main;
    if (strip.parentNode === main) {
      while (strip.firstChild) main.insertBefore(strip.firstChild, strip);
      main.removeChild(strip);
    }

    /* Borrowed nodes go home FIRST, while the wrappers they belong
       inside still exist. In reverse, so a pair that were siblings
       land back in their original order. */
    var moved = sideways.moved || [];
    for (var m = moved.length - 1; m >= 0; m--) {
      if (moved[m].home) {
        moved[m].home.insertBefore(moved[m].node, moved[m].next || null);
      }
    }
    if (sideways.edge && sideways.edge.parentNode) {
      sideways.edge.parentNode.removeChild(sideways.edge);
    }

    var head = sideways.head;
    if (head && head.parentNode) {
      var above = head.parentNode;
      while (head.firstChild) above.insertBefore(head.firstChild, head);
      above.removeChild(head);
    }

    var viewport = sideways.viewport;
    if (viewport && viewport.parentNode) {
      var host = viewport.parentNode;
      while (viewport.firstChild) host.insertBefore(viewport.firstChild, viewport);
      host.removeChild(viewport);
    }

    [sideways.spacer, sideways.bar].forEach(function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });

    sideways = null;
    window.scrollTo(0, 0);
  }

  function startSideways() {
    var main = document.querySelector("main");
    if (!main) return false;

    /* PROJECT PAGES ONLY. The home page is one clipped viewport and
       the listings are a short column -- neither has anything to
       turn, and turning them puts a horizontal scrollbar on a page
       with nowhere to scroll. A project page is the one that runs
       long enough for reading it sideways to mean anything. */
    if (!document.querySelector(".project-title")) return false;

    var strip = document.createElement("div");
    strip.setAttribute("data-drift-sideways-strip", "");
    while (main.firstChild) strip.appendChild(main.firstChild);
    main.appendChild(strip);

    /* THE PAGE STOPS SCROLLING VERTICALLY, which is the whole point
       and was the thing missing: left in normal flow, the document
       scrolled down while the strip slid left and the page moved
       diagonally out from under the reader.

       So everything visible is pinned to the viewport and the
       spacer becomes the only thing in the document with height.
       The scroll is still completely real -- it simply has nothing
       left to move except the number the strip reads. */
    var viewport = document.createElement("div");
    viewport.setAttribute("data-drift-sideways-viewport", "");
    document.body.appendChild(viewport);

    var kids = [].slice.call(document.body.childNodes);
    for (var k = 0; k < kids.length; k++) {
      if (kids[k] !== viewport) viewport.appendChild(kids[k]);
    }

    /* BODY'S GUTTERS MOVE TO THE WRAPPER. The page's left margin
       belongs to body, and body no longer contains anything -- so
       without this the name and the nav sit flush against the edge
       of the screen the moment the event turns on. */
    var frame = window.getComputedStyle(document.body);
    viewport.style.paddingTop =
      (parseFloat(frame.marginTop) + parseFloat(frame.paddingTop)) + "px";
    viewport.style.paddingLeft =
      (parseFloat(frame.marginLeft) + parseFloat(frame.paddingLeft)) + "px";
    viewport.style.paddingRight =
      (parseFloat(frame.marginRight) + parseFloat(frame.paddingRight)) + "px";

    /* THE MASTHEAD TRAVELS WITH THE STRIP. Everything above the rule
       is wrapped and translated by the same amount, so the name and
       the nav slide off to the left as the page turns -- the rule
       itself is left out and stays where it is, which is the one
       fixed edge the whole layout is hung from. */
    var rule = viewport.querySelector("hr");
    var head = null;
    if (rule) {
      head = document.createElement("div");
      head.setAttribute("data-drift-sideways-head", "");
      while (viewport.firstChild && viewport.firstChild !== rule) {
        head.appendChild(viewport.firstChild);
      }
      viewport.insertBefore(head, rule);
    }

    var spacer = document.createElement("div");
    spacer.setAttribute("data-drift-sideways-spacer", "");
    document.body.appendChild(spacer);

    /* The native scrollbar is vertical and the page moves sideways,
       so it would be pointing the wrong way. Hidden in CSS, and one
       drawn along the bottom instead -- which also has to be
       draggable, or the visitor loses a way of moving they had.

       Outside the pinned viewport, so it stays put. */
    var bar = document.createElement("div");
    bar.setAttribute("data-drift-sideways-bar", "");
    var thumb = document.createElement("div");
    thumb.setAttribute("data-drift-sideways-thumb", "");
    bar.appendChild(thumb);
    document.body.appendChild(bar);

    sideways = {
      main: main, strip: strip, viewport: viewport, head: head,
      spacer: spacer, bar: bar, thumb: thumb,
      travel: 0, over: 0, push: 0, frame: 0, settle: 0,

      /* Read once here rather than per frame. applyDomEvents rebuilds
         the strip whenever the active set changes, so a mirror
         arriving or leaving re-runs this line anyway. */
      mirrored: document.documentElement.matches('[data-event~="mirrored-page"]')
    };

    sideways.onScroll = function () { drawSideways(); };
    sideways.onResize = function () { measureSideways(); drawSideways(); };
    sideways.onWheel = function (event) { pushSideways(event.deltaY); };

    /* THE FOOTER AND THE BACK-TO-TOP LINK MOVE TO THE RIGHT EDGE.
       Left in the flow the footer becomes another column at the end
       of the strip, landing against whatever the last block happened
       to be -- and the link, which page.js drops in on its own and
       is NOT inside the footer, lands somewhere else again.

       At the bottom of a normal page those two sit at opposite ends
       of one line, reached when the scroll runs out. Turned, that is
       the right edge, and they keep the same relationship: this band
       is that line rotated with the page.

       Outside the pinned wrapper, so the mirror does not take it --
       a fixed element inside a transformed ancestor stops being
       fixed, which is the trap the wrapper itself fell into. */
    var edge = document.createElement("div");
    edge.setAttribute("data-drift-sideways-edge", "");
    document.body.appendChild(edge);

    sideways.edge = edge;
    sideways.moved = [];

    [document.querySelector(".to-top"),
     viewport.querySelector("footer")].forEach(function (node) {
      if (!node) return;
      sideways.moved.push({
        node: node, home: node.parentNode, next: node.nextSibling
      });
      edge.appendChild(node);
    });

    window.addEventListener("scroll", sideways.onScroll, { passive: true });
    window.addEventListener("resize", sideways.onResize);
    window.addEventListener("wheel", sideways.onWheel, { passive: true });

    dragSideways(bar);

    measureSideways();

    /* NOTHING TO TURN. A project page short enough to fit one column
       has no travel, and a strip with no travel is a page that looks
       rearranged for no reason and carries a scrollbar that cannot
       move. Put everything back and let the page be a page. */
    if (sideways.travel < 1) {
      stopSideways();
      return false;
    }

    drawSideways();
    return true;
  }

  /* THE SPRING AT THE ENDS.

     A page that has run out of scroll and is pushed further bounces
     and comes back. That behaviour belongs to the document's
     vertical scroll, and this page has given its vertical scroll
     away -- so at the ends of the strip the gesture simply did
     nothing, which feels like the page has died rather than like it
     has finished.

     The browser clamps scrollY at the ends, so the overshoot cannot
     be read from it and is accumulated from the wheel instead.
     Asymptotic rather than linear: the harder it is pushed the less
     it gives, which is what makes it read as resistance rather than
     as slack.

     Not an animation in the S14 sense -- it is the tail of a
     gesture, the same as the bounce it replaces -- but it does move
     on its own for a few frames, so reduced-motion skips it. */
  function pushSideways(delta) {
    if (!sideways || reducedMotion()) return;

    var atEnd = window.scrollY >= sideways.travel - 0.5;
    var atStart = window.scrollY <= 0.5;

    if (!((atEnd && delta > 0) || (atStart && delta < 0))) {
      if (sideways.push) springSideways();
      return;
    }

    sideways.push += delta * 0.6;
    sideways.over = OVER_MAX * sideways.push /
                    (Math.abs(sideways.push) + OVER_MAX);
    drawSideways();

    window.clearTimeout(sideways.settle);
    sideways.settle = window.setTimeout(springSideways, 90);
  }

  function springSideways() {
    if (!sideways) return;
    window.clearTimeout(sideways.settle);

    if (sideways.frame) window.cancelAnimationFrame(sideways.frame);

    var step = function () {
      if (!sideways) return;

      sideways.push *= 0.78;
      sideways.over = OVER_MAX * sideways.push /
                      (Math.abs(sideways.push) + OVER_MAX);

      if (Math.abs(sideways.over) < 0.4) {
        sideways.over = 0;
        sideways.push = 0;
        sideways.frame = 0;
        drawSideways();
        return;
      }

      drawSideways();
      sideways.frame = window.requestAnimationFrame(step);
    };

    sideways.frame = window.requestAnimationFrame(step);
  }

  function measureSideways() {
    if (!sideways) return;
    var strip = sideways.strip;
    var main = sideways.main;

    /* Clear the inline sizes first, or every measurement after the
       first is taken against the last one's answer. */
    strip.style.height = "";
    sideways.spacer.style.height = "";

    /* The viewport wrapper is pinned at the top of the screen, so a
       rect read straight off main is already its offset inside it --
       no scroll to add, because there is no longer any scrolling
       for it to have done. */
    var top = main.getBoundingClientRect().top;
    var height = Math.max(200, window.innerHeight - top);
    strip.style.height = height + "px";

    /* One column the width of the content column, so the first
       column is the page as it was. */
    strip.style.columnWidth = main.clientWidth + "px";

    /* How far the strip has to travel, and therefore how much
       document the spacer has to invent. */
    sideways.travel = Math.max(0, strip.scrollWidth - main.clientWidth);
    sideways.spacer.style.height =
      (sideways.travel + window.innerHeight) + "px";
  }

  function drawSideways() {
    if (!sideways) return;

    var x = Math.min(Math.max(window.scrollY, 0), sideways.travel) +
            sideways.over;
    var shift = "translate3d(" + (-x) + "px, 0, 0)";

    sideways.strip.style.transform = shift;
    if (sideways.head) sideways.head.style.transform = shift;

    var span = sideways.travel + sideways.main.clientWidth;
    var visible = sideways.main.clientWidth / (span || 1);
    var at = Math.min(Math.max(window.scrollY, 0), sideways.travel) /
             (span || 1);

    /* Under the mirror the page runs right to left, so the thumb has
       to as well or the one control on screen contradicts the thing
       it controls. The thumb's own width comes off the offset,
       because mirroring a box means mirroring its far edge, not its
       near one. */
    if (sideways.mirrored) at = 1 - at - visible;

    sideways.thumb.style.width = (visible * 100).toFixed(2) + "%";
    sideways.thumb.style.left = (at * 100).toFixed(2) + "%";
  }

  /* Dragging the drawn bar scrolls the real document, so the two can
     never disagree: there is one position, and it is scrollY. */
  function dragSideways(bar) {
    function to(event) {
      if (!sideways) return;
      var box = bar.getBoundingClientRect();
      var at = (event.clientX - box.left) / (box.width || 1);

      /* Mirrored with the thumb, so grabbing it moves it with the
         pointer rather than away from it. The two flips have to be
         made together: either alone gives a control that fights
         whoever is using it. */
      if (sideways.mirrored) at = 1 - at;

      window.scrollTo(0, Math.round(at * sideways.travel));
    }

    bar.addEventListener("pointerdown", function (event) {
      bar.setPointerCapture(event.pointerId);
      to(event);
      event.preventDefault();
    });

    bar.addEventListener("pointermove", function (event) {
      if (bar.hasPointerCapture && bar.hasPointerCapture(event.pointerId)) {
        to(event);
      }
    });
  }


  function applyDomEvents() {
    /* The timer holds references to spans this teardown destroys. */
    stopLineShuffle();
    stopSideways();
    clearFurniture();
    clearFacts();
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

    /* BEFORE THE LINE EVENTS, and this is load-bearing. They wrap
       every word in its own span, which leaves each text node
       holding exactly one word -- and a run needs a node with
       several in it. Run after them and `selected` finds no
       candidate anywhere and silently does nothing whenever a line
       event happens to be active.

       The seed is kept on the event record, so the phrase stays put
       across a re-measure and only moves when the event itself is
       re-rolled. */
    if (active["selected"]) {
      if (!active["selected"].seed) {
        active["selected"].seed = Math.floor(Math.random() * 1e9);
        save();
      }
      var run = TEXT.run("selected", 3, 9, seeded(active["selected"].seed));
      if (drift.DEBUG) {
        console.log("selected  " + (run ? run + " words highlighted"
                                        : "no node long enough"));
      }
    }

    if (active["zalgo-word"]) {
      if (!active["zalgo-word"].seed) {
        active["zalgo-word"].seed = Math.floor(Math.random() * 1e9);
        save();
      }
      var frayed = TEXT.zalgo("zalgo-word",
                              active["zalgo-word"].stack || 2,
                              seeded(active["zalgo-word"].seed));
      if (drift.DEBUG) {
        console.log("zalgo-word  " + (frayed ? '"' + frayed + '"' +
                    "  stack " + (active["zalgo-word"].stack || 2)
                    : "no word long enough"));
      }
    }

    /* AFTER `selected`, BEFORE the line events. Both neighbours care.

       `selected` refuses any node inside a link, so if the page were
       already full of injected links it would have nowhere left to
       highlight. And the line events wrap words in spans, which is
       harmless inside an anchor but leaves nothing for a linker to
       split if it ran the other way round. */
    var linker = active["super-hyperlink"] || active["hyperlink"];
    if (linker) {
      if (!linker.seed) {
        linker.seed = Math.floor(Math.random() * 1e9);
        save();
      }
      var linked = TEXT.link(
        linker.id,
        linker.id === "super-hyperlink" ? Infinity : 1,
        seeded(linker.seed)
      );
      if (drift.DEBUG) {
        console.log(linker.id + "  " + linked + " words linked");
      }
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

    if (active["mirrored-letters"]) {
      var flipped = TEXT.letters(MIRROR_LETTERS, "mirrored-letters");
      if (drift.DEBUG) {
        console.log("mirrored-letters  " + flipped + " flipped  (" +
                    MIRROR_LETTERS.join("") + ")");
      }
    }

    var furniture = active["form-furniture"] || active["form-infestation"];
    if (furniture && furniture.furniture) {
      var n = placeFurniture(
        furniture.furniture,
        furniture.id,
        furniture.id === "form-furniture",          /* avoid images */
        furniture.id === "form-infestation" ? 20 : 0 /* floor */
      );
      if (drift.DEBUG) {
        var how = furniture.furniture.count
          ? "count " + furniture.furniture.count
          : "density " + furniture.furniture.density.toFixed(1) + "/screen";
        console.log(furniture.id + "  " + n + " controls  (" + how + ")");
      }
    }

    var facts = active["did-you-know-madness"] || active["did-you-know"];
    if (facts) {
      placeFacts(facts);
      if (drift.DEBUG) {
        console.log(facts.id + "  drawing at counter " + state.counter);
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

    if (active["zalgo"]) {
      if (!active["zalgo"].seed) {
        active["zalgo"].seed = Math.floor(Math.random() * 1e9);
        save();
      }
      /* LAST, deliberately. Everything above has already claimed its
         spans and collect() will not descend into them -- so the
         marked word, the selection and the letters spelling the lock
         combination come through legible while the rest of the page
         comes apart around them. */
      var buried = TEXT.zalgoAll("zalgo",
                                 active["zalgo"].stack || 12,
                                 seeded(active["zalgo"].seed));
      if (drift.DEBUG) {
        console.log("zalgo  " + buried + " nodes  stack " +
                    (active["zalgo"].stack || 12));
      }
    }

    if (active["sideways"]) {
      /* LAST of everything, because it measures. Every text event
         above changes how long the content is, and the strip's
         travel is exactly that length -- measured before they had
         finished, the page would run out of scroll before it ran
         out of columns. */
      var turned = startSideways();
      if (drift.DEBUG) {
        if (!turned) {
          console.log("sideways  nothing to turn");
        } else {
          var box = sideways.main.getBoundingClientRect();
          console.log("sideways  travel " + Math.round(sideways.travel) +
                      "  column " + Math.round(box.width) + "x" +
                      Math.round(parseFloat(sideways.strip.style.height)) +
                      "  main top " + Math.round(box.top) +
                      "  strip " + Math.round(sideways.strip.scrollWidth) +
                      "  blocks " + sideways.strip.children.length);
        }
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
                 " · reroll " + drift.pReroll(state.counter).toFixed(2) +
                 " · remove " +
                 (state.counter < drift.T.breakingPoint
                   ? drift.pRemove(state.counter).toFixed(2) + " each"
                   : drift.T.postFlipRemoval.toFixed(2) + " once  [FLIPPED]") +
                 " · intensity " + drift.intensityAt(state.counter).toFixed(2));
    }

    if (roll && !roll.gated) {
      lines.push("roll: " +
                 (roll.spawned ? "+" + roll.spawned + " (" + roll.tier + ")" : "no spawn") +
                 (roll.rerolled ? "  ~" + roll.rerolled : "") +
                 (roll.converted ? "  =>" + roll.converted : "") +
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
    lines.push("fonts " + ready + "/" + totalFonts +
               " ready");

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
