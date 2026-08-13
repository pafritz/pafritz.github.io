import unittest
import os
import tempfile

import build_pages


class BuildPagesTests(unittest.TestCase):
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
                f.write("https://vimeo.com/123456789 | 02-Video _Insert_\n")

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
                '<p class="project-credits">Virginie<br>\nPaul<br>\nEt compagnie</p>',
                html,
            )
            self.assertNotIn('<figcaption>thumb a</figcaption>', html)
            self.assertNotIn('<figcaption>thumb b</figcaption>', html)


if __name__ == "__main__":
    unittest.main()
