import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

type Point = [number, number];

interface PathDef {
  name: string;
  indices: number[];
}

/** All points in a flat list; paths index into them. paths[0] = outer, paths[1+] = holes */
interface PolyState {
  points: Point[];
  paths: PathDef[];
  label?: string;
}

const GRID_SIZE = 1;
const GRID_MAJOR = 10;
const INITIAL_SCALE = 4;
const MAX_HISTORY = 50;
const STORAGE_KEY = 'polygon-editor-history-v3';
const STORAGE_POS_KEY = 'polygon-editor-history-pos-v3';
const POINT_HIT_RADIUS = 10;
const EDGE_HIT_RADIUS = 8;

type EditMode = 'normal' | 'distance' | 'move' | 'moveAll' | 'angle' | 'length' | 'parallel' | 'duplicate' | 'view' | 'rotate' | 'rotateAll' | 'simplify';

/** Signed distance from point P to the infinite line through A→B.
 *  Positive = left side of A→B, negative = right side. */
function signedDistToLine(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - ax, py - ay);
  // cross product (B-A) × (P-A) / |B-A|
  return (dx * (py - ay) - dy * (px - ax)) / len;
}

/** Project point P onto the infinite line through A→B, return the closest point on the line. */
function projectOntoLine(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return [ax, ay];
  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  return [ax + t * dx, ay + t * dy];
}

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
  paths: [{ name: 'Outer', indices: [0, 1, 2] }],
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
  // Migrate from v2 format
  try {
    const rawV2 = localStorage.getItem('polygon-editor-history-v2');
    const rawPosV2 = localStorage.getItem('polygon-editor-history-pos-v2');
    const rawNames = localStorage.getItem('polygon-editor-path-names-v2');
    if (rawV2) {
      const v2Entries = JSON.parse(rawV2) as { points: Point[]; paths: number[][] }[];
      const names: string[] = rawNames ? JSON.parse(rawNames) : [];
      const entries: PolyState[] = v2Entries.map((e) => ({
        points: e.points,
        paths: e.paths.map((indices, pi) => ({
          name: names[pi] || (pi === 0 ? 'Outer' : `Hole ${pi}`),
          indices,
        })),
      }));
      const pos = rawPosV2 !== null ? Number(rawPosV2) : entries.length - 1;
      if (entries.length > 0 && pos >= 0 && pos < entries.length) {
        // Save as v3 and clean up v2
        saveHistory(entries, pos);
        localStorage.removeItem('polygon-editor-history-v2');
        localStorage.removeItem('polygon-editor-history-pos-v2');
        localStorage.removeItem('polygon-editor-path-names-v2');
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
  for (const pathDef of paths) {
    const path = pathDef.indices;
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

  let maxCrossings = 0;

  // Count crossings for a ray from origin (ox,oy) in direction (dx,dy)
  const countCrossings = (ox: number, oy: number, dx: number, dy: number): number => {
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
    return crossings;
  };

  const testRay = (ox: number, oy: number, dx: number, dy: number) => {
    const crossings = countCrossings(ox, oy, dx, dy);
    if (crossings > maxCrossings) maxCrossings = crossings;
  };

  // Collect all significant sample points: vertices + edge midpoints
  const samplePoints: Point[] = [...points];
  for (const [[x1, y1], [x2, y2]] of edges) {
    samplePoints.push([(x1 + x2) / 2, (y1 + y2) / 2]);
  }

  // Strategy 1: cast rays through each sample point at many angles
  const numAngles = 72;
  for (let ai = 0; ai < numAngles; ai++) {
    const angle = (ai * Math.PI) / numAngles;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (const [vx, vy] of samplePoints) {
      testRay(vx - dx * extent, vy - dy * extent, dx, dy);
    }
  }

  // Strategy 2: cast rays through every pair of sample points
  // Lines connecting points from different paths maximize boundary crossings
  // Limit to avoid O(n^2) blowup with many points
  const maxSamples = Math.min(samplePoints.length, 60);
  for (let i = 0; i < maxSamples; i++) {
    for (let j = i + 1; j < maxSamples; j++) {
      const [x1, y1] = samplePoints[i];
      const [x2, y2] = samplePoints[j];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-12) continue;
      const ndx = dx / len;
      const ndy = dy / len;
      testRay(x1 - ndx * extent, y1 - ndy * extent, ndx, ndy);
      // Small perpendicular offsets to avoid vertex-on-edge degeneracies
      const px = -ndy * 0.01;
      const py = ndx * 0.01;
      testRay(x1 - ndx * extent + px, y1 - ndy * extent + py, ndx, ndy);
      testRay(x1 - ndx * extent - px, y1 - ndy * extent - py, ndx, ndy);
    }
  }

  return Math.max(1, Math.ceil(maxCrossings / 2));
}

function parseOpenSCAD(text: string): PolyState | null {
  try {
    // Extract points: polygon(points=[[x,y],[x,y],...], ...)
    const pointsMatch = text.match(/points\s*=\s*\[(\[[\s\S]*?\])\s*\]/);
    if (!pointsMatch) return null;
    // Parse nested array of points
    const pointsStr = '[' + pointsMatch[1] + ']';
    const points: Point[] = JSON.parse(pointsStr);
    if (!Array.isArray(points) || points.length < 3) return null;
    for (const p of points) {
      if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null;
    }
    // Extract paths (optional)
    const pathsMatch = text.match(/paths\s*=\s*(\[[\s\S]*?\])\s*[,)]/);
    let rawPaths: number[][];
    if (pathsMatch) {
      rawPaths = JSON.parse(pathsMatch[1]);
      if (!Array.isArray(rawPaths) || rawPaths.length === 0) return null;
    } else {
      rawPaths = [points.map((_, i) => i)];
    }
    return {
      points: points.map(p => [p[0], p[1]] as Point),
      paths: rawPaths.map((indices, pi) => ({ name: pi === 0 ? 'Outer' : `Hole ${pi}`, indices })),
    };
  } catch {
    return null;
  }
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

  // Path names: derived from paths[i].name
  const [editingPathName, setEditingPathName] = useState<number | null>(null);

  const getPathName = (pi: number) => paths[pi]?.name || (pi === 0 ? 'Outer' : `Hole ${pi}`);

  const setPathName = (pi: number, name: string) => {
    const newPaths = paths.map((p, i) => i === pi ? { ...p, name } : p);
    // Update current history entry in-place (name change is part of state)
    setHistory((prev) => {
      const updated = [...prev];
      updated[historyPos] = { points, paths: newPaths };
      saveHistory(updated, historyPos);
      return updated;
    });
  };

  // Editing mode
  const [editMode, setEditMode] = useState<EditMode>('normal');
  // Distance mode state: selected point, selected edge (as [pathIdx, edgeIdx])
  const [distPoint, setDistPoint] = useState<number | null>(null);
  const [distEdge, setDistEdge] = useState<[number, number] | null>(null); // [pathIdx, positionInPath]
  const [distValue, setDistValue] = useState<string>('');

  // Move mode state
  const [moveDragging, setMoveDragging] = useState(false);
  const [moveStart, setMoveStart] = useState<[number, number]>([0, 0]); // world coords at drag start
  const [moveOrigPoints, setMoveOrigPoints] = useState<Point[]>([]); // points snapshot at drag start

  // Angle mode state: select points A, B, C; angle is at B between edges BA and BC
  const [anglePoints, setAnglePoints] = useState<number[]>([]); // up to 3 global indices [A, B, C]
  const [angleValue, setAngleValue] = useState<string>('');

  // Length mode state
  const [lengthEdge, setLengthEdge] = useState<[number, number] | null>(null); // [pathIdx, posInPath]
  const [lengthValue, setLengthValue] = useState<string>('');

  // Parallel mode state
  const [parallelBase, setParallelBase] = useState<[number, number] | null>(null); // base edge [pathIdx, posInPath]
  const [parallelTarget, setParallelTarget] = useState<[number, number] | null>(null); // target edge

  // Duplicate mode state: after duplicating, we enter a drag to place the copy
  const [dupDragging, setDupDragging] = useState(false);
  const [dupStart, setDupStart] = useState<[number, number]>([0, 0]);
  const [dupOrigPoints, setDupOrigPoints] = useState<Point[]>([]);
  const [dupNewPathIdx, setDupNewPathIdx] = useState<number | null>(null); // index of the newly created path

  // Rotate mode state
  const [rotatePivot, setRotatePivot] = useState<Point | null>(null); // world coords of pivot
  const [rotateDragging, setRotateDragging] = useState(false);
  const [rotateStartAngle, setRotateStartAngle] = useState(0); // angle of mouse at drag start
  const [rotateOrigPoints, setRotateOrigPoints] = useState<Point[]>([]);

  // Simplify mode state
  const [simplifyDecimals, setSimplifyDecimals] = useState(1);

  const pushState = useCallback((next: PolyState, label?: string) => {
    const entry = label ? { ...next, label } : next;
    setHistory((prev) => {
      const trimmed = prev.slice(0, historyPos + 1);
      const updated = [...trimmed, entry].slice(-MAX_HISTORY);
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
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [showAngles, setShowAngles] = useState(false);
  const [showLengths, setShowLengths] = useState(false);
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

  const toWorldRaw = useCallback(
    (cx: number, cy: number): [number, number] => {
      const wx = (cx - offset[0]) / scale;
      const wy = (offset[1] - cy) / scale;
      return [wx, wy];
    },
    [offset, scale]
  );

  // Get points for a specific path, with drag preview applied
  const getPathPoints = useCallback((pathIdx: number): Point[] => {
    const pathDef = paths[pathIdx];
    if (!pathDef) return [];
    return pathDef.indices.map((gi) => {
      if (dragIndex === gi && dragPreview !== null) return dragPreview;
      return points[gi];
    });
  }, [points, paths, dragIndex, dragPreview]);

  // Active path's global indices
  const activePathIndices = paths[activePath]?.indices || [];

  // Compute current distance for distance mode
  const distInfo = (() => {
    if (distPoint === null || distEdge === null) return null;
    const [pi, ei] = distEdge;
    const pathDef = paths[pi];
    if (!pathDef || ei >= pathDef.indices.length) return null;
    const gi1 = pathDef.indices[ei];
    const gi2 = pathDef.indices[(ei + 1) % pathDef.indices.length];
    const a = points[gi1];
    const b = points[gi2];
    const p = points[distPoint];
    if (!a || !b || !p) return null;
    const dist = signedDistToLine(p[0], p[1], a[0], a[1], b[0], b[1]);
    return { a, b, p, dist, gi1, gi2 };
  })();

  // When distPoint/distEdge/points change, update the input value
  useEffect(() => {
    if (distInfo) {
      setDistValue(String(Math.round(Math.abs(distInfo.dist) * 1000) / 1000));
    }
  }, [distPoint, distEdge, points]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyDistance = useCallback(() => {
    if (distPoint === null || distEdge === null || !distInfo) return;
    const newDist = parseFloat(distValue);
    if (isNaN(newDist) || newDist < 0) return;
    const { a, b, p } = distInfo;
    // Project point onto the line, then offset by newDist in the same direction
    const [projX, projY] = projectOntoLine(p[0], p[1], a[0], a[1], b[0], b[1]);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    // Normal pointing left of A→B
    const nx = -dy / len;
    const ny = dx / len;
    // Preserve the side: if current signed dist is negative, place on negative side
    // If dist is ~0, default to positive (left) side
    const sign = distInfo.dist < -1e-9 ? -1 : 1;
    // Don't grid-snap: use exact floating point to honor the distance precisely
    const wx = projX + nx * newDist * sign;
    const wy = projY + ny * newDist * sign;
    // Round to reasonable precision to avoid floating point noise
    const finalX = Math.round(wx * 1000) / 1000;
    const finalY = Math.round(wy * 1000) / 1000;
    // Only push if the point actually moved
    if (finalX === p[0] && finalY === p[1]) return;
    const newPoints = [...points];
    newPoints[distPoint] = [finalX, finalY];
    pushState({ points: newPoints, paths }, 'Set distance');
  }, [distPoint, distEdge, distInfo, distValue, points, paths, pushState]);

  // Angle mode: compute current angle at B between edges BA and BC (in degrees)
  const angleInfo = (() => {
    if (anglePoints.length < 3) return null;
    const [ai, bi, ci] = anglePoints;
    const a = points[ai];
    const b = points[bi];
    const c = points[ci];
    if (!a || !b || !c) return null;
    const bax = a[0] - b[0], bay = a[1] - b[1];
    const bcx = c[0] - b[0], bcy = c[1] - b[1];
    const dot = bax * bcx + bay * bcy;
    const cross = bax * bcy - bay * bcx;
    // Unsigned angle (always 0..180)
    const angle = Math.atan2(Math.abs(cross), dot) * (180 / Math.PI);
    // Signed angle from BA to BC (positive = counterclockwise)
    const signedAngle = Math.atan2(cross, dot);
    return { a, b, c, angle, cross, signedAngle };
  })();

  // Sync angle input when selection changes
  useEffect(() => {
    if (angleInfo) {
      setAngleValue(String(Math.round(angleInfo.angle * 1000) / 1000));
    }
  }, [anglePoints[0], anglePoints[1], anglePoints[2], points]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyAngle = useCallback(() => {
    if (anglePoints.length < 3 || !angleInfo) return;
    const newAngle = parseFloat(angleValue);
    if (isNaN(newAngle) || newAngle <= 0 || newAngle >= 360) return;
    const [, , ci] = anglePoints;
    const { b, c, signedAngle } = angleInfo;
    const a = points[anglePoints[0]];
    const bcLen = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (bcLen === 0) return;
    // Compute the current absolute angle of BA direction
    const baAngle = Math.atan2(a[1] - b[1], a[0] - b[0]);
    // Preserve direction: signedAngle tells us which way C is rotated from BA
    // Apply new magnitude with same sign
    const sign = signedAngle >= 0 ? 1 : -1;
    const newSignedAngle = sign * newAngle * (Math.PI / 180);
    // BC angle = BA angle + signed rotation from BA to BC
    const newBcAngle = baAngle + newSignedAngle;
    const newCx = Math.round((b[0] + bcLen * Math.cos(newBcAngle)) * 1000) / 1000;
    const newCy = Math.round((b[1] + bcLen * Math.sin(newBcAngle)) * 1000) / 1000;
    if (newCx === c[0] && newCy === c[1]) return;
    const newPoints = [...points];
    newPoints[ci] = [newCx, newCy];
    pushState({ points: newPoints, paths }, 'Set angle');
  }, [anglePoints, angleInfo, angleValue, points, paths, pushState]);

  // Length mode: compute current edge length
  const lengthInfo = (() => {
    if (lengthEdge === null) return null;
    const [pi, ei] = lengthEdge;
    const pathDef = paths[pi];
    if (!pathDef || ei >= pathDef.indices.length) return null;
    const gi1 = pathDef.indices[ei];
    const gi2 = pathDef.indices[(ei + 1) % pathDef.indices.length];
    const a = points[gi1];
    const b = points[gi2];
    if (!a || !b) return null;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { a, b, length, gi1, gi2 };
  })();

  useEffect(() => {
    if (lengthInfo) {
      setLengthValue(String(Math.round(lengthInfo.length * 1000) / 1000));
    }
  }, [lengthEdge, points]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyLength = useCallback(() => {
    if (lengthEdge === null || !lengthInfo) return;
    const newLen = parseFloat(lengthValue);
    if (isNaN(newLen) || newLen <= 0) return;
    const { a, b, length, gi2 } = lengthInfo;
    if (length === 0) return;
    // Move endpoint B along the A→B direction to achieve newLen
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const sc = newLen / length;
    const newBx = Math.round((a[0] + dx * sc) * 1000) / 1000;
    const newBy = Math.round((a[1] + dy * sc) * 1000) / 1000;
    if (newBx === b[0] && newBy === b[1]) return;
    const newPoints = [...points];
    newPoints[gi2] = [newBx, newBy];
    pushState({ points: newPoints, paths }, 'Set length');
  }, [lengthEdge, lengthInfo, lengthValue, points, paths, pushState]);

  // Parallel mode: compute info
  const parallelInfo = (() => {
    if (parallelBase === null || parallelTarget === null) return null;
    const [bpi, bei] = parallelBase;
    const [tpi, tei] = parallelTarget;
    const bPath = paths[bpi];
    const tPath = paths[tpi];
    if (!bPath || !tPath) return null;
    const bgi1 = bPath.indices[bei], bgi2 = bPath.indices[(bei + 1) % bPath.indices.length];
    const tgi1 = tPath.indices[tei], tgi2 = tPath.indices[(tei + 1) % tPath.indices.length];
    const ba = points[bgi1], bb = points[bgi2];
    const ta = points[tgi1], tb = points[tgi2];
    if (!ba || !bb || !ta || !tb) return null;
    const baseAngle = Math.atan2(bb[1] - ba[1], bb[0] - ba[0]);
    const targetAngle = Math.atan2(tb[1] - ta[1], tb[0] - ta[0]);
    return { ba, bb, ta, tb, baseAngle, targetAngle, tgi1, tgi2 };
  })();

  const applyParallel = useCallback(() => {
    if (!parallelInfo) return;
    const { ta, tb, baseAngle, targetAngle, tgi1, tgi2 } = parallelInfo;
    // Rotate target edge around its midpoint to match base angle
    // Choose the closer of the two parallel directions (same or opposite)
    let angleDiff = baseAngle - targetAngle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    let angleDiff2 = angleDiff + Math.PI;
    while (angleDiff2 > Math.PI) angleDiff2 -= 2 * Math.PI;
    while (angleDiff2 < -Math.PI) angleDiff2 += 2 * Math.PI;
    const rot = Math.abs(angleDiff) <= Math.abs(angleDiff2) ? angleDiff : angleDiff2;

    const mx = (ta[0] + tb[0]) / 2;
    const my = (ta[1] + tb[1]) / 2;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const rotateAround = (px: number, py: number): Point => {
      const dx = px - mx;
      const dy = py - my;
      return [
        Math.round((mx + dx * cosR - dy * sinR) * 1000) / 1000,
        Math.round((my + dx * sinR + dy * cosR) * 1000) / 1000,
      ];
    };
    const newA = rotateAround(ta[0], ta[1]);
    const newB = rotateAround(tb[0], tb[1]);
    if (newA[0] === ta[0] && newA[1] === ta[1] && newB[0] === tb[0] && newB[1] === tb[1]) return;
    const newPoints = [...points];
    newPoints[tgi1] = newA;
    newPoints[tgi2] = newB;
    pushState({ points: newPoints, paths }, 'Make parallel');
  }, [parallelInfo, points, paths, pushState]);

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
      for (let k = paths[pi].indices.length - 1; k >= 0; k--) {
        const gi = paths[pi].indices[k];
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

  // Hit test edge on ANY path; returns [pathIdx, positionInPath] or null
  const hitTestEdgeAny = useCallback((cx: number, cy: number): [number, number] | null => {
    let bestDist = Infinity;
    let bestResult: [number, number] | null = null;
    for (let pi = 0; pi < paths.length; pi++) {
      const path = paths[pi].indices;
      if (path.length < 2) continue;
      for (let i = 0; i < path.length; i++) {
        const j = (i + 1) % path.length;
        const [ax, ay] = toCanvas(points[path[i]][0], points[path[i]][1]);
        const [bx, by] = toCanvas(points[path[j]][0], points[path[j]][1]);
        const d = distToSegment(cx, cy, ax, ay, bx, by);
        if (d < EDGE_HIT_RADIUS && d < bestDist) {
          bestDist = d;
          bestResult = [pi, i];
        }
      }
    }
    return bestResult;
  }, [points, paths, toCanvas]);

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
        const inMoveMode = editMode === 'move' || editMode === 'duplicate';
        ctx.strokeStyle = (inMoveMode && !isActive) ? '#555' : color.stroke;
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
      const path = paths[pi].indices;
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
        const inMoveMode = editMode === 'move' || editMode === 'duplicate';
        ctx.fillStyle = (inMoveMode && !isActivePath) ? '#555' : isDragging ? '#ffaa00' : isSelected ? '#ff4444' : color.stroke;
        ctx.globalAlpha = isActivePath ? 1 : (inMoveMode ? 0.3 : 0.5);
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

    // Distance mode visual feedback
    if (editMode === 'distance') {
      // Highlight selected point
      if (distPoint !== null && points[distPoint]) {
        const [px, py] = toCanvas(points[distPoint][0], points[distPoint][1]);
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.strokeStyle = '#00ffcc';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Highlight selected edge
      if (distEdge !== null) {
        const [pi, ei] = distEdge;
        const pathDef = paths[pi];
        if (pathDef) {
          const gi1 = pathDef.indices[ei];
          const gi2 = pathDef.indices[(ei + 1) % pathDef.indices.length];
          const a = points[gi1];
          const b = points[gi2];
          if (a && b) {
            const [ax, ay] = toCanvas(a[0], a[1]);
            const [bx, by] = toCanvas(b[0], b[1]);
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.strokeStyle = '#00ffcc';
            ctx.lineWidth = 3;
            ctx.stroke();

            // Draw the perpendicular line from point to the infinite line
            if (distPoint !== null && points[distPoint]) {
              const p = points[distPoint];
              const [projX, projY] = projectOntoLine(p[0], p[1], a[0], a[1], b[0], b[1]);
              const [cpx, cpy] = toCanvas(p[0], p[1]);
              const [cProjX, cProjY] = toCanvas(projX, projY);
              ctx.beginPath();
              ctx.moveTo(cpx, cpy);
              ctx.lineTo(cProjX, cProjY);
              ctx.strokeStyle = '#ffcc00';
              ctx.lineWidth = 1.5;
              ctx.setLineDash([3, 3]);
              ctx.stroke();
              ctx.setLineDash([]);

              // Small right-angle indicator
              const dist = Math.abs(signedDistToLine(p[0], p[1], a[0], a[1], b[0], b[1]));
              const midX = (cpx + cProjX) / 2;
              const midY = (cpy + cProjY) / 2;
              ctx.fillStyle = '#ffcc00';
              ctx.font = 'bold 12px monospace';
              ctx.fillText(String(Math.round(dist * 100) / 100), midX + 6, midY - 6);
            }
          }
        }
      }
    }

    // Angle mode visual feedback
    if (editMode === 'angle' && anglePoints.length > 0) {
      // Highlight selected points
      for (let i = 0; i < anglePoints.length; i++) {
        const pt = points[anglePoints[i]];
        if (!pt) continue;
        const [px, py] = toCanvas(pt[0], pt[1]);
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.strokeStyle = i === 1 ? '#ff44ff' : '#00ffcc'; // B is magenta, A/C are cyan
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        // Label
        ctx.fillStyle = i === 1 ? '#ff44ff' : '#00ffcc';
        ctx.font = 'bold 12px monospace';
        ctx.fillText(['A', 'B', 'C'][i], px + 14, py - 10);
      }
      // Draw edges BA and BC
      if (anglePoints.length >= 2) {
        const a = points[anglePoints[0]];
        const b = points[anglePoints[1]];
        if (a && b) {
          const [ax, ay] = toCanvas(a[0], a[1]);
          const [bx, by] = toCanvas(b[0], b[1]);
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ax, ay);
          ctx.strokeStyle = '#ff44ff'; ctx.lineWidth = 2; ctx.stroke();
        }
      }
      if (anglePoints.length >= 3) {
        const b = points[anglePoints[1]];
        const c = points[anglePoints[2]];
        if (b && c) {
          const [bx, by] = toCanvas(b[0], b[1]);
          const [cx2, cy2] = toCanvas(c[0], c[1]);
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(cx2, cy2);
          ctx.strokeStyle = '#ff44ff'; ctx.lineWidth = 2; ctx.stroke();
        }
        // Draw arc showing the angle
        if (angleInfo) {
          const bPt = points[anglePoints[1]];
          const [bx, by] = toCanvas(bPt[0], bPt[1]);
          const aPt = points[anglePoints[0]];
          const cPt = points[anglePoints[2]];
          const baAngle = Math.atan2(-(aPt[1] - bPt[1]), aPt[0] - bPt[0]); // canvas Y is flipped
          const bcAngle = Math.atan2(-(cPt[1] - bPt[1]), cPt[0] - bPt[0]);
          ctx.beginPath();
          const radius = 25;
          // Draw arc from BA angle to BC angle
          const startAngle = angleInfo.cross >= 0 ? bcAngle : baAngle;
          const endAngle = angleInfo.cross >= 0 ? baAngle : bcAngle;
          ctx.arc(bx, by, radius, startAngle, endAngle);
          ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 1.5; ctx.stroke();
          // Label
          const midAngle = (startAngle + endAngle) / 2;
          ctx.fillStyle = '#ffcc00'; ctx.font = 'bold 11px monospace';
          ctx.fillText(`${Math.round(angleInfo.angle * 10) / 10}°`, bx + 30 * Math.cos(midAngle), by + 30 * Math.sin(midAngle));
        }
      }
    }

    // Length mode visual feedback
    if (editMode === 'length' && lengthEdge !== null && lengthInfo) {
      const { a, b } = lengthInfo;
      const [ax, ay] = toCanvas(a[0], a[1]);
      const [bx, by] = toCanvas(b[0], b[1]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.strokeStyle = '#00ffcc'; ctx.lineWidth = 3; ctx.stroke();
      // Length label at midpoint
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      ctx.fillStyle = '#00ffcc'; ctx.font = 'bold 12px monospace';
      ctx.fillText(String(Math.round(lengthInfo.length * 100) / 100), mx + 6, my - 6);
    }

    // Parallel mode visual feedback
    if (editMode === 'parallel') {
      const drawEdgeHighlight = (edge: [number, number], color: string, label: string) => {
        const [pi, ei] = edge;
        const pathDef = paths[pi];
        if (!pathDef) return;
        const gi1 = pathDef.indices[ei];
        const gi2 = pathDef.indices[(ei + 1) % pathDef.indices.length];
        const a = points[gi1], b = points[gi2];
        if (!a || !b) return;
        const [ax, ay] = toCanvas(a[0], a[1]);
        const [bx, by] = toCanvas(b[0], b[1]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = color; ctx.font = 'bold 11px monospace';
        ctx.fillText(label, (ax + bx) / 2 + 6, (ay + by) / 2 - 6);
      };
      if (parallelBase !== null) drawEdgeHighlight(parallelBase, '#44ff44', 'base');
      if (parallelTarget !== null) drawEdgeHighlight(parallelTarget, '#ff44ff', 'target');
    }

    // Rotate mode: draw pivot point
    if ((editMode === 'rotate' || editMode === 'rotateAll') && rotatePivot) {
      const [px, py] = toCanvas(rotatePivot[0], rotatePivot[1]);
      // Crosshair
      ctx.strokeStyle = '#ff44ff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px - 12, py); ctx.lineTo(px + 12, py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, py - 12); ctx.lineTo(px, py + 12); ctx.stroke();
      // Circle
      ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.strokeStyle = '#ff44ff'; ctx.lineWidth = 1.5; ctx.stroke();
      // Label
      ctx.fillStyle = '#ff44ff'; ctx.font = 'bold 10px monospace';
      ctx.fillText('pivot', px + 12, py - 10);
    }

    // Show all edge lengths overlay
    if (showLengths) {
      ctx.font = editMode === 'view' ? 'bold 14px monospace' : 'bold 13px monospace';
      for (let pi = 0; pi < paths.length; pi++) {
        const path = paths[pi].indices;
        if (path.length < 2) continue;
        const color = PATH_COLORS[pi % PATH_COLORS.length].stroke;
        ctx.fillStyle = color;
        for (let ei = 0; ei < path.length; ei++) {
          const gi1 = path[ei];
          const gi2 = path[(ei + 1) % path.length];
          const a = points[gi1], b = points[gi2];
          if (!a || !b) continue;
          const len = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 100) / 100;
          const [ax, ay] = toCanvas(a[0], a[1]);
          const [bx, by] = toCanvas(b[0], b[1]);
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          // offset label perpendicular to edge
          const edx = bx - ax, edy = by - ay;
          const elen = Math.hypot(edx, edy) || 1;
          const nx = -edy / elen * 12, ny = edx / elen * 12;
          ctx.fillText(String(len), mx + nx, my + ny);
        }
      }
    }

    // Show all angles overlay
    if (showAngles) {
      ctx.font = editMode === 'view' ? 'bold 13px monospace' : 'bold 12px monospace';
      for (let pi = 0; pi < paths.length; pi++) {
        const path = paths[pi].indices;
        if (path.length < 3) continue;
        const color = PATH_COLORS[pi % PATH_COLORS.length].stroke;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        for (let i = 0; i < path.length; i++) {
          const prevIdx = path[(i - 1 + path.length) % path.length];
          const curIdx = path[i];
          const nextIdx = path[(i + 1) % path.length];
          const prev = points[prevIdx], cur = points[curIdx], next = points[nextIdx];
          if (!prev || !cur || !next) continue;
          // Interior angle at cur between prev-cur-next
          const ax = prev[0] - cur[0], ay = prev[1] - cur[1];
          const bx = next[0] - cur[0], by = next[1] - cur[1];
          const dot = ax * bx + ay * by;
          const cross = ax * by - ay * bx;
          const angle = Math.abs(Math.atan2(cross, dot)) * 180 / Math.PI;
          const [cx2, cy2] = toCanvas(cur[0], cur[1]);
          // Draw small arc
          // Canvas angles: note Y is flipped in our toCanvas
          const aAngle = Math.atan2(-(prev[1] - cur[1]), prev[0] - cur[0]);
          const bAngle = Math.atan2(-(next[1] - cur[1]), next[0] - cur[0]);
          ctx.beginPath();
          const r = 18;
          if (cross >= 0) {
            ctx.arc(cx2, cy2, r, bAngle, aAngle);
          } else {
            ctx.arc(cx2, cy2, r, aAngle, bAngle);
          }
          ctx.lineWidth = 1;
          ctx.stroke();
          const midA = (aAngle + bAngle) / 2 + (cross >= 0 ? 0 : Math.PI);
          ctx.fillText(`${Math.round(angle * 10) / 10}°`, cx2 + 22 * Math.cos(midA), cy2 + 22 * Math.sin(midA));
        }
      }
    }
  }, [getPathPoints, points, paths, selectedIndex, activePath, dragIndex, dragPreview, offset, scale, toCanvas, canvasSize, bgImage, imageOpacity, polyOpacity, editMode, distPoint, distEdge, anglePoints, angleInfo, lengthEdge, lengthInfo, parallelBase, parallelTarget, showAngles, showLengths, rotatePivot]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (editMode === 'view') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, editMode]);

  // --- Mouse handlers ---
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (e.button === 1) {
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }
    if (editMode === 'view') {
      if (e.button === 0 && e.shiftKey) { setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); }
      return;
    }
    if (e.button !== 0) return;

    // Pan with shift+click on empty space (shared across modes)
    if (e.shiftKey && editMode === 'normal') {
      const hitPt = hitTestPoint(cx, cy);
      if (hitPt !== null) {
        setDragIndex(hitPt); setDragPreview(points[hitPt]); setSelectedIndex(hitPt);
        for (let pi = 0; pi < paths.length; pi++) {
          if (paths[pi].indices.includes(hitPt)) { setActivePath(pi); break; }
        }
        e.preventDefault(); return;
      }
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }

    if (e.shiftKey && editMode === 'distance') {
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }

    if (e.shiftKey && (editMode === 'move' || editMode === 'moveAll' || editMode === 'duplicate' || editMode === 'rotate' || editMode === 'rotateAll' || editMode === 'simplify')) {
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }

    if (e.shiftKey && editMode === 'angle') {
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }

    if (e.shiftKey && (editMode === 'length' || editMode === 'parallel')) {
      setIsPanning(true); setPanStart([e.clientX, e.clientY]); setOffsetStart([...offset]); e.preventDefault(); return;
    }

    // Distance mode clicks
    if (editMode === 'distance') {
      // Step 1: select a point
      if (distPoint === null) {
        const hitPt = hitTestPoint(cx, cy);
        if (hitPt !== null) {
          setDistPoint(hitPt);
          setDistEdge(null);
        }
        return;
      }
      // Step 2: select an edge
      if (distEdge === null) {
        // Allow clicking a different point to re-select
        const hitPt = hitTestPoint(cx, cy);
        if (hitPt !== null) {
          // If clicking the same point, deselect
          if (hitPt === distPoint) { setDistPoint(null); return; }
          setDistPoint(hitPt);
          return;
        }
        const hitEdgeResult = hitTestEdgeAny(cx, cy);
        if (hitEdgeResult !== null) {
          // Don't allow selecting an edge that contains the selected point
          const [pi, ei] = hitEdgeResult;
          const path = paths[pi].indices;
          const gi1 = path[ei];
          const gi2 = path[(ei + 1) % path.length];
          if (gi1 !== distPoint && gi2 !== distPoint) {
            setDistEdge(hitEdgeResult);
          }
        }
        return;
      }
      // Step 3: already have both, clicking resets
      const hitPt = hitTestPoint(cx, cy);
      if (hitPt !== null) {
        setDistPoint(hitPt);
        setDistEdge(null);
        return;
      }
      const hitEdgeResult = hitTestEdgeAny(cx, cy);
      if (hitEdgeResult !== null) {
        const [pi, ei] = hitEdgeResult;
        const path = paths[pi].indices;
        const gi1 = path[ei];
        const gi2 = path[(ei + 1) % path.length];
        if (gi1 !== distPoint && gi2 !== distPoint) {
          setDistEdge(hitEdgeResult);
        }
        return;
      }
      return;
    }

    // Duplicate mode: drag to move the active path
    if (editMode === 'duplicate') {
      if (!dupDragging) {
        const [wx, wy] = toWorld(cx, cy);
        setDupDragging(true);
        setDupStart([wx, wy]);
        setDupOrigPoints([...points]);
      }
      return;
    }

    // Rotate / Rotate All mode: first click sets pivot, subsequent drag rotates
    if (editMode === 'rotate' || editMode === 'rotateAll') {
      if (rotatePivot === null) {
        // Set pivot: snap to existing point if close, otherwise use world coords
        const hitPt = hitTestPoint(cx, cy);
        if (hitPt !== null) {
          setRotatePivot(points[hitPt]);
        } else {
          setRotatePivot(toWorld(cx, cy));
        }
      } else {
        // Start rotation drag
        const [wx, wy] = toWorldRaw(cx, cy);
        const angle = Math.atan2(wy - rotatePivot[1], wx - rotatePivot[0]);
        setRotateDragging(true);
        setRotateStartAngle(angle);
        setRotateOrigPoints([...points]);
      }
      return;
    }

    // Length mode: select an edge
    if (editMode === 'length') {
      const hitEdgeResult = hitTestEdgeAny(cx, cy);
      if (hitEdgeResult !== null) {
        setLengthEdge(hitEdgeResult);
      }
      return;
    }

    // Parallel mode: select base edge, then target edge
    if (editMode === 'parallel') {
      const hitEdgeResult = hitTestEdgeAny(cx, cy);
      if (hitEdgeResult !== null) {
        if (parallelBase === null) {
          setParallelBase(hitEdgeResult);
          setParallelTarget(null);
        } else if (parallelTarget === null) {
          // Don't allow same edge as target
          if (hitEdgeResult[0] === parallelBase[0] && hitEdgeResult[1] === parallelBase[1]) return;
          setParallelTarget(hitEdgeResult);
        } else {
          // Re-select: click sets new base
          setParallelBase(hitEdgeResult);
          setParallelTarget(null);
        }
      }
      return;
    }

    // Angle mode: select 3 points A, B, C
    if (editMode === 'angle') {
      const hitPt = hitTestPoint(cx, cy);
      if (hitPt !== null) {
        if (anglePoints.length < 3) {
          setAnglePoints([...anglePoints, hitPt]);
        } else {
          // Reset, start new selection
          setAnglePoints([hitPt]);
        }
      }
      return;
    }

    // Move All mode: drag to move every point in every path
    if (editMode === 'moveAll') {
      const [wx, wy] = toWorld(cx, cy);
      setMoveDragging(true);
      setMoveStart([wx, wy]);
      setMoveOrigPoints([...points]);
      return;
    }

    // Move mode: drag to move all points in active path
    if (editMode === 'move') {
      const [wx, wy] = toWorld(cx, cy);
      setMoveDragging(true);
      setMoveStart([wx, wy]);
      setMoveOrigPoints([...points]);
      return;
    }

    // Normal mode: click on edge of active path to insert point
    if (editMode !== 'normal') return;
    const hitEdge = hitTestEdge(cx, cy);
    if (hitEdge !== null) {
      const [wx, wy] = toWorld(cx, cy);
      const newGlobalIdx = points.length;
      const newPoints = [...points, [wx, wy] as Point];
      const newPaths = paths.map((p, pi) => {
        if (pi !== activePath) return { ...p, indices: [...p.indices] };
        const np = [...p.indices];
        np.splice(hitEdge + 1, 0, newGlobalIdx);
        return { ...p, indices: np };
      });
      pushState({ points: newPoints, paths: newPaths }, 'Point added');
      setSelectedIndex(newGlobalIdx);
      return;
    }

    // Click on a point: select it (and switch to its path)
    const hitPt = hitTestPoint(cx, cy);
    if (hitPt !== null) {
      setSelectedIndex(hitPt === selectedIndex ? null : hitPt);
      for (let pi = 0; pi < paths.length; pi++) {
        if (paths[pi].indices.includes(hitPt)) { setActivePath(pi); break; }
      }
      return;
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) {
      setOffset([offsetStart[0] + e.clientX - panStart[0], offsetStart[1] + e.clientY - panStart[1]]);
      return;
    }
    if (moveDragging) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      const dx = wx - moveStart[0];
      const dy = wy - moveStart[1];
      const newPoints = moveOrigPoints.map((p, gi) => {
        if (editMode === 'moveAll' || (paths[activePath]?.indices || []).includes(gi)) {
          return [p[0] + dx, p[1] + dy] as Point;
        }
        return p;
      });
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: newPoints, paths };
        return updated;
      });
      return;
    }
    if (dupDragging) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const [wx, wy] = toWorld(e.clientX - rect.left, e.clientY - rect.top);
      const dx = wx - dupStart[0];
      const dy = wy - dupStart[1];
      const pathIndices = paths[activePath]?.indices || [];
      const newPoints = [...dupOrigPoints];
      for (const gi of pathIndices) {
        if (dupOrigPoints[gi]) {
          newPoints[gi] = [dupOrigPoints[gi][0] + dx, dupOrigPoints[gi][1] + dy];
        }
      }
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: newPoints, paths };
        return updated;
      });
      return;
    }
    if (rotateDragging && rotatePivot) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const [wx, wy] = toWorldRaw(e.clientX - rect.left, e.clientY - rect.top);
      const currentAngle = Math.atan2(wy - rotatePivot[1], wx - rotatePivot[0]);
      const deltaAngle = currentAngle - rotateStartAngle;
      const cosA = Math.cos(deltaAngle);
      const sinA = Math.sin(deltaAngle);
      const px = rotatePivot[0], py = rotatePivot[1];
      const activeIndicesSet = new Set(paths[activePath]?.indices || []);
      const newPoints = rotateOrigPoints.map((p, gi) => {
        if (editMode === 'rotateAll' || activeIndicesSet.has(gi)) {
          const dx = p[0] - px;
          const dy = p[1] - py;
          return [px + dx * cosA - dy * sinA, py + dx * sinA + dy * cosA] as Point;
        }
        return p;
      });
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: newPoints, paths };
        return updated;
      });
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
    if (editMode === 'move' || editMode === 'moveAll') {
      canvas.style.cursor = moveDragging ? 'grabbing' : 'grab';
    } else if (editMode === 'duplicate') {
      canvas.style.cursor = dupDragging ? 'grabbing' : 'grab';
    } else if (editMode === 'rotate' || editMode === 'rotateAll') {
      if (rotateDragging) canvas.style.cursor = 'grabbing';
      else if (rotatePivot === null) canvas.style.cursor = 'crosshair';
      else canvas.style.cursor = 'grab';
    } else if (editMode === 'length' || editMode === 'parallel') {
      canvas.style.cursor = hitTestEdgeAny(cx, cy) !== null ? 'crosshair' : 'default';
    } else if (editMode === 'angle') {
      canvas.style.cursor = hitTestPoint(cx, cy) !== null ? 'pointer' : 'default';
    } else if (editMode === 'distance') {
      if (hitTestPoint(cx, cy) !== null) canvas.style.cursor = 'pointer';
      else if (distPoint !== null && hitTestEdgeAny(cx, cy) !== null) canvas.style.cursor = 'crosshair';
      else canvas.style.cursor = 'default';
    } else {
      if (e.shiftKey && hitTestPoint(cx, cy) !== null) canvas.style.cursor = 'grab';
      else if (hitTestPoint(cx, cy) !== null) canvas.style.cursor = 'pointer';
      else if (hitTestEdge(cx, cy) !== null) canvas.style.cursor = 'copy';
      else canvas.style.cursor = 'default';
    }
  };

  const handleMouseUp = () => {
    if (rotateDragging) {
      setRotateDragging(false);
      const currentPoints = [...points];
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: rotateOrigPoints, paths };
        return updated;
      });
      pushState({ points: currentPoints, paths }, 'Rotated');
      return;
    }
    if (moveDragging) {
      setMoveDragging(false);
      const currentPoints = [...points];
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: moveOrigPoints, paths };
        return updated;
      });
      pushState({ points: currentPoints, paths }, editMode === 'moveAll' ? 'Moved all' : 'Moved path');
      return;
    }
    if (dupDragging) {
      setDupDragging(false);
      const currentPoints = [...points];
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: dupOrigPoints, paths };
        return updated;
      });
      pushState({ points: currentPoints, paths }, 'Placed duplicate');
      // Keep dupNewPathIdx so the duplicate can be dragged again
      return;
    }
    if (dragIndex !== null && dragPreview !== null) {
      const newPoints = [...points];
      newPoints[dragIndex] = dragPreview;
      pushState({ points: newPoints, paths }, 'Point moved');
      setDragIndex(null); setDragPreview(null);
      return;
    }
    setIsPanning(false);
  };

  const handleMouseLeave = () => {
    if (rotateDragging) {
      setRotateDragging(false);
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: rotateOrigPoints, paths };
        return updated;
      });
    }
    if (moveDragging) {
      setMoveDragging(false);
      setHistory((prev) => {
        const updated = [...prev];
        updated[historyPos] = { points: moveOrigPoints, paths };
        return updated;
      });
    }
    if (dupDragging) {
      // Don't cancel duplicate on leave — keep it where it is
      setDupDragging(false);
      setDupNewPathIdx(null);
    }
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
      if (paths[pi].indices.includes(globalIdx)) { ownerPath = pi; break; }
    }
    if (ownerPath < 0) return;

    const newPaths = paths.map((p, pi) => {
      if (pi !== ownerPath) return { ...p, indices: [...p.indices] };
      return { ...p, indices: p.indices.filter((gi) => gi !== globalIdx) };
    });
    // Don't allow removing a path's last 3 points for outer, or last 3 for a hole
    if (ownerPath === 0 && newPaths[0].indices.length < 3) return;
    // If a hole goes below 3 points, remove the whole hole path
    if (ownerPath > 0 && newPaths[ownerPath].indices.length < 3) {
      newPaths.splice(ownerPath, 1);
      if (activePath >= newPaths.length) setActivePath(Math.max(0, newPaths.length - 1));
    }
    pushState({ points: [...points], paths: newPaths }, 'Point removed');
    if (selectedIndex === globalIdx) setSelectedIndex(null);
  };

  const movePointInPath = (globalIdx: number, direction: -1 | 1) => {
    let ownerPath = -1;
    let posInPath = -1;
    for (let pi = 0; pi < paths.length; pi++) {
      const idx = paths[pi].indices.indexOf(globalIdx);
      if (idx >= 0) { ownerPath = pi; posInPath = idx; break; }
    }
    if (ownerPath < 0) return;
    const pathIndices = paths[ownerPath].indices;
    const target = posInPath + direction;
    if (target < 0 || target >= pathIndices.length) return;
    const newPaths = paths.map((p, pi) => {
      if (pi !== ownerPath) return { ...p, indices: [...p.indices] };
      const np = [...p.indices];
      [np[posInPath], np[target]] = [np[target], np[posInPath]];
      return { ...p, indices: np };
    });
    pushState({ points: [...points], paths: newPaths }, 'Point reordered');
    setSelectedIndex(globalIdx);
  };

  const addHole = () => {
    // Place a small triangle hole near the center of the outer path
    const outerPts = (paths[0]?.indices || []).map((gi) => points[gi]);
    let cx = 25, cy = 20;
    if (outerPts.length >= 3) {
      cx = outerPts.reduce((s, p) => s + p[0], 0) / outerPts.length;
      cy = outerPts.reduce((s, p) => s + p[1], 0) / outerPts.length;
    }
    cx = Math.round(cx / GRID_MAJOR) * GRID_MAJOR;
    cy = Math.round(cy / GRID_MAJOR) * GRID_MAJOR;
    const base = points.length;
    const newPoints: Point[] = [...points, [cx - 5, cy - 5], [cx + 5, cy - 5], [cx, cy + 5]];
    const newPaths = [...paths, { name: `Hole ${paths.length}`, indices: [base, base + 1, base + 2] }];
    pushState({ points: newPoints, paths: newPaths }, 'Hole added');
    setActivePath(newPaths.length - 1);
    setSelectedIndex(null);
  };

  const removeHole = (pathIdx: number) => {
    if (pathIdx === 0) return; // can't remove outer
    const newPaths = paths.filter((_, i) => i !== pathIdx);
    pushState({ points: [...points], paths: newPaths }, 'Hole removed');
    if (activePath >= newPaths.length) setActivePath(Math.max(0, newPaths.length - 1));
    setSelectedIndex(null);
  };


  // --- Output ---
  const [convexity, setConvexity] = useState(() => paths[0]?.indices.length >= 3 ? calcConvexity(state) : 1);

  // Auto-recalculate convexity when state changes
  useEffect(() => {
    setConvexity(paths[0]?.indices.length >= 3 ? calcConvexity(state) : 1);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const recalcConvexity = useCallback(() => {
    setConvexity(paths[0]?.indices.length >= 3 ? calcConvexity(state) : 1);
  }, [state, paths]);

  const openscadOutput = (() => {
    // Collect only referenced points and re-index
    const usedSet = new Set<number>();
    for (const p of paths) for (const gi of p.indices) usedSet.add(gi);
    const usedIndices = [...usedSet].sort((a, b) => a - b);
    const reindex = new Map<number, number>();
    usedIndices.forEach((gi, newIdx) => reindex.set(gi, newIdx));
    const usedPoints = usedIndices.map((gi) => points[gi]);
    const ptsStr = `[${usedPoints.map((p) => `[${p[0]},${p[1]}]`).join(',')}]`;
    const remappedPaths = paths.map((p) => p.indices.map((gi) => reindex.get(gi)!));
    const pathsStr = `[${remappedPaths.map((p) => `[${p.join(',')}]`).join(',')}]`;
    const hasHoles = paths.length > 1;
    // Always include paths= to preserve winding order
    if (hasHoles || convexity > 1) {
      return `polygon(points=${ptsStr}, paths=${pathsStr}, convexity=${convexity});`;
    }
    return `polygon(points=${ptsStr}, paths=${pathsStr});`;
  })();

  // Active path's points for the sidebar list
  const activeIndices = paths[activePath]?.indices || [];
  const isView = editMode === 'view';

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
            {editMode === 'view'
              ? 'View only — shift+click to pan | Scroll to zoom'
              : editMode === 'normal'
              ? 'Click edge to insert point | Shift+drag point to move | Middle-mouse/Shift+click to pan | Scroll to zoom'
              : editMode === 'move'
                ? 'Drag to move active path | Middle-mouse to pan | Scroll to zoom'
                : editMode === 'moveAll'
                  ? 'Drag to move all paths together | Middle-mouse to pan | Scroll to zoom'
                  : editMode === 'duplicate'
                    ? 'Drag to move active path | Click "Duplicate" to copy | Shift+click to pan'
                  : editMode === 'angle'
                    ? anglePoints.length < 3
                      ? 'Click 3 points: A, B (vertex), C | Middle-mouse to pan'
                      : 'Enter angle and press Apply or Enter | Click to re-select'
                    : editMode === 'length'
                      ? lengthEdge === null
                        ? 'Click an edge to select it | Middle-mouse to pan'
                        : 'Enter length and press Apply or Enter | Click another edge'
                      : editMode === 'parallel'
                        ? parallelBase === null
                          ? 'Click the base edge (reference) | Middle-mouse to pan'
                          : parallelTarget === null
                            ? 'Click the target edge (to rotate) | Click to re-select base'
                            : 'Click Make Parallel to apply | Click to re-select'
                        : distPoint === null
                          ? 'Click a point to select it | Middle-mouse to pan | Scroll to zoom'
                          : distEdge === null
                            ? 'Click an edge to measure distance | Click another point to re-select'
                            : 'Enter distance and press Apply or Enter | Click to re-select'}
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
              <button className="action-btn" disabled={isView} onClick={() => fileInputRef.current?.click()}>Import Image</button>
              {bgImage && <button onClick={() => setBgImage(null)} className="inline-btn" disabled={isView}>Remove</button>}
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

          <h2>Mode</h2>
          <div className="mode-toolbar">
            <button
              className={`mode-btn ${editMode === 'normal' ? 'active' : ''}`}
              onClick={() => { setEditMode('normal'); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Normal editing mode"
            >Edit</button>
            <button
              className={`mode-btn ${editMode === 'distance' ? 'active' : ''}`}
              onClick={() => { setEditMode('distance'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Set point distance from a line"
            >Distance</button>
            <button
              className={`mode-btn ${editMode === 'move' ? 'active' : ''}`}
              onClick={() => { setEditMode('move'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Drag to move active path only"
            >Move</button>
            <button
              className={`mode-btn ${editMode === 'moveAll' ? 'active' : ''}`}
              onClick={() => { setEditMode('moveAll'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Drag to move all paths together"
            >Move All</button>
            <button
              className={`mode-btn ${editMode === 'angle' ? 'active' : ''}`}
              onClick={() => { setEditMode('angle'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Set angle between two edges at a vertex"
            >Angle</button>
            <button
              className={`mode-btn ${editMode === 'length' ? 'active' : ''}`}
              onClick={() => { setEditMode('length'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Set edge length"
            >Length</button>
            <button
              className={`mode-btn ${editMode === 'parallel' ? 'active' : ''}`}
              onClick={() => { setEditMode('parallel'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Make an edge parallel to another"
            >Parallel</button>
            <button
              className={`mode-btn ${editMode === 'duplicate' ? 'active' : ''}`}
              onClick={() => { setEditMode('duplicate'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); }}
              title="Click to duplicate active path, then drag to place"
            >Duplicate</button>
            <button
              className={`mode-btn ${editMode === 'rotate' ? 'active' : ''}`}
              onClick={() => { setEditMode('rotate'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); setRotatePivot(null); setRotateDragging(false); }}
              title="Click to set pivot, then drag to rotate active path"
            >Rotate</button>
            <button
              className={`mode-btn ${editMode === 'rotateAll' ? 'active' : ''}`}
              onClick={() => { setEditMode('rotateAll'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); setRotatePivot(null); setRotateDragging(false); }}
              title="Click to set pivot, then drag to rotate all paths"
            >Rotate All</button>
            <button
              className={`mode-btn ${editMode === 'simplify' ? 'active' : ''}`}
              onClick={() => { setEditMode('simplify'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(false); setShowLengths(false); setRotatePivot(null); setRotateDragging(false); }}
              title="Simplify point ordering to match polygon traversal order"
            >Simplify</button>
            <button
              className={`mode-btn ${editMode === 'view' ? 'active' : ''}`}
              onClick={() => { setEditMode('view'); setSelectedIndex(null); setDistPoint(null); setDistEdge(null); setAnglePoints([]); setLengthEdge(null); setParallelBase(null); setParallelTarget(null); setDupDragging(false); setShowAngles(true); setShowLengths(true); }}
              title="View only — no editing, shows angles and lengths"
            >View</button>
          </div>
          {(editMode === 'rotate' || editMode === 'rotateAll') && rotatePivot && (
            <button
              className="action-btn"
              onClick={() => { setRotatePivot(null); setRotateDragging(false); }}
              title="Clear pivot to select a new one"
            >Reset Pivot</button>
          )}
          {editMode === 'simplify' && (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="action-btn"
                onClick={() => {
                  const newPoints: Point[] = [];
                  const newPaths: PathDef[] = [];
                  for (const path of paths) {
                    const startIdx = newPoints.length;
                    const newIndices: number[] = [];
                    for (const idx of path.indices) {
                      newPoints.push(points[idx]);
                      newIndices.push(startIdx + newIndices.length);
                    }
                    newPaths.push({ name: path.name, indices: newIndices });
                  }
                  pushState({ points: newPoints, paths: newPaths }, 'Reordered points');
                }}
                title="Reorder points to match path traversal order"
              >Reorder Points</button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
                Decimals:
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={simplifyDecimals}
                  onChange={(e) => setSimplifyDecimals(Math.max(0, Math.min(10, parseInt(e.target.value) || 0)))}
                  style={{ width: '40px' }}
                />
              </label>
              <button
                className="action-btn"
                onClick={() => {
                  const factor = Math.pow(10, simplifyDecimals);
                  const newPoints: Point[] = points.map(([x, y]) => {
                    const rx = Math.round(x * factor) / factor;
                    const ry = Math.round(y * factor) / factor;
                    return [rx, ry] as Point;
                  });
                  pushState({ points: newPoints, paths }, 'Rounded coords');
                }}
                title="Round all point coordinates to the specified number of decimals"
              >Round</button>
            </div>
          )}
          <div className="overlay-buttons">
            <button
              className={`action-btn${showAngles ? ' active' : ''}`}
              {...(editMode === 'view'
                ? { onClick: () => setShowAngles(!showAngles) }
                : { onMouseDown: () => setShowAngles(true), onMouseUp: () => setShowAngles(false), onMouseLeave: () => setShowAngles(false) }
              )}
              title={editMode === 'view' ? 'Toggle angles' : 'Hold to show all angles'}
            >Angles</button>
            <button
              className={`action-btn${showLengths ? ' active' : ''}`}
              {...(editMode === 'view'
                ? { onClick: () => setShowLengths(!showLengths) }
                : { onMouseDown: () => setShowLengths(true), onMouseUp: () => setShowLengths(false), onMouseLeave: () => setShowLengths(false) }
              )}
              title={editMode === 'view' ? 'Toggle lengths' : 'Hold to show all edge lengths'}
            >Lengths</button>
          </div>

          {editMode === 'distance' && (
            <div className="distance-panel">
              <div className="distance-steps">
                <div className={`distance-step ${distPoint === null ? 'current' : 'done'}`}>
                  1. Click a point {distPoint !== null && <span className="step-done">— pt {distPoint}</span>}
                </div>
                <div className={`distance-step ${distPoint !== null && distEdge === null ? 'current' : distEdge !== null ? 'done' : ''}`}>
                  2. Click an edge {distEdge !== null && <span className="step-done">— edge {paths[distEdge[0]].indices[distEdge[1]]}→{paths[distEdge[0]].indices[(distEdge[1] + 1) % paths[distEdge[0]].indices.length]}</span>}
                </div>
              </div>
              {distInfo && (
                <div className="distance-input-row">
                  <label>Distance:</label>
                  <input
                    type="number"
                    className="distance-input"
                    value={distValue}
                    min="0"
                    step="1"
                    onChange={(e) => setDistValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyDistance(); }}
                  />
                  <button className="action-btn" onClick={applyDistance}>Apply</button>
                </div>
              )}
              {distInfo && (
                <div className="distance-current">
                  Current: {Math.round(Math.abs(distInfo.dist) * 1000) / 1000}
                  {' '}({distInfo.dist >= 0 ? 'left' : 'right'} of edge)
                </div>
              )}
            </div>
          )}

          {editMode === 'angle' && (
            <div className="distance-panel">
              <div className="distance-steps">
                <div className={`distance-step ${anglePoints.length === 0 ? 'current' : 'done'}`}>
                  1. Click point A {anglePoints.length >= 1 && <span className="step-done">— pt {anglePoints[0]}</span>}
                </div>
                <div className={`distance-step ${anglePoints.length === 1 ? 'current' : anglePoints.length >= 2 ? 'done' : ''}`}>
                  2. Click point B (vertex) {anglePoints.length >= 2 && <span className="step-done">— pt {anglePoints[1]}</span>}
                </div>
                <div className={`distance-step ${anglePoints.length === 2 ? 'current' : anglePoints.length >= 3 ? 'done' : ''}`}>
                  3. Click point C {anglePoints.length >= 3 && <span className="step-done">— pt {anglePoints[2]}</span>}
                </div>
              </div>
              {angleInfo && (
                <div className="distance-input-row">
                  <label>Angle°:</label>
                  <input
                    type="number"
                    className="distance-input"
                    value={angleValue}
                    min="0.001"
                    max="359.999"
                    step="1"
                    onChange={(e) => setAngleValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyAngle(); }}
                  />
                  <button className="action-btn" onClick={applyAngle}>Apply</button>
                </div>
              )}
              {angleInfo && (
                <div className="distance-current">
                  Current: {Math.round(angleInfo.angle * 1000) / 1000}° (moves C)
                </div>
              )}
            </div>
          )}

          {editMode === 'length' && (
            <div className="distance-panel">
              <div className="distance-steps">
                <div className={`distance-step ${lengthEdge === null ? 'current' : 'done'}`}>
                  1. Click an edge {lengthEdge !== null && lengthInfo && <span className="step-done">— {lengthInfo.gi1}→{lengthInfo.gi2}</span>}
                </div>
              </div>
              {lengthInfo && (
                <div className="distance-input-row">
                  <label>Length:</label>
                  <input
                    type="number"
                    className="distance-input"
                    value={lengthValue}
                    min="0.001"
                    step="1"
                    onChange={(e) => setLengthValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyLength(); }}
                  />
                  <button className="action-btn" onClick={applyLength}>Apply</button>
                </div>
              )}
              {lengthInfo && (
                <div className="distance-current">
                  Current: {Math.round(lengthInfo.length * 1000) / 1000} (moves pt {lengthInfo.gi2})
                </div>
              )}
            </div>
          )}

          {editMode === 'parallel' && (
            <div className="distance-panel">
              <div className="distance-steps">
                <div className={`distance-step ${parallelBase === null ? 'current' : 'done'}`}>
                  1. Click base edge {parallelBase !== null && (() => {
                    const p = paths[parallelBase[0]]?.indices;
                    return p ? <span className="step-done">— {p[parallelBase[1]]}→{p[(parallelBase[1] + 1) % p.length]}</span> : null;
                  })()}
                </div>
                <div className={`distance-step ${parallelBase !== null && parallelTarget === null ? 'current' : parallelTarget !== null ? 'done' : ''}`}>
                  2. Click target edge {parallelTarget !== null && (() => {
                    const p = paths[parallelTarget[0]]?.indices;
                    return p ? <span className="step-done">— {p[parallelTarget[1]]}→{p[(parallelTarget[1] + 1) % p.length]}</span> : null;
                  })()}
                </div>
              </div>
              {parallelInfo && (
                <>
                  <button className="action-btn" style={{ width: '100%' }} onClick={applyParallel}>Make Parallel</button>
                  <div className="distance-current">
                    Base angle: {Math.round(parallelInfo.baseAngle * 180 / Math.PI * 10) / 10}°,
                    Target angle: {Math.round(parallelInfo.targetAngle * 180 / Math.PI * 10) / 10}°
                  </div>
                </>
              )}
            </div>
          )}

          {editMode === 'duplicate' && (
            <div className="distance-panel">
              <div className="distance-current" style={{ marginBottom: 6 }}>
                Active: <strong>{getPathName(activePath)}</strong> ({(paths[activePath]?.indices || []).length} pts)
              </div>
              <button
                className="action-btn"
                style={{ width: '100%' }}
                onClick={() => {
                  const srcPath = paths[activePath]?.indices;
                  if (!srcPath || srcPath.length === 0) return;
                  const base = points.length;
                  const newPoints: Point[] = [...points];
                  const newPathIndices: number[] = [];
                  for (let i = 0; i < srcPath.length; i++) {
                    const p = points[srcPath[i]];
                    newPoints.push([p[0], p[1]]);
                    newPathIndices.push(base + i);
                  }
                  const newPaths = [...paths, { name: getPathName(activePath) + ' copy', indices: newPathIndices }];
                  const newIdx = newPaths.length - 1;
                  pushState({ points: newPoints, paths: newPaths }, 'Duplicated path');
                  setActivePath(newIdx);
                  setSelectedIndex(null);
                  setDupNewPathIdx(newIdx);
                }}
              >Duplicate "{getPathName(activePath)}"</button>
              {dupNewPathIdx !== null && dupNewPathIdx < paths.length && (
                <div className="distance-current" style={{ marginTop: 4 }}>
                  Last duplicate: <strong>{getPathName(dupNewPathIdx)}</strong>
                </div>
              )}
            </div>
          )}

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
                  {editingPathName === pi ? (
                    <input
                      className="path-name-input"
                      autoFocus
                      defaultValue={getPathName(pi)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => { setPathName(pi, e.target.value || getPathName(pi)); setEditingPathName(null); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { setPathName(pi, (e.target as HTMLInputElement).value || getPathName(pi)); setEditingPathName(null); }
                        if (e.key === 'Escape') setEditingPathName(null);
                      }}
                    />
                  ) : (
                    <span className="path-name" onDoubleClick={(e) => { e.stopPropagation(); setEditingPathName(pi); }}>{getPathName(pi)}</span>
                  )}
                  <span className="path-count">{paths[pi].indices.length} pts</span>
                  {pi > 0 && (
                    <button className="danger-btn" disabled={isView} onClick={(e) => { e.stopPropagation(); removeHole(pi); }}
                      title="Remove hole">x</button>
                  )}
                </div>
              );
            })}
            <button className="add-hole-btn" disabled={isView} onClick={addHole}>+ Add Hole</button>
          </div>

          <h2>Points — {getPathName(activePath)} ({activeIndices.length})</h2>
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
                  <input
                    type="number"
                    className="point-coord-input"
                    value={p[0]}
                    disabled={isView}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (isNaN(val)) return;
                      const newPoints = [...points];
                      newPoints[gi] = [val, p[1]];
                      pushState({ points: newPoints, paths }, 'Coord edited');
                    }}
                  />
                  <input
                    type="number"
                    className="point-coord-input"
                    value={p[1]}
                    disabled={isView}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (isNaN(val)) return;
                      const newPoints = [...points];
                      newPoints[gi] = [p[0], val];
                      pushState({ points: newPoints, paths }, 'Coord edited');
                    }}
                  />
                  <button className="inline-btn" disabled={isView || posInPath === 0}
                    onClick={(e) => { e.stopPropagation(); movePointInPath(gi, -1); }} title="Move up">^</button>
                  <button className="inline-btn" disabled={isView || posInPath === activeIndices.length - 1}
                    onClick={(e) => { e.stopPropagation(); movePointInPath(gi, 1); }} title="Move down">v</button>
                  <button className="danger-btn" disabled={isView}
                    onClick={(e) => { e.stopPropagation(); removePoint(gi); }} title="Remove point">x</button>
                </div>
              );
            })}
          </div>
          <div className="convexity-label">
            Convexity: <span className={convexity <= 1 ? 'convex' : 'concave'}>{convexity}</span>
            {convexity <= 1 ? ' (convex)' : ' (concave)'}
            <button className="inline-btn" style={{ marginLeft: 'auto', fontSize: 14, padding: '2px 6px', lineHeight: 1 }} onClick={recalcConvexity} title="Recalculate convexity">↻</button>
          </div>
          <h2>OpenSCAD Output</h2>
          <textarea
            className="output-area"
            readOnly
            value={openscadOutput}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <button
            className="action-btn full-width"
            onClick={() => {
              navigator.clipboard.writeText(openscadOutput).then(() => {
                const btn = document.querySelector('.action-btn.full-width') as HTMLButtonElement;
                if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 1500); }
              });
            }}
          >Copy to Clipboard</button>
          <button className="action-btn full-width" disabled={isView} onClick={() => setShowImport(!showImport)}>
            {showImport ? '▾ Hide Import' : '▸ Import from OpenSCAD'}
          </button>
          {showImport && (
            <div className="import-panel">
              <textarea
                className="import-textarea"
                placeholder="Paste polygon(points=..., paths=...) here"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <button
                className="action-btn"
                onClick={() => {
                  const parsed = parseOpenSCAD(importText);
                  if (parsed) {
                    pushState(parsed, 'Imported');
                    setActivePath(0);
                    setSelectedIndex(null);
                    setImportText('');
                    setShowImport(false);
                  } else {
                    alert('Could not parse OpenSCAD polygon. Expected: polygon(points=[[x,y],...], paths=[[0,1,2],...])');
                  }
                }}
              >Load</button>
            </div>
          )}
          <div className="history-section">
            <h2>History ({historyPos + 1} / {history.length})</h2>
            <div className="history-controls">
              <button className="action-btn" style={{ flex: 1 }} disabled={isView || historyPos === 0} onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
              <button className="action-btn" style={{ flex: 1 }} disabled={isView || historyPos === history.length - 1} onClick={redo} title="Redo (Ctrl+Y)">Redo</button>
            </div>
            <div className="history-list">
              {[...history].map((_, i) => {
                const ri = history.length - 1 - i;
                const e = history[ri];
                return (
                <div
                  key={ri}
                  className={`history-item ${ri === historyPos ? 'active' : ''} ${ri > historyPos ? 'future' : ''}`}
                  onClick={() => !isView && jumpTo(ri)}
                >
                  <span className="history-index">{ri + 1}</span>
                  <span className="history-summary">{e.label || (ri === 0 ? 'Initial' : `${e.points.length} pts`)}</span>
                </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
