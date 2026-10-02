// PPSSPP Web loader.
//
// Responsibilities:
//   1. Boot the non-MODULARIZED emscripten build (it expects a global `Module`).
//   2. Mount the user's game WITHOUT copying it into memory. The default approach
//      is FS.writeFile() into MEMFS, which turns a 1-2 GB .cso into a 1-2 GB heap
//      allocation and kills the tab. We use FS.createLazyFile() over a blob URL,
//      so reads are pulled on demand through the browser's own file streaming.
//   3. Persist saves in IndexedDB via IDBFS mounted over PPSSPP's user dir.
//
// The build is THREADED (-pthread), so this page only works when the document is
// cross-origin isolated. That requires COOP/COEP headers -- see serve.py.

const STATUS = document.getElementById('status');
const BAR = document.getElementById('bar');
const DROP = document.getElementById('drop');
const STAGE = document.getElementById('stage');
const CANVAS = document.getElementById('canvas');
const PICK = document.getElementById('pick');
const FILE = document.getElementById('file');

const USER_DIR = '/home/web_user';
const GAME_DIR = '/games';

// Game bytes read asynchronously by runGame(), written into MEMFS during preRun.
let pendingBytes = null;   // { name, data: Uint8Array }
let bootPromise = null;

// Localised, with a passthrough so this still works if i18n.js failed to load.
function T(key, vars) {
  return (typeof t === 'function') ? t(key, vars) : key;
}

function say(msg, cls = '') {
  STATUS.textContent = msg;
  STATUS.className = 'status' + (cls ? ' ' + cls : '');
}

function progress(pct) {
  BAR.classList.add('on');
  BAR.value = pct;
}

function idle() {
  BAR.classList.remove('on');
  BAR.value = 0;
}

// Return to the picker. Reloads, because a booted wasm instance cannot be reused.
let returning = false;
function returnToPicker() {
  if (returning) return;
  returning = true;
  STAGE.style.display = 'none';
  syncEscapeVisibility();
  say(T('st.returning'), 'warn');
  setTimeout(() => location.reload(), 250);
}

// A frozen frame with no way out is the worst failure mode here, and it can also
// come from a crash inside wasm or a lost WebGL context, not just from a missed
// exit notification. Rather than guess at liveness, keep a reliable escape hatch.
//
// It stays out of the way: hidden until the pointer moves, fading again once the
// user stops, but always visible on focus (keyboard) and on touch devices where
// there is no hover to reveal it.
let escapeBar = null;
let escapeTimer = null;

function showEscape() {
  // Guard the class write: pointermove fires at frame rate, and toggling the
  // class that way restarts the CSS transition every time.
  if (!escapeBar || escapeBar.classList.contains('show')) return;
  escapeBar.classList.add('show');
}

// Fade out again once the pointer stops. Tracked from real pointer events rather
// than :hover, because a pointer resting on the corner would otherwise pin the
// button open forever.
let lastPointerAt = 0;

function maybeHideEscape() {
  if (!escapeBar) return;
  if (document.activeElement === escapeBar) return;  // keyboard: keep visible
  if (Date.now() - lastPointerAt < 2500) {            // still moving; re-arm
    escapeTimer = setTimeout(() => { escapeTimer = null; maybeHideEscape(); }, 2600);
    return;
  }
  escapeBar.classList.remove('show');
}

function onPointerActivity() {
  lastPointerAt = Date.now();
  showEscape();
  // pointermove fires continuously during play, so only re-arm when nothing is
  // pending. Note the handle MUST be nulled after clearTimeout, otherwise
  // `escapeTimer === null` below is never true and the hide timer is cancelled
  // on every event and never rescheduled -- the button then stays up forever.
  if (escapeTimer !== null) clearTimeout(escapeTimer);
  escapeTimer = setTimeout(() => { escapeTimer = null; maybeHideEscape(); }, 2600);
}

function installEscapeHatch() {
  if (escapeBar) return;
  escapeBar = document.createElement('button');
  escapeBar.id = 'escape';
  escapeBar.textContent = T('st.backToPicker');
  escapeBar.title = 'Reload and return to the game picker (saves are kept)';
  escapeBar.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      if (window.Module && window.Module.FS && typeof window.Module.IDBFS !== 'undefined') {
        // populate = FALSE -> MEMFS -> IndexedDB (save). See preRunHook.
        window.Module.FS.syncfs(false, () => {});
      }
    } catch (err) { /* nothing to save */ }
    returnToPicker();
  });
  // Keep it shown while keyboard-focused so it is always reachable. Only on
  // focus: hooking blur would re-show it immediately at startup if it happened to
  // receive focus as the page loaded.
  escapeBar.addEventListener('focus', showEscape);
  escapeBar.addEventListener('blur', () => {
    clearTimeout(escapeTimer);
    escapeTimer = setTimeout(() => { escapeTimer = null; maybeHideEscape(); }, 1200);
  });
  document.body.appendChild(escapeBar);
  syncEscapeVisibility();

  // Start hidden: only pointer movement (or keyboard focus) reveals it.
  escapeBar.classList.remove('show');

  window.addEventListener('pointermove', onPointerActivity, { passive: true });
  window.addEventListener('pointerdown', onPointerActivity, { passive: true });
}

