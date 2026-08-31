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

    // The ceiling on how many pixels get shaded, whatever the screen. The
    // library's own default is 1920*1080*4 -- eight megapixels -- which clamps
    // nothing in practice: a Retina Mac renders this window at about 5.5Mpx
    // and pays for every one of them, sixty times a second. Measured here at
    // 2.2Mpx it cost 46% of a core.
    //
    // This is soft noise with no hard edges. Shading it at roughly a megapixel
    // and letting the GPU scale that up is not a difference anyone can point
    // to, and it is the difference between a background and a fan coming on.
    maxPixelCount: 1100 * 1000,

    // How long it keeps moving with nobody touching anything. A clipboard
    // drawer's background is seen for the second or two it takes to find a
    // clip; after that it is a still gradient behind a list, and a still
    // gradient costs nothing at all. Any input starts it again.
    settleAfterMs: 1500,

    // Whether it is allowed to move at all. Off unless the setting says
    // otherwise -- see animateBackground in main.js for why that is the
    // default. A still gradient is one draw and then nothing.
    allowMotion: false,
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
        CONFIG.minPixelRatio,
        CONFIG.maxPixelCount
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

  // Animation is a thing you spend, not a thing you leave on.
  //
  // The drawer hides rather than closing, so it can sit there for hours; and
  // even while it is open, the background has done its job within a second or
  // two of being looked at. So it runs after something happens and settles
  // when nothing has for a while. Settled costs nothing -- ShaderMount cancels
  // its rAF outright at speed 0, rather than drawing the same frame forever.
  let settleTimer = null;
  let settled = false;

  function stopMoving() {
    settleTimer = null;
    if (!mount || settled) return;
    settled = true;
    mount.setSpeed(0);
  }

  function keepMoving() {
    if (!CONFIG.allowMotion) return;      // a still gradient stays still
    clearTimeout(settleTimer);
    settleTimer = setTimeout(stopMoving, CONFIG.settleAfterMs);
    if (!mount || !settled) return;
    settled = false;
    mount.setSpeed(CONFIG.speed);
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
      clearTimeout(settleTimer);
      settleTimer = null;
      settled = true;
      mount.setSpeed(0);
    },
    resume() {
      if (!mount) return;
      stats.resumes++;
      keepMoving();
    },
    // Something happened: a key, a pointer, a clip arriving. Move again, and
    // start the clock over.
    stir() { if (mount) keepMoving(); },
    get settled() { return settled; },
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
    // Turning it on mid-session should look like turning it on, so it starts
    // moving immediately rather than waiting for the next thing to happen.
    setMotionAllowed(on) {
      CONFIG.allowMotion = !!on;
      if (!mount) return;
      if (CONFIG.allowMotion) keepMoving();
      else { clearTimeout(settleTimer); settleTimer = null; settled = true; mount.setSpeed(0); }
    },
    palettes: PALETTES,
    config: CONFIG,
    stats,
  };

  // The drawer hides on blur. Nobody is looking at the gradient then, and a
  // frozen one during a drag is imperceptible, so this is free to be blunt.
  //
  // Blur is not enough on its own: it depends on the OS delivering it, and a
  // window that was never focused never gets one. The main process says so
  // directly as well -- see window:shown / window:hidden in the drawer.
  window.addEventListener('blur', () => api.pause());
  window.addEventListener('focus', () => api.resume());

  // Anything a person does is a reason to move; nothing they do is a reason to
  // stop. Passive listeners so this can never hold up a scroll.
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach(ev =>
    window.addEventListener(ev, () => api.stir(), { passive: true }));

  window.StashShader = api;
})();
