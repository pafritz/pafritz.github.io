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

from caption import caption_from_filename, alt_from_caption, strip_prefix, caption_from_text

SITE = "https://example.github.io/paul-fritz"   # replace with the real Pages URL
NAME = "Paul Fritz"

IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")

# A project folder may hold a video.txt. One video per line:
#     https://vimeo.com/123456789
#     https://vimeo.com/123456789 | Paul Fritz, _DUMMIES_, 2025
#     https://vimeo.com/123456789 | Paul Fritz, _DUMMIES_, 2025 | 4:3
# Blank lines and lines starting with # are ignored. Videos are
# placed above the images on the project page. When no ratio is
# supplied, the embed falls back to 16:9.
VIDEO_FILE = "video.txt"

# folder on disk -> (listing page, label in the nav)
SECTIONS = [
    ("works",       "films.html",       "Selected Works"),
    ("exhibitions", "exhibitions.html", "Selected Exhibitions"),
]

FLAT_PAGES = [
    ("about.html",    "About",              "About Paul Fritz."),
    ("colophon.html", "About this website", "How this website is built."),
]

NAV = [(page, label) for _, page, label in SECTIONS] + [("about.html", "About")]

LOREM = ("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do "
         "eiusmod tempor incididunt ut labore et dolore magna aliqua.")

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
<small>\U0001F12F 2026</small>
</footer>

</body>
</html>
"""


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

            embed = vimeo_embed(url.strip())
            if embed:
                out.append((embed, caption_from_text(caption), parse_ratio(ratio)))
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


def render(url, title, desc, body, root="", home=False, preview="preview.jpg",
           back_to_section=None):
    items = []
    for href, label in NAV:
        target = root + href
        if href == url:
            items.append("  <li>{}</li>".format(label))
        elif back_to_section and href == back_to_section[0]:
            items.append('  <li><a href="{}">\u21a9 Back to {}</a></li>'.format(
                target, back_to_section[1]))
        else:
            items.append('  <li><a href="{}">{}</a></li>'.format(target, label))

    # The h1 is never a link — a blue underlined name reads badly.
    # Inner pages get a separate back link underneath instead.
    heading = '<h1 id="top">{}</h1>'.format(NAME)
    if not home:
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


# --- project pages --------------------------------------------------

def build_project(section_dir, folder):
    """One project page. Images in order, each with its caption."""
    path = os.path.join(section_dir, folder)
    # No strip_prefix here: the folder name is the title, so a
    # leading year stays visible. Images still strip their 01- etc.
    title = caption_from_filename(folder)
    plain = alt_from_caption(title)

    figures = []

    # Videos first, then images.
    for embed, cap, ratio in read_videos(path):
        ratio_attr = ''
        if ratio:
            ratio_attr = ' style="--video-ratio: {ratio};"'.format(ratio=ratio)
        figures.append(
            '<figure>\n'
            '<div class="video-embed"{ratio_attr}>\n'
            '<iframe src="{src}" title="{t}" loading="lazy"\n'
            '        allow="fullscreen; picture-in-picture"></iframe>\n'
            '</div>\n'
            '<figcaption>{cap}</figcaption>\n'
            '</figure>'.format(src=embed, t=plain, cap=cap or title, ratio_attr=ratio_attr)
        )

    for image in sorted_images(path):
        cap = caption_from_filename(strip_prefix(image))
        figures.append(
            '<figure>\n'
            '<img src="{src}" alt="">\n'
            '<figcaption>{cap}</figcaption>\n'
            '</figure>'.format(src=image, cap=cap)
        )

    section_page = None
    section_label = None
    for section, page, label in SECTIONS:
        if section == section_dir:
            section_page = page
            section_label = label
            break

    # A video-only project has no image to use as a link preview.
    images = sorted_images(path)
    first = images[0] if images else "preview.jpg"
    body = ("<h2 class=\"project-title\">{}</h2>\n\n".format(title)
            + "\n\n".join(figures)
            + '\n\n<p class="to-top"><a href="#top">Back to top \u2191</a></p>')

    write(os.path.join(path, "index.html"), render(
        url="{}/{}/index.html".format(section_dir, folder),
        title="{} — {}".format(plain, NAME),
        desc="{}. {}.".format(plain, NAME),
        body=body,
        root="../../",
        preview=("{}/{}/{}".format(section_dir, folder, first)
                 if images else "preview.jpg"),
        back_to_section=(section_page, section_label),
    ))
    return title, plain


# --- listing pages --------------------------------------------------

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
        body="<p>{}</p>".format(LOREM), home=True,
    ))

    for section_dir, page, label in SECTIONS:
        build_listing(section_dir, page, label)

    for page, label, desc in FLAT_PAGES:
        write(page, render(url=page, title="{} — {}".format(label, NAME),
                           desc=desc, body="<p>{}</p>".format(LOREM)))