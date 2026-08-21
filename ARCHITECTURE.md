# Architecture

## What This Is

Paul Fritz's portfolio is a small, static, file-backed website. There is no
runtime server, database, frontend framework, bundler, or client-side router.
The repository is both the content source and the deployable site. GitHub Pages
serves the committed HTML, CSS, JavaScript, fonts, images, and PDF files as
static assets.

The site intentionally resembles an authored browser-default document: serif
type, ordinary blue links, semantic HTML, visible rules, list navigation, and
minimal decoration. `style.css` makes those defaults explicit and owns the
layout tokens, rather than relying on a user agent stylesheet.

## Stack

- HTML generated as static files.
- Python 3 standard-library build script in `build_pages.py`.
- Pillow is optional and used only to generate image miniatures.
- Plain CSS in `style.css`, with local TeX Gyre Termes fonts in `fonts/`.
- Plain browser JavaScript in `page.js`, loaded with `defer`.
- Vimeo iframes for project videos.
- `unittest` tests in `test_build_pages.py` and `test_caption.py`.
- GitHub Pages deployment, with the `CNAME` file defining the custom domain.

There is currently no `package.json`, dependency lockfile, build tool, or
JavaScript framework. Do not introduce one for ordinary site changes.

## Source Of Truth

Edit content and structure in these sources:

- `home.txt`: home-page copy.
- `about/*.txt`: bio, CV intro, CV, and press data.
- `works/`: selected works, one project directory per work.
- `exhibitions/`: selected exhibitions, one project directory per exhibition.
- `caption.py`: filename-to-caption and filename-to-alt-text rules.
- `build_pages.py`: page template, parsing, ordering, and generated markup.
- `style.css`: baseline visual system and component styling.
- `page.js`: small progressive-enhancement behaviors.

Root HTML pages and project `index.html` files are generated artifacts. They
can be inspected while debugging, but a durable content or template change
belongs in the source files and should be followed by a build.

## Request And Build Flow

There is no application request flow in the server-side sense. A browser asks
GitHub Pages for a static file and receives it directly. The meaningful flow is
the authoring/build flow:

1. An author edits a `.txt` file, project folder, media filename, or generator
   code.
2. `py build_pages.py` reads the source tree.
3. The generator parses text, captions, ordering prefixes, images, and Vimeo
   entries.
4. It writes the home page, section listings, about pages, press page, flat
   pages, and each project's `index.html`.
5. For project images, it rebuilds `miniatures/`, records intrinsic dimensions,
   and emits preload links and layout-reservation attributes.
6. GitHub Pages serves the resulting files. On page load, `page.js` attaches
   optional interactions to elements that exist on that page.

The shared generated shell is the `TEMPLATE` in `build_pages.py`: heading,
navigation, horizontal rule, main content, footer, stylesheet links, and
deferred script. Relative `root` prefixes make the same shell work at the
repository root and inside nested project directories.

## Page Families

- `index.html`: one-viewport home page, using `home.txt`.
- `films.html` and `exhibitions.html`: generated project listings.
- `works/<project>/index.html` and `exhibitions/<project>/index.html`:
  project title, optional intro, ordered text/media, credits, and back links.
- `about.html`: links to bio, CV, portfolio PDF, and press.
- `bio.html`, `cv.html`, and `press.html`: generated about subpages.
- `colophon.html`: a flat generated page.

## Content Grammar And Naming

Filenames are part of the data model. In project and media names:

- `-` becomes a space.
- `--` becomes a literal hyphen.
- `~` becomes two en-spaces.
- `_text_` becomes italic markup in filename captions.
- A leading `NN-` is an ordering prefix and is removed from the displayed
  media caption. Project folder years are not stripped from project titles.
- A media filename beginning with `00-` is a thumbnail and is shown in the
  project's thumbnail strip, not the main gallery.
- `©` in a filename becomes `Photo:` in its caption.

Project folders may contain:

- `project.txt`: intro shown below the title.
- `NN-project.txt`: text block placed before media with the same number.
- `credits.txt`: final credits block, rendered with line breaks.
- `video.txt`: one Vimeo URL per line, optionally followed by caption and
  aspect ratio separated by `|`.
- Image files with extensions in the generator's `IMAGE_EXT` list.

Text files use blank lines for paragraphs, `#`-prefixed lines for comments, and
limited inline tags: `<em>`, `<strong>`, `<u>`, `<s>`, and `<a href="...">`.
Links are escaped and open in a new tab. Fieldsets use the special complete
block form documented in `README.md`. CV files use `<cat>Category</cat>` (with
legacy `<strong>Category</strong>` support) followed by ordinary entry lines.

Project media ordering is the non-obvious rule: numbered text, videos, and
images are merged by number; text comes first, then video, then image. Videos
without a number remain at the top. Unnumbered images follow numbered media.
Listings are reverse alphabetical by folder name, which puts year-first newer
projects first.

## Runtime State And Behavior

The only browser state is ephemeral DOM/class state; nothing is persisted.

- `page.js` shows a back-to-top link only when the document overflows and
  animates the return to `#top`.
- The footer copyright button toggles a horizontally mirrored symbol and
  `aria-pressed`.
- Progressive images begin with a generated miniature background and fade in
  the native lazy-loaded full image when it finishes loading. Intrinsic image
  dimensions reserve layout space before loading.
- Every image in `main` becomes a lightbox trigger. The script creates one
  overlay, opens the clicked image, blurs the page behind it, locks document
  scrolling, and closes on any overlay click or `Escape`.
- Pages with no matching elements simply skip each behavior. This is the
  expected progressive-enhancement pattern.

## CSS And Design Rules

`style.css` is the authored baseline and should remain the primary styling
surface. CSS custom properties in `:root` are the mutation points for colors,
type, spacing, measure, image sizing, and related behavior. The text measure is
limited independently from media, so images can be wider than paragraphs.

The home page is deliberately fixed to `100dvh` and clipped, while inner pages
scroll normally. The footer is flex-pinned in the document column. Images have
stable intrinsic sizing, a maximum gallery width/height, and no layout-shifting
JS loader. Preserve semantic HTML, keyboard focus visibility, alt text, and
the light color scheme when designing new pages or interactions.

All generated pages also link `drift.css`, but that file is not present in the
current workspace. Treat it as an unresolved external or omitted stylesheet:
check its intended source before changing that contract or relying on rules
from it. `style.css` contains notes referring to future mutation behavior in
that file, including a deliberately unused `--skew` token.

## Conventions For Future Agents

- Prefer changing source text, `build_pages.py`, `caption.py`, `style.css`, or
  `page.js`; do not hand-edit generated HTML as the lasting fix.
- Keep the site static and dependency-light unless the requirement genuinely
  changes its deployment model.
- Preserve relative URL generation and test nested project pages.
- Keep filename parsing backward-compatible; filenames are user-facing copy.
- Escape authored text and URLs when extending the generator.
- Use semantic, accessible HTML and progressive enhancement for interactions.
- Run `py build_pages.py` after generator/content changes, then run
  `py -m unittest -v`.
- Inspect the generated diff and verify that `miniatures/` regeneration is
  expected before committing.
