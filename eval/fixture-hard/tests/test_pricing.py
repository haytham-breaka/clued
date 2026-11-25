import unittest

from pricing import member_price, with_tax


class TestPricing(unittest.TestCase):
    def test_with_tax(self):
        self.assertEqual(with_tax(100), 119.0)

    def test_member_price(self):
        self.assertEqual(member_price(100), 95.0)


if __name__ == "__main__":
    unittest.main()
