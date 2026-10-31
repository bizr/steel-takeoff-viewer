import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';

const STATUS_COLOR = { CONFIRMED: '#2d8066', MEASURED: '#3f6fb5', ESTIMATED: '#d59a3e', MISSING: '#b84d46' };
const MARK_PALETTE = ['#547f78', '#cf7351', '#6f88a4', '#9a7a9e', '#b38a45', '#62766f', '#9c665f', '#77965d'];
const PAGE_COPY = {
  model: ['MODEL & VERIFY', 'Roof support steelwork', 'Explore the frame, inspect members and verify the takeoff.', '3D workspace'],
  schedule: ['TAKEOFF', 'Member schedule', 'A traceable bill of materials for every member, plate and fitting.', 'Member schedule'],
  procurement: ['MATERIAL PLANNING', 'Procurement', 'Review stock requirements, cutting efficiency and fasteners.', 'Procurement'],
  quote: ['COMMERCIAL', 'Project quote', 'A transparent cost build-up for fabrication and erection.', 'Quote'],
  qa: ['QUALITY ASSURANCE', 'Quality review', 'Resolve assumptions and cross-check the model against the takeoff.', 'Quality review'],
};
// ?job=<id> loads output/<id>/; no job = the original output/ (14017)
const JOB = new URLSearchParams(location.search).get('job');
const BASE = JOB ? `data/output/${encodeURIComponent(JOB)}/` : 'data/output/';
const state = { data: null, dwg: null, selected: null, mode: 'model', display: 'material', filter: 'all', sheets: new Map(), sheetPage: 0, sheetViewHeight: 1000, visibleFraction: [1, 1] };
const meshesByMark = new Map();
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const fmt = (n, digits = 2) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: digits });
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.prepend(renderer.domElement);
renderer.domElement.setAttribute('aria-label', 'Interactive structural steel model');

const modelScene = new THREE.Scene();
modelScene.background = new THREE.Color('#e8ece9');
const sheetScene = new THREE.Scene();
sheetScene.background = new THREE.Color('#d9dfdb');
const modelCamera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
modelCamera.position.set(14, 12, 18);
const sheetCamera = new THREE.OrthographicCamera(-500, 500, 500, -500, 0.1, 5000);
sheetCamera.position.set(0, 0, 1000);

const controls = new OrbitControls(modelCamera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.5;
controls.maxDistance = 180;
controls.target.set(0, 0, 0);
const sheetControls = new OrbitControls(sheetCamera, renderer.domElement);
sheetControls.enabled = false;
sheetControls.enableRotate = false;
sheetControls.screenSpacePanning = true;
sheetControls.enableDamping = true;
sheetControls.dampingFactor = 0.1;
sheetControls.minZoom = 0.2;
sheetControls.maxZoom = 30;
controls.zoomToCursor = sheetControls.zoomToCursor = true;   // CAD-style: zoom where the pointer is
sheetControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };   // 2D: one finger pans the sheet
// phones and portrait tablets: bottom tab bar, side panels open over the view
const COMPACT = matchMedia('(max-width: 820px)');
const TOUCH = matchMedia('(pointer: coarse)').matches;

// Trackpads: OrbitControls scales each wheel step by |deltaY| / (100 * dpr), so a
// Retina pinch (ctrl+wheel, deltaY ~1-10) barely moves. Set the speed per event,
// in capture on the parent so it runs before OrbitControls' own wheel handler.
viewport.addEventListener('wheel', event => {
  controls.zoomSpeed = sheetControls.zoomSpeed = event.ctrlKey ? 12 : 3;
}, { capture: true, passive: true });

// Safari sends trackpad pinch as gesture events, not ctrl+wheel. iOS also sends
// them for touch pinches, which OrbitControls already handles: skip those.
let gestureScale = 1;
const touches = new Set();
viewport.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') touches.add(event.pointerId); }, { capture: true });
['pointerup', 'pointercancel'].forEach(type => viewport.addEventListener(type, event => touches.delete(event.pointerId), { capture: true }));
viewport.addEventListener('gesturestart', event => { event.preventDefault(); gestureScale = 1; });
viewport.addEventListener('gesturechange', event => {
  event.preventDefault();
  if (touches.size) return;
  const factor = gestureScale / event.scale;          // <1 = zoom in
  gestureScale = event.scale;
  if (state.mode === 'model') {
    const offset = modelCamera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
    modelCamera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
  } else {
    sheetCamera.zoom = THREE.MathUtils.clamp(sheetCamera.zoom / factor, sheetControls.minZoom, sheetControls.maxZoom);
    sheetCamera.updateProjectionMatrix();
    sheetControls.update();
  }
});

modelScene.add(new THREE.HemisphereLight(0xf7fbff, 0x75827b, 2.0));
const sun = new THREE.DirectionalLight(0xfff7ec, 3.1);
sun.position.set(-12, 24, 15);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -24;
sun.shadow.camera.right = 24;
sun.shadow.camera.top = 24;
sun.shadow.camera.bottom = -24;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0004;
modelScene.add(sun);
const fillLight = new THREE.DirectionalLight(0xc9dce5, 0.8);
fillLight.position.set(15, 8, -12);
modelScene.add(fillLight);

const g3d = new THREE.Group();
const gLabels = new THREE.Group();
const gGrid = new THREE.Group();
const gConnections = new THREE.Group();
const gSheet = new THREE.Group();
const gText = new THREE.Group();
modelScene.add(g3d, gLabels, gGrid, gConnections);
sheetScene.add(gSheet, gText);

function resize() {
  const width = Math.max(viewport.clientWidth, 1);
  const height = Math.max(viewport.clientHeight, 1);
  renderer.setSize(width, height, false);
  modelCamera.aspect = width / height;
  modelCamera.updateProjectionMatrix();
  const halfH = state.sheetViewHeight / 2;
  const halfW = halfH * width / height;
  sheetCamera.left = -halfW;
  sheetCamera.right = halfW;
  sheetCamera.top = halfH;
  sheetCamera.bottom = -halfH;
  sheetCamera.updateProjectionMatrix();
  updateViewOffset(width, height);
}
new ResizeObserver(resize).observe(viewport);

// On small screens the side panels cover part of the view: shift the 3D
// projection so the camera target sits in the middle of what is still visible.
function updateViewOffset(width = viewport.clientWidth, height = viewport.clientHeight) {
  const rail = $('#utility-rail').getBoundingClientRect();
  let dx = 0, dy = 0;
  if (COMPACT.matches && rail.width && rail.height && document.body.dataset.page === 'model') {
    if (rail.width > width * 0.7) dy = (height - rail.top) / 2;      // bottom sheet
    else dx = (width - rail.left) / 2;                               // side panel
  }
  state.visibleFraction = [1 - 2 * dx / width, 1 - 2 * dy / height];
  if (dx || dy) modelCamera.setViewOffset(width, height, dx, dy, width, height);
  else modelCamera.clearViewOffset();
  modelCamera.updateProjectionMatrix();
}
new ResizeObserver(() => updateViewOffset()).observe($('#utility-rail'));

