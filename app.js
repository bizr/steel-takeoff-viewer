import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';

const STATUS_COLOR = { CONFIRMED: 0x3fb950, ESTIMATED: 0xd29922, MISSING: 0xf85149 };
const MARK_PALETTE = ['#5b9bd5','#3fb950','#d29922','#b678e0','#e06c75','#56b6c2','#c8a24a','#7f8ea3'];

const state = { data: null, dwg: null, selected: null, sheetSpan: 1600 };
const meshesByMark = new Map();

// ---------- scene ----------
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5e6);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(1.5, -1, 2.5);
scene.add(sun);

const g2d = new THREE.Group(), g3d = new THREE.Group(), gMark = new THREE.Group(),
      gText = new THREE.Group(), gGrid = new THREE.Group(), gConn = new THREE.Group();
scene.add(g2d, g3d, gMark, gText, gGrid, gConn);

const LAYERS = { sheet: [g2d], model: [g3d], marks: [gMark], text: [gText], grid: [gGrid], conn: [gConn] };
document.querySelectorAll('[data-layer]').forEach(btn => {
  btn.onclick = () => {
    btn.classList.toggle('active');
    for (const g of LAYERS[btn.dataset.layer]) g.visible = btn.classList.contains('active');
  };
});

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', resize);

// ---------- data ----------
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  if (url.endsWith('.gz')) {
    const ds = new DecompressionStream('gzip');
    return JSON.parse(await new Response(r.body.pipeThrough(ds)).text());
  }
  return r.json();
}

const col3 = (c, fb = 0x222222) => c ? new THREE.Color(c[0], c[1], c[2]) : new THREE.Color(fb);

function buildSheet(dwg) {
  g2d.clear(); gText.clear();
  const page = dwg.pages[0];
  const lines = [], lineCols = [], fills = [];
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  const track = (x, y) => { minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); };
  const push = (x0, y0, x1, y1, c) => { lines.push(x0, -y0, 0, x1, -y1, 0); lineCols.push(c.r, c.g, c.b, c.r, c.g, c.b); };
  for (const p of page.paths) {
    const sc = col3(p.stroke), fc = p.fill ? col3(p.fill, 0x000000) : null;
    const shapePts = [];
    for (const it of p.items) {
      if (it[0] === 'l') {
        if (p.op !== 'f') push(it[1][0], it[1][1], it[2][0], it[2][1], sc);
        shapePts.push(it[1], it[2]); track(...it[1]); track(...it[2]);
      } else if (it[0] === 'c') {
        let prev = it[1];
        for (let i = 1; i <= 12; i++) {
          const t = i / 12, mt = 1 - t;
          const x = mt**3*it[1][0] + 3*mt*mt*t*it[2][0] + 3*mt*t*t*it[3][0] + t**3*it[4][0];
          const y = mt**3*it[1][1] + 3*mt*mt*t*it[2][1] + 3*mt*t*t*it[3][1] + t**3*it[4][1];
          if (p.op !== 'f') push(prev[0], prev[1], x, y, sc);
          shapePts.push([x, y]); track(x, y); prev = [x, y];
        }
      } else if (it[0] === 're') {
        const [x0, y0, x1, y1] = it[1];
        if (p.op !== 'f') { push(x0,y0,x1,y0,sc); push(x1,y0,x1,y1,sc); push(x1,y1,x0,y1,sc); push(x0,y1,x0,y0,sc); }
        shapePts.push([x0,y0],[x1,y0],[x1,y1],[x0,y1]); track(x0,y0); track(x1,y1);
      } else if (it[0] === 'qu') {
        const q = it[1];
        for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i+1)%4]; if (p.op !== 'f') push(a[0],a[1],b[0],b[1],sc); shapePts.push(a); track(...a); }
      }
    }
    if (fc && p.op !== 's' && shapePts.length > 2)
      fills.push({ shape: new THREE.Shape(shapePts.map(pt => new THREE.Vector2(pt[0], -pt[1]))), color: fc });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(lineCols, 3));
  g2d.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true })));
  for (const f of fills.slice(0, 8000)) {
    const m = new THREE.Mesh(new THREE.ShapeGeometry(f.shape),
      new THREE.MeshBasicMaterial({ color: f.color, side: THREE.DoubleSide }));
    m.position.z = -0.1; g2d.add(m);
  }
  const cx = (minx + maxx) / 2, cy = -(miny + maxy) / 2;
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(maxx - minx + 60, maxy - miny + 60),
    new THREE.MeshBasicMaterial({ color: 0xf5f2ea }));
  paper.position.set(cx, cy, -1);
  g2d.add(paper);
  g2d.position.set(-cx, -cy, 0);
  state.sheetCenter = { x: cx, y: -cy };  // pt-space centre (y down)
  state.sheetSpan = Math.max(maxx - minx, maxy - miny);

  for (const s of page.text.slice(0, 3000)) {
    const c = document.createElement('canvas');
    const fs = 48; c.width = Math.max(2, s.t.length * fs * 0.62); c.height = fs * 1.4;
    const ctx = c.getContext('2d');
    ctx.font = `${fs}px ${s.font || 'Arial'}`; ctx.fillStyle = '#222';
    ctx.fillText(s.t, 0, fs);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
    const h = s.size * 1.4;
    sp.scale.set(h * c.width / c.height, h, 1);
    sp.center.set(0, 0.5);
    sp.position.set(s.o[0], -s.o[1], 0.5);
    if (s.dir && Math.abs(s.dir[1]) > 0.5) sp.material.rotation = s.dir[1] > 0 ? Math.PI / 2 : -Math.PI / 2;
    gText.add(sp);
  }
  gText.position.copy(g2d.position);
}

