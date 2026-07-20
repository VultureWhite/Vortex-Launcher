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
  javaPath: '',        // legacy — kept for migration
  javaPath17: '',      // Java 17 path (MC < 1.20.5)
  javaPath21: '',      // Java 21 path (MC >= 1.20.5)
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
    // Migrate legacy javaPath → javaPath17/javaPath21 if new fields are empty
    if (saved.javaPath && !data.javaPath17 && !data.javaPath21) {
      data.javaPath17 = saved.javaPath;
      data.javaPath21 = saved.javaPath;
      await save();
    }
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
