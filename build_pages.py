#!/usr/bin/env python3
"""Builds the site from the folder structure.

  films/<project>/*.jpg   ->  films/<project>/index.html
                          ->  films.html  (listing)

Folder and file naming (see caption.py):
  -    space
  --   literal hyphen
  _x_  italic
  NN-  leading order prefix, stripped
"""
import os
import re
import shutil
import html
import json
import math

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None
    ImageDraw = None

from caption import caption_from_filename, alt_from_caption, strip_prefix

SITE = "https://example.github.io/paul-fritz"   # replace with the real Pages URL
NAME = "Paul Fritz"

IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")
ORDER_PREFIX_RE = re.compile(r"^(\d+)-(?!-)\s*(.*)$")
INLINE_LINK_RE = re.compile(
    r"<a\s+href\s*=\s*(?:\"([^\"]+)\"|'([^']+)'|([^\s>]+))\s*>(.*?)</a>",
    re.IGNORECASE,
)
INLINE_EM_RE = re.compile(r"<em>(.*?)</em>", re.IGNORECASE)
INLINE_STRONG_RE = re.compile(r"<strong>(.*?)</strong>", re.IGNORECASE)
INLINE_UNDERLINE_RE = re.compile(r"<u>(.*?)</u>", re.IGNORECASE)
INLINE_STRIKE_RE = re.compile(r"<s>(.*?)</s>", re.IGNORECASE)
INLINE_SMALL_RE = re.compile(r"<small>(.*?)</small>", re.IGNORECASE)
FIELDSET_BLOCK_RE = re.compile(
    r"^<fieldset>\s*<legend>(.*?)</legend>(.*?)</fieldset>$",
    re.IGNORECASE | re.DOTALL,
)
CV_CATEGORY_RE = re.compile(r"^<cat>(.*?)</cat>$", re.IGNORECASE)
CV_STRONG_CATEGORY_RE = re.compile(r"^<strong>(.*?)</strong>$", re.IGNORECASE)
CV_ITALIC_CATEGORIES = {
    "films",
    "selected group exhibitions",
    "selected personal exhibitions",
}

# A project folder may hold a video.txt. One video per line:
#     https://vimeo.com/123456789
#     https://vimeo.com/123456789 | Paul-Fritz,-_DUMMIES_,-2025
#     https://vimeo.com/123456789 | Paul-Fritz,-_DUMMIES_,-2025 | 4:3
# Blank lines and lines starting with # are ignored. Videos can carry
# an optional NN- prefix at the start of their caption to position
# them among images. When no ratio is supplied, the embed falls back
# to 16:9.
VIDEO_FILE = "video.txt"

# folder on disk -> (listing page, label in the nav)
SECTIONS = [
    ("works",       "films.html",       "Selected Works"),
    ("exhibitions", "exhibitions.html", "Selected Exhibitions"),
]

PRESS_PAGE = "press.html"
ABOUT_DIR = "about"
PRESS_TEXT_FILE = os.path.join(ABOUT_DIR, "press.txt")

ABOUT_PAGE = "about.html"
BIO_PAGE = "bio.html"
CV_PAGE = "cv.html"
PORTFOLIO_PDF = "about/Paul-Fritz-portfolio.pdf"
BIO_TEXT_FILE = os.path.join(ABOUT_DIR, "bio.txt")
CV_TEXT_FILE = os.path.join(ABOUT_DIR, "cv.txt")
CV_INTRO_TEXT_FILE = os.path.join(ABOUT_DIR, "cvintro.txt")

FLAT_PAGES = [
    ("colophon.html", "About this website", "How this website is built."),
]

NAV = [(page, label) for _, page, label in SECTIONS] + [(ABOUT_PAGE, "About")]

LOREM = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do "
         "eiusmod tempor incididunt ut labore et dolore magna aliqua.")
# The homepage reads text from the root-level home.txt file.
# Each project folder can have its own project.txt file for the
# intro text shown under the title. A project folder can also hold
# any number of NN-project.txt files (e.g. 01-project.txt), each
# rendered as its own paragraph block placed before the image or
# video sharing that number.
HOME_TEXT_FILE = "home.txt"
PROJECT_TEXT_FILE = "project.txt"
NUMBERED_PROJECT_TEXT_RE = re.compile(r"^(\d+)-project\.txt$", re.IGNORECASE)
# A project folder can also hold a credits.txt, always rendered last
# on the page, under a fixed "CREDITS:" line.
CREDITS_TEXT_FILE = "credits.txt"
# A project folder can also hold any number of seealso.txt files
# (plain, or NN-seealso.txt to place one at a specific position on
# the page, like project.txt). Each renders as its own fieldset
# titled "See Also" (in italics). A numbered one sits between the
# project.txt block and the video/image sharing its number; the
# plain, unnumbered one has no position of its own so it renders
# just above the credits block.
SEEALSO_TEXT_FILE = "seealso.txt"
NUMBERED_SEEALSO_TEXT_RE = re.compile(r"^(\d+)-seealso\.txt$", re.IGNORECASE)
MINIATURES_DIR = "miniatures"
MINIATURE_SIZE_PX = 50
FIGURE_MAX_WIDTH_PX = 1066
FIGURE_MAX_HEIGHT_PX = 600

# A very low-res webp approximating the whole project page's real
# layout: a virtual desktop-width canvas is built using the same
# margins/gaps/max sizes as style.css (so images sit at their true
# on-page size and ratio, with correct white margins around them),
# then the whole thing is downscaled to a tiny width in one shot.
# Used as a hover background on the project's link in its listing.
PAGE_PREVIEW_FILENAME = "page-preview.webp"
PAGE_PREVIEW_WIDTH_PX = 30
PAGE_PREVIEW_CANVAS_WIDTH_PX = 1400          # representative desktop viewport
PAGE_PREVIEW_PAGE_INLINE_PX = 12             # --page-inline
PAGE_PREVIEW_INDENT_PX = 40                  # --indent, clamped at this width
PAGE_PREVIEW_FIGURE_INLINE_PX = round(0.08 * PAGE_PREVIEW_CANVAS_WIDTH_PX)  # --figure-inline: 8vw
PAGE_PREVIEW_FONT_SIZE_PX = 1.2 * 16         # body font-size: 1.2rem
PAGE_PREVIEW_FIGURE_GAP_PX = round(max(
    2.5 * PAGE_PREVIEW_FONT_SIZE_PX,
    min(0.08 * PAGE_PREVIEW_CANVAS_WIDTH_PX, 4 * PAGE_PREVIEW_FONT_SIZE_PX),
))                                            # figure margin-bottom: clamp(2.5em, 8vw, 4em)
PAGE_PREVIEW_TEXT_MIN_HEIGHT_PX = round(1.3 * PAGE_PREVIEW_FONT_SIZE_PX)  # floor: one text line
PAGE_PREVIEW_CHAR_WIDTH_FACTOR = 0.5   # average glyph width, in em, for a serif body font
PAGE_PREVIEW_LINE_HEIGHT_FACTOR = 1.3  # approximates the UA's `line-height: normal`
PAGE_PREVIEW_PARAGRAPH_GAP_FACTOR = 1.0  # p { margin-bottom: 1em }
PAGE_PREVIEW_MEASURE_PX = round(60 * PAGE_PREVIEW_FONT_SIZE_PX)  # --measure: 60em
PAGE_PREVIEW_BG_COLOR = (255, 255, 255)      # --bg
PAGE_PREVIEW_TEXT_COLOR = (222, 219, 210)
PAGE_PREVIEW_VIDEO_COLOR = (40, 40, 40)
PAGE_PREVIEW_VIDEO_RATIO = 9 / 16

