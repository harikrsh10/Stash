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

// Figma frames run to megabytes and the payload is the clip, so they get their
// own ceiling rather than the one meant for stray formatting. Still bounded:
// an unbounded one would let a single copy fill the store.
const DESIGN_HTML_MAX = 8 * 1024 * 1024;

function looksLikeFigma(html) {
  if (!html) return false;
  return FIGMA_MARKERS.some(re => re.test(html));
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
  return looksLikeFigma(html) ? DESIGN_HTML_MAX : ordinaryMax;
}

// What the row calls it.
function labelFor(asset) {
  if (asset === 'figma') return 'figma';
  if (asset === 'svg') return 'svg';
  return null;
}

module.exports = {
  sniffAsset, looksLikeFigma, looksLikeSvg, extensionFor, htmlCapFor, labelFor,
  FIGMA_MARKERS, DESIGN_HTML_MAX,
};