// The escape hatch only makes sense over a running emulator; keeping it on the
// library page would sit on top of the header for no reason.
function syncEscapeVisibility() {
  if (!escapeBar) return;
  escapeBar.style.display = STAGE.style.display === 'block' ? 'block' : 'none';
}

// The wasm build hardcodes -pthread and -msimd128, so it needs
// SharedArrayBuffer and SIMD support.
function checkEnvironment() {
  const problems = [];
  if (typeof SharedArrayBuffer === 'undefined') {
    problems.push('SharedArrayBuffer is unavailable, so the page is not cross-origin isolated.');
  } else if (!self.crossOriginIsolated) {
    problems.push('crossOriginIsolated is false, so the COOP/COEP headers are missing or wrong.');
  }
  if (typeof SIMD !== 'undefined' && !SIMD) {
    problems.push('SIMD128 is unavailable, and this build requires it.');
  }
  return problems;
}

const UNSAFE = /[^A-Za-z0-9 ._\-()\[\]]/g;

function safeName(name) {
  return name.replace(UNSAFE, '_').slice(0, 100) || 'game.iso';
}

// Runs inside the wasm runtime, before main() runs.
// Both the IDBFS mount and the game mount have to happen here: FS does not
// exist before the runtime starts, and argv is read once at startup.
function preRunHook() {
  const FS = this.FS;
  if (!FS) return;

  // ---- saves: MEMFS <-> IndexedDB over PPSSPP's user directory
  try {
    FS.mkdirTree(USER_DIR);
  } catch (e) { /* already there */ }

  // Do NOT addRunDependency() for IDBFS. IDBFS only reads IndexedDB when
  // syncfs() is called, so a run dependency would never resolve and the runtime
  // would hang forever before onRuntimeInitialized.
  //
  // ARGUMENT ORDER MATTERS. IDBFS.syncfs(mount, populate) is implemented as:
  //     var src = populate ? remote : local;
  //     var dst = populate ? local  : remote;
  // Therefore  populate = TRUE  copies IndexedDB -> MEMFS   (LOAD, at startup)
  //           populate = FALSE copies MEMFS    -> IndexedDB (SAVE, on the way out)
  //
  // Getting this backwards does not just fail -- it DELETES. A save call that
  // actually loads wipes whatever MEMFS holds that is not already in IndexedDB,
  // which is exactly how saves were being destroyed here.
  //
  // emscripten can attach IDBFS to the Module object or leave it as a global
  // depending on link settings, so check both.
  const IDBFS = (typeof this.IDBFS !== 'undefined' && this.IDBFS)
    || (typeof window.IDBFS !== 'undefined' && window.IDBFS)
    || (typeof globalThis.IDBFS !== 'undefined' && globalThis.IDBFS);

  if (IDBFS) {
    try {
      FS.mkdirTree(USER_DIR);
      FS.mount(IDBFS, {}, USER_DIR);
      console.log('[loader] IDBFS mounted at', USER_DIR);
      // populate = TRUE -> load IndexedDB into MEMFS at startup.
      FS.syncfs(true, (err) => {
        if (err) console.warn('IDBFS load failed; saves start empty:', err);
        else console.log('[loader] saves loaded from IndexedDB');
      });
    } catch (e) {
      console.warn('IDBFS mount failed; saves will not persist:', e);
    }
  } else {
    console.warn('IDBFS not found in build; saves will not persist across reloads.');
  }

  // ---- game: mount into MEMFS so PPSSPP can read it synchronously
  //
  // Why buffered rather than streamed: PPSSPP's emulated filesystem reads
  // synchronously, and on the MAIN THREAD browsers forbid synchronous XHR.
  // FS.createLazyFile() depends on exactly that and aborts with "Cannot do
  // synchronous binary XHRs outside webworkers". WORKERFS, FileReaderSync and
  // OPFS sync access handles are all worker-only.
  //
  // So we read the file ASYNCHRONOUSLY here in main() and hand the bytes over in
  // a module-level variable, then write them synchronously during preRun (which
  // cannot await). Memory cost is roughly the file size; CSO is compressed so
  // this is usually a few hundred MB rather than the ~1.8 GB of a raw ISO.
  // Moving the emulator into a Worker would remove this limit; see NOTES.md.
  if (pendingBytes) {
    bootState = 'pending';
    updateBootBadge();
    if (pendingBytes.dir && pendingBytes.files) {
      // Directory game: PPSSPP boots a folder containing EBOOT.PBP directly,
      // so no ISO packing is needed.
      const dir = pendingBytes.dir;
      FS.mkdirTree(dir);
      let total = 0;
      for (const [name, data] of pendingBytes.files) {
        FS.writeFile(dir + '/' + name, data);
        total += data.byteLength;
      }
      this.arguments = [dir];
      console.log('[loader] mounted directory', dir, pendingBytes.files.length,
                  'files,', total, 'bytes');
    } else {
      const path = GAME_DIR + '/' + pendingBytes.name;
      FS.mkdirTree(GAME_DIR);
      FS.writeFile(path, pendingBytes.data);
      this.arguments = [path];
      console.log('[loader] mounted', path, pendingBytes.data.byteLength, 'bytes');
    }
    pendingBytes = null;
  }
}

