
import { useCallback, useEffect, useMemo, useState } from "react";
import RoutePlanner from "./RoutePlanner";
import AuthScreen from "./AuthScreen";
import CustomerPortal from "./CustomerPortal";
import { API, api, clearSession } from "./api";
import "./App.css";

const EMPTY_ORDER = {
  order_number: "",
  customer: "",
  pickup: "",
  destination: "",
  status: "Pending",
  priority: "Normal",
  eta: "Not estimated",
};

const EMPTY_DRIVER = {
  name: "",
  vehicle: "",
  status: "Available",
  deliveries_today: 0,
  capacity_kg: 500,
};

const ORDER_STATUSES = [
  "Pending",
  "In Transit",
  "In Progress",
  "Dispatched",
  "Delivered",
  "Failed Delivery",
  "Rescheduled",
  "Returned",
];

function OperationsApp() {
  const [token, setToken] = useState(() => localStorage.getItem("fleetflow_access_token"));
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("fleetflow_user") || "null"); } catch { return null; }
  });
  const [page, setPage] = useState("Dashboard");
  const [connection, setConnection] = useState("Checking...");
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [showOrderForm, setShowOrderForm] = useState(false);
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [creatingDriver, setCreatingDriver] = useState(false);
  const [updatingOrderId, setUpdatingOrderId] = useState(null);
  const [assigningOrderId, setAssigningOrderId] = useState(null);
  const [intelligence, setIntelligence] = useState(null);
  const [intelligenceLoading, setIntelligenceLoading] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [orderFilter, setOrderFilter] = useState("All");
  const [copilotOrder, setCopilotOrder] = useState(null);
  const [copilotResult, setCopilotResult] = useState(null);
  const [copilotLoading, setCopilotLoading] = useState(false);
  const [copilotAssigning, setCopilotAssigning] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [liveDrivers, setLiveDrivers] = useState([]);
  const [trackingLink, setTrackingLink] = useState("");
  const [exceptions, setExceptions] = useState([]);
  const [codSummary, setCodSummary] = useState(null);
  const [maintenance, setMaintenance] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [podOrder, setPodOrder] = useState(null);
  const [podForm, setPodForm] = useState({ recipient_name: "", signature_name: "", photo_url: "", otp_verified: false, notes: "" });
  const [submittingPod, setSubmittingPod] = useState(false);

  const [orderForm, setOrderForm] = useState({ ...EMPTY_ORDER });
  const [driverForm, setDriverForm] = useState({ ...EMPTY_DRIVER });
  const [pickupLocation, setPickupLocation] = useState(null);
  const [destinationLocation, setDestinationLocation] = useState(null);
  const [geocoding, setGeocoding] = useState(false);
  const [locationsVerified, setLocationsVerified] = useState(false);

  const loadData = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    setRefreshing(true);
    setError("");

    try {
      const health = await api.get(`${API}/health`);
      setConnection(
        health.data.status === "healthy" ? "Connected" : "Offline"
      );

      setIntelligenceLoading(true);
      const results = await Promise.allSettled([
        api.get(`${API}/dashboard/stats`),
        api.get(`${API}/orders`),
        api.get(`${API}/drivers`),
        api.get(`${API}/intelligence/brief`),
      ]);

      const [statsResult, ordersResult, driversResult, intelligenceResult] = results;
      const failures = [];

      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value.data);
      } else failures.push("statistics");

      if (ordersResult.status === "fulfilled") {
        setOrders(ordersResult.value.data);
      } else failures.push("orders");

      if (driversResult.status === "fulfilled") {
        setDrivers(driversResult.value.data);
      } else failures.push("drivers");

      if (intelligenceResult.status === "fulfilled") {
        setIntelligence(intelligenceResult.value.data);
      } else failures.push("intelligence");

      const notificationResult = await api.get(`${API}/notifications`);
      setNotifications(notificationResult.data);
      const liveResult = await api.get(`${API}/fleet/live`);
      setLiveDrivers(liveResult.data.drivers || []);
      const workspaceResult = await api.get(`${API}/workspace`);
      setWorkspace(workspaceResult.data);
      const [exceptionResult, codResult, maintenanceResult] = await Promise.allSettled([
        api.get(`${API}/exceptions`),
        api.get(`${API}/cod/summary`),
        api.get(`${API}/maintenance`),
      ]);
      if (exceptionResult.status === "fulfilled") setExceptions(exceptionResult.value.data.exceptions || []);
      if (codResult.status === "fulfilled") setCodSummary(codResult.value.data);
      if (maintenanceResult.status === "fulfilled") setMaintenance(maintenanceResult.value.data || []);

      if (failures.length) {
        setError(`Unable to load ${failures.join(", ")}.`);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        clearSession();
        setToken(null);
        setUser(null);
        return;
      }
      setConnection("Offline");
      setError("Backend connection failed. Start FastAPI and try again.");
    } finally {
      setLoading(false);
      setRefreshing(false);
      setIntelligenceLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!token) return undefined;
    const timer = window.setInterval(() => {
      api.get(`${API}/notifications`).then((response) => setNotifications(response.data)).catch(() => {});
    }, 20000);
    return () => window.clearInterval(timer);
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    const socketUrl = API.startsWith("http")
      ? API.replace(/^http/, "ws") + `/ws/fleet?token=${encodeURIComponent(token)}`
      : `${window.location.origin.replace(/^http/, "ws")}${API}/ws/fleet?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(socketUrl);
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.event !== "driver_location_updated") return;
      setLiveDrivers((current) => {
        const next = current.filter((driver) => driver.driver_id !== payload.driver_id);
        return [...next, { ...payload, driver_id: payload.driver_id, last_seen: payload.recorded_at }];
      });
    };
    return () => socket.close();
  }, [token]);

  const activeOrders = useMemo(
    () => orders.filter((o) => o.status !== "Delivered"),
    [orders]
  );

  const assignedOrders = useMemo(
    () => activeOrders.filter((o) => o.driver_id != null),
    [activeOrders]
  );

  const unassignedOrders = useMemo(
    () => activeOrders.filter((o) => o.driver_id == null),
    [activeOrders]
  );

  const statusCounts = useMemo(() => {
    const statuses = [
      "Pending",
      "In Transit",
      "In Progress",
      "Dispatched",
      "Delivered",
      "Failed Delivery",
      "Rescheduled",
      "Returned",
    ];

    return statuses.map((name) => ({
      name,
      count: orders.filter((o) => o.status === name).length,
    }));
  }, [orders]);

  const priorityCounts = useMemo(() => {
    const priorities = ["Urgent", "High", "Normal", "Low"];

    return priorities.map((name) => ({
      name,
      count: orders.filter((o) => o.priority === name).length,
    }));
  }, [orders]);

  const visibleOrders = useMemo(() => {
    const query = orderSearch.trim().toLowerCase();
    return orders.filter((order) => {
      const matchesFilter = orderFilter === "All" || order.status === orderFilter;
      const matchesSearch = !query || [
        order.order_number,
        order.customer,
        order.pickup,
        order.destination,
      ].some((value) => String(value || "").toLowerCase().includes(query));
      return matchesFilter && matchesSearch;
    });
  }, [orders, orderSearch, orderFilter]);

  const fleetMapPoints = useMemo(() => {
    const source = liveDrivers.length ? liveDrivers : drivers;
    const positioned = source.filter((driver) => Number.isFinite(Number(driver.latitude ?? driver.current_latitude)) && Number.isFinite(Number(driver.longitude ?? driver.current_longitude)));
    if (!positioned.length) return [];
    const lats = positioned.map((driver) => Number(driver.latitude ?? driver.current_latitude));
    const lons = positioned.map((driver) => Number(driver.longitude ?? driver.current_longitude));
    const minLat = Math.min(...lats); const maxLat = Math.max(...lats); const minLon = Math.min(...lons); const maxLon = Math.max(...lons);
    return positioned.map((driver) => ({
      ...driver,
      x: 10 + ((Number(driver.longitude ?? driver.current_longitude) - minLon) / Math.max(maxLon - minLon, 0.01)) * 80,
      y: 86 - ((Number(driver.latitude ?? driver.current_latitude) - minLat) / Math.max(maxLat - minLat, 0.01)) * 72,
    }));
  }, [liveDrivers, drivers]);

  const statusClass = (value = "") =>
    value.toLowerCase().trim().replace(/\s+/g, "-");

  const handleOrderInput = (e) => {
    const { name, value } = e.target;
    setOrderForm((prev) => ({ ...prev, [name]: value }));

    // Coordinates must be looked up again whenever either address changes.
    if (name === "pickup") {
      setPickupLocation(null);
      setLocationsVerified(false);
    }
    if (name === "destination") {
      setDestinationLocation(null);
      setLocationsVerified(false);
    }
  };

  const handleGeocodeLocations = async () => {
    if (orderForm.pickup.trim().length < 3 || orderForm.destination.trim().length < 3) {
      setError("Enter both pickup and destination addresses (at least 3 characters).");
      return;
    }

    setGeocoding(true);
    setError("");
    setMessage("");
    setPickupLocation(null);
    setDestinationLocation(null);
    setLocationsVerified(false);

    try {
      const pickupResponse = await api.post(`${API}/locations/geocode`, {
        address: orderForm.pickup.trim(),
      });
      const destinationResponse = await api.post(`${API}/locations/geocode`, {
        address: orderForm.destination.trim(),
      });

      setPickupLocation(pickupResponse.data);
      setDestinationLocation(destinationResponse.data);
      setMessage("Both locations were found. Review the matched addresses before confirming.");
    } catch (err) {
      setError(
        typeof err.response?.data?.detail === "string"
          ? err.response.data.detail
          : "Could not find one or both locations. Try a more complete address."
      );
    } finally {
      setGeocoding(false);
    }
  };

  const handleDriverInput = (e) => {
    const { name, value } = e.target;
    setDriverForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleCreateOrder = async (e) => {
    e.preventDefault();
    setCreatingOrder(true);
    setError("");
    setMessage("");

    try {
      if (!pickupLocation || !destinationLocation || !locationsVerified) {
        throw new Error("Verify and confirm both locations before saving the order.");
      }

      const payload = {
        ...orderForm,
        pickup_latitude: pickupLocation.latitude,
        pickup_longitude: pickupLocation.longitude,
        destination_latitude: destinationLocation.latitude,
        destination_longitude: destinationLocation.longitude,
      };

      await api.post(`${API}/orders`, payload);
      setOrderForm({ ...EMPTY_ORDER });
      setPickupLocation(null);
      setDestinationLocation(null);
      setLocationsVerified(false);
      setShowOrderForm(false);
      setMessage("Order created successfully with verified location coordinates.");
      await loadData();
    } catch (err) {
      setError(
        typeof err.response?.data?.detail === "string"
          ? err.response.data.detail
          : err.message || "Could not create order. Check the order number and backend."
      );
    } finally {
      setCreatingOrder(false);
    }
  };

  const handleCreateDriver = async (e) => {
    e.preventDefault();
    setCreatingDriver(true);
    setError("");
    setMessage("");

    try {
      await api.post(`${API}/drivers`, {
        ...driverForm,
        deliveries_today: Number(driverForm.deliveries_today),
        capacity_kg: Number(driverForm.capacity_kg),
      });

      setDriverForm({ ...EMPTY_DRIVER });
      setShowDriverForm(false);
      setMessage("Driver added successfully.");
      await loadData();
    } catch (err) {
      setError(
        typeof err.response?.data?.detail === "string"
          ? err.response.data.detail
          : "Could not add driver."
      );
    } finally {
      setCreatingDriver(false);
    }
  };

  const handleStatusUpdate = async (orderId, newStatus) => {
    setUpdatingOrderId(orderId);
    setError("");
    setMessage("");

    if (newStatus === "Delivered") {
      const order = orders.find((item) => item.id === orderId);
      setPodOrder(order);
      setUpdatingOrderId(null);
      return;
    }

    try {
      await api.patch(`${API}/orders/${orderId}/status`, {
        status: newStatus,
      });
      setMessage("Order status updated.");
      await loadData();
    } catch (err) {
      setError(
        typeof err.response?.data?.detail === "string"
          ? err.response.data.detail
          : "Could not update order status."
      );
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const handleAssignDriver = async (orderId, driverId) => {
    setAssigningOrderId(orderId);
    setError("");
    setMessage("");

    try {
      await api.patch(`${API}/orders/${orderId}/assign-driver`, {
        driver_id: driverId === "" ? null : Number(driverId),
      });

      setMessage(
        driverId === ""
          ? "Driver unassigned successfully."
          : "Driver assigned successfully."
      );
      await loadData();
    } catch (err) {
      setError(
        typeof err.response?.data?.detail === "string"
          ? err.response.data.detail
          : "Could not assign driver."
      );
    } finally {
      setAssigningOrderId(null);
    }
  };

  const openDispatchCopilot = async (order) => {
    const normalizedOrder = { ...order, id: order.id ?? order.order_id };
    setCopilotOrder(normalizedOrder);
    setCopilotResult(null);
    setTrackingLink("");
    setCopilotLoading(true);
    setError("");
    try {
      const response = await api.get(`${API}/dispatch/recommend/${normalizedOrder.id}`);
      setCopilotResult(response.data);
    } catch (err) {
      setError(
        typeof err.response?.data?.detail === "string"
          ? err.response.data.detail
          : "Dispatch Copilot could not score this order."
      );
    } finally {
      setCopilotLoading(false);
    }
  };

  const assignCopilotRecommendation = async () => {
    const driverId = copilotResult?.recommended_driver?.driver_id;
    if (!copilotOrder || !driverId) return;
    setCopilotAssigning(true);
    setError("");
    try {
      await api.post(`${API}/dispatch/assign/${copilotOrder.id}`, {
        driver_id: driverId,
      });
      setCopilotOrder(null);
      setCopilotResult(null);
      setMessage("Copilot recommendation approved and driver assigned.");
      await loadData();
    } catch (err) {
      setError(
        typeof err.response?.data?.detail === "string"
          ? err.response.data.detail
          : "Could not apply the Copilot recommendation."
      );
    } finally {
      setCopilotAssigning(false);
    }
  };

  const handleLogout = () => {
    clearSession();
    setToken(null);
    setUser(null);
  };

  const markNotificationRead = async (notification) => {
    if (notification.is_read) return;
    try {
      await api.patch(`${API}/notifications/${notification.id}/read`);
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, is_read: true } : item));
    } catch { /* the next polling cycle will reconcile state */ }
  };

  const createTrackingShare = async (orderId) => {
    try {
      const response = await api.post(`${API}/orders/${orderId}/tracking-share`);
      const url = `${window.location.origin}${response.data.path}`;
      setTrackingLink(url);
      await navigator.clipboard?.writeText(url);
      setMessage("Customer tracking link created and copied to clipboard.");
    } catch (err) {
      setError(err.response?.data?.detail || "Could not create a customer tracking link.");
    }
  };

  const submitProofOfDelivery = async (event) => {
    event.preventDefault();
    if (!podOrder) return;
    setSubmittingPod(true);
    setError("");
    try {
      await api.post(`${API}/orders/${podOrder.id}/proof`, podForm);
      setPodOrder(null);
      setPodForm({ recipient_name: "", signature_name: "", photo_url: "", otp_verified: false, notes: "" });
      setMessage("Proof of delivery captured. Order marked as delivered.");
      await loadData();
    } catch (err) {
      setError(err.response?.data?.detail || "Could not submit proof of delivery.");
    } finally {
      setSubmittingPod(false);
    }
  };

  const statCards = [
    {
      label: "Total Orders",
      value: stats?.total_orders ?? orders.length,
      icon: "📦",
    },
    {
      label: "Active Deliveries",
      value: stats?.active_deliveries ?? activeOrders.length,
      icon: "🚚",
    },
    {
      label: "Available Drivers",
      value:
        stats?.available_drivers ??
        drivers.filter((d) => d.status === "Available").length,
      icon: "👤",
    },
    {
      label: "On-Time Rate",
      value: `${stats?.on_time_rate ?? 0}%`,
      icon: "📈",
    },
    {
      label: "SLA Alerts",
      value: intelligence?.kpis?.critical_alerts ?? 0,
      icon: "🛡️",
    },
  ];

  const renderOrdersTable = (items) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ORDER ID</th>
            <th>CUSTOMER</th>
            <th>DESTINATION</th>
            <th>STATUS</th>
            <th>UPDATE STATUS</th>
            <th>ASSIGNED DRIVER</th>
            <th>PRIORITY</th>
            <th>COPILOT</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan="8">
                {loading ? "Loading orders..." : "No orders found."}
              </td>
            </tr>
          ) : (
            items.map((order) => (
              <tr key={order.id}>
                <td className="order-id">#{order.order_number}</td>
                <td>{order.customer}</td>
                <td>{order.destination}</td>
                <td>
                  <span className={`badge ${statusClass(order.status)}`}>
                    {order.status}
                  </span>
                </td>
                <td>
                  <select
                    value={order.status}
                    disabled={updatingOrderId === order.id}
                    onChange={(e) =>
                      handleStatusUpdate(order.id, e.target.value)
                    }
                    aria-label={`Update ${order.order_number} status`}
                  >
                    {ORDER_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={order.driver_id ?? ""}
                    disabled={
                      assigningOrderId === order.id ||
                      order.status === "Delivered"
                    }
                    onChange={(e) =>
                      handleAssignDriver(order.id, e.target.value)
                    }
                    aria-label={`Assign driver to ${order.order_number}`}
                  >
                    <option value="">Unassigned</option>
                    {drivers
                      .filter(
                        (d) =>
                          d.status === "Available" ||
                          Number(d.id) === Number(order.driver_id)
                      )
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} — {d.vehicle}
                        </option>
                      ))}
                  </select>
                  {assigningOrderId === order.id && (
                    <small>Saving...</small>
                  )}
                </td>
                <td>
                  <span className={`badge ${statusClass(order.priority)}`}>
                    {order.priority}
                  </span>
                </td>
                <td>
                  {order.status === "Delivered" ? (
                    <span className="muted-cell">Closed</span>
                  ) : (
                    <button
                      type="button"
                      className="copilot-button"
                      onClick={() => openDispatchCopilot(order)}
                    >
                      ✦ Assess
                    </button>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );

  const renderProgressList = (items, total) => (
    <div className="analytics-list">
      {items.map((item) => {
        const percent = total ? (item.count / total) * 100 : 0;
        return (
          <div className="analytics-row" key={item.name}>
            <div className="analytics-row-label">
              <span>{item.name}</span>
              <strong>{item.count}</strong>
            </div>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );

  if (!token) {
    return <AuthScreen onAuthenticated={(nextUser) => { setUser(nextUser); setToken(localStorage.getItem("fleetflow_access_token")); }} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">F</div>
          <div>
            <h2>FleetFlow</h2>
            <p>{workspace?.name || "AI Logistics Platform"}</p>
          </div>
        </div>

        <p className="nav-heading">WORKSPACE</p>

        {[
          ["Dashboard", "▦"],
          ["Orders", "▤"],
          ["Drivers", "♙"],
          ["Routes", "⌁"],
          ["Analytics", "▥"],
          ["Exceptions", "!"],
          ["Finance", "₹"],
          ["Maintenance", "⚙"],
        ].map(([name, icon]) => (
          <button
            key={name}
            className={`nav-item ${page === name ? "active" : ""}`}
            onClick={() => {
              setPage(name);
              setMessage("");
              setError("");
            }}
          >
            <span>{icon}</span>
            {name}
          </button>
        ))}

        <div className="sidebar-bottom">
          <div className="system-card">
            <span className="online-dot" />
            <div>
              <strong>System status</strong>
              <p>{connection}</p>
            </div>
          </div>
          <p className="version">FLEETFLOW AI · VERSION 1.1</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="breadcrumb">WORKSPACE / {page.toUpperCase()}</p>
            <h1>{page}</h1>
            <p className="muted">Manage your delivery operations.</p>
          </div>
          <div className="admin-profile">
            <button
              className="primary-button"
              onClick={loadData}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing..." : "↻ Refresh"}
            </button>
            <div className="notification-wrap">
              <button className="notification-button" onClick={() => setNotificationsOpen((value) => !value)} aria-label="Open notifications">
                ♢<span>{notifications.filter((item) => !item.is_read).length}</span>
              </button>
              {notificationsOpen && <div className="notification-popover"><div className="notification-popover-head"><strong>Operations inbox</strong><span>{notifications.filter((item) => !item.is_read).length} unread</span></div>{notifications.length === 0 ? <p className="empty-state">No operational notifications yet.</p> : notifications.slice(0, 6).map((notification) => <button className={`notification-row ${notification.is_read ? "read" : ""}`} key={notification.id} onClick={() => markNotificationRead(notification)}><span className={`notification-severity ${notification.severity}`} /><div><strong>{notification.title}</strong><p>{notification.message}</p><small>{new Date(notification.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div></button>)}</div>}
            </div>
            <div className="avatar">{(user?.full_name || "A").slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{user?.full_name || "Administrator"}</strong>
              <p>{workspace?.role || user?.role || "Operations owner"} · <button className="logout-button" onClick={handleLogout}>Sign out</button></p>
            </div>
          </div>
        </header>

        {error && (
          <section className="panel" role="alert">
            <p>{error}</p>
          </section>
        )}
        {message && (
          <section className="panel" role="status">
            <p>{message}</p>
          </section>
        )}

        {page === "Dashboard" && (
          <>
            <section className="welcome">
              <div>
                <span className="welcome-tag">OPERATIONS OVERVIEW</span>
                <h2>Welcome back, Admin 👋</h2>
                <p>Keep deliveries moving and operations on track.</p>
              </div>
              <div className="truck-art">🚚</div>
            </section>

            <section className="stats-grid">
              {statCards.map((stat) => (
                <article className="stat-card" key={stat.label}>
                  <div className="stat-top">
                    <span className="stat-icon">{stat.icon}</span>
                    <span className="trend">Live data</span>
                  </div>
                  <h2>{loading && !stats ? "..." : stat.value}</h2>
                  <p>{stat.label}</p>
                </article>
              ))}
            </section>

            <section className="content-grid">
              <article className="panel">
                <div className="panel-header">
                  <div>
                    <h3>Recent Orders</h3>
                    <p>Latest records from your database</p>
                  </div>
                  <button className="link-button" onClick={() => setPage("Orders")}>
                    View all →
                  </button>
                </div>
                {renderOrdersTable(orders.slice(0, 5))}
              </article>

              <article className="panel ai-panel">
                <div className="panel-header">
                  <div>
                    <h3>SLA Shield</h3>
                    <p>Explainable operations intelligence</p>
                  </div>
                  <span className="ai-label">LIVE</span>
                </div>
                <div className="intelligence-hero">
                  <div className="ai-symbol">✦</div>
                  <div>
                    <span className="eyebrow">CONTROL TOWER BRIEF</span>
                    <h3>{intelligence?.headline || "Reading the live operation..."}</h3>
                    <p>
                      {intelligenceLoading
                        ? "Scoring live orders, driver capacity and dispatch readiness."
                        : `${intelligence?.kpis?.watchlist_orders ?? 0} order(s) are on the watchlist and ${intelligence?.kpis?.unassigned_active ?? 0} active order(s) need a driver.`}
                    </p>
                  </div>
                </div>
                <div className="risk-strip">
                  <div><strong>{intelligence?.kpis?.critical_alerts ?? 0}</strong><span>Critical</span></div>
                  <div><strong>{intelligence?.kpis?.watchlist_orders ?? 0}</strong><span>Watchlist</span></div>
                  <div><strong>{intelligence?.kpis?.fleet_utilization_pct ?? 0}%</strong><span>Fleet load</span></div>
                </div>
                <div className="recommendation-list">
                  {(intelligence?.recommendations || []).slice(0, 2).map((item) => (
                    <div className="recommendation-item" key={item.title}>
                      <span className={`recommendation-dot ${item.priority}`} />
                      <div><strong>{item.title}</strong><p>{item.detail}</p></div>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          </>
        )}

        {page === "Orders" && (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h3>Order Management</h3>
                <p>Create orders, update status and assign drivers.</p>
              </div>
              <button
                className="primary-button"
                onClick={() => {
                  setMessage("");
                  setError("");
                  setShowOrderForm((v) => !v);
                }}
              >
                {showOrderForm ? "Cancel" : "+ Create Order"}
              </button>
            </div>

            {showOrderForm && (
              <form className="order-form" onSubmit={handleCreateOrder}>
                <h3>Create New Order</h3>
                <div className="order-form-grid">
                  <label>Order Number
                    <input name="order_number" required maxLength={30}
                      placeholder="FF-1003" value={orderForm.order_number}
                      onChange={handleOrderInput} />
                  </label>
                  <label>Customer
                    <input name="customer" required maxLength={100}
                      value={orderForm.customer} onChange={handleOrderInput}
                      placeholder="Customer name" />
                  </label>
                  <label>Pickup
                    <input name="pickup" required maxLength={200}
                      value={orderForm.pickup} onChange={handleOrderInput}
                      placeholder="Pickup location" />
                  </label>
                  <label>Destination
                    <input name="destination" required maxLength={200}
                      value={orderForm.destination} onChange={handleOrderInput}
                      placeholder="Delivery destination" />
                  </label>
                  <label>Status
                    <select name="status" value={orderForm.status} onChange={handleOrderInput}>
                      {ORDER_STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </label>
                  <label>Priority
                    <select name="priority" value={orderForm.priority} onChange={handleOrderInput}>
                      {["Normal", "High", "Urgent", "Low"].map((p) => <option key={p}>{p}</option>)}
                    </select>
                  </label>
                </div>

                <div className="location-verification" style={{ margin: "16px 0", padding: "14px", border: "1px solid #d7deea", borderRadius: "10px" }}>
                  <h4 style={{ margin: "0 0 8px" }}>Location verification</h4>
                  <p style={{ margin: "0 0 12px", fontSize: "13px" }}>
                    Look up both addresses and check that the matched locations are correct.
                  </p>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={handleGeocodeLocations}
                    disabled={geocoding || !orderForm.pickup.trim() || !orderForm.destination.trim()}
                  >
                    {geocoding ? "Finding locations..." : "Verify Pickup & Destination"}
                  </button>

                  {pickupLocation && destinationLocation && (
                    <div style={{ marginTop: "14px", display: "grid", gap: "12px" }}>
                      <div>
                        <strong>Pickup match</strong>
                        <p style={{ margin: "4px 0" }}>{pickupLocation.matched_address}</p>
                        <small>
                          Coordinates: {pickupLocation.latitude}, {pickupLocation.longitude}
                        </small>
                      </div>
                      <div>
                        <strong>Destination match</strong>
                        <p style={{ margin: "4px 0" }}>{destinationLocation.matched_address}</p>
                        <small>
                          Coordinates: {destinationLocation.latitude}, {destinationLocation.longitude}
                        </small>
                      </div>
                      <label style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                        <input
                          type="checkbox"
                          checked={locationsVerified}
                          onChange={(e) => setLocationsVerified(e.target.checked)}
                          style={{ width: "auto", marginTop: "3px" }}
                        />
                        <span>I have checked both matched addresses and confirm they are the intended locations.</span>
                      </label>
                    </div>
                  )}
                  <small style={{ display: "block", marginTop: "10px" }}>
                    Geocoding results can be approximate. Do not confirm a result unless the matched address is correct.
                  </small>
                </div>

                <button
                  className="primary-button"
                  type="submit"
                  disabled={creatingOrder || geocoding || !pickupLocation || !destinationLocation || !locationsVerified}
                >
                  {creatingOrder ? "Creating..." : "Save Order"}
                </button>
              </form>
            )}

            <div className="panel-header">
              <div>
                <h3>All Orders</h3>
                <p>{visibleOrders.length} of {orders.length} order(s) · use Assess for capacity-safe dispatch</p>
              </div>
            </div>
            <div className="order-toolbar">
              <label className="search-field">
                <span>⌕</span>
                <input
                  value={orderSearch}
                  onChange={(e) => setOrderSearch(e.target.value)}
                  placeholder="Search order, customer or destination"
                  aria-label="Search orders"
                />
              </label>
              <select value={orderFilter} onChange={(e) => setOrderFilter(e.target.value)} aria-label="Filter orders by status">
                <option value="All">All statuses</option>
                {ORDER_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
            </div>
            {renderOrdersTable(visibleOrders)}
          </section>
        )}

        {page === "Drivers" && (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h3>Driver Management</h3>
                <p>Manage drivers and their current availability.</p>
              </div>
              <button
                className="primary-button"
                onClick={() => {
                  setMessage("");
                  setError("");
                  setShowDriverForm((v) => !v);
                }}
              >
                {showDriverForm ? "Cancel" : "+ Add Driver"}
              </button>
            </div>

            {showDriverForm && (
              <form className="order-form" onSubmit={handleCreateDriver}>
                <h3>Add New Driver</h3>
                <div className="order-form-grid">
                  <label>Driver Name
                    <input name="name" required maxLength={100}
                      value={driverForm.name} onChange={handleDriverInput}
                      placeholder="Driver full name" />
                  </label>
                  <label>Vehicle
                    <input name="vehicle" required maxLength={100}
                      value={driverForm.vehicle} onChange={handleDriverInput}
                      placeholder="Vehicle type / number" />
                  </label>
                  <label>Status
                    <select name="status" value={driverForm.status} onChange={handleDriverInput}>
                      {["Available", "On Duty", "Off Duty"].map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </label>
                  <label>Deliveries Today
                    <input name="deliveries_today" type="number" min="0" max="1000"
                      required value={driverForm.deliveries_today}
                      onChange={handleDriverInput} />
                  </label>
                  <label>Vehicle Capacity (kg)
                    <input name="capacity_kg" type="number" min="1" max="100000" step="0.1"
                      required value={driverForm.capacity_kg ?? 500}
                      onChange={handleDriverInput} />
                  </label>
                </div>
                <button className="primary-button" type="submit" disabled={creatingDriver}>
                  {creatingDriver ? "Saving..." : "Save Driver"}
                </button>
              </form>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>DRIVER ID</th>
                    <th>NAME</th>
                    <th>VEHICLE</th>
                    <th>STATUS</th>
                    <th>DELIVERIES TODAY</th>
                    <th>CAPACITY</th>
                  </tr>
                </thead>
                <tbody>
                  {drivers.length === 0 ? (
                    <tr><td colSpan="6">{loading ? "Loading drivers..." : "No drivers found."}</td></tr>
                  ) : drivers.map((driver) => (
                    <tr key={driver.id}>
                      <td>#{driver.id}</td>
                      <td>{driver.name}</td>
                      <td>{driver.vehicle}</td>
                      <td><span className={`badge ${statusClass(driver.status)}`}>{driver.status}</span></td>
                      <td>{driver.deliveries_today}</td>
                      <td>
                        <div className="capacity-cell">
                          <strong>{driver.capacity_kg} kg</strong>
                          <span>{intelligence?.driver_load?.find((item) => item.driver_id === driver.id)?.utilization_pct ?? 0}% loaded</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {page === "Routes" && (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h3>Routes & Dispatch</h3>
                <p>Active orders and their assigned drivers.</p>
              </div>
              <span className="badge in-transit">{activeOrders.length} active</span>
            </div>

            <section className="stats-grid route-stats">
              <article className="stat-card">
                <span className="stat-icon">🚚</span>
                <h2>{activeOrders.length}</h2>
                <p>Active Orders</p>
              </article>
              <article className="stat-card">
                <span className="stat-icon">✅</span>
                <h2>{assignedOrders.length}</h2>
                <p>Assigned Orders</p>
              </article>
              <article className="stat-card">
                <span className="stat-icon">⚠️</span>
                <h2>{unassignedOrders.length}</h2>
                <p>Unassigned Orders</p>
              </article>
            </section>
             <RoutePlanner />

            <div className="live-fleet-panel">
              <div className="panel-header">
                <div><h3>Live fleet stream</h3><p>Driver positions update through the authenticated WebSocket feed.</p></div>
                <span className="badge connected"><span className="live-pulse" /> WebSocket</span>
              </div>
              <div className="fleet-map" aria-label="Live fleet position map">
                <div className="map-grid-lines" />
                <span className="map-label map-label-one">DEPOT</span><span className="map-label map-label-two">SERVICE ZONE</span>
                {fleetMapPoints.length ? fleetMapPoints.map((driver) => <div className="map-driver-point" key={driver.driver_id ?? driver.id} style={{ left: `${driver.x}%`, top: `${driver.y}%` }} title={`${driver.name} · ${driver.status}`}><span>{(driver.name || "D").slice(0, 1)}</span><small>{driver.name}</small></div>) : <div className="map-empty"><span>⌁</span><p>Awaiting the first GPS signal from your fleet.</p></div>}
              </div>
              <div className="live-driver-grid">{(liveDrivers.length ? liveDrivers : drivers).map((driver) => <div className="live-driver-card" key={driver.driver_id ?? driver.id}><div className="live-driver-head"><div className="driver-avatar">{(driver.name || "D").slice(0, 1)}</div><div><strong>{driver.name}</strong><p>{driver.vehicle}</p></div><span className={`badge ${statusClass(driver.status)}`}>{driver.status}</span></div><div className="live-driver-meta"><span>⌖ {(driver.latitude ?? driver.current_latitude) ? `${Number(driver.latitude ?? driver.current_latitude).toFixed(4)}, ${Number(driver.longitude ?? driver.current_longitude).toFixed(4)}` : "Awaiting GPS"}</span><span>↯ {driver.speed_kph ?? 0} km/h</span></div></div>)}</div>
            </div>
             
            <div className="panel-header">
              <div>
                <h3>Active Dispatches</h3>
                <p>Assign drivers from the Orders page.</p>
              </div>
              <button className="link-button" onClick={() => setPage("Orders")}>
                Manage orders →
              </button>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ORDER</th>
                    <th>PICKUP</th>
                    <th>DESTINATION</th>
                    <th>DRIVER</th>
                    <th>VEHICLE</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {activeOrders.length === 0 ? (
                    <tr><td colSpan="6">{loading ? "Loading routes..." : "No active orders."}</td></tr>
                  ) : activeOrders.map((order) => {
                    const driver = drivers.find((d) => d.id === order.driver_id);
                    return (
                      <tr key={order.id}>
                        <td className="order-id">#{order.order_number}</td>
                        <td>{order.pickup}</td>
                        <td>{order.destination}</td>
                        <td>{driver?.name ?? "Unassigned"}</td>
                        <td>{driver?.vehicle ?? "—"}</td>
                        <td><span className={`badge ${statusClass(order.status)}`}>{order.status}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="demo-note">
               Route records use saved order and driver data. Live positions arrive through the authenticated fleet stream when a driver app sends GPS points.
            </p>
          </section>
        )}

        {page === "Analytics" && (
          <section className="panel">
            <div className="panel-header">
              <div>
                <h3>Operations Analytics</h3>
                <p>Performance summaries calculated from current database records.</p>
              </div>
              <span className="badge connected">Live database</span>
            </div>

            <section className="stats-grid">
              <article className="stat-card">
                <span className="stat-icon">📦</span>
                <h2>{orders.length}</h2>
                <p>Total Orders</p>
              </article>
              <article className="stat-card">
                <span className="stat-icon">✅</span>
                <h2>{orders.filter((o) => o.status === "Delivered").length}</h2>
                <p>Delivered Orders</p>
              </article>
              <article className="stat-card">
                <span className="stat-icon">🚛</span>
                <h2>{drivers.length}</h2>
                <p>Total Drivers</p>
              </article>
              <article className="stat-card">
                <span className="stat-icon">🧭</span>
                <h2>{orders.length ? Math.round((assignedOrders.length / Math.max(activeOrders.length, 1)) * 100) : 0}%</h2>
                <p>Active Order Assignment Rate</p>
              </article>
            </section>

            <section className="content-grid">
              <article className="panel analytics-panel">
                <div className="panel-header">
                  <div>
                    <h3>Orders by Status</h3>
                    <p>Distribution across delivery stages</p>
                  </div>
                </div>
                {renderProgressList(statusCounts, orders.length)}
              </article>

              <article className="panel analytics-panel">
                <div className="panel-header">
                  <div>
                    <h3>Orders by Priority</h3>
                    <p>Current workload priority breakdown</p>
                  </div>
                </div>
                {renderProgressList(priorityCounts, orders.length)}
              </article>
            </section>

            <section className="content-grid intelligence-grid">
              <article className="panel analytics-panel">
                <div className="panel-header">
                  <div>
                    <h3>Top risk signals</h3>
                    <p>Evidence-backed exceptions from SLA Shield</p>
                  </div>
                  <span className="badge watch">Explainable</span>
                </div>
                <div className="risk-list">
                  {(intelligence?.top_risks || []).length === 0 ? (
                    <p className="empty-state">No active risks detected.</p>
                  ) : intelligence.top_risks.map((risk) => (
                    <button className="risk-row" key={risk.order_id} onClick={() => openDispatchCopilot(orders.find((o) => o.id === risk.order_id) || risk)}>
                      <div className={`risk-score ${risk.risk_level.toLowerCase()}`}>{risk.risk_score}</div>
                      <div className="risk-copy"><strong>#{risk.order_number} · {risk.customer}</strong><p>{risk.reasons.join(" · ")}</p></div>
                      <span className={`badge ${risk.risk_level.toLowerCase()}`}>{risk.risk_level}</span>
                    </button>
                  ))}
                </div>
              </article>
              <article className="panel analytics-panel">
                <div className="panel-header">
                  <div>
                    <h3>Fleet capacity heatmap</h3>
                    <p>Active package weight vs declared vehicle capacity</p>
                  </div>
                  <span className="badge connected">Live</span>
                </div>
                <div className="capacity-list">
                  {(intelligence?.driver_load || []).map((driver) => (
                    <div className="capacity-row" key={driver.driver_id}>
                      <div className="capacity-label"><span>{driver.name}</span><strong>{driver.utilization_pct}%</strong></div>
                      <div className="capacity-track"><span style={{ width: `${Math.max(driver.utilization_pct, 3)}%` }} className={driver.utilization_pct >= 80 ? "hot" : ""} /></div>
                      <small>{driver.active_weight_kg} kg active · {driver.remaining_capacity_kg} kg remaining</small>
                    </div>
                  ))}
                </div>
              </article>
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <h3>Driver Availability</h3>
                  <p>Current status of registered drivers</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>DRIVER</th>
                      <th>VEHICLE</th>
                      <th>STATUS</th>
                      <th>DELIVERIES TODAY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drivers.length === 0 ? (
                      <tr><td colSpan="4">No driver data available.</td></tr>
                    ) : drivers.map((driver) => (
                      <tr key={driver.id}>
                        <td>{driver.name}</td>
                        <td>{driver.vehicle}</td>
                        <td><span className={`badge ${statusClass(driver.status)}`}>{driver.status}</span></td>
                        <td>{driver.deliveries_today}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="demo-note">
                 Analytics combine historical operational records with explainable SLA, capacity, finance and maintenance signals.
              </p>
            </section>
          </section>
        )}

        {page === "Exceptions" && (
          <section className="panel">
            <div className="panel-header"><div><h3>Exception inbox</h3><p>Every issue that needs an operations decision, ranked by urgency.</p></div><span className="badge critical">{exceptions.length} open</span></div>
            <div className="exception-list">{exceptions.length === 0 ? <div className="empty-state large-empty"><span>✓</span><h3>Operations are clear</h3><p>No unresolved SLA, capacity or recovery exceptions.</p></div> : exceptions.map((item) => <article className="exception-card" key={`${item.order_id}-${item.queue}`}><div className={`risk-score ${item.risk_level.toLowerCase()}`}>{item.risk_score}</div><div className="exception-copy"><div className="exception-title"><strong>#{item.order_number} · {item.customer}</strong><span className={`badge ${item.risk_level.toLowerCase()}`}>{item.queue}</span></div><p>{item.reasons.join(" · ")}</p><small>{item.owner_action}</small></div><button className="copilot-button" onClick={() => openDispatchCopilot(orders.find((order) => order.id === item.order_id) || item)}>Open Copilot</button></article>)}</div>
          </section>
        )}

        {page === "Finance" && (
          <section className="panel">
            <div className="panel-header"><div><h3>COD reconciliation</h3><p>Track cash collection and settlement exposure across deliveries.</p></div><span className="badge connected">Finance control</span></div>
            <section className="stats-grid finance-stats"><article className="stat-card"><span className="stat-icon">₹</span><h2>₹{codSummary?.amount_due ?? 0}</h2><p>Amount due</p></article><article className="stat-card"><span className="stat-icon">✓</span><h2>₹{codSummary?.amount_collected ?? 0}</h2><p>Collected</p></article><article className="stat-card"><span className="stat-icon">!</span><h2>₹{codSummary?.outstanding ?? 0}</h2><p>Outstanding</p></article><article className="stat-card"><span className="stat-icon">%</span><h2>{codSummary?.collection_rate_pct ?? 0}%</h2><p>Collection rate</p></article></section>
            <div className="finance-callout"><span>◎</span><div><strong>Settlement safety</strong><p>COD records are audit-logged and tied to an order, so operations and finance share the same source of truth.</p></div></div>
          </section>
        )}

        {page === "Maintenance" && (
          <section className="panel">
            <div className="panel-header"><div><h3>Vehicle health</h3><p>Schedule maintenance before a vehicle becomes an SLA incident.</p></div><span className="badge watch">Preventive</span></div>
            <div className="table-wrap"><table><thead><tr><th>DRIVER ID</th><th>SERVICE</th><th>DUE DATE</th><th>ODOMETER</th><th>STATUS</th><th>NOTES</th></tr></thead><tbody>{maintenance.length === 0 ? <tr><td colSpan="6">No maintenance records scheduled yet.</td></tr> : maintenance.map((item) => <tr key={item.id}><td>#{item.driver_id}</td><td>{item.service_type}</td><td>{item.due_date ? new Date(item.due_date).toLocaleDateString() : "Not set"}</td><td>{item.odometer_km} km</td><td><span className={`badge ${statusClass(item.status)}`}>{item.status}</span></td><td>{item.notes || "—"}</td></tr>)}</tbody></table></div>
            <p className="demo-note">Maintenance records can be created through the authenticated API at POST /maintenance and consumed by a fleet service workflow.</p>
          </section>
        )}

        {podOrder && (
          <div className="modal-backdrop" role="presentation" onClick={() => setPodOrder(null)}>
            <section className="copilot-modal pod-modal" role="dialog" aria-modal="true" aria-label="Proof of delivery" onClick={(e) => e.stopPropagation()}>
              <div className="panel-header"><div><span className="eyebrow">PROOF OF DELIVERY</span><h3>Close #{podOrder.order_number} with trust</h3><p>Capture at least one verified handoff signal.</p></div><button className="icon-button" onClick={() => setPodOrder(null)} aria-label="Close">×</button></div>
              <form className="pod-form" onSubmit={submitProofOfDelivery}><label>Recipient name<input required value={podForm.recipient_name} onChange={(e) => setPodForm({ ...podForm, recipient_name: e.target.value })} placeholder="Who received the package?" /></label><label>Signature name<input value={podForm.signature_name} onChange={(e) => setPodForm({ ...podForm, signature_name: e.target.value })} placeholder="Optional signature reference" /></label><label>Photo URL<input value={podForm.photo_url} onChange={(e) => setPodForm({ ...podForm, photo_url: e.target.value })} placeholder="Optional secure media URL" /></label><label className="pod-check"><input type="checkbox" checked={podForm.otp_verified} onChange={(e) => setPodForm({ ...podForm, otp_verified: e.target.checked })} /> Customer OTP verified</label><label>Notes<textarea value={podForm.notes} onChange={(e) => setPodForm({ ...podForm, notes: e.target.value })} placeholder="Condition, handoff notes or exception" /></label><div className="modal-actions"><button type="button" className="link-button" onClick={() => setPodOrder(null)}>Cancel</button><button className="primary-button" disabled={submittingPod}>{submittingPod ? "Saving proof…" : "Confirm delivery"}</button></div></form>
            </section>
          </div>
        )}

        {copilotOrder && (
          <div className="modal-backdrop" role="presentation" onClick={() => setCopilotOrder(null)}>
            <section className="copilot-modal" role="dialog" aria-modal="true" aria-label="Dispatch Copilot" onClick={(e) => e.stopPropagation()}>
              <div className="panel-header">
                <div><span className="eyebrow">DISPATCH COPILOT</span><h3>Make the next dispatch safer</h3><p>Order #{copilotOrder.order_number} · {copilotOrder.customer}</p></div>
                <button className="icon-button" onClick={() => setCopilotOrder(null)} aria-label="Close">×</button>
              </div>
              {copilotLoading ? <div className="copilot-loading"><span className="loading-orb">✦</span><p>Scoring proximity, capacity and workload…</p></div> : copilotResult && (
                <>
                  <div className="copilot-summary"><div><span className="eyebrow">RECOMMENDED MATCH</span><h2>{copilotResult.recommended_driver?.driver_name || "No eligible driver"}</h2><p>{copilotResult.recommended_driver ? `${copilotResult.recommended_driver.vehicle} · ${copilotResult.recommended_driver.remaining_capacity_after_assignment_kg} kg remaining` : "Review the excluded drivers below."}</p></div><span className="match-score">{copilotResult.recommended_driver ? `${Math.round(copilotResult.recommended_driver.score)}%` : "—"}<small>match</small></span></div>
                  {copilotResult.recommended_driver && <div className="copilot-reasons"><span>Why this match</span><p>{copilotResult.recommended_driver.reasons?.join(" · ") || "Best weighted score across capacity, proximity and workload."}</p></div>}
                  <div className="candidate-list">{(copilotResult.candidates || []).slice(0, 3).map((candidate) => <div className="candidate-row" key={candidate.driver_id}><div><strong>{candidate.driver_name}</strong><p>{candidate.vehicle} · {candidate.remaining_capacity_after_assignment_kg} kg free</p></div><span>{Math.round(candidate.score)}%</span></div>)}</div>
                  <p className="demo-note">Manager approval is required. The recommendation is recalculated against live capacity before assignment.</p>
                  {trackingLink && <div className="tracking-link-box"><span>Customer tracking link</span><a href={trackingLink} target="_blank" rel="noreferrer">{trackingLink}</a></div>}
                  <div className="modal-actions"><button className="link-button" onClick={() => createTrackingShare(copilotOrder.id)}>Create customer link</button><button className="link-button" onClick={() => setCopilotOrder(null)}>Keep reviewing</button>{copilotResult.recommended_driver && <button className="primary-button" onClick={assignCopilotRecommendation} disabled={copilotAssigning}>{copilotAssigning ? "Applying…" : "Approve & assign"}</button>}</div>
                </>
              )}
            </section>
          </div>
        )}

        <footer>
          <span>© 2026 FleetFlow AI</span>
          <span>Intelligent Delivery Operations</span>
        </footer>
      </main>
    </div>
  );
}

function App() {
  const path = window.location.pathname;
  if (path.startsWith("/track/")) {
    return <CustomerPortal token={decodeURIComponent(path.replace("/track/", ""))} />;
  }
  return <OperationsApp />;
}

export default App;
