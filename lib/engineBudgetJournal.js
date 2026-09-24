'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

// Use the SAME retained directory in the producer and recovery worker. Never
// put this in a public/static directory. Files contain only sanitized ledger
// fields (hashed identities, timestamps, usage), never provider payloads.
const defaultDirectory = () => process.env.ENGINE_SPEND_OUTBOX_DIR || path.resolve(__dirname, '../.engine-spend-outbox');
const validName = name => /^[a-f0-9-]{36}\.json$/.test(name);

function createSpendJournal({directory = defaultDirectory()} = {}) {
  async function syncDirectory() {
    const dir = await fs.open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  return {
    async append(payload) {
      await fs.mkdir(directory, {recursive: true, mode: 0o700});
      const name = `${randomUUID()}.json`, temporary = path.join(directory, `${name}.tmp`);
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({journalVersion: 1, ...payload}));
        await file.sync();
      } finally { await file.close(); }
      await fs.rename(temporary, path.join(directory, name));
      await syncDirectory();
      return name;
    },
    async list(after = '', limit = 25) {
      try { return (await fs.readdir(directory)).filter(name => validName(name) && name > after).sort().slice(0, limit); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    async read(name) {
      if (!validName(name)) throw new Error('invalid_journal_name');
      const value = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (value.journalVersion !== 1 || !value.seed || !value.event) throw new Error('invalid_journal_record');
      return value;
    },
    async remove(name) {
      if (!validName(name)) throw new Error('invalid_journal_name');
      try { await fs.unlink(path.join(directory, name)); await syncDirectory(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

module.exports = {createSpendJournal};
