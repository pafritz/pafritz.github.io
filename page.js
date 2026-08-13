/* Show the back-to-top link only when the page is scrollable. */
(function () {
  var link = document.querySelector(".to-top");
  if (!link) return;

  function update() {
    var hasOverflow = document.documentElement.scrollHeight > window.innerHeight + 2;
    link.hidden = !hasOverflow;
  }

  function scrollToTop(event) {
    event.preventDefault();

    var startY = window.pageYOffset || document.documentElement.scrollTop || 0;
    if (startY === 0) {
      return;
    }

    var startTime = null;
    var duration = 500;

    function step(timestamp) {
      if (!startTime) {
        startTime = timestamp;
      }

      var progress = Math.min((timestamp - startTime) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      window.scrollTo(0, startY * (1 - eased));

      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    }

    window.requestAnimationFrame(step);
  }

  document.querySelectorAll('a[href="#top"]').forEach(function (anchor) {
    anchor.addEventListener("click", scrollToTop);
  });

  window.addEventListener("load", update);
  window.addEventListener("resize", update);
  window.addEventListener("scroll", function () {
    update();
  });
})();

(function () {
  var toggle = document.querySelector(".footer-symbol-toggle");
  if (!toggle) return;

  var isSwapped = false;

  function setState(nextState) {
    isSwapped = nextState;
    toggle.classList.toggle("is-swapped", isSwapped);
    toggle.setAttribute("aria-pressed", String(isSwapped));
  }

  toggle.addEventListener("click", function () {
    setState(!isSwapped);
  });

  toggle.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setState(!isSwapped);
    }
  });

  setState(false);
})();

/* Show one thumbnail at a time and shuffle through them. */
(function () {
  var strips = document.querySelectorAll(".project-thumbnails");
  if (!strips.length) return;

  var mobileQuery = window.matchMedia("(max-width: 700px)");
  var intervalMs = 2400;
  var activeIntervals = [];

  function clearAllIntervals() {
    activeIntervals.forEach(function (id) {
      window.clearInterval(id);
    });
    activeIntervals = [];
  }

  function restoreStrip(strip) {
    strip.classList.remove("is-rotating");
    Array.prototype.slice.call(strip.querySelectorAll("img")).forEach(function (img) {
      img.classList.remove("is-active");
    });
  }

  function showOnly(images, index) {
    images.forEach(function (img, i) {
      img.classList.toggle("is-active", i === index);
    });
    syncStripHeights();
  }

  function shuffleIndexes(length) {
    var order = [];
    var i;
    for (i = 0; i < length; i += 1) {
      order.push(i);
    }
    for (i = order.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = order[i];
      order[i] = order[j];
      order[j] = temp;
    }
    return order;
  }

  function getFrameHeightLimit(strip) {
    var raw = getComputedStyle(strip).getPropertyValue("--thumbnail-frame-height");
    var parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return 420;
  }

  function getBaselineImage(strip) {
    return strip.querySelector("img");
  }

  function getReferenceImage(strip) {
    if (strip.classList.contains("is-rotating")) {
      return getBaselineImage(strip);
    }
    return strip.querySelector("img");
  }

  function syncStripHeights() {
    strips.forEach(function (strip) {
      var referenceImage = getReferenceImage(strip);
      if (!referenceImage) {
        strip.style.removeProperty("height");
        return;
      }

      if (strip.classList.contains("is-rotating")) {
        var stripWidth = strip.getBoundingClientRect().width;
        var naturalWidth = referenceImage.naturalWidth;
        var naturalHeight = referenceImage.naturalHeight;
        var frameHeightLimit = getFrameHeightLimit(strip);

        if (stripWidth > 0 && naturalWidth > 0 && naturalHeight > 0) {
          var targetHeight = Math.min(stripWidth * (naturalHeight / naturalWidth), frameHeightLimit);
          strip.style.height = targetHeight + "px";
          return;
        }

        strip.style.removeProperty("height");
        return;
      }

      var referenceRect = referenceImage.getBoundingClientRect();
      if (referenceRect.height > 0) {
        strip.style.height = referenceRect.height + "px";
      }
    });
  }

  function startMobileRotation() {
    clearAllIntervals();

    strips.forEach(function (strip) {
      var images = Array.prototype.slice.call(strip.querySelectorAll("img"));
      if (!images.length) {
        return;
      }

      strip.classList.add("is-rotating");

      if (images.length === 1) {
        showOnly(images, 0);
        return;
      }

      var order = shuffleIndexes(images.length);
      var pointer = 0;
      showOnly(images, order[pointer]);

      var id = window.setInterval(function () {
        pointer += 1;
        if (pointer >= order.length) {
          order = shuffleIndexes(images.length);
          pointer = 0;
        }
        showOnly(images, order[pointer]);
      }, intervalMs);

      activeIntervals.push(id);
    });
  }

  function stopMobileRotation() {
    clearAllIntervals();
    strips.forEach(restoreStrip);
    syncStripHeights();
  }

  function updateMode() {
    if (mobileQuery.matches) {
      startMobileRotation();
    } else {
      stopMobileRotation();
      syncStripHeights();
    }
  }

  function installLoadListeners() {
    strips.forEach(function (strip) {
      var firstImage = strip.querySelector("img");
      if (!firstImage) return;

      if (firstImage.complete) {
        syncStripHeights();
        return;
      }

      firstImage.addEventListener("load", syncStripHeights, { once: true });
    });
  }

  updateMode();
  installLoadListeners();

  window.addEventListener("resize", function () {
    syncStripHeights();
  });

  if (mobileQuery.addEventListener) {
    mobileQuery.addEventListener("change", updateMode);
  } else if (mobileQuery.addListener) {
    mobileQuery.addListener(updateMode);
  }
})();

/* Click a picture to open it centered over a blurred page; click
   anywhere (or press Escape) to close it again. */
(function () {
  var images = document.querySelectorAll("main img");
  if (!images.length) return;

  var overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.hidden = true;

  var lightboxImage = document.createElement("img");
  lightboxImage.alt = "";
  overlay.appendChild(lightboxImage);
  document.body.appendChild(overlay);

  function openLightbox(img) {
    lightboxImage.src = img.currentSrc || img.src;
    lightboxImage.alt = img.alt || "";
    overlay.hidden = false;
    document.documentElement.classList.add("lightbox-open");
  }

  function closeLightbox() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.documentElement.classList.remove("lightbox-open");
    lightboxImage.src = "";
  }

  images.forEach(function (img) {
    img.classList.add("lightbox-trigger");
    img.addEventListener("click", function () {
      openLightbox(img);
    });
  });

  overlay.addEventListener("click", closeLightbox);

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeLightbox();
    }
  });
})();