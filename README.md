# Dwarven Deep

A browser-based colony simulation: a living mountain of dwarves who mine, farm,
build, fight, and remember. The full design lives in
[`dwarven-deep-gdd-v4-1.docx`](./dwarven-deep-gdd-v4-1.docx).

During play the simulation ticks on the main thread, inside the
`requestAnimationFrame` loop in `src/main.ts`, and the same frame renders the
world to a `<canvas>`. A Web Worker (`src/workers/sim.worker.ts`) is used only
for offline catch-up: when you reopen a fortress after time away, it replays
the elapsed ticks off the main thread and hands back a save. Saves persist to
IndexedDB across up to five fortress slots.

## Prerequisites

- **Node.js 18.18+** (Node 20 or 22 LTS recommended; CI uses 22)
- **npm 9+**

No other system dependencies — everything runs in the browser.

## Setup

```sh
git clone <this-repo>
cd Dwarf_farm
npm install
```

## Scripts

| Command              | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `npm run dev`        | Start the Vite dev server with HMR. Open the printed URL.          |
| `npm run build`      | Type-check (`tsc -b`) and produce a production bundle in `dist/`.  |
| `npm run preview`    | Serve the production build locally to sanity-check `dist/`.        |
| `npm run typecheck`  | Type-check only (`tsc -b`), no bundle.                             |
| `npm run lint`       | ESLint (flat config in `eslint.config.js`); fails on any warning.  |
| `npm test`           | Run the Vitest suite once (a few minutes — the sim tests are long). |
| `npm run test:watch` | Run Vitest in watch mode while developing.                         |
| `npm run bench`      | Tick benchmark: prints ms/tick and state hashes for a fixed seed. Args: `npm run bench -- <dwarves> <ticks> <seed> <width> <height>` (default `60 5000 4242 200 500`). Run before and after a perf change — the hashes must not change. |

CI (`.github/workflows/ci.yml`) runs type-check, lint, the test suite and the
production build on every push to `main` and every pull request.

The simulation must stay deterministic: same seed, same inputs, same state
tick for tick. Nothing under `src/sim` may call `Math.random` (lint enforces
this) — draw from the seeded RNGs in `src/sim/rng.ts` instead.
`src/sim/sim.test.ts` and `src/save/roundtrip.test.ts` guard this.

## Playing

1. `npm run dev` and open the printed URL (usually http://localhost:5173).
2. Pick an empty fortress slot → choose a game mode → review founders → embark.
3. Use the on-screen panels for speed control, sliders, emergencies, the event
   log, research, population, and per-dwarf inspection. The bunny button on
   the title screen swaps the sprite set (dwarves / mixed / bunnies).
4. Progress is auto-saved per slot to IndexedDB. Clearing site data wipes
   saves.

## Project layout

```
src/
  main.ts            entry point — boot/title flow, the live game loop
                     (ticks the sim + renders each animation frame), UI
                     wiring, autosave, and offline catch-up via the worker
  sim/               simulation: ECS, pathing, jobs, dwarves, world, events
    sim.ts           tick() — the ordered list of per-tick systems
    systems/         systems split out of sim.ts (hostiles, social, pets, trade, ...)
    world/           tile grid, worldgen, noise
    ecs/             components and world container
    dwarves/         traits, skills, aging, birth, death, founders, migration
    jobs/            job/task selection and idle behavior
    pathing/         A* and region map
    planner/         colony planner, blueprints, recipes, furnishing
    hostiles/        hostile entities and types
    events/          event log and narrator
  render/            canvas renderer, camera, minimap, sprites, palette
  ui/                DOM panels: title screen, HUD, inspectors, tutorial, etc.
  save/              IndexedDB persistence, snapshot/restore, codec, schema,
                     versioned migrations, JSON export/import (+ validation)
    fixtures/        hand-built old-version saves for migration tests
  audio/             sound playback
  shared/            worker <-> main protocol types (catch-up messages)
  workers/sim.worker.ts   offline catch-up only: replays elapsed ticks for a
                          reopened save, then posts the resulting save back
scripts/
  bench-tick.ts      `npm run bench` — ms/tick + determinism hashes
```

Tests live next to the code they cover as `*.test.ts` files and run under
Vitest (jsdom is not required — the suite is pure logic).

## Architecture notes

- **One `tick()` everywhere.** `tick(sim)` in `src/sim/sim.ts` is the single
  deterministic step. The live game loop and the catch-up worker both call it;
  the only difference is whether a renderer reads the world afterwards.
- **Known limitation: the live sim runs on the main thread.** Simulation and
  rendering share each animation frame, so an expensive tick (a large
  colony, a full region-map rebuild after a barred door) shows up directly as
  frame time. Moving the live sim into the worker would need a render-state
  protocol — a compact per-frame (or diffed) snapshot of tiles, entities and
  UI-facing state posted to the main thread, plus a command channel for
  player input (speed, sliders, emergencies) — none of which exists yet. The
  worker today only speaks the catch-up protocol in `src/shared/protocol.ts`
  (`INIT`/`STOP` in, `READY`/`PROGRESS`/`DONE`/`ERROR` out).
- **Saves** are versioned (`CURRENT_SAVE_VERSION` in `src/save/schema.ts`,
  with the version history there). Every load — IndexedDB or an imported
  file — goes through `migrateSave()`; imported files are structurally
  validated first. Saves without a version, older than v2, or from a newer
  build are rejected with a readable error.

## Tech stack

- TypeScript (strict) targeting ES2022
- Vite for dev server and bundling, with an ES-module Web Worker for catch-up
- Vitest for unit tests, ESLint (typescript-eslint) for linting
- Canvas 2D for rendering, IndexedDB for persistence
