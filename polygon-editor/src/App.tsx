import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

type Point = [number, number];

/** All points in a flat list; paths index into them. paths[0] = outer, paths[1+] = holes */
interface PolyState {
  points: Point[];
  paths: number[][];
}

const GRID_SIZE = 1;
const GRID_MAJOR = 10;
const INITIAL_SCALE = 4;
const MAX_HISTORY = 50;
const STORAGE_KEY = 'polygon-editor-history-v2';
const STORAGE_POS_KEY = 'polygon-editor-history-pos-v2';
const POINT_HIT_RADIUS = 10;
const EDGE_HIT_RADIUS = 8;

const PATH_COLORS = [
  { fill: [200, 180, 50], stroke: '#c8b432', label: 'Outer' },
  { fill: [255, 80, 80],  stroke: '#ff5050', label: 'Hole' },
  { fill: [80, 200, 255], stroke: '#50c8ff', label: 'Hole' },
  { fill: [180, 80, 255], stroke: '#b450ff', label: 'Hole' },
  { fill: [80, 255, 140],  stroke: '#50ff8c', label: 'Hole' },
  { fill: [255, 180, 80],  stroke: '#ffb450', label: 'Hole' },
];

const DEFAULT_STATE: PolyState = {
  points: [[0, 0], [50, 0], [25, 40]],
  paths: [[0, 1, 2]],
};

function loadHistory(): { entries: PolyState[]; pos: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const rawPos = localStorage.getItem(STORAGE_POS_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as PolyState[];
      const pos = rawPos !== null ? Number(rawPos) : entries.length - 1;
      if (entries.length > 0 && pos >= 0 && pos < entries.length && entries[0].paths) {
        return { entries, pos };
      }
    }
  } catch { /* ignore */ }
  return { entries: [DEFAULT_STATE], pos: 0 };
}

function saveHistory(entries: PolyState[], pos: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem(STORAGE_POS_KEY, String(pos));
  } catch { /* full */ }
}