// ---------- real section geometry ----------
// Local frame: x = flange width, y = section depth, z = member axis (0..len).
function iSectionGeo(sec, len, sc) {
  const b = sec.b * sc, h = sec.h * sc, tw = Math.max(sec.tw * sc, 0.4), tf = sec.tf * sc;
  const pts = [
    [-b/2,-h/2],[b/2,-h/2],[b/2,-h/2+tf],[tw/2,-h/2+tf],[tw/2,h/2-tf],[b/2,h/2-tf],
    [b/2,h/2],[-b/2,h/2],[-b/2,h/2-tf],[-tw/2,h/2-tf],[-tw/2,-h/2+tf],[-b/2,-h/2+tf],
  ].map(p => new THREE.Vector2(p[0], p[1]));
  const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: len, bevelEnabled: false });
  return geo;
}

function memberGeo(m, len, sc, sections) {
  const sec = sections?.[m.section];
  if (sec?.shape === 'I') return { geo: iSectionGeo(sec, len, sc), depth: sec.h * sc };
  const h = (sec?.h ?? m.depth_mm) * sc, w = (sec?.b ?? m.width_mm) * sc;
  const geo = new THREE.BoxGeometry(w, h, len);
  geo.translate(0, 0, len / 2);  // match extrusion: axis 0..len
  return { geo, depth: h };
}

// orient local (x=flange, y=depth, z=axis) onto segment dir with depth vertical
function memberQuat(dir) {
  const up = Math.abs(dir.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const yAxis = up.clone().sub(dir.clone().multiplyScalar(up.dot(dir))).normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, dir);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, dir));
}

// ---------- connections ----------
const PLATE_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa7b2, metalness: 0.55, roughness: 0.35 });
const BOLT_MAT = new THREE.MeshStandardMaterial({ color: 0x3d434b, metalness: 0.6, roughness: 0.4 });
const BOLT_VIS = 2;  // bolts drawn 2x so they read at plan zoom

function boltMesh(dia, len, sc, hexHead = true) {
  const g = new THREE.Group();
  const r = dia / 2 * BOLT_VIS * sc;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len * sc, 10), BOLT_MAT);
  g.add(shaft);
  if (hexHead) {
    const head = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.8, r * 1.8, dia * 0.7 * BOLT_VIS * sc, 6), BOLT_MAT);
    head.position.y = len * sc / 2 + dia * 0.35 * BOLT_VIS * sc;
    g.add(head);
  }
  return g;
}