# figcaption, .credits-label and .project-credits all set font-size: 1rem
# (the UA root size, 16px) rather than inheriting body's 1.2rem -- using
# the body size for them overstates their height.
PAGE_PREVIEW_SMALL_FONT_SIZE_PX = 16
PAGE_PREVIEW_CAPTION_GAP_PX = round(0.3 * PAGE_PREVIEW_SMALL_FONT_SIZE_PX)  # figcaption margin-top: 0.3em
# CREDITS: label -- its own bold line-height plus margin-bottom: 1em,
# ahead of the credits paragraphs that follow it in the same block.
PAGE_PREVIEW_CREDITS_LABEL_PX = round(
    PAGE_PREVIEW_SMALL_FONT_SIZE_PX * PAGE_PREVIEW_LINE_HEIGHT_FACTOR
    + PAGE_PREVIEW_SMALL_FONT_SIZE_PX
)
# fieldset/legend carry no rule of their own in style.css, so a seealso
# block renders with the UA default chrome: a border, block padding, and
# a legend line overlapping the top border. Approximated here rather
# than styled, to avoid changing how that box actually looks.
PAGE_PREVIEW_FIELDSET_CHROME_PX = round(
    PAGE_PREVIEW_FONT_SIZE_PX * PAGE_PREVIEW_LINE_HEIGHT_FACTOR  # legend line
    + 0.975 * PAGE_PREVIEW_FONT_SIZE_PX                          # padding-block
    + 4                                                          # border, top+bottom
)

# Every block's own margin-bottom, in on-page px -- not one flat gap.
# Margins don't collapse here (body is a flex column), and every
# margin-top is 0 by convention, so each element's real margin-bottom
# IS the gap to whatever comes next.
PAGE_PREVIEW_THUMB_GAP_PX = round(1.5 * PAGE_PREVIEW_FONT_SIZE_PX)      # .project-thumbnails: 1.5em
PAGE_PREVIEW_TITLE_GAP_PX = round(1 * PAGE_PREVIEW_FONT_SIZE_PX)        # .project-title: 1em
PAGE_PREVIEW_INTRO_GAP_PX = round(2 * PAGE_PREVIEW_FONT_SIZE_PX)        # .project-intro (also seealso): 2em
PAGE_PREVIEW_CREDITS_GAP_PX = round(1 * PAGE_PREVIEW_SMALL_FONT_SIZE_PX)  # .project-credits: 1em, at 1rem

TEMPLATE = """<!DOCTYPE html>
<html lang="en"{home}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="only light">
<title>{title}</title>
<meta name="description" content="{desc}">

<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{site}/{url}">
<meta property="og:image" content="{site}/{preview}">

<script src="{root}drift-boot.js"></script>
<link rel="stylesheet" href="{root}style.css">
<link rel="stylesheet" href="{root}drift.css">
<script src="{root}page.js" defer></script>
<script src="{root}drift.js" defer></script>
<script type="importmap">
{{ "imports": {{
  "three": "./{root}vendor/three.min.js",
  "three/addons": "./{root}vendor/three-addons.min.js",
  "@dimforge/rapier3d-compat": "./{root}vendor/rapier.min.js"
}} }}
</script>
<script type="module" src="{root}drift-3d.js"></script>
{extra_head}</head>
<body>

{heading}

<nav>
<ul>
{nav}
</ul>
</nav>

<hr>

<main>
{body}
</main>

<footer>
<small><a href="{root}colophon.html">About this website</a></small>
<small><button type="button" class="footer-symbol-toggle" aria-label="Toggle copyright symbol" title="Toggle copyright symbol"><span class="footer-symbol" aria-hidden="true">©</span></button> 2026</small>
</footer>

</body>
</html>
"""


def parse_order_prefix(text):
    """Extract an optional leading order prefix: '03-Title' -> (3, 'Title')."""
    m = ORDER_PREFIX_RE.match(text or "")
    if not m:
        return None, text or ""
    return int(m.group(1)), m.group(2)


def read_videos(folder):
    """Vimeo embeds from video.txt, in file order."""
    path = os.path.join(folder, VIDEO_FILE)
    if not os.path.isfile(path):
        return []

    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            url, _, rest = line.partition("|")
            if not rest:
                caption = ""
                ratio = None
            else:
                parts = [part.strip() for part in rest.split("|")]
                caption = parts[0] if parts else ""
                ratio = parts[1] if len(parts) > 1 else None

            order, clean_caption = parse_order_prefix(caption)

            embed = vimeo_embed(url.strip())
            if embed:
                out.append((embed, caption_from_filename(clean_caption), parse_ratio(ratio), order))
            else:
                print("  ! not a Vimeo URL, skipped:", url.strip())
    return out


def parse_ratio(value):
    """Convert a ratio string into a CSS-compatible aspect-ratio value."""
    if not value:
        return None

    value = value.strip()
    if not value:
        return None

    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)", value)
    if m:
        return "{w} / {h}".format(w=m.group(1), h=m.group(2))

    m = re.fullmatch(r"(\d+(?:\.\d+)?)", value)
    if m:
        return "{value} / 1".format(value=m.group(1))

    return None


def vimeo_embed(url):
    """Player URL from any Vimeo link. Returns None if unrecognised.

    Handles the private-video hash, which appears either as a second
    path segment or as an h= parameter.
    """
    m = re.search(r"vimeo\.com/(?:video/)?(\d+)", url)
    if not m:
        return None
    video_id = m.group(1)

    h = re.search(r"(?:[?&]h=|/)([0-9a-fA-F]{6,})", url[m.end():])
    embed = "https://player.vimeo.com/video/" + video_id
    embed += "?h=" + h.group(1) + "&dnt=1" if h else "?dnt=1"
    return embed


