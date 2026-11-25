import unittest

from inventory import low_stock


class TestInventory(unittest.TestCase):
    def test_low_stock(self):
        rows = [{"item": "a", "qty": 4}, {"item": "b", "qty": 5}, {"item": "c", "qty": 6}]
        self.assertEqual(low_stock(rows), ["a"])


if __name__ == "__main__":
    unittest.main()
