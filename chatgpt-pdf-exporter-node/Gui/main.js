const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");

let mainWindow = null;
let exporterProcess = null;

const ROOT = path.join(__dirname, "..");
const EXPORTER_SCRIPT = path.join(ROOT, "run_fresh_export_select_page.js");
const OUTPUT_DIR = path.join(ROOT, "output");

function sendLog(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("exporter:log", String(text || ""));
  }
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("exporter:status", status);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    title: "ChatGPT PDF Exporter",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (exporterProcess) {
    exporterProcess.kill();
    exporterProcess = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle("exporter:start", async () => {
  if (exporterProcess) {
    return { ok: false, message: "Exporter is already running." };
  }

  if (!fs.existsSync(EXPORTER_SCRIPT)) {
    return {
      ok: false,
      message: "Cannot find run_fresh_export_select_page.js. Please put gui/ folder inside chatgpt-pdf-exporter-node."
    };
  }

  sendStatus("running");
  sendLog("\n========================================\n");
  sendLog("Starting ChatGPT PDF Exporter GUI...\n");
  sendLog("Working directory: " + ROOT + "\n");
  sendLog("Script: " + EXPORTER_SCRIPT + "\n");
  sendLog("========================================\n\n");

  exporterProcess = childProcess.spawn(
    "node",
    [EXPORTER_SCRIPT],
    {
      cwd: ROOT,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  exporterProcess.stdout.on("data", chunk => {
    sendLog(chunk.toString("utf8"));
  });

  exporterProcess.stderr.on("data", chunk => {
    sendLog(chunk.toString("utf8"));
  });

  exporterProcess.on("error", err => {
    sendLog("\n[ERROR] " + err.message + "\n");
    exporterProcess = null;
    sendStatus("stopped");
  });

  exporterProcess.on("close", code => {
    sendLog("\n========================================\n");
    sendLog("Exporter process exited with code: " + code + "\n");
    sendLog("========================================\n");
    exporterProcess = null;
    sendStatus("stopped");
  });

  return { ok: true };
});

ipcMain.handle("exporter:send-input", async (_event, input) => {
  if (!exporterProcess || !exporterProcess.stdin) {
    return { ok: false, message: "Exporter is not running." };
  }

  exporterProcess.stdin.write(String(input || "") + "\r\n");
  return { ok: true };
});

ipcMain.handle("exporter:stop", async () => {
  if (!exporterProcess) {
    return { ok: false, message: "Exporter is not running." };
  }

  exporterProcess.kill();
  exporterProcess = null;
  sendStatus("stopped");
  sendLog("\n[INFO] Exporter stopped by user.\n");
  return { ok: true };
});

ipcMain.handle("output:open", async () => {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  await shell.openPath(OUTPUT_DIR);
  return { ok: true };
});

ipcMain.handle("dialog:show-error", async (_event, message) => {
  dialog.showErrorBox("ChatGPT PDF Exporter", String(message || "Unknown error"));
});
