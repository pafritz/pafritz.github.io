/* ===========================
   PAUL FRITZ — SHARED JS
   =========================== */

// Parse folder name → { name, year, month }
function parseProjectFolder(folder) {
  const parts = folder.split('.');
  const year = parts[0] || '';
  const month = parts[1] || '';
  const namePart = parts.slice(2).join('.').replace(/-/g, ' ');
  const name = namePart.charAt(0).toUpperCase() + namePart.slice(1);
  return { folder, name, year, month };
}

// Strip leading number prefix from filename: "01-Paul-Fritz-..." → "Paul-Fritz-..."
function stripNumberPrefix(filename) {
  return filename.replace(/^\d+-/, '');
}

// Parse image filename → caption HTML (strips number prefix)
// "01-Paul-Fritz-_Talking-wound_-2025" → "Paul Fritz <em>Talking wound</em> 2025"
function parseCaption(filename) {
  let name = stripNumberPrefix(filename);
  let caption = name.replace(/-/g, ' ');
  caption = caption.replace(/_([^_]+)_/g, '<em>$1</em>');
  return caption;
}

// Sort projects: pinned first, then by date desc
function sortProjects(projectsObj, pinned = []) {
  const keys = Object.keys(projectsObj);
  const pinnedKeys = pinned.filter(k => keys.includes(k));
  const rest = keys
    .filter(k => !pinned.includes(k))
    .sort((a, b) => b.localeCompare(a));
  return [...pinnedKeys, ...rest];
}

// Load images.json
async function loadData() {
  const res = await fetch('images.json');
  return res.json();
}

// Golden ratio constant
const PHI = 1.618;

// Build carousel for a project
// carouselHeight: CSS value string e.g. '50vh' or '30vh'
function buildCarousel(images, projectFolder, linkToProject = true, carouselHeight = '50vh') {
  const carousel = document.createElement('div');
  carousel.className = 'carousel';
  carousel.style.setProperty('--carousel-height', carouselHeight);

  const wrapper = document.createElement('div');
  wrapper.className = 'carousel-track-wrapper';
  // Fix wrapper height immediately to prevent layout jump
  wrapper.style.height = carouselHeight;
  wrapper.style.overflow = 'hidden';

  const track = document.createElement('div');
  track.className = 'carousel-track';

  let currentIndex = 0;
  let initialized = false;

  // Arrow buttons (created early so we can reference them)
  const prevBtn = document.createElement('button');
  prevBtn.className = 'carousel-btn prev';
  prevBtn.innerHTML = '←';
  prevBtn.setAttribute('aria-label', 'Previous');

  const nextBtn = document.createElement('button');
  nextBtn.className = 'carousel-btn next';
  nextBtn.innerHTML = '→';
  nextBtn.setAttribute('aria-label', 'Next');

  const items = [];

  images.forEach((imgName, i) => {
    const item = document.createElement('div');
    item.className = 'carousel-item';
    // All items hidden except first
    item.style.display = i === 0 ? 'block' : 'none';

    const img = document.createElement('img');
    img.src = `images/${projectFolder}/${imgName}.jpg`;
    img.alt = parseCaption(imgName).replace(/<[^>]+>/g, '');
    img.loading = i === 0 ? 'eager' : 'lazy';

    img.style.display = 'block';
    img.style.transition = 'opacity 0.3s ease';

    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight;
      if (ratio < 4/3 - 0.05) {
        // Vertical: fix width instead, height = carouselHeight still
        // Width = carouselHeight * (naturalWidth/naturalHeight)
        // We keep height fixed so no jump in carousel
        item.dataset.isVertical = 'true';
      }
      // Update arrow positions once first image loads
      if (i === 0) {
        updateArrows();
      }
    };

    img.onerror = () => {
      const ph = document.createElement('div');
      ph.className = 'img-placeholder';
      ph.dataset.name = imgName;
      ph.style.height = carouselHeight;
      ph.style.width = `calc(${carouselHeight} * 4 / 3)`;
      item.replaceChild(ph, img);
      if (i === 0) updateArrows();
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
    items.push(item);
  });

  if (items.length <= 1) {
    nextBtn.disabled = true;
    prevBtn.disabled = true;
  }

  // Update arrow horizontal position based on current image width
  function updateArrows() {
    const current = items[currentIndex];
    if (!current) return;
    const img = current.querySelector('img');
    if (!img || !img.naturalWidth) return;

    // Don't reposition next arrow if it's disabled (last image)
    if (currentIndex === items.length - 1) return;

    const imgWidth = img.offsetWidth;
    const carouselRect = carousel.getBoundingClientRect();
    const maxRight = window.innerWidth - carouselRect.left - 36;

    const nextLeft = Math.min(imgWidth, maxRight);
    nextBtn.style.left = `${nextLeft}px`;
    nextBtn.style.right = 'auto';
    nextBtn.style.transform = 'translateX(-50%) translateY(-50%)';
  }

  function goTo(index) {
    // Infinite loop — wrap around
    if (index < 0) index = items.length - 1;
    if (index >= items.length) index = 0;
    if (index === currentIndex) return;

    // Hide current
    const currentItem = items[currentIndex];
    const currentImg = currentItem.querySelector('img');
    const currentCaption = currentItem.querySelector('.carousel-caption');

    if (currentImg) currentImg.style.opacity = '0';
    if (currentCaption) currentCaption.style.opacity = '0';

    setTimeout(() => {
      currentItem.style.display = 'none';

      // Show new
      const newItem = items[index];
      newItem.style.display = 'block';
      const newImg = newItem.querySelector('img');
      const newCaption = newItem.querySelector('.carousel-caption');

      if (newImg) {
        newImg.style.opacity = '0';
        requestAnimationFrame(() => {
          newImg.style.opacity = '1';
        });
      }
      if (newCaption) {
        newCaption.style.opacity = '0';
        setTimeout(() => { newCaption.style.opacity = '1'; }, 100);
      }

      currentIndex = index;

      // Update arrow position for new image
      if (newImg && newImg.complete && newImg.naturalWidth) {
        updateArrows();
      } else if (newImg) {
        newImg.onload = () => updateArrows();
      }
    }, 200);
  }

  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    goTo(currentIndex - 1);
  });

  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    goTo(currentIndex + 1);
  });

  wrapper.appendChild(track);
  carousel.appendChild(wrapper);
  carousel.appendChild(prevBtn);
  carousel.appendChild(nextBtn);

  // Update arrow on resize
  window.addEventListener('resize', () => updateArrows());

  return carousel;
}
