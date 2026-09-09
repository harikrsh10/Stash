// Builds src/_harness.html from src/renderer.html by injecting a stub
// window.api (the preload bridge) plus fixture clips, so the drawer can be
// driven in a plain browser for layout and performance work.
//
//   npm run harness     -> writes src/_harness.html
//
// The output is generated and gitignored; regenerate it after changing
// renderer.html. Serve it with scripts/harness-server.js.

const fs = require('fs');
const path = require('path');
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const SRC_DIR = path.join(__dirname, '..', 'src');
const IN = path.join(SRC_DIR, 'renderer.html');
const OUT = path.join(SRC_DIR, '_harness.html');
const src = fs.readFileSync(IN, 'utf8').split(CR + LF).join(LF);

const STUB = `
  <script>
    // Harness only. Stands in for the preload bridge so the drawer can be
    // driven in a plain browser for layout and performance work.
    (function () {
      // The preview pane reports the tab as hidden even when it is on screen,
      // and the app closes the inspector whenever the document goes hidden so
      // the OS window shrinks back. Harness only.
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });

      function svg(body, w, h) {
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' + body + '</svg>');
      }
      const shotLight = svg(
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#2f7fd4"/><stop offset="100%" stop-color="#cfe6fa"/>' +
        '</linearGradient></defs>' +
        '<rect width="520" height="300" fill="url(#g)"/>' +
        '<rect x="150" y="18" width="220" height="20" rx="10" fill="#ffffff" opacity="0.85"/>' +
        '<text x="260" y="120" font-family="sans-serif" font-size="30" font-weight="700" ' +
        'fill="#ffffff" text-anchor="middle">Place for your</text>' +
        '<text x="260" y="156" font-family="sans-serif" font-size="30" font-weight="700" ' +
        'fill="#ffffff" text-anchor="middle">tickets, booking</text>' +
        '<rect x="90" y="185" width="120" height="60" rx="8" fill="#ffffff"/>' +
        '<rect x="220" y="178" width="90" height="74" rx="8" fill="#101014"/>' +
        '<rect x="320" y="185" width="110" height="60" rx="8" fill="#ffffff"/>', 520, 300);
      const shotDark = svg(
        '<rect width="520" height="300" fill="#141416"/>' +
        '<rect x="240" y="150" width="40" height="130" fill="#e2481c"/>' +
        '<text x="260" y="52" font-family="sans-serif" font-size="24" font-weight="800" ' +
        'fill="#ffffff" text-anchor="middle">AI FRAMEWORK</text>' +
        '<text x="260" y="80" font-family="sans-serif" font-size="24" font-weight="800" ' +
        'fill="#ffffff" text-anchor="middle">TO TAKE YOU</text>' +
        '<text x="360" y="180" font-family="sans-serif" font-size="22" font-weight="700" ' +
        'fill="#ffffff">10X</text>' +
        '<text x="120" y="215" font-family="sans-serif" font-size="22" font-weight="700" ' +
        'fill="#ffffff">50+</text>', 520, 300);
      const shotUi = svg(
        '<rect width="520" height="300" fill="#f2f4f8"/>' +
        '<rect x="0" y="0" width="520" height="44" fill="#ffffff"/>' +
        '<rect x="16" y="16" width="90" height="12" rx="6" fill="#c7ccd6"/>' +
        '<rect x="24" y="70" width="200" height="16" rx="4" fill="#20242c"/>' +
        '<rect x="24" y="100" width="330" height="10" rx="5" fill="#aeb5c1"/>' +
        '<rect x="24" y="120" width="290" height="10" rx="5" fill="#aeb5c1"/>' +
        '<rect x="24" y="160" width="140" height="34" rx="8" fill="#2f6df6"/>', 520, 300);

      const now = Date.now();
      const clips = [
        { id: 'c1', type: 'text', content: 'the nav spacing feels tight at 1440', ts: now - 2000 },
        { id: 'c2', type: 'code', content: 'startDrag({ files, icon })', ts: now - 60000 },
        { id: 'c2b', type: 'text', content: '#3B82F6' + String.fromCharCode(10) + '#EF4444' + String.fromCharCode(10) + '#10B981', ts: now - 90000 },
        { id: 'c3', type: 'url', content: 'app.paper.design/file/young-bridge', ts: now - 240000 },
        { id: 'c4', type: 'img', content: 'image', meta: '520x300', dataUrl: shotLight, ts: now - 720000 },
        { id: 'c5', type: 'img', content: 'image', meta: '520x300', dataUrl: shotDark, ts: now - 725000 },
        { id: 'c6', type: 'img', content: 'image', meta: '520x300', dataUrl: shotUi, ts: now - 730000 },
      ];

      const overrides = {
        getHistory: async () => ({
          history: clips, pinned: [], sessionClips: [], activeSessionId: 'ses1',
          sessions: [
            { id: 'ses1', name: 'Redesign', createdAt: 1 },
            { id: 'ses2', name: 'Stash Import', createdAt: 2 },
            { id: 'ses3', name: 'stash', createdAt: 3 },
          ],
        }),
        ocr: async () => ({
          ok: true, imageUrl: shotLight, width: 520, height: 300,
          blocks: [
            { text: 'Place for your tickets, booking and documents', bbox: { x0: 118, y0: 52, x1: 402, y1: 132 } },
            { text: 'Everything related to travelling stored in one place.', bbox: { x0: 150, y0: 196, x1: 372, y1: 242 } },
            { text: 'Download for iOS', bbox: { x0: 196, y0: 250, x1: 326, y1: 276 } },
          ],
        }),
        palette: async () => ({
          ok: true, imageUrl: shotLight, width: 520, height: 300,
          colors: [{ hex: '#2F7FD4', rgb: [47,127,212], share: 0.31, light: false },{ hex: '#CFE6FA', rgb: [207,230,250], share: 0.22, light: true },{ hex: '#101014', rgb: [16,16,20], share: 0.14, light: false },{ hex: '#FFFFFF', rgb: [255,255,255], share: 0.11, light: true },{ hex: '#E2481C', rgb: [226,72,28], share: 0.08, light: false },{ hex: '#FCC419', rgb: [252,196,25], share: 0.05, light: true },{ hex: '#12B886', rgb: [18,184,134], share: 0.04, light: false },{ hex: '#7048E8', rgb: [112,72,232], share: 0.03, light: false },{ hex: '#868E96', rgb: [134,142,150], share: 0.02, light: false },{ hex: '#FFD8A8', rgb: [255,216,168], share: 0.01, light: true }],
        }),
        getPaused: async () => false,
        getSettings: async () => ({}),
        getAppearance: async () => ({ choice: 'light' }),
        getUpdateState: async () => ({ state: 'idle' }),
      };

      window.api = new Proxy({}, {
        get(_t, k) {
          if (overrides[k]) return overrides[k];
          if (typeof k === 'string' && k.indexOf('on') === 0) return function () {};
          return async function () { return null; };
        },
      });
    })();
  </script>
`;

let src2 = src.replace('</title>', '</title>' + String.fromCharCode(10) + '  <meta name="viewport" content="width=device-width, initial-scale=1">'); if (src2 === src) throw new Error('no title tag'); const i = src2.indexOf('<body>');
if (i === -1) throw new Error('no body');
const at = i + '<body>'.length;
const out = src2.slice(0, at) + STUB + src2.slice(at);
fs.writeFileSync(OUT, out.split(LF).join(CR + LF));
console.log('wrote ' + path.relative(process.cwd(), OUT));
