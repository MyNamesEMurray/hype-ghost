import { app, BrowserWindow, Tray, Menu, shell, clipboard, nativeImage, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');
const SMOKE = Boolean(process.env.HG_SMOKE); // CI/smoke mode: no UI, auto-quit

// Required for Windows notifications/toasts to render at all.
app.setAppUserModelId('com.hypeghost.app');

// Only one Hype Ghost at a time — a second launch just shows the existing window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

// Installed app: config lives in %APPDATA%/Hype Ghost (writable, survives updates).
// Dev (npm start): use the project folder so hacking on it stays simple.
const dataDir = app.isPackaged ? app.getPath('userData') : packageRoot;
const configPath = path.join(dataDir, 'config.json');
const notesPath = path.join(dataDir, 'session-notes.txt');

let win = null;
let tray = null;
let server = null;
let quitting = false;
let updateReady = null; // version string once an update is downloaded

function installUpdateNow() {
  quitting = true;
  electronUpdater.autoUpdater.quitAndInstall();
}

function ensureConfig() {
  if (existsSync(configPath)) return;
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(path.join(packageRoot, 'config.example.json'), configPath);
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 720,
    icon: path.join(packageRoot, 'assets', 'icon.png'),
    title: 'Hype Ghost',
    autoHideMenuBar: true,
    show: false,
  });
  win.loadURL(`http://127.0.0.1:${server.port}/`);
  // External links (console.anthropic.com, dev.twitch.tv, …) open in the
  // user's real browser — never in a chrome-less Electron window where they
  // can't verify the URL they're typing credentials into.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${server.port}/`) && !url.startsWith(`http://localhost:${server.port}/`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.once('ready-to-show', () => {
    if (!SMOKE) win.show();
  });
  // Closing the window hides to tray; the ghost keeps chatting.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function trayMenu() {
  return Menu.buildFromTemplate([
    ...(updateReady
      ? [
          { label: `Install update (v${updateReady}) and restart`, click: installUpdateNow },
          { type: 'separator' },
        ]
      : []),
    { label: 'Open Dashboard', click: () => { win.show(); win.focus(); } },
    {
      label: 'Copy Overlay URL (for OBS)',
      click: () => clipboard.writeText(`http://localhost:${server.port}/overlay`),
    },
    { type: 'separator' },
    {
      label: 'Pause Ghost',
      type: 'checkbox',
      checked: server.isPaused(),
      click: (item) => {
        if (item.checked) server.pause();
        else server.resume();
        tray.setContextMenu(trayMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        win.loadURL(`http://127.0.0.1:${server.port}/settings`);
        win.show();
        win.focus();
      },
    },
    {
      label: 'Run Setup Wizard',
      click: () => {
        win.loadURL(`http://127.0.0.1:${server.port}/setup`);
        win.show();
        win.focus();
      },
    },
    { label: 'Edit Config (raw JSON)', click: () => shell.openPath(configPath) },
    { label: 'Open Config Folder', click: () => shell.showItemInFolder(configPath) },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit Hype Ghost', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(packageRoot, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Hype Ghost — AI practice chat (simulated viewer)');
  tray.setContextMenu(trayMenu());
  tray.on('double-click', () => { win.show(); win.focus(); });
}

app.whenReady().then(() => {
  ensureConfig();
  try {
    server = startServer({
      configPath,
      notesPath,
      publicDir: path.join(packageRoot, 'public'),
      // The setup wizard saved a new config — restart the whole app to apply it.
      onConfigSaved: () => {
        quitting = true;
        app.relaunch();
        app.exit(0);
      },
      // Keep the tray's "Pause Ghost" checkbox in sync when pause is toggled
      // from the dashboard (or by the auto-pause dead-man switch).
      onPauseChanged: () => {
        if (tray) tray.setContextMenu(trayMenu());
      },
      // Async server failures (e.g. port already in use) get a friendly
      // dialog instead of Electron's raw uncaught-exception box.
      onFatal: (err) => {
        dialog.showErrorBox('Hype Ghost failed to start', err.message);
        quitting = true;
        app.exit(1);
      },
      // Settings page "Browse…" → native file dialog (full path, which the
      // browser's own <input type=file> can't provide).
      pickFile: async () => {
        const r = await dialog.showOpenDialog(win, {
          title: 'Choose the LocalVocal transcript file',
          properties: ['openFile'],
          filters: [
            { name: 'Transcripts', extensions: ['srt', 'txt'] },
            { name: 'All files', extensions: ['*'] },
          ],
        });
        return r.canceled ? null : r.filePaths[0];
      },
    });
  } catch (err) {
    dialog.showErrorBox('Hype Ghost failed to start', String(err.message || err));
    app.quit();
    return;
  }
  createWindow();
  createTray();

  // Auto-update from GitHub Releases (configurable: app.autoUpdate in config.json).
  // A tray-resident app rarely quits, so a downloaded update must be actionable:
  // a real dialog (toasts are unreliable) + a tray menu item, not just install-on-quit.
  const autoUpdateEnabled = loadConfig(configPath).config.app.autoUpdate !== false;
  if (app.isPackaged && !SMOKE && autoUpdateEnabled) {
    const { autoUpdater } = electronUpdater;
    autoUpdater.on('update-downloaded', (info) => {
      updateReady = info.version;
      if (tray) tray.setContextMenu(trayMenu());
      const visible = win && win.isVisible();
      const choice = dialog.showMessageBoxSync(visible ? win : undefined, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update ready',
        message: `Hype Ghost v${info.version} is ready to install.`,
        detail: 'Restart to apply it now — or do it later from the tray menu, or just quit whenever (it installs on the way out).',
      });
      if (choice === 0) installUpdateNow();
    });
    autoUpdater.checkForUpdates().catch((err) => console.warn('[update] check failed:', err.message));
  }

  if (SMOKE) {
    // Verify the server responds, then exit with a pass/fail code.
    setTimeout(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/`);
        console.log(`SMOKE: dashboard HTTP ${res.status}`);
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        console.error('SMOKE: failed —', err.message);
        process.exit(1);
      }
    }, 2500);
  }
});

app.on('before-quit', () => {
  quitting = true;
});

// Keep running in the tray even with all windows closed.
app.on('window-all-closed', (e) => {
  e?.preventDefault?.();
});
