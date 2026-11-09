#!/usr/bin/env node
import { loadServerConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { Hub } from "./hub.js";
import { createHttpServer } from "./http.js";

const cfg = loadServerConfig();
const hub = new Hub(openDatabase(cfg.dbPath), cfg.hub);
hub.ensureProject(cfg.defaultProject, { root_path: cfg.projectRoot ?? undefined });

const server = createHttpServer(hub, cfg);
server.listen(cfg.port, cfg.host, () => {
  const url = `http://${cfg.host}:${cfg.port}`;
  console.log(`R.U.Ch. hub běží na ${url}`);
  console.log(`  databáze:  ${cfg.dbPath}`);
  console.log(`  projekt:   ${cfg.defaultProject}${cfg.projectRoot ? ` (kořen ${cfg.projectRoot})` : " (bez kořene – důkazy ze souborů se neověřují)"}`);
  if (cfg.token) console.log("  přístup chráněn tokenem RUCH_TOKEN");
  if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && !cfg.token) {
    console.warn("  POZOR: hub poslouchá mimo localhost bez RUCH_TOKEN – kdokoli v síti může psát za tebe.");
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
