"""Stock levels from stock.csv."""
import csv

LOW_STOCK = 5


def load_stock(path="stock.csv"):
    with open(path, newline="") as f:
        return [{"item": r["item"], "qty": int(r["qty"])} for r in csv.DictReader(f)]


def low_stock(rows):
    """Names of items with fewer than LOW_STOCK units."""
    return [r["item"] for r in rows if r["qty"] <= LOW_STOCK]
