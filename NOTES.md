# PPSSPP Web — build notes

Browser build of the PPSSPP emulator (PSP), where the user supplies their own game
file from their own machine. Nothing is uploaded; there is no server-side game
storage by design.

## Status

Working, verified end to end with a synthetic CSO:

- wasm build compiles and boots (VFS registered, G3D initialised, SDL audio up)
- game file is mounted into the emulated filesystem at `/games/<name>`
- argv reaches PPSSPP correctly, so it opens the file instead of looking for a
  file named `PPSSPPSDL`
- saves persist via IDBFS mounted over `/home/web_user`
- "Exit" in the PPSSPP menu returns to the picker instead of freezing

Not yet verified: actual gameplay with a real game, gamepad input, save round-trip.

## Layout

    build.sh          builds the wasm via the fork's own `make wasm-release`
    serve.py          dev server; adds the COOP/COEP headers the build needs
    web/index.html    host page (library grid + local file drop)
    web/loader.js     mount / argv / persistence / library launch
    web/settings.js   shared settings state + FPS overlay
    web/topbar.js     status chips and their popovers
    web/library.json  library manifest — one-click entries
    web/i18n.js       TR/EN dictionaries and the search filter
    web/icons/        per-entry cover art, if present
    web/PPSSPPSDL.*   build output (js, wasm, data) — committed, ~36 MB

## Build

    ./build.sh

Uses `root-hunter/ppsspp-wasm` (branch `wasm`), an unofficial WebAssembly fork of
PPSSPP. Upstream PPSSPP: https://github.com/hrydgard/ppsspp

Two deviations from the fork's stock flags, both in `ppsspp-wasm/CMakeLists.txt`:

- `-lidbfs.js` — so saves can persist to IndexedDB
- `-sEXPORTED_RUNTIME_METHODS=[FS,IDBFS,WORKERFS,...]` — the host page needs the
  FS handles to mount the game

Toolchain notes for this machine (macOS, no Homebrew):

- CMake must be 3.x. Submodules declare `cmake_minimum_required` as low as 2.4.4,
  which CMake 4.x rejects outright. Installed 3.31.10 via `uv tool install`.
- emsdk needs Python >= 3.10; system Python is 3.9. Standalone 3.12/3.13 via `uv`
  and emsdk's own bundled Python, both put ahead of `/usr/bin` on PATH.
- `ninja` comes from `pip3 install --user ninja`.

## Deployment constraint (important)

The fork hardcodes `-pthread`, so the build needs `SharedArrayBuffer`, which
browsers only expose to cross-origin-isolated documents. The page will not run
without these two headers:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

Netlify and Cloudflare Pages can set both. **Plain GitHub Pages cannot**, so it
will silently fail there. `serve.py` sets them for local development.

SIMD128 is also hardcoded, with no non-SIMD fallback compiled in.

## Known limitation: memory

PPSSPP's emulated filesystem reads synchronously, and the main thread forbids
synchronous XHR. `FS.createLazyFile()` depends on exactly that and aborts with:

    Cannot do synchronous binary XHRs outside webworkers

`WORKERFS`, `FileReaderSync` and OPFS sync access handles are worker-only. So the
current design reads the whole image into the wasm heap (`file.arrayBuffer()`, then
`FS.writeFile`). Peak memory is roughly the file size.

CSO is compressed, so this is usually a few hundred MB rather than the ~1.8 GB of
a raw ISO.

**The ceiling is higher than it first looks.** Verified with a 583 MB hosted `.cso`,
comfortably past the 512 MB initial heap: it loads, `ALLOW_MEMORY_GROWTH` grows the
heap, it boots, and it holds ~29/30 Hz. So the practical limit is not memory
failure — it is load time (~20s to fetch and stage a file that size) and the
browser's tab memory budget.

Moving the emulator into a Worker would still be the right fix, because `WORKERFS`
would avoid materialising the image in the JS heap at all — but it is an
optimisation now, not a correctness blocker.

