import unittest

from app.routing import optimize_stops


class RoutingTests(unittest.TestCase):
    def test_pickup_is_always_before_matching_destination(self):
        result = optimize_stops(
            26.45,
            80.33,
            [
                {"stop_id": "order-1-destination", "name": "Drop", "latitude": 26.50, "longitude": 80.31},
                {"stop_id": "order-1-pickup", "name": "Pickup", "latitude": 26.46, "longitude": 80.35},
            ],
        )
        ids = [stop["stop_id"] for stop in result["optimized_stops"]]
        self.assertLess(ids.index("order-1-pickup"), ids.index("order-1-destination"))


    def test_duplicate_stops_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            optimize_stops(
                26.45,
                80.33,
                [
                    {"stop_id": "same", "name": "A", "latitude": 26.4, "longitude": 80.3},
                    {"stop_id": "same", "name": "B", "latitude": 26.5, "longitude": 80.4},
                ],
            )


if __name__ == "__main__":
    unittest.main()
