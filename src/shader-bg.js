/* The drawer's background layer.
 *
 * This runs the real Paper Design shader (@paper-design/shaders, bundled to a
 * classic script in vendor/ because Chromium refuses ES module imports over
 * file://). The shell stacks on top of it: background container -> panel cards.
 *
 * Performance note, because this is the whole reason the layer is isolated:
 * ShaderMount stops its rAF entirely when speed is 0, so a still gradient
 * costs one draw and then nothing. Above 0 it draws every frame for as long as
 * the drawer exists -- and the drawer hides on blur rather than closing, so it
 * can sit invisible for hours. The library pauses itself on document.hidden;
 * we pause on window blur as well rather than trust that alone.
 */
(function () {
  'use strict';

  // Smoke Ring, with the values off the shader node in the Paper file. Paper
  // shows these as percentages of the raw value, so 153% is 1.53 and 500% is 5.
  // The ring keeps its shape across both themes; only what it is made of
  // changes. Light is the pair straight off the Paper node.
  //
  // Dark is tuned against the cards rather than taken from Paper directly.
  // Its 202022 ground and 353536 ring both sat above the #141519 card -- the
  // ring by 1.49 -- so the cards read as holes punched in a grey fog instead
  // of as objects on a black field. These sit the ground on the drawer's own black
  // (1.01 against it) and bring the ring down to 1.09 above the card: enough
  // to see the smoke move, never enough to out-weigh what is on top of it.
  const PALETTES = {
    light: { colorBack: '#81ADEC', colors: ['#BDD6F6'] },
    dark:  { colorBack: '#0A0B0D', colors: ['#1B1E26'] },
  };

  const CONFIG = {

    thickness: 0.65,
    radius: 0.5,
    innerShape: 0.78,
    noiseScale: 5,
    noiseIterations: 5,

    // 1 matches the design. Drop to 0 to freeze it and stop the render loop
    // outright -- see the note above.
    speed: 1,
    frame: 0,

    fit: 'cover',
    scale: 1.53,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    originX: 0.5,
    originY: 0.5,
    worldWidth: 0,
    worldHeight: 0,

    // The drawer is ~466px wide. Rendering it at 2x device pixels is wasted
    // fill rate on soft noise with no hard edges to alias.
    minPixelRatio: 1,
  };

  let mount = null;
  let building = null;
  let isLight = true;

  function palette() {
    return PALETTES[isLight ? 'light' : 'dark'];
  }
  const stats = { mountMs: 0, firstPaintMs: 0, pauses: 0, resumes: 0 };

  // ShaderMount throws unless the noise texture is fully decoded, so the mount
  // has to wait on it.
  function noiseReady(P) {
    const img = P.getShaderNoiseTexture();
    if (!img || img.complete) return Promise.resolve(img);
    return new Promise((resolve) => {
      img.onload = () => resolve(img);
      img.onerror = () => resolve(undefined);
    });
  }

  async function build(host) {
    const P = window.PaperShaders;
    if (!P || !host) return null;

    const t0 = performance.now();
    const noise = await noiseReady(P);
    const colors = palette().colors.map(P.getShaderColorFromString);

    const uniforms = {
      u_colorBack: P.getShaderColorFromString(palette().colorBack),
      u_colors: colors,
      u_colorsCount: colors.length,
      u_thickness: CONFIG.thickness,
      u_radius: CONFIG.radius,
      u_innerShape: CONFIG.innerShape,
      u_noiseScale: CONFIG.noiseScale,
      u_noiseIterations: CONFIG.noiseIterations,
      u_noiseTexture: noise,

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
        P.smokeRingFragmentShader,
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

  const api = {
    init(host) {
      if (mount) return Promise.resolve(mount);
      if (!building) building = build(host);
      return building;
    },
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
    // Swapping colours beats tearing the context down and building another:
    // the shape, the noise texture and the compiled program all stay put, so
    // a theme change costs one uniform upload.
    setTheme(light) {
      isLight = !!light;
      if (!mount) return;
      const P = window.PaperShaders;
      const next = palette();
      const colors = next.colors.map(P.getShaderColorFromString);
      mount.setUniforms({
        u_colorBack: P.getShaderColorFromString(next.colorBack),
        u_colors: colors,
        u_colorsCount: colors.length,
      });
    },
    palettes: PALETTES,
    config: CONFIG,
    stats,
  };

  // The drawer hides on blur. Nobody is looking at the gradient then, and a
  // frozen one during a drag is imperceptible, so this is free to be blunt.
  window.addEventListener('blur', () => api.pause());
  window.addEventListener('focus', () => api.resume());

  window.StashShader = api;
})();
