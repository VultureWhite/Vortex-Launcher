/**
 * settings.js — Global launcher settings.
 */

const { readJSON, writeJSON } = require('./store');

const FILE = 'settings.json';

const DEFAULTS = {
  theme: 'dark',
  defaultRam: 4,
  defaultResolution: '1920 × 1080',
  keepOpenAfterLaunch: false,
  showSnapshots: false,
  javaPath: '',        // empty = auto-detect
  gameDir: '',         // empty = default .minecraft location
  jvmArgs: '',
  width: 854,
  height: 480
};

let data = { ...DEFAULTS };

async function init() {
  const saved = await readJSON(FILE, null);
  if (saved) {
    data = { ...DEFAULTS, ...saved };
  } else {
    await save();
  }
}

async function save() {
  await writeJSON(FILE, data);
}

function get() {
  return { ...data };
}

async function update(patch) {
  Object.assign(data, patch);
  await save();
  return get();
}

module.exports = { init, get, update };
