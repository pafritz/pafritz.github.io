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

    // Replace/create all favicon links
    const setOrCreate = (rel, type, sizes, href) => {
      let selector = `link[rel="${rel}"]`;
      if (sizes) selector += `[sizes="${sizes}"]`;
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement('link');
        el.rel = rel;
        document.head.appendChild(el);
      }
      if (type) el.type = type;
      if (sizes) el.sizes = sizes;
      el.href = href + '?v=' + Math.random();
    };

    const setManifest = (href) => {
      let el = document.querySelector('link[rel="manifest"]');
      if (!el) {
        el = document.createElement('link');
        el.rel = 'manifest';
        document.head.appendChild(el);
      }
      el.href = href + '?v=' + Math.random();
    };

    setOrCreate('icon', 'image/x-icon', null, `${base}/favicon.ico`);
    setOrCreate('icon', 'image/png', '16x16', `${base}/favicon-16x16.png`);
    setOrCreate('icon', 'image/png', '32x32', `${base}/favicon-32x32.png`);
    setOrCreate('apple-touch-icon', null, '180x180', `${base}/apple-touch-icon.png`);
    setOrCreate('icon', 'image/png', '192x192', `${base}/android-chrome-192x192.png`);
    setOrCreate('icon', 'image/png', '512x512', `${base}/android-chrome-512x512.png`);
    setManifest(`${base}/site.webmanifest`);

  } catch (e) {
    // Fail silently — default favicon stays
    console.log('Favicon loader:', e);
  }
}

loadRandomFavicon();