def sorted_images(folder):
    """Image files in filename order. The NN- prefix does the sorting."""
    names = [f for f in os.listdir(folder) if f.lower().endswith(IMAGE_EXT)]
    return sorted(names)


def image_order_prefix(filename):
    stem = os.path.splitext(os.path.basename(filename))[0]
    order, _ = parse_order_prefix(stem)
    return order


def is_thumbnail_image(filename):
    stem = os.path.splitext(os.path.basename(filename))[0]
    return stem.startswith("00-")


def miniature_filename(filename):
    """Map an image filename to its miniature filename.

    Numbered images become NN-small.ext (keeps their leading number).
    Unnumbered images become name-small.ext.
    """
    base = os.path.basename(filename)
    stem, ext = os.path.splitext(base)
    m = ORDER_PREFIX_RE.match(stem)
    if m:
        prefix = m.group(1)
        return "{}-small{}".format(prefix, ext.lower())
    return "{}-small{}".format(stem, ext.lower())


def get_resample_filter():
    if hasattr(Image, "Resampling"):
        return Image.Resampling.LANCZOS
    return Image.LANCZOS


def create_miniatures(project_folder, images):
    """Rebuild miniatures/ for one project folder from its image files."""
    miniature_dir = os.path.join(project_folder, MINIATURES_DIR)
    if os.path.isdir(miniature_dir):
        shutil.rmtree(miniature_dir)
    os.makedirs(miniature_dir, exist_ok=True)

    dimensions = {}

    if not images:
        return dimensions

    if Image is None:
        print("  ! Pillow not installed; miniatures skipped for", project_folder)
        return dimensions

    resample = get_resample_filter()

    used_names = set()
    for image_name in images:
        src = os.path.join(project_folder, image_name)
        out_name = miniature_filename(image_name)

        if out_name in used_names:
            stem, ext = os.path.splitext(out_name)
            i = 2
            while True:
                candidate = "{}-{}{}".format(stem, i, ext)
                if candidate not in used_names:
                    out_name = candidate
                    break
                i += 1
        used_names.add(out_name)

        out = os.path.join(miniature_dir, out_name)
        try:
            with Image.open(src) as img:
                if getattr(img, "is_animated", False):
                    img.seek(0)
                dimensions[image_name] = (img.width, img.height)
                frame = img.copy()
                frame.thumbnail((MINIATURE_SIZE_PX, MINIATURE_SIZE_PX), resample)

                ext = os.path.splitext(out_name)[1].lower()
                if ext in (".jpg", ".jpeg") and frame.mode not in ("RGB", "L"):
                    frame = frame.convert("RGB")
                frame.save(out)
        except Exception as exc:
            print("  ! miniature skipped for {}: {}".format(src, exc))

    return dimensions


def estimate_wrapped_row_count(line, chars_per_line):
    """Rough wrapped-row count for one logical line of text."""
    plain = html.unescape(re.sub(r"<[^>]+>", "", line)).strip()
    if not plain:
        return 0
    return max(1, math.ceil(len(plain) / chars_per_line))


def estimate_text_block_height_px(raw_text, width_px, font_size_px=PAGE_PREVIEW_FONT_SIZE_PX, reflow=True):
    """Estimate the on-page pixel height of a text block from its raw source.

    `reflow=True` merges each blank-line-delimited paragraph into one
    run of text that wraps to width_px (how render_paragraphs renders
    project.txt/NN-project.txt). `reflow=False` treats every non-empty
    source line as its own row (how credits.txt/seealso.txt render,
    with an explicit <br> per line and no reflow across lines).
    """
    if not raw_text or not raw_text.strip():
        return 0

    cleaned_lines = [
        line for line in raw_text.splitlines()
        if not line.lstrip().lstrip("\ufeff").startswith("#")
    ]
    cleaned = "\n".join(cleaned_lines).strip()
    if not cleaned:
        return 0

    chars_per_line = max(1, int(width_px / (font_size_px * PAGE_PREVIEW_CHAR_WIDTH_FACTOR)))
    line_height_px = font_size_px * PAGE_PREVIEW_LINE_HEIGHT_FACTOR

    if reflow:
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", cleaned) if p.strip()]
        rows = sum(estimate_wrapped_row_count(" ".join(p.split()), chars_per_line) for p in paragraphs)
        gap = len(paragraphs) * font_size_px * PAGE_PREVIEW_PARAGRAPH_GAP_FACTOR
    else:
        lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
        rows = sum(estimate_wrapped_row_count(line, chars_per_line) for line in lines)
        gap = 0

    return round(rows * line_height_px + gap)


def estimate_caption_height_px(cap_text, width_px):
    """figcaption's own height: margin-top: 0.3em plus its (1rem) text,
    which can still wrap under a narrow or portrait figure."""
    if not cap_text or not cap_text.strip():
        return 0
    chars_per_line = max(1, int(width_px / (PAGE_PREVIEW_SMALL_FONT_SIZE_PX * PAGE_PREVIEW_CHAR_WIDTH_FACTOR)))
    rows = estimate_wrapped_row_count(cap_text, chars_per_line)
    line_height_px = PAGE_PREVIEW_SMALL_FONT_SIZE_PX * PAGE_PREVIEW_LINE_HEIGHT_FACTOR
    return round(rows * line_height_px + PAGE_PREVIEW_CAPTION_GAP_PX)


