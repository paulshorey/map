/**
 * Environment for the detached processes ingestion starts.
 *
 * `node --watch` sets WATCH_REPORT_DEPENDENCIES in its child's environment, and every
 * process that inherits it reports each module it loads to its parent over IPC. A launcher
 * started under a watched process (a dev server, an agent session) passes the variable on;
 * the detached supervisor it spawns keeps an IPC channel only for its startup handshake,
 * so once the launcher exits, the next lazily loaded module makes Node send on a closed
 * channel and the supervisor dies with ERR_IPC_CHANNEL_CLOSED, after the import itself has
 * finished, leaving the job recorded as running with no result.
 */
export function childEnv(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.WATCH_REPORT_DEPENDENCIES;
  return env;
}