function setUtilitiesCollapsed(collapsed) {
  document.body.classList.toggle('utilities-collapsed', collapsed);
  $('#show-utilities').hidden = !collapsed;
  updateViewOffset();
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  if (url.endsWith('.gz')) {
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  return response.json();
}

const col3 = (value, fallback = '#202522') => value ? new THREE.Color(value[0], value[1], value[2]) : new THREE.Color(fallback);

// Ref and title of a sheet: from project.drawings when it lists every page
// ("3225-S01 Ground floor plan"), else the configured drawing, else its number.
function sheetInfo(index = state.sheetPage) {
  const project = state.data?.project ?? {};
  const count = state.dwg?.pages.length ?? 1;
  const sheet = project.sheets?.[index];
  const name = sheet ? sheet.label ?? sheet.source.replace(/\.pdf$/i, '') : project.drawings?.length === count ? project.drawings[index] : null;
  if (name) {
    const [ref, ...title] = name.split(' ');
    return { ref, title: title.join(' ') || ref, label: name };
  }
  if (index === (project.drawing_page ?? 0)) {
    const ref = project.drawing_ref ?? '14017/05 REV B', title = project.drawing_title ?? 'Proposed roof plan';
    return { ref, title, label: `${ref} ${title}` };
  }
  return { ref: `SHEET ${index + 1}`, title: `Sheet ${index + 1} of ${count}`, label: `Sheet ${index + 1}` };
}

// Each sheet is built once into its own groups; switching only toggles visibility.
// Jobs made from sheet files (project.sheets) fetch each sheet the first time it is shown.
async function showSheet(index) {
  if (!state.dwg) return;
  const count = state.dwg.pages.length;
  index = (index + count) % count;
  state.sheetPage = index;
  $('#sheet-select').value = String(index);
  if (!state.dwg.pages[index]) {
    toast(`Loading ${sheetInfo(index).label}…`);
    try {
      state.dwg.pages[index] = (await fetchJSON(BASE + state.data.project.sheets[index].file)).pages[0];
    } catch (error) {
      return toast(`Sheet could not load: ${error.message}`);
    }
    if (state.sheetPage !== index) return;                 // moved on while it loaded
  }
  if (!state.sheets.has(index)) state.sheets.set(index, buildSheet(state.dwg.pages[index]));
  for (const [key, sheet] of state.sheets) sheet.lines.visible = sheet.text.visible = key === index;
  state.sheetBounds = state.sheets.get(index).bounds;
  const info = sheetInfo(index);
  if (state.mode === 'drawing') {
    $('#model-meta').textContent = info.title;
    $('#scene-units').textContent = info.ref;
  }
  fitSheet();
}

function stepSheet(step) {
  if (!state.dwg) return;
  showPage('model');
  if (state.mode !== 'drawing') setViewMode('drawing');
  if (state.dwg.pages.length < 2) return toast('This job has one drawing sheet');
  showSheet(state.sheetPage + step);
  toast(`Sheet ${state.sheetPage + 1}/${state.dwg.pages.length}: ${sheetInfo().label}`);
}

function fillSheetPicker() {
  const count = state.dwg?.pages.length ?? 0;
  $('#sheet-picker').hidden = count < 2;
  $('#sheet-select').innerHTML = Array.from({ length: count }, (_, index) => `<option value="${index}">${index + 1} · ${esc(sheetInfo(index).label)}</option>`).join('');
  $('#sheet-select').value = String(state.sheetPage);
}

function buildSheet(page) {
  const sheetGroup = new THREE.Group();
  const textGroup = new THREE.Group();
  gSheet.add(sheetGroup);
  gText.add(textGroup);
  // dwg.json keeps unrotated PDF coords; map them to display orientation (/Rotate)
  const M = page.rotation_matrix ?? [1, 0, 0, 1, 0, 0];
  const T = p => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];
  const rotateItem = item => {
    if (item[0] === 're') {
      const [a, b] = [T([item[1][0], item[1][1]]), T([item[1][2], item[1][3]])];
      return ['re', [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
    }
    if (item[0] === 'qu') return ['qu', item[1].map(T)];
    return [item[0], ...item.slice(1).map(T)];
  };
  const lines = [];
  const lineColors = [];
  const fillBuckets = new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const track = (x, y) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  const push = (x0, y0, x1, y1, color) => {
    lines.push(x0, -y0, 0, x1, -y1, 0);
    lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  };
  const addFill = (points, color) => {
    const key = color.getHexString();
    if (!fillBuckets.has(key)) fillBuckets.set(key, { color, positions: [], indices: [] });
    const bucket = fillBuckets.get(key);
    const geometry = new THREE.ShapeGeometry(new THREE.Shape(points.map(point => new THREE.Vector2(point[0], -point[1]))));
    const positions = geometry.getAttribute('position');
    const offset = bucket.positions.length / 3;
    for (let i = 0; i < positions.count; i++) bucket.positions.push(positions.getX(i), positions.getY(i), positions.getZ(i));
    if (geometry.index) {
      for (let i = 0; i < geometry.index.count; i++) bucket.indices.push(geometry.index.getX(i) + offset);
    } else {
      for (let i = 0; i < positions.count; i++) bucket.indices.push(i + offset);
    }
    geometry.dispose();
  };
  for (const path of page.paths) {
    const stroke = col3(path.stroke);
    const fill = path.fill ? col3(path.fill) : null;
    const shapePoints = [];
    for (const item of path.items.map(rotateItem)) {
      if (item[0] === 'l') {
        if (path.op !== 'f') push(item[1][0], item[1][1], item[2][0], item[2][1], stroke);
        shapePoints.push(item[1], item[2]);
        track(...item[1]); track(...item[2]);
      } else if (item[0] === 'c') {
        let previous = item[1];
        for (let i = 1; i <= 12; i++) {
          const t = i / 12, mt = 1 - t;
          const x = mt ** 3 * item[1][0] + 3 * mt * mt * t * item[2][0] + 3 * mt * t * t * item[3][0] + t ** 3 * item[4][0];
          const y = mt ** 3 * item[1][1] + 3 * mt * mt * t * item[2][1] + 3 * mt * t * t * item[3][1] + t ** 3 * item[4][1];
          if (path.op !== 'f') push(previous[0], previous[1], x, y, stroke);
          shapePoints.push([x, y]); track(x, y); previous = [x, y];
        }
      } else if (item[0] === 're') {
        const [x0, y0, x1, y1] = item[1];
        if (path.op !== 'f') {
          push(x0, y0, x1, y0, stroke); push(x1, y0, x1, y1, stroke);
          push(x1, y1, x0, y1, stroke); push(x0, y1, x0, y0, stroke);
        }
        shapePoints.push([x0, y0], [x1, y0], [x1, y1], [x0, y1]);
        track(x0, y0); track(x1, y1);
      } else if (item[0] === 'qu') {
        const quad = [item[1][0], item[1][1], item[1][3], item[1][2]];  // PDF quad order ul,ur,ll,lr -> perimeter
        for (let i = 0; i < 4; i++) {
          const a = quad[i], b = quad[(i + 1) % 4];
          if (path.op !== 'f') push(a[0], a[1], b[0], b[1], stroke);
          shapePoints.push(a); track(...a);
        }
      }
    }
    if (fill && path.op !== 's' && shapePoints.length > 2) addFill(shapePoints, fill);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
  sheetGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.82 })));
  for (const bucket of fillBuckets.values()) {
    const fillGeometry = new THREE.BufferGeometry();
    fillGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
    fillGeometry.setIndex(bucket.indices);
    const mesh = new THREE.Mesh(fillGeometry, new THREE.MeshBasicMaterial({ color: bucket.color, side: THREE.DoubleSide }));
    mesh.position.z = -0.1;
    sheetGroup.add(mesh);
  }
  const centerX = (minX + maxX) / 2, centerY = -(minY + maxY) / 2;
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX + 50, maxY - minY + 50), new THREE.MeshBasicMaterial({ color: '#fbfaf5' }));
  paper.position.set(centerX, centerY, -1);
  sheetGroup.add(paper);
  for (const span of page.text.slice(0, 3000)) {
    const canvas = document.createElement('canvas');
    const fontSize = 48;
    canvas.width = Math.max(2, span.t.length * fontSize * 0.62);
    canvas.height = fontSize * 1.4;
    const context = canvas.getContext('2d');
    context.font = `${fontSize}px ${span.font || 'Arial'}`;
    context.fillStyle = '#252a27';
    context.fillText(span.t, 0, fontSize);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
    const height = span.size * 1.4;
    sprite.scale.set(height * canvas.width / canvas.height, height, 1);
    sprite.center.set(0, 0.5);
    const origin = T(span.o);
    const dir = span.dir ? [M[0] * span.dir[0] + M[2] * span.dir[1], M[1] * span.dir[0] + M[3] * span.dir[1]] : [1, 0];
    sprite.position.set(origin[0], -origin[1], 0.5);
    sprite.material.rotation = Math.atan2(-dir[1], dir[0]);
    textGroup.add(sprite);
  }
  return { lines: sheetGroup, text: textGroup, bounds: { minX, maxX, minY: -maxY, maxY: -minY, centerX, centerY } };
}

// Part of the canvas not covered by the floating bars and panels, in canvas pixels.
function freeRect() {
  const width = viewport.clientWidth, height = viewport.clientHeight, gap = 8;
  const box = selector => {
    const rect = $(selector)?.getBoundingClientRect();
    return rect?.width && rect.height ? rect : null;
  };
  let left = 0, right = width, top = 0, bottom = height;
  for (const selector of ['.topbar', '#viewer-toolbar']) {
    const rect = box(selector);
    if (rect) top = Math.max(top, rect.bottom + gap);
  }
  const nav = box('#sidebar');                      // left column, or the bottom tab bar
  if (nav && nav.width < width / 2) left = nav.right + gap;
  else if (nav) bottom = Math.min(bottom, nav.top - gap);
  const rail = box('#utility-rail');                // right column, or the phone bottom sheet
  if (rail && rail.width > width * 0.7) bottom = Math.min(bottom, rail.top - gap);
  else if (rail) right = Math.min(right, rail.left - gap);
  for (const selector of ['#viewer-subbar', '.viewer-status', '.content-footer']) {
    const rect = box(selector);
    if (rect && rect.top > height / 2) bottom = Math.min(bottom, rect.top - gap);
  }
  return { left, right, top, bottom };
}

// Fit the sheet into the free part of the canvas, not behind the panels.
function fitSheet() {
  if (!state.sheetBounds) return;
  const bounds = state.sheetBounds;
  const width = Math.max(viewport.clientWidth, 1), height = Math.max(viewport.clientHeight, 1);
  const free = freeRect();
  const freeWidth = Math.max(free.right - free.left, width * 0.3), freeHeight = Math.max(free.bottom - free.top, height * 0.3);
  const unit = Math.max((bounds.maxX - bounds.minX) / freeWidth, (bounds.maxY - bounds.minY) / freeHeight) * 1.04;   // sheet units per pixel
  state.sheetViewHeight = unit * height;
  const x = bounds.centerX - ((free.left + free.right) / 2 - width / 2) * unit;
  const y = bounds.centerY + ((free.top + free.bottom) / 2 - height / 2) * unit;
  sheetCamera.zoom = 1;
  sheetCamera.position.set(x, y, 1000);
  sheetControls.target.set(x, y, 0);
  sheetControls.update();
  resize();
}

function rectangleShape(width, height) {
  return new THREE.Shape([
    new THREE.Vector2(-width / 2, -height / 2), new THREE.Vector2(width / 2, -height / 2),
    new THREE.Vector2(width / 2, height / 2), new THREE.Vector2(-width / 2, height / 2),
  ]);
}

// Section library lookup: exact key, else the same normalised match as takeoff/sections.py
// (UC = UKC, UB = UKB, UPFC = PFC, "100x100x5" = "100x100x5.0", any case / multiplication sign).
const SECTION_ALIASES = { UC: 'UKC', UB: 'UKB', UPFC: 'PFC', UKPFC: 'PFC', L: 'EA' };
function normaliseSection(name) {
  let text = String(name).toUpperCase().replace(/[×*]/g, 'X').trim().replace(/\s*X\s*/g, 'X').replace(/\s+/g, ' ');
  text = text.replace(/^L\s*(\d.*)$/, '$1 L');
  const match = text.match(/^(\d+(?:\.\d+)?(?:X\d+(?:\.\d+)?)+)\s*([A-Z]+)?$/);
  if (!match) return text;
  const dims = match[1].split('X').map(part => String(Number(part)));
  let suffix = SECTION_ALIASES[match[2]] ?? match[2] ?? '';
  if (suffix === 'EA' && dims[0] !== dims[1]) suffix = 'UA';
  return `${dims.join('X')} ${suffix}`.trim();
}
const sectionIndex = new WeakMap();
function sectionFor(sections, name) {
  if (!sections || !name) return null;
  if (sections[name]) return sections[name];
  if (!sectionIndex.has(sections)) sectionIndex.set(sections, new Map(Object.keys(sections).map(key => [normaliseSection(key), key])));
  const key = sectionIndex.get(sections).get(normaliseSection(name));
  return key ? sections[key] : null;
}

function profileGeometry(points, length, depth) {
  const shape = new THREE.Shape(points.map(point => new THREE.Vector2(...point)));
  return { geometry: new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false }), depth };
}

