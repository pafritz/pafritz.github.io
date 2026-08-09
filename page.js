/* Show the back-to-top link only when the page is scrollable. */
(function () {
  var link = document.querySelector(".to-top");
  if (!link) return;

  function update() {
    var hasOverflow = document.documentElement.scrollHeight > window.innerHeight + 2;
    link.hidden = !hasOverflow;
  }

  window.addEventListener("load", update);
  window.addEventListener("resize", update);
  window.addEventListener("scroll", function () {
    update();
  });
})();