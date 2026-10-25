/**
 * main.js — application entry point.
 *
 * Acts as the composition root / IoC adapter: it looks up the HTML elements
 * and wires them to a SandEngine instance. All simulation logic lives in
 * game.js; nothing here knows how particles behave.
 */

import { SandEngine, Element } from './game.js';

/* ------------------------------------------------------------- DOM lookup */

const canvas = document.getElementById('sand-canvas');
const brushButtons = Array.from(
  document.querySelectorAll('[data-element]'),
);
const sizeInput = document.getElementById('brush-size');
const sizeOutput = document.getElementById('brush-size-output');
const clearButton = document.getElementById('clear-button');
const yearOutput = document.getElementById('copyright-year');

/* ------------------------------------------------------- element resolution */

/**
 * Maps the `data-element` attribute to an Element value.
 * Kept explicit so unknown/typo'd values fail loudly instead of silently.
 * @type {Record<string, number>}
 */
const ELEMENT_BY_NAME = {
  sand: Element.Sand,
  water: Element.Water,
  acid: Element.Acid,
  wall: Element.Wall,
};

/* ------------------------------------------------------------ bootstrapping */

const engine = new SandEngine(canvas, { cellSize: 4 });
engine.start();

/* ---------------------------------------------------------- brush selector */

/**
 * Applies the pressed state to the brush button group.
 * @param {HTMLButtonElement} active
 */
function setActiveBrushButton(active) {
  for (const button of brushButtons) {
    const isActive = button === active;
    button.setAttribute('aria-pressed', String(isActive));
  }
}

for (const button of brushButtons) {
  button.addEventListener('click', () => {
    const element = ELEMENT_BY_NAME[button.dataset.element];
    if (element === undefined) return;

    engine.setBrushElement(element);
    setActiveBrushButton(button);
  });
}

// Sync the engine with the markup's initial aria-pressed="true" button.
const initiallyPressed = brushButtons.find(
  (button) => button.getAttribute('aria-pressed') === 'true',
);
if (initiallyPressed) {
  const element = ELEMENT_BY_NAME[initiallyPressed.dataset.element];
  if (element !== undefined) engine.setBrushElement(element);
}

/* --------------------------------------------------------------- brush size */

if (sizeInput instanceof HTMLInputElement) {
  const applySize = () => {
    const value = Number(sizeInput.value);
    engine.setBrushSize(value);
    if (sizeOutput) sizeOutput.textContent = String(engine.brushSize);
  };

  sizeInput.addEventListener('input', applySize);
  applySize(); // pick up the markup's initial value
}

/* -------------------------------------------------------------- clear button */

clearButton?.addEventListener('click', () => {
  engine.clear();
});

/* ------------------------------------------------------------ canvas input */

/** True while a pointer stroke is in progress. */
let isDrawing = false;
/** Pointer id captured on pointerdown, so multi-touch cannot hijack a stroke. */
let activePointerId = null;

/**
 * Converts a PointerEvent to canvas-local pixel coordinates, accounting for
 * CSS scaling (the canvas is displayed at a responsive width but its drawing
 * buffer stays 640x480).
 * @param {PointerEvent} event
 * @returns {{ x: number, y: number }}
 */
function toCanvasCoords(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

canvas.addEventListener('pointerdown', (event) => {
  if (activePointerId !== null) return; // already drawing with another pointer
  if (event.button !== 0 && event.pointerType === 'mouse') return; // left click only

  activePointerId = event.pointerId;
  isDrawing = true;
  canvas.setPointerCapture(event.pointerId);

  const { x, y } = toCanvasCoords(event);
  engine.beginStroke(x, y);

  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  const { x, y } = toCanvasCoords(event);

  if (!isDrawing || event.pointerId !== activePointerId) {
    // Hover preview: nothing to paint, but keep coordinates fresh for UX
    // (no-op for now — reserved for a future cursor overlay).
    return;
  }

  engine.paint(x, y);
  event.preventDefault();
});

/**
 * Ends the current stroke and releases the pointer capture.
 * @param {PointerEvent} event
 */
function finishStroke(event) {
  if (event.pointerId !== activePointerId) return;

  isDrawing = false;
  activePointerId = null;
  engine.endStroke();

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}

canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);

// Safety net: if focus/capture is lost mid-stroke, stop drawing.
canvas.addEventListener('lostpointercapture', () => {
  isDrawing = false;
  activePointerId = null;
  engine.endStroke();
});

// Suppress the browser's native drag/select behaviour on the canvas.
canvas.addEventListener('dragstart', (event) => event.preventDefault());
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

/* ------------------------------------------------------------ page lifecycle */

// Pause the simulation when the tab is hidden — saves battery, and the
// accumulator reset on resume avoids a burst of catch-up steps.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    engine.stop();
  } else {
    engine.start();
  }
});

// Release the animation frame when the page is being unloaded.
window.addEventListener('pagehide', () => {
  engine.destroy();
});

/* -------------------------------------------------------------- footer year */

if (yearOutput) {
  yearOutput.textContent = String(new Date().getFullYear());
}