function memberGeometry(member, length, sections) {
  const section = sectionFor(sections, member.section);
  if (section?.shape === 'I') {
    const b = section.b / 1000, h = section.h / 1000;
    const tw = Math.max(section.tw / 1000, 0.0004), tf = section.tf / 1000;
    return profileGeometry([
      [-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, -h / 2 + tf], [tw / 2, -h / 2 + tf],
      [tw / 2, h / 2 - tf], [b / 2, h / 2 - tf], [b / 2, h / 2], [-b / 2, h / 2],
      [-b / 2, h / 2 - tf], [-tw / 2, h / 2 - tf], [-tw / 2, -h / 2 + tf], [-b / 2, -h / 2 + tf],
    ], length, h);
  }
  if (section?.shape === 'C') {
    // PFC: web on local -x, toes always point local +x (same side for every member)
    const b = section.b / 1000, h = section.h / 1000;
    const tw = Math.max(section.tw / 1000, 0.0004), tf = section.tf / 1000;
    return profileGeometry([
      [-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, -h / 2 + tf], [-b / 2 + tw, -h / 2 + tf],
      [-b / 2 + tw, h / 2 - tf], [b / 2, h / 2 - tf], [b / 2, h / 2], [-b / 2, h / 2],
    ], length, h);
  }
  if (section?.shape === 'L') {
    // angle: leg h up the local -x side, leg b along the bottom, heel at bottom-left
    const b = section.b / 1000, h = section.h / 1000, t = Math.max(section.t / 1000, 0.0004);
    return profileGeometry([
      [-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, -h / 2 + t], [-b / 2 + t, -h / 2 + t], [-b / 2 + t, h / 2], [-b / 2, h / 2],
    ], length, h);
  }
  if (section?.shape === 'CHS') {
    const radius = section.d / 2000, thickness = Math.min(section.t / 1000, radius * 0.9);
    const shape = new THREE.Shape();
    shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, radius - thickness, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    return { geometry: new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false, curveSegments: 28 }), depth: radius * 2 };
  }
  const height = (section?.h ?? member.depth_mm) / 1000;
  const width = (section?.b ?? member.width_mm) / 1000;
  if (section?.shape === 'RHS') {
    const shape = rectangleShape(width, height);
    const thickness = section.t / 1000;
    const hole = new THREE.Path([
      new THREE.Vector2(-width / 2 + thickness, -height / 2 + thickness),
      new THREE.Vector2(-width / 2 + thickness, height / 2 - thickness),
      new THREE.Vector2(width / 2 - thickness, height / 2 - thickness),
      new THREE.Vector2(width / 2 - thickness, -height / 2 + thickness),
    ]);
    shape.holes.push(hole);
    return { geometry: new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false }), depth: height };
  }
  const geometry = new THREE.BoxGeometry(width, height, length);
  geometry.translate(0, 0, length / 2);
  return { geometry, depth: height };
}

function memberQuaternion(direction, webDir) {
  // posts: section depth along layout "web_dir" (plan), default model y (= world -z)
  const up = Math.abs(direction.y) > 0.9 ? (webDir ? toWorld(webDir[0], webDir[1], 0).normalize() : new THREE.Vector3(0, 0, 1)) : new THREE.Vector3(0, 1, 0);
  const yAxis = up.clone().sub(direction.clone().multiplyScalar(up.dot(direction))).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, direction).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, direction));
}

const toWorld = (x, y, z) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000);
const directionToWorld = vector => toWorld(vector[0], vector[1], vector[2]).normalize();
const PLATE_MATERIAL = new THREE.MeshStandardMaterial({ color: '#63736f', metalness: 0.72, roughness: 0.32 });
const BOLT_MATERIAL = new THREE.MeshStandardMaterial({ color: '#35403c', metalness: 0.75, roughness: 0.3 });

function boltMesh(diameter, length, withHead = true) {
  const group = new THREE.Group();
  const radius = diameter / 2000 * 1.35;
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length / 1000, 12), BOLT_MATERIAL));
  if (withHead) {
    const head = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.75, radius * 1.75, diameter / 1000, 6), BOLT_MATERIAL);
    head.position.y = length / 2000 + diameter / 2000;
    group.add(head);
  }
  return group;
}

// Rule-based joints (takeoff/connections.py) carry explicit geometry in model mm:
// plates as boxes on local axes u, v (w = u x v), bolts as axis + diameter + length.
function buildParts(joint) {
  const group = new THREE.Group();
  for (const part of joint.parts) {
    const u = directionToWorld(part.u), v = directionToWorld(part.v);
    const w = new THREE.Vector3().crossVectors(u, v).normalize();
    const plate = new THREE.Mesh(new THREE.BoxGeometry(...part.size.map(value => value / 1000)), PLATE_MATERIAL);
    plate.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, w));
    plate.position.copy(toWorld(...part.center));
    group.add(plate);
  }
  for (const bolt of joint.bolt_parts) {
    const mesh = boltMesh(bolt.dia, bolt.length);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), directionToWorld(bolt.dir));
    mesh.position.copy(toWorld(...bolt.at));
    group.add(mesh);
  }
  return group;
}

function buildConnections(data) {
  if (!data.connections) return;
  for (const joint of data.connections.joints) {
    if (joint.parts) {
      const group = buildParts(joint);
      group.userData.members = joint.members;
      group.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; } });
      gConnections.add(group);
      continue;
    }
    const type = data.connections.types[joint.type];
    const [width, depth, thickness] = type.plate;
    const group = new THREE.Group();
    group.position.copy(toWorld(...joint.pos_mm));
    if (type.kind === 'baseplate' || type.kind === 'cap_plate') {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(width / 1000, thickness / 1000, depth / 1000), PLATE_MATERIAL);
      plate.position.y = -thickness / 2000;
      group.add(plate);
      const boltLength = type.bolts.length_mm ?? type.bolts.projection_mm + thickness;
      for (const x of [-1, 1]) for (const z of [-1, 1]) {
        const bolt = boltMesh(type.bolts.dia, boltLength);
        bolt.position.set(x * type.bolts.gauge[0] / 1000, type.kind === 'baseplate' ? (type.bolts.projection_mm - thickness) / 2000 : 0, z * type.bolts.gauge[1] / 1000);
        group.add(bolt);
      }
    } else if (type.kind === 'end_plate') {
      const normal = directionToWorld(joint.normal ?? [0, -1, 0]);
      const beamHeight = (joint.beam_h_mm ?? type.beam_h_mm ?? 157.6) / 1000;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(depth / 1000, width / 1000, thickness / 1000), PLATE_MATERIAL);
      plate.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      plate.position.copy(normal).multiplyScalar(thickness / 2000);
      plate.position.y += beamHeight / 2;
      group.add(plate);
      const across = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const bolt = boltMesh(type.bolts.dia, type.bolts.length_mm);
        bolt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        bolt.position.addScaledVector(across, x * type.bolts.gauge[0] / 1000);
        bolt.position.y += y * type.bolts.gauge[1] / 1000 + beamHeight / 2;
        group.add(bolt);
      }
    }
    group.userData.members = joint.members;
    group.traverse(object => { if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; } });
    gConnections.add(group);
  }
}

function makeLabel(mark) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 88;
  const context = canvas.getContext('2d');
  context.fillStyle = '#17211f';
  context.beginPath();
  context.roundRect(3, 3, 250, 82, 18);
  context.fill();
  context.strokeStyle = '#ffffff44';
  context.lineWidth = 2;
  context.stroke();
  context.font = '600 43px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#ffffff';
  context.fillText(mark, 128, 45);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.scale.set(1.05, 0.36, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function updateMaterials() {
  for (const [mark, meshes] of meshesByMark) {
    for (const mesh of meshes) {
      const selected = state.selected === mark;
      const color = selected ? '#df6742' : state.display === 'status' ? STATUS_COLOR[mesh.userData.status] : '#78908d';
      mesh.material.color.set(color || '#78908d');
      mesh.material.emissive.set(selected ? '#341008' : '#000000');
      mesh.material.emissiveIntensity = selected ? 0.5 : 0;
      mesh.material.wireframe = state.partRender === 'wireframe';
      mesh.material.transparent = state.partRender === 'shaded' && !selected;
      mesh.material.opacity = mesh.material.transparent ? 0.3 : 1;
      mesh.material.depthWrite = !mesh.material.transparent;
      mesh.visible = !state.isolated || state.isolated === mark;
    }
  }
}

function buildModel(data) {
  g3d.clear(); gLabels.clear(); gGrid.clear(); gConnections.clear();
  meshesByMark.clear();
  const materials = new Map();
  let segmentCount = 0;
  for (const member of data.model.members) {
    if (!materials.has(member.mark)) {
      materials.set(member.mark, new THREE.MeshStandardMaterial({ color: '#78908d', metalness: 0.66, roughness: 0.34 }));
      meshesByMark.set(member.mark, []);
    }
    let longest = null;
    for (const segment of member.segments) {
      const start = toWorld(...segment.from);
      const end = toWorld(...segment.to);
      const direction = end.clone().sub(start);
      const length = direction.length();
      if (length < 0.0001) continue;
      direction.normalize();
      const { geometry, depth } = memberGeometry(member, length, data.sections);
      const mesh = new THREE.Mesh(geometry, materials.get(member.mark));
      const vertical = Math.abs(direction.y) > 0.9;
      const lift = vertical ? 0 : depth / 2;
      mesh.position.copy(start);
      mesh.position.y += lift;
      mesh.quaternion.copy(memberQuaternion(direction, member.web_dir));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.mark = member.mark;
      mesh.userData.status = member.status;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 32), new THREE.LineBasicMaterial({ color: '#31433e', transparent: true, opacity: 0.22 }));
      mesh.add(edges);
      g3d.add(mesh);
      meshesByMark.get(member.mark).push(mesh);
      if (!longest || length > longest.length) longest = { start, end, length, lift, depth };
      segmentCount++;
    }
    if (longest) {
      const label = makeLabel(member.mark);
      label.position.copy(longest.start).add(longest.end).multiplyScalar(0.5);
      label.position.y += longest.lift + longest.depth / 2 + 0.55;
      label.userData.mark = member.mark;
      gLabels.add(label);
    }
  }
  buildConnections(data);
  const bounds = new THREE.Box3().setFromObject(g3d);
  state.modelCenter = bounds.getCenter(new THREE.Vector3());
  state.modelSize = bounds.getSize(new THREE.Vector3());
  state.modelRadius = Math.max(state.modelSize.length() / 2, 2);
  const groundY = bounds.min.y - 0.045;
  const gridSize = Math.max(24, Math.ceil(Math.max(state.modelSize.x, state.modelSize.z) * 1.5 / 2) * 2);
  const grid = new THREE.GridHelper(gridSize, Math.min(gridSize, 36), '#8d9b95', '#aab5af');
  grid.position.set(state.modelCenter.x, groundY, state.modelCenter.z);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  gGrid.add(grid);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ color: '#34443e', opacity: 0.16 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = groundY - 0.01;
  ground.receiveShadow = true;
  gGrid.add(ground);
  const axes = new THREE.AxesHelper(1.4);
  axes.position.set(bounds.min.x - 0.8, groundY + 0.01, bounds.max.z + 0.8);
  gGrid.add(axes);
  $('#model-meta').textContent = `${data.model.members.length} assemblies · ${segmentCount} segments`;
  updateMaterials();
}

