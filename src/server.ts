#!/usr/bin/env node
import { loadServerConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { Hub } from "./hub.js";
import { createHttpServer } from "./http.js";

const cfg = loadServerConfig();
const hub = new Hub(openDatabase(cfg.dbPath), cfg.hub);
hub.cleanup();

const server = createHttpServer(hub, cfg);
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