The fix is architectural: move the emulator into a Worker and drive it through
`OffscreenCanvas` + `AudioWorklet`. `WORKERFS` would then mount the user's `File`
directly and reads would stay off the JS heap. That is the single highest-value
next step and would remove the size ceiling.

## Emulator-specific gotchas (all cost real debugging time)

- **argv ordering.** Emscripten snapshots `Module.arguments` into `programArgs`
  during `initRuntime`, which runs *before* `preRun`. Assigning argv inside
  `preRun` is silently too late — it must be set at Module construction.
- **argv contents.** SDLMain forwards argv verbatim and PPSSPP opens every
  non-flag argument as a boot file. So `arguments` must contain only the in-FS
  game path, never the program name, or it tries to open a file called `PPSSPPSDL`.
- **IDBFS deadlock.** Do not `addRunDependency('idbfs')`. IDBFS only touches
  IndexedDB when `syncfs()` is called, so a run dependency never resolves and the
  runtime hangs before `onRuntimeInitialized` forever.
- **`preRun` must not throw.** Emscripten aborts the entire runtime if it does,
  and the abort reason carries no useful message, so failures surface as
  `undefined`. Wrap it and capture the error.
- **`FS.mounts` is misleading.** For top-level mounts this emscripten version
  records the mount on the node (`node.mounted`), leaving `FS.mounts` empty. Check
  `FS.isMountpoint()` instead.
