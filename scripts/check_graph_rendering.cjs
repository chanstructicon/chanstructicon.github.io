/* Scheduling and rendering regression checks; run with Node, no dependencies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frames = new Map();
let nextFrame = 0;
const controls = new Map();
const counters = { paints: 0, measurements: 0, lines: [], circles: [], dashes: [] };
const context = new Proxy({
  clearRect() { counters.paints++; },
  measureText(text) { counters.measurements++; return { width: text.length * 8 }; },
  lineTo(x, y) { counters.lines.push([x, y]); },
  arc(x, y, r) { counters.circles.push([x, y, r]); },
  setLineDash(dashes) { if (dashes.length) counters.dashes.push([...dashes]); },
}, { get: (target, key) => key in target ? target[key] : () => {} });
const handlers = new Map();
const canvas = {
  clientWidth: 900, clientHeight: 600, style: {},
  getContext: () => context,
  addEventListener: (name, callback) => handlers.set(name, callback),
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
};
class Observer { observe() {} }
const sandbox = {
  window: {}, devicePixelRatio: 1,
  document: { hidden: false, addEventListener() {}, querySelector(selector) {
    if (!controls.has(selector)) controls.set(selector, { addEventListener() {}, setAttribute() {} });
    return controls.get(selector);
  } },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  ResizeObserver: Observer, IntersectionObserver: Observer,
  requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
  cancelAnimationFrame(id) { frames.delete(id); },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/graph.js'), 'utf8'), sandbox);
const nodes = [
  { id: 'a', x: -100, y: 100 }, { id: 'b', x: 1000, y: 100 },
  { id: 'c', x: -200, y: 200 }, { id: 'd', x: -100, y: 200 },
  { id: 'e', x: 200, y: 200 },
].map(node => ({ ...node, label: node.id, r: 5, type: 'word', color: '#555' }));
const view = new sandbox.window.ConstructiconGraph(canvas, {
  nodes, edges: [{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }],
  familyRegions: [{ x: -100, y: 200, r: 30, color: '#555' }],
}, () => {});
function frame(time) {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(time));
}
assert.equal(counters.paints, 0);
assert.equal(frames.size, 1);
for (let i = 0; i < 120; i++) view.zoom(i % 2 ? 1.001 : 1 / 1.001);
assert.equal(frames.size, 1);
assert.equal(counters.paints, 0);
frame(16);
assert.equal(counters.paints, 1);
frame(32);
assert.equal(counters.paints, 2, 'animation follows display frames by default');
view.paused = true;
view.restart();
frame(48);
assert.equal(frames.size, 0, 'paused animation does not spin');
for (let i = 0; i < 20; i++) view.restart();
frame(64);
assert.equal(counters.paints, 4, 'paused interaction still paints once');

let hits = 0;
const originalHit = view.hit.bind(view);
view.hit = point => { hits++; return originalHit(point); };
view.camera = { x: 0, y: 0, scale: 1 };
for (let i = 0; i < 40; i++) handlers.get('pointermove')({ clientX: 200, clientY: 200 });
assert.equal(hits, 0);
frame(80);
assert.equal(hits, 1);
assert.equal(view.hovered.id, 'e');
assert.equal(controls.get('#node-tooltip').textContent, 'e');
handlers.get('pointermove')({ clientX: 200, clientY: 200 });
handlers.get('pointerleave')();
frame(96);
assert.equal(view.hovered, null, 'leaving cancels queued hover');
assert.equal(hits, 1);

counters.lines.length = 0;
counters.circles.length = 0;
view.display.labels = 'all';
view.draw(100);
assert.deepEqual(counters.lines, [[1000, 100]], 'crossing edge retained, offscreen edge culled');
assert.ok(!counters.circles.some(([x]) => x === -100), 'offscreen region culled');
const measurements = counters.measurements;
view.draw(110);
assert.equal(counters.measurements, measurements, 'text metrics reused');
view.display.fontSize = 18;
view.draw(120);
assert.ok(counters.measurements > measurements, 'font changes refresh text metrics');
view.edgeGroups = [{ kind: 'secondary', color: '#555', edges: view.edges }];
view.camera.scale = .1;
view.draw(121);
assert.ok(counters.dashes.at(-1)[0] * view.camera.scale >= 1.5, 'overview dashes stay visible in screen pixels');
view.camera.scale = 1;
view.draw(122);
assert.deepEqual(counters.dashes.at(-1), [3, 3], 'closer views retain the original dash pattern');

view.restart();
sandbox.document.hidden = true;
view.restart();
assert.equal(frames.size, 0);
sandbox.document.hidden = false;
view.restart();
frame(128);
assert.equal(frames.size, 0);
view.visible = false;
view.restart();
assert.equal(frames.size, 0);
view.visible = true;
view.paused = false;
view.display.motionFrameInterval = 100;
view.restart();
frame(144);
const previousPaints = counters.paints;
frame(160);
assert.equal(counters.paints, previousPaints, 'explicit frame interval respected');
view.zoom(1.01);
frame(176);
assert.equal(counters.paints, previousPaints + 1, 'interaction bypasses motion interval');
console.log('Rendering: coalesced input, paused/hidden views, hover, clipping, text cache and animation timing OK.');
