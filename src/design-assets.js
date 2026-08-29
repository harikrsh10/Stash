// src/design-assets.js — recognising the things designers copy.
//
// A clipboard is not only text and pictures. Copying a frame in Figma puts an
// encoded description of that frame on the clipboard as HTML; copying artwork
// out of Illustrator or a design tool often puts SVG source on it as plain
// text. Both arrive looking like "some text" and are stored as such, which
// loses the thing that made them worth copying.
//
// Two different problems wearing the same disguise:
//
// - A **Figma frame** is only useful if it goes back to Figma unchanged. The
//   payload lives in the HTML flavour, and it is not decoration around the
//   text -- it *is* the clip. Stash caps HTML at 256KB because Word and Excel
//   put hundreds of kilobytes of styling scaffolding around one paragraph, and
//   that cap is right for scaffolding and exactly wrong here: it silently turns
//   a frame into the word "Frame".
//
// - **SVG** is text, and perfectly readable as text, but it is a picture. It
//   should say so, and it should leave as a .svg rather than a .txt, because a
//   .txt full of SVG is not something another app will open.
//
// No electron import, so this is drivable from a test.

// What a Figma payload looks like on the clipboard. Figma wraps a base64 blob
// in a span carrying these attributes; the comment markers are how its own
// paste handler finds them again.
const FIGMA_MARKERS = [/data-buffer\s*=/i, /<!--\(figma\)/i, /<!--\(figmeta\)/i];

// Paper writes a different shape: a comment wrapping a JSON description of the
// selection, with the node tree, its styles and the file's design tokens.
//
//   <!--<paper-paste-start data-embed="{ ...json... }"></paper-paste-start>-->
//
// This was found by looking at what actually landed in a real history rather
// than by reasoning about it -- the first version of this file knew only about
// Figma, so copying out of Paper produced a row headlined "Node IDs: 4QE-0"
// and nothing else.
const PAPER_MARKERS = [/paper-paste-start/i];

// Apps whose pictures are artwork rather than screenshots.
//
// This exists because of what the clipboard actually offers, which is not what
// you would guess. Copying an icon in Figma on Windows puts *only* image/png on
// the clipboard -- no HTML, no payload, nothing to say it is a design at all.
// Paper does the opposite: text/html with a full scene description and no
// picture. So neither tool can be recognised the same way, and a Figma asset is
// only distinguishable from a screenshot by knowing where it came from.
const DESIGN_TOOLS = [
  'figma', 'paper', 'sketch', 'penpot', 'framer', 'rive', 'lottiefiles',
  'adobe illustrator', 'illustrator', 'adobe photoshop', 'photoshop',
  'adobe xd', 'affinity designer', 'affinity photo', 'inkscape', 'canva',
];

function isDesignTool(appName) {
  const n = String(appName || '').trim().toLowerCase();
  if (!n) return false;
  return DESIGN_TOOLS.some(t => n === t || n.startsWith(t + ' ') || n.includes(t));
}

// Figma frames run to megabytes and the payload is the clip, so they get their
// own ceiling rather than the one meant for stray formatting. Still bounded:
// an unbounded one would let a single copy fill the store.
const DESIGN_HTML_MAX = 8 * 1024 * 1024;

function looksLikeFigma(html) {
  if (!html) return false;
  return FIGMA_MARKERS.some(re => re.test(html));
}

function looksLikePaper(html) {
  if (!html) return false;
  return PAPER_MARKERS.some(re => re.test(html));
}

// The design tools whose payload is the clip rather than formatting around it.
function looksLikeScene(html) {
  return looksLikeFigma(html) || looksLikePaper(html);
}

