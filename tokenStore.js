// Simple single-user token store, persisted to disk as JSON.
// Fine for a personal-use backend with one Schwab account.
// If you deploy to a platform with an ephemeral filesystem (most serverless
// functions), swap this for a small hosted KV/Redis instead — the file
// will get wiped on redeploy otherwise.
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'tokens.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function saveTokens({ access_token, refresh_token, expires_in }) {
  const store = readStore();
  store.access_token = access_token;
  store.refresh_token = refresh_token || store.refresh_token;
  store.expires_at = Date.now() + (expires_in * 1000) - 30000; // 30s safety margin
  store.last_transaction_check = store.last_transaction_check || null;
  writeStore(store);
  return store;
}

function getTokens() {
  return readStore();
}

function setLastCheck(iso) {
  const store = readStore();
  store.last_transaction_check = iso;
  writeStore(store);
}

module.exports = { saveTokens, getTokens, setLastCheck };