function plateMesh(w, d, t, sc) {
  return new THREE.Mesh(new THREE.BoxGeometry(w * sc, d * sc, t * sc), PLATE_MAT);
}

function buildConnections(data, tf, sc) {
  gConn.clear();
  const conn = data.connections;
  if (!conn) return;
  const dirTf = (v) => {   // model-space direction -> viewer direction (linear part of tf)
    const o = tf(0, 0, 0), p = tf(v[0], v[1], v[2]);
    return new THREE.Vector3(p[0] - o[0], p[1] - o[1], p[2] - o[2]).normalize();
  };
  for (const j of conn.joints) {
    const T = conn.types[j.type];
    const [w, d, t] = T.plate;
    const P = tf(...j.pos_mm);
    const grp = new THREE.Group();
    grp.position.set(P[0], P[1], P[2]);
    if (T.kind === 'baseplate') {
      const plate = plateMesh(w, d, t, sc);
      plate.position.z = -t * sc / 2;
      grp.add(plate);
      for (const gx of [-1, 1]) for (const gy of [-1, 1]) {
        const b = boltMesh(T.bolts.dia, T.bolts.projection_mm + t, sc);
        b.position.set(gx * T.bolts.gauge[0] * sc, gy * T.bolts.gauge[1] * sc,
                       (T.bolts.projection_mm - t) * sc / 2);
        grp.add(b);
      }
    } else if (T.kind === 'cap_plate') {
      const plate = plateMesh(w, d, t, sc);
      plate.position.z = -t * sc / 2;
      grp.add(plate);
      for (const gx of [-1, 1]) for (const gy of [-1, 1]) {
        const b = boltMesh(T.bolts.dia, T.bolts.length_mm, sc);
        b.position.set(gx * T.bolts.gauge[0] * sc, gy * T.bolts.gauge[1] * sc, 0);
        grp.add(b);
      }
    } else if (T.kind === 'end_plate') {
      // vertical plate, face normal = joint normal (model space), centred at beam half-depth
      const n = dirTf(j.normal ?? [0, -1, 0]);
      const beamH = 157.6 * sc;  // B3 depth
      const plate = plateMesh(d, t, w, sc);   // width across, thickness through, height vertical
      plate.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      plate.position.copy(n).multiplyScalar(t * sc / 2);
      plate.position.z += beamH / 2;
      grp.add(plate);
      for (const gx of [-1, 1]) for (const gz of [-1, 1]) {
        const b = boltMesh(T.bolts.dia, T.bolts.length_mm, sc);
        b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        const off = new THREE.Vector3()
          .addScaledVector(new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 0, 1)).normalize(), gx * T.bolts.gauge[0] * sc)
          .addScaledVector(new THREE.Vector3(0, 0, 1), gz * T.bolts.gauge[1] * sc + beamH / 2);
        b.position.copy(off);
        grp.add(b);
      }
    }
    gConn.add(grp);
  }
}

