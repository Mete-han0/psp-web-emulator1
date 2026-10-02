// Top-bar status chips and their popovers.
//
// Each chip summarises a subsystem; clicking opens a panel with detail and the
// controls that actually work for it.
//
// What is NOT here, deliberately:
//
//  - No GPU/backend selector. This build is compiled with USING_GLES2=ON and
//    -sMIN_WEBGL_VERSION=2, so WebGL2 is the only backend and JS cannot change
//    it. The GPU panel reports the real renderer instead of offering a choice
//    that would not take effect.
//
//  - No player-1 pad reassignment. PPSSPP maps controllers by SDL device index
//    (SDL/SDLJoystick.cpp) and exposes no config key for changing it, so the pad
//    panel shows which pad is player 1 rather than a dropdown that silently does
//    nothing. Remapping is in PPSSPP: pause menu -> Settings -> Controls.
//
//  - FPS here is the page's requestAnimationFrame rate, i.e. browser-side
//    responsiveness. The emulator's own loop rate is shown in the Speed chip and
//    comes from the wasm main loop.

const GPU_KEY = 'gpu';
const PAD_KEY = 'pad';
const SET_KEY = 'settings';

let openPop = null;
let gpuInfo = null;

// ---------------------------------------------------------------- popovers

function closePop() {
  if (!openPop) return;
  openPop.el.remove();
  openPop.chip.setAttribute('aria-expanded', 'false');
  openPop = null;
}

function togglePop(key, chip, build) {
  if (openPop && openPop.key === key) { closePop(); return; }
  closePop();

  const el = document.createElement('div');
  el.className = 'pop';
  el.setAttribute('role', 'dialog');
  el.style.right = (window.innerWidth - chip.getBoundingClientRect().right) + 'px';
  build(el);
  document.body.appendChild(el);
  chip.setAttribute('aria-expanded', 'true');
  openPop = { key, chip, el };

  // Keep the panel inside the viewport on narrow screens.
  if (el.getBoundingClientRect().left < 12) el.style.left = '12px';
}

document.addEventListener('click', (e) => {
  if (!openPop) return;
  if (openPop.el.contains(e.target) || openPop.chip.contains(e.target)) return;
  closePop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function T(key, vars) {
  return (typeof t === 'function') ? t(key, vars) : key;
}

function kv(key, v) {
  return `<div class="kv"><span>${esc(T(key))}</span><span>${v}</span></div>`;
}

// ---------------------------------------------------------------- gpu

function readGpu() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      api: gl.getParameter(gl.VERSION),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    };
  } catch (e) { return null; }
}