let cameraAnimation = null;
const viewHistory = [];
function pushView() {
  const view = state.mode === 'model'
    ? { mode: 'model', target: controls.target.clone(), position: modelCamera.position.clone() }
    : { mode: 'drawing', target: sheetControls.target.clone(), position: sheetCamera.position.clone(), zoom: sheetCamera.zoom };
  const last = viewHistory.at(-1);
  if (last && last.mode === view.mode && last.target.distanceTo(view.target) < 1e-4 && last.position.distanceTo(view.position) < 1e-4 && last.zoom === view.zoom) return;
  viewHistory.push(view);
  if (viewHistory.length > 50) viewHistory.shift();
}

function animateCamera(target, position, duration = 500) {
  pushView();
  const started = performance.now();
  const fromTarget = controls.target.clone();
  const fromPosition = modelCamera.position.clone();
  cameraAnimation = () => {
    const progress = Math.min((performance.now() - started) / duration, 1);
    const eased = 1 - (1 - progress) ** 3;
    controls.target.lerpVectors(fromTarget, target, eased);
    modelCamera.position.lerpVectors(fromPosition, position, eased);
    if (progress >= 1) cameraAnimation = null;
  };
}

function setCamera(name) {
  if (!state.modelCenter) return;
  pushView();
  cameraAnimation = null;
  const directions = {
    iso: new THREE.Vector3(1, 0.82, 1.25).normalize(),
    top: new THREE.Vector3(0, 1, 0.001).normalize(),
    front: new THREE.Vector3(0, 0.12, 1).normalize(),
    right: new THREE.Vector3(1, 0.12, 0).normalize(),
  };
  const direction = name === 'fit' ? modelCamera.position.clone().sub(controls.target).normalize() : directions[name];
  const fitMargin = modelCamera.aspect < 1 ? 1.02 : 0.82;
  const distance = state.modelRadius / Math.sin(fitFov() / 2) * fitMargin;
  controls.target.copy(state.modelCenter);
  modelCamera.position.copy(state.modelCenter).addScaledVector(direction, distance);
  modelCamera.up.set(0, 1, 0);
  controls.update();
  $$('[data-cam]').forEach(button => button.classList.toggle('active', button.dataset.cam === name));
}

// Narrowest field of view over the part of the canvas no panel covers.
function fitFov() {
  const [fx, fy] = state.visibleFraction;
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(modelCamera.fov) / 2);
  return 2 * Math.atan(tanHalf * Math.min(fy, modelCamera.aspect * fx));
}

function focusMember(mark) {
  const bounds = new THREE.Box3();
  for (const mesh of meshesByMark.get(mark) ?? []) bounds.expandByObject(mesh);
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const direction = modelCamera.position.clone().sub(controls.target).normalize();
  const distance = Math.max(size.length() / 2 / Math.sin(fitFov() / 2) * 1.1, 2.5);
  animateCamera(center, center.clone().addScaledVector(direction, distance));
}

function focusConnection(id) {
  const joint = state.data?.connections?.joints.find(item => (item.id ?? `${item.type}`) === id && item.pos_mm);
  if (!joint) return;
  showPage('model');
  setViewMode('model');
  const center = toWorld(...joint.pos_mm);
  const direction = modelCamera.position.clone().sub(controls.target).normalize();
  animateCamera(center, center.clone().addScaledVector(direction, 1.1));
}

function showPage(name) {
  document.body.dataset.page = name;
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  $$('.page').forEach(page => page.classList.toggle('active', page.id === `page-${name}`));
  $('#page-crumb').textContent = PAGE_COPY[name][3];
  if (COMPACT.matches && name !== 'model') setUtilitiesCollapsed(true);
  requestAnimationFrame(resize);
}

function renderMemberList() {
  if (!state.data) return;
  const query = $('#member-search').value.trim().toLowerCase();
  const members = state.data.members.filter(member => {
    const matchesQuery = `${member.mark} ${member.section}`.toLowerCase().includes(query);
    const matchesFilter = state.filter === 'all' || member.status !== 'CONFIRMED';
    return matchesQuery && matchesFilter;
  });
  $('#member-list').innerHTML = members.length ? members.map(member => `
    <button class="member-row ${state.selected === member.mark ? 'selected' : ''}" data-mark="${esc(member.mark)}">
      <span class="mark-badge">${esc(member.mark)}</span>
      <span class="member-main"><strong>${esc(member.section)}</strong><small>${member.qty} × ${fmt(member.length_mm / 1000)} m</small></span>
      <span class="member-side"><strong>${fmt(member.mass_kg, 1)} kg</strong><small><i class="status-dot ${member.status}"></i>${member.status}</small></span>
    </button>`).join('') : '<div class="empty-list">No members match this search.</div>';
  $$('#member-list .member-row').forEach(button => button.onclick = () => selectMember(button.dataset.mark));
}

function fillMemberDetail(mark) {
  if (!mark || !state.data) return;
  const rows = state.data.members.filter(member => member.mark === mark);
  if (!rows.length) return;
  const member = rows[0];
  const mass = rows.reduce((sum, row) => sum + row.mass_kg, 0);
  const section = sectionFor(state.data.sections, member.section);
  const shapeRows = {
    I: s => [['Depth h', `${s.h} mm`], ['Flange width b', `${s.b} mm`], ['Web tw', `${s.tw} mm`], ['Flange tf', `${s.tf} mm`], ['Root radius', `${s.r} mm`]],
    C: s => [['Depth h', `${s.h} mm`], ['Flange width b', `${s.b} mm`], ['Web tw', `${s.tw} mm`], ['Flange tf', `${s.tf} mm`], ['Root radius', `${s.r} mm`]],
    RHS: s => [['Depth h', `${s.h} mm`], ['Width b', `${s.b} mm`], ['Wall thickness', `${s.t} mm`]],
    CHS: s => [['Outside diameter', `${s.d} mm`], ['Wall thickness', `${s.t} mm`]],
    L: s => [['Leg h', `${s.h} mm`], ['Leg b', `${s.b} mm`], ['Thickness t', `${s.t} mm`], ...(s.r1 ? [['Root radius', `${s.r1} mm`]] : [])],
  };
  const properties = section ? [
    ...(shapeRows[section.shape] ?? (s => [['Depth h', `${s.h} mm`], ['Width b', `${s.b} mm`]]))(section),
    ...(section.kg_m != null ? [['Unit mass', `${section.kg_m} kg/m`]] : []),
    ...(section.A_cm2 != null ? [['Section area', `${section.A_cm2} cm²`]] : []),
    ...(section.Ix_cm4 != null ? [['Ixx', `${fmt(section.Ix_cm4, 0)} cm⁴`]] : []),
    ...(section.Iy_cm4 != null ? [['Iyy', `${fmt(section.Iy_cm4, 0)} cm⁴`]] : []),
  ] : [];
  const joints = (state.data.connections?.joints ?? []).filter(joint => joint.members.includes(mark));
  $('#inspector-detail').innerHTML = `
    <div class="detail-head"><button class="back-button" id="detail-back">← Back to schedule</button>
      <div class="detail-title"><span class="mark-badge">${esc(mark)}</span><div><h2>${esc(member.section)}</h2><p><span class="pill pill-${member.status}">${member.status}</span></p></div></div>
    </div>
    <div class="detail-body">
      <div class="detail-metrics"><div class="detail-metric"><span>Quantity</span><strong>${member.qty}</strong></div><div class="detail-metric"><span>Length each</span><strong>${fmt(member.length_mm / 1000)} m</strong></div><div class="detail-metric"><span>Total mass</span><strong>${fmt(mass, 1)} kg</strong></div></div>
      <section class="detail-section"><h3>Location &amp; source</h3><p class="detail-note">${esc(member.location)}<br><br>${esc(member.source)}</p></section>
      ${properties.length ? `<section class="detail-section"><h3>Section properties</h3><div class="property-grid">${properties.map(([key, value]) => `<span>${key}</span><span>${value}</span>`).join('')}</div></section>` : ''}
      ${joints.length ? `<section class="detail-section"><h3>Connections</h3>${joints.map(joint => {
        if (joint.auto) return `<div class="connection-item" data-joint="${esc(joint.id)}" role="button" tabindex="0" title="Zoom to this connection"><strong>${esc(joint.id)} · ${esc(joint.rule.replace(/_/g, ' '))}${joint.variant ? ` (${esc(joint.variant)})` : ''} · rule-based</strong><span>${esc(joint.note)}${joint.warnings.map(warning => `<br>⚠ ${esc(warning)}`).join('')}</span></div>`;
        const type = state.data.connections.types[joint.type];
        return `<div class="connection-item"><strong>${esc(joint.type)} · ${esc(type.desc)}</strong><span>${type.plate.join(' × ')} mm plate · ${type.bolts.n}No ${esc(type.bolts.spec)}<br>${esc(joint.note)}</span></div>`;
      }).join('')}</section>` : ''}
      ${member.notes ? `<div class="detail-warning"><strong>Review note</strong><br>${esc(member.notes)}</div>` : ''}
    </div>
    <div class="detail-actions"><button class="button" id="focus-member">Focus member in 3D</button></div>`;
  $('#inspector-list').hidden = true;
  $('#inspector-detail').hidden = false;
  $('#detail-back').onclick = () => selectMember(null, false);
  $('#focus-member').onclick = () => { setViewMode('model'); focusMember(mark); };
  $$('#inspector-detail [data-joint]').forEach(item => item.onclick = () => focusConnection(item.dataset.joint));
}

