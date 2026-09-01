// src/icns.js — an app's own icon, read out of its bundle.
//
// macOS was asked, on a Mac, what getFileIcon returns for six installed apps:
//
//   small:  6 apps -> 2 distinct icons
//   normal: 6 apps -> 2 distinct icons
//   large:  6 apps -> 1 distinct icon
//
// Terminal, TextEdit, Calculator, Chrome and Firefox all came back as the same
// picture. On the Mac this was reported from it is worse than that -- every app
// shares one, which is why every row ended up showing a name. Whatever
// getFileIcon is asking, it is not producing app icons there.
//
// So this does not ask anything. An .icns file is a flat list of chunks, and
// since 10.7 the interesting ones hold a PNG verbatim -- so the app's real icon
// is already sitting in its bundle as bytes that can be handed straight to
// nativeImage. No icon service, no window server, no cache, no subprocess.
//
// Format, which has not changed since it was documented:
//
//   'icns'  <4 bytes, total length>
//   then chunks of:  <4-byte type>  <4-byte length, header included>  <data>
//
// The four-letter types are sizes. ic11 is 32px, ic12 64px, ic07 128px, and so
// on up to ic10 at 1024. Older files carry JPEG 2000 in the same slots, which
// nativeImage cannot read -- so the payload is checked rather than assumed.
const fs = require('fs');
const path = require('path');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// What each chunk is worth having, roughly in pixels. A row draws the icon at
// 13 to 22 CSS pixels, so on a Retina Mac anything from 64px up is plenty and
// a 1024px chunk is a megabyte of PNG to throw away.
const SIZES = {
  ic11: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256,
  ic14: 512, ic09: 512, ic10: 1024, ic05: 32, ic04: 16,
};
const PREFERENCE = ['ic12', 'ic07', 'ic11', 'ic13', 'ic08', 'ic14', 'ic09', 'ic10'];

// Every chunk in the file, with its payload. Deliberately tolerant: a chunk
// with a nonsense length ends the walk rather than throwing, because a bundle
// that ships something odd should cost that one app its icon and nothing more.
function chunks(buf) {
  const found = [];
  if (!buf || buf.length < 8 || buf.slice(0, 4).toString('latin1') !== 'icns') return found;
  const total = Math.min(buf.readUInt32BE(4), buf.length);
  let at = 8;
  while (at + 8 <= total) {
    const type = buf.slice(at, at + 4).toString('latin1');
    const len = buf.readUInt32BE(at + 4);
    if (len < 8 || at + len > total) break;
    found.push({ type, data: buf.slice(at + 8, at + len) });
    at += len;
  }
  return found;
}

function isPng(data) {
  return data.length > 8 && data.slice(0, 8).equals(PNG_MAGIC);
}

// The PNG worth using, or null if the file holds none -- which is what an icns
// written before 10.7 looks like, and is a miss rather than an error.
function bestPng(buf) {
  const png = new Map();
  for (const c of chunks(buf)) if (isPng(c.data) && !png.has(c.type)) png.set(c.type, c.data);
  if (!png.size) return null;
  for (const type of PREFERENCE) {
    if (png.has(type)) return { type, size: SIZES[type] || null, data: png.get(type) };
  }
  // A type not on the list, but still a PNG: better than nothing.
  const [type, data] = png.entries().next().value;
  return { type, size: SIZES[type] || null, data };
}

// Where a bundle keeps its icon. CFBundleIconFile is the key that points at a
// plain .icns; CFBundleIconName points into Assets.car instead, which is not a
// file anyone can read, so those apps fall through to the search below.
//
// readPlistIconName is injected rather than imported so this is drivable from a
// test on a machine with no plutil on it.
function iconPathFor(appPath, { readPlistIconName, exists = fs.existsSync, list = fs.readdirSync } = {}) {
  if (!appPath) return null;
  const resources = path.join(appPath, 'Contents', 'Resources');
  const named = readPlistIconName ? readPlistIconName(appPath) : '';
  if (named) {
    const file = named.endsWith('.icns') ? named : named + '.icns';
    const full = path.join(resources, file);
    if (exists(full)) return full;
  }
  let icns = [];
  try { icns = list(resources).filter(n => n.endsWith('.icns')); } catch (_) { return null; }
  if (!icns.length) return null;
  // One candidate is unambiguous. Several, and the one named after the app is
  // the app's own far more often than not -- and picking wrong costs a wrong
  // logo, which the collision check in main will not catch, so it is the only
  // guess made here.
  if (icns.length === 1) return path.join(resources, icns[0]);
  const base = path.basename(appPath, '.app').toLowerCase();
  const match = icns.find(n => n.toLowerCase() === base + '.icns')
    || icns.find(n => n.toLowerCase() === 'appicon.icns');
  return match ? path.join(resources, match) : null;
}

module.exports = { chunks, bestPng, iconPathFor, isPng, PREFERENCE, SIZES };
