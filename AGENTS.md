# AGENTS.md

## Project

Single-page OpenSCAD polygon editor. Users click on a canvas to build 2D polygons and copy the `polygon(points=...)` output into `.scad` files.

## Layout

All source lives in `polygon-editor/`. The workspace root is one level above.

- `polygon-editor/src/App.tsx` — entire app (canvas, point list, OpenSCAD output, convexity check)
- `polygon-editor/src/App.css` — all styles
- `polygon-editor/src/index.css` — minimal global reset

No routing, no backend, no state library. Single React component.

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
- Canvas grid snaps to 10-unit increments
- Y-axis is flipped (math/OpenSCAD convention: Y up, canvas Y down)
- Initial state is always a triangle (3 points)
