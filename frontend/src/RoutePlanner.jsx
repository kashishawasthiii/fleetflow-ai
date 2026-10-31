import { useState } from "react";
import { API, api } from "./api";

const initialStops = [
  {
    stop_id: "S1",
    name: "Kanpur Central",
    latitude: "26.4538",
    longitude: "80.3512",
  },
  {
    stop_id: "S2",
    name: "Phool Bagh",
    latitude: "26.4691",
    longitude: "80.3509",
  },
];

export default function RoutePlanner() {
  const [start, setStart] = useState({
    latitude: "26.4499",
    longitude: "80.3319",
  });
  const [stops, setStops] = useState(initialStops);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [skippedOrders, setSkippedOrders] = useState([]);

  const updateStop = (index, field, value) => {
    setStops((current) =>
      current.map((stop, i) =>
        i === index ? { ...stop, [field]: value } : stop
      )
    );
    setResult(null);
  };

  const addStop = () => {
    setStops((current) => [
      ...current,
      {
        stop_id: `manual-${Date.now()}`,
        name: "",
        latitude: "",
        longitude: "",
      },
    ]);
    setResult(null);
  };

  const removeStop = (index) => {
    setStops((current) => current.filter((_, i) => i !== index));
    setResult(null);
  };

  const loadOrders = async () => {
    setLoadingOrders(true);
    setError("");
    setMessage("");
    setResult(null);
    setSkippedOrders([]);

    try {
      const response = await api.get(`${API}/routes/stops-from-orders`);
      const data = response.data;

      if (!Array.isArray(data.stops)) {
        throw new Error("The backend returned an unexpected response.");
      }

      if (data.stops.length > 100) {
        throw new Error(
          "The route API supports at most 100 stops. Load fewer orders."
        );
      }

      const loadedStops = data.stops.map((stop) => ({
        stop_id: stop.stop_id,
        name: stop.name,
        latitude: String(stop.latitude),
        longitude: String(stop.longitude),
      }));

      setStops(loadedStops);
      setSkippedOrders(data.skipped_orders || []);

      if (loadedStops.length === 0) {
        setMessage(
          "No eligible orders with complete coordinates were found. Verify addresses and save coordinates on active orders first."
        );
      } else {
        setMessage(
          `Loaded ${data.orders_included} order(s) and ${loadedStops.length} stops. Pickup-before-delivery sequencing will be enforced.`
        );
      }

      if (data.skipped_orders?.length) {
        setMessage((current) =>
          `${current} ${data.skipped_orders.length} order(s) skipped because coordinates are missing.`
        );
      }
    } catch (err) {
      setError(
        err.response?.data?.detail ||
          err.message ||
          "Could not load orders."
      );
    } finally {
      setLoadingOrders(false);
    }
  };

  const calculateRoute = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const payload = {
        start_latitude: Number(start.latitude),
        start_longitude: Number(start.longitude),
        stops: stops.map((stop) => ({
          ...stop,
          latitude: Number(stop.latitude),
          longitude: Number(stop.longitude),
        })),
      };

      if (
        !Number.isFinite(payload.start_latitude) ||
        !Number.isFinite(payload.start_longitude) ||
        payload.start_latitude < -90 ||
        payload.start_latitude > 90 ||
        payload.start_longitude < -180 ||
        payload.start_longitude > 180 ||
        start.latitude.trim() === "" ||
        start.longitude.trim() === "" ||
        stops.length === 0 ||
        stops.length > 100 ||
        stops.some(
          (stop) =>
            !stop.name.trim() ||
            stop.latitude.trim() === "" ||
            stop.longitude.trim() === "" ||
            !Number.isFinite(Number(stop.latitude)) ||
            !Number.isFinite(Number(stop.longitude)) ||
            Number(stop.latitude) < -90 ||
            Number(stop.latitude) > 90 ||
            Number(stop.longitude) < -180 ||
            Number(stop.longitude) > 180
        )
      ) {
        throw new Error(
          "Enter valid names and coordinates for the start and every stop."
        );
      }

      const ids = payload.stops.map((stop) => stop.stop_id);
      if (new Set(ids).size !== ids.length) {
        throw new Error("Every stop must have a unique ID.");
      }

      const response = await api.post(
        `${API}/routes/optimize-road`,
        payload
      );
      setResult(response.data);
    } catch (err) {
      setError(
        err.response?.data?.detail ||
          err.message ||
          "Could not calculate the route."
      );
    } finally {
      setLoading(false);
    }
  };

  const getStopLabel = (stop) => {
    if (stop.stop_type === "pickup") return "PICKUP";
    if (stop.stop_type === "destination") return "DELIVERY";
    return "STOP";
  };

  return (
    <section className="panel route-planner">
      <div className="panel-header">
        <div>
          <h3>Smart Route Planner</h3>
          <p>
            Load active orders or enter stops manually, then calculate a
            suggested road route with pickup-before-delivery sequencing.
          </p>
        </div>
        <span className="badge connected">OSRM</span>
      </div>

      <div className="route-order-actions">
        <button
          type="button"
          className="primary-button"
          onClick={loadOrders}
          disabled={loadingOrders || loading}
        >
          {loadingOrders ? "Loading orders..." : "Load Orders from Database"}
        </button>
        <p>
          Loads pickup and destination locations for active orders that have
          verified coordinates.
        </p>
      </div>

      {message && (
        <p className="demo-note" role="status">
          {message}
        </p>
      )}

      {skippedOrders.length > 0 && (
        <div className="route-skipped-orders">
          <strong>Orders needing coordinates</strong>
          <ul>
            {skippedOrders.map((order) => (
              <li key={order.order_id}>
                {order.order_number}: {order.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form className="order-form" onSubmit={calculateRoute}>
        <h4>Starting Location</h4>
        <div className="order-form-grid">
          <label>
            Latitude
            <input
              type="number"
              step="any"
              min="-90"
              max="90"
              required
              value={start.latitude}
              onChange={(e) =>
                setStart({ ...start, latitude: e.target.value })
              }
            />
          </label>
          <label>
            Longitude
            <input
              type="number"
              step="any"
              min="-180"
              max="180"
              required
              value={start.longitude}
              onChange={(e) =>
                setStart({ ...start, longitude: e.target.value })
              }
            />
          </label>
        </div>

        <div className="panel-header">
          <div>
            <h4>Route Stops</h4>
            <p>{stops.length} stop(s)</p>
          </div>
          <button
            type="button"
            className="link-button"
            onClick={addStop}
            disabled={stops.length >= 100 || loading || loadingOrders}
          >
            + Add stop
          </button>
        </div>

        {stops.map((stop, index) => (
          <div className="route-stop-form" key={stop.stop_id}>
            <strong>Stop {index + 1}</strong>
            <div className="order-form-grid">
              <label>
                Location Name
                <input
                  required
                  value={stop.name}
                  onChange={(e) =>
                    updateStop(index, "name", e.target.value)
                  }
                  placeholder="Delivery location"
                />
              </label>
              <label>
                Latitude
                <input
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  required
                  value={stop.latitude}
                  onChange={(e) =>
                    updateStop(index, "latitude", e.target.value)
                  }
                />
              </label>
              <label>
                Longitude
                <input
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  required
                  value={stop.longitude}
                  onChange={(e) =>
                    updateStop(index, "longitude", e.target.value)
                  }
                />
              </label>
            </div>
            <button
              type="button"
              className="link-button"
              onClick={() => removeStop(index)}
              disabled={stops.length <= 1 || loading || loadingOrders}
            >
              Remove stop
            </button>
          </div>
        ))}

        <button
          className="primary-button"
          type="submit"
          disabled={loading || loadingOrders || stops.length === 0}
        >
          {loading ? "Calculating route..." : "Optimize Road Route"}
        </button>
      </form>

      {error && (
        <p className="route-error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <div className="route-result" role="status">
          <h4>Route Calculation Result</h4>
          <div className="stats-grid">
            <article className="stat-card">
              <h2>{result.total_distance_km} km</h2>
              <p>Road Distance Estimate</p>
            </article>
            <article className="stat-card">
              <h2>{result.estimated_duration_minutes} min</h2>
              <p>Estimated Driving Time</p>
            </article>
            <article className="stat-card">
              <h2>{result.stop_count}</h2>
              <p>Stops</p>
            </article>
          </div>

          <h4>Suggested Stop Order</h4>
          <ol className="route-stop-list">
            {result.optimized_stops.map((stop, index) => (
              <li key={stop.stop_id}>
                <strong>
                  {index + 1}. {stop.name}
                </strong>
                <span>
                  {stop.stop_type && (
                    <>[{getStopLabel(stop)}] · </>
                  )}
                  {stop.distance_from_previous_km} km straight-line distance
                  from previous location
                </span>
              </li>
            ))}
          </ol>

          <p className="demo-note">
            {result.pickup_delivery_constraint
              ? `Pickup/delivery constraint: ${result.pickup_delivery_constraint}. `
              : ""}
            {result.note}
          </p>
        </div>
      )}
    </section>
  );
}
