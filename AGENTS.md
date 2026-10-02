# Repository working agreement

These instructions apply to human contributors and AI agents, regardless of
editor or provider. `AGENTS.md` is the shared source for repository working
rules. If a tool does not load it automatically, include this file in its task
context. Keep any tool-specific instruction file as a pointer here, not a copy.

## Start with the current project

- Read `README.md`, the relevant parts of `NOTES.md`, and the source files for
  the task before editing. Check the current branch and working tree first.
- Record the task's scope, intended files, and acceptance criteria in the task
  brief or handoff. Keep changes focused on that scope.
- Check claims in documentation against current code when they matter to the
  task. If they disagree, report the discrepancy rather than treating either
  claim as verified behavior.

## Coordinate parallel work

- Assign one active writer per file. Divide concurrent work by files or areas
  and agree on ownership before editing. Coordinate before touching a file
  owned by another contributor.
- Parallel contributors may edit only their assigned, non-overlapping files in
  the shared checkout or return proposed patches to the integrator. Give one
  integrator ownership of Git operations and handle overlapping edits in
  sequence. Preserve changes made by others; do not reset, revert, or overwrite
  their work to make the working tree clean.
- Designate one integrator to review the combined diff, resolve overlaps, and
  commit and push on `main`. A handoff must name changed files, completed work,
  checks performed, open questions, and remaining work.

## Preserve project behavior

- Games are supplied by the user. Do not commit game images, user files, or
  saves. Do not introduce server uploads or persistent copies of game images
  without an explicitly scoped product change. File handles remembered by the
  browser and emulator saves are separate from game-image copies; see
  `README.md`.
- Interface strings support English and Turkish in `web/i18n.js`. Update both
  languages when changing UI text. Game titles and subtitles in
  `web/library.json` are data and should remain untranslated.
- Saves use IDBFS at `/home/web_user`. Changes to mounting, `syncfs`, or exit
  handling can lose progress; read the relevant `NOTES.md` section and verify
  the direction and outcome of synchronization before changing that flow.
- The threaded WebAssembly build requires cross-origin isolation and SIMD128.
  Preserve the COOP/COEP response headers and runtime asset MIME types when
  changing serving or deployment. Run the site through `serve.py` or a suitably
  configured host, not `file://`.
- `web/PPSSPPSDL.{js,wasm,data}` are committed build outputs. Change them only
  for a task that changes the emulator build, and document the source revision
  and build procedure used. The external `ppsspp-wasm` checkout is not part of
  this repository, and the current `build.sh` contains host-specific paths.

## Verify and deliver

- Run checks relevant to the change. For browser behavior, the documented local
  entry point is `python3 serve.py 8087`. Report what was checked, the result,
  and what could not be checked; do not present an unrun check as passing.
- Use `main` as the only working branch. Keep commits focused and exclude
  unrelated changes. Review the combined diff and relevant checks before
  pushing to `origin/main`. Do not force-push or overwrite remote history; if a
  push is rejected, fetch and integrate the remote changes before retrying.
