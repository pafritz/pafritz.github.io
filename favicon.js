/* ===========================
   PAUL FRITZ — FAVICON LOADER
   Random weighted favicon picker
   =========================== */

async function loadRandomFavicon() {
  try {
    const res = await fetch('favicon/config.json');
    const data = await res.json();
    const favicons = data.favicons;
    if (!favicons || favicons.length === 0) return;

    // Weighted random pick
    const totalWeight = favicons.reduce((sum, f) => sum + f.weight, 0);
    let rand = Math.random() * totalWeight;
    let chosen = favicons[0];
    for (const f of favicons) {
      rand -= f.weight;
      if (rand <= 0) {
        chosen = f;
        break;
      }
    }

    const base = `favicon/${chosen.id}`;

    // Replace favicon links
    const setOrCreate = (rel, type, sizes, href) => {
      let el = document.querySelector(`link[rel="${rel}"]`);
      if (!el) {
        el = document.createElement('link');
        el.rel = rel;
        document.head.appendChild(el);
      }
      if (type) el.type = type;
      if (sizes) el.sizes = sizes;
      el.href = href + '?v=' + Math.random(); // cache bust
    };

    setOrCreate('icon', 'image/x-icon', null, `${base}/favicon.ico`);
    setOrCreate('icon', 'image/png', '32x32', `${base}/favicon-32x32.png`);
    setOrCreate('apple-touch-icon', null, '180x180', `${base}/apple-touch-icon.png`);

  } catch (e) {
    // Fail silently — default favicon stays
    console.log('Favicon loader:', e);
  }
}

loadRandomFavicon();
