/**
 * accounts.js — Offline account management.
 *
 * Future: Microsoft authentication flow, token refresh, skin fetching.
 */

const { readJSON, writeJSON } = require('./store');

const FILE = 'accounts.json';

let data = { accounts: [], activeAccountId: null };

const AVATAR_COLORS = ['#c4863a', '#e3ad6f', '#6fa3c9', '#8fc98f', '#c98f8f', '#a98fc9'];

function genId() {
  return 'acc_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

async function init() {
  data = await readJSON(FILE, { accounts: [], activeAccountId: null });
  if (!data.accounts.length) {
    // Seed with a default offline account
    const id = genId();
    data.accounts.push({ id, name: 'Steve', color: '#c4863a' });
    data.activeAccountId = id;
    await save();
  }
  if (!data.activeAccountId && data.accounts.length) {
    data.activeAccountId = data.accounts[0].id;
    await save();
  }
}

async function save() {
  await writeJSON(FILE, data);
}

function list() {
  return data.accounts;
}

function getActive() {
  return data.accounts.find(a => a.id === data.activeAccountId) || data.accounts[0] || null;
}

async function setActive(id) {
  if (data.accounts.some(a => a.id === id)) {
    data.activeAccountId = id;
    await save();
  }
  return getActive();
}

async function add(name) {
  const color = AVATAR_COLORS[data.accounts.length % AVATAR_COLORS.length];
  const acc = { id: genId(), name, color };
  data.accounts.push(acc);
  if (!data.activeAccountId) data.activeAccountId = acc.id;
  await save();
  return acc;
}

async function update(id, patch) {
  const acc = data.accounts.find(a => a.id === id);
  if (!acc) return null;
  Object.assign(acc, patch);
  await save();
  return acc;
}

async function remove(id) {
  const idx = data.accounts.findIndex(a => a.id === id);
  if (idx === -1) return { removed: false };
  if (data.accounts.length <= 1) return { removed: false };
  data.accounts.splice(idx, 1);
  if (data.activeAccountId === id) {
    data.activeAccountId = data.accounts[0].id;
  }
  await save();
  return { removed: true };
}

module.exports = { init, list, getActive, setActive, add, update, remove };