function selectMember(mark, focus = true) {
  state.selected = mark || null;
  updateMaterials();
  renderMemberList();
  if (mark) {
    showPage('model');
    setUtilitiesCollapsed(false);
    $('#inspector').classList.remove('collapsed');
    $('#collapse-inspector').textContent = '−';
    fillMemberDetail(mark);
    const member = state.data.members.find(item => item.mark === mark);
    $('#sel-info').textContent = `${mark} · ${member.section} · ${fmt(member.mass_kg, 1)} kg`;
    if (focus) {
      if (state.mode !== 'model') setViewMode('model');
      focusMember(mark);
    }
  } else {
    $('#inspector-list').hidden = false;
    $('#inspector-detail').hidden = true;
    $('#sel-info').textContent = 'Select a member to inspect';
  }
}

function viewportHelp(isModel) {
  if (TOUCH) return isModel ? 'Drag to orbit <i>·</i> Pinch to zoom <i>·</i> Two fingers to pan <i>·</i> Tap a member' : 'Drag to pan <i>·</i> Pinch to zoom';
  return isModel ? 'Drag to orbit <i>·</i> Scroll to zoom <i>·</i> Click a member' : 'Drag to pan <i>·</i> Scroll to zoom <i>·</i> Use fit to reset';
}

function setViewMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  $$('[data-view-mode]').forEach(button => button.classList.toggle('active', button.dataset.viewMode === mode));
  const isModel = mode === 'model';
  controls.enabled = isModel;
  sheetControls.enabled = !isModel;
  $('#model-tools').hidden = !isModel;
  $('#drawing-tools').hidden = isModel;
  $('#camera-presets').hidden = !isModel;
  $('.legend').hidden = !isModel;
  const segmentCount = state.data?.model.members.reduce((sum, member) => sum + member.segments.length, 0) ?? 0;
  $('#model-meta').textContent = isModel ? `${state.data?.model.members.length ?? 0} assemblies · ${segmentCount} segments` : sheetInfo().title;
  $('#scene-label').textContent = isModel ? '3D MODEL' : '2D DRAWING';
  $('#scene-units').textContent = isModel ? 'METRES' : sheetInfo().ref;
  $('#viewport-help').innerHTML = viewportHelp(isModel);
  if (!isModel && state.dwg && !state.sheets.has(state.sheetPage)) showSheet(state.sheetPage);
  resize();
}

function fillProject(project) {
  const set = (selector, value) => { if (value) $(selector).textContent = value; };
  if (project.short_name) document.title = `Steel Takeoff — ${project.short_name}`;
  set('#top-job', project.job && `JOB ${project.job}${project.revision ? ' · REV ' + project.revision : ''}`);
  set('#project-job-no', project.job);
  set('#project-rev', project.revision ? `REV ${project.revision}` : '');
  set('#project-name', project.short_name);
  if (project.package || project.address) $('#project-desc').innerHTML = `${esc(project.package ?? '')}<br>${esc(project.address ?? '')}`;
  if (project.stock_note) set('#stock-note', project.stock_note);
}

