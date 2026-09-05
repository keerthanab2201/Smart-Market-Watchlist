/**
 * Server lifecycle hook: starts the shared market-data scheduler once per
 * server process. It runs without visitors on its 60s cadence.
 *
 * Deployment requirement: single instance with a persistent disk for .data/.
 * Multiple instances would each run their own scheduler against separate
 * SQLite files; that topology needs PostgreSQL instead (schema maps 1:1).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureScheduler } = await import("./lib/shared");
    ensureScheduler();
  }
}
