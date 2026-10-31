import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

export default function CustomerPortal({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const response = await api.get(`/tracking/public/${token}`);
      setData(response.data);
      setError("");
    } catch (err) {
      setError(err.response?.data?.detail || "This tracking link is no longer available.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 15000);
    return () => window.clearInterval(timer);
  }, [token]);

  const progress = useMemo(() => {
    const states = ["Pending", "Dispatched", "In Transit", "In Progress", "Delivered"];
    const index = Math.max(states.indexOf(data?.order?.status), 0);
    return ((index + 1) / states.length) * 100;
  }, [data]);

  if (loading) return <main className="tracking-shell"><div className="tracking-card tracking-loading"><span className="loading-orb">✦</span><p>Loading live delivery status…</p></div></main>;
  if (error) return <main className="tracking-shell"><div className="tracking-card tracking-error"><div className="brand-logo">F</div><h1>Tracking unavailable</h1><p>{error}</p></div></main>;

  const order = data.order;
  return <main className="tracking-shell">
    <div className="tracking-topbar"><div className="auth-brand"><div className="brand-logo">F</div><div><strong>FleetFlow</strong><span>Customer delivery tracking</span></div></div><span className="tracking-live"><i /> Live updates</span></div>
    <section className="tracking-card tracking-main-card">
      <div className="tracking-heading"><div><span className="eyebrow">SHIPMENT {order.order_number}</span><h1>Your delivery is {order.status.toLowerCase()}.</h1><p>We refresh this page automatically as your shipment moves.</p></div><span className={`badge ${order.status.toLowerCase().replaceAll(" ", "-")}`}>{order.status}</span></div>
      <div className="tracking-progress"><div style={{ width: `${progress}%` }} /><div className="tracking-nodes"><span className="done" /><span className={progress >= 40 ? "done" : ""} /><span className={progress >= 60 ? "done" : ""} /><span className={progress >= 80 ? "done" : ""} /><span className={progress >= 100 ? "done" : ""} /></div></div>
      <div className="tracking-route"><div><span>FROM</span><strong>{order.pickup}</strong></div><div className="route-arrow">→</div><div><span>TO</span><strong>{order.destination}</strong></div></div>
      <div className="tracking-detail-grid"><div><span>Estimated arrival</span><strong>{order.eta}</strong></div><div><span>Priority</span><strong>{order.priority}</strong></div><div><span>Customer</span><strong>{order.customer}</strong></div></div>
    </section>
    <section className="tracking-columns"><div className="tracking-card"><div className="panel-header"><div><h3>Delivery timeline</h3><p>Verified events from the operations system</p></div></div><div className="tracking-timeline">{(data.events || []).map((event) => <div className="tracking-event" key={event.id}><span className="timeline-dot" /><div><strong>{event.title}</strong><p>{event.detail}</p><small>{new Date(event.created_at).toLocaleString()}</small></div></div>)}{!data.events?.length && <p className="muted-cell">Your delivery timeline will appear here.</p>}</div></div><div className="tracking-card"><div className="panel-header"><div><h3>Driver handoff</h3><p>Only safe operational details are shared</p></div></div>{data.driver ? <div className="tracking-driver"><div className="tracking-driver-avatar">{data.driver.name.slice(0, 1)}</div><div><strong>{data.driver.name}</strong><p>{data.driver.vehicle} · {data.driver.status}</p><span className="tracking-safe">● Verified fleet partner</span></div></div> : <div className="tracking-empty"><span>⌁</span><p>Your shipment is waiting for dispatch. Driver details will appear once assigned.</p></div>}</div></section>
    <p className="tracking-footer">Powered by FleetFlow · Link expires {new Date(data.expires_at).toLocaleDateString()}</p>
  </main>;
}
