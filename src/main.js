const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;

// Ensure userData uses vortex-launcher folder consistently
app.setPath('userData', path.join(app.getPath('appData'), 'vortex-launcher'));
const instances = require('./backend/instances');
const accounts = require('./backend/accounts');
const settings = require('./backend/settings');
const launcherModule = require('./backend/launcher');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0c10',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'launcher.html'));

  launcherModule.setMainWindowRef(mainWindow);

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// Instances
ipcMain.handle('instances:list', () => instances.list());
ipcMain.handle('instances:create', (_e, name, version, loader, iconColor, iconImage, ram, resolution) =>
  instances.create(name, version, loader, iconColor, iconImage, ram, resolution));
ipcMain.handle('instances:createFromModpack', (_e, name, version, loader, projectId, title, icon, versionNumber) =>
  instances.createFromModpack(name, version, loader, projectId, title, icon, versionNumber));
ipcMain.handle('instances:update', (_e, id, patch) => instances.update(id, patch));
ipcMain.handle('instances:delete', (_e, id) => instances.delete(id));
ipcMain.handle('instances:addContent', (_e, id, contentKey, item) =>
  instances.addContent(id, contentKey, item));
ipcMain.handle('instances:appendLog', (_e, id, line) => instances.appendLog(id, line));
ipcMain.handle('instances:markLaunched', (_e, id) => instances.markLaunched(id));
ipcMain.handle('instances:markStopped', (_e, id) => instances.markStopped(id));

// Content download
ipcMain.handle('content:download', async (_e, instanceId, contentKey, fileUrl, fileName) => {
  try {
    return await launcherModule.downloadContentFile(instanceId, contentKey, fileUrl, fileName);
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('content:remove', async (_e, instanceId, contentKey, fileName) => {
  try {
    return await launcherModule.removeContentFile(instanceId, contentKey, fileName);
  } catch (err) {
    return { error: err.message };
  }
});

// Modpack install
ipcMain.handle('modpack:install', async (_e, mrpackUrl, projectId, title, icon, gameVersion, loaderRaw) => {
  const sendLog = (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('launch:log', { instanceId: 'modpack', line });
    }
  };
  try {
    return await launcherModule.installModpack(mrpackUrl, projectId, title, icon, gameVersion, loaderRaw, sendLog);
  } catch (err) {
    return { error: err.message };
  }
});

// Launch
ipcMain.handle('launch:start', async (_e, instanceId) => {
  return launcherModule.launch(instanceId, mainWindow);
});
ipcMain.handle('launch:stop', async (_e, instanceId) => {
  return launcherModule.stop(instanceId);
});
ipcMain.handle('app:quit', () => {
  app.quit();
});
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

// Fabric loader
ipcMain.handle('fabric:resolveVersion', async (_e, mcVersion, loaderVersion) => {
  try {
    return await launcherModule.getFabricVersionJSON(mcVersion, loaderVersion || null);
  } catch (err) {
    return { error: err.message };
  }
});

// Quilt loader
ipcMain.handle('quilt:resolveVersion', async (_e, mcVersion, loaderVersion) => {
  try {
    return await launcherModule.getQuiltVersionJSON(mcVersion, loaderVersion || null);
  } catch (err) {
    return { error: err.message };
  }
});

// NeoForge loader
ipcMain.handle('neoforge:resolveVersion', async (_e, mcVersion, neoForgeVersion) => {
  try {
    return await launcherModule.getNeoForgeVersionJSON(mcVersion, neoForgeVersion || null);
  } catch (err) {
    return { error: err.message };
  }
});

// Forge loader
ipcMain.handle('forge:resolveVersion', async (_e, mcVersion, forgeVersion) => {
  try {
    return await launcherModule.getForgeVersionJSON(mcVersion, forgeVersion || null);
  } catch (err) {
    return { error: err.message };
  }
});

// Accounts
ipcMain.handle('accounts:list', () => accounts.list());
ipcMain.handle('accounts:getActive', () => accounts.getActive());
ipcMain.handle('accounts:setActive', (_e, id) => accounts.setActive(id));
ipcMain.handle('accounts:add', (_e, name) => accounts.add(name));
ipcMain.handle('accounts:update', (_e, id, patch) => accounts.update(id, patch));
ipcMain.handle('accounts:remove', (_e, id) => accounts.remove(id));

// Settings
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:update', (_e, patch) => settings.update(patch));

// Java Management
ipcMain.handle('java:detect', async (_e, mcVersion) => {
  return launcherModule.detectJavaInfo(mcVersion || null);
});
ipcMain.handle('java:getInfo', async (_e, javaPath) => {
  return launcherModule.getJavaInfo(javaPath);
});
ipcMain.handle('java:download', async (_e, mcVersion) => {
  try {
    return await launcherModule.downloadJava(mcVersion || null);
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('java:browse', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Java Executable',
    filters: process.platform === 'win32'
      ? [{ name: 'Java Executable', extensions: ['exe'] }]
      : [{ name: 'Java Executable', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
ipcMain.handle('browse:directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Game Directory',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Skin presets — use userData path so skins persist in packaged builds
ipcMain.handle('skins:list', async () => {
  const skinsDir = path.join(app.getPath('userData'), 'skins');
  try {
    const files = await fs.readdir(skinsDir);
    return files.filter(f => f.endsWith('.png')).map(f => ({
      name: f.replace('.png', ''),
      file: f,
      path: path.join(skinsDir, f)
    }));
  } catch { return []; }
});
ipcMain.handle('skins:getImage', async (_e, filename) => {
  const filePath = path.join(app.getPath('userData'), 'skins', filename);
  try {
    const buf = await fs.readFile(filePath);
    return buf.toString('base64');
  } catch { return null; }
});
ipcMain.handle('skins:copy', async (_e, base64Data, name) => {
  const skinsDir = path.join(app.getPath('userData'), 'skins');
  try {
    await fs.mkdir(skinsDir, { recursive: true });
    const filename = (name || 'skin') + '.png';
    const dest = path.join(skinsDir, filename);
    const buf = Buffer.from(base64Data, 'base64');
    await fs.writeFile(dest, buf);
    return filename;
  } catch { return null; }
});

// ── App Lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Copy bundled skins to userData on first run so presets are available
  const bundledSkinsDir = path.join(__dirname, '..', 'assets', 'skins');
  const userSkinsDir = path.join(app.getPath('userData'), 'skins');
  try {
    await fs.mkdir(userSkinsDir, { recursive: true });
    const bundled = await fs.readdir(bundledSkinsDir).catch(() => []);
    const existing = await fs.readdir(userSkinsDir).catch(() => []);
    for (const file of bundled) {
      if (!file.endsWith('.png')) continue;
      if (!existing.includes(file)) {
        const src = path.join(bundledSkinsDir, file);
        const dst = path.join(userSkinsDir, file);
        await fs.copyFile(src, dst);
      }
    }
  } catch {}

  await settings.init();
  await instances.init();
  await accounts.init();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
