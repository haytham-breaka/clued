"""Small helpers for the sales report."""

CURRENCY = "EUR"


def parse_amount(text):
    """Turns '1,250.50' into 1250.5. An empty string gives 0.0."""
    text = text.strip().replace(",", "")
    if not text:
        return 0.0
    return float(text)


def format_money(value):
    return f"{value:,.2f} {CURRENCY}"


def percent(part, whole):
    """Share of part in whole, as a percentage rounded to one decimal."""
    if whole == 0:
        return 0.0
    return round(part / whole * 10, 1)