function buildModel(data) {
  g3d.clear(); gMark.clear(); gGrid.clear(); gConn.clear(); meshesByMark.clear();
  const reg = data.registration, sc = reg ? reg.scale_pt_per_mm : 1;
  const cc = state.sheetCenter || { x: 0, y: 0 };
  // model mm -> viewer coords (aligned with the 2D sheet when registration exists)
  const tf = reg ? (mx, my, mz) => [
      (mx * reg.M[0][0] + my * reg.M[1][0] + reg.M[2][0]) - cc.x,
      -(mx * reg.M[0][1] + my * reg.M[1][1] + reg.M[2][1] - cc.y),
      mz * sc,
    ] : (mx, my, mz) => [mx, -my, mz];
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  for (const m of data.model.members) {
    const mat = new THREE.MeshStandardMaterial({
      color: STATUS_COLOR[m.status] ?? 0x8fb8ff, metalness: 0.35, roughness: 0.5 });
    for (const s of m.segments) {
      const a = new THREE.Vector3(...tf(s.from[0], s.from[1], s.from[2]));
      const b = new THREE.Vector3(...tf(s.to[0], s.to[1], s.to[2]));
      const dir = b.clone().sub(a), len = dir.length();
      dir.normalize();
      const { geo, depth } = memberGeo(m, len, sc, data.sections);
      const box = new THREE.Mesh(geo, mat);
      const vertical = Math.abs(dir.z) > 0.9;
      const lift = vertical ? 0 : depth / 2;   // horizontal beams rest on their bottom flange
      box.position.copy(a); box.position.z += lift;
      box.quaternion.copy(memberQuat(dir));
      box.userData.mark = m.mark;
      g3d.add(box);
      if (!meshesByMark.has(m.mark)) meshesByMark.set(m.mark, []);
      meshesByMark.get(m.mark).push(box);
      const mid = a.clone().add(b).multiplyScalar(0.5); mid.z += lift;
      const ring = new THREE.Mesh(new THREE.RingGeometry(220 * sc, 300 * sc, 32), ringMat);
      ring.position.copy(mid); ring.position.z += depth;
      gMark.add(ring);
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
      const ctx = cv.getContext('2d'); ctx.font = '600 52px system-ui'; ctx.fillStyle = '#fff';
      ctx.fillText(m.mark, 10, 46);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
      sp.scale.set(900 * sc, 450 * sc, 1);
      sp.position.copy(mid); sp.position.z += 700 * sc;
      gMark.add(sp);
    }
  }
  const g = data.grids, pts = [], cols = [], gc = new THREE.Color(0x2a333f);
  for (const x of Object.values(g.x_grids)) { const p0 = tf(x, 0, 0), p1 = tf(x, 22000, 0); pts.push(...p0, ...p1); cols.push(gc, gc); }
  for (const y of Object.values(g.y_grids)) { const p0 = tf(0, y, 0), p1 = tf(22000, y, 0); pts.push(...p0, ...p1); cols.push(gc, gc); }
  const flat = []; for (const c of cols) flat.push(c.r, c.g, c.b);
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  gg.setAttribute('color', new THREE.Float32BufferAttribute(flat, 3));
  gGrid.add(new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ vertexColors: true })));
  if (reg) gGrid.position.z = 1;
  buildConnections(data, tf, sc);

  if (!reg) {
    const span = state.sheetSpan;
    const box3 = new THREE.Box3().setFromObject(g3d);
    const c3 = box3.getCenter(new THREE.Vector3());
    const size3 = box3.getSize(new THREE.Vector3());
    const k = span * 0.55 / Math.max(size3.x, size3.y, 1);
    for (const grp of [g3d, gMark, gGrid, gConn]) {
      grp.scale.setScalar(k);
      grp.position.set(span * 0.62 - c3.x * k, -c3.y * k, -c3.z * k);
    }
  }
  const mb = new THREE.Box3().setFromObject(g3d);
  state.modelCenter = mb.getCenter(new THREE.Vector3());
  const ms = mb.getSize(new THREE.Vector3());
  state.modelSpan = Math.max(ms.x, ms.y, 1);
}

// ---------- selection ----------
const memberCard = document.getElementById('member-card');

