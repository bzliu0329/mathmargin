const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

app.setName("MathMargin");

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#f8f7f2",
    show: false,
    autoHideMenuBar: true,
    title: "MathMargin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.loadFile(path.join(__dirname, "..", "desktop-dist", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
