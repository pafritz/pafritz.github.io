import unittest

from caption import caption_from_filename


class CaptionTests(unittest.TestCase):
    def test_copyright_symbol_becomes_photo_label(self):
        self.assertEqual(caption_from_filename("©.jpg"), "Photo:")

    def test_copyright_symbol_is_replaced_in_caption(self):
        self.assertEqual(caption_from_filename("2025-©-test.jpg"), "2025 Photo: test")


if __name__ == "__main__":
    unittest.main()
