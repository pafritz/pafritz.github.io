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
    eventGate: 6,

    /* SPAWN? — probability an event occurs this navigation.

       The curve is defined by its two ends rather than by a slope:
       it starts at spawnBase the moment events open, and reaches
       spawnMax exactly at the breaking point. Move either gate and
       the ramp follows on its own.

       So the two thresholds coincide: at the counter where changes
       stop going away, they also start arriving almost every
       navigation. Before it, a third of navigations do nothing and
       most of what does arrive is gone again shortly. After it,
       nineteen navigations in twenty bring something and almost
       nothing leaves. */
    spawnBase:   0.12,
    spawnMax:    0.95,

    /* RE-ROLL? — chance that one already-active event changes its
       values. Climbs with depth on the same two anchors as the
       spawn curve, so the endgame is progressively more agitated
       rather than flatly so. */
    rerollBase:  0.05,
    rerollMax:   0.80,

    /* REMOVE? — per-event chance, decaying toward zero. Also
       measured in depth. */
    removeBase:  0.55,
    removeDecay: 45,

    /* The mode flip (§6). Below it, every active event rolls to be
       removed and the set self-corrects. Above it, one check per
       navigation regardless of how many are active, so the set can
       only grow. This is the main dial in the whole system.

       Absolute counter values, not depth. With the gate at 6 that
       leaves 24 navigations of "changes come and go" before things
       start sticking. */
    breakingPoint:   30,
    postFlipRemoval: 0.35,

    /* How deep before a scaling event reaches full strength. Angles
       and similar magnitudes ramp from soft at the gate to their
       full range here.

       Aligned with the BREAKING POINT rather than with rareGate:
       the commons reach full volume at the moment their changes
       start to stick, which is one escalation rather than two, and
       leaves the rare tier as a separate later beat instead of
       landing on top of it. */
    intensityFull: 30,


    /* Gates. */
    rareGate:      40,
    /* How far past rareGate before rares reach their full weight,
       as a MULTIPLE of the ramp the commons use -- so it tracks the
       gates instead of being a standalone number that quietly stops
       making sense when they move. */
    rareRampFactor: 1.25,
    rareWeightMax: 0.22,

    uncommonBase: 0.12,
    uncommonMax:  0.28,

    rareLifeMin: 2,
    rareLifeMax: 3,

    /* presence — ungated, and outside the tier system entirely.

       It is not a common and not a rare: it does not compete for
       the spawn, does not exclude anything, and can sit alongside a
       full set of events. Its own roll, every navigation, from the
       first one.

       LOW, BECAUSE IT WAITS. An armed record holds until an image
       is opened, so arming often does not mean appearing often --
       it means being permanently armed, and the face turning up on
       every lightbox. Once it is expected it is nothing. At 0.03 it
       arms about every thirty navigations, which is once or twice
       in a long session and never on a short one. */
    presenceChance: 0.03,
    presenceLife:   2
  };

  /* ---------------------------------------------------------------
     EVENT REGISTRY
     One entry per event. Every field except `tier` is optional.

       tier      "common" | "rare"          required
       weight    relative pick odds          default 1
       gate      own counter threshold       default: tier's gate
       maxGate   stops being spawnable here   default: never
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

    /* Bullets. --marker is disc by default, so every variant here
       is a real non-default.

       ONE POOL, NOT TWO. The numbered ones read as the markup being
       different rather than the styling -- a bulleted list quietly
       turning out to be ordered. The arbitrary characters and the
       non-Latin counters read as the page having inherited a locale
       it should not have. Neither is disruptive enough to hold back
       for the rare tier: a list is still a list whatever sits in
       front of it, and the visitor can still read and click every
       item.

       list-style-type accepts an arbitrary string, so the dagger
       and the rest are not pseudo-elements or hacks -- they are the
       real property doing what it was specified to do.

       `none` is the quietest and the most disruptive at once: it
       hits the nav, and a list with no markers stops reading as a
       list. */
    "marker": {
      tier: "common",
      variants: ["circle", "square", "none", "decimal",
                 "lower-roman", "upper-alpha",
                 "dagger", "reference", "negation", "cross",
                 "arrow", "middot", "dash", "cjk", "hebrew"]
    },

    /* bg-drift - white stops being white. Warm rather than cool: a
       cool shade reads as a miscalibrated monitor, a warm one reads
       as paper. */
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

    /* §5 — the text skew, and the reason --skew has been sitting
       declared but unwired in style.css since the start.

       Angles are ROLLED, not listed. Every spawn gets its own
       magnitude and its own direction, so the same mode never looks
       twice the same. The mode only sets the range.

       The anchor must vary VERTICALLY. skewX maps a point to
       x + (y - originY) * tan(angle) — the origin's x never appears,
       so left/center/right are mathematically identical. Only the
       vertical position does anything: it decides which line holds
       still while the rest slide. */
    "skew": {
      tier: "common",
      variants: {
        mode:   ["subtle", "uniform", "scatter"],
        origin: ["top", "center", "bottom"]
      },
      props: function (record, state, rng) {
        var mode = record.variants.mode;

        /* Each range ramps from soft at the gate to full at depth.
           lerp(soft, loud) reads the counter, so an early spawn is
           a hint and a late one is the real thing. */
        if (mode === "subtle") {
          return { "--skew": rng.signed(rng.lerp(0.1, 0.3),
                                        rng.lerp(0.4, 1)) + "deg" };
        }
        if (mode === "uniform") {
          return { "--skew": rng.signed(rng.lerp(0.4, 1.2),
                                        rng.lerp(1, 3)) + "deg" };
        }

        /* scatter: five independent angles, consumed by an
           nth-child cycle in drift.css. Five shares no factor with
           a typical paragraph count, so the pattern does not line
           up with the page. */
        var out = { "--skew": "0deg" };
        for (var i = 1; i <= 5; i++) {
          out["--skew-" + i] = rng.signed(rng.lerp(0.3, 1),
                                          rng.lerp(1.2, 4)) + "deg";
        }
        return out;
      }
    },

    /* form-furniture — orphaned form controls, attached to nothing.

       A bare checkbox between two paragraphs, a slider with no
       label, a submit button that submits nothing. Pure unstyled-
       HTML detritus, which is what the whole site is impersonating.

       IT GROWS. The count scales from one at the event gate to four
       at the breaking point. What each control DOES is a flat coin
       toss: half sit in the flow and push the text down, half
       ignore the layout and land anywhere on the page. Escaping is
       what the control is, not a measure of depth -- ramping it
       meant the early ones were all in the flow, where a lone
       checkbox between two paragraphs is easy to miss entirely.
       Depth is carried by the count.

       A FLAT COUNT, not a per-screen density. form-infestation is
       the one measured per screen, because filling a page up is
       proportional to the page by definition. At these numbers it is
       not: per-screen turned one event into two, a pair of controls
       on a short page and ten down a long one.

       An escaped control sits at z-index -1: above the page's
       background, below every element's content. So it can never
       cover an image -- where it overlaps one it vanishes behind it
       and sticks out at the edge -- and text stays perfectly
       readable with the control peeking out around the words. The
       rule that keeps it off the images is the same rule that lets
       it go anywhere.

       maxGate: it stops being spawnable at the rare threshold,
       because past that it is replaced by form-infestation. */
    "form-furniture": {
      tier: "common",
      maxGate: 25,
      becomes: "form-infestation",
      becomesAt: 25,
      dom: true,
      props: function (record, state) {
        var span = Math.max(1, T.breakingPoint - T.eventGate);
        var t = clamp01((state.counter - T.eventGate) / span);

        record.furniture = buildFurniture(
          { count: Math.round(1 + t * 3) },  /* one at the gate, four at the flip */
          0.5                                /* loose or not, an even split */
        );
        return null;
      }
    },

    /* form-infestation — the same controls, past all restraint.

       Not a separate idea: it is what form-furniture becomes. When
       the counter crosses the rare threshold an active
       form-furniture is CONVERTED rather than removed, so the
       escalation is continuous instead of one event stopping and
       another starting.

       Everything escapes. Twenty to forty controls, none of them in
       the flow, all of them behind the content. */
    "form-infestation": {
      tier: "rare",
      dom: true,
      props: function (record, state) {
        record.furniture = buildFurniture(
          { density: 6 },   /* per screen, with a floor applied in drift.js */
          1                 /* all of them loose */
        );
        return null;
      }
    },

    /* red-letters — spells the lock combination by colouring one
       letter at a time across the page: the first `n`, then the
       next `i` after it, and so on through "nine four six seven".

       DOM event, not a token event. It needs the text engine in
       drift.js, so unlike every event above it cannot apply before
       first paint. Sixteen letters changing colour a frame late is
       imperceptible.

       The whole code, every time. A sparse page may run out of
       letters before finishing — that is fine and deliberate: the
       visitor gets a partial reading and better luck on the next
       page. It never wraps around, because a sequence that restarts
       stops being a sequence. */
    "red-letters": {
      tier: "common",
      weight: 1.5,
      dom: true
    },

    /* rotate — the block tips as a rigid object. Distinct from
       skew, where the glyphs themselves shear and verticals go
       slanted; here the letterforms are untouched and the whole
       paragraph turns.

       Nine anchors, not three. A rotation matrix uses both x and y,
       so `left top` and `right bottom` genuinely differ — unlike
       skewX, which ignores the origin's x entirely.

       Purely visual: transform does not affect layout, so a rotated
       block keeps its original box and nothing reflows. The corners
       do reach outside that box, so the common angles stay small
       enough that neighbours do not collide. rotate-extreme is
       where that is allowed to happen. */
    "rotate": {
      tier: "common",
      variants: {
        mode:   ["subtle", "uniform", "scatter"],
        originX: ["left", "center", "right"],
        originY: ["top", "center", "bottom"]
      },
      props: function (record, state, rng) {
        var mode = record.variants.mode;

        /* Smaller than skew at every step. A rotated block's corners
           swing further than a sheared one's for the same angle, and
           the page has only its margins to absorb the overhang. */
        if (mode === "subtle") {
          return { "--rotate": rng.signed(rng.lerp(0.05, 0.2),
                                          rng.lerp(0.2, 0.6)) + "deg" };
        }
        if (mode === "uniform") {
          return { "--rotate": rng.signed(rng.lerp(0.2, 0.6),
                                          rng.lerp(0.5, 1.5)) + "deg" };
        }

        var out = { "--rotate": "0deg" };
        for (var i = 1; i <= 5; i++) {
          out["--rotate-" + i] = rng.signed(rng.lerp(0.15, 0.5),
                                            rng.lerp(0.5, 1.8)) + "deg";
        }
        return out;
      }
    },

    /* Louder than the rest — it flips the page from accidental to
       authored, which contradicts the note in style.css on purpose.
       Gated above the others; move to rare if it reads too strong.

       `justify` is the no-flag-edge one: every line ends at the
       same point. Only reads on paragraphs long enough to wrap. */
    "align": {
      tier: "common",
      variants: ["center", "right", "justify"]
    },

    /* hyperlink — one word in the prose quietly becomes a link, and
       it works: clicking it opens a Wikipedia search for that word
       in a new tab.

       The strongest version of this site's premise. Everything else
       makes the page look wrong; this makes it BEHAVE wrong while
       looking completely ordinary, because an injected link is
       styled by style.css exactly like a real one. There is no way
       to tell which links the artist wrote and which the page grew
       until one of them goes somewhere absurd.

       New tab, so the visitor never loses their place -- and
       because a surviving document is what lets the click count as
       a navigation and re-drift in place.

       Excludes its rare: with every word already linked there is
       nothing for a single link to add. */
    "hyperlink": {
      tier: "common",
      dom: true,
      excludes: ["super-hyperlink"]
    },

    /* zalgo-word — one word grows combining marks.

       The full-page version was considered and left out: stacked
       diacritics on everything is a very specific internet-2012
       register, and at that scale the marks collide with every line
       around them. One word is the same idea at a dose this site
       can hold -- a single word coming apart in an otherwise
       completely ordinary paragraph.

       The text is REWRITTEN rather than styled, so the engine keeps
       the original on the span and teardown restores it exactly.

       stack is how many marks a character may take, scaled with
       depth: 6 at the gate, 12 at full intensity. Rolled in props,
       so it re-rolls when the event does and holds still otherwise. */
    "zalgo-word": {
      tier: "common",
      dom: true,
      excludes: ["zalgo"],
      props: function (record, state) {
        record.stack = 6 + Math.round(intensityAt(state.counter) * 6);
        record.seed = Math.floor(Math.random() * 1e9);
        return null;
      }
    },

    /* zalgo — the whole page, at a depth the word version never
       reaches: 12 marks a character at the rare threshold, 20 by
       the bottom of a long session.

       Measured PAST rareGate rather than by intensity, because
       intensity is already 1 by the time a rare can fire -- so a
       rare that scales needs its own ramp, and this one borrows the
       span the rare weights use so it tracks the gates.

       Excludes the word version, which would be one word frayed
       slightly differently inside a page frayed completely.

       This is the event that most needs its two-to-three navigation
       lifespan. Nothing is destroyed -- the original text rides on
       the span and comes back exactly -- but for as long as it is
       on, the page cannot be read. */
    /* sideways — the page reads left to right, and the visitor
       scrolls exactly as they always did.

       The scroll is REAL: a spacer gives the document the height it
       would have had and the strip is translated by whatever
       scrollY reports. Wheel, trackpad inertia, iOS momentum,
       spacebar, Page Down, arrow keys and find-in-page all keep
       working without a line of code each, which faking the scroll
       would have cost.

       Excludes `vertical` only. Both rewrite the direction text
       runs in and one of them would silently win.

       mirrored-page is deliberately NOT excluded: it flips body, so
       the strip travels the other way and the page reads right to
       left. That is two events composing into a third thing rather
       than fighting, which is the rarest outcome in this set and
       worth keeping. */
    /* presence — a face at very low opacity behind the lightbox
       image, revealed across the screen when the lightbox closes.

       NOT A JUMPSCARE. No sound, no movement, barely above the
       paper. A visitor should not be certain they saw anything; the
       difference between uncanny and startling is the opacity and
       the absence of motion, and both are held at the quiet end.

       OUTSIDE THE TIER SYSTEM. It is neither common nor rare: it
       has its own roll every navigation at its own low chance, it
       is ungated, and it does not compete for the spawn -- so it
       can arrive alongside a full set of events rather than instead
       of one. Nothing excludes it and it excludes nothing.

       IT WAITS TO BE SEEN. The lifespan does not start until the
       visitor opens an image, because the event needs a lightbox to
       happen at all -- a record that armed while they were clicking
       through text would expire having shown nothing. Held until it
       fires, then two navigations, lightboxes and links alike.

       Needs presence.png beside drift.js. Without it the layer is
       there and empty, which shows nothing -- the event fails
       silently rather than drawing a broken image across the
       screen. */
    "presence": {
      tier: "special",
      dom: true,
      waits: true,
      life: 2
    },

    "sideways": {
      tier: "rare",
      dom: true,
      excludes: ["vertical"]
    },

    "zalgo": {
      tier: "rare",
      dom: true,
      excludes: ["zalgo-word"],
      props: function (record, state) {
        var span = Math.max(1, (T.intensityFull - T.eventGate) *
                               T.rareRampFactor);
        var over = clamp01((state.counter - T.rareGate) / span);

        record.stack = 12 + Math.round(over * 8);
        record.seed = Math.floor(Math.random() * 1e9);
        return null;
      }
    },

    /* selected — a phrase rendered as though it were already
       selected, as if someone had been reading the page and left
       the cursor where they stopped.

       THE SYSTEM COLOURS, not a chosen blue. `Highlight` and
       `HighlightText` resolve to whatever this visitor's own OS
       uses, so the highlight is identical to the one they get when
       they drag across a paragraph themselves. That identity is the
       whole effect: a blue of our choosing reads as decoration,
       their own selection colour reads as a selection they did not
       make.

       The run is drawn from whatever prose the page happens to
       have, not from an authored phrase -- no phrase written here
       would appear on more than one page. */
    "selected": {
      tier: "common",
      dom: true
    },

    /* redaction — every text block becomes continuous bars, one per
       line, spaces included, ending ragged on the last line.

       Images are untouched: bars over the writing with the
       photographs still visible is the image. Blacking out the work
       as well would just be a dark page.

       The nav and the title redact too. By this depth the visitor
       knows where they are, and it expires after two or three
       navigations, so clicking blind is part of it. */
    /* skew-lines — each LINE at its own angle, rather than each
       paragraph. Lines are not elements, so the text engine wraps
       every word and then groups them by measured vertical position:
       words sharing a top are on the same line.

       Common, because at low intensity it reads as a page that has
       come slightly loose rather than as an effect.

       The grouping is only valid until something reflows the page,
       so drift.js re-measures on resize. That matters more here than
       it would for a rare: a common can stay active for dozens of
       navigations, long enough for a window to be resized. */
    "skew-lines": {
      tier: "common",
      dom: true
    },

    /* rotate-lines — each line tipping as a rigid strip. The
       sibling of skew-lines, but a different problem: rotating each
       word about its own centre would give a wavy row of tilted
       words, so every word also carries a translation derived from
       its position along the line.

       Rare, and static. A rotated line displaces its far end by far
       more than a sheared one, so the per-second reshuffle that
       suits skew-lines would be a strobe here. */
    "rotate-lines": {
      tier: "rare",
      dom: true
    },

    /* mirrored-letters — one letter, everywhere it appears, flipped
       horizontally.

       The pool is the near-symmetric letters, so the flip reverses
       the stroke stress rather than producing a visibly backwards
       glyph: a W thin where it should be thick. Legible, and wrong
       in a way that is hard to name.

       All of them at once, everywhere they appear. One letter at a
       time would read as a single damaged glyph; the whole set
       flipped reads as a typeface that was cut wrong.

       Case is part of the set: A works in caps only, l lowercase
       only, the rest in both. The list lives in drift.js. */
    "mirrored-letters": {
      tier: "common",
      dom: true
    },

    /* mirrored-page — the text reversed, readable in a mirror and
       nowhere else.

       Text only. Images stay as they are: a mirrored photograph is
       just a photograph the wrong way round, and nobody would know.
       A mirrored page of writing is unmistakable.

       The transform sits on the text blocks, never on html, body or
       main, for the same reason as skew and rotate -- a transform
       makes an element a containing block for fixed-position
       descendants and would capture the three.js overlay. */
    "mirrored-page": {
      tier: "rare"
    },

    /* vertical — text runs downward with the letters upright, the
       way Japanese vertical typesetting handles Latin. Each
       paragraph becomes a tall narrow column and the page becomes
       enormously long.

       Applied per text block, not to body: on body the whole
       document turns sideways and scrolls horizontally, which is a
       different event. Per block, the blocks still stack top to
       bottom, so scrolling stays vertical and only the writing
       turns.

       upright  each glyph stands the right way up. Latin was never
                meant to do this and it shows.
       rotated  glyphs turn with the line, readable with a tilted
                head. Quieter. */
    "vertical": {
      tier: "rare",
      variants: ["upright", "rotated"],

      /* Symmetric with sideways. The pick tests a CANDIDATE's own
         excludes against what is already active, so a one-sided
         declaration only stops the pair in one order. */
      excludes: ["sideways"]
    },

    /* redaction — the same wrapper, three densities.

         bars    the text is covered
         lines   the text is gone, only its shape is left
         struck  the text stays readable with a line through it

       struck is the mildest and reads as an edit rather than a
       censoring, so it is the one a visitor can still work around. */
    "redaction": {
      tier: "rare",
      dom: true,
      variants: ["bars", "lines", "struck"]
    },

    /* align-total — the same three values, taken by the whole page.

       The common deliberately leaves the nav, the title and the
       back/to-top links alone, so an aligned page still has a fixed
       frame around moving prose. This takes the frame too, and the
       images with it.

       NOT an exclusion of `align`. Both write --align, and the rare
       sits below the common in drift.css at equal specificity, so
       source order decides while both are active and the page peels
       back to the common's alignment when this expires rather than
       snapping to left-flush.

       Reads as 1996 on sight: a centred nav over a centred heading
       over centred paragraphs is a specific and very dated page. */
    /* super-hyperlink — every word its own link, each to a search
       for itself.

       Not "more links": a different reading of the page. Text where
       everything is a link is text with no emphasis left in it,
       since a link is the one piece of formatting that means
       something specific -- and a page where every word claims to
       lead somewhere is claiming nothing.

       Rare, and short-lived. The real links are still in there,
       indistinguishable, so for two or three navigations the
       visitor cannot tell the navigation from the noise. */
    "super-hyperlink": {
      tier: "rare",
      dom: true,
      excludes: ["hyperlink"]
    },

    /* did-you-know — a box of Wikipedia trivia in the corner of the
       nav, as a fieldset with a legend.

       THE ONLY ADDITIVE EVENT IN THE SET. Everything else alters
       what the generator produced; this puts something on the page
       that was never there. Worth having for that alone.

       The facts are real, harvested from Wikipedia's Did You Know
       archives, which is what makes it work: invented trivia reads
       as writing, and true trivia reads as a component that wandered
       in from another website entirely. */
    "did-you-know": {
      tier: "common",
      dom: true,
      excludes: ["did-you-know-madness"]
    },

    /* did-you-know-madness — five to twenty of them, loose.

       Not in the flow, so nothing reflows; clipped, so the page
       does not grow; behind the content, so a box can pass under a
       photograph but never over one. The work stays visible and the
       trivia piles up around it.

       Excludes the common. One box in the nav is a component that
       wandered in; twenty scattered is an infestation. Both at once
       is neither. */
    "did-you-know-madness": {
      tier: "rare",
      dom: true,
      excludes: ["did-you-know"]
    },

    "align-total": {
      tier: "rare",
      variants: ["center", "right", "justify"]
    },

    "font-weird": {
      tier: "rare",
      weight: 2,
      variants: function (state) { return loadedFonts(state, "rare"); }
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
      code: null,            /* the lock combination — per browser */
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

  /* The controls themselves. Chosen for being recognisably form
     furniture at a glance, and for rendering at wildly different
     sizes -- a checkbox is 13px square and a range slider is 130
     wide, which is what makes a scatter of them read as debris
     rather than as a pattern. */
  var CONTROLS = [
    /* states and values */
    "checkbox", "radio", "range", "number", "progress", "meter",
    /* text entry */
    "text", "password", "search", "textarea", "datalist",
    /* pickers */
    "select", "date", "time", "color", "file",
    /* dead actions */
    "submit", "submit-blank", "reset", "button", "image"
  ];

  /* A few worth knowing about:

     image   an <input type="image"> pointed at a source that
             cannot decode, so it renders the browser's own
             broken-image icon. A form control that displays as a
             failed image is about as close to this site's premise
             as HTML gets. An ABSENT src is not enough -- browsers
             disagree on whether that draws anything -- so it gets a
             deliberately invalid data URL, which fails locally with
             no network request.

     radio   always a CLUSTER of two to four sharing a name. A lone
             radio button cannot show what a radio button does; a
             group where picking one releases the others can.

     file    opens the system file dialog. Nothing is uploaded --
             there is no form, no action, no fetch -- the browser
             hands the page a File object that sits in memory and
             goes nowhere. The filename appears beside the button
             and vanishes on reload.

     submit / submit-blank
             the same control with and without its label. One reads
             "Submit" and is unmistakably form furniture; the other
             is a tiny empty button, which is its own kind of wrong.

     datalist
             a text field offering suggestions. The only control
             here that proposes rather than states, which on a page
             with no form implies something knows what you were
             about to type. */

  var SUGGESTIONS = [
    "Full name",
    "Preferred name",
    "Reason for visit",
    "Purpose of enquiry",
    "How did you hear about us",
    "Date of last visit",
    "Relationship to the work",
    "Other",
    "Please specify",
    "Not applicable",
    "Prefer not to say",
    "Same as above",
    "See attached",
    "To be confirmed",
    "No longer in use"
  ];

  /* Two ways to ask for controls, and which one an event uses is
     the difference between the two events.

       count    a flat number, placed whatever the page turns out to
                be. What form-furniture uses.
       density  per viewport-height, multiplied in drift.js by how
                many screens tall the page measured. What
                form-infestation uses.

     THE DENSITY WAS WRONG FOR THE COMMON. Per-screen is the right
     measure for a page that is meant to fill up, because filling up
     is proportional to the surface by definition. At one to four
     controls it is the wrong measure entirely: the same event buys
     two controls on a short page and ten on a long one, and ten
     orphaned controls is not a louder version of two, it is a
     different event. A flat count reads as the same small wrongness
     wherever it lands, which is what a common is for.

     Positions are still percentages of the document, so the escaped
     ones spread over the whole page however long it is. Only how
     MANY changed, not where they go.

     No rotation. They are loose in their position, not in their
     bearing -- a tilted control reads as decoration, an upright one
     in the wrong place reads as debris. */
  function buildFurniture(spec, escapeChance) {
    spec.escape = escapeChance;
    spec.seed = Math.floor(Math.random() * 1e9);
    return spec;
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

    var ramp = T.breakingPoint - T.eventGate;
    if (ramp <= 0) return T.spawnMax;

    var slope = (T.spawnMax - T.spawnBase) / ramp;
    return Math.min(T.spawnMax, T.spawnBase + slope * depth(n));
  }

  function pReroll(n) {
    if (n < T.eventGate) return 0;

    var ramp = T.breakingPoint - T.eventGate;
    if (ramp <= 0) return T.rerollMax;

    /* Squared, so it stays quiet through the early phase where
       events are still coming and going on their own, and only
       becomes the dominant source of change once the set has
       stopped turning over by itself. */
    var t = Math.min(1, depth(n) / ramp);
    return T.rerollBase + (T.rerollMax - T.rerollBase) * t * t;
  }

  function pRemove(n) {
    return T.removeBase * Math.exp(-depth(n) / T.removeDecay);
  }

  function rollTier(n) {
    var rare = 0;
    if (n >= T.rareGate) {
      var rareRamp = Math.max(1,
        (T.intensityFull - T.eventGate) * T.rareRampFactor);
      rare = T.rareWeightMax * clamp01((n - T.rareGate) / rareRamp);
    }
    /* Measured in DEPTH past the event gate, like every other
       curve, and ramping to the same anchor the others use. Reading
       raw `n` here meant the uncommon weight started climbing
       before events even existed, and a separate constant meant it
       silently ignored the gates when they moved. */
    var uncommon = T.uncommonBase +
                   (T.uncommonMax - T.uncommonBase) *
                   clamp01(depth(n) / Math.max(1, T.intensityFull - T.eventGate));

    var r = Math.random();
    if (r < rare) return "rare";
    if (r < rare + uncommon) return "uncommon";
    return "common";
  }

  /* ---------------------------------------------------------------
     ROLLED PROPERTIES
     ---------------------------------------------------------------
     A variant picks from a list; a `props` function rolls numbers.
     It runs once at spawn, returns an object of CSS custom
     properties, and the result is stored on the event record — so
     the values persist across navigation and are stable until
     removal, exactly like a variant.

     This is what stops angles being hardcoded. Without it every
     `uniform` skew is the same 2 degrees in the same direction; with
     it, each spawn gets its own angle, either way round.
     --------------------------------------------------------------- */

  /* 0 at the event gate, 1 at T.intensityFull. Everything that
     scales with depth reads this, so "deeper is louder" is one
     mechanism rather than a rule re-implemented per event. */
  function intensityAt(n) {
    var span = T.intensityFull - T.eventGate;
    if (span <= 0) return 1;
    return clamp01((n - T.eventGate) / span);
  }

  /* A random magnitude between min and max, randomly signed. */
  function signed(min, max, decimals) {
    var mag = min + Math.random() * (max - min);
    var val = Math.random() < 0.5 ? -mag : mag;
    var p = Math.pow(10, decimals === undefined ? 2 : decimals);
    return Math.round(val * p) / p;
  }

  function rollProps(state, id, record) {
    var def = EVENTS[id];
    if (typeof def.props !== "function") return null;

    var k = intensityAt(state.counter);

    return def.props(record, state, {
      signed: signed,
      intensity: k,
      /* soft value at the gate, loud value at full depth */
      lerp: function (soft, loud) { return soft + (loud - soft) * k; }
    });
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

  /* Resolve a variants entry to what is available right now.

     Two shapes are accepted:

       ["a", "b"]                    one axis, published as
                                     data-v-<id>="a"

       { angle: [...], origin: [...] }  several independent axes,
                                     each rolled separately and
                                     published as
                                     data-v-<id>-<axis>="..."

     A function may be given instead of an array on either shape;
     it receives (state) and returns the array. Fonts use that, so
     only downloaded faces are pickable. */
  function variantsOf(state, id) {
    var v = EVENTS[id].variants;
    if (!v) return null;
    if (typeof v === "function") return v(state);
    return v;
  }

  function isMultiAxis(v) {
    return v && !Array.isArray(v) && typeof v !== "function";
  }

  /* Is there at least one pickable value on every axis? */
  function variantsAvailable(state, id) {
    var v = variantsOf(state, id);
    if (!v) return true;

    if (!isMultiAxis(v)) return v.length > 0;

    for (var axis in v) {
      var pool = (typeof v[axis] === "function") ? v[axis](state) : v[axis];
      if (!pool || !pool.length) return false;
    }
    return true;
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

      /* Already active, and not a leveling event that can climb.
         Re-rolling an active event is a separate step of its own
         (§7 step 2 below), so the spawn roll stays purely about
         growth and the two never compete for the same roll. */
      if (active.indexOf(id) !== -1 && !def.level) continue;

      /* Its own gate, which may differ from its tier's. */
      if (n < gateOf(id)) continue;

      /* And its ceiling. Every other gate is a floor; this is the
         first event that stops being available as the counter
         rises, because past the rare threshold it is replaced by a
         louder version of itself. */
      if (typeof def.maxGate === "number" && n >= def.maxGate) continue;

      /* Mutual exclusion — sideways vs vertical, and similar. */
      if (def.excludes && def.excludes.some(function (other) {
        return active.indexOf(other) !== -1;
      })) continue;

      /* A variant event with nothing available cannot spawn. Fonts
         use this: no downloaded face means no font event, rather
         than an event that renders as Times. */
      if (!variantsAvailable(state, id)) continue;

      pool.push(id);
    }

    if (!pool.length) return null;
    return pickWeighted(pool, function (i) { return EVENTS[i].weight || 1; });
  }

  /* Add the event, or advance it if it is already active and levels. */
  function spawnEvent(state, id, tier) {
    var def = EVENTS[id];

    /* A one-shot does its work and is never added to the active
       set, so whatever it changed outlives it. */
    if (def.oneShot) {
      var result = def.apply(state);
      return { id: id, leveled: 0, oneShot: result };
    }

    var existing = findEvent(state, id);

    if (existing && def.level) {
      /* Wear replaces colour rather than covering it. Once the
         paint starts failing the shade is gone for good; the next
         spawn after this one clears starts from nothing.

         Climbing out of level 0 lands on 1, not 2 -- `|| 1` would
         treat a colour-only record as though it were already worn
         and skip the first stage entirely. */
      if (!existing.level) {
        delete existing.variant;
        existing.level = 1;
      } else {
        existing.level += 1;
      }

      /* Re-roll, or the level climbs while the page looks the same:
         the properties were built for the old level and know
         nothing about the patch just added. */
      var grown = rollProps(state, id, existing);
      if (grown) existing.props = grown;

      return { id: id, leveled: existing.level };
    }
    if (existing) return null;

    var record = { id: id, tier: tier, life: null };

    if (tier === "rare") {
      record.life = T.rareLifeMin +
        Math.floor(Math.random() * (T.rareLifeMax - T.rareLifeMin + 1));
    } else if (typeof def.life === "number") {
      /* A declared lifespan, for events outside the tiers. Without
         this, forcing presence from the console would produce a
         record that never expires. */
      record.life = def.life;
    }
    if (def.level) record.level = 1;

    var variants = variantsOf(state, id);

    if (isMultiAxis(variants)) {
      /* Each axis is rolled independently, so skew gets an angle
         AND an anchor point, freshly chosen every time it spawns. */
      record.variants = {};
      for (var axis in variants) {
        var pool = (typeof variants[axis] === "function")
          ? variants[axis](state) : variants[axis];
        record.variants[axis] = pool[Math.floor(Math.random() * pool.length)];
      }

    } else if (variants && variants.length) {
      record.variant = (id === "font-change" || id === "font-weird")
        ? pickFontVariant(fontPoolOf(id), variants)
        : variants[Math.floor(Math.random() * variants.length)];
    }

    var props = rollProps(state, id, record);
    if (props) record.props = props;

    state.events.push(record);
    return { id: id, leveled: 0, variant: record.variant, variants: record.variants };
  }

  /* Can this event's values change without the event itself
     changing? True for anything carrying variants or rolled
     numbers; false for a single fixed state, where landing on it
     again could not do anything. */
  function canReroll(id) {
    var def = EVENTS[id];
    return !!(def && (def.variants || def.props));
  }

  /* Re-roll one active event in place: new variant, new numbers,
     same record.

     Its own step, with its own probability, so it never competes
     with the spawn roll. Without this the deep state has nowhere to
     go -- past the breaking point removal barely fires, the pool
     fills, and every roll lands on something already active and
     does nothing. The counter keeps climbing and the page stops
     responding to it. */
  function rerollEvent(state, id) {
    var existing = findEvent(state, id);
    if (!existing) return null;

    var fresh = variantsOf(state, id);

    if (isMultiAxis(fresh)) {
      existing.variants = {};
      for (var axis in fresh) {
        var pool = (typeof fresh[axis] === "function")
          ? fresh[axis](state) : fresh[axis];
        existing.variants[axis] = pool[Math.floor(Math.random() * pool.length)];
      }
    } else if (fresh && fresh.length) {
      existing.variant = (id === "font-change" || id === "font-weird")
        ? pickFontVariant(fontPoolOf(id), fresh)
        : fresh[Math.floor(Math.random() * fresh.length)];
    }

    var props = rollProps(state, id, existing);
    if (props) existing.props = props;

    /* A rare that re-rolls gets its lifespan back, or it would
       expire partway through a value it only just took. */
    if (existing.tier === "rare") {
      existing.life = T.rareLifeMin +
        Math.floor(Math.random() * (T.rareLifeMax - T.rareLifeMin + 1));
    }

    return existing;
  }

  function rollNavigation(state) {
    var n = state.counter;
    var log = { n: n, spawned: null, tier: null, rerolled: null, converted: null,
                removed: [], expired: [], gated: false };
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

    /* 0.5 · CONVERSION ------------------------------------------- */
    /* form-furniture becomes form-infestation at the rare
       threshold rather than being removed and re-spawned. The
       escalation is continuous: the controls a visitor already has
       do not vanish, they multiply.

       Generic, because nothing about it is specific to these two --
       any event can name a successor and the counter at which it
       takes over. */
    for (i = 0; i < state.events.length; i++) {
      var def = EVENTS[state.events[i].id];
      if (!def || !def.becomes) continue;
      if (n < def.becomesAt) continue;

      var heir = state.events[i].id;
      state.events.splice(i, 1);
      i -= 1;

      if (!findEvent(state, def.becomes)) {
        var born = spawnEvent(state, def.becomes, EVENTS[def.becomes].tier);
        if (born) log.converted = heir + " -> " + def.becomes;
      }
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
              (result.variants
                ? ":" + Object.keys(result.variants).map(function (k) {
                    return result.variants[k];
                  }).join("/")
                : "") +
              (result.leveled ? " (L" + result.leveled + ")" : "");
          }
        }
        /* else: nothing of that tier is eligible — all active, all
           gated, or all excluded. Nothing spawns. */
      }
    }

    /* 1b · PRESENCE? --------------------------------------------- */
    /* Its own roll, and nothing else's. Ungated, so it can arrive
       on the first navigation; independent of the spawn above, so
       it neither takes a spawn from the tiers nor needs one to be
       free. It simply happens or does not.

       Skipped if already armed -- an armed record is waiting for a
       lightbox, and re-arming it would do nothing except reset a
       lifespan that has not started. */

    var armed = false;
    for (i = 0; i < state.events.length; i++) {
      if (state.events[i].id === "presence") armed = true;
    }

    if (!armed && Math.random() < T.presenceChance) {
      state.events.push({
        id: "presence",
        tier: "special",
        life: T.presenceLife,
        fired: false
      });
      log.presence = true;
    }

    /* 2 · RE-ROLL? ----------------------------------------------- */
    /* One active event changes its values. Independent of the spawn
       above, so accumulation is untouched: the set still grows at
       the spawn rate, and this only decides how restless what is
       already there feels. Rising with depth, so a deep page is
       both more accumulated AND more unstable. */

    if (Math.random() < pReroll(n)) {
      var candidates = [];
      for (i = 0; i < state.events.length; i++) {
        if (state.events[i].id !== justSpawned && canReroll(state.events[i].id)) {
          candidates.push(state.events[i].id);
        }
      }
      if (candidates.length) {
        var chosen = candidates[Math.floor(Math.random() * candidates.length)];
        var changed = rerollEvent(state, chosen);
        if (changed) {
          log.rerolled = chosen +
            (changed.variant ? ":" + changed.variant : "") +
            (changed.variants
              ? ":" + Object.keys(changed.variants).map(function (k) {
                  return changed.variants[k];
                }).join("/")
              : "");
        }
      }
    }

    /* 3 · REMOVE? ------------------------------------------------ */
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
          /* A leveled event steps down instead of vanishing, and
             the last step clears it. Nothing carries `level` at
             present; kept because red-letters and the word-creep
             both want it. */
          if (EVENTS[e.id] && EVENTS[e.id].level && (e.level || 0) > 1) {
            e.level -= 1;
            log.removed.push(e.id + "-1");
            survivors.push(e);
          } else {
            log.removed.push(e.id);
          }
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
          if (EVENTS[e.id] && EVENTS[e.id].level && (e.level || 0) > 1) {
            e.level -= 1;
            log.removed.push(e.id + "-1");
            survivors.push(e);
          } else {
            log.removed.push(e.id);
          }
        } else {
          survivors.push(e);
        }
      }
    }
    state.events = survivors;

    /* 4 · LIFESPANS ---------------------------------------------- */
    /* Anything carrying a life counts down. Rares get one when they
       spawn; presence gets one from the registry. Commons have none
       and are governed by the removal roll above instead. */
    state.events = state.events.filter(function (ev) {
      if (typeof ev.life !== "number" || ev.id === justSpawned) return true;

      /* WAITING TO HAPPEN DOES NOT COUNT AS HAVING HAPPENED.

         Most events are on the screen the moment they arrive, so
         navigations since is a fair measure of how long they have
         been seen. presence is not: it needs the visitor to open an
         image, and a record armed while they were clicking through
         text would expire having shown nothing at all.

         So an event declared `waits` holds its full lifespan until
         drift.js marks it fired. After that it ticks down like any
         other, on lightboxes and links alike. */
      var def = EVENTS[ev.id];
      if (def && def.waits && !ev.fired) return true;

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

  var appliedProps = [];

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

    /* Rolled properties from the previous state, cleared the same
       way, so applyDrift stays idempotent on an already-rendered
       page. */
    for (i = 0; i < appliedProps.length; i++) {
      root.style.removeProperty(appliedProps[i]);
    }
    appliedProps = [];

    for (i = 0; i < state.events.length; i++) {
      e = state.events[i];
      if (e.variant) root.setAttribute("data-v-" + e.id, e.variant);
      if (e.variants) {
        for (var axis in e.variants) {
          root.setAttribute("data-v-" + e.id + "-" + axis, e.variants[axis]);
        }
      }
      if (e.level) root.setAttribute("data-l-" + e.id, String(e.level));
      if (e.props) {
        for (var prop in e.props) {
          root.style.setProperty(prop, e.props[prop]);
          appliedProps.push(prop);
        }
      }
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

  /* The lock combination (Appendix A). Four digits, generated once
     per browser and then permanent.

     Per browser rather than fixed, so it cannot be spoiled: someone
     posting "it is 4917" is wrong for everyone else. Per browser
     rather than per session, because the counter persists too — a
     returning visitor deep enough to reach the lock must find the
     code they wrote down still works.

     It deliberately survives a reload. Everything else resets, but
     the code is not progress, it is the answer. Re-rolling it on
     refresh would make the lock look broken to anyone who noted it
     down and then reloaded. */
  if (!state.code) {
    state.code = String(Math.floor(Math.random() * 10000));
    while (state.code.length < 4) state.code = "0" + state.code;
  }

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
    CONTROLS: CONTROLS,
    SUGGESTIONS: SUGGESTIONS,
    buildFurniture: buildFurniture,
    FONTS: FONTS,
    state: state,
    navigationType: type,
    didReset: reset,
    defaults: defaults,
    read: read,
    write: write,
    rollNavigation: rollNavigation,
    signed: signed,
    intensityAt: intensityAt,
    rollProps: rollProps,
    applyDrift: applyDrift,
    pSpawn: pSpawn,
    pReroll: pReroll,
    pRemove: pRemove
  };
})();
