const { app, BrowserWindow, dialog } = require("electron");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

let backendProcess = null;
let frontendProcess = null;
let mainWindow = null;
let backendPort = null;
let frontendPort = null;
let backendLogPath = null;
let frontendLogPath = null;

function getDesktopResourceRoot() {
  if (!app.isPackaged) {
    return path.join(__dirname, "resources");
  }

  const nestedResourceRoot = path.join(process.resourcesPath, "resources");
  if (fs.existsSync(nestedResourceRoot)) {
    return nestedResourceRoot;
  }

  return process.resourcesPath;
}

function getEngineRootForDev() {
  return path.resolve(__dirname, "..");
}

function getBackendExecutablePath() {
  const root = getDesktopResourceRoot();
  const base = path.join(root, "backend", process.platform === "win32" ? "gms-backend.exe" : "gms-backend");
  return base;
}

function getFrontendServerPath() {
  return path.join(getDesktopResourceRoot(), "frontend", "standalone", "server.js");
}

function createLogFilePath(prefix) {
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(logDir, `${prefix}-${timestamp}.log`);
}

function pipeChildOutputToFile(child, logFilePath, label) {
  const sink = fs.createWriteStream(logFilePath, { flags: "a" });
  sink.write(`[${new Date().toISOString()}] ${label} started\n`);

  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      sink.write(chunk);
    });
  }

  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      sink.write(chunk);
    });
  }

  child.once("error", (error) => {
    sink.write(`\n[${new Date().toISOString()}] ${label} spawn error: ${String(error)}\n`);
  });

  child.once("exit", (code, signal) => {
    sink.write(`\n[${new Date().toISOString()}] ${label} exited (code=${String(code)}, signal=${String(signal)})\n`);
    sink.end();
  });
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

function waitForChildAndUrl(child, label, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onError = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      settleReject(new Error(`${label} failed to start: ${message}`));
    };

    const onExit = (code, signal) => {
      settleReject(
        new Error(`${label} exited before ready (code=${String(code)}, signal=${String(signal)})`),
      );
    };

    child.once("error", onError);
    child.once("exit", onExit);

    waitForUrl(url, timeoutMs)
      .then(() => {
        settleResolve();
      })
      .catch((error) => {
        settleReject(error);
      });
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

function parseMajorMinor(versionText) {
  const match = /^(\d+)\.(\d+)$/.exec(versionText.trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function isSupportedPythonVersion(versionText) {
  const parsed = parseMajorMinor(versionText);
  if (!parsed) {
    return false;
  }

  return parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 10);
}

function getPythonVersion(bin) {
  const result = spawnSync(bin, ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], {
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
}

function resolvePythonBin() {
  const explicitPython = (process.env.PYTHON_BIN || "").trim();

  if (explicitPython) {
    const version = getPythonVersion(explicitPython);
    if (!version) {
      throw new Error(
        [
          `PYTHON_BIN is set to '${explicitPython}', but it could not be executed.`,
          "Set PYTHON_BIN to a valid Python 3.10+ interpreter.",
        ].join("\n"),
      );
    }

    if (!isSupportedPythonVersion(version)) {
      throw new Error(
        [
          `PYTHON_BIN points to Python ${version}.`,
          "Backend dev mode requires Python 3.10+.",
          "Use a newer interpreter, for example: PYTHON_BIN=python3.10 npm run start",
        ].join("\n"),
      );
    }

    return explicitPython;
  }

  const engineRoot = getEngineRootForDev();
  const condaPython = process.env.CONDA_PREFIX
    ? path.join(process.env.CONDA_PREFIX, "bin", "python")
    : null;
  const localCandidates = [
    condaPython,
    path.join(engineRoot, "backend", "env", "bin", "python"),
    path.join(engineRoot, "backend", ".env", "bin", "python"),
    path.join(engineRoot, "backend", ".venv", "bin", "python"),
    path.join(engineRoot, ".env", "bin", "python"),
    path.join(engineRoot, ".venv", "bin", "python"),
  ];

  for (const candidate of localCandidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const version = getPythonVersion(candidate);
    if (version && isSupportedPythonVersion(version)) {
      return candidate;
    }
  }

  const candidates = ["python3.13", "python3.12", "python3.11", "python3.10", "python", "python3"];

  for (const candidate of candidates) {
    const version = getPythonVersion(candidate);
    if (version && isSupportedPythonVersion(version)) {
      return candidate;
    }
  }

  throw new Error(
    [
      "No Python 3.10+ interpreter found for backend dev startup.",
      "Set PYTHON_BIN to your Python 3.10+ executable and retry.",
      "Example: PYTHON_BIN=python3.10 npm run start",
    ].join("\n"),
  );
}

async function startBackend() {
  backendPort = await pickFreePort();

  const sharedEnv = {
    ...process.env,
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(backendPort),
  };

  if (app.isPackaged) {
    const executablePath = getBackendExecutablePath();
    ensureExecutableExists(executablePath);
    backendLogPath = createLogFilePath("backend");

    backendProcess = spawn(executablePath, [], {
      cwd: path.dirname(executablePath),
      env: sharedEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });

    pipeChildOutputToFile(backendProcess, backendLogPath, "backend");
  } else {
    const pythonBin = resolvePythonBin();
    const engineRoot = getEngineRootForDev();

    backendProcess = spawn(
      pythonBin,
      ["-m", "backend", "--serve-api", "--host", "127.0.0.1", "--port", String(backendPort)],
      {
        cwd: engineRoot,
        env: sharedEnv,
        stdio: "inherit",
        windowsHide: true,
        detached: false,
      },
    );
  }

  try {
    await waitForChildAndUrl(backendProcess, "Backend", `http://127.0.0.1:${backendPort}/health`, 60000);
  } catch (error) {
    if (app.isPackaged && backendLogPath) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nBackend log: ${backendLogPath}`);
    }
    throw error;
  }
}

async function startFrontend() {
  const frontendServerPath = getFrontendServerPath();
  ensureFrontendExists(frontendServerPath);

  frontendPort = await pickFreePort();
  const apiBase = `http://127.0.0.1:${backendPort}`;

  if (app.isPackaged) {
    frontendLogPath = createLogFilePath("frontend");
  }

  frontendProcess = spawn(process.execPath, [frontendServerPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: "127.0.0.1",
      PORT: String(frontendPort),
      NEXT_PUBLIC_ENGINE_API_BASE: apiBase,
    },
    stdio: app.isPackaged ? ["ignore", "pipe", "pipe"] : "ignore",
    windowsHide: true,
    detached: false,
  });

  if (app.isPackaged && frontendLogPath) {
    pipeChildOutputToFile(frontendProcess, frontendLogPath, "frontend");
  }

  await waitForChildAndUrl(frontendProcess, "Frontend", `http://127.0.0.1:${frontendPort}`, 60000);
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
  const iconCandidates = [
    path.join(__dirname, "assets", "icon.png"),
    path.join(__dirname, "assets", "logo.png"),
  ];
  const icon = iconCandidates.find((candidate) => fs.existsSync(candidate));

  if (process.platform === "darwin" && app.dock && icon) {
    app.dock.setIcon(icon);
  }

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