function fillSummary(data) {
  $('#kpi-net').innerHTML = `${fmt(data.summary.net_t, 3)} <small>t</small>`;
  $('#kpi-order').innerHTML = `${fmt(data.summary.order_t, 3)} <small>t</small>`;
  $('#kpi-quote').textContent = `£${fmt(data.summary.quote_total, 0)}`;
  $('#kpi-verify').textContent = data.summary.n_to_verify;
  $('#kpi-waste').textContent = `Includes ${data.quote.procurement.waste_pct}% waste allowance`;
  $('#review-count').textContent = data.summary.n_to_verify;
  $('#nav-qa-count').textContent = data.summary.n_to_verify;
  $('#qa-count').textContent = `${data.summary.n_to_verify} open items`;
  $('#member-count').textContent = data.members.length;
  $('#member-mass').textContent = `${fmt(data.summary.member_mass_kg, 1)} kg`;
  const generated = new Date(data.generated);
  $('#generated-date').textContent = generated.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fillSchedule(data) {
  $('#schedule-count').textContent = `${data.members.length} member marks · ${data.plates.length} plate types`;
  const members = data.members.map(member => `<tr class="rowmark" data-mark="${esc(member.mark)}"><td><span class="table-mark">${esc(member.mark)}</span></td><td class="mono">${esc(member.section)}<div class="item-description">${esc(member.location)}</div></td><td class="num">${member.qty}</td><td class="num">${fmt(member.length_mm, 0)}</td><td class="num">${fmt(member.kg_m, 1)}</td><td class="num">${fmt(member.mass_kg, 1)}</td><td><span class="pill pill-${member.status}">${member.status}</span></td></tr>`).join('');
  const plates = data.plates.map(plate => `<tr><td><span class="table-mark">${esc(plate.mark)}</span></td><td>${esc(plate.description)}<div class="item-description">${esc(plate.size)} mm · ${esc(plate.source)}</div></td><td class="num">${plate.qty}</td><td class="num">—</td><td class="num">—</td><td class="num">${fmt(plate.mass_kg, 1)}</td><td><span class="pill pill-${/estimat|not dimensioned|missing/i.test(plate.notes) ? 'ESTIMATED' : 'CONFIRMED'}">PLATE</span></td></tr>`).join('');
  $('#schedule-table').innerHTML = `<table><thead><tr><th>Mark</th><th>Section / item</th><th class="num">Qty</th><th class="num">Length (mm)</th><th class="num">kg/m</th><th class="num">Mass (kg)</th><th>Status</th></tr></thead><tbody>${members}${plates}</tbody></table>`;
  $$('#schedule-table .rowmark').forEach(row => row.onclick = () => selectMember(row.dataset.mark));
}

function fillProcurement(data) {
  const marks = [...new Set(data.members.map(member => member.mark))];
  const colour = mark => MARK_PALETTE[marks.indexOf(mark) % MARK_PALETTE.length];
  const totalOffcut = data.cut_list.reduce((sum, bar) => sum + bar.offcut_mm, 0);
  $('#stock-count').textContent = `${data.cut_list.length} stock bars`;
  const bars = data.cut_list.map(bar => {
    const pieces = bar.pieces.map(piece => `<div class="bar-seg" style="width:${piece.length_mm / bar.stock_mm * 100}%;background:${colour(piece.mark)}" title="${esc(piece.mark)} · ${piece.length_mm} mm">${esc(piece.mark)}</div>`).join('');
    const offcut = bar.offcut_mm > 0 ? `<div class="bar-offcut" style="width:${bar.offcut_mm / bar.stock_mm * 100}%"></div>` : '';
    return `<div class="bar-row"><div class="bar-head"><strong>Bar ${bar.bar} · ${esc(bar.section)}</strong><span>${fmt(bar.offcut_mm, 0)} mm offcut</span></div><div class="bar-track">${pieces}${offcut}</div><div class="bar-foot"><span>${bar.pieces.length} pieces</span><span>${fmt(bar.stock_mm / 1000, 1)} m stock</span></div></div>`;
  }).join('');
  const fasteners = data.fasteners.map(fastener => `<tr><td>${esc(fastener.description)}</td><td class="num">${fastener.qty}</td></tr>`).join('');
  $('#procurement-content').innerHTML = `<div class="summary-strip"><div class="summary-box"><span>Stock bars</span><strong>${data.cut_list.length}</strong></div><div class="summary-box"><span>Total offcut</span><strong>${fmt(totalOffcut / 1000)} m</strong></div><div class="summary-box"><span>Order quantity</span><strong>${fmt(data.summary.order_t)} t</strong></div></div><div class="section-heading"><h3>Cutting list</h3><span>First-fit into ${fmt((data.cut_list[0]?.stock_mm ?? 13000) / 1000, 1)} m stock bars</span></div><div class="cut-grid">${bars}</div><div class="section-heading"><h3>Fasteners</h3><span>${data.fasteners.length} item types</span></div><table class="fastener-table"><thead><tr><th>Description</th><th class="num">Quantity</th></tr></thead><tbody>${fasteners}</tbody></table>`;
}

function fillQuote(data) {
  const items = data.quote.items.map(item => `<tr><td>${esc(item.item)}</td><td class="num">${item.qty} ${item.unit}</td><td class="num">£${fmt(item.rate)}</td><td class="num">£${fmt(item.total)}</td></tr>`).join('');
  $('#quote-content').innerHTML = `<section class="quote-main"><div class="panel-heading"><div><span class="eyebrow">COST BUILD-UP</span><h2>Fabrication &amp; erection</h2><p>Illustrative UK fabricator rates.</p></div><div class="window-actions">${data.offer ? '<button class="button button-secondary" id="print-quote"><svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z"/></svg><span>Print / PDF</span></button>' : ''}<span class="panel-badge">GBP</span><button class="window-control" data-collapse-window title="Collapse window" aria-label="Collapse window">−</button></div></div><div class="table-scroll"><table><thead><tr><th>Item</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Total</th></tr></thead><tbody>${items}<tr><td>Subtotal</td><td></td><td></td><td class="num">£${fmt(data.quote.subtotal)}</td></tr><tr><td>Overheads &amp; profit · ${data.quote.overhead_profit_pct}%</td><td></td><td></td><td class="num">£${fmt(data.quote.overhead_profit)}</td></tr><tr class="qtotal"><td>Total</td><td></td><td></td><td class="num">£${fmt(data.quote.total)}</td></tr></tbody></table>${offerTerms(data)}</div></section><aside class="quote-side"><span class="quote-total-label">Estimated project total</span><div class="quote-total">£${fmt(data.quote.total)}</div><span class="quote-currency">GBP · including overheads &amp; profit</span><div class="quote-breakdown"><div><span>Net steel</span><strong>${fmt(data.summary.net_t, 3)} t</strong></div><div><span>Order quantity</span><strong>${fmt(data.summary.order_t, 3)} t</strong></div><div><span>Waste allowance</span><strong>${data.quote.procurement.waste_pct}%</strong></div></div><div class="hour-cards"><div class="hour-card"><strong>${data.manhours.fabrication_hours}</strong><span>Fabrication hours</span></div><div class="hour-card"><strong>${data.manhours.erection_hours}</strong><span>Erection hours</span></div></div><p class="quote-disclaimer">These rates are illustrative. Substitute current supplier and fabricator rates before issuing a commercial quote.</p></aside>`;
  $('#print-quote')?.addEventListener('click', () => window.print());
}

const CONNECTION_STATUS = { auto: ['check-pass', 'Designed by rules'], 'auto-warning': ['check-warn', 'Designed - check'], provisional: ['check-warn', 'Provisional'], manual: ['check-pass', "Engineer's detail"], resolved: ['check-pass', 'Corner resolved'], skipped: ['check-warn', 'Skipped'], unresolved: ['check-warn', 'Needs detail'], clash: ['check-warn', 'Clash'], warning: ['check-warn', 'Warning'], info: ['check-pass', 'Note'] };

function connectionReport(data) {
  const rows = (data.connection_report ?? []).map(row => {
    const [cls, label] = CONNECTION_STATUS[row.status] ?? ['check-warn', row.status];
    const flagged = row.text.includes('⚠') || cls === 'check-warn';
    return `<tr${data.connections?.joints.some(joint => joint.id === row.id) ? ` class="rowjoint" data-joint="${esc(row.id)}" title="Zoom to this connection"` : ''}><td><span class="table-mark">${esc(row.id)}</span></td><td><span class="${flagged ? 'check-warn' : cls}">${flagged ? '⚠ ' : '✓ '}${label}</span></td><td>${esc(row.text.replace(/^[^:]+: /, ''))}</td></tr>`;
  }).join('');
  return rows ? `<section class="qa-section"><h3>Connections</h3><table><thead><tr><th>Joint</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></section>` : '';
}

function fillQA(data) {
  const passed = data.checks.filter(check => check.deviation_pct < 15).length;
  const issues = data.assumptions.map(assumption => {
    const member = data.members.find(item => item.mark === assumption.mark);
    const missing = member?.status === 'MISSING';
    return `<div class="issue-card ${missing ? 'missing' : ''}" data-mark="${esc(assumption.mark)}" tabindex="0" role="button"><span class="table-mark">${esc(assumption.mark)}</span><div><strong>${missing ? 'Missing dimension' : 'Estimated quantity'} · ${esc(member?.section ?? '')}</strong><p>${esc(assumption.text)}</p></div></div>`;
  }).join('');
  const checks = data.checks.map(check => `<tr><td><span class="table-mark">${esc(check.mark)}</span></td><td class="num">${fmt(check.modelled_mm, 0)} mm</td><td class="num">${fmt(check.schedule_mm, 0)} mm</td><td class="num">${fmt(check.deviation_pct, 1)}%</td><td><span class="${check.deviation_pct < 15 ? 'check-pass' : 'check-warn'}">${check.deviation_pct < 15 ? '✓ Within tolerance' : '⚠ Review deviation'}</span></td></tr>`).join('');
  $('#qa-content').innerHTML = `<div class="summary-strip"><div class="summary-box"><span>Open review items</span><strong>${data.assumptions.length}</strong></div><div class="summary-box"><span>Length checks passing</span><strong>${passed} / ${data.checks.length}</strong></div><div class="summary-box"><span>Source drawings</span><strong>${data.project.drawings.length}</strong></div></div><section class="qa-section"><h3>Assumptions &amp; missing information</h3><div class="issue-list">${issues}</div></section><section class="qa-section"><h3>Model ↔ schedule length cross-check</h3><table><thead><tr><th>Mark</th><th class="num">Modelled</th><th class="num">Scheduled</th><th class="num">Deviation</th><th>Result</th></tr></thead><tbody>${checks}</tbody></table></section>${connectionReport(data)}`;
  $$('#qa-content [data-joint]').forEach(row => row.onclick = () => focusConnection(row.dataset.joint));
  $$('#qa-content .issue-card').forEach(card => {
    card.onclick = () => selectMember(card.dataset.mark);
    card.onkeydown = event => { if (event.key === 'Enter') selectMember(card.dataset.mark); };
  });
}

// Offer terms under the cost build-up on the Quote page; wording comes from the
// job's "offer" block (job.json), basis lines from the open review items.
function offerTerms(data) {
  const offer = data.offer;
  if (!offer) return '';
  const project = data.project ?? {};
  const blank = (value, placeholder) => value ? esc(value) : `<span class="offer-fill">${placeholder}</span>`;
  const today = new Date();
  const valid = new Date(today.getTime() + (offer.validity_days ?? 30) * 864e5);
  const day = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const list = items => items?.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p>None.</p>';
  const from = offer.from ?? {}, to = offer.to ?? {};
  const members = data.members.map(m => `${esc(m.mark)} ${esc(m.section)} × ${m.qty} @ ${fmt(m.length_mm / 1000, 2)} m`).join(' · ');
  const provisional = (offer.provisional ?? []).map(p => `<tr><td>${esc(p.item)}</td><td class="num">${p.amount != null ? '£' + fmt(p.amount) : '<span class="offer-fill">to be priced</span>'}</td></tr>`).join('');
  // client wording by status; the engineering notes stay on the Quality review page
  const BASIS = { MEASURED: 'length scaled from the drawings, to be confirmed', ESTIMATED: 'estimated, to be confirmed', MISSING: 'size or dimension not stated on the drawings, priced provisionally' };
  const basis = data.assumptions.map(a => {
    const member = data.members.find(m => m.mark === a.mark);
    const plate = data.plates.find(p => p.mark === a.mark);
    const what = member ? `${member.section}, ${fmt(member.length_mm, 0)} mm` : plate ? `${plate.description} ${plate.size}` : '';
    const why = member ? BASIS[member.status] ?? 'to be confirmed' : 'not fully detailed, subject to connection design';
    return `<li><strong>${esc(a.mark)}</strong> ${esc(what)} — ${why}</li>`;
  }).join('');
  return `<div class="quote-terms" contenteditable="true" spellcheck="false">
    <div class="offer-parties"><div><span class="offer-label">From</span><strong>${blank(from.company, '[Your company]')}</strong><br>${blank(from.contact, '[Contact]')} · ${blank(from.phone, '[Phone]')} · ${blank(from.email, '[Email]')}</div>
      <div><span class="offer-label">To</span><strong>${blank(to.client, '[Client]')}</strong><br>${to.attn ? `FAO ${esc(to.attn)}` : '<span class="offer-fill">[FAO]</span>'}</div>
      <div><span class="offer-label">Quotation</span>Ref <strong>${esc(offer.reference ?? `${project.job ?? 'JOB'}-Q01`)}</strong><br>${day(today)} · valid until ${day(valid)}</div></div>
    <h3>Scope</h3>${list(offer.scope)}<p class="offer-small">${members}</p>
    <p class="offer-small">Drawings: ${(project.drawings ?? []).map(esc).join(' · ')}. ${esc(offer.vat_note ?? 'Prices exclude VAT.')}</p>
    ${provisional ? `<h3>Provisional items</h3><table><tbody>${provisional}</tbody></table>` : ''}
    <h3>Basis of quotation</h3><p>Quantities are taken from the drawings listed. The items below are subject to confirmation and the price will be adjusted to the approved shop drawings.</p><ul>${basis}</ul>
    <h3>Clarifications required</h3>${list(offer.rfis)}
    <h3>Exclusions</h3>${list(offer.exclusions)}
    <h3>Programme &amp; terms</h3><p>${esc(offer.programme ?? '')}</p><p>${esc(offer.terms ?? '')}</p>
    <div class="offer-sign"><div>For and on behalf of ${blank(from.company, '[Your company]')}<div class="offer-line"></div>Signed / date</div><div>Accepted by ${blank(to.client, '[Client]')}<div class="offer-line"></div>Signed / date</div></div>
  </div>`;
}

function bindUI() {
  const setNavCollapsed = collapsed => {
    document.body.classList.toggle('nav-collapsed', collapsed);
    $('#show-nav').hidden = !collapsed;
  };
  const bindCollapse = (buttonSelector, panelSelector) => {
    const button = $(buttonSelector);
    const panel = $(panelSelector);
    button.onclick = () => {
      const collapsed = panel.classList.toggle('collapsed');
      button.textContent = collapsed ? '+' : '−';
      button.setAttribute('aria-expanded', String(!collapsed));
    };
  };
  $('#collapse-nav').onclick = () => setNavCollapsed(true);
  $('#show-nav').onclick = () => setNavCollapsed(false);
  $('#collapse-utilities').onclick = () => setUtilitiesCollapsed(true);
  $('#show-utilities').onclick = () => setUtilitiesCollapsed(false);
  bindCollapse('#collapse-kpis', '#kpi-panel');
  bindCollapse('#collapse-inspector', '#inspector');
  bindCollapse('#collapse-viewer-tools', '#viewer-toolbar');
  bindCollapse('#collapse-camera', '#viewer-subbar');
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-collapse-window]');
    if (!button) return;
    const collapsed = button.closest('.page').classList.toggle('window-collapsed');
    button.textContent = collapsed ? '+' : '−';
    button.setAttribute('aria-expanded', String(!collapsed));
  });
  if (COMPACT.matches) setUtilitiesCollapsed(true);
  if (TOUCH) $('#viewport-help').innerHTML = viewportHelp(true);
  COMPACT.addEventListener('change', event => { if (event.matches) setUtilitiesCollapsed(true); resize(); });
  $$('.nav-item').forEach(button => button.onclick = () => showPage(button.dataset.page));
  $$('[data-go]').forEach(element => {
    element.addEventListener('click', () => showPage(element.dataset.go));
    if (element.getAttribute('role') === 'button') element.addEventListener('keydown', event => { if (event.key === 'Enter') showPage(element.dataset.go); });
  });
  $$('[data-view-mode]').forEach(button => button.onclick = () => setViewMode(button.dataset.viewMode));
  $$('[data-display]').forEach(button => button.onclick = () => {
    state.display = button.dataset.display;
    $$('[data-display]').forEach(item => item.classList.toggle('active', item === button));
    updateMaterials();
  });
  const layerGroups = { labels: gLabels, connections: gConnections, grid: gGrid, text: gText };
  $$('[data-layer]').forEach(button => button.onclick = () => {
    button.classList.toggle('active');
    layerGroups[button.dataset.layer].visible = button.classList.contains('active');
  });
  $$('[data-cam]').forEach(button => button.onclick = () => setCamera(button.dataset.cam));
  $('#fit-drawing').onclick = fitSheet;
  $('#sheet-select').onchange = event => showSheet(Number(event.target.value));
  $$('[data-sheet-step]').forEach(button => button.onclick = () => stepSheet(Number(button.dataset.sheetStep)));
  $('#member-search').addEventListener('input', renderMemberList);
  $$('[data-filter]').forEach(button => button.onclick = () => {
    state.filter = button.dataset.filter;
    $$('[data-filter]').forEach(item => item.classList.toggle('active', item === button));
    renderMemberList();
  });
  $('#export-data').onclick = () => {
    if (!state.data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.data.project?.job ?? 'job'}_takeoff_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  bindShortcuts();
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDown = null;
renderer.domElement.addEventListener('pointerdown', event => { pointerDown = [event.clientX, event.clientY]; });
renderer.domElement.addEventListener('pointerup', event => {
  if (state.mode !== 'model' || !pointerDown || Math.hypot(event.clientX - pointerDown[0], event.clientY - pointerDown[1]) > 5) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
  raycaster.setFromCamera(pointer, modelCamera);
  const hit = raycaster.intersectObjects(g3d.children, false)[0];
  selectMember(hit?.object.userData.mark ?? null);
  if (!hit && COMPACT.matches) setUtilitiesCollapsed(true);   // tap empty space closes the panel
});

// --- keyboard shortcuts -----------------------------------------------------------
// One keymap drives the handler and the F1 cheat sheet. Close to Tekla Structures
// where a command exists there (Ctrl+P 3D/plane, Home/End zoom original/previous,
// PgUp/PgDn zoom, Ctrl+arrows rotate, V rotation point, Ctrl+1..5 part and
// Shift+1..4 component representation, Esc interrupt, Ctrl+B reports, F1 help).
// "Mod" = Cmd on Mac, Ctrl on Windows. On Mac the Tekla Ctrl+digit keys stay on
// Control (Cmd+digit switches browser tabs) and rotate uses Option+arrows
// (Control+arrows switches desktops).
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent);
const lastPointer = { x: null, y: null };
renderer.domElement.addEventListener('pointermove', event => { lastPointer.x = event.clientX; lastPointer.y = event.clientY; });
controls.addEventListener('start', pushView);
[controls, sheetControls].forEach(item => item.addEventListener('start', () => $('#viewport-help').classList.add('done')));   // hint fades after first use
sheetControls.addEventListener('start', pushView);

