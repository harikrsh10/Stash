// src/history-store.js — history that survives a restart.
//
// History used to live in memory and die with the process, which made the one
// moment a clipboard manager exists for -- "it still has it" -- impossible past
// a quit. This is the log behind it.
//
// It is an append-only NDJSON file rather than a database on purpose. Every
// capture is a single line appended to the end, so the cost of a copy does not
// grow with the size of the history; rewriting a whole JSON array on every
// copy, the way the pinned store does, would. Electron 31 runs Node 20, which
// has no built-in sqlite, and a native module would put electron-rebuild in
// front of the mac notarisation step for a gain this does not need.
//
// Deliberately free of any electron import so it can be unit-tested under
// plain node, and so the storage can be swapped later without the rest of the
// app knowing.

const fs = require('fs');
const path = require('path');

// Fields that describe this run rather than the clip, and must not be written.
// `dataUrl` is the thumbnail: tens of kilobytes of base64 per image, which
// would dwarf everything else in the log. It is regenerated from the file on
// load instead.
const VOLATILE = ['_new', '_promoted', 'dataUrl'];

function serialize(entry) {
  const copy = { ...entry };
  VOLATILE.forEach(k => delete copy[k]);
  return copy;
}

function createHistoryStore({ filePath, limit = 10000, enabled = true } = {}) {
  // Every live clip, keyed by id, in the order the log last saw it. A Map keeps
  // insertion order, which is all the ordering the replay below needs.
  let entries = new Map();
  // How many lines are on disk. Compare against the live count to know when
  // the log has accumulated enough dead weight to be worth rewriting.
  let lines = 0;
  let ready = false;

  function append(record) {
    if (!enabled || !filePath || !ready) return;
    try {
      fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
      lines += 1;
    } catch (err) {
      console.error('[Stash] failed to append to history log:', err);
    }
  }

  // Replay the log into the live set. Later records win, so a clip copied
  // again simply appears twice and the second one is the survivor -- there is
  // no need to rewrite the earlier line at the time it happens.
  function replay(raw) {
    const live = new Map();
    let count = 0;
    raw.split('\n').forEach(line => {
      if (!line.trim()) return;
      count += 1;
      let rec;
      // One torn line -- a half-written record from a process killed mid-append
      // -- must not cost the user the whole history, so a parse failure skips
      // that line and nothing else.
      try { rec = JSON.parse(line); } catch (_) { return; }
      if (!rec || typeof rec !== 'object') return;
      if (rec.op === 'add' && rec.e && rec.e.id) {
        live.delete(rec.e.id);
        live.set(rec.e.id, rec.e);
      } else if (rec.op === 'del' && rec.id) {
        live.delete(rec.id);
      } else if (rec.op === 'clear') {
        live.clear();
      }
    });
    lines = count;
    return live;
  }

  return {
    get path() { return filePath; },
    get enabled() { return enabled; },

    // Read the log back. Returns the clips newest first, and separately the
    // ones the cap pushed out, whose image files the caller still owns and
    // needs to unlink.
    load() {
      ready = true;
      entries = new Map();
      if (!enabled || !filePath) return { entries: [], evicted: [] };
      let raw = '';
      try {
        if (!fs.existsSync(filePath)) return { entries: [], evicted: [] };
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        console.error('[Stash] failed to read history log:', err);
        return { entries: [], evicted: [] };
      }

      const live = replay(raw);
      // Newest first, the order the drawer shows. Ties fall back to how
      // recently the log saw them, so a restored history matches what was on
      // screen before the quit.
      const ordered = [...live.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const kept = ordered.slice(0, limit);
      const evicted = ordered.slice(limit);

      entries = new Map(kept.map(e => [e.id, e]));
      // A log that shrank below what is on disk has dead lines in it. Fold
      // them away now, while startup is already touching the file, rather than
      // during a copy.
      if (evicted.length || lines > kept.length * 2 + 500) this.compact();
      return { entries: kept, evicted };
    },

    // A clip that is already held moves to the front rather than being stored
    // twice, which is what a re-copy means everywhere else in the app.
    add(entry) {
      if (!entry || !entry.id) return;
      entries.delete(entry.id);
      entries.set(entry.id, entry);
      append({ op: 'add', e: serialize(entry) });
    },

    remove(id) {
      if (!id || !entries.has(id)) return false;
      entries.delete(id);
      append({ op: 'del', id });
      return true;
    },

    clear() {
      entries = new Map();
      if (!enabled || !filePath || !ready) return;
      // A clear is the one moment where leaving the old lines on disk would be
      // wrong: the user asked for the content to be gone, and a tombstone in
      // front of it does not make it gone.
      try {
        fs.writeFileSync(filePath, '', 'utf8');
        lines = 0;
      } catch (err) {
        console.error('[Stash] failed to clear history log:', err);
      }
    },

    // Rewrite the log as one line per live clip, dropping every superseded and
    // tombstoned record.
    compact() {
      if (!enabled || !filePath) return;
      try {
        const body = [...entries.values()]
          .map(e => JSON.stringify({ op: 'add', e: serialize(e) }))
          .join('\n');
        fs.writeFileSync(filePath, body ? body + '\n' : '', 'utf8');
        lines = entries.size;
      } catch (err) {
        console.error('[Stash] failed to compact history log:', err);
      }
    },

    // For tests and the stats nobody has asked for yet.
    get size() { return entries.size; },
    get lineCount() { return lines; },
  };
}

module.exports = { createHistoryStore, serialize, VOLATILE };
