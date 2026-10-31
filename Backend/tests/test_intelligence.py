import unittest

from app.main import build_order_risk
from app.models import Order


class IntelligenceTests(unittest.TestCase):
    def test_unassigned_urgent_order_is_critical(self):
        order = Order(
            id=7,
            order_number="FF-TEST",
            customer="Test customer",
            pickup="Pickup",
            destination="Destination",
            status="Pending",
            priority="Urgent",
            eta="Not estimated",
        )
        result = build_order_risk(order)
        self.assertEqual(result["risk_level"], "Critical")
        self.assertIn("No driver assigned", result["reasons"])


if __name__ == "__main__":
    unittest.main()
