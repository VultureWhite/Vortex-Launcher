/**
 * store.js — Simple JSON file-backed data store.
 *
 * Each module gets its own file under <userData>/data/.
 * Reads/writes are atomic enough for single-user desktop use.
 */

const fs = require('fs').promises;
const path = require('path');

let DATA_DIR;
try {
  const { app } = require('electron');
  DATA_DIR = path.join(app.getPath('userData'), 'data');
} catch {
  DATA_DIR = path.join(__dirname, '..', 'data');
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJSON(filename, fallback) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    const raw = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJSON(filename, data) {
  await ensureDir();
  const filepath = path.join(DATA_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
}

module.exports = { readJSON, writeJSON, DATA_DIR };
