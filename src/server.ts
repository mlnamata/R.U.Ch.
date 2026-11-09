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
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Port ${cfg.port} už je obsazený – hub tu nejspíš už běží. Jiný port: RUCH_PORT=4318.`);
    process.exit(0);
  }
  throw e;
});
server.listen(cfg.port, cfg.host, () => {
  const url = cfg.publicUrl ?? `http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}`;
  console.log(`R.U.Ch. hub: ${url}  (databáze ${cfg.dbPath})`);
  console.log(`  Nová místnost: otevři ${url} v prohlížeči, nebo agent: node .ruch/ruch.mjs new --name <Jméno> --hub ${url}`);
  if (cfg.hub.projectRoot) console.log(`  Důkazy ze souborů ověřuji v ${cfg.hub.projectRoot}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
