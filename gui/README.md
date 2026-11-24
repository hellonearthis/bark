# Bark Studio (Tauri v2 GUI)

Desktop interface for [Bark](https://github.com/hellonearthis/bark) built with **Tauri v2**, **React + TypeScript** (Pure Functional Architecture), and a persistent **Python** inference worker.

## Architecture

- **Frontend (`src/`)**:
  - `src/core/types.ts` — immutable domain types and JSON database record definitions
  - `src/core/barkHelpers.ts` — prompt tag insertion, validation, duration formatting, and preset filtering
  - `src/core/speakerCatalog.ts` — speaker context metadata (gender, summary, language/version formatting)
  - `src/api/tauriBridge.ts` — typed Tauri `invoke` and event listener wrappers
  - `src/App.tsx` — studio UI with tooltips, voice context card, audio player, and saved history
- **Rust Backend (`src-tauri/src/lib.rs`)**:
  - Manages the persistent Python worker process over JSON-line stdin/stdout
  - Streams worker status, readiness, results, and logs as Tauri events
  - Persists generation history to `../outputs/generations.json`
- **Python Worker (`python/bark_worker.py`)**:
  - Runs inside `../.venv` and keeps Bark models warm in VRAM across generations

## Scripts

From the repository root:

```pwsh
.\start-gui.ps1   # Run Tauri v2 in development mode
.\build-gui.ps1   # Build release executable / installer
```

From `gui/`:

```pwsh
npm run dev       # Vite dev server only
npm run build     # TypeScript check + production bundle
npm run lint      # oxlint check
npm run tauri dev
npm run tauri build
```
