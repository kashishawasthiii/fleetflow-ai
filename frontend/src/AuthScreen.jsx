import { useEffect, useState } from "react";
import { api } from "./api";

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", full_name: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    api.get("/auth/status").then((response) => {
      if (!response.data.has_accounts) setMode("register");
    }).catch(() => {
      // The form remains usable and the submit request will show the real error.
    });
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await api.post(`/auth/${mode === "login" ? "login" : "register"}`, form);
      localStorage.setItem("fleetflow_access_token", response.data.access_token);
      localStorage.setItem("fleetflow_user", JSON.stringify(response.data.user));
      onAuthenticated(response.data.user);
    } catch (err) {
      setError(err.response?.data?.detail || "Could not connect to FleetFlow authentication.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand"><div className="brand-logo">F</div><div><strong>FleetFlow</strong><span>Operations control tower</span></div></div>
        <div className="auth-copy"><span className="eyebrow">SECURE WORKSPACE</span><h1>{mode === "login" ? "Move every delivery with confidence." : "Create your operations workspace."}</h1><p>Dispatch, monitor and protect customer SLAs from one intelligent logistics workspace.</p></div>
        <form className="auth-form" onSubmit={submit}>
          {mode === "register" && <label>Full name<input required minLength="2" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Your name" /></label>}
          <label>Work email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@company.com" /></label>
          <label>Password
            <span className="password-input-wrap">
              <input required minLength={mode === "register" ? 8 : 1} type={showPassword ? "text" : "password"} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={mode === "register" ? "At least 8 characters" : "Your password"} />
              <button type="button" className="password-toggle" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"}>{showPassword ? "◉" : "◌"}</button>
            </span>
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="primary-button auth-submit" disabled={loading}>{loading ? "Securing workspace…" : mode === "login" ? "Sign in to FleetFlow" : "Create account"}</button>
        </form>
        <button className="auth-switch" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
          {mode === "login" ? "New operations team? Create an account" : "Already have an account? Sign in"}
        </button>
        <p className="auth-footnote">Your operational data stays behind an authenticated API boundary.</p>
      </section>
      <section className="auth-visual"><div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" /><div className="auth-visual-copy"><span className="eyebrow">FLEETFLOW INTELLIGENCE</span><h2>From last-mile chaos to a calm control tower.</h2><div className="auth-mini-grid"><div><strong>01</strong><span>SLA Shield</span></div><div><strong>02</strong><span>Dispatch Copilot</span></div><div><strong>03</strong><span>Live fleet stream</span></div></div></div></section>
    </main>
  );
}
