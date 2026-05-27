'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT_DIR    = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'Neural', 'config.json');
const BACKUP_PATH = path.join(os.tmpdir(), 'jarvis-test-config-backup.json');

module.exports = async function globalTeardown() {
  try {
    const original = fs.readFileSync(BACKUP_PATH, 'utf8');
    fs.writeFileSync(CONFIG_PATH, original);
    fs.unlinkSync(BACKUP_PATH);
    console.log('[teardown] config.json restored');
  } catch (e) {
    console.warn('[teardown] could not restore config:', e.message);
  }
};
