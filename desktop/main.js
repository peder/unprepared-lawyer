// Electron shell — Windows exe for Steam distribution.
// Dev: `npm run dev:client` + `npm run electron:dev`. Dist: `npm run dist:win`.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

let hub = null;

function startHub() {
  // In packaged builds the server is bundled alongside; in dev, assume `npm run dev:server`.
  if (app.isPackaged) {
    hub = spawn(process.execPath, [path.join(process.resourcesPath, "server-index.js")], { stdio: "inherit" });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "UNPREPARED LAWYER",
    backgroundColor: "#0c0f0a",
    webPreferences: { contextIsolation: true },
  });
  const dev = !app.isPackaged;
  win.loadURL(dev ? "http://localhost:5173" : `file://${path.join(__dirname, "../client/dist/index.html")}`);
}

app.whenReady().then(() => {
  startHub();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (hub) hub.kill();
  if (process.platform !== "darwin") app.quit();
});