def create_page_preview(project_folder, blocks):
    """Build a tiny webp approximating the whole page's real layout.

    `blocks` is the page's content in on-page order, each one of:
      ("image", {"file", "cap"})  -> a gallery image, at its true rendered
                          size/ratio, plus the figcaption under it
      ("thumbrow", [filename, ...]) -> the thumbnail strip, laid out in one
                          row like .project-thumbnails (flex, nowrap), each
                          image capped at the same 600px height as a figure
      ("video", {"ratio", "cap"}) -> flat band sized by the video's aspect
                          ratio, plus its figcaption
      ("text", {...})     -> flat band standing in for a title/paragraph/
                          fieldset block; see TEXT_INSETS for its keys

    A full-size page is laid out on a virtual desktop-width canvas using
    style.css's own margins/gaps/max sizes, then downscaled once to
    PAGE_PREVIEW_WIDTH_PX, so images end up at the correct on-page size,
    ratio, and inset relative to each other. Returns the file's
    root-relative URL path, or None if skipped.
    """
    miniature_dir = os.path.join(project_folder, MINIATURES_DIR)
    out_path = os.path.join(miniature_dir, PAGE_PREVIEW_FILENAME)

    if Image is None or not blocks:
        return None

    resample = get_resample_filter()

    canvas_width = PAGE_PREVIEW_CANVAS_WIDTH_PX
    main_width = canvas_width - 2 * PAGE_PREVIEW_PAGE_INLINE_PX
    figure_x = PAGE_PREVIEW_PAGE_INLINE_PX + PAGE_PREVIEW_FIGURE_INLINE_PX
    figure_box_width = min(FIGURE_MAX_WIDTH_PX, main_width - 2 * PAGE_PREVIEW_FIGURE_INLINE_PX)
    indent_x = PAGE_PREVIEW_PAGE_INLINE_PX + PAGE_PREVIEW_INDENT_PX
    thumbrow_width = main_width - 2 * PAGE_PREVIEW_INDENT_PX  # .project-thumbnails: margin indent both sides, no max-width

    # Left inset and measure per text role -- these differ in style.css:
    # .project-title has no horizontal margin (page-inline only), intro/
    # seealso sit at --indent, and credits sit at --figure-inline. Treating
    # them all alike was throwing the title and credits bands sideways.
    TEXT_INSETS = {
        "page": (PAGE_PREVIEW_PAGE_INLINE_PX, min(PAGE_PREVIEW_MEASURE_PX, main_width)),
        "indent": (indent_x, min(PAGE_PREVIEW_MEASURE_PX, main_width - 2 * PAGE_PREVIEW_INDENT_PX)),
        "figure": (figure_x, min(PAGE_PREVIEW_MEASURE_PX, main_width - 2 * PAGE_PREVIEW_FIGURE_INLINE_PX)),
    }
    # Same roles, but the real margin-bottom of the element they stand in
    # for -- .project-title, .project-intro/seealso, .project-credits.
    TEXT_GAPS = {
        "page": PAGE_PREVIEW_TITLE_GAP_PX,
        "indent": PAGE_PREVIEW_INTRO_GAP_PX,
        "figure": PAGE_PREVIEW_CREDITS_GAP_PX,
    }

    # (x, y, w, h, frame-or-None, color-or-None)
    placed = []
    cursor_y = 0

    def place_image(src, box_width, box_height_cap, left_x, gap_after, cap_text=None):
        nonlocal cursor_y
        try:
            with Image.open(src) as img:
                if getattr(img, "is_animated", False):
                    img.seek(0)
                frame = img.convert("RGB")
                w, h = frame.width, frame.height
                if not w or not h:
                    return
                rendered_w = max(1, round(min(box_width, box_height_cap * (w / h))))
                rendered_h = max(1, round(rendered_w * (h / w)))
                frame = frame.resize((rendered_w, rendered_h), resample)
        except Exception as exc:
            print("  ! page preview image skipped for {}: {}".format(src, exc))
            return
        placed.append((left_x, cursor_y, rendered_w, rendered_h, frame, None))
        cursor_y += rendered_h + estimate_caption_height_px(cap_text, rendered_w) + gap_after

    def place_band(width, height, color, left_x, gap_after):
        nonlocal cursor_y
        placed.append((left_x, cursor_y, width, height, None, color))
        cursor_y += height + gap_after

    def place_thumbrow(filenames, gap_after):
        # .project-thumbnails is a single nowrap flex row (flex-shrink: 1,
        # no gap): every thumbnail sits on the same line, capped by height
        # like any other image, then shrunk together if the row overflows.
        nonlocal cursor_y
        frames = []
        for name in filenames:
            try:
                with Image.open(os.path.join(project_folder, name)) as img:
                    if getattr(img, "is_animated", False):
                        img.seek(0)
                    frame = img.convert("RGB")
                    w, h = frame.width, frame.height
                    if not w or not h:
                        continue
                    rendered_h = min(FIGURE_MAX_HEIGHT_PX, h)
                    rendered_w = max(1, round(rendered_h * (w / h)))
                    frames.append(frame.resize((rendered_w, rendered_h), resample))
            except Exception as exc:
                print("  ! page preview thumb skipped for {}: {}".format(name, exc))
        if not frames:
            return
        total_w = sum(f.width for f in frames)
        scale = min(1.0, thumbrow_width / total_w) if total_w else 1.0
        x = indent_x
        row_h = 0
        for frame in frames:
            w = max(1, round(frame.width * scale))
            h = max(1, round(frame.height * scale))
            if scale != 1.0:
                frame = frame.resize((w, h), resample)
            placed.append((x, cursor_y, w, h, frame, None))
            x += w
            row_h = max(row_h, h)
        cursor_y += row_h + gap_after

    for kind, payload in blocks:
        if kind == "image":
            src = os.path.join(project_folder, payload["file"])
            place_image(src, figure_box_width, FIGURE_MAX_HEIGHT_PX, figure_x,
                        PAGE_PREVIEW_FIGURE_GAP_PX, payload.get("cap"))
        elif kind == "thumbrow":
            place_thumbrow(payload, PAGE_PREVIEW_THUMB_GAP_PX)
        elif kind == "video":
            ratio = payload.get("ratio") or PAGE_PREVIEW_VIDEO_RATIO
            w = figure_box_width
            h = max(1, round(w * ratio))
            if h > FIGURE_MAX_HEIGHT_PX:
                h = FIGURE_MAX_HEIGHT_PX
                w = max(1, round(h / ratio))
            place_band(w, h, PAGE_PREVIEW_VIDEO_COLOR, figure_x, PAGE_PREVIEW_FIGURE_GAP_PX)
            cursor_y += estimate_caption_height_px(payload.get("cap"), w)
        else:
            raw_text = ""
            font_size_px = PAGE_PREVIEW_FONT_SIZE_PX
            reflow = True
            inset = "indent"
            extra_px = 0
            if isinstance(payload, dict):
                raw_text = payload.get("raw", "")
                font_size_px = payload.get("font_size", font_size_px)
                reflow = payload.get("reflow", True)
                inset = payload.get("inset", inset)
                extra_px = payload.get("label_extra_px", 0)
                if payload.get("fieldset"):
                    extra_px += PAGE_PREVIEW_FIELDSET_CHROME_PX
            left_x, text_box_width = TEXT_INSETS[inset]
            height = estimate_text_block_height_px(raw_text, text_box_width, font_size_px, reflow)
            height = max(height, PAGE_PREVIEW_TEXT_MIN_HEIGHT_PX) + extra_px
            place_band(text_box_width, height, PAGE_PREVIEW_TEXT_COLOR, left_x, TEXT_GAPS[inset])

    if not placed:
        return None

    canvas_height = max(y + h for _, y, _, h, _, _ in placed)
    composite = Image.new("RGB", (canvas_width, canvas_height), PAGE_PREVIEW_BG_COLOR)
    draw = ImageDraw.Draw(composite)
    for x, y, w, h, frame, color in placed:
        if frame is not None:
            composite.paste(frame, (x, y))
        else:
            draw.rectangle([x, y, x + w, y + h], fill=color)

    preview_height = max(1, round(canvas_height * PAGE_PREVIEW_WIDTH_PX / canvas_width))
    composite = composite.resize((PAGE_PREVIEW_WIDTH_PX, preview_height), resample)

    os.makedirs(miniature_dir, exist_ok=True)
    try:
        composite.save(out_path, "WEBP", quality=40, method=6)
    except Exception as exc:
        print("  ! page preview skipped for {}: {}".format(project_folder, exc))
        return None

    return "/{}/{}/{}".format(project_folder.replace(os.sep, "/"), MINIATURES_DIR, PAGE_PREVIEW_FILENAME)



