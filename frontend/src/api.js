import axios from "axios";

export const API = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";

export const api = axios.create({
  baseURL: API,
  timeout: 20000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("fleetflow_access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export function clearSession() {
  localStorage.removeItem("fleetflow_access_token");
  localStorage.removeItem("fleetflow_user");
}
