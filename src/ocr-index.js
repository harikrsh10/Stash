// src/ocr-index.js — reading the text in pictures so it can be searched for.
//
// Searching only what you copied as text misses the thing a clipboard manager
// is uniquely holding: the screenshot of the error, the design spec, the token
// in a terminal window. Those are the clips you cannot copy again, and until
// their text is indexed they are unreachable by anything except scrolling.
//
// The work is expensive -- on Windows every read spawns a PowerShell process --
// so this is a queue of one job at a time with a gap between them, not a
// parallel sweep. Newest first, because the picture you want back is far more
// often the one from ten minutes ago than the one from last month.
//
// The engine is injected rather than imported, so this file has no electron in
// it and can be driven by a test without a real OCR run.

// A screenshot of a page of documentation is a lot of text, and all of it would
// go in the log. This is well past what anyone searches for and still small
// enough not to matter.
const MAX_CHARS = 8000;

// Extracted text goes on disk, so anything that looks like a credential must
// not. `looksSecret` answers for one whitespace-free token, which is exactly
// what splitting on whitespace produces.
function sanitizeOcrText(raw, looksSecret, maxChars = MAX_CHARS) {
  if (!raw) return '';
  const kept = String(raw)
    .split(/(\s+)/)
    .map(part => (/\s/.test(part) ? part : (looksSecret(part) ? '' : part)))
    .join('');
  return kept.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

// Has this picture already been looked at? Either it has text, or it was read
// and had none, or reading it failed and retrying every launch would just burn
// the same CPU for the same nothing.
function needsIndexing(clip) {
  return !!clip
    && clip.type === 'img'
    && !!clip.filepath
    && typeof clip.ocrText !== 'string'
    && !clip.ocrTried;
}

function createOcrIndexer({
  extract,              // (filepath) -> Promise<string>
  onText,               // (clip, text) -> void
  looksSecret = () => false,
  gapMs = 1500,
  maxChars = MAX_CHARS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const pending = [];
  const seen = new Set();
  let timer = null;
  let running = false;
  let stopped = false;

  function schedule(delay) {
    if (stopped || running || timer || !pending.length) return;
    timer = setTimer(() => { timer = null; step(); }, delay);
  }

  async function step() {
    if (stopped || running) return;
    const clip = pending.shift();
    if (!clip) return;
    // It may have been deleted, pinned away or already read since it was queued.
    if (!needsIndexing(clip)) { schedule(0); return; }

    running = true;
    try {
      const raw = await extract(clip.filepath);
      const text = sanitizeOcrText(raw, looksSecret, maxChars);
      clip.ocrText = text;
      onText(clip, text);
    } catch (_) {
      // A picture that cannot be read stays unread rather than being retried
      // for ever. The file may be gone, or the engine may not exist here.
      clip.ocrTried = true;
      onText(clip, null);
    } finally {
      running = false;
      schedule(gapMs);
    }
  }

  return {
    // Newest first: queue order is the order given, and callers hand it
    // history, which is already newest first.
    queue(clips) {
      (Array.isArray(clips) ? clips : [clips]).forEach(c => {
        if (!needsIndexing(c) || seen.has(c.id)) return;
        seen.add(c.id);
        pending.push(c);
      });
      schedule(gapMs);
    },
    // Something just arrived and is the most likely thing to be wanted, so it
    // goes to the front rather than behind a backlog of old pictures.
    queueFirst(clip) {
      if (!needsIndexing(clip) || seen.has(clip.id)) return;
      seen.add(clip.id);
      pending.unshift(clip);
      schedule(gapMs);
    },
    forget(id) { seen.delete(id); },
    stop() {
      stopped = true;
      if (timer) { clearTimer(timer); timer = null; }
      pending.length = 0;
    },
    get size() { return pending.length; },
    get busy() { return running; },
  };
}

module.exports = { createOcrIndexer, sanitizeOcrText, needsIndexing, MAX_CHARS };