// ---------------------------------------------------------------- boot

function boot() {
  if (bootPromise) return bootPromise;

  bootPromise = new Promise((resolve, reject) => {
    say(T('st.starting'));

    const Module = {
      canvas: CANVAS,
      print: (t) => { console.log('[ppsspp]', t); onEmulatorLog(String(t)); },
      printErr: (t) => { console.warn('[ppsspp]', t); onEmulatorLog(String(t)); },
      setStatus: (t) => console.log('[status]', t),

      locateFile: (path) => {
        if (path.endsWith('.wasm')) return 'PPSSPPSDL.wasm';
        // The pthread worker reloads this same script under a different name.
        if (path.endsWith('.worker.js')) return 'PPSSPPSDL.js';
        return path;
      },

      // NOTE: emscripten snapshots Module["arguments"] into programArgs during
      // initRuntime, which happens BEFORE preRun runs. So argv must be set here,
      // at Module construction -- assigning it in preRun is silently too late.
      //
      // SDLMain also forwards argv verbatim and PPSSPP opens every non-flag
      // argument as a boot file, so this holds ONLY the in-FS game path. Passing
      // the program name here makes it try to open a file called "PPSSPPSDL".
      // Speed preference must be on Module before the wasm loop starts reading it.
      emuFpsOverride: readEmuFps(),

      arguments: pendingBytes
        ? [pendingBytes.dir || (GAME_DIR + '/' + pendingBytes.name)]
        : [],

      SDL2: {},

      // "Exit" (in PPSSPP's own menu or the pause menu), and any fatal graphics
      // error, hand control back to the host page from here.
      //
      // This is deliberately routed through Module.onEmulatorExit rather than
      // detected by the host: in the wasm build main() returns before any of its
      // native teardown runs, so the render loop just stops and the page is left
      // holding a dead canvas. Reloading is the only real reset, since the wasm
      // instance, its pthread pool and the WebGL context cannot be torn down
      // from JS.
      //
      // restart: 1 = PPSSPP asked to restart (e.g. backend change), 0 = exit.
      onEmulatorExit(restart) {
        console.log('[loader] emulator exited, restart =', restart);
        // Flush saves first. In the wasm build main() returns before any of its
        // teardown runs, so NativeShutdown() never writes them out for us.
        // populate = FALSE -> write MEMFS out to IndexedDB. See preRunHook for why
        // the argument is FALSE and not TRUE.
        try {
          if (this.FS && typeof this.IDBFS !== 'undefined') {
            this.FS.syncfs(false, (err) => {
              if (err) console.warn('[loader] save sync on exit failed:', err);
            });
          }
        } catch (e) {
          console.warn('[loader] save sync on exit threw:', e);
        }

        returnToPicker();
      },

      // preRunHook runs with `this` bound to Module and must not throw: emscripten
      // aborts the whole runtime if it does, and the abort reason carries no
      // useful message. Failures there are surfaced via preRunError instead.
      preRun: [function () {
        try {
          preRunHook.call(this);
        } catch (e) {
          window.__preRunError = e;
          console.error('[loader] preRun failed:', e);
        }
      }],

      onRuntimeInitialized() {
        if (window.__preRunError) {
          const e = window.__preRunError;
          say('Setup failed: ' + (e && e.message ? e.message : String(e)), 'err');
          reject(e);
          return;
        }
        try {
          STAGE.style.display = 'block';
          syncEscapeVisibility();
          if (bootState === 'idle') bootState = 'pending';
          updateBootBadge();
          CANVAS.focus();
          say(T('st.ready'), 'ok');
          resolve(this);
        } catch (e) {
          say('Runtime init failed: ' + (e && e.message ? e.message : String(e)), 'err');
          reject(e);
        }
      },

      onAbort(reason) {
        // emscripten often aborts with a bare value (or an object with no
        // .message), so stringify defensively rather than printing "undefined".
        const msg = (reason && reason.message)
          ? reason.message
          : (typeof reason === 'string' ? reason : JSON.stringify(reason));
        console.error('[loader] abort reason:', reason);
        say('Emulator aborted: ' + (msg === undefined ? '(no reason given)' : msg), 'err');
        reject(reason instanceof Error ? reason : new Error(msg || 'unknown abort'));
      },
    };

    window.Module = Module;
    progress(5);

    const script = document.createElement('script');
    script.src = 'PPSSPPSDL.js';
    script.onerror = () => {
      say('Failed to load PPSSPPSDL.js -- is the build in place?', 'err');
      reject(new Error('script load failed'));
    };
    script.onload = () => progress(60);
    document.body.appendChild(script);
  });

  return bootPromise;
}

