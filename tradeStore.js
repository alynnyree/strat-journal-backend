// Stores raw open legs (waiting for a matching close) and fully-matched
// closed trades that are ready for the user to tag with Strat setup/FTFC
// in the app. Same persistence caveat as tokenStore.js: fine for a small
// personal server with a real disk, not for stateless serverless functions.
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'trades_pending.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    return { openLegs: [], pending: [], lastProcessedIds: [] };
  }
}

function write(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function getState() {
  return read();
}

function saveState(state) {
  write(state);
}

function addPendingTrade(trade) {
  const state = read();
  state.pending.unshift(trade);
  write(state);
}

function removePendingTrade(id) {
  const state = read();
  state.pending = state.pending.filter(t => t.id !== id);
  write(state);
}

module.exports = { getState, saveState, addPendingTrade, removePendingTrade };
