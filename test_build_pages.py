import unittest
import os
import tempfile
from unittest import mock

import build_pages


class BuildPagesTests(unittest.TestCase):
    def test_render_cv_text_uses_cat_as_bold_category_and_bullets(self):
        html = build_pages.render_cv_text(
            "<cat>Selected Personal Exhibitions</cat>\n"
            "2025 Priscilla Predator / FOR / Basel (CH)\n"
        )
        self.assertIn('<p class="cv-category"><strong>Selected Personal Exhibitions</strong></p>', html)
        self.assertIn('<ul class="cv-list">', html)
        self.assertIn('<li>2025&ensp;&ensp;<em>Priscilla Predator</em> / FOR / Basel (CH)</li>', html)

    def test_render_cv_text_supports_legacy_strong_category_lines(self):
        html = build_pages.render_cv_text(
            "<strong>Films</strong>\n"
            "2024 The Crust / UFM\n"
        )
        self.assertIn('<p class="cv-category"><strong>Films</strong></p>', html)
        self.assertIn('<li>2024&ensp;&ensp;<em>The Crust</em> / UFM</li>', html)

    def test_render_cv_item_without_slash_keeps_title_italic(self):
        html = build_pages.format_cv_item("2024 Dummies")
        self.assertEqual(html, "2024&ensp;&ensp;<em>Dummies</em>")

    def test_render_cv_text_italic_rule_applies_only_to_whitelisted_categories(self):
        html = build_pages.render_cv_text(
            "<cat>Awards & Grants</cat>\n"
            "2025 Tremplin Prize Fondation Leenards\n"
            "<cat>Studies</cat>\n"
            "2023-2025 Master in Arts Visuels a l'ECAL / Lausanne\n"
            "<cat>Selected Group Exhibitions</cat>\n"
            "2026 Another Puppet Show / Pantin (FR)\n"
            "<cat>Selected Personal Exhibitions</cat>\n"
            "2025 Priscilla Predator / Basel (CH)\n"
            "<cat>Films</cat>\n"
            "2024 The Crust That Came Back to Life / UFM\n"
        )
        self.assertIn("<li>2025&ensp;&ensp;Tremplin Prize Fondation Leenards</li>", html)
        self.assertIn("<li>2023-2025&ensp;&ensp;Master in Arts Visuels a l'ECAL / Lausanne</li>", html)
        self.assertIn("<li>2026&ensp;&ensp;<em>Another Puppet Show</em> / Pantin (FR)</li>", html)
        self.assertIn("<li>2025&ensp;&ensp;<em>Priscilla Predator</em> / Basel (CH)</li>", html)
        self.assertIn("<li>2024&ensp;&ensp;<em>The Crust That Came Back to Life</em> / UFM</li>", html)

    def test_read_press_entries_supports_inline_formatting(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "press.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write('<em>FOR</em> <strong>Magazine</strong> | https://example.com/article\n')

            entries = build_pages.read_press_entries(path)

            self.assertEqual(len(entries), 1)
            label, url = entries[0]
            self.assertEqual(url, "https://example.com/article")
            self.assertEqual(label, "<em>FOR</em> <strong>Magazine</strong>")

    def test_read_press_entries_ignores_nested_links_in_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "press.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write('<a href="https://inner.example">inner</a> label | https://example.com/article\n')

            entries = build_pages.read_press_entries(path)

            self.assertEqual(len(entries), 1)
            label, _ = entries[0]
            self.assertNotIn("<a href=", label)
            self.assertIn('&lt;a href="https://inner.example"&gt;inner&lt;/a&gt; label', label)

    def test_build_about_text_page_supports_inline_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            about_dir = os.path.join(tmp, "about")
            os.makedirs(about_dir)
            text_file = os.path.join(about_dir, "bio-test.txt")
            with open(text_file, "w", encoding="utf-8") as f:
                f.write('Open <a href="about/Paul-Fritz-portfolio.pdf#zoom=page-fit">Portfolio</a>.')

            captured = {}
            with mock.patch.object(build_pages, "__file__", os.path.join(tmp, "build_pages.py")):
                with mock.patch.object(build_pages, "write") as write_mock:
                    def _capture(path, text):
                        captured["path"] = path
                        captured["text"] = text

                    write_mock.side_effect = _capture
                    build_pages.build_about_text_page(
                        build_pages.BIO_PAGE,
                        "Bio",
                        "Biography test.",
                        os.path.join("about", "bio-test.txt"),
                    )

            self.assertEqual(captured["path"], build_pages.BIO_PAGE)
            self.assertIn(
                '<a href="about/Paul-Fritz-portfolio.pdf#zoom=page-fit" target="_blank" rel="noopener noreferrer">Portfolio</a>',
                captured["text"],
            )

    def test_build_cv_page_renders_cvintro_before_cv_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            about_dir = os.path.join(tmp, "about")
            os.makedirs(about_dir)

            with open(os.path.join(about_dir, "cvintro.txt"), "w", encoding="utf-8") as f:
                f.write("Intro paragraph for CV.")

            with open(os.path.join(about_dir, "cv-test.txt"), "w", encoding="utf-8") as f:
                f.write("<cat>Films</cat>\n2024 The Crust / UFM")

            captured = {}
            with mock.patch.object(build_pages, "__file__", os.path.join(tmp, "build_pages.py")):
                with mock.patch.object(build_pages, "write") as write_mock:
                    def _capture(path, text):
                        captured["path"] = path
                        captured["text"] = text

                    write_mock.side_effect = _capture
                    build_pages.build_about_text_page(
                        build_pages.CV_PAGE,
                        "CV/Resume",
                        "CV test.",
                        os.path.join("about", "cv-test.txt"),
                    )

            self.assertEqual(captured["path"], build_pages.CV_PAGE)
            self.assertIn('<p>Intro paragraph for CV.</p>', captured["text"])
            self.assertIn('<ul class="cv-list">', captured["text"])
            self.assertLess(
                captured["text"].find('<p>Intro paragraph for CV.</p>'),
                captured["text"].find('<ul class="cv-list">'),
            )

    def test_render_paragraphs_supports_inline_links(self):
        html = build_pages.render_paragraphs(
            'See <a href="about/Paul-Fritz-portfolio.pdf#zoom=page-fit">Portfolio</a>.'
        )
        self.assertIn(
            '<a href="about/Paul-Fritz-portfolio.pdf#zoom=page-fit" target="_blank" rel="noopener noreferrer">Portfolio</a>',
            html,
        )

    def test_render_paragraphs_supports_italics_inside_link_labels(self):
        html = build_pages.render_paragraphs(
            'Read <a href="https://example.com/path"><em>FOR</em> article</a>.'
        )
        self.assertIn(
            '<a href="https://example.com/path" target="_blank" rel="noopener noreferrer"><em>FOR</em> article</a>',
            html,
        )

    def test_render_paragraphs_does_not_treat_underscores_as_italics(self):
        html = build_pages.render_paragraphs("This _stays_ literal.")
        self.assertIn("This _stays_ literal.", html)
        self.assertNotIn("<em>stays</em>", html)

    def test_render_paragraphs_supports_strong_tags(self):
        html = build_pages.render_paragraphs("Use <strong>important</strong> text.")
        self.assertIn("Use <strong>important</strong> text.", html)

    def test_render_paragraphs_supports_underline_tags(self):
        html = build_pages.render_paragraphs("Use <u>underlined</u> text.")
        self.assertIn("Use <u>underlined</u> text.", html)

    def test_render_paragraphs_supports_strikethrough_tags(self):
        html = build_pages.render_paragraphs("Use <s>removed</s> text.")
        self.assertIn("Use <s>removed</s> text.", html)

    def test_render_paragraphs_supports_fieldset_legend_blocks(self):
        html = build_pages.render_paragraphs(
            "<fieldset><legend>Archive</legend>This sits in a frame.</fieldset>",
            class_name="project-intro",
        )
        self.assertIn(
            '<fieldset class="project-intro"><legend>Archive</legend>This sits in a frame.</fieldset>',
            html,
        )
        self.assertNotIn("<p class=\"project-intro\"><fieldset>", html)

    def test_render_paragraphs_supports_fieldset_inline_formatting(self):
        html = build_pages.render_paragraphs(
            '<fieldset><legend><em>Label</em></legend>Use <a href="about/Paul-Fritz-portfolio.pdf">link</a>.</fieldset>'
        )
        self.assertIn("<legend><em>Label</em></legend>", html)
        self.assertIn(
            '<a href="about/Paul-Fritz-portfolio.pdf" target="_blank" rel="noopener noreferrer">link</a>',
            html,
        )

    def test_render_paragraphs_keeps_square_brackets_as_plain_text(self):
        html = build_pages.render_paragraphs("Notes [draft] [v2] stay plain text.")
        self.assertIn("Notes [draft] [v2] stay plain text.", html)

    def test_render_paragraphs_ignores_comment_lines(self):
        html = build_pages.render_paragraphs(
            "# Syntax note\n\nKeep this line."
        )
        self.assertNotIn("Syntax note", html)
        self.assertIn("Keep this line.", html)

    def test_render_paragraphs_ignores_bom_prefixed_comment_lines(self):
        html = build_pages.render_paragraphs(
            "\ufeff# Syntax note\n\nKeep this line."
        )
        self.assertNotIn("Syntax note", html)
        self.assertIn("Keep this line.", html)

    def test_back_to_link_uses_short_section_label(self):
        html = build_pages.render(
            url="works/test/index.html",
            title="Test",
            desc="test",
            body="<p>body</p>",
            root="../../",
            back_to_section=("films.html", "Selected Works"),
        )
        self.assertIn("Back to Works", html)
        self.assertNotIn("Back to Selected Works", html)

    def test_back_to_link_for_exhibitions_uses_short_label(self):
        html = build_pages.render(
            url="exhibitions/test/index.html",
            title="Test",
            desc="test",
            body="<p>body</p>",
            root="../../",
            back_to_section=("exhibitions.html", "Selected Exhibitions"),
        )
        self.assertIn("Back to Exhibitions", html)
        self.assertNotIn("Back to Selected Exhibitions", html)

    def test_video_prefix_controls_position_and_is_removed_from_caption(self):
        with tempfile.TemporaryDirectory() as tmp:
            section = os.path.join(tmp, "works")
            project = os.path.join(section, "test-project")
            os.makedirs(project)

            with open(os.path.join(project, "01-first.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "02-second.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "video.txt"), "w", encoding="utf-8") as f:
                f.write("https://vimeo.com/123456789 | 02-Video-_Insert_\n")

            old_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                build_pages.build_project("works", "test-project")
            finally:
                os.chdir(old_cwd)

            with open(os.path.join(project, "index.html"), encoding="utf-8") as f:
                html = f.read()

            self.assertIn("Video <em>Insert</em>", html)
            self.assertNotIn("02-Video", html)

            first_pos = html.find("<figcaption>first</figcaption>")
            video_pos = html.find("<figcaption>Video <em>Insert</em></figcaption>")
            second_pos = html.find("<figcaption>second</figcaption>")

            self.assertGreater(first_pos, -1)
            self.assertGreater(video_pos, -1)
            self.assertGreater(second_pos, -1)
            self.assertLess(first_pos, video_pos)
            self.assertLess(video_pos, second_pos)

    def test_thumbnail_prefix_renders_before_title_and_not_in_gallery(self):
        with tempfile.TemporaryDirectory() as tmp:
            section = os.path.join(tmp, "works")
            project = os.path.join(section, "test-project")
            os.makedirs(project)

            with open(os.path.join(project, "00-thumb-a.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "00-thumb-b.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "01-main.jpg"), "wb") as f:
                f.write(b"\x00")

            old_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                build_pages.build_project("works", "test-project")
            finally:
                os.chdir(old_cwd)

            with open(os.path.join(project, "index.html"), encoding="utf-8") as f:
                html = f.read()

            strip_pos = html.find('<div class="project-thumbnails"><img src="00-thumb-a.jpg" alt=""><img src="00-thumb-b.jpg" alt=""></div>')
            title_pos = html.find('<h2 class="project-title">test project</h2>')
            gallery_caption_pos = html.find('<figcaption>main</figcaption>')

            self.assertGreater(strip_pos, -1)
            self.assertGreater(title_pos, -1)
            self.assertGreater(gallery_caption_pos, -1)
            self.assertLess(strip_pos, title_pos)
            self.assertLess(title_pos, gallery_caption_pos)

    def test_numbered_project_text_renders_before_matching_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            section = os.path.join(tmp, "works")
            project = os.path.join(section, "test-project")
            os.makedirs(project)

            with open(os.path.join(project, "01-first.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "02-second.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "02-project.txt"), "w", encoding="utf-8") as f:
                f.write("Text before second image.")

            old_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                build_pages.build_project("works", "test-project")
            finally:
                os.chdir(old_cwd)

            with open(os.path.join(project, "index.html"), encoding="utf-8") as f:
                html = f.read()

            first_pos = html.find("<figcaption>first</figcaption>")
            text_pos = html.find("Text before second image.")
            second_pos = html.find("<figcaption>second</figcaption>")

            self.assertGreater(first_pos, -1)
            self.assertGreater(text_pos, -1)
            self.assertGreater(second_pos, -1)
            self.assertLess(first_pos, text_pos)
            self.assertLess(text_pos, second_pos)

    def test_credits_text_renders_last_with_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            section = os.path.join(tmp, "works")
            project = os.path.join(section, "test-project")
            os.makedirs(project)

            with open(os.path.join(project, "01-first.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "credits.txt"), "w", encoding="utf-8") as f:
                f.write("Directed by Paul Fritz.")

            old_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                build_pages.build_project("works", "test-project")
            finally:
                os.chdir(old_cwd)

            with open(os.path.join(project, "index.html"), encoding="utf-8") as f:
                html = f.read()

            first_pos = html.find("<figcaption>first</figcaption>")
            label_pos = html.find('<p class="credits-label">CREDITS:</p>')
            credits_pos = html.find("Directed by Paul Fritz.")
            to_top_pos = html.find('<p class="to-top">')

            self.assertGreater(first_pos, -1)
            self.assertGreater(label_pos, -1)
            self.assertGreater(credits_pos, -1)
            self.assertGreater(to_top_pos, -1)
            self.assertLess(first_pos, label_pos)
            self.assertLess(label_pos, credits_pos)
            self.assertLess(credits_pos, to_top_pos)

    def test_credits_text_lines_become_br_within_paragraph(self):
        with tempfile.TemporaryDirectory() as tmp:
            section = os.path.join(tmp, "works")
            project = os.path.join(section, "test-project")
            os.makedirs(project)

            with open(os.path.join(project, "01-first.jpg"), "wb") as f:
                f.write(b"\x00")
            with open(os.path.join(project, "credits.txt"), "w", encoding="utf-8") as f:
                f.write("Virginie\nPaul\nEt compagnie")

            old_cwd = os.getcwd()
            try:
                os.chdir(tmp)
                build_pages.build_project("works", "test-project")
            finally:
                os.chdir(old_cwd)

            with open(os.path.join(project, "index.html"), encoding="utf-8") as f:
                html = f.read()

            self.assertIn(
                '<p class="project-credits"><span class="line-break-line">Virginie</span><span class="line-break-line">Paul</span><span class="line-break-line">Et compagnie</span></p>',
                html,
            )
            self.assertNotIn('<figcaption>thumb a</figcaption>', html)
            self.assertNotIn('<figcaption>thumb b</figcaption>', html)


if __name__ == "__main__":
    unittest.main()
