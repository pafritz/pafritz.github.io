/* ===========================
   PAUL FRITZ — SHARED JS
   =========================== */

// Parse folder name → { name, year, month }
function parseProjectFolder(folder) {
  const parts = folder.split('.');
  const year = parts[0] || '';
  const month = parts[1] || '';
  const namePart = parts.slice(2).join('.').replace(/-/g, ' ');
  // Capitalize first letter
  const name = namePart.charAt(0).toUpperCase() + namePart.slice(1);
  return { folder, name, year, month };
}

// Parse image filename → caption HTML
// "Paul-Fritz-_Talking-wound_-2025" → "Paul Fritz <em>Talking wound</em> 2025"
function parseCaption(filename) {
  // Replace - with spaces, handle _italic_
  let caption = filename.replace(/-/g, ' ');
  caption = caption.replace(/_([^_]+)_/g, '<em>$1</em>');
  return caption;
}

// Sort projects: pinned first, then by date desc
function sortProjects(projectsObj, pinned = []) {
  const keys = Object.keys(projectsObj);
  const pinnedKeys = pinned.filter(k => keys.includes(k));
  const rest = keys
    .filter(k => !pinned.includes(k))
    .sort((a, b) => b.localeCompare(a)); // desc chronological
  return [...pinnedKeys, ...rest];
}

// Load images.json
async function loadData() {
  const res = await fetch('images.json');
  return res.json();
}

// Determine if image ratio is vertical (narrower than 4:3)
// We'll use a placeholder approach since we don't have real images
// In production this checks natural width/height after load
function checkImageRatio(img, item) {
  const ratio = img.naturalWidth / img.naturalHeight;
  if (ratio < 4/3 - 0.05) {
    item.classList.add('is-vertical');
  }
}

// Build carousel for a project
function buildCarousel(images, projectFolder, linkToProject = true, size = 'normal') {
  const carousel = document.createElement('div');
  carousel.className = 'carousel';

  const wrapper = document.createElement('div');
  wrapper.className = 'carousel-track-wrapper';

  const track = document.createElement('div');
  track.className = 'carousel-track';

  let currentIndex = 0;

  images.forEach((imgName, i) => {
    const item = document.createElement('div');
    item.className = 'carousel-item';

    const img = document.createElement('img');
    img.src = `images/${projectFolder}/${imgName}.jpg`;
    img.alt = parseCaption(imgName).replace(/<[^>]+>/g, '');
    img.loading = 'lazy';

    img.onload = () => checkImageRatio(img, item);
    img.onerror = () => {
      // Fallback placeholder
      const ph = document.createElement('div');
      ph.className = 'img-placeholder';
      ph.dataset.name = imgName;
      item.replaceChild(ph, img);
    };

    item.appendChild(img);

    const caption = document.createElement('div');
    caption.className = 'carousel-caption';
    caption.innerHTML = parseCaption(imgName);
    item.appendChild(caption);

    if (linkToProject) {
      item.addEventListener('click', () => {
        window.location.href = `projet.html?p=${encodeURIComponent(projectFolder)}`;
      });
      item.style.cursor = 'pointer';
    }

    track.appendChild(item);
  });

  wrapper.appendChild(track);
  carousel.appendChild(wrapper);

  // Arrow buttons
  const prevBtn = document.createElement('button');
  prevBtn.className = 'carousel-btn prev';
  prevBtn.innerHTML = '←';
  prevBtn.setAttribute('aria-label', 'Previous');

  const nextBtn = document.createElement('button');
  nextBtn.className = 'carousel-btn next';
  nextBtn.innerHTML = '→';
  nextBtn.setAttribute('aria-label', 'Next');

  carousel.appendChild(prevBtn);
  carousel.appendChild(nextBtn);

  // Scroll logic
  function scrollTo(index) {
    const items = track.querySelectorAll('.carousel-item');
    if (index < 0 || index >= items.length) return;

    const targetItem = items[index];
    const currentItem = items[currentIndex];

    // Fade out current
    const currentImg = currentItem.querySelector('img, .img-placeholder');
    const currentCaption = currentItem.querySelector('.carousel-caption');
    if (currentImg) currentImg.style.opacity = '0';
    if (currentCaption) currentCaption.style.opacity = '0';

    // Animate track height
    const targetHeight = targetItem.offsetHeight;
    wrapper.style.transition = `height ${getComputedStyle(document.documentElement).getPropertyValue('--transition-speed')} ease`;
    wrapper.style.height = targetHeight + 'px';

    setTimeout(() => {
      // Move track
      const offset = targetItem.offsetLeft;
      track.style.transform = `translateX(-${offset}px)`;

      currentIndex = index;

      // Fade in new
      const newImg = targetItem.querySelector('img, .img-placeholder');
      const newCaption = targetItem.querySelector('.carousel-caption');
      if (newImg) newImg.style.opacity = '1';
      if (newCaption) newCaption.style.opacity = '1';
    }, 200);

    // Update buttons
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === items.length - 1;
  }

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    scrollTo(currentIndex - 1);
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    scrollTo(currentIndex + 1);
  });

  // Init
  prevBtn.disabled = true;

  return carousel;
}

// Build lightbox
function buildLightbox() {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';

  const bg = document.createElement('div');
  bg.className = 'lightbox-bg';

  const wrap = document.createElement('div');
  wrap.className = 'lightbox-img-wrap';

  const img = document.createElement('img');
  wrap.appendChild(img);
  overlay.appendChild(bg);
  overlay.appendChild(wrap);
  document.body.appendChild(overlay);

  function open(src) {
    img.src = src;
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  overlay.addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });

  return { open, close };
}
