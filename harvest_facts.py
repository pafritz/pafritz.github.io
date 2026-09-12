#!/usr/bin/env python3
"""Harvest "Did you know" hooks from Wikipedia's archives into facts.json.

Every hook that has appeared on Wikipedia's Main Page is archived at
Wikipedia:Recent additions/<year>/<month>. This walks those pages
backwards from a starting month, strips the wikitext, and writes a
JSON file for the did-you-know events to draw from.

Standard library only, like build_pages.py. Run it once and commit
the result; nothing fetches anything at runtime.

    py harvest_facts.py                 # 500 facts, most recent first
    py harvest_facts.py --count 1200
    py harvest_facts.py --from 2019-06  # start walking back from there

The text is CC BY-SA 4.0, so the attribution belongs in colophon.html.
The licence details are written into the output file as well, so the
provenance travels with the data.
"""

import argparse
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

RAW = "https://en.wikipedia.org/w/index.php?title={}&action=raw"

# The archives live at "Did you know archive" now; "Recent additions"
# was moved and is kept as a redirect. Both are tried, newest name
# first, because the move did not reach every month.
PAGES = ["Wikipedia:Did_you_know_archive/{year}/{month}",
         "Wikipedia:Recent_additions/{year}/{month}"]

MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]

# Wikimedia asks for a descriptive User-Agent with a contact address.
# Requests without one are rate-limited or refused outright.
USER_AGENT = ("drift-facts-harvest/1.0 "
              "(https://paulfritz.ch; contact: hello@paulfritz.ch)")

# A hook shorter than this is usually a fragment left by a malformed
# entry; longer than this and it will not fit a small box without
# becoming a paragraph.
MIN_LEN = 45
MAX_LEN = 230


def fetch(page):
    """Raw wikitext for a page, following #REDIRECT if it is one.

    action=raw hands back the redirect's own source rather than the
    page it points at -- six lines of wikitext with no hooks in it,
    which reads exactly like a page full of unusable content. Worth
    following explicitly rather than trusting the title.
    """
    for _ in range(3):
        url = RAW.format(urllib.parse.quote(page, safe=":/"))
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8", "replace")

        target = re.match(r"\s*#\s*REDIRECT\s*\[\[([^\]]+)\]\]", text, re.I)
        if not target:
            return text
        page = target.group(1).strip().replace(" ", "_")

    return text


def fetch_month(year, month_name):
    """Try each known archive title, returning the first that exists."""
    last = None
    for pattern in PAGES:
        page = pattern.format(year=year, month=month_name)
        try:
            return page, fetch(page)
        except urllib.error.HTTPError as err:
            if err.code != 404:
                raise
            last = page
    raise urllib.error.HTTPError(last, 404, "no archive page", None, None)


def clean(text):
    """Wikitext to plain text, or None if the hook is not usable."""

    # Templates and comments first: they can wrap anything else.
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"<ref[^>]*>.*?</ref>", "", text, flags=re.S)
    text = re.sub(r"<ref[^>]*/>", "", text)

    # A hook carrying a template is usually an image credit or a
    # formatting helper. Not worth reconstructing.
    if "{{" in text:
        return None

    # [[target|shown]] keeps what was shown; [[target]] keeps target.
    text = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)

    # External links: [url label] keeps the label.
    text = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", text)
    text = re.sub(r"\[https?://\S+\]", "", text)

    text = text.replace("'''", "").replace("''", "")
    text = re.sub(r"</?(small|b|i|span|sub|sup|nowiki)[^>]*>", "", text)

    # Image cues make no sense without the image.
    text = re.sub(r"\s*\((?:[^()]*\b)?pictured(?:[^()]*)?\)", "", text)
    text = re.sub(r"\s*\((?:[^()]*\b)?illustrated(?:[^()]*)?\)", "", text)
    text = re.sub(r"\s*\(video\)", "", text)

    text = text.replace("&nbsp;", " ").replace("&ndash;", "\u2013")
    text = text.replace("&mdash;", "\u2014").replace("&amp;", "&")
    text = re.sub(r"\s+", " ", text).strip()

    # Normalise the opening to a single form. The archives use "...",
    # "…", and occasionally neither.
    text = re.sub(r"^(?:\.\.\.|\u2026)\s*", "", text)
    if not text.lower().startswith("that "):
        return None
    text = "... " + text

    if not text.endswith("?"):
        return None
    if len(text) < MIN_LEN or len(text) > MAX_LEN:
        return None

    # Anything still carrying markup did not survive the pass above.
    if re.search(r"[\[\]{}|]|</?[a-z]", text):
        return None

    return text


def hooks_from(wikitext):
    out = []
    for line in wikitext.splitlines():
        line = line.strip()
        if not line.startswith("*"):
            continue
        line = line.lstrip("*").strip()
        if not re.match(r"^(?:\.\.\.|\u2026)?\s*that\b", line, re.I):
            continue
        fact = clean(line)
        if fact:
            out.append(fact)
    return out


def months_back(start, how_many):
    year, month = start
    for _ in range(how_many):
        yield year, month
        month -= 1
        if month == 0:
            year, month = year - 1, 12


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=500,
                        help="how many facts to keep (default 500)")
    parser.add_argument("--out", default="facts.json")
    parser.add_argument("--from", dest="start", default=None,
                        metavar="YYYY-MM",
                        help="month to start walking back from")
    parser.add_argument("--max-months", type=int, default=36)
    parser.add_argument("--seed", type=int, default=None,
                        help="shuffle seed; omit to keep archive order")
    parser.add_argument("--user-agent", default=USER_AGENT)
    args = parser.parse_args()

    if args.start:
        year, month = (int(p) for p in args.start.split("-"))
    else:
        # Last full month: the current one is still being written.
        today = date.today()
        year, month = (today.year, today.month - 1) if today.month > 1 \
            else (today.year - 1, 12)

    globals()["USER_AGENT"] = args.user_agent

    seen = set()
    facts = []
    pages = 0

    for y, m in months_back((year, month), args.max_months):
        if len(facts) >= args.count:
            break

        try:
            page, text = fetch_month(y, MONTHS[m - 1])
        except urllib.error.HTTPError as err:
            print("  %s %d -> HTTP %s" % (MONTHS[m - 1], y, err.code),
                  file=sys.stderr)
            continue
        except Exception as err:                       # noqa: BLE001
            print("  %s %d -> %s" % (MONTHS[m - 1], y, err), file=sys.stderr)
            continue

        pages += 1
        fresh = 0
        for fact in hooks_from(text):
            key = fact.lower()
            if key in seen:
                continue
            seen.add(key)
            facts.append(fact)
            fresh += 1

        print("%s  +%d  (%d total)" % (page.split("/", 1)[1], fresh, len(facts)))
        time.sleep(0.5)                                # be a polite client

    if args.seed is not None:
        random.Random(args.seed).shuffle(facts)

    facts = facts[:args.count]

    payload = {
        "source": "English Wikipedia, Did You Know archives "
                  "(Wikipedia:Recent additions)",
        "licence": "CC BY-SA 4.0",
        "licence_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "harvested": date.today().isoformat(),
        "pages_read": pages,
        "count": len(facts),
        "facts": facts,
    }

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")

    print("\n%d facts from %d archive pages -> %s"
          % (len(facts), pages, args.out))
    if len(facts) < args.count:
        print("Short of %d. Raise --max-months." % args.count, file=sys.stderr)


if __name__ == "__main__":
    main()
