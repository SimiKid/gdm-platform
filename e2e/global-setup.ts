const TARGETS = [
  ["participant app", process.env.E2E_PARTICIPANT_URL ?? "http://localhost:3000"],
  [
    "session-manager API",
    `${process.env.E2E_SESSION_MANAGER_URL ?? "http://localhost:3001/api"}/conditions`,
  ],
  ["admin dashboard", process.env.E2E_ADMIN_URL ?? "http://localhost:3003"],
] as const;

/** Fail fast with instructions instead of timing out selector by selector. */
export default async function globalSetup(): Promise<void> {
  for (const [name, url] of TARGETS) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new Error(
        `The ${name} is not reachable at ${url} (${String(err)}).\n` +
          `Start the local stack first: ./infra/start.sh (docker compose), ` +
          `then re-run pnpm test:e2e.`,
      );
    }
  }
}
