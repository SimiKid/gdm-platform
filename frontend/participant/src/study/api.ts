/**
 * Base URL of the Session Manager. Dev: the backend runs on :3001. The
 * container build sets VITE_SESSION_MANAGER_URL=/api so nginx proxies it.
 */
export const API_BASE: string =
  import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