function toast(text) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast floating';
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1400);
}

function activeView() {
  return state.mode === 'model'
    ? { camera: modelCamera, controls }
    : { camera: sheetCamera, controls: sheetControls };
}

function panView(dx, dy) {
  cameraAnimation = null;
  pushView();
  const { camera, controls: ctl } = activeView();
  const scale = state.mode === 'model'
    ? camera.position.distanceTo(ctl.target) * 0.08
    : (state.sheetViewHeight / camera.zoom) * 0.08;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(dx * scale);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * scale);
  camera.position.add(right).add(up);
  ctl.target.add(right).add(up);
  ctl.update();
}

function orbitView(azimuth, elevation) {
  if (state.mode !== 'model') return;
  cameraAnimation = null;
  pushView();
  const offset = modelCamera.position.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta += azimuth;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi - elevation, 0.05, Math.PI - 0.05);
  modelCamera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
  controls.update();
}

function zoomView(factor) {
  cameraAnimation = null;
  pushView();
  if (state.mode === 'model') {
    const offset = modelCamera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
    modelCamera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
  } else {
    sheetCamera.zoom = THREE.MathUtils.clamp(sheetCamera.zoom / factor, sheetControls.minZoom, sheetControls.maxZoom);
    sheetCamera.updateProjectionMatrix();
    sheetControls.update();
  }
}

function fitView() {
  if (state.mode === 'model') setCamera('fit'); else { pushView(); fitSheet(); }
}

function previousView() {
  const view = viewHistory.pop();
  if (!view) return toast('No previous view');
  cameraAnimation = null;
  if (view.mode !== state.mode) setViewMode(view.mode);
  const { camera, controls: ctl } = activeView();
  ctl.target.copy(view.target);
  camera.position.copy(view.position);
  if (view.zoom) { camera.zoom = view.zoom; camera.updateProjectionMatrix(); }
  ctl.update();
}

function setRotationPoint() {
  if (state.mode !== 'model') return;
  let point = null;
  if (lastPointer.x !== null) {
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set((lastPointer.x - bounds.left) / bounds.width * 2 - 1, -(lastPointer.y - bounds.top) / bounds.height * 2 + 1);
    raycaster.setFromCamera(pointer, modelCamera);
    point = raycaster.intersectObjects([...g3d.children, ...gConnections.children], true)[0]?.point ?? null;
  }
  if (!point && state.selected) {
    const box = new THREE.Box3();
    for (const mesh of meshesByMark.get(state.selected) ?? []) box.expandByObject(mesh);
    if (!box.isEmpty()) point = box.getCenter(new THREE.Vector3());
  }
  if (!point) return toast('Point at a member to set the rotation point');
  pushView();
  controls.target.copy(point);
  controls.update();
  toast('Rotation point set');
}

const RENDER_NAMES = { wireframe: 'Wireframe', shaded: 'Shaded wireframe', grayscale: 'Grayscale', rendered: 'Rendered' };
function setPartRender(mode) {
  state.partRender = mode;
  if (mode === 'grayscale' || mode === 'rendered') {
    state.display = mode === 'rendered' ? 'status' : 'material';
    $$('[data-display]').forEach(item => item.classList.toggle('active', item.dataset.display === state.display));
  }
  updateMaterials();
  toast(`Parts: ${RENDER_NAMES[mode]}`);
}

function setConnectionRender(mode) {
  for (const [material, colour] of [[PLATE_MATERIAL, '#63736f'], [BOLT_MATERIAL, '#35403c']]) {
    material.wireframe = mode === 'wireframe';
    material.transparent = mode === 'shaded';
    material.opacity = mode === 'shaded' ? 0.3 : 1;
    material.depthWrite = mode !== 'shaded';
    material.color.set(mode === 'grayscale' ? '#8d9692' : colour);
  }
  toast(`Connections: ${RENDER_NAMES[mode]}`);
}

function setIsolated(mark) {
  state.isolated = mark;
  updateMaterials();
  gLabels.children.forEach(label => { label.visible = !mark || label.userData.mark === mark; });
  gConnections.children.forEach(group => { group.visible = !mark || (group.userData.members ?? []).includes(mark); });
  toast(mark ? `Showing only ${mark}` : 'Showing all members');
}

function toggleLayer(name) {
  const button = $(`[data-layer="${name}"]`);
  if (!button) return;
  button.click();
  const layer = button.title.replace(/^Toggle /, '');
  toast(`${layer[0].toUpperCase()}${layer.slice(1)}: ${button.classList.contains('active') ? 'on' : 'off'}`);
}

function cycleMember(step) {
  const marks = [...new Set(state.data?.members.map(member => member.mark) ?? [])];
  if (!marks.length) return;
  const index = marks.indexOf(state.selected);
  selectMember(marks[(index + step + marks.length) % marks.length]);
}

function reviewItems() {
  const data = state.data;
  if (!data) return [];
  const members = data.assumptions.map(item => ({ kind: 'member', id: item.mark }));
  const joints = (data.connections?.joints ?? []).filter(joint => joint.auto && joint.warnings?.length).map(joint => ({ kind: 'joint', id: joint.id }));
  return [...members, ...joints];
}

function cycleReview(step) {
  const items = reviewItems();
  if (!items.length) return toast('No open review items');
  state.reviewIndex = ((state.reviewIndex ?? -1) + step + items.length) % items.length;
  const item = items[state.reviewIndex];
  if (item.kind === 'member') selectMember(item.id); else focusConnection(item.id);
  toast(`Review ${state.reviewIndex + 1}/${items.length}: ${item.id}`);
}

function focusSearch() {
  showPage('model');
  if (state.selected) selectMember(null, false);
  setUtilitiesCollapsed(false);
  $('#member-search').focus();
  $('#member-search').select();
}

function interrupt() {
  if (!$('#shortcut-help').hidden) return toggleHelp(false);
  if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return document.activeElement.blur();
  if (state.isolated) return setIsolated(null);
  if (state.selected) return selectMember(null, false);
  cameraAnimation = null;
}

function toggleCollapse(showId, collapseId) {
  ($(showId).hidden ? $(collapseId) : $(showId)).click();
}

