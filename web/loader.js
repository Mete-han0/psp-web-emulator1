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

// Public catalog and personal library are separate. Persist only small metadata
// and supported file handles; game bytes remain on the user's disk or in the
// current session's File objects, never copied to persistent browser storage.
let libraryEntries = [];
let libraryLoadPromise = Promise.resolve();
const sessionFiles = new Map();
const OWNED_KEY = 'ppsspp-web:owned-library-v1';
const ownedEntries = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(OWNED_KEY) || '[]');
  if (Array.isArray(saved)) {
    for (const g of saved) {
      if (g && typeof g.id === 'string' && typeof g.title === 'string') {
        ownedEntries.set(g.id, g);
      }
    }
  }
} catch (e) { console.warn('[library] metadata unavailable:', e); }

function saveOwnedEntries() {
  try { localStorage.setItem(OWNED_KEY, JSON.stringify(Array.from(ownedEntries.values()))); }
  catch (e) { console.warn('[library] metadata was not saved:', e); }
}
function hasSessionFile(id) { return sessionFiles.has(id); }
function isReadyToPlay(id) { return hasSessionFile(id) || rememberedState.has(id); }

function localEntry(file) {
  const normalized = (name) => String(name || '').toLowerCase().replace(/\.(cso|iso|pbp|chd)$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const match = libraryEntries.find((g) =>
    normalized(g.sourceFile || g.sourceText) === normalized(file.name) ||
    normalized(g.title) === normalized(file.name));
  if (match) return match;
  let hash = 2166136261;
  for (const c of file.name.toLowerCase() + ':' + file.size) {
    hash ^= c.charCodeAt(0); hash = Math.imul(hash, 16777619);
  }
  return { id: 'local-' + (hash >>> 0).toString(16), title: file.name.replace(/\.(cso|iso|pbp|chd)$/i, ''), badge: 'LOCAL' };
}

function rememberSessionFiles(entry, files) {
  const source = entry || localEntry(files[0]);
  const previous = ownedEntries.get(source.id);
  const record = {
    id: source.id, title: source.title, subtitle: source.subtitle || '',
    icon: source.icon || '', badge: source.badge || 'LOCAL',
    files: source.files || null, fileName: files[0].name,
    size: files.reduce((n, f) => n + f.size, 0),
    addedAt: Date.now(), lastPlayedAt: previous ? previous.lastPlayedAt || 0 : 0,
  };
  ownedEntries.set(record.id, record);
  sessionFiles.set(record.id, files);
  saveOwnedEntries();
  renderCollections();
  return record;
}

function markPlayed(entry) {
  const record = entry && ownedEntries.get(entry.id);
  if (record) { record.lastPlayedAt = Date.now(); saveOwnedEntries(); }
}

function acceptFiles(entry, files) {
  if (!files.length) return null;
  if (entry && entry.files && entry.files.length) {
    const names = new Set(files.map((f) => f.name.toLowerCase()));
    const missing = entry.files.filter((n) => !names.has(n.toLowerCase()));
    if (missing.length) { say(T('st.missingMembers', { names: missing.join(', ') }), 'err'); return null; }
  } else if (!/\.(cso|iso|pbp|chd)$/i.test(files[0].name)) {
    say(T('st.invalidFile'), 'err'); return null;
  }
  return rememberSessionFiles(entry, files);
}

function revealLibrary(record) {
  if (typeof window.setCatalogTab === 'function') window.setCatalogTab('library');
  say(T('st.added', { name: record.title }), 'ok');
  document.getElementById('librarySection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function chooseEntry(entry, launch = false) {
  if (supportsFileHandles() && !(entry && entry.files && entry.files.length)) {
    try { await pickAndRemember(entry, launch); return; }
    catch (e) { console.warn('[library] native picker unavailable:', e); }
  }
  FILE.value = '';
  FILE.dataset.target = entry ? entry.id : '';
  FILE.dataset.launch = String(launch);
  FILE.multiple = !!(entry && entry.files && entry.files.length);
  FILE.click();
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
  try { await idbDelete(entryId); }
  catch (e) { console.warn('[library] remembered location could not be removed:', e); }
}

// Pick a file and remember its location. Directory games need several files, and
// the standard picker has no folder mode, so those keep the plain picker.
async function pickAndRemember(entry, launch = false) {
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'PSP game', accept: { 'application/octet-stream': ['.cso', '.iso', '.pbp', '.chd'] } }],
    });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    throw e;
  }
  if (!handle) return;
  const files = [await handle.getFile()];
  await libraryLoadPromise;
  const record = acceptFiles(entry, files);
  if (!record) return;
  try {
    await rememberHandle(record.id, handle);
    rememberedState.set(record.id, 'granted');
  } catch (e) { console.warn('[library] file location was not saved:', e); }
  renderCollections();
  revealLibrary(record);
  if (launch) await playSessionFiles(record, files);
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
      markPlayed(entry);
      return;
    }

    const f = files[0];
    say(T('st.reading', { name: f.name, size: fmt(f.size) }));
    const buf = new Uint8Array(await f.arrayBuffer());
    progress(85);
    await bootWith({ name: safeName(f.name), data: buf });
    markPlayed(entry);
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
// Download opens the collection's listing page (some 1,200 rows) and jumps to
// the row, rather than fetching the file. The Text Fragment (#:~:text=) is what
// does the jumping: the browser scrolls the match into view and highlights it.
// Supported in Chrome 89+ and Safari 16.1+; elsewhere the link still lands on a
// working listing.
//
// One behaviour worth knowing, because it looks like a bug and is not: the
// fragment is honoured only while the tab has focus. Opening the link into a new
// background tab leaves the listing at scroll position 0 with nothing highlighted
// -- verified in Chrome, where the same URL in a focused tab scrolls correctly.
// So the link deliberately does NOT open in a new tab. One tab, focused, the row
// visible and highlighted, which is what this button is for.
//
// Fragment text must avoid " - " (space-hyphen-space). Verified in Chrome against
// the live listing: every full-filename fragment containing " - " fails to scroll
// (scrollY stays 0, target never enters the viewport), while fragments without it
// succeed -- including ones with apostrophes, exclamation marks and parentheses.
// Entries that need it carry `sourceFragment`: a short, punctuation-light,
// case-insensitively unique substring of the row. Entries without one keep the
// full filename, which is why working entries must not gain this field.
function sourceUrl(g) {
  const base = g.source || '';
  // sourceFragment overrides only where the full row name will not match; the
  // fallback order for everything else is unchanged, so working entries produce
  // byte-identical URLs with or without this field present elsewhere.
  const row = g.sourceFragment || g.sourceFile || g.sourceText;
  if (!row) return base;
  return base + '#:~:text=' + encodeURIComponent(row);
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
function tileActions(g, tile, owned = false) {
  const side = document.createElement('div');
  side.className = 'sideact';
  if (owned) {
    const play = document.createElement('button');
    play.className = 'playbtn needs';
    play.type = 'button';
    play.innerHTML = '<span class="tri"></span><span>' + T(isReadyToPlay(g.id) ? 'lib.play' : 'lib.selectFile') + '</span>';
    play.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (bootPromise) { say(T('st.alreadyRunning'), 'warn'); return; }
      if (hasSessionFile(g.id)) { await playSessionFiles(g, sessionFiles.get(g.id)); return; }
      if (rememberedState.has(g.id)) {
        const handle = await getHandle(g.id);
        if (handle) {
          let perm = await handlePermission(handle);
          if (perm !== 'granted') perm = await requestHandlePermission(handle);
          if (perm === 'granted') {
            try {
              const files = [await handle.getFile()];
              const record = acceptFiles(g, files);
              if (record) await playSessionFiles(record, files);
              return;
            } catch (err) { console.warn('[library] remembered file unreadable:', err); }
          }
        }
        rememberedState.delete(g.id);
      }
      await chooseEntry(g, true);
    });
    artOverlay(tile, play);

    const remove = document.createElement('button');
    remove.className = 'act del';
    remove.type = 'button';
    remove.textContent = T('lib.remove');
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      await forgetHandle(g.id);
      rememberedState.delete(g.id);
      sessionFiles.delete(g.id);
      ownedEntries.delete(g.id);
      saveOwnedEntries();
      renderCollections();
      say(T('st.removed', { name: g.title }), 'ok');
    });
    side.appendChild(remove);
  } else {
    if (g.source) {
      const dl = document.createElement('a');
      dl.className = 'act'; dl.href = sourceUrl(g); dl.rel = 'noopener noreferrer';
      dl.textContent = T('lib.download');
      dl.addEventListener('click', (e) => e.stopPropagation());
      side.appendChild(dl);
    }
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'act have';
    add.textContent = T('lib.addToLibrary');
    add.addEventListener('click', (e) => { e.stopPropagation(); chooseEntry(g, true); });
    side.appendChild(add);
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
  try {
    const res = await fetch('library.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const manifest = await res.json();
    libraryEntries = Array.isArray(manifest.games) ? manifest.games : [];
  } catch (e) { console.warn('[library] public catalog unavailable:', e); }
  if (supportsFileHandles()) {
    const candidates = new Map(libraryEntries.map((g) => [g.id, g]));
    for (const g of ownedEntries.values()) candidates.set(g.id, g);
    for (const g of candidates.values()) {
      if (g.files && g.files.length) continue;
      const handle = await getHandle(g.id);
      if (!handle) continue;
      rememberedState.set(g.id, await handlePermission(handle));
      // Preserve games remembered by the previous single-grid version.
      if (!ownedEntries.has(g.id)) {
        ownedEntries.set(g.id, { id: g.id, title: g.title, subtitle: g.subtitle || '', icon: g.icon || '', badge: g.badge || 'LOCAL', fileName: handle.name, addedAt: Date.now(), lastPlayedAt: 0 });
      }
    }
    saveOwnedEntries();
  }
  renderCollections();
  PICK.disabled = checkEnvironment().length > 0;
}

function renderCollections() {
  const ownedGrid = document.getElementById('ownedGrid');
  const publicGrid = document.getElementById('grid');
  if (!ownedGrid || !publicGrid) return;
  ownedGrid.replaceChildren(); publicGrid.replaceChildren();
  const owned = Array.from(ownedEntries.values()).sort((a, b) =>
    Math.max(b.addedAt || 0, b.lastPlayedAt || 0) - Math.max(a.addedAt || 0, a.lastPlayedAt || 0));
  for (const g of owned) ownedGrid.appendChild(libraryTile(g, true));
  for (const g of libraryEntries) publicGrid.appendChild(libraryTile(g, false));
  const empty = document.getElementById('libraryEmpty');
  if (empty) empty.hidden = owned.length !== 0;
  const ownedCount = document.getElementById('libraryCount');
  const publicCount = document.getElementById('publicCount');
  if (ownedCount) ownedCount.textContent = String(owned.length);
  if (publicCount) publicCount.textContent = String(libraryEntries.length);
  if (typeof filterLibrary === 'function') filterLibrary();
}
document.addEventListener('langchange', renderCollections);

function libraryTile(g, owned = false) {
  // An entry with only a link has nothing to launch here, so it must not look
  // or behave like the hosted ones -- that would promise a launch and then
  // silently do nothing.
  // A <button> cannot legally contain a link or another <button>, and the
  // per-tile controls need to be real interactive elements. Use a div with
  // button semantics instead so the nesting is valid.
  const externalOnly = !g.file && !!g.link;
  const tile = document.createElement('div');
  tile.className = 'tile' + (owned ? ' owned-tile' : ' public-tile');
  if (owned) { tile.setAttribute('role', 'button'); tile.setAttribute('tabindex', '0'); }

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

  const badgeText = g.badge === 'LOCAL' ? T('lib.localBadge') : (externalOnly ? T('lib.extBadge') : g.badge);
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

  if (g.source && !owned) {
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
    tileActions(g, tile, owned);
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
    const record = acceptFiles(g, dropped);
    if (record) revealLibrary(record);
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
  PICK.disabled = true;
  libraryLoadPromise = loadLibrary();

  const problems = checkEnvironment();
  if (problems.length) {
    say('Cannot start: ' + problems[0], 'err');
    PICK.disabled = true;
    DROP.querySelector('p').textContent = problems.join(' ');
    return;
  }

  PICK.addEventListener('click', () => chooseEntry(null, true));
  FILE.addEventListener('change', async () => {
    const files = Array.from(FILE.files || []);
    if (!files.length) return;
    await libraryLoadPromise;
    const target = FILE.dataset.target;
    const entry = ownedEntries.get(target) || libraryEntries.find((g) => g.id === target);
    const record = acceptFiles(entry, files);
    if (!record) return;
    revealLibrary(record);
    if (FILE.dataset.launch === 'true') await playSessionFiles(record, files);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    DROP.addEventListener(ev, (e) => { e.preventDefault(); DROP.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    DROP.addEventListener(ev, (e) => { e.preventDefault(); DROP.classList.remove('over'); }));
  DROP.addEventListener('drop', async (e) => {
    const files = await filesFromDataTransfer(e.dataTransfer);
    await libraryLoadPromise;
    const record = acceptFiles(null, files);
    if (record) revealLibrary(record);
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
