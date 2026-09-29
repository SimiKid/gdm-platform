/** Local frontends (Vite dev servers and preview containers). */
const DEFAULT_DEV_CORS_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3003",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3003",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

/**
 * Development CORS allowlist from comma-separated `CORS_ORIGINS`. An unset,
 * empty or blank value (compose passes `${CORS_ORIGINS:-}`) means the local
 * defaults, never "no origins".
 */
export function corsOrigins(value = process.env.CORS_ORIGINS): string[] {
  if (!value?.trim()) return [...DEFAULT_DEV_CORS_ORIGINS];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
