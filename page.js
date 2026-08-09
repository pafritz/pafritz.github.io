/* Hides the back-to-top link when the page fits on screen.
   The link is present by default, so with JS off it simply stays
   visible — no visitor loses it. */
(function () {
  function update() {
    var link = document.querySelector(".to-top");
    if (!link) return;
    link.hidden = document.documentElement.scrollHeight <= window.innerHeight + 4;
  }
  // load, not DOMContentLoaded: images change the page height.
  window.addEventListener("load", update);
  window.addEventListener("resize", update);
})();