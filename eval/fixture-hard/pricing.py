"""Prices with tax and member discounts."""

TAX_RATE = 0.19
DEFAULT_DISCOUNT = 0.05


def with_tax(amount):
    """Amount plus tax, rounded to cents."""
    return round(amount * (1 + TAX_RATE), 2)


def member_price(amount):
    """Price after the default member discount."""
    return round(amount * (1 + DEFAULT_DISCOUNT), 2)
