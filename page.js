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