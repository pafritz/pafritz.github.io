#!/usr/bin/env python3
"""Filename -> caption.

  -    space
  --   literal hyphen
  _x_  italic
"""
import html
import os
import re

SENTINEL = "\x00"


def caption_from_filename(filename):
    stem = os.path.splitext(os.path.basename(filename))[0]
    stem = stem.replace("©", "Photo:")
    stem = html.escape(stem, quote=False)          # escape before adding tags
    stem = stem.replace("--", SENTINEL)            # protect literal hyphens
    stem = stem.replace("-", " ")
    stem = stem.replace(SENTINEL, "-")
    stem = stem.replace("~", "&ensp;&ensp;")
    stem = re.sub(r"_([^_]+)_", r"<em>\1</em>", stem)
    return stem


def alt_from_caption(caption):
    """Alt text is the caption without markup."""
    return re.sub(r"<[^>]+>", "", caption)


if __name__ == "__main__":
    tests = [
        "Paul-Fritz,-_DUMMIES_,-(film-still),-2025,-2-channel-video,-loop.jpg",
        "Paul-Fritz,-_DUMMIES_,-(film-still),-2025,-2--channel-video,-loop.jpg",
        "_hello-world_.jpg",
        "_A_-and-_B_-together.jpg",
        "Untitled-(site--specific),-2024.jpg",
        "Odd_underscore-count.jpg",
    ]
    for t in tests:
        c = caption_from_filename(t)
        print(t)
        print("  caption:", c)
        print("  alt:    ", alt_from_caption(c))
        print()


def strip_prefix(name):
    """Remove a leading order prefix: '03-Title' -> 'Title'."""
    return re.sub(r"^\d+-(?!-)", "", name)


def caption_from_text(text):
    """Caption written as plain text, not as a filename.

    Spaces stay spaces; only _x_ becomes italic. Used for video.txt,
    where writing hyphens-for-spaces would be unnatural.
    """
    if not text:
        return ""
    text = html.escape(text, quote=False)
    return re.sub(r"_([^_]+)_", r"<em>\1</em>", text)