// ---------------------------------------------------------------- library

// No persistent storage of any kind. Deliberate.
//
// This project stores nothing: not on the server, and not in the browser. The
// user picks a game from their own disk, it is read into memory for that
// session, and when the page reloads it is gone. The alternative -- keeping a
// copy in OPFS -- meant the browser quietly held hundreds of megabytes and the
// user had no obvious way to see or reclaim it. Playing straight from the file
// the user already has is the honest version of 'we host nothing'.

let libraryEntries = [];

// Files the user has supplied for the CURRENT page session. A JS Map, so it
// dies with the tab -- there is deliberately nothing on disk.
const sessionFiles = new Map();

function hasSessionFile(id) {
  return sessionFiles.has(id);
}

// An entry is playable if we have the file in memory right now, OR a remembered
// handle we can reopen. The handle is a path, not a copy.
function isReadyToPlay(id) {
  return hasSessionFile(id) || rememberedState.has(id);
}

// Remember files for this session only. A JS Map, so nothing is written to disk.
function rememberSessionFiles(entry, files) {
  if (!entry) return;
  sessionFiles.set(entry.id, files);
}

// ---------------------------------------------------------------- file handles
//
// Remembering WHERE a file is, without storing the file.
//
// showOpenFilePicker() returns a FileSystemFileHandle: a persistent token that
// points at a path on the user's disk and carries a read permission. Handles are
// structured-cloneable, so they can go in IndexedDB and survive reloads and
// browser restarts.
//
// What this stores: a handle, a few hundred bytes.
// What this does NOT store: the game. The bytes stay where they already are and
// are read fresh each time.
//
// This is why "remember the game without the browser eating gigabytes" is
// achievable -- it is a bookmark, not a cache.
//
// Chromium only. Safari and Firefox lack showOpenFilePicker, so there we fall
// back to picking the file each time.
const HANDLES_DB = 'ppsspp-web-handles';

function supportsFileHandles() {
  return typeof window.showOpenFilePicker === 'function' && typeof indexedDB !== 'undefined';
}

function handlesStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLES_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await handlesStore();
  return new Promise((res, rej) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(value, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function idbGet(key) {
  const db = await handlesStore();
  return new Promise((res, rej) => {
    const tx = db.transaction('handles', 'readonly');
    const rq = tx.objectStore('handles').get(key);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}

async function idbDelete(key) {
  const db = await handlesStore();
  return new Promise((res) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete(key);
    tx.oncomplete = res;
    tx.onerror = res;
  });
}

// Whether the remembered path is still readable without prompting.
async function handlePermission(handle) {
  try {
    if (typeof handle.queryPermission !== 'function') return 'granted';
    return await handle.queryPermission({ mode: 'read' });
  } catch (e) {
    return 'denied';
  }
}

// Prompt for access. Must be called from a user gesture.
async function requestHandlePermission(handle) {
  try {
    if (typeof handle.requestPermission !== 'function') return 'granted';
    return await handle.requestPermission({ mode: 'read' });
  } catch (e) {
    return 'denied';
  }
}

async function rememberHandle(entryId, handle) {
  await idbSet(entryId, { handle, name: handle.name, savedAt: Date.now() });
}

async function getHandle(entryId) {
  try {
    const rec = await idbGet(entryId);
    return rec ? rec.handle : null;
  } catch (e) {
    return null;
  }
}

async function forgetHandle(entryId) {
  await idbDelete(entryId);
}

// Pick a file and remember its location. Directory games need several files, and
// the standard picker has no folder mode, so those keep the plain picker.
async function pickAndRemember(entry) {
  let handle;
  try {
    const accept = {};
    if (!entry.files || !entry.files.length) {
      accept['application/octet-stream'] = ['.cso', '.iso', '.pbp', '.chd'];
    }
    [handle] = await window.showOpenFilePicker({ multiple: false, accept });
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
    throw e;
  }
  if (!handle) return;

  await rememberHandle(entry.id, handle);
  rememberedState.set(entry.id, handlePermissionCached(entry.id, 'prompt'));
  const file = await handle.getFile();
  const files = [file];
  rememberSessionFiles(entry, files);
  playSessionFiles(entry, files);
}

// Permission state per entry, refreshed on load.
const rememberedState = new Map();

function handlePermissionCached(id, fallback) {
  return rememberedState.get(id) || fallback;
}

// Read the files supplied for an entry and boot them.
//
// Directory games ("directory game" in PPSSPP: a folder containing EBOOT.PBP)
// are staged as a directory; everything else as a single image.
async function playSessionFiles(entry, files) {
  if (bootPromise) { say(T('st.alreadyRunning'), 'warn'); return; }

  const wantsDir = !!(entry && entry.files && entry.files.length);
  try {
    progress(5);

    if (wantsDir) {
      const byName = new Map();
      for (const f of files) {
        say(T('st.reading', { name: f.name, size: fmt(f.size) }));
        byName.set(f.name.toLowerCase(), new Uint8Array(await f.arrayBuffer()));
      }
      const missing = entry.files.filter((n) => !byName.has(n.toLowerCase()));
      if (missing.length) {
        throw new Error(T('st.missingMembers', { names: missing.join(', ') }));
      }
      const staged = entry.files.map((n) => [safeName(n), byName.get(n.toLowerCase())]);
      progress(85);
      await bootWith({ dir: GAME_DIR + '/' + safeName(entry.id), files: staged });
      return;
    }

    const f = files[0];
    say(T('st.reading', { name: f.name, size: fmt(f.size) }));
    const buf = new Uint8Array(await f.arrayBuffer());
    progress(85);
    await bootWith({ name: safeName(f.name), data: buf });
  } catch (e) {
    console.error('[loader] play failed:', e);
    say(T('st.loadFailed', { msg: e && e.message ? e.message : String(e) }), 'err');
  }
}

// Where "Download" sends the user.
//
// The listing is unusable for finding one specific game among hundreds, which is
// what people were resorting to Cmd+F for. A Text Fragment (#:~:text=) was the
// obvious fix: the browser scrolls to and highlights the matching row.
//
// It does not work here, and that is a property of the target page rather than
// a bug in the fragment. archive.org's directory listing renders ~1,200 rows
// (the whole PSP CSO dump) into a document tens of thousands of pixels tall.
// Verified in Chrome against the live page: the fragment is accepted -- the row
// text matches exactly one element -- but scrollY stays 0 and the target never
// enters the viewport. A plain listing load is not a viable fallback either,
// since it lands the user at row "A" with nothing in view.
//
// So Download points straight at the file. archive.org 302s to the item server,
// which responds 200 with Content-Disposition: attachment, so the browser saves
// the file instead of rendering it. This is strictly better anyway: one click
// from the tile to the file on disk, with no index to read.
//
// sourceText is kept as the exact filename, which is what makes the direct URL
// correct and is worth having as data even where the fragment is unreliable.

// sourceFile must be the COMPLETE filename, not a substring. Archive.org matches
// direct URLs exactly, so "Liberty City Stories (USA).cso" is a 404 -- the row is
// really "Grand Theft Auto - Liberty City Stories (USA).cso". A Text Fragment
// tolerated a partial match, which is exactly why the truncation went unnoticed
// while the fragment approach was in use.
function sourceUrl(g) {
  const base = g.source || '';
  if (g.sourceFile) {
    const dir = base.endsWith('/') ? base : base + '/';
    return dir + encodeURIComponent(g.sourceFile);
  }
  if (!g.sourceText) return base;
  return base + '#:~:text=' + encodeURIComponent(g.sourceText);
}

// Pull files out of a drop, walking directories when the browser exposes them.
async function filesFromDataTransfer(dt) {
  if (!dt) return [];
  const out = [];
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);

  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push(prefix ? new File([file], prefix + '/' + file.name, { type: file.type }) : file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, entry.name);
      }
    }
  };

  if (entries.length) {
    for (const e of entries) await walk(e, '');
  } else {
    for (const f of Array.from(dt.files || [])) out.push(f);
  }

  // A dropped folder flattens to "Folder/EBOOT.PBP"; take the basename, which is
  // what PPSSPP expects inside the entry directory.
  return out.map((f) => {
    if (f.name.includes('/')) {
      return new File([f], f.name.split('/').pop(), { type: f.type });
    }
    return f;
  });
}

// ---------------------------------------------------------------- tile actions

