# PPSSPP Web

A browser build of the PPSSPP emulator (PSP). You open a game file from your own
machine and it runs in the page. Nothing is uploaded, and no game images are
stored on any server or in the browser.

Based on [`root-hunter/ppsspp-wasm`](https://github.com/root-hunter/ppsspp-wasm)
(branch `wasm`), an unofficial WebAssembly fork of
[PPSSPP](https://github.com/hrydgard/ppsspp).

## Run it

```bash
python3 serve.py 8087
```

Then open <http://127.0.0.1:8087/>.

`serve.py` exists because the build **will not run without specific response
headers** — see below. Opening `web/index.html` as a `file://` URL does not work.

## Deployment constraint (read before choosing a host)

The emulator fork hardcodes `-pthread`, so the build needs `SharedArrayBuffer`.
Browsers only expose that to cross-origin-isolated documents, which means every
response must carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`netlify.toml` and `_headers` are already configured for this. GitHub Pages
**cannot** set these headers, so a Pages deploy will fail to boot the emulator.
Use Netlify or Cloudflare Pages.

The build also hardcodes SIMD128, so there is no non-SIMD fallback path.

## How games are supplied

This host serves no game images. `web/library.json` describes games and where
their images come from; the Download button opens that source page in a new tab.

To play, supply your own file:

- press **Play** on a tile and pick the file, or
- drag the file onto the tile or the drop zone

The file is read into memory for that session and discarded afterwards. Nothing
is cached to disk or to OPFS.

On Chromium, the file *path* is remembered (a few hundred bytes in IndexedDB,
via the File System Access API), so later loads relaunch in one click. That is a
bookmark, not a copy — the bytes stay where they already are. Safari and Firefox
lack that API, so there you pick the file each time.

Saves are different from game images and **do** persist: they live in
`/home/web_user`, IDBFS-backed, and survive reloads. They are kilobytes to a few
megabytes of your own progress.

See `NOTES.md` for build details and the IDBFS `syncfs` argument-order trap.

## Rebuilding the emulator

The compiled output (`web/PPSSPPSDL.{js,wasm,data}`, ~36 MB) is committed, so
cloning gives you a working site without a toolchain.

To change the build:

```bash
git clone --recurse-submodules <ppsspp-wasm-url> ppsspp-wasm
./build.sh
```

That tree is ~2.3 GB and is deliberately not in git.

## Notes

- Interface in English and Turkish. Game titles and subtitles are never
  translated — they're data from `library.json`.
- The emulator loop defaults to 30 fps, which is what PSP 3D games target.
  Driving it at 60 makes them run at double speed.