const PAGES = ['model', 'schedule', 'procurement', 'quote', 'qa'];
const SHORTCUTS = [
  // group, keys (string, or {win, mac}), label, action, tekla?
  ['View', 'Mod+P', 'Switch 3D model / 2D drawing', () => { showPage('model'); setViewMode(state.mode === 'model' ? 'drawing' : 'model'); }, true],
  ['View', 'Home', 'Fit all (zoom original)', fitView, true],
  ['View', 'End', 'Previous view (zoom previous)', previousView, true],
  ['View', 'PageUp', 'Zoom in', () => zoomView(0.8), true],
  ['View', 'PageDown', 'Zoom out', () => zoomView(1.25), true],
  ['View', 'ArrowLeft', 'Pan left', () => panView(-1, 0)],
  ['View', 'ArrowRight', 'Pan right', () => panView(1, 0)],
  ['View', 'ArrowUp', 'Pan up', () => panView(0, 1)],
  ['View', 'ArrowDown', 'Pan down', () => panView(0, -1)],
  ['View', { win: 'Ctrl+ArrowLeft', mac: 'Alt+ArrowLeft' }, 'Rotate left', () => orbitView(-Math.PI / 12, 0), true],
  ['View', { win: 'Ctrl+ArrowRight', mac: 'Alt+ArrowRight' }, 'Rotate right', () => orbitView(Math.PI / 12, 0), true],
  ['View', { win: 'Ctrl+ArrowUp', mac: 'Alt+ArrowUp' }, 'Rotate up', () => orbitView(0, Math.PI / 18), true],
  ['View', { win: 'Ctrl+ArrowDown', mac: 'Alt+ArrowDown' }, 'Rotate down', () => orbitView(0, -Math.PI / 18), true],
  ['View', 'V', 'Set rotation point under the pointer', setRotationPoint, true],
  ['View', 'Shift+PageUp', 'Previous drawing sheet (2D)', () => stepSheet(-1)],
  ['View', 'Shift+PageDown', 'Next drawing sheet (2D)', () => stepSheet(1)],
  ['View', 'F', 'Fit selected member (or all)', () => (state.mode === 'model' && state.selected ? focusMember(state.selected) : fitView())],
  ['View', '1', 'Isometric view', () => setCamera('iso')],
  ['View', '2', 'Top view (plan)', () => setCamera('top')],
  ['View', '3', 'Front view', () => setCamera('front')],
  ['View', '4', 'Right view', () => setCamera('right')],
  ['Representation', 'Ctrl+1', 'Parts: wireframe', () => setPartRender('wireframe'), true],
  ['Representation', 'Ctrl+2', 'Parts: shaded wireframe', () => setPartRender('shaded'), true],
  ['Representation', 'Ctrl+3', 'Parts: grayscale (steel)', () => setPartRender('grayscale'), true],
  ['Representation', 'Ctrl+4', 'Parts: rendered (status colours)', () => setPartRender('rendered'), true],
  ['Representation', 'Ctrl+5', 'Show only selected (toggle)', () => setIsolated(state.isolated || !state.selected ? null : state.selected), true],
  ['Representation', 'Shift+1', 'Connections: wireframe', () => setConnectionRender('wireframe'), true],
  ['Representation', 'Shift+2', 'Connections: shaded wireframe', () => setConnectionRender('shaded'), true],
  ['Representation', 'Shift+3', 'Connections: grayscale', () => setConnectionRender('grayscale'), true],
  ['Representation', 'Shift+4', 'Connections: rendered', () => setConnectionRender('rendered'), true],
  ['Representation', 'L', 'Member labels on/off', () => toggleLayer('labels')],
  ['Representation', 'C', 'Connections on/off', () => toggleLayer('connections')],
  ['Representation', 'G', 'Ground grid on/off', () => toggleLayer('grid')],
  ['Representation', 'T', 'Drawing text on/off', () => toggleLayer('text')],
  ['Select', 'Escape', 'Interrupt: close, show all, clear selection', interrupt, true],
  ['Select', 'Tab', 'Next member', () => cycleMember(1)],
  ['Select', 'Shift+Tab', 'Previous member', () => cycleMember(-1)],
  ['Select', 'Enter', 'Zoom to selected member', () => state.selected && focusMember(state.selected)],
  ['Select', 'Shift+I', 'Inquire selected (member card)', () => state.selected ? selectMember(state.selected, false) : toast('Select a member first'), true],
  ['Select', 'N', 'Next review item', () => cycleReview(1)],
  ['Select', 'Shift+N', 'Previous review item', () => cycleReview(-1)],
  ['Select', 'Mod+F', 'Search members', focusSearch],
  ['Select', '/', 'Search members', focusSearch],
  ['Workspace', 'Alt+1', '3D workspace', () => showPage('model')],
  ['Workspace', 'Alt+2', 'Member schedule', () => showPage('schedule')],
  ['Workspace', 'Alt+3', 'Procurement', () => showPage('procurement')],
  ['Workspace', 'Alt+4', 'Quote & offer', () => showPage('quote')],
  ['Workspace', 'Alt+5', 'Quality review', () => showPage('qa')],
  ['Workspace', 'Mod+B', 'Member schedule (reports)', () => showPage('schedule'), true],
  ['Workspace', 'Mod+Shift+P', 'Print / save offer as PDF', () => { showPage('quote'); setTimeout(() => window.print(), 50); }],
  ['Workspace', 'Mod+S', 'Export takeoff data', () => $('#export-data').click(), true],
  ['Workspace', '[', 'Navigation panel on/off', () => toggleCollapse('#show-nav', '#collapse-nav')],
  ['Workspace', ']', 'Side panels on/off', () => toggleCollapse('#show-utilities', '#collapse-utilities')],
  ['Help', 'F1', 'Keyboard shortcuts', () => toggleHelp(), true],
  ['Help', '?', 'Keyboard shortcuts', () => toggleHelp()],
].map(([group, keys, label, run, tekla]) => {
  const spec = typeof keys === 'string' ? keys : IS_MAC ? keys.mac : keys.win;
  return { group, spec, label, run, tekla: !!tekla, ...parseSpec(spec) };
});

function parseSpec(spec) {
  const parts = spec === '+' ? ['+'] : spec.split('+');
  const key = parts.pop();
  const mods = new Set(parts);
  const mod = mods.has('Mod');
  return {
    key,
    meta: mod && IS_MAC, ctrl: (mod && !IS_MAC) || mods.has('Ctrl'),
    alt: mods.has('Alt'), shift: mods.has('Shift'),
  };
}

const KEY_CODES = { '[': 'BracketLeft', ']': 'BracketRight', '/': 'Slash' };
function matches(shortcut, event) {
  const { key } = shortcut;
  let hit;
  if (key === '?') return event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (/^[A-Z]$/.test(key)) hit = event.code === `Key${key}`;
  else if (/^\d$/.test(key)) hit = event.code === `Digit${key}`;
  else if (KEY_CODES[key]) hit = event.code === KEY_CODES[key];
  else hit = event.key === key;
  if (!hit || event.altKey !== shortcut.alt || event.shiftKey !== shortcut.shift) return false;
  if (IS_MAC && shortcut.meta)            // Tekla habit: Control works for Cmd commands on Mac too
    return (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey);
  return event.metaKey === shortcut.meta && event.ctrlKey === shortcut.ctrl;
}

const KEY_LABELS = IS_MAC
  ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'esc', Enter: '↩', Tab: '⇥', PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End' }
  : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', PageUp: 'PgUp', PageDown: 'PgDn' };
function keyLabel(spec) {
  const parts = spec.split('+').map(part => KEY_LABELS[part] ?? part);
  return parts.map(part => `<kbd>${esc(part)}</kbd>`).join(IS_MAC ? '' : '<span class="kbd-plus">+</span>');
}

function toggleHelp(open) {
  const help = $('#shortcut-help');
  const show = open ?? help.hidden;
  if (show && !help.dataset.built) {
    const groups = [...new Set(SHORTCUTS.map(item => item.group))];
    help.querySelector('.shortcut-groups').innerHTML = groups.map(group => `<section><h3>${group}</h3>${SHORTCUTS.filter(item => item.group === group).map(item => `<div class="shortcut-row"><span>${esc(item.label)}${item.tekla ? '<i class="tekla-tag" title="Same as Tekla Structures">Tekla</i>' : ''}</span><span class="shortcut-keys">${keyLabel(item.spec)}</span></div>`).join('')}</section>`).join('');
    help.querySelector('.shortcut-platform').textContent = IS_MAC
      ? 'Mac: ⌘ for app commands; Tekla Ctrl+digit keys use ⌃ Control; rotate with ⌥ + arrows.'
      : 'Windows: Ctrl for commands, as in Tekla Structures.';
    help.dataset.built = '1';
  }
  help.hidden = !show;
}

function bindShortcuts() {
  $('#show-shortcuts').onclick = () => toggleHelp();
  $('#shortcut-help').addEventListener('click', event => { if (event.target.id === 'shortcut-help' || event.target.closest('[data-close-help]')) toggleHelp(false); });
  addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target : document.body;
    const typing = target.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
    if (typing && event.key !== 'Escape') return;
    // keep normal keyboard navigation on focused buttons and links
    if (target.closest('button, a, select, [role="button"]') && ['Enter', ' ', 'Tab'].includes(event.key)) return;
    if (event.repeat && !/^Arrow|^Page/.test(event.key)) return;
    const shortcut = SHORTCUTS.find(item => matches(item, event));
    if (!shortcut) return;
    if (!$('#shortcut-help').hidden && shortcut.group !== 'Help' && shortcut.run !== interrupt) return;
    event.preventDefault();
    shortcut.run();
  });
}

async function loadAll() {
  try {
    const data = await fetchJSON(BASE + 'app_data.json');
    state.data = data;
    // a missing drawing only disables the 2D view, not the whole workspace
    state.dwg = data.project?.sheets
      ? { pages: data.project.sheets.map(() => null) }
      : await fetchJSON(BASE + (data.project?.drawing ?? 'roof_plan.dwg.json.gz')).catch(() => null);
    fillProject(data.project ?? {});
    state.sheetPage = Math.min(data.project?.drawing_page ?? 0, (state.dwg?.pages.length ?? 1) - 1);
    fillSheetPicker();
    buildModel(data);
    fillSummary(data);
    renderMemberList();
    fillSchedule(data);
    fillProcurement(data);
    fillQuote(data);
    fillQA(data);
    resize();
    setCamera('iso');
    $('#loading').hidden = true;
  } catch (error) {
    $('#loading').innerHTML = `<strong>Workspace could not load</strong><small>${esc(error.message)}</small>`;
  }
}

bindUI();
loadAll();
fetch('manifest.json').then(response => {
  if (response.ok) new EventSource('events').onmessage = () => location.reload();
}).catch(() => {});
function animate() {
  requestAnimationFrame(animate);
  if (cameraAnimation && state.mode === 'model') cameraAnimation();
  if (state.mode === 'model') {
    controls.update();
    renderer.render(modelScene, modelCamera);
  } else {
    sheetControls.update();
    renderer.render(sheetScene, sheetCamera);
  }
}
animate();
