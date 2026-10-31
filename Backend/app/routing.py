from math import radians, sin, cos, asin, sqrt
import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def haversine_km(
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
) -> float:
    """Calculate approximate straight-line distance in kilometres."""
    earth_radius_km = 6371.0088

    lat1_rad = radians(lat1)
    lat2_rad = radians(lat2)
    delta_lat = radians(lat2 - lat1)
    delta_lon = radians(lon2 - lon1)

    a = (
        sin(delta_lat / 2) ** 2
        + cos(lat1_rad)
        * cos(lat2_rad)
        * sin(delta_lon / 2) ** 2
    )
    a = max(0.0, min(1.0, a))
    return 2 * earth_radius_km * asin(sqrt(a))


def _get_order_pair(stop_id: str):
    """
    Identify database-generated pickup/destination pairs.

    Expected IDs:
      order-<id>-pickup
      order-<id>-destination

    Manual stops and other IDs have no precedence dependency.
    """
    if stop_id.endswith("-pickup"):
        return stop_id[:-7], "pickup"
    if stop_id.endswith("-destination"):
        return stop_id[:-12], "destination"
    return None, None


def _validate_and_build_dependencies(stops: list[dict]) -> dict[str, set[str]]:
    """Return destination-stop dependencies and validate paired stops."""
    ids = [str(stop["stop_id"]) for stop in stops]

    if len(ids) != len(set(ids)):
        raise ValueError("Each stop_id must be unique.")

    pickup_by_order = {}
    destination_by_order = {}

    for stop in stops:
        pair_key, stop_type = _get_order_pair(str(stop["stop_id"]))
        if pair_key is None:
            continue

        if stop_type == "pickup":
            pickup_by_order[pair_key] = str(stop["stop_id"])
        else:
            destination_by_order[pair_key] = str(stop["stop_id"])

    dependencies = {stop_id: set() for stop_id in ids}

    for pair_key, destination_id in destination_by_order.items():
        pickup_id = pickup_by_order.get(pair_key)
        if pickup_id is None:
            raise ValueError(
                f"Destination stop {destination_id} has no matching pickup stop."
            )
        dependencies[destination_id].add(pickup_id)

    return dependencies


def optimize_stops(
    start_lat: float,
    start_lon: float,
    stops: list[dict],
) -> dict:
    """
    Arrange stops using a precedence-aware nearest-neighbour heuristic.

    For database order stops, each pickup must be visited before its
    matching destination. Other/manual stops have no dependency.
    Distances are straight-line estimates, not road distances.
    """
    if not stops:
        raise ValueError("At least one delivery stop is required.")

    dependencies = _validate_and_build_dependencies(stops)
    remaining = [dict(stop) for stop in stops]
    ordered_stops = []
    completed_ids = set()

    current_lat = start_lat
    current_lon = start_lon
    total_distance_km = 0.0

    while remaining:
        eligible = [
            stop for stop in remaining
            if dependencies[str(stop["stop_id"])].issubset(completed_ids)
        ]

        # A cycle should not occur with the generated pickup/destination
        # dependencies, but fail safely if malformed input creates one.
        if not eligible:
            raise ValueError(
                "The route contains invalid or circular stop dependencies."
            )

        nearest_stop = min(
            eligible,
            key=lambda stop: haversine_km(
                current_lat,
                current_lon,
                float(stop["latitude"]),
                float(stop["longitude"]),
            ),
        )

        leg_distance = haversine_km(
            current_lat,
            current_lon,
            float(nearest_stop["latitude"]),
            float(nearest_stop["longitude"]),
        )

        total_distance_km += leg_distance
        stop_id = str(nearest_stop["stop_id"])

        pair_key, stop_type = _get_order_pair(stop_id)
        enriched_stop = {
            **nearest_stop,
            "distance_from_previous_km": round(leg_distance, 2),
        }
        if stop_type:
            enriched_stop["stop_type"] = stop_type
            enriched_stop["order_key"] = pair_key

        ordered_stops.append(enriched_stop)
        completed_ids.add(stop_id)
        current_lat = float(nearest_stop["latitude"])
        current_lon = float(nearest_stop["longitude"])
        remaining.remove(nearest_stop)

    return {
        "algorithm": "Precedence-Aware Nearest Neighbour",
        "distance_type": "Straight-line estimate",
        "total_distance_km": round(total_distance_km, 2),
        "stop_count": len(ordered_stops),
        "optimized_stops": ordered_stops,
        "pickup_delivery_constraint": "Enforced for database order stop pairs",
        "note": (
            "Each order pickup is scheduled before its matching destination. "
            "Stop order uses a nearest-neighbour heuristic and is not a "
            "globally optimal vehicle-routing solution. Distances are "
            "straight-line estimates."
        ),
    }


def calculate_road_route(
    start_lat: float,
    start_lon: float,
    stops: list[dict],
) -> dict:
    """Optimize stop order with pickup precedence, then request OSRM road data."""
    if not stops:
        raise ValueError("At least one delivery stop is required.")

    optimized = optimize_stops(start_lat, start_lon, stops)
    ordered_stops = optimized["optimized_stops"]

    coordinates = [f"{start_lon},{start_lat}"] + [
        f'{stop["longitude"]},{stop["latitude"]}'
        for stop in ordered_stops
    ]

    url = (
        "https://router.project-osrm.org/route/v1/driving/"
        + ";".join(coordinates)
        + "?"
        + urlencode({"overview": "false"})
    )

    request = Request(
        url,
        headers={"User-Agent": "FleetFlowAI/1.0 (student capstone prototype)"},
    )

    try:
        with urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(
            "Road-routing service is unavailable. Please try again."
        ) from exc

    if data.get("code") != "Ok" or not data.get("routes"):
        raise RuntimeError(
            "A road route could not be found for these locations."
        )

    route = data["routes"][0]

    return {
        "algorithm": "Precedence-Aware Nearest Neighbour + OSRM",
        "distance_type": "Road route estimate",
        "total_distance_km": round(route["distance"] / 1000, 2),
        "estimated_duration_minutes": round(route["duration"] / 60, 1),
        "stop_count": len(ordered_stops),
        "optimized_stops": ordered_stops,
        "pickup_delivery_constraint": "Enforced",
        "note": (
            "Each order pickup is scheduled before its matching destination. "
            "Stop order is selected using a precedence-aware nearest-neighbour "
            "heuristic. OSRM supplies road distance and estimated duration; "
            "live traffic, vehicle capacity and time windows are not included."
        ),
    }
