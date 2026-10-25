/**
 * game.js — 2D falling-sand simulation engine.
 *
 * Pure simulation + rendering. Knows nothing about the DOM structure of the
 * page: it receives a <canvas> and exposes a small imperative API that
 * main.js wires up to the UI (inversion of control).
 *
 * Elements: empty, wall (static), sand (powder), water (liquid), acid (liquid
 * that dissolves any element and is consumed in the process).
    
 */

/* ------------------------------------------------------------------ exports */

export const Element = Object.freeze({
  Empty: 0,
  Wall: 1,
  Sand: 2,
  Water: 3,
  Acid: 4,
});

/* ------------------------------------------------------------------- tuning */

const CELL_SIZE = 4; // canvas pixels per simulation cell -> 160 x 120 grid
const STEP_MS = 1000 / 60; // fixed simulation timestep
const MAX_STEPS_PER_FRAME = 3; // catch-up cap, avoids spiral of death

const LIQUID_FLOW_CELLS = 3; // how far a liquid may slide sideways per step
const ACID_DISSOLVE_CHANCE = 0.03; // per neighbour, per step
const ACID_SPENT_CHANCE = 0.09; // chance acid is consumed by a dissolve

/** Colour + shading metadata, indexed by Element value. */
const ELEMENT_PROPS = [
  { color: [2, 6, 23], variance: 0 }, // Empty
  { color: [100, 116, 139], variance: 16 }, // Wall
  { color: [222, 184, 110], variance: 12 }, // Sand
  { color: [56, 130, 246], variance: 10 }, // Water
  { color: [163, 230, 53], variance: 16 }, // Acid
];

/** Neighbour offsets (dx, dy) as a flat array for cheap iteration. */
const NEIGHBOURS = new Int8Array([
  1, 0, -1, 0, 0, 1, 0, -1, 1, 1, -1, 1, 1, -1, -1, -1,
]);

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value | 0;
}

/* ------------------------------------------------------------------- engine */