def video_ratio_to_hw_fraction(ratio_css):
    """Convert a CSS aspect-ratio string ('16 / 9') to a height/width fraction."""
    if not ratio_css:
        return None
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*", ratio_css)
    if not m:
        return None
    w, h = float(m.group(1)), float(m.group(2))
    if w <= 0:
        return None
    return h / w


def render_image_size_attrs(dimensions):
    """Return width/height attributes to reserve layout before image load."""
    if not dimensions:
        return ""
    width, height = dimensions
    if not width or not height:
        return ""
    return ' width="{}" height="{}"'.format(int(width), int(height))


def render_shell_reservation_style(dimensions):
    """Inline CSS vars to reserve shell size before full image load."""
    if not dimensions:
        return ""

    width, height = dimensions
    if not width or not height:
        return ""

    reserved_width = min(
        float(width),
        float(FIGURE_MAX_WIDTH_PX),
        float(FIGURE_MAX_HEIGHT_PX) * (float(width) / float(height)),
    )
    if reserved_width <= 0:
        return ""

    return " --reserved-width: {:.2f}px; --img-ratio: {} / {};".format(
        reserved_width,
        int(width),
        int(height),
    )


def miniature_preload_links(project_folder, images):
    """Preload every miniature at high priority so, on a constrained
    connection, they win the race against the full-size images (which
    are fetchpriority="low") instead of queuing behind them."""
    links = []
    for image_name in images:
        mini_name = miniature_filename(image_name)
        mini_abs = os.path.join(project_folder, MINIATURES_DIR, mini_name)
        if not os.path.isfile(mini_abs):
            continue
        mini_rel = "/{}/{}/{}".format(
            project_folder.replace(os.sep, "/"), MINIATURES_DIR, mini_name
        )
        href = html.escape(mini_rel, quote=True)
        links.append(
            '<link rel="preload" as="image" href="{href}" fetchpriority="high">'
            .format(href=href)
        )
    return "\n".join(links) + ("\n" if links else "")


def render_project_image(project_folder, image_name, alt="", dimensions=None):
    """Render an image with LQIP shell when its miniature exists."""
    mini_name = miniature_filename(image_name)
    # Root-relative on purpose: --lqip-image is read by an external
    # stylesheet rule (.image-shell::before), and a url() inside a CSS
    # custom property resolves against the stylesheet consuming var(),
    # not the document declaring it. A page-relative path would look
    # for the miniature next to style.css instead of the project.
    mini_rel = "/{}/{}/{}".format(project_folder.replace(os.sep, "/"), MINIATURES_DIR, mini_name)
    mini_abs = os.path.join(project_folder, MINIATURES_DIR, mini_name)

    src = html.escape(image_name, quote=True)
    alt = html.escape(alt, quote=True)
    size_attrs = render_image_size_attrs(dimensions)
    # Real src with native lazy loading, not a JS-driven loader: the
    # browser only reserves layout from the width/height attributes
    # while the image is genuinely pending its own fetch. Swapping in
    # any src ourselves (even a placeholder) ends that pending state
    # and collapses the box to the placeholder's real dimensions.
    img_html = (
        '<img class="progressive-image" src="{src}" alt="{alt}"{size_attrs} '
        'loading="lazy" decoding="async" fetchpriority="low">'
    ).format(src=src, alt=alt, size_attrs=size_attrs)

    if not os.path.isfile(mini_abs):
        return '<img src="{src}" alt="{alt}"{size_attrs}>'.format(
            src=src,
            alt=alt,
            size_attrs=size_attrs,
        )

    lqip = html.escape(mini_rel, quote=True)
    reservation_style = render_shell_reservation_style(dimensions)
    return (
        '<span class="image-shell" style="--lqip-image: url(\'{lqip}\');{reservation}">'
        '{img}'
        '</span>'
    ).format(lqip=lqip, reservation=reservation_style, img=img_html)


def read_numbered_project_texts(folder):
    """Paragraph blocks from NN-project.txt files, each tagged with its number."""
    if not os.path.isdir(folder):
        return []

    out = []
    for name in sorted(os.listdir(folder)):
        m = NUMBERED_PROJECT_TEXT_RE.match(name)
        if not m:
            continue
        order = int(m.group(1))
        raw = read_text_file(os.path.join(folder, name), "")
        html = render_paragraphs(raw, class_name="project-intro")
        if html:
            out.append((order, html, raw))
    return out


def read_numbered_seealso_texts(folder):
    """'See Also' fieldsets from NN-seealso.txt files.

    The NN- prefix places each one in the page like other numbered
    media (between the matching project.txt block and video/image).
    """
    if not os.path.isdir(folder):
        return []

    out = []
    for name in sorted(os.listdir(folder)):
        m = NUMBERED_SEEALSO_TEXT_RE.match(name)
        if not m:
            continue
        order = int(m.group(1))
        text = read_text_file(os.path.join(folder, name), "")
        if not text:
            continue
        out.append((order, render_seealso_block(text, class_name="project-intro"), text))
    return out


def read_unnumbered_seealso_text(folder):
    """'See Also' fieldset from a plain seealso.txt (no NN- prefix).

    Rendered just above the credits block, since it has no page
    position of its own to be placed at. Returns (html, raw_text).
    """
    text = read_text_file(os.path.join(folder, SEEALSO_TEXT_FILE), "")
    if not text:
        return "", ""
    return render_seealso_block(text, class_name="project-intro"), text


def render_seealso_block(text, class_name=""):
    """Render a seealso.txt body as a fieldset titled 'See Also' in italics."""
    body = "<br>\n".join(format_inline_text(line.strip()) for line in text.strip().splitlines())
    class_attr = ' class="{}"'.format(class_name) if class_name else ""
    return "<fieldset{attrs}><legend><em>See Also</em></legend>{body}</fieldset>\n".format(
        attrs=class_attr,
        body=body,
    )


