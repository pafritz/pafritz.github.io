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

try:
    from PIL import Image
except ImportError:
    Image = None

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
MINIATURES_DIR = "miniatures"
MINIATURE_SIZE_PX = 50
FIGURE_MAX_WIDTH_PX = 1066
FIGURE_MAX_HEIGHT_PX = 600

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

<link rel="stylesheet" href="{root}style.css">
<link rel="stylesheet" href="{root}drift.css">
<script src="{root}page.js" defer></script>
</head>
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

    if hasattr(Image, "Resampling"):
        resample = Image.Resampling.LANCZOS
    else:
        resample = Image.LANCZOS

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


def render_project_image(project_folder, image_name, alt="", mini_url_prefix="", dimensions=None):
    """Render an image with LQIP shell when its miniature exists."""
    mini_name = miniature_filename(image_name)
    if mini_url_prefix:
        mini_rel = "{}/{}/{}".format(mini_url_prefix.strip("/"), MINIATURES_DIR, mini_name)
    else:
        mini_rel = "{}/{}".format(MINIATURES_DIR, mini_name)
    mini_abs = os.path.join(project_folder, MINIATURES_DIR, mini_name)

    src = html.escape(image_name, quote=True)
    alt = html.escape(alt, quote=True)
    size_attrs = render_image_size_attrs(dimensions)
    img_html = (
        '<img class="progressive-image" src="{src}" alt="{alt}"{size_attrs} '
        'loading="lazy" decoding="async">'
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
        html = render_paragraphs(
            read_text_file(os.path.join(folder, name), ""), class_name="project-intro"
        )
        if html:
            out.append((order, html))
    return out


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
           back_to_section=None):
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
        if order is None:
            media.append((0, 0, video_index, figure))
        else:
            media.append((1, order, 0, video_index, figure))

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
                    mini_url_prefix="{}/{}".format(section_dir, folder),
                    dimensions=image_dimensions.get(image),
                ),
                cap=cap,
            )
        )
        order = image_order_prefix(image)
        if order is None:
            media.append((2, 0, image_index, figure))
        else:
            media.append((1, order, 1, image_index, figure))

    # Numbered project.txt blocks (01-project.txt, ...) sort before
    # the video/image sharing their number, hence subpriority -1.
    for text_index, (order, html) in enumerate(read_numbered_project_texts(path)):
        media.append((1, order, -1, text_index, html))

    figures = [entry[-1] for entry in sorted(media)]

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
                    mini_url_prefix="{}/{}".format(section_dir, folder),
                    dimensions=image_dimensions.get(image),
                )
            )
        thumbnail_html = '<div class="project-thumbnails">{}</div>'.format("".join(images_html))

    # A video-only project has no image to use as a link preview.
    preview_image = thumbnails[0] if thumbnails else (gallery_images[0] if gallery_images else "preview.jpg")
    intro = render_paragraphs(read_text_file(
        os.path.join(path, PROJECT_TEXT_FILE), ""
    ), class_name="project-intro")
    credits_text = read_text_file(os.path.join(path, CREDITS_TEXT_FILE), "")
    credits_html = ""
    if credits_text:
        credits_html = (
            '<p class="credits-label">CREDITS:</p>\n'
            + render_paragraphs(credits_text, class_name="project-credits", line_breaks=True)
        )
    body = ((thumbnail_html + "\n\n") if thumbnail_html else "")
    body += ("<h2 class=\"project-title\">{}</h2>\n\n".format(title)
            + intro
            + ("\n\n" if intro else "")
            + "\n\n".join(figures)
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
    ))
    return title, plain


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
        title, _ = build_project(section_dir, folder)
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
        write(page, render(
            url=page,
            title="{} — {}".format(label, NAME),
            desc=desc,
            body="<p>{}</p>".format(LOREM),
            back_to_section=(ABOUT_PAGE, "About"),
        ))