// Build the per-entry controls: Play on the artwork, Download and Upload stacked
// on the right. Kept out of the tile's own click handler so each control can have
// its own behaviour.
function tileActions(g, tile) {
  // Nothing is hosted, so playability depends entirely on whether the user has
  // supplied a copy into browser storage.

  // ---- Play, overlaid on the artwork
  const play = document.createElement('button');
  play.className = 'playbtn';
  play.type = 'button';
  play.innerHTML = '<span class="tri"></span><span>' + T('lib.play') + '</span>';
  // Play, in order of preference: the file already in memory, then a remembered
  // path on the user's disk, then ask.
  play.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (bootPromise) { say(T('st.alreadyRunning'), 'warn'); return; }

    if (hasSessionFile(g.id)) { playSessionFiles(g, sessionFiles.get(g.id)); return; }

    if (rememberedState.has(g.id)) {
      const handle = await getHandle(g.id);
      if (handle) {
        let perm = await handlePermission(handle);
        // Re-granting needs a user gesture -- this click is one.
        if (perm !== 'granted') perm = await requestHandlePermission(handle);
        if (perm === 'granted') {
          try {
            const file = await handle.getFile();
            const files = [file];
            rememberSessionFiles(g, files);
            playSessionFiles(g, files);
            return;
          } catch (e) {
            console.warn('[loader] remembered file unreadable:', e);
          }
        }
        // Permission withdrawn or the file moved: fall back to asking.
        rememberedState.delete(g.id);
      }
    }

    const canRemember = supportsFileHandles() && !(g.files && g.files.length);
    if (canRemember) {
      try { await pickAndRemember(g); return; } catch (err) {
        console.error('[loader] picker failed:', err);
      }
    }

    const picker = document.getElementById('file');
    picker.value = '';
    picker.dataset.target = g.id;
    picker.multiple = !!(g.files && g.files.length);
    picker.click();
  });
  artOverlay(tile, play);

  // ---- Download, to the source page
  const side = document.createElement('div');
  side.className = 'sideact';

  if (g.source) {
    const dl = document.createElement('a');
    dl.className = 'act';
    dl.href = sourceUrl(g);
    dl.target = '_blank';
    dl.rel = 'noopener noreferrer';
    dl.innerHTML = '<span>' + T('lib.download') + '</span>';
    dl.title = g.source;
    dl.addEventListener('click', (e) => e.stopPropagation());
    side.appendChild(dl);
  }

  // Only meaningful once a path has been remembered for this entry.
  if (rememberedState.has(g.id)) {
    const forget = document.createElement('button');
    forget.className = 'act del';
    forget.type = 'button';
    forget.innerHTML = '<span>' + T('lib.forget') + '</span>';
    forget.title = T('lib.forgetHint');
    forget.addEventListener('click', async (e) => {
      e.stopPropagation();
      await forgetHandle(g.id);
      rememberedState.delete(g.id);
      sessionFiles.delete(g.id);
      const t2 = tile.querySelector('.playbtn');
      if (t2) t2.classList.add('needs');
      forget.remove();
    });
    side.appendChild(forget);
  }

  tile.querySelector('.meta').appendChild(side);
  return side;
}

function artOverlay(tile, node) {
  const art = tile.querySelector('.art');
  if (art) art.appendChild(node);
}