function fillMemberCard(mark) {
  if (!mark || !state.data) { memberCard.classList.add('hidden'); return; }
  const d = state.data;
  const rows = d.members.filter(m => m.mark === mark);
  if (!rows.length) { memberCard.classList.add('hidden'); return; }
  const m = rows[0];
  const mass = rows.reduce((s, r) => s + r.mass_kg, 0);
  const sec = d.sections?.[m.section];
  const secRows = sec ? [
    ['Depth h', sec.h + ' mm'], ['Flange width b', sec.b + ' mm'],
    ...(sec.shape === 'I' ? [['Web tw', sec.tw + ' mm'], ['Flange tf', sec.tf + ' mm'], ['Root radius r', sec.r + ' mm']]
                         : [['Wall t', sec.t + ' mm']]),
    ['Mass', sec.kg_m + ' kg/m'], ['Area', sec.A_cm2 + ' cm²'],
    ...(sec.Ix_cm4 ? [['Ixx', sec.Ix_cm4.toLocaleString() + ' cm⁴'], ['Iyy', sec.Iy_cm4.toLocaleString() + ' cm⁴']] : []),
  ] : [];
  const conns = (d.connections?.joints ?? []).filter(j => j.members.includes(mark));
  const connHtml = conns.map(j => {
    const T = d.connections.types[j.type];
    return `<div class="mc-conn"><span class="mark-chip">${j.type}</span> ${esc(T.desc)}<br>
      <span style="color:var(--text-dim)">${T.plate.join('×')} mm plate · ${T.bolts.n}No ${esc(T.bolts.spec)} · ${j.id.replace('J-', '')} · ${esc(j.note)}</span></div>`;
  }).join('');
  const assum = (d.assumptions ?? []).filter(a => a.mark === mark);
  memberCard.innerHTML = `
    <div class="mc-head"><span class="mark-chip">${mark}</span><span class="mc-sec">${esc(m.section)}</span>
      <span class="pill pill-${m.status}">${m.status}</span>
      <button class="mc-close" title="close">×</button></div>
    <div class="mc-grid">
      <span class="k">Quantity</span><span class="v">${m.qty}</span>
      <span class="k">Length each</span><span class="v">${fmt(m.length_mm)} mm</span>
      <span class="k">Total mass</span><span class="v">${fmt(mass)} kg</span>
    </div>
    <div class="mc-loc">${esc(m.location)}<br>Source: ${esc(m.source)}</div>
    ${secRows.length ? `<h5>Section properties (BS 4-1 / EN 10365)</h5>
    <div class="mc-grid">${secRows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div>` : ''}
    ${conns.length ? `<h5>Connections</h5>${connHtml}` : ''}
    ${assum.map(a => `<div class="mc-note">⚠ ${esc(a.text)}</div>`).join('')}`;
  memberCard.classList.remove('hidden');
  memberCard.querySelector('.mc-close').onclick = () => select(null);
}

function select(mark) {
  state.selected = mark;
  for (const [mk, meshes] of meshesByMark)
    for (const mesh of meshes) mesh.material.emissive = new THREE.Color(mk === mark ? 0x333a45 : 0x000000);
  document.querySelectorAll('tr.rowmark').forEach(r => {
    r.classList.toggle('selected', r.dataset.mark === mark);
    if (r.dataset.mark === mark) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  const info = document.getElementById('sel-info');
  if (mark && state.data) {
    const rows = state.data.members.filter(m => m.mark === mark);
    const mass = rows.reduce((s, m) => s + m.mass_kg, 0);
    info.textContent = `${mark} · ${rows[0].section} · ${mass.toLocaleString()} kg`;
    const bbox = new THREE.Box3();
    for (const mesh of meshesByMark.get(mark) ?? []) bbox.expandByObject(mesh);
    if (!bbox.isEmpty()) {
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      flyTo(center, Math.max(size.x, size.y, size.z) * 1.7 + 100);
    }
  } else info.textContent = 'click a member or table row';
  fillMemberCard(mark);
}

let camAnim = null;
function flyTo(target, dist) {
  const t0 = performance.now(), dur = 700;
  const fromT = controls.target.clone(), fromP = camera.position.clone();
  const cur = fromP.clone().sub(fromT);
  // keep current azimuth but approach at ~35 deg elevation so 3D detail reads
  const az = Math.atan2(cur.y, cur.x);
  const dir = new THREE.Vector3(Math.cos(az) * Math.cos(0.61), Math.sin(az) * Math.cos(0.61), Math.sin(0.61));
  const toP = target.clone().add(dir.multiplyScalar(dist));
  camAnim = () => {
    const t = Math.min((performance.now() - t0) / dur, 1), e = 1 - (1 - t) ** 3;
    controls.target.lerpVectors(fromT, target, e);
    camera.position.lerpVectors(fromP, toP, e);
    if (t >= 1) camAnim = null;
  };
}

const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => downAt = [e.clientX, e.clientY]);
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(g3d.children, false)[0];
  select(hit ? hit.object.userData.mark : null);
});

