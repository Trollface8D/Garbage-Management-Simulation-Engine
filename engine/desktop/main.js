const { app, BrowserWindow, dialog } = require("electron");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

let backendProcess = null;
let frontendProcess = null;
let mainWindow = null;
let backendPort = null;
let frontendPort = null;

function getDesktopResourceRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "resources");
}

function getBackendExecutablePath() {
  const root = getDesktopResourceRoot();
  const base = path.join(root, "backend", process.platform === "win32" ? "gms-backend.exe" : "gms-backend");
  return base;
}

function getFrontendServerPath() {
  return path.join(getDesktopResourceRoot(), "frontend", "standalone", "server.js");
}

function waitForUrl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 500);
      });

      req.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };

    attempt();
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function ensureExecutableExists(executablePath) {
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      [
        `Backend executable not found: ${executablePath}`,
        "Run packaging first: bash engine/scripts/package-desktop.sh",
      ].join("\n"),
    );
  }
}

function ensureFrontendExists(frontendPath) {
  if (!fs.existsSync(frontendPath)) {
    throw new Error(
      [
        `Frontend standalone server not found: ${frontendPath}`,
        "Run packaging first: bash engine/scripts/package-desktop.sh",
      ].join("\n"),
    );
  }
}

async function startBackend() {
  const executablePath = getBackendExecutablePath();
  ensureExecutableExists(executablePath);

  backendPort = await pickFreePort();

  backendProcess = spawn(executablePath, [], {
    env: {
      ...process.env,
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(backendPort),
    },
    stdio: "ignore",
    windowsHide: true,
    detached: false,
  });

  backendProcess.unref();
  await waitForUrl(`http://127.0.0.1:${backendPort}/health`, 60000);
}

async function startFrontend() {
  const frontendServerPath = getFrontendServerPath();
  ensureFrontendExists(frontendServerPath);

  frontendPort = await pickFreePort();
  const apiBase = `http://127.0.0.1:${backendPort}`;

  frontendProcess = spawn(process.execPath, [frontendServerPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(frontendPort),
      NEXT_PUBLIC_ENGINE_API_BASE: apiBase,
    },
    stdio: "ignore",
    windowsHide: true,
    detached: false,
  });

  frontendProcess.unref();
  await waitForUrl(`http://127.0.0.1:${frontendPort}`, 60000);
}

function stopProcess(child) {
  if (!child || child.killed) {
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  setTimeout(() => {
    if (!child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore hard-kill errors during shutdown.
      }
    }
  }, 3000);
}

function stopServices() {
  stopProcess(frontendProcess);
  stopProcess(backendProcess);
  frontendProcess = null;
  backendProcess = null;
}

function createWindow() {
  const iconPath = path.join(__dirname, "assets", "icon.png");
  const icon = fs.existsSync(iconPath) ? iconPath : undefined;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    icon,
    autoHideMenuBar: true,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${frontendPort}`);
}

async function bootstrap() {
  try {
    await startBackend();
    await startFrontend();
    createWindow();
  } catch (error) {
    stopServices();

    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Desktop startup failed", message);
    app.quit();
  }
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  stopServices();
});