function calcConvexity(state: PolyState): number {
  const { points, paths } = state;
  // Collect all edges across all paths
  const edges: [Point, Point][] = [];
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const j = (i + 1) % path.length;
      edges.push([points[path[i]], points[path[j]]]);
    }
  }
  if (edges.length < 3) return 1;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1) * 2;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const angles = 36;
  let maxCrossings = 0;

  for (let ai = 0; ai < angles; ai++) {
    const angle = (ai * Math.PI) / angles;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const px = -dy;
    const py = dx;
    const projs = points.map(([x, y]) => (x - cx) * px + (y - cy) * py);
    const pMin = Math.min(...projs);
    const pMax = Math.max(...projs);
    const steps = 20;
    for (let si = 0; si <= steps; si++) {
      const t = pMin + (pMax - pMin) * (si / steps);
      const ox = cx + t * px - dx * extent;
      const oy = cy + t * py - dy * extent;
      let crossings = 0;
      for (const [[x1, y1], [x2, y2]] of edges) {
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
  return Math.max(1, Math.ceil(maxCrossings / 2));
}

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
  const [history, setHistory] = useState<PolyState[]>(initialHistory.entries);
  const [historyPos, setHistoryPos] = useState(initialHistory.pos);
  const state = history[historyPos];
  const { points, paths } = state;

  // Which path is being edited (0 = outer, 1+ = holes)
  const [activePath, setActivePath] = useState(0);
  // Selected point index (global index into points[])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const pushState = useCallback((next: PolyState) => {
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

  const [canvasSize, setCanvasSize] = useState<[number, number]>([800, 800]);
  const [offset, setOffset] = useState<[number, number]>([200, 600]);
  const [scale, setScale] = useState(INITIAL_SCALE);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<[number, number]>([0, 0]);
  const [offsetStart, setOffsetStart] = useState<[number, number]>([0, 0]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragPreview, setDragPreview] = useState<Point | null>(null);
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [imageOpacity, setImageOpacity] = useState(0.5);
  const [polyOpacity, setPolyOpacity] = useState(0.35);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Clamp activePath when paths change
  useEffect(() => {
    if (activePath >= paths.length) setActivePath(Math.max(0, paths.length - 1));
  }, [paths.length, activePath]);

  const handleImageImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => setBgImage(img);
    img.src = URL.createObjectURL(file);
    e.target.value = '';
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setCanvasSize([Math.floor(width), Math.floor(height)]);
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const toCanvas = useCallback(
    (wx: number, wy: number): [number, number] => [offset[0] + wx * scale, offset[1] - wy * scale],
    [offset, scale]
  );
  const toWorld = useCallback(
    (cx: number, cy: number): [number, number] => {
      const wx = (cx - offset[0]) / scale;
      const wy = (offset[1] - cy) / scale;
      return [Math.round(wx / GRID_SIZE) * GRID_SIZE, Math.round(wy / GRID_SIZE) * GRID_SIZE];
    },
    [offset, scale]
  );

  // Get points for a specific path, with drag preview applied
  const getPathPoints = useCallback((pathIdx: number): Point[] => {
    const path = paths[pathIdx];
    if (!path) return [];
    return path.map((gi) => {
      if (dragIndex === gi && dragPreview !== null) return dragPreview;
      return points[gi];
    });
  }, [points, paths, dragIndex, dragPreview]);

  // Active path's global indices
  const activePathIndices = paths[activePath] || [];

  // Hit test: find global point index under cursor (across all paths)
  const hitTestPoint = useCallback((cx: number, cy: number): number | null => {
    // Prefer active path points
    for (let k = activePathIndices.length - 1; k >= 0; k--) {
      const gi = activePathIndices[k];
      const [px, py] = toCanvas(points[gi][0], points[gi][1]);
      if (Math.hypot(cx - px, cy - py) <= POINT_HIT_RADIUS) return gi;
    }
    // Then check all other paths
    for (let pi = 0; pi < paths.length; pi++) {
      if (pi === activePath) continue;
      for (let k = paths[pi].length - 1; k >= 0; k--) {
        const gi = paths[pi][k];
        const [px, py] = toCanvas(points[gi][0], points[gi][1]);
        if (Math.hypot(cx - px, cy - py) <= POINT_HIT_RADIUS) return gi;
      }
    }
    return null;
  }, [points, paths, activePath, activePathIndices, toCanvas]);

  // Hit test edge on active path only; returns position within active path
  const hitTestEdge = useCallback((cx: number, cy: number): number | null => {
    if (activePathIndices.length < 2) return null;
    let bestDist = Infinity;
    let bestIdx: number | null = null;
    for (let i = 0; i < activePathIndices.length; i++) {
      const j = (i + 1) % activePathIndices.length;
      const [ax, ay] = toCanvas(points[activePathIndices[i]][0], points[activePathIndices[i]][1]);
      const [bx, by] = toCanvas(points[activePathIndices[j]][0], points[activePathIndices[j]][1]);
      const d = distToSegment(cx, cy, ax, ay, bx, by);
      if (d < EDGE_HIT_RADIUS && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }, [points, activePathIndices, toCanvas]);

  // --- Drawing ---
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    // Grid
    const minorScreenSize = GRID_SIZE * scale;
    const majorScreenSize = GRID_MAJOR * scale;
    if (minorScreenSize > 4) {
      ctx.strokeStyle = '#222240'; ctx.lineWidth = 0.3;
      const startX = offset[0] % minorScreenSize;
      for (let x = startX; x < w; x += minorScreenSize) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      const startY = offset[1] % minorScreenSize;
      for (let y = startY; y < h; y += minorScreenSize) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    }
    if (majorScreenSize > 4) {
      ctx.strokeStyle = '#2a2a5a'; ctx.lineWidth = 1;
      const startX = offset[0] % majorScreenSize;
      for (let x = startX; x < w; x += majorScreenSize) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      const startY = offset[1] % majorScreenSize;
      for (let y = startY; y < h; y += majorScreenSize) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    }

    // Axes
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, offset[1]); ctx.lineTo(w, offset[1]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(offset[0], 0); ctx.lineTo(offset[0], h); ctx.stroke();
    ctx.fillStyle = '#e44'; ctx.font = '12px monospace'; ctx.fillText('X', w - 15, offset[1] - 5);
    ctx.fillStyle = '#4e4'; ctx.fillText('Y', offset[0] + 5, 15);

    // Ticks
    const worldLeft = -offset[0] / scale;
    const worldRight = (w - offset[0]) / scale;
    const worldBottom = -(h - offset[1]) / scale;
    const worldTop = offset[1] / scale;
    if (minorScreenSize > 8) {
      ctx.strokeStyle = '#555'; ctx.fillStyle = '#555'; ctx.font = '7px monospace';
      for (let wx = Math.ceil(worldLeft); wx <= worldRight; wx++) {
        if (wx === 0 || wx % GRID_MAJOR === 0) continue;
        const [cx, cy] = toCanvas(wx, 0);
        ctx.beginPath(); ctx.moveTo(cx, cy - 2); ctx.lineTo(cx, cy + 2); ctx.lineWidth = 0.5; ctx.stroke();
        if (minorScreenSize > 20) ctx.fillText(String(wx), cx - 4, cy + 12);
      }
      for (let wy = Math.ceil(worldBottom); wy <= worldTop; wy++) {
        if (wy === 0 || wy % GRID_MAJOR === 0) continue;
        const [cx, cy] = toCanvas(0, wy);
        ctx.beginPath(); ctx.moveTo(cx - 2, cy); ctx.lineTo(cx + 2, cy); ctx.lineWidth = 0.5; ctx.stroke();
        if (minorScreenSize > 20) ctx.fillText(String(wy), cx + 5, cy + 3);
      }
    }
    if (majorScreenSize > 8) {
      ctx.strokeStyle = '#888'; ctx.fillStyle = '#999'; ctx.font = '10px monospace';
      for (let wx = Math.ceil(worldLeft / GRID_MAJOR) * GRID_MAJOR; wx <= worldRight; wx += GRID_MAJOR) {
        if (wx === 0) continue;
        const [cx, cy] = toCanvas(wx, 0);
        ctx.beginPath(); ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5); ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillText(String(wx), cx - 8, cy + 16);
      }
      for (let wy = Math.ceil(worldBottom / GRID_MAJOR) * GRID_MAJOR; wy <= worldTop; wy += GRID_MAJOR) {
        if (wy === 0) continue;
        const [cx, cy] = toCanvas(0, wy);
        ctx.beginPath(); ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillText(String(wy), cx + 7, cy + 4);
      }
    }

    // Background image
    if (bgImage) {
      ctx.save();
      ctx.globalAlpha = imageOpacity;
      const imgW = bgImage.naturalWidth;
      const imgH = bgImage.naturalHeight;
      const [x0, y0] = toCanvas(0, imgH);
      ctx.drawImage(bgImage, x0, y0, imgW * scale, imgH * scale);
      ctx.restore();
    }

    // Draw polygon with holes using evenodd fill rule
    // First: fill the composite shape (outer - holes)
    const outerPts = getPathPoints(0);
    if (outerPts.length >= 3) {
      ctx.save();
      ctx.beginPath();
      // Outer path
      const [sx, sy] = toCanvas(outerPts[0][0], outerPts[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < outerPts.length; i++) {
        const [px, py] = toCanvas(outerPts[i][0], outerPts[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      // Hole paths
      for (let pi = 1; pi < paths.length; pi++) {
        const holePts = getPathPoints(pi);
        if (holePts.length < 3) continue;
        const [hx, hy] = toCanvas(holePts[0][0], holePts[0][1]);
        ctx.moveTo(hx, hy);
        for (let i = 1; i < holePts.length; i++) {
          const [px, py] = toCanvas(holePts[i][0], holePts[i][1]);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
      const c = PATH_COLORS[0].fill;
      ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${polyOpacity})`;
      ctx.fill('evenodd');
      ctx.restore();
    }

    // Draw edges and midpoints per path
    for (let pi = 0; pi < paths.length; pi++) {
      const pathPts = getPathPoints(pi);
      const color = PATH_COLORS[pi % PATH_COLORS.length];
      const isActive = pi === activePath;

      // Edges
      if (pathPts.length >= 2) {
        ctx.strokeStyle = color.stroke;
        ctx.lineWidth = isActive ? 2.5 : 1.5;
        if (!isActive) ctx.setLineDash([6, 4]);
        for (let i = 0; i < pathPts.length; i++) {
          const j = (i + 1) % pathPts.length;
          const [ax, ay] = toCanvas(pathPts[i][0], pathPts[i][1]);
          const [bx, by] = toCanvas(pathPts[j][0], pathPts[j][1]);
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // Edge midpoint markers for active path only
      if (isActive && pathPts.length >= 2 && dragIndex === null) {
        for (let i = 0; i < pathPts.length; i++) {
          const j = (i + 1) % pathPts.length;
          const [ax, ay] = toCanvas(pathPts[i][0], pathPts[i][1]);
          const [bx, by] = toCanvas(pathPts[j][0], pathPts[j][1]);
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          ctx.beginPath();
          ctx.moveTo(mx, my - 5); ctx.lineTo(mx + 5, my); ctx.lineTo(mx, my + 5); ctx.lineTo(mx - 5, my);
          ctx.closePath();
          ctx.fillStyle = 'rgba(68, 170, 255, 0.4)'; ctx.fill();
          ctx.strokeStyle = 'rgba(68, 170, 255, 0.7)'; ctx.lineWidth = 1; ctx.stroke();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)'; ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(mx - 2, my); ctx.lineTo(mx + 2, my);
          ctx.moveTo(mx, my - 2); ctx.lineTo(mx, my + 2);
          ctx.stroke();
        }
      }
    }

    // Draw all points
    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi];
      const color = PATH_COLORS[pi % PATH_COLORS.length];
      const isActivePath = pi === activePath;
      for (let k = 0; k < path.length; k++) {
        const gi = path[k];
        const pt = (dragIndex === gi && dragPreview) ? dragPreview : points[gi];
        const [cx, cy] = toCanvas(pt[0], pt[1]);
        const isSelected = gi === selectedIndex;
        const isDragging = gi === dragIndex;
        ctx.beginPath();
        ctx.arc(cx, cy, isSelected || isDragging ? 8 : isActivePath ? 5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isDragging ? '#ffaa00' : isSelected ? '#ff4444' : color.stroke;
        ctx.globalAlpha = isActivePath ? 1 : 0.5;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = isSelected || isDragging ? 2.5 : 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;

        if (isActivePath) {
          ctx.fillStyle = '#fff';
          ctx.font = isSelected ? 'bold 12px monospace' : '10px monospace';
          ctx.fillText(String(gi), cx + 10, cy - 8);
        }
      }
    }

    // Origin label
    ctx.fillStyle = '#aaa'; ctx.font = '10px monospace';
    ctx.fillText('0', offset[0] + 4, offset[1] + 13);
  }, [getPathPoints, points, paths, selectedIndex, activePath, dragIndex, dragPreview, offset, scale, toCanvas, canvasSize, bgImage, imageOpacity, polyOpacity]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // --- Mouse handlers ---
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (e.button === 1) {
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }
    if (e.button !== 0) return;

    if (e.shiftKey) {
      const hitPt = hitTestPoint(cx, cy);
      if (hitPt !== null) {
        setDragIndex(hitPt); setDragPreview(points[hitPt]); setSelectedIndex(hitPt);
        // Switch to the path that owns this point
        for (let pi = 0; pi < paths.length; pi++) {
          if (paths[pi].includes(hitPt)) { setActivePath(pi); break; }
        }
        e.preventDefault(); return;
      }
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }

    // Click on edge of active path: insert point
    const hitEdge = hitTestEdge(cx, cy);
    if (hitEdge !== null) {
      const [wx, wy] = toWorld(cx, cy);
      const newGlobalIdx = points.length;
      const newPoints = [...points, [wx, wy] as Point];
      const newPaths = paths.map((p, pi) => {
        if (pi !== activePath) return [...p];
        const np = [...p];
        np.splice(hitEdge + 1, 0, newGlobalIdx);
        return np;
      });
      pushState({ points: newPoints, paths: newPaths });
      setSelectedIndex(newGlobalIdx);
      return;
    }

    // Click on a point: select it (and switch to its path)
    const hitPt = hitTestPoint(cx, cy);
    if (hitPt !== null) {
      setSelectedIndex(hitPt === selectedIndex ? null : hitPt);
      for (let pi = 0; pi < paths.length; pi++) {
        if (paths[pi].includes(hitPt)) { setActivePath(pi); break; }
      }
      return;
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      setOffset([offsetStart[0] + e.clientX - panStart[0], offsetStart[1] + e.clientY - panStart[1]]);
      return;
    }
    if (dragIndex !== null) {
      const rect = canvasRef.current!.getBoundingClientRect();
      setDragPreview(toWorld(e.clientX - rect.left, e.clientY - rect.top));
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const canvas = canvasRef.current!;
    if (e.shiftKey && hitTestPoint(cx, cy) !== null) canvas.style.cursor = 'grab';
    else if (hitTestPoint(cx, cy) !== null) canvas.style.cursor = 'pointer';
    else if (hitTestEdge(cx, cy) !== null) canvas.style.cursor = 'copy';
    else canvas.style.cursor = 'default';
  };

  const handleMouseUp = () => {
    if (dragIndex !== null && dragPreview !== null) {
      const newPoints = [...points];
      newPoints[dragIndex] = dragPreview;
      pushState({ points: newPoints, paths });
      setDragIndex(null); setDragPreview(null);
      return;
    }
    setIsPanning(false);
  };

  const handleMouseLeave = () => {
    if (dragIndex !== null) { setDragIndex(null); setDragPreview(null); }
    setIsPanning(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(0.5, Math.min(40, scale * factor));
    setScale(newScale);
    setOffset([cx - ((cx - offset[0]) * newScale) / scale, cy - ((cy - offset[1]) * newScale) / scale]);
  };

  // --- Point operations (on active path) ---
  const removePoint = (globalIdx: number) => {
    // Find which path owns this point
    let ownerPath = -1;
    for (let pi = 0; pi < paths.length; pi++) {
      if (paths[pi].includes(globalIdx)) { ownerPath = pi; break; }
    }
    if (ownerPath < 0) return;

    const newPaths = paths.map((p, pi) => {
      if (pi !== ownerPath) return [...p];
      return p.filter((gi) => gi !== globalIdx);
    });
    // Don't allow removing a path's last 3 points for outer, or last 3 for a hole
    if (ownerPath === 0 && newPaths[0].length < 3) return;
    // If a hole goes below 3 points, remove the whole hole path
    if (ownerPath > 0 && newPaths[ownerPath].length < 3) {
      newPaths.splice(ownerPath, 1);
      if (activePath >= newPaths.length) setActivePath(Math.max(0, newPaths.length - 1));
    }
    pushState({ points: [...points], paths: newPaths });
    if (selectedIndex === globalIdx) setSelectedIndex(null);
  };

  const movePointInPath = (globalIdx: number, direction: -1 | 1) => {
    let ownerPath = -1;
    let posInPath = -1;
    for (let pi = 0; pi < paths.length; pi++) {
      const idx = paths[pi].indexOf(globalIdx);
      if (idx >= 0) { ownerPath = pi; posInPath = idx; break; }
    }
    if (ownerPath < 0) return;
    const path = paths[ownerPath];
    const target = posInPath + direction;
    if (target < 0 || target >= path.length) return;
    const newPaths = paths.map((p, pi) => {
      if (pi !== ownerPath) return [...p];
      const np = [...p];
      [np[posInPath], np[target]] = [np[target], np[posInPath]];
      return np;
    });
    pushState({ points: [...points], paths: newPaths });
    setSelectedIndex(globalIdx);
  };

  const addHole = () => {
    // Place a small triangle hole near the center of the outer path
    const outerPts = (paths[0] || []).map((gi) => points[gi]);
    let cx = 25, cy = 20;
    if (outerPts.length >= 3) {
      cx = outerPts.reduce((s, p) => s + p[0], 0) / outerPts.length;
      cy = outerPts.reduce((s, p) => s + p[1], 0) / outerPts.length;
    }
    cx = Math.round(cx / GRID_MAJOR) * GRID_MAJOR;
    cy = Math.round(cy / GRID_MAJOR) * GRID_MAJOR;
    const base = points.length;
    const newPoints: Point[] = [...points, [cx - 5, cy - 5], [cx + 5, cy - 5], [cx, cy + 5]];
    const newPaths = [...paths, [base, base + 1, base + 2]];
    pushState({ points: newPoints, paths: newPaths });
    setActivePath(newPaths.length - 1);
    setSelectedIndex(null);
  };

  const removeHole = (pathIdx: number) => {
    if (pathIdx === 0) return; // can't remove outer
    const newPaths = paths.filter((_, i) => i !== pathIdx);
    pushState({ points: [...points], paths: newPaths });
    if (activePath >= newPaths.length) setActivePath(Math.max(0, newPaths.length - 1));
    setSelectedIndex(null);
  };

  // --- Output ---
  const convexity = paths[0]?.length >= 3 ? calcConvexity(state) : 1;

  const openscadOutput = (() => {
    const ptsStr = `[${points.map((p) => `[${p[0]},${p[1]}]`).join(',')}]`;
    const hasHoles = paths.length > 1;
    const pathsStr = `[${paths.map((p) => `[${p.join(',')}]`).join(',')}]`;
    if (hasHoles) {
      return `polygon(points=${ptsStr}, paths=${pathsStr}, convexity=${convexity});`;
    }
    if (convexity > 1) {
      return `polygon(points=${ptsStr}, convexity=${convexity});`;
    }
    return `polygon(points=${ptsStr});`;
  })();

  // Active path's points for the sidebar list
  const activeIndices = paths[activePath] || [];

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
            Click edge to insert point | Shift+drag point to move | Middle-mouse/Shift+click to pan | Scroll to zoom
          </div>
        </div>
        <div className="sidebar">
          <div className="image-controls">
            <h2>Background Image</h2>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              onChange={handleImageImport}
              style={{ display: 'none' }}
            />
            <div className="image-buttons">
              <button onClick={() => fileInputRef.current?.click()}>Import Image</button>
              {bgImage && <button onClick={() => setBgImage(null)} className="remove-btn">Remove</button>}
            </div>
            {bgImage && (
              <label className="slider-label">
                Image opacity: {Math.round(imageOpacity * 100)}%
                <input type="range" min="0" max="100" value={Math.round(imageOpacity * 100)}
                  onChange={(e) => setImageOpacity(Number(e.target.value) / 100)} />
              </label>
            )}
            <label className="slider-label">
              Polygon opacity: {Math.round(polyOpacity * 100)}%
              <input type="range" min="0" max="100" value={Math.round(polyOpacity * 100)}
                onChange={(e) => setPolyOpacity(Number(e.target.value) / 100)} />
            </label>
          </div>

          <h2>Paths</h2>
          <div className="path-list">
            {paths.map((_, pi) => {
              const color = PATH_COLORS[pi % PATH_COLORS.length];
              return (
                <div
                  key={pi}
                  className={`path-item ${pi === activePath ? 'active' : ''}`}
                  onClick={() => { setActivePath(pi); setSelectedIndex(null); }}
                >
                  <span className="path-color-dot" style={{ background: color.stroke }} />
                  <span className="path-name">{pi === 0 ? 'Outer' : `Hole ${pi}`}</span>
                  <span className="path-count">{paths[pi].length} pts</span>
                  {pi > 0 && (
                    <button className="remove-btn" onClick={(e) => { e.stopPropagation(); removeHole(pi); }}
                      title="Remove hole">x</button>
                  )}
                </div>
              );
            })}
            <button className="add-hole-btn" onClick={addHole}>+ Add Hole</button>
          </div>

          <h2>Points — {paths[activePath] ? (activePath === 0 ? 'Outer' : `Hole ${activePath}`) : ''} ({activeIndices.length})</h2>
          <div className="point-list">
            {activeIndices.map((gi, posInPath) => {
              const p = points[gi];
              return (
                <div
                  key={gi}
                  className={`point-item ${gi === selectedIndex ? 'selected' : ''}`}
                  onClick={() => setSelectedIndex(gi === selectedIndex ? null : gi)}
                >
                  <span className="point-index">{gi}</span>
                  <span className="point-coords">[{p[0]}, {p[1]}]</span>
                  <button className="move-btn" disabled={posInPath === 0}
                    onClick={(e) => { e.stopPropagation(); movePointInPath(gi, -1); }} title="Move up">^</button>
                  <button className="move-btn" disabled={posInPath === activeIndices.length - 1}
                    onClick={(e) => { e.stopPropagation(); movePointInPath(gi, 1); }} title="Move down">v</button>
                  <button className="remove-btn"
                    onClick={(e) => { e.stopPropagation(); removePoint(gi); }} title="Remove point">x</button>
                </div>
              );
            })}
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
                  <span className="history-summary">{entry.paths.length === 1 ? `${entry.points.length} pts` : `${entry.paths.length} paths, ${entry.points.length} pts`}</span>
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
