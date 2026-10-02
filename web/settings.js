// Shared settings state and the FPS overlay.
//
// The top bar (topbar.js) owns the UI; this file only owns the state it reads and
// the on-canvas FPS counter.
//
// Notes on what the numbers mean:
//
//  - The FPS overlay counts the page's requestAnimationFrame callbacks, i.e.
//    browser-side responsiveness. It is capped by the display refresh and is not
//    the emulated game's internal framerate.
//  - The emulator's own loop rate is measured inside the wasm main loop and
//    surfaces as Module.emuLoopFps; that is the number that determines how fast
//    a game runs, and it is shown in the top bar's Speed chip.

const SETTINGS_KEY = 'ppsspp-web:settings';

const DEFAULT_SETTINGS = {
  showFps: true,
  showPads: true,
  // Most PSP 3D games target 30fps. Driving the loop at 60 runs them at double
  // speed, so 30 is the default.
  emuFps: 30,
  renderScale: 'auto',
};

let settings = { ...DEFAULT_SETTINGS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch (e) { /* defaults are fine */ }

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

// ---------------------------------------------------------------- fps overlay
//
// Shows the EMULATOR loop rate, not page rAF.
//
// An earlier version counted requestAnimationFrame callbacks, which is pinned to
// the display refresh -- it read a constant 60 on a 60Hz screen regardless of what
// the emulator was doing, so it reported nothing useful. The number that reflects
// emulation performance is Module.emuLoopFps, measured inside the wasm main loop,
// and that is also what determines how fast a game actually runs.
//
// Only visible while a game is on screen; there is nothing to report otherwise.

let fpsEl = null;
let loopValue = 0;
let loopMin = Infinity;

function initFps() {
  if (!fpsEl) {
    fpsEl = document.createElement('div');
    fpsEl.id = 'fps';
    document.body.appendChild(fpsEl);
  }
  syncFpsVisibility();
  setInterval(tickFps, 500);
}

function syncFpsVisibility() {
  if (!fpsEl) return;
  const stageUp = document.getElementById('stage').style.display === 'block';
  fpsEl.style.display = (settings.showFps && stageUp) ? 'block' : 'none';
}

function tickFps() {
  if (!fpsEl) return;

  const stageUp = document.getElementById('stage').style.display === 'block';
  if (!stageUp) {
    if (fpsEl.style.display !== 'none') {
      fpsEl.style.display = 'none';
      loopValue = 0;
      loopMin = Infinity;
    }
    return;
  }

  const m = window.Module;
  const loop = m && m.emuLoopFps ? m.emuLoopFps : 0;
  const target = m && m.emuTargetFps ? m.emuTargetFps : settings.emuFps;

  if (!loop) {
    fpsEl.style.display = settings.showFps ? 'block' : 'none';
    fpsEl.textContent = 'starting…';
    fpsEl.className = '';
    return;
  }

  if (fpsEl.style.display !== 'block') fpsEl.style.display = settings.showFps ? 'block' : 'none';

  loopValue = loop;
  if (loop < loopMin) loopMin = loop;

  // Drop the low mark once it is stale, so it tracks recent behaviour instead of
  // pinning the worst reading from minutes ago.
  if (loopValue >= loopMin + 2) loopMin = loopValue;

  const behind = target ? (loop < target - 1) : false;
  const low = (loopMin < loopValue - 1) ? ` · low ${loopMin}` : '';
  fpsEl.textContent = `${loop} fps${low}`;
  fpsEl.className = behind ? 'bad' : loop < (target * 0.85) ? 'warn' : 'ok';
}

document.addEventListener('DOMContentLoaded', initFps);