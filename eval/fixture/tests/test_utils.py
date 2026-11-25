import unittest

from utils import format_money, parse_amount, percent


class TestUtils(unittest.TestCase):
    def test_parse_amount(self):
        self.assertEqual(parse_amount("1,250.50"), 1250.5)
        self.assertEqual(parse_amount(""), 0.0)

    def test_percent(self):
        self.assertEqual(percent(1, 4), 25.0)

    def test_format_money(self):
        self.assertEqual(format_money(1250.5), "1,250.50 EUR")


if __name__ == "__main__":
    unittest.main()
