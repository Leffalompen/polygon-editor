import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

type Point = [number, number];

const GRID_SIZE = 10;
const CANVAS_SIZE = 600;
const INITIAL_SCALE = 4; // pixels per unit

function isConvex(points: Point[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const [x3, y3] = points[(i + 2) % n];
    const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
    if (cross !== 0) {
      if (sign === 0) sign = cross > 0 ? 1 : -1;
      else if ((cross > 0 ? 1 : -1) !== sign) return false;
    }
  }
  return true;
}

function App() {
  const [points, setPoints] = useState<Point[]>([
    [0, 0],
    [50, 0],
    [25, 40],
  ]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [offset, setOffset] = useState<[number, number]>([CANVAS_SIZE / 4, (CANVAS_SIZE * 3) / 4]);
  const [scale, setScale] = useState(INITIAL_SCALE);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<[number, number]>([0, 0]);
  const [offsetStart, setOffsetStart] = useState<[number, number]>([0, 0]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Convert world coords to canvas coords (Y flipped for math coords)
  const toCanvas = useCallback(
    (wx: number, wy: number): [number, number] => [
      offset[0] + wx * scale,
      offset[1] - wy * scale,
    ],
    [offset, scale]
  );

  // Convert canvas coords to world coords, snapped to grid
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

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, w, h);

    // Grid
    const gridScreenSize = GRID_SIZE * scale;
    if (gridScreenSize > 4) {
      ctx.strokeStyle = '#2a2a4a';
      ctx.lineWidth = 0.5;
      // Vertical lines
      const startX = offset[0] % gridScreenSize;
      for (let x = startX; x < w; x += gridScreenSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      // Horizontal lines
      const startY = offset[1] % gridScreenSize;
      for (let y = startY; y < h; y += gridScreenSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // Axes
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1.5;
    // X axis
    ctx.beginPath();
    ctx.moveTo(0, offset[1]);
    ctx.lineTo(w, offset[1]);
    ctx.stroke();
    // Y axis
    ctx.beginPath();
    ctx.moveTo(offset[0], 0);
    ctx.lineTo(offset[0], h);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#e44';
    ctx.font = '12px monospace';
    ctx.fillText('X', w - 15, offset[1] - 5);
    ctx.fillStyle = '#4e4';
    ctx.fillText('Y', offset[0] + 5, 15);

    // Tick marks and numbers
    if (gridScreenSize > 20) {
      ctx.fillStyle = '#777';
      ctx.font = '9px monospace';
      const majorEvery = 5; // label every 5 grid units
      // X ticks
      const worldLeft = -offset[0] / scale;
      const worldRight = (w - offset[0]) / scale;
      const tickStart = Math.ceil(worldLeft / GRID_SIZE) * GRID_SIZE;
      for (let wx = tickStart; wx <= worldRight; wx += GRID_SIZE) {
        if (wx === 0) continue;
        const [cx, cy] = toCanvas(wx, 0);
        ctx.beginPath();
        ctx.moveTo(cx, cy - 3);
        ctx.lineTo(cx, cy + 3);
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (Math.round(wx / GRID_SIZE) % majorEvery === 0) {
          ctx.fillText(String(wx), cx - 8, cy + 14);
        }
      }
      // Y ticks
      const worldBottom = -(h - offset[1]) / scale;
      const worldTop = offset[1] / scale;
      const tickStartY = Math.ceil(worldBottom / GRID_SIZE) * GRID_SIZE;
      for (let wy = tickStartY; wy <= worldTop; wy += GRID_SIZE) {
        if (wy === 0) continue;
        const [cx, cy] = toCanvas(0, wy);
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy);
        ctx.lineTo(cx + 3, cy);
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (Math.round(wy / GRID_SIZE) % majorEvery === 0) {
          ctx.fillText(String(wy), cx + 6, cy + 3);
        }
      }
    }

    // Draw polygon fill
    if (points.length >= 3) {
      ctx.beginPath();
      const [sx, sy] = toCanvas(points[0][0], points[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < points.length; i++) {
        const [px, py] = toCanvas(points[i][0], points[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(200, 180, 50, 0.35)';
      ctx.fill();
      ctx.strokeStyle = '#c8b432';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Draw edges with index labels
    if (points.length >= 2) {
      ctx.strokeStyle = '#c8b432';
      ctx.lineWidth = 2;
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = toCanvas(points[i][0], points[i][1]);
        const next = (i + 1) % points.length;
        const [bx, by] = toCanvas(points[next][0], points[next][1]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }

    // Draw points
    points.forEach((p, i) => {
      const [cx, cy] = toCanvas(p[0], p[1]);
      const isSelected = i === selectedIndex;
      ctx.beginPath();
      ctx.arc(cx, cy, isSelected ? 8 : 5, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#ff4444' : '#44aaff';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.stroke();

      // Point index label
      ctx.fillStyle = '#fff';
      ctx.font = isSelected ? 'bold 12px monospace' : '10px monospace';
      ctx.fillText(String(i), cx + 10, cy - 8);
    });

    // Origin label
    ctx.fillStyle = '#aaa';
    ctx.font = '10px monospace';
    ctx.fillText('0', offset[0] + 4, offset[1] + 13);
  }, [points, selectedIndex, offset, scale, toCanvas]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [wx, wy] = toWorld(cx, cy);
    setPoints((prev) => [...prev, [wx, wy]]);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(0.5, Math.min(40, scale * factor));
    // Zoom towards cursor
    const newOffsetX = cx - ((cx - offset[0]) * newScale) / scale;
    const newOffsetY = cy - ((cy - offset[1]) * newScale) / scale;
    setScale(newScale);
    setOffset([newOffsetX, newOffsetY]);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      setIsPanning(true);
      setPanStart([e.clientX, e.clientY]);
      setOffsetStart([...offset]);
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setOffset([
        offsetStart[0] + e.clientX - panStart[0],
        offsetStart[1] + e.clientY - panStart[1],
      ]);
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
  };

  const removePoint = (index: number) => {
    setPoints((prev) => prev.filter((_, i) => i !== index));
    if (selectedIndex === index) setSelectedIndex(null);
    else if (selectedIndex !== null && selectedIndex > index)
      setSelectedIndex(selectedIndex - 1);
  };

  const openscadOutput = `polygon(points=[${points
    .map((p) => `[${p[0]},${p[1]}]`)
    .join(',')}]);`;

  const convex = points.length >= 3 ? isConvex(points) : false;

  return (
    <div className="app">
      <h1>OpenSCAD Polygon Editor</h1>
      <div className="main-layout">
        <div className="canvas-container">
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            onClick={handleCanvasClick}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{ cursor: isPanning ? 'grabbing' : 'crosshair' }}
          />
          <div className="canvas-hint">
            Click to add point | Shift+drag to pan | Scroll to zoom
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
            Convexity: <span className={convex ? 'convex' : 'concave'}>{convex ? 'Convex' : 'Concave'}</span>
          </div>
          <h2>OpenSCAD Output</h2>
          <textarea
            className="output-area"
            readOnly
            value={openscadOutput}
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
