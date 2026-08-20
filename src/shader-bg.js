/* The drawer's background layer.
 *
 * This runs the real Paper Design shader (@paper-design/shaders, bundled to a
 * classic script in vendor/ because Chromium refuses ES module imports over
 * file://). The shell stacks on top of it: background container -> panel cards.
 *
 * Performance note, because this is the whole reason the layer is isolated:
 * ShaderMount stops its rAF entirely when speed is 0, so a static gradient
 * costs one draw and then nothing at all. It also self-pauses on
 * document.hidden and when the canvas leaves the viewport. We add an explicit
 * pause on window hide anyway -- the drawer hides on blur rather than closing,
 * so it can sit invisible for hours and we do not want to trust an implicit.
 */
(function () {
  'use strict';

  // Mirrors the shader layer on the Paper artboard. Every value here is meant
  // to be swapped wholesale once the exact numbers come out of Paper's
  // inspector -- nothing downstream reads these except the mount call.
  const CONFIG = {
    colors: ['#eef4fd', '#cfe0f6', '#a6c8ee', '#7fabe2', '#ffffff'],
    distortion: 0.8,
    swirl: 0.1,
    grainMixer: 0,
    grainOverlay: 0,

    // 0 keeps the gradient still. Anything above 0 turns on a permanent rAF.
    speed: 0,
    // Which still of the animation to freeze on, in milliseconds.
    frame: 14000,

    fit: 'cover',
    scale: 1,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    originX: 0.5,
    originY: 0.5,
    worldWidth: 0,
    worldHeight: 0,

    // The drawer is ~420px wide. Rendering it at 2x device pixels is wasted
    // fill rate on a soft gradient with no hard edges to alias.
    minPixelRatio: 1,
  };

  let mount = null;
  const stats = { mountMs: 0, firstPaintMs: 0, pauses: 0, resumes: 0 };

  function build(host) {
    const P = window.PaperShaders;
    if (!P || !host) return null;

    const t0 = performance.now();
    const colors = CONFIG.colors.map(P.getShaderColorFromString);

    const uniforms = {
      u_colors: colors,
      u_colorsCount: colors.length,
      u_distortion: CONFIG.distortion,
      u_swirl: CONFIG.swirl,
      u_grainMixer: CONFIG.grainMixer,
      u_grainOverlay: CONFIG.grainOverlay,

      u_fit: P.ShaderFitOptions[CONFIG.fit],
      u_scale: CONFIG.scale,
      u_rotation: CONFIG.rotation,
      u_offsetX: CONFIG.offsetX,
      u_offsetY: CONFIG.offsetY,
      u_originX: CONFIG.originX,
      u_originY: CONFIG.originY,
      u_worldWidth: CONFIG.worldWidth,
      u_worldHeight: CONFIG.worldHeight,
    };

    try {
      mount = new P.ShaderMount(
        host,
        P.meshGradientFragmentShader,
        uniforms,
        undefined,
        CONFIG.speed,
        CONFIG.frame,
        CONFIG.minPixelRatio
      );
    } catch (err) {
      // A WebGL failure must never take the drawer down with it. Falling back
      // to the flat --bg colour is a cosmetic loss, not a functional one.
      console.warn('shader background unavailable, falling back to flat fill', err);
      host.classList.add('shader-failed');
      return null;
    }

    stats.mountMs = performance.now() - t0;
    requestAnimationFrame(() => {
      stats.firstPaintMs = performance.now() - t0;
    });
    return mount;
  }

  window.StashShader = {
    init(host) {
      if (mount) return mount;
      return build(host);
    },
    // Called when the drawer hides. With speed 0 this is already a no-op, but
    // it is the switch that matters the moment anyone sets speed above 0.
    pause() {
      if (!mount) return;
      stats.pauses++;
      mount.setSpeed(0);
    },
    resume() {
      if (!mount) return;
      stats.resumes++;
      mount.setSpeed(CONFIG.speed);
    },
    config: CONFIG,
    stats,
  };
})();
