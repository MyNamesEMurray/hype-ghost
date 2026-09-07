import { app, BrowserWindow, Tray, Menu, shell, clipboard, nativeImage, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { POINTER_FILE, dataFilePaths, migrateDataFiles, resolveDataDir, setDataDir } from '../src/storage.js';
import { FileLog } from '../src/logfile.js';
import { UpdateSkip } from '../src/updateskip.js';

// Resource posture: this app shares a machine with OBS and a game. Software
// rendering is plenty for our simple UI and keeps VRAM/GPU cycles for the
// stream; below-normal CPU priority means we never steal from the encoder.
app.disableHardwareAcceleration();
try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {}

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..');
const SMOKE = Boolean(process.env.HG_SMOKE); // CI/smoke mode: no UI, auto-quit

// Required for Windows notifications/toasts to render at all.
app.setAppUserModelId('com.hypeghost.app');

// Only one Hype Ghost at a time — a second launch hands focus to the first
// instance instead of starting a rival. NOTE: app.quit() is asynchronous, so
// losing the lock must also gate the whenReady() block below — otherwise the
// doomed second instance still boots a server into the occupied port and
// flashes a "port already in use" error before its quit lands.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Fired in the FIRST instance when a second launch is attempted: restore
  // from minimized, recreate from tray mode, and bring to the foreground.
  app.on('second-instance', () => {
    if (win && !win.isDestroyed() && win.isMinimized()) win.restore();
    showWindow();
  });
}

// Installed app: data lives in %APPDATA%/Hype Ghost (writable, survives
// updates) — unless a storage.json pointer there redirects everything to a
// user-chosen folder (Settings → About → Storage). The pointer always stays
// in the default dir so it can be found before anything else is known.
// Dev (npm start): the project folder, so hacking on it stays simple.
const defaultDataDir = app.isPackaged ? app.getPath('userData') : packageRoot;
const { dir: dataDir, custom: customDataDir } = resolveDataDir(defaultDataDir);
const { configPath, notesPath, sessionPath, profilePath, gameInfoPath, micCheckPath, logPath, skipPath } = dataFilePaths(dataDir);

// A tray-resident app has no visible console — keep a rotating file log next
// to the data for bug reports. Packaged only: dev has a real terminal.
if (app.isPackaged && !SMOKE) new FileLog(logPath).hookConsole();

let win = null;
let tray = null;
let server = null;
let quitting = false;
let updateReady = null; // version string once an update is downloaded
let checkingByHand = false; // a Settings-initiated check ignores the skip marker
let checkUpdatesNow = null; // set on packaged builds; powers Settings → App
let keepRendererAlive = false; // TTS speaks from the renderer, so it must survive close

function installUpdateNow() {
  quitting = true;
  electronUpdater.autoUpdater.quitAndInstall();
}

function ensureConfig() {
  if (existsSync(configPath)) return;
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(path.join(packageRoot, 'config.example.json'), configPath);
}

function createWindow(page = '/') {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    icon: path.join(packageRoot, 'assets', 'icon.png'),
    title: 'Hype Ghost',
    autoHideMenuBar: true,
    show: false,
  });
  win.loadURL(`http://127.0.0.1:${server.port}${page}`);
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
  // Closing goes to the tray; the ghost keeps chatting either way. Unless the
  // renderer must stay alive (TTS), destroy it — a hidden Chromium renderer
  // is ~100MB of RAM this app doesn't need while you're mid-game.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (keepRendererAlive) {
      win.hide();
    } else {
      win.destroy();
      win = null;
    }
  });
}

function showWindow(page) {
  if (win && !win.isDestroyed()) {
    if (page) win.loadURL(`http://127.0.0.1:${server.port}${page}`);
    win.show();
    win.focus();
  } else if (server) {
    createWindow(page || '/');
  }
}