// Short label for the chip. Chrome reports the renderer as
//   "ANGLE (Vendor, Actual Renderer, Version)"
// where the interesting part is the middle field, so parse rather than regex
// greedily -- a greedy match strips up to the LAST comma and leaves "Unspecified
// Version)".
function gpuLabel() {
  if (!gpuInfo) return 'unavailable';
  let r = gpuInfo.renderer || 'unknown';

  const m = /^ANGLE\s*\((.*)\)\s*$/.exec(r);
  if (m) {
    const parts = m[1].split(',').map((s) => s.trim());
    r = parts[1] || parts[0] || r;
  }
  r = r.replace(/\s*\(.*$/, '').trim();

  if (/apple/i.test(r)) return 'Apple GPU';
  if (/nvidia|geforce|rtx|gtx/i.test(r)) return 'NVIDIA';
  if (/amd|radeon|\brx\b/i.test(r)) return 'AMD';
  if (/intel|iris|uhd|hd graphics/i.test(r)) return 'Intel';
  return r.length > 22 ? r.slice(0, 22) + '…' : r;
}

function buildGpu(el) {
  const g = gpuInfo || readGpu();
  const cv = document.getElementById('canvas');

  el.innerHTML = `
    <h4>${esc(T('gpu.heading'))}</h4>
    ${kv('gpu.renderer', esc(g ? g.renderer : T('gpu.unavailable')))}
    ${kv('gpu.vendor', esc(g ? g.vendor : '—'))}
    ${kv('gpu.api', esc(g ? g.api : '—'))}
    ${kv('gpu.backend', 'WebGL2 only (fixed at build time)')}
    ${kv('gpu.isolated', self.crossOriginIsolated ? 'yes' : 'no')}
    ${kv('gpu.canvas', cv ? `${cv.width}×${cv.height}` : '—')}

    <h4>${esc(T('gpu.display'))}</h4>
    <div class="row"><label for="gpuScale">${esc(T('gpu.scale'))}</label>
      <select id="gpuScale">
        <option value="auto">${esc(T('gpu.fit'))}</option>
        <option value="1">1×</option>
        <option value="2">2×</option>
      </select>
    </div>
    <div class="row"><label for="gpuFs">${esc(T('gpu.fullscreen'))}</label>
      <button class="btn" id="gpuFs">${esc(T('gpu.toggle'))}</button>
    </div>
    <p class="hint">${esc(T('gpu.hint'))}</p>
  `;

  el.querySelector('#gpuFs').addEventListener('click', toggleFullscreen);

  const scale = el.querySelector('#gpuScale');
  const saved = (settings.renderScale || 'auto');
  scale.value = saved;
  scale.addEventListener('change', (e) => {
    settings.renderScale = e.target.value;
    saveSettings();
    applyRenderScale();
  });
}

// Render scale: letterboxed integer scaling, or fit.
function applyRenderScale() {
  const cv = document.getElementById('canvas');
  if (!cv) return;
  const mode = settings.renderScale || 'auto';
  if (mode === 'auto') {
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.imageRendering = '';
    return;
  }
  const k = parseInt(mode, 10) || 1;
  cv.style.width = (480 * k) + 'px';
  cv.style.height = (272 * k) + 'px';
  cv.style.margin = 'auto';
  cv.style.position = 'absolute';
  cv.style.left = '50%';
  cv.style.top = '50%';
  cv.style.transform = 'translate(-50%,-50%)';
  // Nearest-neighbour keeps the low-res original crisp.
  cv.style.imageRendering = 'pixelated';
}

// ---------------------------------------------------------------- pads

function readPads() {
  if (!navigator.getGamepads) return null;
  return Array.from(navigator.getGamepads()).filter(Boolean);
}

// The pad PPSSPP will treat as player 1: controllers are pushed in SDL device
// index order, and the first one wins.
function primaryPad() {
  const p = readPads();
  return p && p.length ? p[0] : null;
}

function padLabel() {
  const p = primaryPad();
  if (!p) return T('pad.noneShort');
  return p.id.replace(/\s*\(.*$/, '').slice(0, 22);
}

function buildPad(el) {
  if (!('getGamepads' in navigator)) {
    el.innerHTML = `<h4>${esc(T('pad.heading'))}</h4><p class="hint">${esc(T('pad.noapi'))}</p>`;
    return;
  }

  const pads = readPads() || [];

  if (!pads.length) {
    el.innerHTML = `<h4>${esc(T('pad.heading'))}</h4>
      <p class="hint">${esc(T('pad.none'))}<br><br>${esc(T('pad.noneHint'))}</p>`;
    return;
  }

  const rows = pads.map((p, i) => {
    const active = p.buttons.filter((b) => b.pressed).length;
    const axes = p.axes.filter((a) => Math.abs(a) > 0.15).length;
    const bits = [`${esc(T('pad.mapping'))}: <code>${esc(p.mapping || 'unknown')}</code>`];
    if (active) {
      bits.push(`${active} ${esc(active > 1 ? T('pad.btns') : T('pad.btn'))} ${esc(T('pad.held'))}`);
    }
    if (axes) {
      bits.push(`${axes} ${esc(axes > 1 ? T('pad.axes') : T('pad.axis'))} ${esc(T('pad.moved'))}`);
    }
    return `<div class="padrow">
      <span class="slot">${esc(T('pad.slot'))} ${i}</span>
      <span class="who"><span class="nm">${esc(p.id)}</span>
        <span class="mt">${bits.join(' · ')}</span></span>
      ${i === 0 ? `<span class="tag">${esc(T('pad.p1'))}</span>` : ''}
    </div>`;
  }).join('');

  el.innerHTML = `<h4>${esc(T('pad.heading'))}</h4>${rows}
    <p class="hint">${esc(T('pad.hint'))}</p>`;
}

// ---------------------------------------------------------------- settings

function buildSettings(el) {
  el.innerHTML = `
    <h4>${esc(T('set.speedHead'))}</h4>
    <div class="row"><label for="stFps">${esc(T('set.loopRate'))}</label>
      <select id="stFps">
        <option value="30">${esc(T('set.rate30'))}</option>
        <option value="60">${esc(T('set.rate60'))}</option>
      </select>
    </div>
    <p class="hint">${esc(T('set.speedHint'))}</p>

    <h4>${esc(T('set.overlays'))}</h4>
    <div class="row"><label for="stFpsOv">${esc(T('set.loopOverlay'))}</label>
      <select id="stFpsOv">
        <option value="1">${esc(T('set.shownPlaying'))}</option>
        <option value="0">${esc(T('set.hidden'))}</option>
      </select>
    </div>

    <h4>${esc(T('set.session'))}</h4>
    ${kv('set.loop', loopText())}
    ${kv('set.saves', esc(T('set.savesVal')))}
    <p class="hint">${esc(T('set.sessionHint'))}</p>
  `;


  const rate = el.querySelector('#stFps');
  rate.value = String(settings.emuFps);
  rate.addEventListener('change', (e) => {
    settings.emuFps = parseInt(e.target.value, 10) || 30;
    saveSettings();
    if (window.Module) window.Module.emuFpsOverride = settings.emuFps;
    refreshChips();
  });

  const ov = el.querySelector('#stFpsOv');
  ov.value = settings.showFps ? '1' : '0';
  ov.addEventListener('change', (e) => {
    settings.showFps = e.target.value === '1';
    saveSettings();
    // syncFpsVisibility also accounts for whether a game is actually on screen.
    if (typeof syncFpsVisibility === 'function') syncFpsVisibility();
  });
}

// What's actually in browser storage, and whether it is durable. Reads the
// loader's state rather than duplicating the OPFS logic.
function loopText() {
  const m = window.Module;
  return m && m.emuLoopFps
    ? `${m.emuLoopFps} / ${m.emuTargetFps} Hz`
    : esc(T('set.notRunning'));
}

function toggleFullscreen() {
  const target = document.getElementById('stage');
  if (!document.fullscreenElement) {
    (target || document.documentElement).requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

// ---------------------------------------------------------------- chips

function refreshChips() {
  const g = document.getElementById('gpuVal');
  if (g) g.textContent = gpuLabel();

  const pad = primaryPad();
  const chip = document.getElementById('padChip');
  const val = document.getElementById('padVal');
  const led = document.getElementById('padLed');
  if (val) val.textContent = padLabel();
  if (chip) chip.dataset.on = pad ? 'on' : 'off';
  if (led) {
    led.className = 'led' + (pad ? ' on' : '');
  }

  const sp = document.getElementById('speedVal');
  if (sp) {
    const m = window.Module;
    sp.textContent = m && m.emuLoopFps ? `${m.emuLoopFps}/${m.emuTargetFps} Hz` : `${settings.emuFps} fps`;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  gpuInfo = readGpu();

  document.getElementById('gpuChip').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePop(GPU_KEY, e.currentTarget, buildGpu);
  });
  document.getElementById('padChip').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePop(PAD_KEY, e.currentTarget, buildPad);
  });
  document.getElementById('settingsChip').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePop(SET_KEY, e.currentTarget, buildSettings);
  });

  refreshChips();
  // Pads and the loop rate both change while a game runs.
  setInterval(() => {
    refreshChips();
    if (openPop && openPop.key === PAD_KEY) {
      const p = readPads();
      if (p && p.length) buildPad(openPop.el);
    }
    if (openPop && openPop.key === SET_KEY) {
      const lt = openPop.el.querySelector('.kv span:last-child');
      if (lt && /Hz|not running/.test(lt.textContent)) lt.textContent = loopText();
    }
  }, 1000);

  window.addEventListener('resize', closePop);
  applyRenderScale();

  // Rebuild whichever popover is open so its contents follow the language.
  document.addEventListener('langchange', () => {
    if (!openPop) return;
    const { key, chip } = openPop;
    closePop();
    const build = { [GPU_KEY]: buildGpu, [PAD_KEY]: buildPad, [SET_KEY]: buildSettings }[key];
    if (build) togglePop(key, chip, build);
  });
});