// Renders the one-click library from library.json. Kept deliberately dumb: it
// only knows how to fetch a URL and hand the bytes to runGame().
async function loadLibrary() {
  const grid = document.getElementById('grid');
  if (!grid) return;

  let manifest;
  try {
    const res = await fetch('library.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    manifest = await res.json();
  } catch (e) {
    console.warn('[loader] no library manifest:', e);
    grid.remove();
    return;
  }

  const games = (manifest && manifest.games) || [];
  if (!games.length) { grid.remove(); return; }
  libraryEntries = games;

  // Restore any remembered file paths and check whether we can still read them.
  // No permission prompt here -- that has to wait for a click.
  if (supportsFileHandles()) {
    for (const g of games) {
      if (g.files && g.files.length) continue;   // directory games: not handled
      const h = await getHandle(g.id);
      if (h) rememberedState.set(g.id, await handlePermission(h));
    }
  }

  for (const g of games) {
    grid.appendChild(libraryTile(g));
  }
  // Apply any active search filter to the freshly built grid.
  if (typeof filterLibrary === 'function') filterLibrary();
}

function libraryTile(g) {
  // An entry with only a link has nothing to launch here, so it must not look
  // or behave like the hosted ones -- that would promise a launch and then
  // silently do nothing.
  // A <button> cannot legally contain a link or another <button>, and the
  // per-tile controls need to be real interactive elements. Use a div with
  // button semantics instead so the nesting is valid.
  const externalOnly = !g.file && !!g.link;
  const tile = document.createElement('div');
  tile.className = 'tile' + (externalOnly ? ' ext' : '');
  tile.setAttribute('role', 'button');
  tile.setAttribute('tabindex', '0');

  const initials = (g.title || '?').split(/\s+/).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase();

  const art = document.createElement('div');
  art.className = 'art';

  // Cover art is optional per entry. The initials are the fallback, and stay
  // hidden until the image proves it can load -- a broken icon must never leave
  // a blank rectangle where the tile used to say something.
  const ini = document.createElement('span');
  ini.className = 'initials';
  ini.textContent = initials;

  if (g.icon) {
    const img = document.createElement('img');
    img.className = 'cover';
    img.src = g.icon;
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('error', () => img.remove(), { once: true });
    img.addEventListener('load', () => art.classList.add('has-cover'), { once: true });
    art.appendChild(img);
  }
  art.appendChild(ini);

  const badgeText = externalOnly ? T('lib.extBadge') : g.badge;
  if (badgeText) {
    const b = document.createElement('span');
    b.className = 'badge' + (externalOnly ? ' ext' : '');
    b.textContent = badgeText;
    art.appendChild(b);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = g.title || g.file || g.link;
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = [
    g.subtitle,
    g.size ? fmt(g.size) : null,
    externalOnly ? T('lib.extSub') : null,
  ].filter(Boolean).join(' · ');
  meta.append(title, sub);

  // Source link. A nested <a> inside a <button> is invalid HTML, so the link is
  // a sibling and the tile itself is what launches.
  tile.append(art, meta);

  if (g.source) {
    const a = document.createElement('a');
    a.className = 'srclink';
    a.href = sourceUrl(g);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = g.linkLabel || T('lib.srcLink');
    a.title = g.source;
    a.addEventListener('click', (e) => e.stopPropagation());
    meta.appendChild(a);
  }

  if (g.notes) tile.title = g.notes;

  // Search matches title and subtitle. Deliberately excludes anything we
  // translate: game names are data and stay verbatim in every language.
  const searchBlob = [g.title, g.subtitle, g.badge, g.linkLabel].filter(Boolean).join(' ').toLowerCase();
  tile.dataset.search = searchBlob;
  tile.dataset.title = g.title || '';
  tile.dataset.entry = g.id || '';

if (g.id) {
    tileActions(g, tile);
    if (isReadyToPlay(g.id)) {
      const p = tile.querySelector('.playbtn');
      if (p) p.classList.remove('needs');
    }
  }

  // Clicking the tile body is the same as Play.
  tile.addEventListener('click', () => {
    const p = tile.querySelector('.playbtn');
    if (p) p.click();
  });

  // Drag a game image (or a folder, for directory games) onto the tile to play
  // it immediately. Nothing is kept -- the drop is read once and discarded.
  tile.addEventListener('dragover', (e) => { e.preventDefault(); tile.classList.add('over'); });
  tile.addEventListener('dragleave', () => tile.classList.remove('over'));
  tile.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    tile.classList.remove('over');
    const dropped = await filesFromDataTransfer(e.dataTransfer);
    if (!dropped.length) return;
    rememberSessionFiles(g, dropped);
    playSessionFiles(g, dropped);
  });

  tile.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tile.click(); }
  });
  return tile;
}

// Fetch a library image and launch it. Same path as a local file, except the
// bytes come over HTTP instead of off disk.
//
// Handles both single-file images (.cso/.iso) and PPSSPP "directory games" -- a
// folder containing EBOOT.PBP plus its data files, which is how most homebrew
// ships and needs no ISO conversion.
async function runFromLibrary(entry) {
  if (bootPromise) {
    say(T('st.alreadyRunning'), 'warn');
    idle();
    return;
  }
  try {
    progress(5);
    say(T('st.fetching', { name: entry.title }));

    if (entry.files) {
      // Directory game: fetch each member into a subdirectory.
      const dir = GAME_DIR + '/' + safeName(entry.id || entry.title);
      const staged = [];
      let done = 0;
      for (const [name, path] of entry.files) {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
        const buf = new Uint8Array(await res.arrayBuffer());
        staged.push([safeName(name), buf]);
        done++;
        progress(Math.max(5, Math.min(80, (done / entry.files.length) * 80)));
      }
      progress(85);
      say(T('st.startingName', { name: entry.title }));
      await bootWith({ dir, files: staged });
      return;
    }

    const res = await fetch(entry.file, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + entry.file);

    const total = Number(res.headers.get('content-length')) || entry.size || 0;
    let buf;
    if (res.body && total) {
      // Stream so the progress bar reflects real bytes rather than jumping.
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        chunks.push(value);
        got += value.length;
        progress(Math.max(5, Math.min(80, (got / total) * 80)));
      }
      buf = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
    } else {
      buf = new Uint8Array(await res.arrayBuffer());
    }

    const name = safeName(entry.file.split('/').pop());
    progress(85);
    say(T('st.startingName', { name: entry.title }));
    await bootWith({ name, data: buf });
  } catch (e) {
    console.error('[loader] library launch failed:', e);
    say('Could not load ' + (entry.title || entry.file) + ': ' +
        (e && e.message ? e.message : String(e)), 'err');
    idle();
  }
}

// Speed preference lives in localStorage (owned by settings.js). Read it here so
// the value is available at Module construction, before the loop starts.
function readEmuFps() {
  try {
    const raw = JSON.parse(localStorage.getItem('ppsspp-web:settings') || '{}');
    const v = parseInt(raw.emuFps, 10);
    if (v === 30 || v === 60) return v;
  } catch (e) { /* fall through */ }
  return 30;
}

