# Site Authoring Index

This is a quick reference for writing content.

## 1) Build

```bash
py build_pages.py
```

Optional tests:

```bash
py -m unittest -v
```

## 2) Where To Edit

- Home text: `home.txt`
- About hub pages source:
  - `about/bio.txt`
  - `about/cvintro.txt`
  - `about/cv.txt`
  - `about/press.txt`

- Project folders are inside:
  - `works/`
  - `exhibitions/`

Inside each project folder:

- `project.txt` (intro)
- `NN-project.txt` (text placed near matching numbered media)
- `credits.txt`
- `video.txt`
- image files

## 3) Filename Caption Rules

For project folders and media filenames:

- `-` = space
- `--` = literal hyphen
- `~` = double en-space
- leading `NN-` = order prefix (used for sorting, removed from caption)

## 4) TXT Formatting (Global)

Works in txt content files:

- Blank line = new paragraph
- Line starting with `#` = comment (ignored)
- Inline tags:
  - `<em>italic</em>`
  - `<strong>bold</strong>`
  - `<u>underline</u>`
  - `<s>strikethrough</s>`
  - `<a href="URL">Label</a>`

Links open in new tab automatically.

In project Text files `_text_` is not parsed as italics (stays literal).

## 5) Fieldset Block

Use this exact structure in txt:

```txt
<fieldset><legend>Title</legend>Line 1
Line 2
Line 3</fieldset>
```

You can use inline tags inside legend/body.

## 6) Press Format

In `about/press.txt`, one line per item:

```txt
Label text | https://example.com/article
```

Left side supports inline tags.

## 7) CV Format

In `about/cv.txt`:

- Category line:
  - `<cat>Section Name</cat>`
  - (legacy also works: `<strong>Section Name</strong>`)
- Any normal non-empty line = bullet item
- Typical item pattern:

```txt
DATE TITLE / DETAILS
```

Auto-italic title is active only in these categories:

- Films
- Selected Group Exhibitions
- Selected Personal Exhibitions

`about/cvintro.txt` is optional and appears before CV list.

## 8) Video File Format

In `video.txt`, one video per line:

```txt
https://vimeo.com/123456789
https://vimeo.com/123456789 | Caption text
https://vimeo.com/123456789 | 02-Caption text | 4:3
```

- Blank/comment lines ignored
- Optional `NN-` in caption controls ordering
