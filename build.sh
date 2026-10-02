#!/usr/bin/env bash
# Build PPSSPP for the browser (Emscripten / WebAssembly) via the fork's own
# `make wasm-release` target, so flags stay in sync with upstream CI.
#
# Output: ppsspp-wasm/build-wasm-release/  ->  PPSSPPSDL.{js,wasm,data}
#
# Important build characteristics (from the fork's CMakeLists + Makefile):
#  - THREADED build: -pthread and a pthread pool are hardcoded. Requires
#    SharedArrayBuffer, so the output MUST be served with COOP/COEP headers.
#    Deploy to Netlify / Cloudflare Pages, not plain GitHub Pages.
#  - SIMD128 is hardcoded. No non-SIMD fallback is compiled in.
#  - USE_NO_MMAP=ON: no mmap emulation, which is what leaves room for
#    streaming a large .cso from the browser instead of buffering it in MEMFS.
#  - USE_FFMPEG=OFF: video decoding falls back to PPSSPP's software path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/ppsspp-wasm"

# emsdk needs python >= 3.10; the system python is 3.9.
EMSDK_PY="/tmp/emsdk/python/3.13.3_64bit/bin"
[ -d "$EMSDK_PY" ] || EMSDK_PY="$HOME/.uv-python/cpython-3.12-macos-aarch64-none/bin"
export PATH="$EMSDK_PY:$HOME/.local/bin:$HOME/Library/Python/3.9/bin:/tmp/emsdk/node/24.19.0_64bit/bin:/tmp/emsdk/upstream/emscripten:/tmp/emsdk:$PATH"

# Must be CMake 3.x: submodules declare cmake_minimum_required down to 2.4.4,
# which CMake 4.x rejects outright.
CMAKE="$HOME/.local/bin/cmake"

echo "python: $(python3 --version 2>&1)"
echo "cmake : $($CMAKE --version | head -1)"
echo "emcc  : $(emcc --version | head -1)"

cd "$SRC"
# 30fps is the correct default: most PSP 3D games target 30fps, and driving the
# loop at 60 makes them run at double speed (and can break them outright). The
# front end can override this per session via Module.emuFpsOverride.
make wasm-release CMAKE="$CMAKE" WASM_JOBS="-j$(sysctl -n hw.ncpu)" WASM_MAIN_LOOP_FPS=30

echo
echo "=== build output ==="
ls -lh build-wasm-release/PPSSPPSDL.* build-wasm-release/*.worker.js 2>/dev/null || true