def find_projects(section_dir):
    """Subfolders holding at least one image, newest first.

    Reverse alphabetical, so a year-first folder name
    ('2026-Title') puts the most recent project at the top.
    Image order inside a project is NOT reversed.
    """
    if not os.path.isdir(section_dir):
        return []
    out = []
    for entry in sorted(os.listdir(section_dir), reverse=True):
        path = os.path.join(section_dir, entry)
        if os.path.isdir(path) and (sorted_images(path) or read_videos(path)):
            out.append(entry)
    return out


def get_back_to_label(label):
    if label.lower().startswith("selected "):
        return label[len("selected "):]
    return label


def render(url, title, desc, body, root="", home=False, preview="preview.jpg",
           back_to_section=None, extra_head=""):
    items = []
    for href, label in NAV:
        target = root + href
        if href == url:
            items.append("  <li>{}</li>".format(label))
        elif back_to_section and href == back_to_section[0]:
            items.append('  <li><a href="{}">↩ Back to {}</a></li>'.format(
                target, get_back_to_label(back_to_section[1])))
        else:
            items.append('  <li><a href="{}">{}</a></li>'.format(target, label))

    # The name itself links back home on inner pages too (styled
    # plain in CSS — no blue, no underline). Home page keeps it text.
    heading = '<h1 id="top">{}</h1>'.format(NAME)
    if not home:
        heading = ('<h1 id="top"><a class="home-link" href="{root}index.html">{name}</a></h1>'
                    .format(root=root, name=NAME))
        heading += ('\n<p class="back"><a href="{}index.html">'
                    '\u21a9 Back to homepage</a></p>'.format(root))

    return TEMPLATE.format(
        home=' class="home"' if home else "",
        title=title, desc=desc, site=SITE, url=url, preview=preview,
        root=root, heading=heading, nav="\n".join(items), body=body,
        extra_head=extra_head,
    )


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote", path)


def read_text_file(path, fallback):
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            text = f.read().strip()
        if text:
            return text
    return fallback


def render_paragraphs(text, class_name="", line_breaks=False):
    """Blank lines start new paragraphs. With line_breaks, single
    newlines inside a paragraph become <br> instead of being merged.
    Lines starting with # are treated as comments and not rendered."""
    cleaned_lines = []
    for line in text.splitlines():
        probe = line.lstrip().lstrip("\ufeff")
        if probe.startswith("#"):
            continue
        cleaned_lines.append(line)
    cleaned = "\n".join(cleaned_lines)
    paras = [p.strip() for p in re.split(r"\n\s*\n", cleaned.strip()) if p.strip()]
    if not paras:
        return ""
    attrs = ' class="{}"'.format(class_name) if class_name else ""
    chunks = []
    for para in paras:
        fieldset_html = render_fieldset_block(para, class_name=class_name)
        if fieldset_html is not None:
            chunks.append(fieldset_html)
            continue

        if line_breaks:
            lines = [format_inline_text(line.strip()) for line in para.splitlines()]
            content = "".join(
                '<span class="line-break-line">{}</span>'.format(line)
                for line in lines
            )
        else:
            content = format_inline_text(para)
        chunks.append("<p{attrs}>{content}</p>\n".format(attrs=attrs, content=content))
    return "".join(chunks)


def render_fieldset_block(text, class_name=""):
    """Render a full fieldset block written in txt source.

    Expected shape:
      <fieldset><legend>Title</legend>Body text</fieldset>
    """
    m = FIELDSET_BLOCK_RE.match(text.strip())
    if not m:
        return None

    legend = format_inline_text(m.group(1).strip())
    body_raw = m.group(2).strip()
    body = "<br>\n".join(format_inline_text(line.strip()) for line in body_raw.splitlines())

    class_attr = ' class="{}"'.format(class_name) if class_name else ""
    return "<fieldset{attrs}><legend>{legend}</legend>{body}</fieldset>\n".format(
        attrs=class_attr,
        legend=legend,
        body=body,
    )


def render_cv_text(text):
    """Render CV text with category headers and bullet entries.

    Rules:
    - <cat>...</cat> line => bold category heading
    - <strong>...</strong> line => treated as category heading (legacy-friendly)
    - any other non-empty line => bullet item
    - item convention: DATE TITLE / DETAILS
      renders as DATE + en-space + italic TITLE, then plain " / DETAILS"
    """
    lines = []
    for line in text.splitlines():
        probe = line.lstrip().lstrip("\ufeff")
        if probe.startswith("#"):
            continue
        lines.append(line.rstrip())

    parts = []
    list_open = False
    current_category = ""

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        cat_match = CV_CATEGORY_RE.match(line)
        strong_cat_match = CV_STRONG_CATEGORY_RE.match(line)
        if cat_match or strong_cat_match:
            if list_open:
                parts.append("</ul>\n")
                list_open = False
            label_raw = (cat_match.group(1) if cat_match else strong_cat_match.group(1)).strip()
            current_category = normalize_cv_category_label(label_raw)
            label = format_inline_text(label_raw, allow_links=False)
            parts.append('<p class="cv-category"><strong>{}</strong></p>\n'.format(label))
            continue

        if not list_open:
            parts.append('<ul class="cv-list">\n')
            list_open = True
        parts.append('  <li>{}</li>\n'.format(
            format_cv_item(
                line,
                italicize_title=(current_category in CV_ITALIC_CATEGORIES),
            )
        ))

    if list_open:
        parts.append("</ul>\n")

    return "".join(parts)


def normalize_cv_category_label(label):
    plain = re.sub(r"<[^>]+>", "", label or "")
    plain = html.unescape(plain).strip().lower()
    return re.sub(r"\s+", " ", plain)


def format_cv_item(line, italicize_title=True):
    """Format one CV entry as: DATE + en-space + italic TITLE, then plain details after /."""
    left, sep, right = line.partition("/")
    left = left.strip()
    right = right.strip()

    m = re.match(r"^(\S+)\s+(.+)$", left)
    if m:
        date = html.escape(m.group(1), quote=False)
        title = format_inline_text(m.group(2))
        if italicize_title:
            head = "{}&ensp;&ensp;<em>{}</em>".format(date, title)
        else:
            head = "{}&ensp;&ensp;{}".format(date, title)
    else:
        head = format_inline_text(left)

    if sep:
        tail = format_inline_text(right)
        return "{} / {}".format(head, tail)
    return head


