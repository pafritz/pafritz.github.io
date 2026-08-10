import unittest

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


if __name__ == "__main__":
    unittest.main()
