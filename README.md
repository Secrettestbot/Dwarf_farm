# Dwarven Deep

A browser-based colony simulation: a living mountain of dwarves who mine, farm,
build, fight, and remember. The full design lives in
[`dwarven-deep-gdd-v4-1.docx`](./dwarven-deep-gdd-v4-1.docx).

The simulation runs in a Web Worker (`src/workers/sim.worker.ts`) and renders
to a `<canvas>` on the main thread. Saves persist to IndexedDB across up to
five fortress slots.

## Prerequisites

- **Node.js 18+** (Node 20 LTS recommended)
- **npm 9+**

No other system dependencies — everything runs in the browser.

## Setup

```sh
git clone <this-repo>
cd Dwarf_farm
npm install
```

## Scripts

| Command            | What it does                                                       |
| ------------------ | ------------------------------------------------------------------ |
| `npm run dev`      | Start the Vite dev server with HMR. Open the printed URL.          |
| `npm run build`    | Type-check (`tsc -b`) and produce a production bundle in `dist/`.  |
| `npm run preview`  | Serve the production build locally to sanity-check `dist/`.        |
| `npm test`         | Run the Vitest suite once.                                         |
| `npm run test:watch` | Run Vitest in watch mode while developing.                       |

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
  main.ts            entry point — wires worker, renderer, and UI together
  sim/               simulation: ECS, pathing, jobs, dwarves, world, events
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
  save/              IndexedDB persistence, snapshot/restore, codec, schema
  audio/             sound playback
  shared/            worker <-> main protocol types
  workers/sim.worker.ts   simulation loop running off the main thread
```

Tests live next to the code they cover as `*.test.ts` files and run under
Vitest (jsdom is not required — the suite is pure logic).

## Tech stack

- TypeScript (strict) targeting ES2022
- Vite for dev server and bundling, with ES-module Web Workers
- Vitest for unit tests
- Canvas 2D for rendering, IndexedDB for persistence
