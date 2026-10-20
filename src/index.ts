import { createBmwContainer } from "./composition/container.js";

const container = createBmwContainer();
await container.objectStorage.ensureBucket();
const server = container.app.listen(container.config.PORT, container.config.HOST, () => console.log(`bmw-reader listening on http://${container.config.HOST}:${container.config.PORT}`));
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ event: "api_shutdown_started", signal }));
  server.close(async error => {
    if (error) console.error(JSON.stringify({ event: "api_server_close_failed", signal, error: error.message }));
    try { await container.close(); }
    catch (closeError) { console.error(JSON.stringify({ event: "api_dependencies_close_failed", error: closeError instanceof Error ? closeError.message : String(closeError) })); }
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
