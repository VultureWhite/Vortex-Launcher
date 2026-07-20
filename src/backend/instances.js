/**
 * instances.js — Minecraft instance management.
 *
 * Each instance is an isolated game environment with its own version,
 * mod loader, mods, resource packs, shader packs, saves, and settings.
 */

const { readJSON, writeJSON } = require('./store');
const fs = require('fs').promises;
const path = require('path');

const FILE = 'instances.json';

let instances = [];

function genId() {
  return 'inst_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'instance';
}

async function init() {
  instances = await readJSON(FILE, []);

  // Sync with filesystem: detect instance folders that exist on disk
  // but aren't tracked in instances.json (e.g. after reinstall or manual copy)
  try {
    const os = require('os');
    const settings = require('./settings');
    const s = settings.get();
    const baseDir = (s && s.gameDir) || path.join(os.homedir(), 'vortex-launcher');
    const instancesDir = path.join(baseDir, 'instances');
    const dirs = await fs.readdir(instancesDir, { withFileTypes: true }).catch(() => []);
    const existingSlugs = new Set(instances.map(i => slugify(i.name)));
    let added = false;

    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const folderSlug = d.name;
      if (existingSlugs.has(folderSlug)) continue;

      // Infer name from folder slug (e.g. "my-modpack" → "My Modpack")
      const inferredName = folderSlug
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .slice(0, 32);

      instances.push({
        id: genId(),
        name: inferredName,
        version: 'Unknown',
        loader: 'Unknown',
        iconColor: '#4fd889',
        iconImage: null,
        lastPlayed: null,
        totalPlaytime: 0,
        launchCount: 0,
        mods: [],
        resourcepacks: [],
        shaderpacks: [],
        datapacks: [],
        saves: [],
        logs: [],
        settings: { ram: 4, resolution: '1920 × 1080' }
      });
      existingSlugs.add(folderSlug);
      added = true;
    }

    if (added) await save();
  } catch { /* best effort */ }
}

async function save() {
  await writeJSON(FILE, instances);
}

function list() {
  return instances;
}

function getById(id) {
  return instances.find(i => i.id === id) || null;
}

async function create(name, version, loader, iconColor, iconImage, ram, resolution) {
  const inst = {
    id: genId(),
    name: name.slice(0, 32),
    version,
    loader: loader || 'Vanilla',
    iconColor: iconColor || '#4fd889',
    iconImage: iconImage || null,
    lastPlayed: null,
    totalPlaytime: 0,
    launchCount: 0,
    mods: [],
    resourcepacks: [],
    shaderpacks: [],
    datapacks: [],
    saves: [],
    logs: [],
    settings: {
      ram: ram || 4,
      resolution: resolution || '1920 × 1080'
    }
  };
  instances.push(inst);
  await save();
  return inst;
}

async function createFromModpack(name, version, loader, projectId, title, icon, versionNumber) {
  const inst = await create(name, version, loader, null, icon);
  inst.mods.push({
    projectId,
    title,
    icon: icon || null,
    version: versionNumber || 'latest',
    kind: 'modpack'
  });
  await save();
  return inst;
}

async function update(id, patch) {
  const inst = getById(id);
  if (!inst) return null;

  // Handle nested settings merge
  if (patch.settings) {
    inst.settings = { ...inst.settings, ...patch.settings };
    delete patch.settings;
  }

  Object.assign(inst, patch);
  await save();
  return inst;
}

async function deleteInstance(id) {
  const idx = instances.findIndex(i => i.id === id);
  if (idx === -1) return false;
  const inst = instances[idx];

  // Delete instance directory from disk
  try {
    const home = require('os').homedir();
    const settings = require('./settings');
    const s = settings.get();
    const baseDir = (s && s.gameDir) || path.join(home, 'vortex-launcher');
    const slug = inst.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'instance';
    const instanceDir = path.join(baseDir, 'instances', slug);
    await fs.rm(instanceDir, { recursive: true, force: true });
  } catch { /* best effort */ }

  instances.splice(idx, 1);
  await save();
  return true;
}

async function addContent(id, contentKey, item) {
  const inst = getById(id);
  if (!inst) return null;
  if (!Array.isArray(inst[contentKey])) return null;

  // Deduplicate by projectId
  if (item.projectId && inst[contentKey].some(m => m.projectId === item.projectId)) {
    return inst;
  }

  inst[contentKey].push(item);
  await save();
  return inst;
}

async function appendLog(id, line) {
  const inst = getById(id);
  if (!inst) return null;
  const ts = new Date().toLocaleTimeString();
  inst.logs.push(`[${ts}] ${line}`);
  // Keep last 500 lines
  if (inst.logs.length > 500) {
    inst.logs = inst.logs.slice(-500);
  }
  await save();
  return inst;
}

async function markLaunched(id) {
  const inst = getById(id);
  if (!inst) return null;
  inst.lastPlayed = Date.now();
  inst.launchCount = (inst.launchCount || 0) + 1;
  inst._launchStart = Date.now();
  await save();
  return inst;
}

async function markStopped(id) {
  const inst = getById(id);
  if (!inst) return null;
  if (inst._launchStart) {
    inst.totalPlaytime = (inst.totalPlaytime || 0) + (Date.now() - inst._launchStart);
    delete inst._launchStart;
  }
  await save();
  return inst;
}

module.exports = { init, list, getById, create, createFromModpack, update, delete: deleteInstance, addContent, appendLog, markLaunched, markStopped };