// ---------- camera presets ----------
const camViews = {
  iso:   { pos: [0.45, -1.0, 0.75], tgt: [0, 0, 0] },
  top:   { pos: [0, 0, 1.45],       tgt: [0, 0, 0] },
  front: { pos: [0, -1.7, 0.25],    tgt: [0, 0, 0] },
};
function setCam(name) {
  camAnim = null;
  const v = camViews[name];
  const fit = state.data?.registration ? state.modelSpan : state.sheetSpan;
  const c = state.data?.registration && state.modelCenter ? state.modelCenter : new THREE.Vector3();
  camera.position.set(c.x + v.pos[0] * fit, c.y + v.pos[1] * fit, c.z + v.pos[2] * fit);
  controls.target.set(c.x + v.tgt[0] * fit, c.y + v.tgt[1] * fit, c.z + v.tgt[2] * fit);
  controls.update();
}
document.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => setCam(b.dataset.cam));
addEventListener('keydown', e => { if (e.key === 'Escape') select(null); });

// ---------- UI panels ----------
const fmt = n => n.toLocaleString('en-GB', { maximumFractionDigits: 2 });
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function fillKPIs(d) {
  document.getElementById('project-sub').textContent =
    `${d.project.name} · Job ${d.project.job} · ${d.project.package}`;
  document.getElementById('chip-drawings').textContent = d.project.drawings.join('  ·  ');
  document.getElementById('kpi-net').textContent = fmt(d.summary.net_t);
  document.getElementById('kpi-order').textContent = fmt(d.summary.order_t) + ' t';
  document.getElementById('kpi-quote').textContent = '£' + fmt(d.summary.quote_total);
  document.getElementById('kpi-marks').textContent = d.summary.n_marks;
  document.getElementById('kpi-verify').textContent = d.summary.n_to_verify;
  document.getElementById('foot-src').textContent = 'Sources: ' + d.project.drawings.join(' · ');
  document.getElementById('foot-gen').textContent = 'Generated ' + d.generated.slice(0, 16).replace('T', ' ') + ' UTC';
}

function fillSchedule(d) {
  const rows = d.members.map(m => `
    <tr class="rowmark" data-mark="${m.mark}">
      <td><span class="mark-chip">${m.mark}</span></td>
      <td class="mono">${esc(m.section)}</td>
      <td class="num">${m.qty}</td>
      <td class="num">${fmt(m.length_mm)}</td>
      <td class="num">${fmt(m.mass_kg)}</td>
      <td><span class="pill pill-${m.status}">${m.status}</span></td>
    </tr>`).join('');
  const plates = d.plates.map(p => `
    <tr><td><span class="mark-chip">${p.mark}</span></td>
      <td>${esc(p.description)} <span class="mono" style="color:var(--text-dim)">${p.size}</span></td>
      <td class="num">${p.qty}</td><td class="num">—</td><td class="num">${fmt(p.mass_kg)}</td><td></td></tr>`).join('');
  document.getElementById('tab-schedule').innerHTML = `
    <table><thead><tr><th>Mark</th><th>Section / item</th><th class="num">Qty</th>
    <th class="num">Len (mm)</th><th class="num">Mass (kg)</th><th>Status</th></tr></thead>
    <tbody>${rows}${plates}</tbody></table>`;
  document.querySelectorAll('tr.rowmark').forEach(r => r.onclick = () => select(r.dataset.mark));
}