- FFmpeg is off (`-DUSE_FFMPEG=OFF`, set by the fork's Makefile), so video decode
  uses PPSSPP's software path.

## Exiting back to the host page

Every exit path is routed to `Module.onEmulatorExit()` in the host, which flushes
saves and reloads to the picker. Two layers:

- **`System_MakeRequest()`** in `SDL/SDLMain.cpp` calls `NotifyHostOfExit()` for
  `EXIT_APP` and `RESTART_APP`. This is the single choke point every exit funnels
  through — the main-menu Exit button, and the `VIRTKEY_EXIT_APP` path — so
  hooking it here is far more reliable than polling a flag in the render loop.
- **`EmscriptenMainLoop()`** also calls it when it observes `g_QuitRequested`, as
  a backstop for anything that sets the flag without going through the request
  handler (e.g. `SDL_QUIT`).

The pause-menu Exit is deliberately **left alone**. `PauseMenuExitsEmulator` defaults
to `false`, so `GamePauseScreen::OnExit` sets `finishNextFrame_` and returns the
user to PPSSPP's own `MainScreen` rather than exiting. That already works, and it
is a genuinely different action from "leave the site" — an earlier attempt to route
it through `System_ExitApp()` broke the in-game return-to-menu. Only the
main-menu/`VIRTKEY_EXIT_APP` exit, which means leaving the site, goes to the host.

### Escape hatch

A "Back to picker" button sits top-left whenever the emulator is on screen. If an
exit path ever fails to notify the host, the user is never trapped on a dead frame.
It syncs saves and reloads. It is deliberately unobtrusive: hidden until the
pointer moves, fading ~2.6s after the pointer stops, and always visible on
keyboard focus and on touch devices (where there is no hover to reveal it).

Gotcha worth remembering: `clearTimeout(id)` does not reset a variable holding that
id. Guarding the re-arm with `if (timer === null)` after a `clearTimeout` means the
branch never runs, the hide timer is cancelled on every event and never
rescheduled, and the button stays up permanently. The handle must be nulled in the
callback, or the re-arm must not depend on it.

### Why it froze instead

`main()` calls `emscripten_set_main_loop_arg()` and then **returns 0 immediately**,
so all the native teardown below it (`EmuThreadStop`, `NativeShutdown`, `SDL_Quit`)
never runs. On exit the main loop cancels and stops. Nothing reached the host page,
which was left holding a dead GL context, a full wasm heap and a live pthread pool.
The JS main thread stayed responsive, so it presented as a frozen last frame rather
than a hung tab — worth knowing when diagnosing this in future.

### Escape hatch

A "Back to picker" button sits top-left whenever the emulator is on screen. If a
future bug stops the exit notification firing, the user is never trapped on a
dead frame. It syncs saves and reloads.

## Why Exit used to freeze the page (first attempt)

In the Emscripten path, `main()` calls `emscripten_set_main_loop_arg()` and then
**returns 0 immediately**. The main loop keeps running on `requestAnimationFrame`,
so all the native teardown beneath it in `main()` — `EmuThreadStop()`,
`NativeShutdown()`, `SDL_Quit()` — never executes. On exit, `EmscriptenMainLoop`
cancelled the loop and stopped, leaving the page holding a dead GL context, a full
wasm heap and a live pthread pool. No signal reached the host, so it read as a
hang.

The fix is `NotifyHostOfExit()` in `SDL/SDLMain.cpp`, which calls
`Module.onEmulatorExit(restart)` via `EM_ASM` at each point the main loop sees
`g_QuitRequested`/`g_RestartRequested`. The host then syncs saves and reloads.

Reloading is deliberate, not a shortcut. A wasm instance cannot be re-entered, and
there is no JS-callable way to destroy its pthread pool or WebGL context. Returning
to the picker with a clean page is the only correct reset; anything in-place would
leave the emulator in a half-dead state. The visible cost is that PPSSPP's own
menu is lost between games.

Saves are flushed on exit for the same reason `NativeShutdown()` never runs — that
is the only thing writing them out.

## Saves

Game saves and savestates live in `/home/web_user`, which is IDBFS-backed and
persists across reloads. Verified round-trip: written, synced, reloaded, restored.

This is separate from the "store nothing" policy for game files. Saves are kilobytes
to a few megabytes and are the one thing worth keeping — they are the user's own
progress, not a copy of someone else's game. The image itself is never cached.

### IDBFS `syncfs` argument order — easy to get backwards

`IDBFS.syncfs(mount, populate, cb)` is implemented as:

    var src = populate ? remote : local;
    var dst = populate ? local  : remote;

So:

    populate = TRUE   IndexedDB -> MEMFS   LOAD, at startup
    populate = FALSE  MEMFS -> IndexedDB   SAVE, on the way out

Having these the wrong way round does not merely fail quietly — it **deletes**.
A save call that actually loads wipes every MEMFS file not already in IndexedDB.
That bug was live here: `syncfs(true)` was used for saving and `syncfs(false)` for
loading, so saves were being destroyed on the way out and IDB was being truncated
at startup. Symptom: `syncfs` reported success, the callback fired, and the data
was gone.

Call sites, for reference: `preRunHook` loads, `onEmulatorExit` and the escape
button and `pagehide` save.

Do not `addRunDependency('idbfs')`. IDBFS does nothing until `syncfs` is called,
so a run dependency would never resolve and the runtime would hang before
`onRuntimeInitialized` forever.

Note PPSSPP writes saves through the emulated memory stick into this directory
during play, not only at shutdown — `NativeShutdown()` never runs in this build,
so exit-time sync is a flush of whatever is already in MEMFS, not the only write.

`web/library.json` lists entries; each renders as a tile. **Nothing is stored,
anywhere.** The host serves no game images and the browser keeps no copy of one.

Flow: press Play (or drop a file on the tile) → pick the file → read into memory
→ boot. On reload it is gone and you pick again. That is the deliberate trade:
an earlier version cached the picked image in OPFS, which meant the browser held
hundreds of megabytes invisibly and deleting the original from disk did not free
it, so a "Stored games" panel with delete controls had to exist purely to undo it.
Playing straight from the file the user already has costs them nothing.

Entry fields:

- `source` — page to visit to obtain the image. `Download` opens it.
- `sourceFile` — exact filename of the row in that collection.
- `sourceText` — same filename, kept as data for the listing fallback.
- `sourceFragment` — optional override for the `#:~:text=` Text Fragment
  (`Download` jumps to and highlights that row in a long index; Chrome 89+/
  Safari 16.1+, degrades to the plain page). Needed for any row whose full name
  contains " - ", which never matches (verified: full-name fragments with it
  leave scrollY at 0; without it they scroll). Keep the override a short,
  punctuation-light substring that is unique across the listing,
  case-insensitively -- a miss only loses the highlight, a non-unique hit jumps
  to the wrong row.
- `files` — for directory games, the member names expected in the user's folder.
  PPSSPP boots a folder containing `EBOOT.PBP` natively (`Core/Loaders.cpp`,
  `PSP_PBP_DIRECTORY`), so no ISO/CSO packing is needed.

`sessionFiles` is a JS Map holding what was picked this page load. Deliberately
not IndexedDB, not OPFS, not Cache API.

### Testing input and canvas pixels

Neither can be driven from automation here, which limits verification:

- **Input** — SDL's Emscripten shim ignores synthetic/untrusted `KeyboardEvent`
  and `quit` events dispatched from JS, so no menu can be navigated
  programmatically. Real hardware input is required.
- **Canvas pixels** — `readPixels`/`drawImage` return an empty buffer because the
  WebGL drawing buffer is cleared after compositing, and this build does not set
  `preserveDrawingBuffer`. Use `browser.screenshot`, which captures the composited
  page and does show the real frame.

Also: stale browser tabs linger across a session and can look like live bugs. Dump
every tab's argv before investigating — a phantom `/games/<name>` is usually a
leftover from an earlier test, not a persistence problem.

## Frame pacing

Emulation speed in PPSSPP is tied to how often `NativeFrame()` runs: one call
advances one emulated game frame. So the main loop rate *is* the game's speed.

The fork used to switch emscripten to `EM_TIMING_SETTIMEOUT` from inside its own
callback. Two problems: changing timing mode from within the callback can
reschedule rather than replace (double-scheduling the loop, ~2x speed), and
setTimeout jitter near the 16.67ms boundary makes any wall-clock throttle skip
frames unpredictably. It now stays on RAF (vsync-locked and stable) and
`EmscriptenThrottle()` caps the rate.

Two further gotchas, both found the hard way:

- The throttle must advance its schedule by one period (`nextDueAt += minMs`), not
  jump to `now`. With `lastFrameAt = now`, any float shortfall makes it skip an
  extra frame and the error compounds, so it only ever falls short: measured 22-24Hz
  against a 30Hz target and drifting. Now stable at 29/30.
- `EM_ASM` argument names are derived from the C expression, so
  `}, measured, EmscriptenMainLoopFPS())` left `$measured` undefined and threw once
  a second inside the render callback. Bind named locals, or use positional `$0`/`$1`.

**Default is 30fps, not 60.** Most PSP 3D games target 30; driving the loop at 60
runs them at double speed and can break them outright. Overridable per session via
`Module.emuFpsOverride` (Settings → loop rate) and in `build.sh` via
`WASM_MAIN_LOOP_FPS`.

## Top bar

`GPU`, `Pad`, `Speed` and `Settings` chips, each opening a popover. Deliberate
non-features, so they do not read as bugs later:

- **No GPU/backend selector.** The build is compiled `USING_GLES2=ON` with
  `-sMIN_WEBGL_VERSION=2`, so WebGL2 is the only backend and JS cannot change it.
  The panel reports the real renderer instead. Note PPSSPP has no separate GLES3
  backend — `GPUBackend` is only OPENGL/D3D11/Vulkan and it auto-detects ES 3.0.
- **No player-1 pad reassignment.** PPSSPP maps by SDL device index
  (`SDL/SDLJoystick.cpp`) with no config key to reorder. The panel shows which pad
  is P1 rather than a dropdown that silently does nothing.
- **Two different FPS numbers.** The overlay is page rAF (browser responsiveness);
  the Speed chip is the wasm main loop rate, which is what determines game speed.

Chip parsing note: Chrome reports `ANGLE (Vendor, Renderer, Version)`; take the
*middle* field. A greedy regex strips to the last comma and leaves
"Unspecified Version)".

## Licensing

PPSSPP is GPL-2.0-or-later. Distributing the wasm build means offering the
corresponding source; linking to upstream and the fork satisfies this.

Game files are the user's own and never touch this project. The host page has no
upload endpoint, no server-side storage and no analytics, which is both the
compliance story and the best feature.