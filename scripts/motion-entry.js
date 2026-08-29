// Entry point bundled into src/vendor/motion.js.
//
// The drawer is a plain page with an inline script and no module loader, so
// the library cannot be imported there. It is bundled to a global the same way
// the shader background is, and loaded with a script tag.
//
// Only the pieces a clipboard drawer could plausibly want are pulled in: the
// package's root has 261 exports, most of them React internals and projection
// machinery that nothing here will ever call, and tree-shaking can drop all of
// it if we do not ask for it. Add to this list when something new is needed
// rather than exporting the whole surface.
export { animate } from 'motion';
export { spring } from 'motion';     // the curve, for things that should settle
export { stagger } from 'motion';    // lists arriving in sequence
export { inView } from 'motion';     // run something when a row scrolls in
