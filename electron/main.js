import { app, BrowserWindow, Tray, Menu, shell, clipboard, nativeImage, dialog } from 'electron';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');
const SMOKE = Boolean(process.env.HG_SMOKE); // CI/smoke mode: no UI, auto-quit

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
      label: 'Run Setup Wizard',
      click: () => {
        win.loadURL(`http://127.0.0.1:${server.port}/setup`);
        win.show();
        win.focus();
      },
    },
    { label: 'Edit Config', click: () => shell.openPath(configPath) },
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
    });
  } catch (err) {
    dialog.showErrorBox('Hype Ghost failed to start', String(err.message || err));
    app.quit();
    return;
  }
  createWindow();
  createTray();

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
