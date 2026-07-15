# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Source lives one level down in `polygon-editor/`, not the repo root. **All npm commands must run from `polygon-editor/`.** The repo root holds only `README.md`, `AGENTS.md`, and `images/`.

## Commands

```
cd polygon-editor
npm run dev        # Vite dev server (localhost:5173)
npm run build      # tsc -b && vite build — typecheck then bundle
npm run lint       # eslint
npm run preview    # serve production build
```

`npm run build` runs the typecheck, so use it as the verification step. There are no tests and no test runner.

## Architecture

The entire application is one React component in `polygon-editor/src/App.tsx` (~2200 lines). No routing, no backend, no state-management library. `App.css` holds all styles; `index.css` is a minimal reset. Rendering is done imperatively with the Canvas 2D API inside a `useEffect` redraw, not with React elements.

### Data model

```ts
type Point = [number, number];
interface PathDef { name: string; indices: number[] }
interface PolyState { points: Point[]; paths: PathDef[]; label?: string }
```

- `points` is a single flat array shared by every path (matches OpenSCAD's format); paths reference points by index.
- `paths[0]` is the outer shape, `paths[1+]` are holes. Only referenced points are emitted in output, re-indexed to be contiguous.
- State is the current entry of an undo history array (max 50 entries), persisted to `localStorage` under `polygon-editor-history-v3` with the cursor in `polygon-editor-history-pos-v3`. `loadHistory()` migrates the old v2 format on first load.
- `label` is the human-readable description shown in the history list (e.g. "Point added", "Rotated").

### Editing modes

`EditMode` is a union of twelve modes (`normal`, `distance`, `move`, `moveAll`, `angle`, `length`, `parallel`, `duplicate`, `view`, `rotate`, `rotateAll`, `simplify`). Mode drives pointer-event handling and which sidebar panel renders. Geometry-editing modes (distance/angle/length/parallel) use exact float math with **no grid snapping**; only click-to-place point insertion snaps to the 1-unit grid. See `AGENTS.md` for the per-mode interaction spec.

### Conventions

- Coordinates are OpenSCAD/math convention: Y-axis points up, so canvas Y is flipped when drawing.
- Points are inserted only by clicking edge-midpoint diamond markers, never click-anywhere. Shift+drag moves a point; middle-mouse or shift+drag empty space pans; scroll zooms.
- A header dropdown (`exportFormat`, persisted under `polygon-editor-format`) switches export/import between **OpenSCAD** and **build123d**; the output heading, output text, and import button/parser all follow it.
- OpenSCAD output must match `polygon()` syntax exactly: single path emits `polygon(points=[...]);`; multi-path emits `paths=[[...],[...]]` and appends `convexity=N` when > 1.
- build123d output is a plain reordered point list per path: `profile_pts = [ (x, y), ... ]` for the outer, `hole_N_pts = [...]` for holes, points emitted in path-index order. Output heading is "build123d Output reordered". Convexity is OpenSCAD-only and hidden in build123d mode. `parseBuild123d` imports both `Polygon(...)` calls and bare point lists.
- Convexity is computed by ray-casting in `calcConvexity()` and auto-recalculates on state change.
- Holes render via the canvas `evenodd` fill rule. Each path index maps to a fixed color in `PATH_COLORS` (outer = gold).

## Reference

`AGENTS.md` at the repo root documents every editing mode's step-by-step interaction and the full convention list. Keep both files in sync when behavior changes.
