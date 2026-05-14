import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

type Point = [number, number];

const GRID_SIZE = 1;
const GRID_MAJOR = 10;
const INITIAL_SCALE = 4; // pixels per unit
const MAX_HISTORY = 50;
const STORAGE_KEY = 'polygon-editor-history';
const STORAGE_POS_KEY = 'polygon-editor-history-pos';
const POINT_HIT_RADIUS = 10; // pixels
const EDGE_HIT_RADIUS = 8;  // pixels

const DEFAULT_POINTS: Point[] = [
  [0, 0],
  [50, 0],
  [25, 40],
];

function loadHistory(): { entries: Point[][]; pos: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const rawPos = localStorage.getItem(STORAGE_POS_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as Point[][];
      const pos = rawPos !== null ? Number(rawPos) : entries.length - 1;
      if (entries.length > 0 && pos >= 0 && pos < entries.length) {
        return { entries, pos };
      }
    }
  } catch { /* ignore corrupt storage */ }
  return { entries: [DEFAULT_POINTS], pos: 0 };
}

function saveHistory(entries: Point[][], pos: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem(STORAGE_POS_KEY, String(pos));
  } catch { /* storage full, ignore */ }
}

/**
 * Calculate OpenSCAD convexity: the maximum number of times any straight line
 * can cross the polygon boundary (outside→inside transitions).
 * For a convex polygon this is 1. For concave shapes it increases.
 * We sample many ray angles through many points and count edge crossings.
 */
function calcConvexity(points: Point[]): number {
  const n = points.length;
  if (n < 3) return 1;

  // Ray-casting: for a set of angles, cast rays from outside the polygon
  // through interior sample points and count boundary crossings.
  // The maximum crossing count / 2 (enter+exit = 2 crossings per "layer") = convexity.

  // We'll cast rays in many directions and track max crossings for each.
  const angles = 36; // every 10 degrees
  let maxCrossings = 0;

  // Bounding box to know "far away"
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1) * 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  for (let ai = 0; ai < angles; ai++) {
    const angle = (ai * Math.PI) / angles;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    // Sweep perpendicular lines: cast parallel rays across the polygon
    // The perpendicular direction
    const px = -dy;
    const py = dx;

    // Project all vertices onto the perpendicular axis
    const projs = points.map(([x, y]) => (x - cx) * px + (y - cy) * py);
    const pMin = Math.min(...projs);
    const pMax = Math.max(...projs);

    // Sample rays along the perpendicular axis
    const steps = 20;
    for (let si = 0; si <= steps; si++) {
      const t = pMin + (pMax - pMin) * (si / steps);
      // Ray origin: far away along the ray direction, at perpendicular offset t
      const ox = cx + t * px - dx * extent;
      const oy = cy + t * py - dy * extent;

      // Count intersections of this ray with polygon edges
      let crossings = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [x1, y1] = points[i];
        const [x2, y2] = points[j];
        // Ray: P = O + s * D, s >= 0
        // Edge: Q = A + u * (B - A), 0 <= u <= 1
        const ex = x2 - x1;
        const ey = y2 - y1;
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-12) continue;
        const u = (dx * (y1 - oy) - dy * (x1 - ox)) / denom;
        if (u < 0 || u > 1) continue;
        const s = (ex * (y1 - oy) - ey * (x1 - ox)) / (ex * dy - ey * dx);
        if (s >= 0) crossings++;
      }
      if (crossings > maxCrossings) maxCrossings = crossings;
    }
  }

  // Convexity = max crossings / 2 (each "layer" crossed has an enter and exit)
  return Math.max(1, Math.ceil(maxCrossings / 2));
}

/** Distance from point (px,py) to line segment (ax,ay)-(bx,by), all in canvas pixels */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const initialHistory = loadHistory();

