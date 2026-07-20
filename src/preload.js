const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Instances ──────────────────────────────────────────────
  getInstances:                   ()                        => ipcRenderer.invoke('instances:list'),
  createInstance:                 (name, ver, loader, color, img, ram, res) =>
    ipcRenderer.invoke('instances:create', name, ver, loader, color, img, ram, res),
  createInstanceFromModpack:      (name, ver, loader, projectId, title, icon, verNum) =>
    ipcRenderer.invoke('instances:createFromModpack', name, ver, loader, projectId, title, icon, verNum),
  updateInstance:                 (id, patch)               => ipcRenderer.invoke('instances:update', id, patch),
  deleteInstance:                 (id)                      => ipcRenderer.invoke('instances:delete', id),
  addInstanceContent:             (id, contentKey, item)    => ipcRenderer.invoke('instances:addContent', id, contentKey, item),
  appendInstanceLog:              (id, line)                => ipcRenderer.invoke('instances:appendLog', id, line),
  markInstanceLaunched:           (id)                      => ipcRenderer.invoke('instances:markLaunched', id),
  markInstanceStopped:            (id)                      => ipcRenderer.invoke('instances:markStopped', id),

  // ── Content Download ────────────────────────────────────────
  downloadContentFile:            (instanceId, contentKey, fileUrl, fileName) =>
    ipcRenderer.invoke('content:download', instanceId, contentKey, fileUrl, fileName),
  removeContentFile:              (instanceId, contentKey, fileName) =>
    ipcRenderer.invoke('content:remove', instanceId, contentKey, fileName),

  // ── Modpack Install ────────────────────────────────────────
  installModpack:                 (mrpackUrl, projectId, title, icon, gameVersion, loaderRaw) =>
    ipcRenderer.invoke('modpack:install', mrpackUrl, projectId, title, icon, gameVersion, loaderRaw),

  // ── Launch ─────────────────────────────────────────────────
  launchInstance:                 (id)                      => ipcRenderer.invoke('launch:start', id),
  stopInstance:                   (id)                      => ipcRenderer.invoke('launch:stop', id),

  // ── App ───────────────────────────────────────────────────
  quitApp:                        ()                        => ipcRenderer.invoke('app:quit'),
  getVersion:                     ()                        => ipcRenderer.invoke('app:getVersion'),

  // ── Fabric Loader ─────────────────────────────────────────
  resolveFabricVersion:           (mcVersion, loaderVersion)=> ipcRenderer.invoke('fabric:resolveVersion', mcVersion, loaderVersion),

  // ── Quilt Loader ─────────────────────────────────────────
  resolveQuiltVersion:            (mcVersion, loaderVersion)=> ipcRenderer.invoke('quilt:resolveVersion', mcVersion, loaderVersion),

  // ── NeoForge Loader ──────────────────────────────────────
  resolveNeoForgeVersion:         (mcVersion, neoForgeVersion)=> ipcRenderer.invoke('neoforge:resolveVersion', mcVersion, neoForgeVersion),

  // ── Forge Loader ─────────────────────────────────────────
  resolveForgeVersion:            (mcVersion, forgeVersion) => ipcRenderer.invoke('forge:resolveVersion', mcVersion, forgeVersion),

  // ── Launch events (main → renderer push) ───────────────────
  onLaunchProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('launch:progress', handler);
    return () => ipcRenderer.removeListener('launch:progress', handler);
  },
  onLaunchLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('launch:log', handler);
    return () => ipcRenderer.removeListener('launch:log', handler);
  },
  onLaunchState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('launch:state', handler);
    return () => ipcRenderer.removeListener('launch:state', handler);
  },

  // ── Accounts ───────────────────────────────────────────────
  getAccounts:                    ()                        => ipcRenderer.invoke('accounts:list'),
  getActiveAccount:               ()                        => ipcRenderer.invoke('accounts:getActive'),
  setActiveAccount:               (id)                      => ipcRenderer.invoke('accounts:setActive', id),
  addAccount:                     (name)                    => ipcRenderer.invoke('accounts:add', name),
  updateAccount:                  (id, patch)               => ipcRenderer.invoke('accounts:update', id, patch),
  removeAccount:                  (id)                      => ipcRenderer.invoke('accounts:remove', id),

  // ── Settings ───────────────────────────────────────────────
  getSettings:                    ()                        => ipcRenderer.invoke('settings:get'),
  updateSettings:                 (patch)                   => ipcRenderer.invoke('settings:update', patch),

  // ── Java Management ────────────────────────────────────────
  detectJava:                     (mcVersion)               => ipcRenderer.invoke('java:detect', mcVersion),
  getJavaInfo:                    (javaPath)                => ipcRenderer.invoke('java:getInfo', javaPath),
  downloadJava:                   (mcVersion)               => ipcRenderer.invoke('java:download', mcVersion),
    browseJava:                     ()                        => ipcRenderer.invoke('java:browse'),
    browseDirectory:                ()                        => ipcRenderer.invoke('browse:directory'),

  // ── Skin Presets ───────────────────────────────────────────
    listSkins:                      ()                        => ipcRenderer.invoke('skins:list'),
    getSkinImage:                   (filename)                => ipcRenderer.invoke('skins:getImage', filename),
    copySkin:                       (base64Data, name)        => ipcRenderer.invoke('skins:copy', base64Data, name)
});
