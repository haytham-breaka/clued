"""Monthly sales report from sales.csv."""
import csv
from collections import defaultdict

from utils import format_money, parse_amount

TAX_RATE = 0.19


def load_rows(path="sales.csv"):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def monthly_totals(rows):
    totals = defaultdict(float)
    for row in rows:
        totals[row["date"][:7]] += parse_amount(row["amount"])
    return dict(totals)


def with_tax(amount):
    return amount * (1 + TAX_RATE)


if __name__ == "__main__":
    for month, total in sorted(monthly_totals(load_rows()).items()):
        print(month, format_money(with_tax(total)))
