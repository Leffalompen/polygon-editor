# AGENTS.md

## Project

Single-page OpenSCAD polygon editor with hole support. Users click on a canvas to build 2D polygons (outer shape + holes), then copy the `polygon(points=..., paths=...)` output into `.scad` files.

## Layout

All source lives in `polygon-editor/`. The workspace root is one level above.

- `polygon-editor/src/App.tsx` — entire app (canvas, point list, path list, OpenSCAD output, convexity check, background image)
- `polygon-editor/src/App.css` — all styles
- `polygon-editor/src/index.css` — minimal global reset

No routing, no backend, no state library. Single React component.

## Data Model

```ts
interface PathDef { name: string; indices: number[] }
type PolyState = { points: Point[], paths: PathDef[] }
```

- `points` — flat array of `[x, y]` shared across all paths (matches OpenSCAD format)
- `paths[0]` — outer shape (`{ name, indices }` where indices reference `points`)
- `paths[1+]` — holes (`{ name, indices }`)
- Path names are part of the state and included in undo history
- Stored in localStorage under key `polygon-editor-history-v3` (50-entry undo history)
- Automatic migration from v2 format on first load

## Commands

All commands run from `polygon-editor/`:

```
npm run dev        # Vite dev server (localhost:5173)
npm run build      # tsc -b && vite build (typecheck then bundle)
npm run lint       # eslint
npm run preview    # serve production build
```

`build` runs typecheck first — use it as the verification step. There are no tests.

## Editing Modes

The editor has a mode toolbar with eleven modes:

- **Edit** (normal) — click edge midpoints to insert points, shift+drag to move points
- **Distance** — select a point then an edge; set the perpendicular distance from the point to the infinite line defined by the edge. Point moves along the perpendicular, no grid snapping.
- **Move** — drag to translate all points in the active path (outer or a hole) together
- **Move All** — drag to translate every point in every path together, preserving relative positions
- **Angle** — select 3 points A, B, C; set the angle at vertex B between edges BA and BC. Point C is rotated around B to achieve the target angle, preserving the BC edge length.
- **Length** — select an edge; set its length. The second endpoint moves along the edge direction to match the new length.
- **Parallel** — select a base edge (reference) then a target edge; click "Make Parallel" to rotate the target edge around its midpoint to match the base edge's angle (preserving length, choosing the closer of the two parallel directions).
- **Duplicate** — click to duplicate the active path (creates a copy with new points), then drag to place the copy. The new path gets the original's name + " copy".
- **Rotate** — click to set pivot (snaps to existing point if near, otherwise arbitrary), then drag to rotate active path around pivot. Mouse-up commits.
- **Rotate All** — same as Rotate but rotates all points in all paths around the pivot.
- **Simplify** — read-only mode (no point insertion or movement). Provides "Reorder Points" button to renumber points sequentially per path, and a "Round" button with configurable decimal places to reduce coordinate precision.

## Export Format

A header dropdown (`exportFormat` state, persisted under `polygon-editor-format`) toggles between OpenSCAD and build123d. The output panel heading, output text, and import button/parser all follow it.

- **OpenSCAD** — `polygon(points=..., paths=...)`, convexity label shown
- **build123d** — a plain reordered point list per path: `profile_pts = [ (x, y), ... ]` for `paths[0]`, `hole_N_pts = [...]` for each hole. Points are emitted in path (indices) order; convexity is hidden. Output heading reads "build123d Output reordered".
- Import: `parseOpenSCAD` or `parseBuild123d` per format; only the matching import button is shown. `parseBuild123d` reads both `Polygon(...)` calls and bare `name = [ (x, y), ... ]` lists (a `hole`-named variable or `mode=Mode.SUBTRACT` marks a hole).

## Conventions

- OpenSCAD output format must match `polygon()` syntax exactly
- Single path: `polygon(points=[...]);`
- Multiple paths: `polygon(points=[...], paths=[[...],[...]], convexity=N);`
- Canvas grid snaps to 1-unit increments, major grid lines every 10 units
- Y-axis is flipped (math/OpenSCAD convention: Y up, canvas Y down)
- Initial state is a triangle (3 points, single outer path)
- Points are added by clicking edge midpoint markers (not click-anywhere)
- Shift+drag to move points; middle-mouse or shift+click empty space to pan
- Canvas fill uses `evenodd` rule to render holes as cutouts
- Each path has a distinct color (outer = gold, holes = red, blue, purple, green, orange)
- Active path: solid thick edges with midpoint diamonds; inactive: dashed, dimmer
- Convexity value is computed via ray-casting and included in output when paths > 1
- Convexity auto-recalculates on state change; manual recalculate button (↻) also available
- Point coordinates are directly editable via number inputs in the sidebar
- Path names are editable (double-click to rename); stored in localStorage separately
- OpenSCAD polygon text can be imported via the "Import from OpenSCAD" panel below the output