def format_inline_text(text, allow_links=True):
    """Render plain text with two inline features:
    - <em>italic</em> text
    - <strong>bold</strong> text
    - <u>underline</u> text
    - <s>strikethrough</s> text
    - <small>small text</small>
    - <a href="url">label</a> links (when allow_links=True)
    """
    if not text:
        return ""

    out = []
    cursor = 0

    while cursor < len(text):
        matches = []
        for kind, pattern in (
            ("link", INLINE_LINK_RE),
            ("em", INLINE_EM_RE),
            ("strong", INLINE_STRONG_RE),
            ("u", INLINE_UNDERLINE_RE),
            ("s", INLINE_STRIKE_RE),
                ("small", INLINE_SMALL_RE),
        ):
            if kind == "link" and not allow_links:
                continue
            m = pattern.search(text, cursor)
            if m:
                matches.append((m.start(), m.end(), kind, m))

        if matches:
            _, _, kind, match = min(matches, key=lambda item: (item[0], item[1]))
        else:
            out.append(html.escape(text[cursor:], quote=False))
            break

        out.append(html.escape(text[cursor:match.start()], quote=False))

        if kind == "link":
            href = match.group(1) or match.group(2) or match.group(3) or ""
            href = href.replace('"', "%22")
            label = format_inline_text(match.group(4), allow_links=allow_links)
            out.append('<a href="{}" target="_blank" rel="noopener noreferrer">{}</a>'.format(href, label))
        elif kind == "em":
            inner = format_inline_text(match.group(1), allow_links=allow_links)
            out.append("<em>{}</em>".format(inner))
        elif kind == "strong":
            inner = format_inline_text(match.group(1), allow_links=allow_links)
            out.append("<strong>{}</strong>".format(inner))
        elif kind == "u":
            inner = format_inline_text(match.group(1), allow_links=allow_links)
            out.append("<u>{}</u>".format(inner))
        elif kind == "small":
            inner = format_inline_text(match.group(1), allow_links=allow_links)
            out.append("<small>{}</small>".format(inner))
        else:
            inner = format_inline_text(match.group(1), allow_links=allow_links)
            out.append("<s>{}</s>".format(inner))

        cursor = match.end()

    return "".join(out)


def read_press_entries(path):
    if not os.path.isfile(path):
        return []

    entries = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "|" not in line:
                continue
            label, url = [part.strip() for part in line.split("|", 1)]
            if label and url:
                entries.append((format_inline_text(label, allow_links=False), url))
    return entries


# --- project pages --------------------------------------------------

def build_project(section_dir, folder):
    """One project page. Images in order, each with its caption."""
    path = os.path.join(section_dir, folder)
    # No strip_prefix here: the folder name is the title, so a
    # leading year stays visible. Images still strip their 01- etc.
    title = caption_from_filename(folder)
    plain = alt_from_caption(title)

    all_images = sorted_images(path)
    image_dimensions = create_miniatures(path, all_images)
    thumbnails = [name for name in all_images if is_thumbnail_image(name)]
    gallery_images = [name for name in all_images if not is_thumbnail_image(name)]
    preload_head = miniature_preload_links(path, all_images)

    media = []

    # Numbered media are merged by number; ties show video before image.
    # Unnumbered videos stay at the top to preserve previous behavior.
    for video_index, (embed, cap, ratio, order) in enumerate(read_videos(path)):
        ratio_attr = ''
        if ratio:
            ratio_attr = ' style="--video-ratio: {ratio};"'.format(ratio=ratio)
        figure = (
            '<figure>\n'
            '<div class="video-embed"{ratio_attr}>\n'
            '<iframe src="{src}" title="{t}" loading="lazy"\n'
            '        allow="fullscreen; picture-in-picture"></iframe>\n'
            '</div>\n'
            '<figcaption>{cap}</figcaption>\n'
            '</figure>'.format(src=embed, t=plain, cap=cap or title, ratio_attr=ratio_attr)
        )
        preview_block = ("video", {"ratio": video_ratio_to_hw_fraction(ratio), "cap": cap or title})
        if order is None:
            media.append((0, 0, video_index, preview_block, figure))
        else:
            media.append((1, order, 0, video_index, preview_block, figure))

    for image_index, image in enumerate(gallery_images):
        cap = caption_from_filename(strip_prefix(image))
        figure = (
            '<figure>\n'
            '{img}\n'
            '<figcaption>{cap}</figcaption>\n'
            '</figure>'.format(
                img=render_project_image(
                    path,
                    image,
                    dimensions=image_dimensions.get(image),
                ),
                cap=cap,
            )
        )
        order = image_order_prefix(image)
        preview_block = ("image", {"file": image, "cap": cap})
        if order is None:
            media.append((2, 0, image_index, preview_block, figure))
        else:
            media.append((1, order, 1, image_index, preview_block, figure))

    # Numbered project.txt blocks (01-project.txt, ...) sort before
    # the video/image sharing their number, hence subpriority -1.
    for text_index, (order, html, raw) in enumerate(read_numbered_project_texts(path)):
        preview_block = ("text", {"raw": raw, "font_size": PAGE_PREVIEW_FONT_SIZE_PX, "reflow": True})
        media.append((1, order, -1, text_index, preview_block, html))

    # Numbered seealso.txt blocks sort between the project.txt block
    # and the video/image sharing their number, hence subpriority -0.5.
    for text_index, (order, html, raw) in enumerate(read_numbered_seealso_texts(path)):
        preview_block = ("text", {"raw": raw, "font_size": PAGE_PREVIEW_FONT_SIZE_PX, "reflow": False, "fieldset": True})
        media.append((1, order, -0.5, text_index, preview_block, html))

    sorted_media = sorted(media)
    figures = [entry[-1] for entry in sorted_media]
    media_preview_blocks = [entry[-2] for entry in sorted_media]

    section_page = None
    section_label = None
    for section, page, label in SECTIONS:
        if section == section_dir:
            section_page = page
            section_label = label
            break

    thumbnail_html = ""
    if thumbnails:
        images_html = []
        for image in thumbnails:
            images_html.append(
                render_project_image(
                    path,
                    image,
                    dimensions=image_dimensions.get(image),
                )
            )
        thumbnail_html = '<div class="project-thumbnails">{}</div>'.format("".join(images_html))

    # A video-only project has no image to use as a link preview.
    preview_image = thumbnails[0] if thumbnails else (gallery_images[0] if gallery_images else "preview.jpg")
    raw_intro_text = read_text_file(os.path.join(path, PROJECT_TEXT_FILE), "")
    intro = render_paragraphs(raw_intro_text, class_name="project-intro")
    credits_text = read_text_file(os.path.join(path, CREDITS_TEXT_FILE), "")
    credits_html = ""
    if credits_text:
        credits_html = (
            '<p class="credits-label">CREDITS:</p>\n'
            + render_paragraphs(credits_text, class_name="project-credits", line_breaks=True)
        )
    unnumbered_seealso_html, raw_unnumbered_seealso_text = read_unnumbered_seealso_text(path)
    body = ((thumbnail_html + "\n\n") if thumbnail_html else "")
    body += ("<h2 class=\"project-title\">{}</h2>\n\n".format(title)
            + intro
            + ("\n\n" if intro else "")
            + "\n\n".join(figures)
            + (("\n\n" + unnumbered_seealso_html) if unnumbered_seealso_html else "")
            + (("\n\n" + credits_html) if credits_html else "")
            + '\n\n<p class="to-top"><a href="#top">Back to top \u2191</a></p>')

    write(os.path.join(path, "index.html"), render(
        url="{}/{}/index.html".format(section_dir, folder),
        title="{} — {}".format(plain, NAME),
        desc="{}. {}.".format(plain, NAME),
        body=body,
        root="../../",
        preview=("{}/{}/{}".format(section_dir, folder, preview_image)
                 if preview_image != "preview.jpg" else "preview.jpg"),
        back_to_section=(section_page, section_label),
        extra_head=preload_head,
    ))

    # Whole-page preview, in the same order build_project writes the real
    # body: thumbnail strip, then title, intro, media, seealso, credits.
    page_preview_blocks = []
    if thumbnails:
        page_preview_blocks.append(("thumbrow", thumbnails))
    page_preview_blocks.append(
        ("text", {"raw": title, "font_size": PAGE_PREVIEW_FONT_SIZE_PX * 1.2, "reflow": True, "inset": "page"})
    )
    if intro:
        page_preview_blocks.append(
            ("text", {"raw": raw_intro_text, "font_size": PAGE_PREVIEW_FONT_SIZE_PX, "reflow": True})
        )
    page_preview_blocks += media_preview_blocks
    if unnumbered_seealso_html:
        page_preview_blocks.append(
            ("text", {"raw": raw_unnumbered_seealso_text, "font_size": PAGE_PREVIEW_FONT_SIZE_PX,
                      "reflow": False, "fieldset": True})
        )
    if credits_html:
        page_preview_blocks.append(
            ("text", {"raw": credits_text, "font_size": PAGE_PREVIEW_SMALL_FONT_SIZE_PX, "reflow": False,
                      "inset": "figure", "label_extra_px": PAGE_PREVIEW_CREDITS_LABEL_PX})
        )
    page_preview_url = create_page_preview(path, page_preview_blocks)

    return title, plain, page_preview_url