export class SandEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ cellSize?: number }} [options]
   */
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error('SandEngine: a canvas element is required.');

    this.canvas = canvas;
    this.cellSize = options.cellSize ?? CELL_SIZE;
    this.ctx = canvas.getContext('2d', { alpha: false });

    this.cols = Math.max(1, Math.floor(canvas.width / this.cellSize));
    this.rows = Math.max(1, Math.floor(canvas.height / this.cellSize));
    this.size = this.cols * this.rows;

    /** @type {Uint8Array} element id per cell */
    this.cells = new Uint8Array(this.size);
    /** @type {Uint8Array} 1 when a cell already moved during the current step */
    this.moved = new Uint8Array(this.size);
    /** @type {Float32Array} deterministic per-cell shading noise (-1..1) */
    this.noise = new Float32Array(this.size);

    // Low-resolution offscreen buffer, upscaled with nearest-neighbour.
    this.buffer = document.createElement('canvas');
    this.buffer.width = this.cols;
    this.buffer.height = this.rows;
    this.bufferCtx = this.buffer.getContext('2d');
    this.imageData = this.bufferCtx.createImageData(this.cols, this.rows);
    this.pixels = this.imageData.data;

    this.brushElement = Element.Sand;
    this.brushSize = 8; // radius, in cells
    this.lastPaint = null;

    this.running = false;
    this.rafId = 0;
    this.lastTime = 0;
    this.accumulator = 0;
    this.frameParity = 0;

    this.seedNoise();
    this.loadDemoScene();
    this.render();
  }

  /* ------------------------------------------------------------- public API */

  /** Starts the requestAnimationFrame loop. Idempotent. */
  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  /** Stops the loop, keeping the current grid contents. */
  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** @param {number} element one of the Element values */
  setBrushElement(element) {
    if (typeof element !== 'number' || !ELEMENT_PROPS[element]) return;
    this.brushElement = element;
  }

  /** @param {number} size brush radius in cells (clamped 1..60) */
  setBrushSize(size) {
    const value = Number(size);
    if (!Number.isFinite(value)) return;
    this.brushSize = Math.min(60, Math.max(1, Math.round(value)));
  }

  /** Empties the whole grid. */
  clear() {
    this.cells.fill(Element.Empty);
    this.render();
  }

  /** Restores the starting scene. */
  reset() {
    this.loadDemoScene();
    this.render();
  }

  /* ---------------------------------------------------------- pointer input */

  /**
   * Coordinates are in canvas pixel space; the engine converts to grid space.
   * @param {number} canvasX
   * @param {number} canvasY
   */
  beginStroke(canvasX, canvasY) {
    const point = this.toGridSpace(canvasX, canvasY);
    this.lastPaint = point;
    this.stamp(point.x, point.y);
  }

  /** Continues a stroke, interpolating so fast drags leave no gaps. */
  paint(canvasX, canvasY) {
    const point = this.toGridSpace(canvasX, canvasY);

    if (!this.lastPaint) {
      this.lastPaint = point;
      this.stamp(point.x, point.y);
      return;
    }

    const dx = point.x - this.lastPaint.x;
    const dy = point.y - this.lastPaint.y;
    const distance = Math.hypot(dx, dy);
    const stepLength = Math.max(0.5, this.brushSize / 2);
    const steps = Math.max(1, Math.ceil(distance / stepLength));

    for (let s = 1; s <= steps; s += 1) {
      this.stamp(
        this.lastPaint.x + (dx * s) / steps,
        this.lastPaint.y + (dy * s) / steps,
      );
    }

    this.lastPaint = point;
  }

  /** Terminates a stroke. */
  endStroke() {
    this.lastPaint = null;
  }

  /** Stops the loop and drops references. */
  destroy() {
    this.stop();
    this.lastPaint = null;
  }

  /* ------------------------------------------------------------ frame loop */

  tick = (now) => {
    if (!this.running) return;

    const delta = Math.min(now - this.lastTime, 250);
    this.lastTime = now;
    this.accumulator += delta;

    let steps = 0;
    while (this.accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.accumulator -= STEP_MS;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.render();
    this.rafId = requestAnimationFrame(this.tick);
  };

  /* ------------------------------------------------------------- simulation */

  /** Advances the whole grid by one tick. */
  step() {
    this.moved.fill(0);

    const { cols, rows } = this;
    const leftToRight = (this.frameParity & 1) === 0;

    // Bottom-up so falling particles are not processed twice in one tick.
    for (let y = rows - 1; y >= 0; y -= 1) {
      if (leftToRight) {
        for (let x = 0; x < cols; x += 1) this.updateCell(x, y);
      } else {
        for (let x = cols - 1; x >= 0; x -= 1) this.updateCell(x, y);
      }
    }

    this.frameParity ^= 1;
  }

  updateCell(x, y) {
    const index = y * this.cols + x;
    if (this.moved[index]) return;

    const element = this.cells[index];
    if (element === Element.Sand) this.updatePowder(x, y, index);
    else if (element === Element.Water) this.updateLiquid(x, y, index);
    else if (element === Element.Acid) this.updateAcid(x, y, index);
  }

  /** Sand: straight down, then one of the two diagonals, displacing water. */
  updatePowder(x, y, index) {
    if (this.tryMove(index, x, y + 1, Element.Water)) return;

    const dir = Math.random() < 0.5 ? -1 : 1;
    if (this.tryMove(index, x + dir, y + 1, Element.Water)) return;
    this.tryMove(index, x - dir, y + 1, Element.Water);
  }
  

  /** Water: down, diagonals, then a sideways slide. */
  updateLiquid(x, y, index) {
    if (this.tryMove(index, x, y + 1)) return;

    const dir = Math.random() < 0.5 ? -1 : 1;
    if (this.tryMove(index, x + dir, y + 1)) return;
    if (this.tryMove(index, x - dir, y + 1)) return;

    const flow = Math.random() < 0.5 ? -1 : 1;
    if (this.slide(x, y, index, flow)) return;
    this.slide(x, y, index, -flow);
  }

  /** Acid: eats adjacent matter, then behaves like any other liquid. */
    
  updateAcid(x, y, index) {
    if (this.dissolveNeighbours(x, y, index)) return;
    this.updateLiquid(x, y, index);
  }

  /**
   * @returns {boolean} true when the acid particle was consumed.
   */
  dissolveNeighbours(x, y, index) {
    const { cols, rows, cells, moved } = this;

    for (let n = 0; n < NEIGHBOURS.length; n += 2) {
      const nx = x + NEIGHBOURS[n];
      const ny = y + NEIGHBOURS[n + 1];
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;

      const neighbour = ny * cols + nx;
      if (cells[neighbour] === Element.Empty) continue;
    
      if (Math.random() >= ACID_DISSOLVE_CHANCE) continue;

      cells[neighbour] = Element.Empty;
      moved[neighbour] = 1;

      if (Math.random() < ACID_SPENT_CHANCE) {
        cells[index] = Element.Empty;
        return true;
      }
    }

    return false;
  }

  /**
   * Moves a particle one cell if the destination is free.
   * @returns {boolean} whether the move happened.
   */
  tryMove(index, targetX, targetY, displace = Element.Empty) {
    if (targetX < 0 || targetX >= this.cols) return false;
    if (targetY < 0 || targetY >= this.rows) return false;

    const target = targetY * this.cols + targetX;
    if (this.moved[target]) return false;

    const targetElement = this.cells[target];
    if (targetElement !== Element.Empty && targetElement !== displace) return false;

    this.swap(index, target);
    this.moved[target] = 1;
    if (targetElement !== Element.Empty) this.moved[index] = 1;
    return true;
  }
  

  /**
   * Slides a liquid up to LIQUID_FLOW_CELLS sideways, stopping at obstacles.
   * @returns {boolean} whether at least one cell of movement happened.
   */
  slide(x, y, index, direction) {
    let currentIndex = index;
    let currentX = x;
    let didMove = false;

    for (let step = 0; step < LIQUID_FLOW_CELLS; step += 1) {
      const nextX = currentX + direction;
      if (nextX < 0 || nextX >= this.cols) break;

      const nextIndex = y * this.cols + nextX;
      if (this.moved[nextIndex]) break;
      if (this.cells[nextIndex] !== Element.Empty) break;

      this.swap(currentIndex, nextIndex);
      this.moved[nextIndex] = 1;

      currentIndex = nextIndex;
      currentX = nextX;
      didMove = true;
    }

    return didMove;
  }

  swap(a, b) {
    const tmp = this.cells[a];
    this.cells[a] = this.cells[b];
    this.cells[b] = tmp;
  }

  /* --------------------------------------------------------------- painting */

  toGridSpace(canvasX, canvasY) {
    return { x: canvasX / this.cellSize, y: canvasY / this.cellSize };
  }

  /** Paints a filled circle of the current brush at grid coordinates. */
  stamp(gridX, gridY) {
    const radius = this.brushSize;
    const radiusSq = radius * radius;
    const element = this.brushElement;
    const { cols, rows, cells } = this;

    const minX = Math.max(0, Math.floor(gridX - radius));
    const maxX = Math.min(cols - 1, Math.ceil(gridX + radius));
    const minY = Math.max(0, Math.floor(gridY - radius));
    const maxY = Math.min(rows - 1, Math.ceil(gridY + radius));

    for (let y = minY; y <= maxY; y += 1) {
      const dy = y - gridY;
      const row = y * cols;

      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - gridX;
        if (dx * dx + dy * dy > radiusSq) continue;
        cells[row + x] = element;
      }
    }
  }

  /* --------------------------------------------------------------- rendering */

  render() {
    const { pixels, cells, noise, size } = this;

    for (let i = 0; i < size; i += 1) {
      const props = ELEMENT_PROPS[cells[i]];
      const shade = noise[i] * props.variance;
      const offset = i << 2;

      pixels[offset] = clampByte(props.color[0] + shade);
      pixels[offset + 1] = clampByte(props.color[1] + shade);
      pixels[offset + 2] = clampByte(props.color[2] + shade);
      pixels[offset + 3] = 255;
    }

    this.bufferCtx.putImageData(this.imageData, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
  }

  /* ----------------------------------------------------------------- scene */

  seedNoise() {
    for (let i = 0; i < this.size; i += 1) {
      this.noise[i] = Math.random() * 2 - 1;
    }
  }

  /** Fills the grid with the opening scene: bedrock, a funnel and some matter. */
  loadDemoScene() {
    const { cols, rows } = this;
    this.cells.fill(Element.Empty);

    const floorTop = rows - 2;
    const edge = 2;

    // Bedrock floor.
    for (let y = floorTop; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) this.setCell(x, y, Element.Wall);
    }

    // Side walls keep particles on screen.
    for (let y = 0; y < rows; y += 1) {
      for (let t = 0; t < edge; t += 1) {
        this.setCell(t, y, Element.Wall);
        this.setCell(cols - 1 - t, y, Element.Wall);
      }
    }

    // A V-shaped funnel.
    const centreX = Math.floor(cols / 2);
    const rimY = Math.floor(rows * 0.5);
    const bottomY = floorTop - 1;
    const mouth = 11;

    this.drawLine(
      Math.floor(cols * 0.14),
      rimY,
      centreX - mouth,
      bottomY,
      Element.Wall,
      3,
    );
    this.drawLine(
      Math.floor(cols * 0.86),
      rimY,
      centreX + mouth,
      bottomY,
      Element.Wall,
      3,
    );

    // A scoop of sand tumbling into the funnel.
    this.fillRect(centreX - 9, Math.floor(rows * 0.1), 18, 9, Element.Sand);
    // And a splash of water landing on the left ramp.
    this.fillRect(Math.floor(cols * 0.26), Math.floor(rows * 0.18), 12, 7, Element.Water);
  }

  setCell(x, y, element) {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    this.cells[y * this.cols + x] = element;
  }

  fillRect(x, y, width, height, element) {
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) this.setCell(xx, yy, element);
    }
  }

  /** Bresenham line with a square brush of the given thickness. */
  drawLine(x0, y0, x1, y1, element, thickness = 1) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    const half = Math.floor(thickness / 2);

    let err = dx + dy;
    let x = x0;
    let y = y0;

    for (;;) {
      for (let oy = -half; oy <= half; oy += 1) {
        for (let ox = -half; ox <= half; ox += 1) {
          this.setCell(x + ox, y + oy, element);
        }
      }

      if (x === x1 && y === y1) break;

      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }
}