function App() {
  const [history, setHistory] = useState<Point[][]>(initialHistory.entries);
  const [historyPos, setHistoryPos] = useState(initialHistory.pos);
  const points = history[historyPos];

  const pushPoints = useCallback((next: Point[]) => {
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyPos + 1);
      const updated = [...trimmed, next].slice(-MAX_HISTORY);
      const newPos = updated.length - 1;
      setHistoryPos(newPos);
      saveHistory(updated, newPos);
      return updated;
    });
  }, [historyPos]);

  const undo = useCallback(() => {
    setHistoryPos((p) => {
      const next = Math.max(0, p - 1);
      saveHistory(history, next);
      return next;
    });
  }, [history]);

  const redo = useCallback(() => {
    setHistoryPos((p) => {
      const next = Math.min(history.length - 1, p + 1);
      saveHistory(history, next);
      return next;
    });
  }, [history]);

  const jumpTo = useCallback((pos: number) => {
    setHistoryPos(pos);
    saveHistory(history, pos);
  }, [history]);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [canvasSize, setCanvasSize] = useState<[number, number]>([800, 800]);
  const [offset, setOffset] = useState<[number, number]>([200, 600]);
  const [scale, setScale] = useState(INITIAL_SCALE);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<[number, number]>([0, 0]);
  const [offsetStart, setOffsetStart] = useState<[number, number]>([0, 0]);

  // Drag state: shift+click on a point starts dragging
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragPreview, setDragPreview] = useState<Point | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resize canvas to fill container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasSize([Math.floor(width), Math.floor(height)]);
        }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const toCanvas = useCallback(
    (wx: number, wy: number): [number, number] => [
      offset[0] + wx * scale,
      offset[1] - wy * scale,
    ],
    [offset, scale]
  );

  const toWorld = useCallback(
    (cx: number, cy: number): [number, number] => {
      const wx = (cx - offset[0]) / scale;
      const wy = (offset[1] - cy) / scale;
      return [
        Math.round(wx / GRID_SIZE) * GRID_SIZE,
        Math.round(wy / GRID_SIZE) * GRID_SIZE,
      ];
    },
    [offset, scale]
  );

  // Points for rendering: apply drag preview if active
  const displayPoints = useCallback((): Point[] => {
    if (dragIndex !== null && dragPreview !== null) {
      const copy = [...points];
      copy[dragIndex] = dragPreview;
      return copy;
    }
    return points;
  }, [points, dragIndex, dragPreview]);

  /** Find which point index is under canvas coords, or null */
  const hitTestPoint = useCallback((cx: number, cy: number): number | null => {
    for (let i = points.length - 1; i >= 0; i--) {
      const [px, py] = toCanvas(points[i][0], points[i][1]);
      if (Math.hypot(cx - px, cy - py) <= POINT_HIT_RADIUS) return i;
    }
    return null;
  }, [points, toCanvas]);

  /** Find which edge (by first-point index) is closest under canvas coords, or null */
  const hitTestEdge = useCallback((cx: number, cy: number): number | null => {
    if (points.length < 2) return null;
    let bestDist = Infinity;
    let bestIdx: number | null = null;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      const [ax, ay] = toCanvas(points[i][0], points[i][1]);
      const [bx, by] = toCanvas(points[j][0], points[j][1]);
      const d = distToSegment(cx, cy, ax, ay, bx, by);
      if (d < EDGE_HIT_RADIUS && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }, [points, toCanvas]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    const dp = displayPoints();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    // Grid — minor lines every 1 unit, major lines every 10 units
    const minorScreenSize = GRID_SIZE * scale;  // 1-unit spacing in pixels
    const majorScreenSize = GRID_MAJOR * scale;  // 10-unit spacing in pixels

    // Minor grid (1-unit) — only draw when zoomed in enough to see them
    if (minorScreenSize > 4) {
      ctx.strokeStyle = '#222240';
      ctx.lineWidth = 0.3;
      const startX = offset[0] % minorScreenSize;
      for (let x = startX; x < w; x += minorScreenSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      const startY = offset[1] % minorScreenSize;
      for (let y = startY; y < h; y += minorScreenSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    }

    // Major grid (10-unit) — thicker, brighter
    if (majorScreenSize > 4) {
      ctx.strokeStyle = '#2a2a5a';
      ctx.lineWidth = 1;
      const startX = offset[0] % majorScreenSize;
      for (let x = startX; x < w; x += majorScreenSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      const startY = offset[1] % majorScreenSize;
      for (let y = startY; y < h; y += majorScreenSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    }

    // Axes
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, offset[1]); ctx.lineTo(w, offset[1]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(offset[0], 0); ctx.lineTo(offset[0], h); ctx.stroke();

    ctx.fillStyle = '#e44'; ctx.font = '12px monospace';
    ctx.fillText('X', w - 15, offset[1] - 5);
    ctx.fillStyle = '#4e4';
    ctx.fillText('Y', offset[0] + 5, 15);

    // Tick marks and labels
    const worldLeft = -offset[0] / scale;
    const worldRight = (w - offset[0]) / scale;
    const worldBottom = -(h - offset[1]) / scale;
    const worldTop = offset[1] / scale;

    // X-axis ticks
    // Minor ticks (every 1 unit) when zoomed enough
    if (minorScreenSize > 8) {
      ctx.strokeStyle = '#555';
      ctx.fillStyle = '#555';
      ctx.font = '7px monospace';
      const tickStart = Math.ceil(worldLeft);
      for (let wx = tickStart; wx <= worldRight; wx += 1) {
        if (wx === 0) continue;
        const [cx, cy] = toCanvas(wx, 0);
        const isMajor = wx % GRID_MAJOR === 0;
        if (isMajor) continue; // draw major separately
        ctx.beginPath();
        ctx.moveTo(cx, cy - 2);
        ctx.lineTo(cx, cy + 2);
        ctx.lineWidth = 0.5;
        ctx.stroke();
        // Label minor ticks when very zoomed in
        if (minorScreenSize > 20) {
          ctx.fillText(String(wx), cx - 4, cy + 12);
        }
      }
    }
    // Major ticks (every 10 units)
    if (majorScreenSize > 8) {
      ctx.strokeStyle = '#888';
      ctx.fillStyle = '#999';
      ctx.font = '10px monospace';
      const tickStart = Math.ceil(worldLeft / GRID_MAJOR) * GRID_MAJOR;
      for (let wx = tickStart; wx <= worldRight; wx += GRID_MAJOR) {
        if (wx === 0) continue;
        const [cx, cy] = toCanvas(wx, 0);
        ctx.beginPath();
        ctx.moveTo(cx, cy - 5);
        ctx.lineTo(cx, cy + 5);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillText(String(wx), cx - 8, cy + 16);
      }
    }

    // Y-axis ticks
    if (minorScreenSize > 8) {
      ctx.strokeStyle = '#555';
      ctx.fillStyle = '#555';
      ctx.font = '7px monospace';
      const tickStart = Math.ceil(worldBottom);
      for (let wy = tickStart; wy <= worldTop; wy += 1) {
        if (wy === 0) continue;
        const [cx, cy] = toCanvas(0, wy);
        const isMajor = wy % GRID_MAJOR === 0;
        if (isMajor) continue;
        ctx.beginPath();
        ctx.moveTo(cx - 2, cy);
        ctx.lineTo(cx + 2, cy);
        ctx.lineWidth = 0.5;
        ctx.stroke();
        if (minorScreenSize > 20) {
          ctx.fillText(String(wy), cx + 5, cy + 3);
        }
      }
    }
    if (majorScreenSize > 8) {
      ctx.strokeStyle = '#888';
      ctx.fillStyle = '#999';
      ctx.font = '10px monospace';
      const tickStart = Math.ceil(worldBottom / GRID_MAJOR) * GRID_MAJOR;
      for (let wy = tickStart; wy <= worldTop; wy += GRID_MAJOR) {
        if (wy === 0) continue;
        const [cx, cy] = toCanvas(0, wy);
        ctx.beginPath();
        ctx.moveTo(cx - 5, cy);
        ctx.lineTo(cx + 5, cy);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillText(String(wy), cx + 7, cy + 4);
      }
    }

    // Polygon fill
    if (dp.length >= 3) {
      ctx.beginPath();
      const [sx, sy] = toCanvas(dp[0][0], dp[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < dp.length; i++) {
        const [px, py] = toCanvas(dp[i][0], dp[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(200, 180, 50, 0.35)';
      ctx.fill();
      ctx.strokeStyle = '#c8b432';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Edges
    if (dp.length >= 2) {
      ctx.strokeStyle = '#c8b432';
      ctx.lineWidth = 2;
      for (let i = 0; i < dp.length; i++) {
        const [ax, ay] = toCanvas(dp[i][0], dp[i][1]);
        const next = (i + 1) % dp.length;
        const [bx, by] = toCanvas(dp[next][0], dp[next][1]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
    }

    // Edge midpoint "+" markers (insert hint)
    if (dp.length >= 2 && dragIndex === null) {
      for (let i = 0; i < dp.length; i++) {
        const j = (i + 1) % dp.length;
        const [ax, ay] = toCanvas(dp[i][0], dp[i][1]);
        const [bx, by] = toCanvas(dp[j][0], dp[j][1]);
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        ctx.fillStyle = 'rgba(68, 170, 255, 0.5)';
        ctx.font = '16px monospace';
        ctx.fillText('+', mx - 5, my + 5);
      }
    }

    // Points
    dp.forEach((p, i) => {
      const [cx, cy] = toCanvas(p[0], p[1]);
      const isSelected = i === selectedIndex;
      const isDragging = i === dragIndex;
      ctx.beginPath();
      ctx.arc(cx, cy, isSelected || isDragging ? 8 : 5, 0, Math.PI * 2);
      ctx.fillStyle = isDragging ? '#ffaa00' : isSelected ? '#ff4444' : '#44aaff';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = isSelected || isDragging ? 2.5 : 1.5;
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = isSelected ? 'bold 12px monospace' : '10px monospace';
      ctx.fillText(String(i), cx + 10, cy - 8);
    });

    // Origin label
    ctx.fillStyle = '#aaa'; ctx.font = '10px monospace';
    ctx.fillText('0', offset[0] + 4, offset[1] + 13);
  }, [displayPoints, selectedIndex, dragIndex, offset, scale, toCanvas]);

  useEffect(() => { draw(); }, [draw]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault(); undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault(); redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // Middle mouse button: pan
    if (e.button === 1) {
      setIsPanning(true);
      setPanStart([e.clientX, e.clientY]);
      setOffsetStart([...offset]);
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    // Shift+click on a point: start dragging
    if (e.shiftKey) {
      const hitPt = hitTestPoint(cx, cy);
      if (hitPt !== null) {
        setDragIndex(hitPt);
        setDragPreview(points[hitPt]);
        setSelectedIndex(hitPt);
        e.preventDefault();
        return;
      }
      // Shift+click on empty space: pan
      setIsPanning(true);
      setPanStart([e.clientX, e.clientY]);
      setOffsetStart([...offset]);
      e.preventDefault();
      return;
    }

    // Plain click on an edge: insert point at the click location between the two edge endpoints
    const hitEdge = hitTestEdge(cx, cy);
    if (hitEdge !== null) {
      const [wx, wy] = toWorld(cx, cy);
      const insertAt = hitEdge + 1;
      const next = [...points];
      next.splice(insertAt, 0, [wx, wy]);
      pushPoints(next);
      setSelectedIndex(insertAt);
      return;
    }

    // Plain click on a point: select it
    const hitPt = hitTestPoint(cx, cy);
    if (hitPt !== null) {
      setSelectedIndex(hitPt === selectedIndex ? null : hitPt);
      return;
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      setOffset([
        offsetStart[0] + e.clientX - panStart[0],
        offsetStart[1] + e.clientY - panStart[1],
      ]);
      return;
    }
    if (dragIndex !== null) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setDragPreview(toWorld(cx, cy));
      return;
    }

    // Update cursor based on what's under the mouse
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const canvas = canvasRef.current!;
    if (e.shiftKey && hitTestPoint(cx, cy) !== null) {
      canvas.style.cursor = 'grab';
    } else if (hitTestPoint(cx, cy) !== null) {
      canvas.style.cursor = 'pointer';
    } else if (hitTestEdge(cx, cy) !== null) {
      canvas.style.cursor = 'copy';
    } else {
      canvas.style.cursor = 'default';
    }
  };

  const handleMouseUp = () => {
    if (dragIndex !== null && dragPreview !== null) {
      const next = [...points];
      next[dragIndex] = dragPreview;
      pushPoints(next);
      setDragIndex(null);
      setDragPreview(null);
      return;
    }
    setIsPanning(false);
  };

  const handleMouseLeave = () => {
    // Cancel drag on leave — don't commit
    if (dragIndex !== null) {
      setDragIndex(null);
      setDragPreview(null);
    }
    setIsPanning(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(0.5, Math.min(40, scale * factor));
    const newOffsetX = cx - ((cx - offset[0]) * newScale) / scale;
    const newOffsetY = cy - ((cy - offset[1]) * newScale) / scale;
    setScale(newScale);
    setOffset([newOffsetX, newOffsetY]);
  };

  const removePoint = (index: number) => {
    pushPoints(points.filter((_, i) => i !== index));
    if (selectedIndex === index) setSelectedIndex(null);
    else if (selectedIndex !== null && selectedIndex > index)
      setSelectedIndex(selectedIndex - 1);
  };

  const movePoint = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= points.length) return;
    const next = [...points];
    [next[index], next[target]] = [next[target], next[index]];
    pushPoints(next);
    if (selectedIndex === index) setSelectedIndex(target);
    else if (selectedIndex === target) setSelectedIndex(index);
  };

  const convexity = points.length >= 3 ? calcConvexity(points) : 1;

  const openscadOutput = convexity > 1
    ? `polygon(points=[${points.map((p) => `[${p[0]},${p[1]}]`).join(',')}], convexity=${convexity});`
    : `polygon(points=[${points.map((p) => `[${p[0]},${p[1]}]`).join(',')}]);`;

  return (
    <div className="app">
      <h1>OpenSCAD Polygon Editor</h1>
      <div className="main-layout">
        <div className="canvas-container" ref={containerRef}>
          <canvas
            ref={canvasRef}
            width={canvasSize[0]}
            height={canvasSize[1]}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onWheel={handleWheel}
          />
          <div className="canvas-hint">
            Click edge to insert point | Shift+drag point to move | Middle-mouse to pan | Scroll to zoom
          </div>
        </div>
        <div className="sidebar">
          <h2>Points ({points.length})</h2>
          <div className="point-list">
            {points.map((p, i) => (
              <div
                key={i}
                className={`point-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => setSelectedIndex(i === selectedIndex ? null : i)}
              >
                <span className="point-index">{i}</span>
                <span className="point-coords">
                  [{p[0]}, {p[1]}]
                </span>
                <button
                  className="move-btn"
                  disabled={i === 0}
                  onClick={(e) => { e.stopPropagation(); movePoint(i, -1); }}
                  title="Move up"
                >^</button>
                <button
                  className="move-btn"
                  disabled={i === points.length - 1}
                  onClick={(e) => { e.stopPropagation(); movePoint(i, 1); }}
                  title="Move down"
                >v</button>
                <button
                  className="remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    removePoint(i);
                  }}
                  title="Remove point"
                >
                  x
                </button>
              </div>
            ))}
          </div>
          <div className="convexity-label">
            Convexity: <span className={convexity <= 1 ? 'convex' : 'concave'}>{convexity}</span>
            {convexity <= 1 ? ' (convex)' : ' (concave)'}
          </div>
          <h2>OpenSCAD Output</h2>
          <textarea
            className="output-area"
            readOnly
            value={openscadOutput}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <div className="history-section">
            <h2>History ({historyPos + 1} / {history.length})</h2>
            <div className="history-controls">
              <button disabled={historyPos === 0} onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
              <button disabled={historyPos === history.length - 1} onClick={redo} title="Redo (Ctrl+Y)">Redo</button>
            </div>
            <div className="history-list">
              {history.map((entry, i) => (
                <div
                  key={i}
                  className={`history-item ${i === historyPos ? 'active' : ''} ${i > historyPos ? 'future' : ''}`}
                  onClick={() => jumpTo(i)}
                >
                  <span className="history-index">{i + 1}</span>
                  <span className="history-summary">{entry.length} pts</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