# --- listing pages --------------------------------------------------

def build_press_page():
    entries = read_press_entries(os.path.join(os.path.dirname(__file__), PRESS_TEXT_FILE))
    if entries:
        rows = []
        for label, url in entries:
            rows.append('  <li><a href="{url}" target="_blank" rel="noopener noreferrer">{label}</a> <span class="press-url">{url}</span></li>'.format(
                url=url, label=label))
        body = ("<ul>\n" + "\n".join(rows) + "\n</ul>"
                + '\n\n<p class="to-top"><a href="#top">Back to top ↑</a></p>')
    else:
        body = "<p>Nothing here yet.</p>"

    write(PRESS_PAGE, render(
        url=PRESS_PAGE,
        title="{} — {}".format("Press", NAME),
        desc="Press by {}.".format(NAME),
        body=body,
        back_to_section=(ABOUT_PAGE, "About"),
    ))


def build_about_page():
    body = (
        "<ul>\n"
        '  <li><a href="{bio}">Bio</a></li>\n'
        '  <li><a href="{cv}">CV/Resume</a></li>\n'
        '  <li><a href="{pdf}#zoom=page-fit" target="_blank" rel="noopener noreferrer">Portfolio (PDF)</a></li>\n'
        '  <li><a href="{press}">Press</a></li>\n'
        "</ul>"
    ).format(bio=BIO_PAGE, cv=CV_PAGE, pdf=PORTFOLIO_PDF, press=PRESS_PAGE)

    write(ABOUT_PAGE, render(
        url=ABOUT_PAGE,
        title="{} — {}".format("About", NAME),
        desc="About {}.".format(NAME),
        body=body,
    ))


def build_about_text_page(page, label, desc, source_text_file):
    content = read_text_file(os.path.join(os.path.dirname(__file__), source_text_file), LOREM)
    body = render_paragraphs(content)
    if page == BIO_PAGE:
        body = render_paragraphs(content, class_name="home-intro")
    if page == CV_PAGE:
        intro_text = read_text_file(os.path.join(os.path.dirname(__file__), CV_INTRO_TEXT_FILE), "")
        intro_html = render_paragraphs(intro_text)
        cv_html = render_cv_text(content)
        body = intro_html + ("\n" if intro_html and cv_html else "") + cv_html
    write(page, render(
        url=page,
        title="{} — {}".format(label, NAME),
        desc=desc,
        body=body,
        back_to_section=(ABOUT_PAGE, "About"),
    ))


def build_listing(section_dir, page, label):
    projects = find_projects(section_dir)
    rows = []
    for folder in projects:
        title, _, _ = build_project(section_dir, folder)
        rows.append('  <li><a href="{d}/{f}/index.html">{t}</a></li>'.format(
            d=section_dir, f=folder, t=title))

    if rows:
        body = ("<ul>\n" + "\n".join(rows) + "\n</ul>"
                + '\n\n<p class="to-top"><a href="#top">Back to top \u2191</a></p>')
    else:
        body = "<p>Nothing here yet.</p>"

    write(page, render(
        url=page,
        title="{} — {}".format(label, NAME),
        desc="{} by {}.".format(label, NAME),
        body=body,
    ))


def build_sounds_json():
    sounds_dir = os.path.join(os.path.dirname(__file__), "sounds")
    names = sorted(
        f for f in os.listdir(sounds_dir)
        if f.startswith("speaker-") and os.path.isfile(os.path.join(sounds_dir, f))
    )
    with open(os.path.join(sounds_dir, "sounds.json"), "w", encoding="utf-8") as f:
        json.dump(names, f)


# --- run ------------------------------------------------------------

if __name__ == "__main__":
    write("index.html", render(
        url="index.html", title=NAME, desc="Portfolio of {}.".format(NAME),
        body=render_paragraphs(read_text_file(
            os.path.join(os.path.dirname(__file__), HOME_TEXT_FILE), ""
        ), class_name="home-intro"), home=True,
    ))

    for section_dir, page, label in SECTIONS:
        build_listing(section_dir, page, label)

    build_about_page()
    build_about_text_page(BIO_PAGE, "Bio", "Biography of {}.".format(NAME), BIO_TEXT_FILE)
    build_about_text_page(CV_PAGE, "CV/Resume", "CV and resume of {}.".format(NAME), CV_TEXT_FILE)
    build_press_page()

    for page, label, desc in FLAT_PAGES:
        body = "<p>Did-you-know facts from English Wikipedia, CC BY-SA 4.0</p>"
        write(page, render(
            url=page,
            title="{} — {}".format(label, NAME),
            desc=desc,
            body=body,
            back_to_section=(ABOUT_PAGE, "About"),
        ))

    build_sounds_json()