#!/usr/bin/env node
// node:sqlite prints an "experimental" warning on import; it is stable enough for us, so keep logs clean.
process.removeAllListeners("warning");
const { loadServerConfig } = await import("./config.js");
const { openDatabase } = await import("./db.js");
const { Hub } = await import("./hub.js");
const { createHttpServer } = await import("./http.js");

const cfg = loadServerConfig();
const hub = new Hub(openDatabase(cfg.dbPath), cfg.hub);
hub.cleanup();

const server = createHttpServer(hub, cfg);
// Daily consistent backups (keeps the newest 7) when RUCH_BACKUP_DIR is set.
if (cfg.backupDir) {
  const backup = () => {
    try {
      console.log(`Backup: ${hub.backup(cfg.backupDir!)}`);
    } catch (e) {
      console.error("Backup failed:", e);
    }
  };
  setTimeout(backup, 60_000).unref();
  setInterval(backup, 24 * 3_600_000).unref();
}

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Port ${cfg.port} is already in use – a hub is probably running already. Other port: RUCH_PORT=4318.`);
    process.exit(0);
  }
  throw e;
});
server.listen(cfg.port, cfg.host, () => {
  const url = cfg.publicUrl ?? `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`;
  console.log(`R.U.Ch. hub: ${url}  (database ${cfg.dbPath})`);
  console.log(`  New room: open ${url} in a browser, or an agent runs: node .ruch/ruch.mjs new --name <Name> --hub ${url}`);
  if (cfg.hub.projectRoot) console.log(`  Verifying file evidence in ${cfg.hub.projectRoot}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
