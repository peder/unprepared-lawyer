// Minimal state hub: serves client build + WebSocket event relay for TrialEngine.
// The engine itself runs in-process; Steam/Electron build loads this same server.
import { createServer } from "http";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PORT = Number(process.env.PORT ?? 4123);
const here = dirname(fileURLToPath(import.meta.url));

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, game: "unprepared-lawyer", v: "0.1.0" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, hint: "WS trial channel coming in milestone 2; run scripts/sim.ts for headless trial." }));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[unprepared-lawyer] hub on http://localhost:${PORT} (dir=${here}, client=${join(here, "..", "client", "dist")})`);
  void readFile;
});