// Shared launch path for library entries and local files: argv is read once
// inside main(), so the image must be staged before the runtime starts.
async function bootWith(staged) {
  pendingBytes = staged;
  progress(95);
  await boot();
  idle();
}

// ---------------------------------------------------------------- diagnostics

// A black screen is ambiguous: the game may still be loading, may have failed to
// boot, or may have booted and be rendering nothing. PPSSPP tells us which, but
// only in its log stream, so classify those lines and surface the result.
const BOOT = {
  pending: 'Loading',
  running: 'Running',
  failed: 'Failed to boot',
  rendering: 'Booted, no frames yet',
};

let bootState = 'idle';
let bootDetail = '';

const FAIL_PATTERNS = [
  /Boot failed/i,
  /didn't recognize file/i,
  /Not a PSP game/i,
  /Failed to (?:open|read|load|init|create)/i,
  /EBOOT\.PBP (?:not )?found/i,
  /Error:/i,
];

const OK_PATTERNS = [
  /Booted\s+\//i,
  /PPSSPP\s+\d/i,
];

function onEmulatorLog(text) {
  if (FAIL_PATTERNS.some((re) => re.test(text))) {
    bootState = 'failed';
    bootDetail = text.replace(/\x1b\[[0-9;]*m/g, '').slice(-160).trim();
    updateBootBadge();
  } else if (/Booted\s+\//i.test(text)) {
    bootState = 'running';
    bootDetail = text.replace(/\x1b\[[0-9;]*m/g, '').slice(-160).trim();
    updateBootBadge();
  }
}

function updateBootBadge() {
  const el = document.getElementById('bootBadge');
  if (!el) return;
  el.textContent = BOOT[bootState] || bootState;
  el.className = 'badge-' + bootState;
}

// ---------------------------------------------------------------- game

async function runGame(file) {
  try {
    // Booting lazily on first game selection means we only ever boot once.
    if (bootPromise) {
      say(T('st.alreadyRunning'), 'warn');
      idle();
      return;
    }

    // Large images are slow to materialise: a 200 MB file spends ~10s in
    // arrayBuffer() alone on the main thread, plus another copy into MEMFS.
    // Without per-phase reporting that reads as a hang, so keep the status line
    // honest about what is actually happening.
    progress(5);
    say(T('st.reading', { name: file.name, size: fmt(file.size) }));
    const t0 = performance.now();

    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (e) {
      throw new Error('could not read the file from disk: ' + (e && e.message ? e.message : String(e)));
    }

    progress(80);
    say(T('st.loaded', {
      size: fmt(buf.byteLength),
      secs: Math.round((performance.now() - t0) / 100) / 10,
    }));
    // Yield so the status line paints before the synchronous write blocks.
    await new Promise((r) => setTimeout(r, 30));

    progress(90);
    await bootWith({ name: safeName(file.name), data: new Uint8Array(buf) });
    console.log('[loader] total load time', Math.round(performance.now() - t0), 'ms');
  } catch (e) {
    console.error('[loader] load failed:', e);
    // e.message can be missing on emscripten abort values; never print undefined.
    const msg = (e && e.message) ? e.message : String(e);
    say('Could not load game: ' + msg, 'err');
    idle();
  }
}

function fmt(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}

document.addEventListener('DOMContentLoaded', () => {
  loadLibrary();

  const problems = checkEnvironment();
  if (problems.length) {
    say('Cannot start: ' + problems[0], 'err');
    PICK.disabled = true;
    DROP.querySelector('p').textContent = problems.join(' ');
    return;
  }

  PICK.addEventListener('click', () => { FILE.dataset.target = ''; FILE.multiple = false; FILE.click(); });
  FILE.addEventListener('change', async () => {
    const files = Array.from(FILE.files || []);
    const target = FILE.dataset.target;
    if (!files.length) return;

    const entry = target ? libraryEntries.find((e) => e.id === target) : null;
    if (!entry) {
      // No entry chosen (the general drop area): just play it.
      runGame(files[0]);
      return;
    }
    // Remembered only for this page session; nothing is written anywhere.
    rememberSessionFiles(entry, files);
    playSessionFiles(entry, files);
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    DROP.addEventListener(ev, (e) => { e.preventDefault(); DROP.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    DROP.addEventListener(ev, (e) => { e.preventDefault(); DROP.classList.remove('over'); }));

  DROP.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) runGame(f);
  });

  window.addEventListener('gamepadconnected', () => console.log('gamepad connected'));
  CANVAS.addEventListener('click', () => CANVAS.focus());

  // Available whenever the emulator is on screen, so a frozen frame is never a
  // dead end.
  installEscapeHatch();

  // Expose save syncing for manual flushes on unload.
  window.addEventListener('pagehide', () => {
    try { if (window.Module && window.Module.FS) window.Module.FS.syncfs(false, () => {}); } catch (e) {}
  });
});