function trayMenu() {
  return Menu.buildFromTemplate([
    ...(updateReady
      ? [
          { label: `Install update (v${updateReady}) and restart`, click: installUpdateNow },
          { type: 'separator' },
        ]
      : []),
    { label: 'Open Dashboard', click: () => showWindow('/') },
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
    { label: 'Settings', click: () => showWindow('/settings') },
    { label: 'Run Setup Wizard', click: () => showWindow('/setup') },
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
  tray.on('double-click', () => showWindow());
}

// Gated on the lock: without this, the losing instance's whenReady still
// fires before its queued app.quit() and boots a second server (see above).
if (gotLock) app.whenReady().then(() => {
  ensureConfig();
  try {
    server = startServer({
      configPath,
      notesPath,
      sessionPath,
      profilePath,
      gameInfoPath,
      micCheckPath,
      publicDir: path.join(packageRoot, 'public'),
      // Settings → About → Storage: shows where the data lives and moves it.
      // Files are copied (originals stay as a fallback), the pointer is
      // rewritten, and the usual relaunch picks up the new location.
      storage: {
        info: () => ({
          dir: dataDir,
          defaultDir: defaultDataDir,
          custom: customDataDir,
          logFile: app.isPackaged ? path.basename(logPath) : null,
        }),
        pickFolder: async () => {
          const parent = win && !win.isDestroyed() ? win : undefined;
          const r = await dialog.showOpenDialog(parent, {
            title: 'Choose the Hype Ghost data folder',
            properties: ['openDirectory', 'createDirectory'],
            defaultPath: dataDir,
          });
          return r.canceled ? null : r.filePaths[0];
        },
        setDir: (dir) => {
          const copied = migrateDataFiles(dataDir, dir ?? defaultDataDir);
          setDataDir(defaultDataDir, dir);
          return copied;
        },
      },
      // Factory reset must also clear the pointer, the active log and
      // update-skip marker, and any stale copies left in the default dir
      // from before a folder move.
      resetPaths: [path.join(defaultDataDir, POINTER_FILE), logPath, skipPath, ...Object.values(dataFilePaths(defaultDataDir))],
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
        const parent = win && !win.isDestroyed() ? win : undefined;
        const r = await dialog.showOpenDialog(parent, {
          title: 'Choose the LocalVocal transcript file',
          properties: ['openFile'],
          filters: [
            { name: 'Transcripts', extensions: ['srt', 'txt'] },
            { name: 'All files', extensions: ['*'] },
          ],
        });
        return r.canceled ? null : r.filePaths[0];
      },
      // Settings → App → "Check for updates". Only a packaged build can update
      // itself, so running from source passes no hook and the button never
      // appears, rather than appearing and failing. checkUpdatesNow is wired
      // below once the updater is configured; until then there is nothing to
      // check, which is the honest answer during the first moments of startup.
      ...(app.isPackaged && !SMOKE
        ? { checkUpdates: () => (checkUpdatesNow ? checkUpdatesNow() : { state: 'starting' }) }
        : {}),
    });
  } catch (err) {
    dialog.showErrorBox('Hype Ghost failed to start', String(err.message || err));
    app.quit();
    return;
  }
  createWindow();
  createTray();

  const appCfg = loadConfig(configPath).config.app;
  keepRendererAlive = appCfg.tts === true; // TTS speaks from the renderer

  // Auto-update from GitHub Releases (configurable: app.autoUpdate in config.json).
  // A tray-resident app rarely quits, so a downloaded update must be actionable:
  // a real dialog (toasts are unreliable) + a tray menu item, not just install-on-quit.
  // The listeners below are wired whenever this is a packaged build, even with
  // automatic updates switched off: "Check for updates" in Settings is an
  // explicit request, and it would be useless if finding an update led nowhere.
  // Only the check at launch is what `app.autoUpdate` turns off.
  const autoUpdateEnabled = appCfg.autoUpdate !== false;
  if (app.isPackaged && !SMOKE) {
    const { autoUpdater } = electronUpdater;
    // "Skip this update" memory: a skipped version (or older) is never even
    // downloaded again — the user is asked only when something strictly newer
    // is out. Once we're running at/past the skipped version, the marker has
    // no meaning left and is dropped.
    const updateSkip = new UpdateSkip(skipPath);
    updateSkip.clearIfNotNewer(app.getVersion());

    // Update channel (Settings → App). "auto" follows whichever build is
    // running, which is exactly the previous behaviour: a stable install reads
    // latest.yml, a beta build reads beta.yml.
    //
    // The explicit "stable" option exists because leaving the beta channel is
    // otherwise a one-way door. A stable release publishes only latest.yml, so
    // beta.yml goes on advertising the last beta and a tester is never offered
    // the real release. Coming home is also a version *decrease*
    // (3.8.0-beta.5 → 3.7.0), so without allowDowngrade the escape hatch would
    // silently do nothing — and that flag is scoped to exactly this case so a
    // normal install can never be walked backwards.
    const running = app.getVersion();
    const onPrerelease = running.includes('-');
    const setting = ['stable', 'beta'].includes(appCfg.updateChannel) ? appCfg.updateChannel : 'auto';
    const wantsBeta = setting === 'beta' || (setting === 'auto' && onPrerelease);
    autoUpdater.allowPrerelease = wantsBeta;
    autoUpdater.channel = wantsBeta ? 'beta' : 'latest';
    autoUpdater.allowDowngrade = setting === 'stable' && onPrerelease;
    console.log(`[update] running v${running}; channel "${setting}" → ${wantsBeta ? 'beta' : 'stable'} builds`);

    autoUpdater.autoDownload = false; // decide *before* pulling ~80MB
    autoUpdater.on('update-available', (info) => {
      // A skipped version stays skipped for automatic checks only. Asking for a
      // check by hand is asking about that version too, so the marker (there is
      // only ever one) is dropped rather than silently swallowing the answer.
      if (checkingByHand) updateSkip.clear();
      if (updateSkip.isSkipped(info.version)) {
        console.log(`[update] v${info.version} is out, but you skipped it — staying quiet until something newer.`);
        return;
      }
      autoUpdater.downloadUpdate().catch((err) => console.warn('[update] download failed:', err.message));
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateReady = info.version;
      if (tray) tray.setContextMenu(trayMenu());
      const visible = win && !win.isDestroyed() && win.isVisible();
      const choice = dialog.showMessageBoxSync(visible ? win : undefined, {
        type: 'info',
        buttons: ['Restart now', 'Later', 'Skip this update'],
        defaultId: 0,
        cancelId: 1, // Esc = Later, the do-nothing-destructive default
        title: 'Update ready',
        message: `Hype Ghost v${info.version} is ready to install.`,
        detail: 'Restart to apply it now, install later from the tray menu (or on your way out) — or skip this version and only get asked again when a newer one is released.',
      });
      if (choice === 0) {
        installUpdateNow();
      } else if (choice === 2) {
        updateSkip.skip(info.version);
        updateReady = null; // no tray install item for a version they declined
        autoUpdater.autoInstallOnAppQuit = false; // and no surprise install on quit
        if (tray) tray.setContextMenu(trayMenu());
        console.log(`[update] v${info.version} skipped — you'll be asked again for the next release.`);
      }
    });
    if (autoUpdateEnabled) {
      autoUpdater.checkForUpdates().catch((err) => console.warn('[update] check failed:', err.message));
    } else {
      console.log('[update] automatic checks are off — Settings → App → Check for updates still works.');
    }

    // Settings → App → "Check for updates". Reports what happened rather than
    // going quiet: on a tray app an unanswered button is indistinguishable from
    // a broken one. The download and the restart prompt are the same path the
    // automatic check uses, so there is one update flow, not two.
    checkUpdatesNow = async () => {
      if (updateReady) return { state: 'downloaded', version: updateReady };
      checkingByHand = true;
      try {
        const result = await autoUpdater.checkForUpdates();
        const found = result?.updateInfo?.version;
        // isUpdateAvailable is authoritative where electron-updater provides
        // it; the version comparison is the fallback, never the other way
        // round, since a channel switch can legitimately offer an older build.
        const available = result?.isUpdateAvailable ?? Boolean(found && found !== app.getVersion());
        if (!available) return { state: 'current', version: app.getVersion() };
        return { state: 'downloading', version: found };
      } finally {
        checkingByHand = false;
      }
    };
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
