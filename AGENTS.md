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
type PolyState = { points: Point[], paths: number[][] }
```

- `points` — flat array of `[x, y]` shared across all paths (matches OpenSCAD format)
- `paths[0]` — outer shape (indices into `points`)
- `paths[1+]` — holes (indices into `points`)
- Stored in localStorage under key `polygon-editor-history-v2` (50-entry undo history)

## Commands

All commands run from `polygon-editor/`:

```
npm run dev        # Vite dev server (localhost:5173)
npm run build      # tsc -b && vite build (typecheck then bundle)
npm run lint       # eslint
npm run preview    # serve production build
```

`build` runs typecheck first — use it as the verification step. There are no tests.

## Conventions

- Output format must match OpenSCAD `polygon()` syntax exactly
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