// What Paper knows about what you copied. The name and the size come out of
// the embedded scene, which is the difference between a row that says "Frame,
// 893×969" and one that says "Node IDs: 4QE-0".
function paperScene(html) {
  const m = String(html || '').match(/data-embed="([\s\S]*?)"><\/paper-paste-start>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch (_) { return null; }
  const ids = Array.isArray(data.topLevelNodeIds) ? data.topLevelNodeIds : [];
  const nodes = data.nodes || {};
  const first = nodes[ids[0]] || {};
  const styles = first.styles || {};
  const size = (Number.isFinite(styles.width) && Number.isFinite(styles.height))
    ? `${Math.round(styles.width)}×${Math.round(styles.height)}`
    : '';
  return {
    name: String(first.label || first.component || '').trim(),
    size,
    // More than one thing selected is worth saying, since the name can only
    // describe the first of them.
    count: ids.length,
    nodes: Object.keys(nodes).length,
  };
}

// SVG source, as opposed to a document that merely mentions one. Anchored at
// the start so a blog post about SVG is still a blog post.
function looksLikeSvg(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (!t) return false;
  // an xml prolog or a comment may come first
  const head = t.slice(0, 500).replace(/^<\?xml[^>]*\?>\s*/i, '').replace(/^<!--[\s\S]*?-->\s*/, '');
  if (!/^<svg[\s>]/i.test(head.trim())) return false;
  // and it has to actually close, or it is a fragment of something else
  return /<\/svg\s*>\s*$/i.test(t);
}

// What kind of design asset this is, if any. Given both flavours because the
// answer lives in different ones: Figma's in the HTML, SVG's in the text.
function sniffAsset(text, html) {
  if (looksLikeFigma(html)) return 'figma';
  if (looksLikePaper(html)) return 'paper';
  if (looksLikeSvg(text)) return 'svg';
  return null;
}

// The extension a clip should leave as when dragged out. A design asset that
// arrives as a .txt is a design asset another app refuses to open.
function extensionFor(asset) {
  if (asset === 'svg') return '.svg';
  return '.txt';
}

// How big the HTML flavour is allowed to be for this clip. Ordinary styled
// text keeps the small cap; a design payload gets the room it needs.
function htmlCapFor(html, ordinaryMax) {
  return looksLikeScene(html) ? DESIGN_HTML_MAX : ordinaryMax;
}

// What the row calls it. Both kinds read as one idea -- something a designer
// copied -- rather than as the format they happen to be encoded in.
function labelFor(asset) {
  if (asset === 'figma' || asset === 'paper' || asset === 'svg'
      || asset === 'artwork') return 'assets';
  return null;
}

// Which assets can actually be drawn. SVG is source we can hand to an <img>;
// a Figma frame is Figma's own encoding of a frame, which is not a picture and
// cannot be turned into one here.
function isDrawable(asset) {
  return asset === 'svg';
}

// What to call the thing on the row. Figma and most drawing tools write the
// layer name into <title> when they export, which is the closest thing to what
// the person called it.
function assetTitle(source) {
  const m = String(source || '').match(/<title[^>]*>([\s\S]{1,120}?)<\/title>/i);
  if (!m) return '';
  const text = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text;
}

// The size it draws at, for the line under the name. viewBox is the honest
// answer -- width and height may be percentages or absent entirely.
function assetSize(source) {
  const s = String(source || '');
  const vb = s.match(/viewBox\s*=\s*["']\s*[-\d.]+[,\s]+[-\d.]+[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (vb) return `${Math.round(Number(vb[1]))}×${Math.round(Number(vb[2]))}`;
  const w = s.match(/\bwidth\s*=\s*["']([\d.]+)(px)?["']/i);
  const h = s.match(/\bheight\s*=\s*["']([\d.]+)(px)?["']/i);
  if (w && h) return `${Math.round(Number(w[1]))}×${Math.round(Number(h[1]))}`;
  return '';
}

// Past this a preview is not worth building: the data URL would be megabytes
// of string handed to the DOM on every render of the list.
const PREVIEW_MAX = 512 * 1024;

function previewable(source) {
  const s = String(source || '');
  return s.length > 0 && s.length <= PREVIEW_MAX;
}

module.exports = {
  sniffAsset, looksLikeFigma, looksLikePaper, looksLikeScene, looksLikeSvg,
  isDesignTool, DESIGN_TOOLS,
  paperScene, extensionFor, htmlCapFor, labelFor,
  isDrawable, assetTitle, assetSize, previewable,
  FIGMA_MARKERS, PAPER_MARKERS, DESIGN_HTML_MAX, PREVIEW_MAX,
};