function fillQuote(d) {
  const items = d.quote.items.map(i => `
    <tr><td>${esc(i.item)}</td><td class="num">${i.qty} ${i.unit}</td>
    <td class="num">${fmt(i.rate)}</td><td class="num">${fmt(i.total)}</td></tr>`).join('');
  document.getElementById('tab-quote').innerHTML = `
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Total</th></tr></thead>
    <tbody>${items}
    <tr><td>Subtotal</td><td></td><td></td><td class="num">${fmt(d.quote.subtotal)}</td></tr>
    <tr><td>Overheads &amp; profit ${d.quote.overhead_profit_pct}%</td><td></td><td></td>
        <td class="num">${fmt(d.quote.overhead_profit)}</td></tr>
    <tr class="qtotal"><td>Total</td><td></td><td></td>
        <td class="num">£${fmt(d.quote.total)}</td></tr></tbody></table>
    <div class="mh-cards">
      <div class="mh-card"><div class="v">${d.manhours.fabrication_hours}</div><div class="l">fabrication hours</div></div>
      <div class="mh-card"><div class="v">${d.manhours.erection_hours}</div><div class="l">erection hours</div></div>
      <div class="mh-card"><div class="v">${d.quote.procurement.order_t.toFixed(2)}t</div><div class="l">to procure (incl. ${d.quote.procurement.waste_pct}% waste)</div></div>
    </div>
    <p class="qa-note">Illustrative UK fabricator rates — substitute live rates before issuing.</p>`;
}

function fillProcurement(d) {
  const marks = [...new Set(d.members.map(m => m.mark))];
  const colour = mk => MARK_PALETTE[marks.indexOf(mk) % MARK_PALETTE.length];
  const bars = d.cut_list.map(bar => {
    const segs = bar.pieces.map(p =>
      `<div class="bar-seg" style="width:${p.length_mm / bar.stock_mm * 100}%;background:${colour(p.mark)}"
        title="${p.mark} · ${p.length_mm}mm">${p.mark}</div>`).join('');
    const off = bar.offcut_mm > 0
      ? `<div class="bar-offcut" style="width:${bar.offcut_mm / bar.stock_mm * 100}%"></div>` : '';
    return `<div class="bar-row">
      <div class="bar-head">Bar ${bar.bar} · ${esc(bar.section)} · 12.0 m stock · offcut ${fmt(bar.offcut_mm)} mm</div>
      <div class="bar-track">${segs}${off}</div></div>`;
  }).join('');
  const fasteners = d.fasteners.map(f =>
    `<tr><td>${esc(f.description)}</td><td class="num">${f.qty}</td></tr>`).join('');
  document.getElementById('tab-procurement').innerHTML = `
    <p class="qa-note">Cutting list — first-fit into ${d.cut_list[0]?.stock_mm / 1000 ?? 12} m stock bars.</p>
    ${bars}
    <h4 style="margin:18px 0 6px">Fasteners</h4>
    <table><tbody>${fasteners}</tbody></table>`;
}

function fillQA(d) {
  const items = d.assumptions.map(a => `
    <div class="qa-item"><span class="mark-chip qa-mark">${a.mark}</span><span>${esc(a.text)}</span></div>`).join('');
  const checks = d.checks.map(c =>
    `<div class="check-ok">${c.deviation_pct < 15 ? '✓' : '⚠'} ${c.mark}: modelled ${fmt(c.modelled_mm)} mm vs schedule ${fmt(c.schedule_mm)} mm (${c.deviation_pct}%)</div>`).join('');
  document.getElementById('tab-qa').innerHTML = `
    <h4 style="margin:2px 0 8px">Assumptions &amp; missing information</h4>
    ${items}
    <h4 style="margin:16px 0 6px">Model ↔ schedule length cross-check</h4>
    ${checks}`;
}

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.tabpage').forEach(p =>
    p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
});

// ---------- boot ----------
async function loadAll() {
  try {
    if (!state.dwg) state.dwg = await fetchJSON('data/output/roof_plan.dwg.json.gz');
    state.data = await fetchJSON('data/output/app_data.json');
    buildSheet(state.dwg);
    buildModel(state.data);
    fillKPIs(state.data); fillSchedule(state.data); fillQuote(state.data);
    fillProcurement(state.data); fillQA(state.data);
    resize(); setCam('iso');
  } catch (e) {
    document.getElementById('sel-info').textContent = 'load failed: ' + e.message;
  }
}
try { new EventSource('events').onmessage = () => loadAll(); } catch {}
loadAll();
(function anim() { requestAnimationFrame(anim); if (camAnim) camAnim(); renderer.render(scene, camera); })();
