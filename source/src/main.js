import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------- params
const Q = new URLSearchParams(location.search);
// phones / tablets: lighter rendering so the city stays playable
const MOBILE = !!Q.get('touch') || matchMedia('(pointer:coarse)').matches;
const SHOT = Q.get('shot');            // headless screenshot preset
const statusEl = document.getElementById('status');
const say = (t) => { if (statusEl) statusEl.textContent = t; };

// deterministic RNG
let seed = 1337;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const rr = (a, b) => a + (b - a) * rnd();
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: !MOBILE, preserveDrawingBuffer: !!SHOT, powerPreference: 'high-performance' });
renderer.setPixelRatio(SHOT ? 1 : Math.min(devicePixelRatio, MOBILE ? 1.25 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = MOBILE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(MOBILE ? 50 : 40, innerWidth / innerHeight, 0.5, MOBILE ? 900 : 3000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 6;
controls.maxDistance = 1100;

const hemi = new THREE.HemisphereLight(0xdfefff, 0x9a8f7a, 1.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 4096, MOBILE ? 1024 : 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
const SUN_DIR = new THREE.Vector3(-0.55, 1, 0.35).normalize();
scene.add(sun, sun.target);

// ---------------------------------------------------------------- loading
const BASE = Q.get('base') || './';
const texLoader = new THREE.TextureLoader();
function loadTexBlob(url, onLoad, flip = false) { const t = new THREE.Texture(); fetch(url).then(r => r.blob()).then(b => createImageBitmap(b, flip ? { imageOrientation: 'flipY' } : {})).then(img => { t.image = img; t.needsUpdate = true; onLoad && onLoad(t); }); return t; }
const texCache = {};
function getTex(name) {
  if (!name) return null;
  if (!texCache[name]) {
    const t = loadTexBlob(BASE + 'tex/' + name + (name === 'x_car3' ? '.jpg' : '.png'), null, name.startsWith('fbx_') || name.startsWith('cc_') || name.startsWith('x_'));
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.anisotropy = 8;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    texCache[name] = t;
  }
  return texCache[name];
}
const matCache = {};
function sharedMat(m) {
  const tex = m.userData && m.userData.tex;
  const key = m.name + '|' + (tex || '') + '|' + m.color.getHexString() + '|' + (m.transparent ? 1 : 0);
  if (!matCache[key]) {
    const nm = new THREE.MeshStandardMaterial({
      name: m.name, color: m.color, map: getTex(tex),
      roughness: Math.max(0.55, m.roughness), metalness: Math.min(0.35, m.metalness),
      transparent: m.transparent, opacity: m.opacity, side: THREE.FrontSide,
      alphaTest: m.alphaTest, envMapIntensity: 0.55,
    });
    if (/window|glass/i.test(m.name)) { nm.roughness = 0.25; nm.metalness = 0.3; nm.envMapIntensity = 1.0; }
    if (m.name === 'Windows' && tex === 'windows') patchWindows(nm);
    matCache[key] = nm;
  }
  return matCache[key];
}

const proto = {};
const FIXED = [];       // name -> {parts:[{geo,mat,mtx}], bb:Box3}
const skinned = {};     // name -> gltf scene
let clips = {};
let INDEX;
// merge all parts of a model that share a material into one geometry (fewer draw calls)
const WHEEL_RE = /^(RL|FL|RR|FR)([._]\d+)?$|^(back|front)(Left|Right)|^B?whe?e?l|^W_[bf][LR]|tire|tyre|roue/i;
const isWheel = (o) => WHEEL_RE.test(o.name || '') || (o.parent && WHEEL_RE.test(o.parent.name || ''));
function mergeParts(parts) {
  const wheels = parts.filter(p => p.wheel); parts = parts.filter(p => !p.wheel);
  const byMat = new Map();
  for (const p of parts) { if (!byMat.has(p.mat)) byMat.set(p.mat, []); byMat.get(p.mat).push(p); }
  const out = [];
  for (const [mat, list] of byMat) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const geos = list.map(p => {
      let g = p.geo.clone();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      if (!g.index) { const n = g.attributes.position.count, idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
      g.morphAttributes = {};
      g.applyMatrix4(p.mtx);
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (merged) out.push({ geo: merged, mat, mtx: new THREE.Matrix4() });
    else out.push(...list);
  }
  for (const w of wheels) out.push(w);
  return out;
}
// ---- extra vehicles supplied as FBX (same City Atlas / Windows textures as the pack)
let FBX_VEH = {};
async function loadFBXVehicles() {
  try { FBX_VEH = await (await fetch(BASE + 'veh/list.json')).json(); } catch (e) { return; }
  const mgr = new THREE.LoadingManager();
  mgr.setURLModifier(u => /\.(png|jpg|tga)$/i.test(u) ? 'data:,' : u); // textures assigned below by name
  const L = new FBXLoader(mgr);
  await Promise.all(Object.entries(FBX_VEH).map(async ([name, len]) => {
    let o;
    try { o = await L.loadAsync(BASE + 'veh/' + name + '.fbx'); } catch (e) { console.warn('fbx', name, e); return; }
    o.traverse(m => {
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const out = mats.map(mt => {
        const isWin = /window/i.test(mt.name) || (mt.map && /window/i.test(mt.map.name || ''));
        const fake = new THREE.MeshStandardMaterial({ name: isWin ? 'Windows' : 'City_Atlas', color: 0xffffff, roughness: isWin ? 0.3 : 1, metalness: isWin ? 0.6 : 0 });
        fake.userData = { tex: isWin ? 'fbx_windows' : 'fbx_atlas' };
        return sharedMat(fake);
      });
      m.material = Array.isArray(m.material) ? out : out[0];
    });
    // normalise: upright, length along Z, real size, origin 0.24 m above the wheels
    o.updateMatrixWorld(true);
    let bb = new THREE.Box3().setFromObject(o), sz = bb.getSize(new THREE.Vector3());
    const root = new THREE.Group(); root.add(o);
    if (sz.y > sz.z * 1.2 && sz.y > sz.x * 1.2) { o.rotation.x = -Math.PI / 2; }      // Z-up export
    root.updateMatrixWorld(true); bb = new THREE.Box3().setFromObject(root); sz = bb.getSize(new THREE.Vector3());
    if (sz.x > sz.z) { root.rotation.y = Math.PI / 2; }                               // length onto Z
    const wrap = new THREE.Group(); wrap.add(root); wrap.updateMatrixWorld(true);
    bb = new THREE.Box3().setFromObject(wrap); sz = bb.getSize(new THREE.Vector3());
    const k = len / Math.max(sz.x, sz.z); wrap.scale.setScalar(k); wrap.updateMatrixWorld(true);
    bb = new THREE.Box3().setFromObject(wrap); const c = bb.getCenter(new THREE.Vector3());
    wrap.position.set(-c.x, -bb.min.y - 0.24, -c.z); if (true) { wrap.rotation.y = Math.PI; wrap.position.x *= -1; wrap.position.z *= -1; }
    wrap.updateMatrixWorld(true);
    const parts = [];
    wrap.traverse(m => {
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.length === 1 || !m.geometry.groups.length) parts.push({ geo: m.geometry, mat: mats[0], mtx: m.matrixWorld.clone(), wheel: isWheel(m) });
      else for (const g of m.geometry.groups) {
        const geo = m.geometry.clone(); geo.clearGroups();
        if (geo.index) geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(g.start, g.start + g.count), 1));
        else { for (const key in geo.attributes) { const at = geo.attributes[key]; geo.setAttribute(key, new THREE.BufferAttribute(at.array.slice(g.start * at.itemSize, (g.start + g.count) * at.itemSize), at.itemSize)); } }
        parts.push({ geo, mat: mats[g.materialIndex], mtx: m.matrixWorld.clone(), wheel: isWheel(m) });
      }
    });
    proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(wrap), fbx: true };
  }));
}
const FBX_FLIP = {};
// ---- extra packs: Cartoon Buildings (garage, gas station, shop), Car V3.1, Carss (20 vehicles in one file)
function fbxToParts(root, tex) {
  root.traverse(m => { if (!m.isMesh) return; const ms = Array.isArray(m.material) ? m.material : [m.material];
    const out = ms.map(() => { const f = new THREE.MeshStandardMaterial({ name: 'X_' + tex, color: 0xffffff, roughness: 0.8 }); f.userData = { tex }; return sharedMat(f); });
    m.material = Array.isArray(m.material) ? out : out[0]; });
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse(m => { if (!m.isMesh) return; const ms = Array.isArray(m.material) ? m.material : [m.material];
    if (ms.length === 1 || !m.geometry.groups.length) parts.push({ geo: m.geometry, mat: ms[0], mtx: m.matrixWorld.clone(), wheel: isWheel(m) });
    else for (const g of m.geometry.groups) { const geo = m.geometry.clone(); geo.clearGroups(); if (geo.index) geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(g.start, g.start + g.count), 1)); else for (const key in geo.attributes) { const at = geo.attributes[key]; geo.setAttribute(key, new THREE.BufferAttribute(at.array.slice(g.start * at.itemSize, (g.start + g.count) * at.itemSize), at.itemSize)); } parts.push({ geo, mat: ms[g.materialIndex], mtx: m.matrixWorld.clone(), wheel: isWheel(m) }); } });
  return mergeParts(parts);
}
function normalize(obj, scale, lift, flip) {
  const wrap = new THREE.Group(); wrap.add(obj); wrap.scale.setScalar(scale); if (flip) wrap.rotation.y = Math.PI; wrap.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(wrap), c = bb.getCenter(new THREE.Vector3());
  const outer = new THREE.Group(); outer.add(wrap); wrap.position.set(-c.x, -bb.min.y - lift, -c.z); outer.updateMatrixWorld(true);
  return outer;
}
async function loadExtras() {
  const mgr = new THREE.LoadingManager(); mgr.setURLModifier(u => /\.(png|jpg|tga)$/i.test(u) ? 'data:,' : u);
  const Lf = new FBXLoader(mgr);
  const get = async (f) => { try { return await Lf.loadAsync(BASE + 'x/' + f + '.fbx'); } catch (e) { console.warn('extra', f, e); return null; } };
  for (const [f, sc] of [['Garage', 0.032], ['Gas_station', 0.03], ['Station', 0.02]]) {
    const o = await get(f); if (!o) continue;
    const w = normalize(o, sc, 0, false); proto['X_' + f] = { parts: fbxToParts(w, 'x_buildings'), bb: new THREE.Box3().setFromObject(w) };
  }
  const c3 = await get('car3_new');
  if (c3) { const w = normalize(c3, 0.012, 0.24, false); proto.C_car3 = { parts: fbxToParts(w, 'x_car3'), bb: new THREE.Box3().setFromObject(w) }; }
  const cs = await get('Carss');
  if (cs) {
    cs.updateMatrixWorld(true);
    const main = cs.children.filter(c => !/^(Cylinder|Cube|Text|back|front)/.test(c.name));
    const groups = new Map(main.map(m => [m, [m]]));
    const cx = (o) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).x;
    for (const c of cs.children.slice()) {
      if (main.includes(c) || /^Text/.test(c.name)) continue;
      let best = null, bd = 1e9; const x = cx(c); for (const m of main) { const d = Math.abs(cx(m) - x); if (d < bd) { bd = d; best = m; } }
      if (best && bd < 200) groups.get(best).push(c);
    }
    for (const [m, list] of groups) {
      const g = new THREE.Group(); const x0 = cx(m);
      for (const o of list) { const clone = o.clone(); clone.applyMatrix4(cs.matrixWorld); clone.position.x -= x0 * cs.scale.x; g.add(clone); }
      const w = normalize(g, 0.0088, 0.24, true);
      proto['C_' + m.name] = { parts: fbxToParts(w, 'x_car3'), bb: new THREE.Box3().setFromObject(w) };
    }
  }
}

async function loadAll() {
  say('Chargement des modèles…');
  INDEX = await (await fetch(BASE + 'index.json')).json();
  const PP = await (await fetch(BASE + 'packparts.json')).json();
  const parts = PP.parts;
  const heads = parts.map(() => 0);
  const sizes = [];
  const datas = [];
  let got = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const r = await fetch(BASE + parts[pi]);
    const reader = r.body.getReader(); const chunks = []; let skip = heads[pi];
    for (;;) { let { done, value } = await reader.read(); if (done) break; if (skip) { const k = Math.min(skip, value.length); value = value.subarray(k); skip -= k; if (!value.length) continue; } chunks.push(value); got += value.length; say(`Chargement des modèles… ${(got / 1e6).toFixed(0)} / ${(PP.total / 1e6).toFixed(0)} Mo`); }
    datas.push(...chunks);
  }
  const all = new Uint8Array(got); let o = 0; for (const c of datas) { all.set(c, o); o += c.length; } datas.length = 0;
  const buf = all.buffer;
  const loader = new GLTFLoader();
  const names = Object.keys(INDEX);
  let n = 0;
  await Promise.all(names.map(async (name) => {
    const [off, len] = INDEX[name];
    const g = await loader.parseAsync(buf.slice(off, off + len), '');
    n++; if (n % 20 === 0) say(`Préparation ${n}/${names.length}`);
    if (name === 'Characters_1_Animations') { for (const c of g.animations) clips[c.name] = c; return; }
    if (name.startsWith('Character_') || name.startsWith('PoliceMan')) {
      g.scene.traverse(o => { if (o.isMesh) { o.material = sharedMat(o.material); o.castShadow = true; o.frustumCulled = false; } });
      skinned[name] = g.scene; return;
    }
    g.scene.updateMatrixWorld(true);
    { const b0 = new THREE.Box3().setFromObject(g.scene);
      if (b0.min.y < -0.5 && b0.max.z < 0.05 && !/^Cloud/.test(name)) { // exported lying down (Z-up): stand it up
        const root = new THREE.Group(); root.add(g.scene); g.scene.rotation.x = Math.PI / 2; g.scene = root; g.scene.updateMatrixWorld(true);
        const b1 = new THREE.Box3().setFromObject(g.scene); g.scene.children[0].position.y -= b1.min.y; g.scene.updateMatrixWorld(true);
        FIXED.push(name);
      } }
    const parts = [];
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.length === 1) parts.push({ geo: o.geometry, mat: sharedMat(mats[0]), mtx: o.matrixWorld.clone(), wheel: isWheel(o) });
      else {
        for (const grp of o.geometry.groups) {
          const geo = o.geometry.clone(); geo.clearGroups();
          const idx = geo.index.array.slice(grp.start, grp.start + grp.count);
          geo.setIndex(new THREE.BufferAttribute(idx, 1));
          parts.push({ geo, mat: sharedMat(mats[grp.materialIndex]), mtx: o.matrixWorld.clone(), wheel: isWheel(o) });
        }
      }
    });
    const bb = new THREE.Box3().setFromObject(g.scene);
    proto[name] = { parts: mergeParts(parts), bb };
  }));
}

// ---------------------------------------------------------------- instancing
const CHUNK = 400;
const buckets = new Map(); // key -> {name, mats:[]}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const PUTLOG = [];
function put(name, x, y, z, rot = 0, sc = 1, sy) {
  if (!proto[name]) { console.warn('missing', name); return; }
  if (name === 'Parkomat') parkomats.push({ x, z });
  PUTLOG.push([name, x, y, z]);
  if (name === 'Basketball_Stand_A') hoops.push({ x, z });
  if (/^Bench/.test(name)) benchSpots.push({ x, z, rot: (rot || 0) + Math.PI, used: false });
  const key = name + '@' + Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
  let b = buckets.get(key); if (!b) { b = { name, mats: [] }; buckets.set(key, b); }
  _q.setFromAxisAngle(_up, rot); _s.set(sc, sy ?? sc, sc); _p.set(x, y, z);
  b.mats.push(new THREE.Matrix4().compose(_p, _q, _s));
  if (y < 2.5 && PROP_COL.test(name)) propCollider(name, x, z, rot, sc);
  if (/^(Lights_5|Lamp_Court|StreetLamp)/.test(name)) registerLamp(name, x, y, z, rot, sc);
  if (y < 2.5 && /^Bench_(1_A|2_A|3_A|4_A|1_A_1)$/.test(name)) registerBench(x, z, rot);
  return { key, idx: b.mats.length - 1 };
}
function hideInstance(h) {
  const b = buckets.get(h.key); if (!b || !b.meshes) return;
  _m.makeScale(0, 0, 0);
  for (const im of b.meshes) { im.setMatrixAt(h.idx, _m); im.instanceMatrix.needsUpdate = true; }
}
// parked cars: instanced for speed, turned into a drivable object when the player takes one
const parkedSpots = [];
function parkCar(name, x, z, rot) {
  const h = put(name, x, SW + 0.24, z, rot);
  if (h) parkedSpots.push({ name, x, z, rot, h });
}
const PROP_COL = /^(Tree_A|Lights_|StreetLamp|Lamp_Court|Trashbin|BinB|BinG|Hydrant|Bench_[1-4]_A$|BusStop|Kiosk|FoodCart|PostBox|NewspaperH|Parkomat|Fountain|Mayor_Statue|RockFormation|Fence_1_A|Barier_1_1|Container|GasTank|Crane|ConcrateTruck|SandHill|Generator|RubbleContainer|ForkLift|Basketball_Stand|SignHolder_4|Bollards|PlantPot|FlowerPot|Scaffolding|ChimneyPowerPlant|Pallet|Barrel|WoodStock|PipesBulk|BikePlace|Cone_1)/;
const propCols = [], camCols = [];
function propCollider(name, x, z, rot, sc) {
  if (/^(Tree_A|Lights_|StreetLamp|Lamp_Court|Parkomat|Hydrant|Cone_1)/.test(name)) {
    const r = /^Tree_A/.test(name) ? 0.32 * sc : 0.22;
    propCols.push([x - r, z - r, x + r, z + r]);
    if (/^Tree_A/.test(name) && name !== 'Tree_A_8') camCols.push({ x, z, r: 1.7 * sc, y0: 1.6 * sc, y1: 6.5 * sc });
    return;
  }
  if (name === 'SignHolder_4_A') { // two legs of the gantry
    const c = Math.cos(rot), s = Math.sin(rot);
    for (const lz of [-4.4, 4.4]) { const lx = 0.4; const wx = x + lx * c + lz * s, wz = z - lx * s + lz * c; propCols.push([wx - 0.3, wz - 0.3, wx + 0.3, wz + 0.3]); }
    return;
  }
  const f = footprint(name, rot);
  propCols.push([x + f.minx * sc, z + f.minz * sc, x + f.maxx * sc, z + f.maxz * sc]);
}
// rotated footprint helpers
function footprint(name, rot) {
  const bb = proto[name].bb;
  const c = Math.round(Math.cos(rot)), s = Math.round(Math.sin(rot));
  const xs = [], zs = [];
  for (const x of [bb.min.x, bb.max.x]) for (const z of [bb.min.z, bb.max.z]) { xs.push(x * c + z * s); zs.push(-x * s + z * c); }
  return { minx: Math.min(...xs), maxx: Math.max(...xs), minz: Math.min(...zs), maxz: Math.max(...zs), h: bb.max.y };
}
// place so the rotated bbox's min corner lands at (x0,z0)
const extraCols = [];
const SOLID = /Factory|GasTank|ChimneyPowerPlant|Fundaments|Kiosk_|Building_22|Building_23/;
function putAt(name, x0, z0, y, rot) { const f = footprint(name, rot); put(name, x0 - f.minx, y, z0 - f.minz, rot); if (SOLID.test(name)) extraCols.push([x0, z0, x0 + f.maxx - f.minx, z0 + f.maxz - f.minz]); return f; }
// place so the rotated bbox is centred on (cx,cz)
function putC(name, cx, cz, y, rot, sc = 1) { const f = footprint(name, rot); put(name, cx - (f.minx + f.maxx) / 2 * sc, y, cz - (f.minz + f.maxz) / 2 * sc, rot, sc); if (SOLID.test(name)) { const hw = (f.maxx - f.minx) / 2 * sc, hd = (f.maxz - f.minz) / 2 * sc; extraCols.push([cx - hw, cz - hd, cx + hw, cz + hd]); } return f; }


// keep doorways free: small street furniture standing in front of an entrance is dropped (with its collider and lamp light)
const DOORWAY_PROP = /^(Tree_A|StreetLamp|Lamp_Court|Lights_5|Trashbin|BinB|BinG|Hydrant|Bench_|PostBox|NewspaperH|Parkomat|Cone_|Bollard|FoodCart|Bush)/;
let DOORWAY_CLEARED = 0;
function clearDoorways() {
  const near = (x, z) => doors.some(d => { const dx = x - d.x, dz = z - d.z; const along = dx * d.out[1] - dz * d.out[0], out = dx * d.out[0] + dz * d.out[1]; return Math.abs(along) < 1.6 && out > -1.2 && out < 3.2; });
  const v = new THREE.Vector3();
  for (const b of buckets.values()) {
    if (!DOORWAY_PROP.test(b.name)) continue;
    const inYard = (x, z) => /^Tree_A/.test(b.name) && jobLots.some(l => Math.abs(x - l.cx) < 18.5 && Math.abs(z - l.cz) < 18.5);
    const before = b.mats.length; b.mats = b.mats.filter(mt => { v.setFromMatrixPosition(mt); return v.y > 2.5 || (!near(v.x, v.z) && !inYard(v.x, v.z)); }); DOORWAY_CLEARED += before - b.mats.length;
  }
  for (let i = propCols.length - 1; i >= 0; i--) { const c = propCols[i]; const cx = (c[0] + c[2]) / 2, cz = (c[1] + c[3]) / 2; if (c[2] - c[0] < 1.2 && jobLots.some(l => Math.abs(cx - l.cx) < 18.5 && Math.abs(cz - l.cz) < 18.5) && Math.abs(c[2] - c[0] - 0.64) < 0.2) { propCols.splice(i, 1); continue; } if (c[2] - c[0] < 1.2 && near((c[0] + c[2]) / 2, (c[1] + c[3]) / 2)) propCols.splice(i, 1); }
  for (let i = lampHeads.length - 1; i >= 0; i--) if (near(lampHeads[i].x, lampHeads[i].z)) lampHeads.splice(i, 1);
}
function buildInstances() {
  let draws = 0;
  for (const b of buckets.values()) {
    for (const part of proto[b.name].parts) {
      const im = new THREE.InstancedMesh(part.geo, part.mat, b.mats.length);
      (b.meshes || (b.meshes = [])).push(im);
      for (let i = 0; i < b.mats.length; i++) { _m.multiplyMatrices(b.mats[i], part.mtx); im.setMatrixAt(i, _m); }
      im.castShadow = !/Tile|Road|Grass|Base_Basket|Court|Kerb|Pebles|ParkRoad/.test(b.name);
      im.receiveShadow = true;
      im.computeBoundingSphere();
      scene.add(im); draws++;
    }
  }
  return draws;
}

// ---------------------------------------------------------------- city layout
const N = 15, BLK = 48, ROAD = 8, P = BLK + ROAD, HALF = N * P / 2;
const RT = 0.41;           // road surface height
const SW = 0.62;           // sidewalk surface height
const lineX = (i) => i * P - HALF;  // road centre lines
const blockC = (i) => i * P - HALF + P / 2;
const MAIN = 6;            // main avenues index (both axes)
const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const rotDir = (d, k) => { let [x, z] = d; for (let i = 0; i < k; i++) [x, z] = [z, -x]; return [x, z]; }; // +90° steps: E->N->W->S

const baseMat = new THREE.MeshStandardMaterial({ color: 0xd3d6dd, roughness: 0.9 });
const kerbMat = new THREE.MeshStandardMaterial({ color: 0xbfc3cc, roughness: 0.85 });
const lots = []; // for pedestrians & ai

const intersections = new Map(), signals = [];
function roads() {
  // intersections
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = lineX(i), z = lineX(j);
    const has = { E: i < N, W: i > 0, S: j < N, N: j > 0 };
    const cnt = Object.values(has).filter(Boolean).length;
    const want = Object.keys(has).filter(k => has[k]).map(k => DIRS[k].join());
    if (cnt === 4) put('Road_A_7', x, 0, z, 0);
    else {
      const piece = cnt === 3 ? 'Road_A_5' : 'Road_A_9';
      const base = cnt === 3 ? ['N', 'S', 'E'] : ['W', 'S'];
      for (let k = 0; k < 4; k++) {
        const got = base.map(d => rotDir(DIRS[d], k).join());
        if (got.every(g => want.includes(g)) && got.length === want.length) { put(piece, x, 0, z, k * Math.PI / 2); break; }
      }
    }
    // traffic lights on interior crossings
    if (cnt >= 3) {
      const inter = { i, j, x, z, off: ((i + j) % 2) * 12 + ((i * 7 + j * 3) % 5) };
      intersections.set(i + ',' + j, inter);
      // Lights_1_A (analysed from the GLB + city atlas): arm along local +Z, one head at z≈2.59,
      // lenses facing local +X: red y=4.24, amber y≈3.955, green y=3.67, x=0.40
      const LENS = { r: 4.24, y: 3.955, g: 3.67 };
      const corners = [[1, 1, 'x'], [-1, -1, 'x'], [1, -1, 'z'], [-1, 1, 'z']];
      corners.forEach(([sx, sz, axis]) => {
        const px = x + sx * 4.9, pz = z + sz * 4.9;
        const rot = axis === 'x' ? (sz > 0 ? Math.PI : 0) : -sx * Math.PI / 2; // arm reaches over the road toward the crossing
        put('Lights_1_A', px, SW, pz, rot);
        const c = Math.cos(rot), s = Math.sin(rot);
        for (const [k, y] of Object.entries(LENS)) { const lx = 0.41, lz = 2.59; signals.push({ inter, axis, c: k, p: new THREE.Vector3(px + lx * c + lz * s, SW + y, pz - lx * s + lz * c) }); }
      });
    }
  }
  // straight segments
  for (let i = 0; i <= N; i++) for (let j = 0; j < N; j++) {
    for (let k = 1; k <= 6; k++) {
      const t = lineX(j) + k * 8;
      const cross = (k === 1 || k === 6);
      // road along Z at x=lineX(i)
      put(cross ? 'Road_A_2_1' : 'Road_A_1', lineX(i), 0, t, 0);
      // road along X at z=lineX(i)
      put(cross ? 'Road_A_2_1' : 'Road_A_1', t, 0, lineX(i), Math.PI / 2);
    }
    // gantries (portiques) on main avenues and some others
    if (i === MAIN || chance(0.25)) {
      put('SignHolder_4_A', lineX(j) + 20, RT - 0.02, lineX(i), 0);
      if (chance(0.5)) put('SignHolder_4_A', lineX(i), RT - 0.02, lineX(j) + 36, Math.PI / 2);
    }
  }
}

// sidewalk ring + base slab for a block. returns inner lot bounds
function blockBase(cx, cz, { grassEdges = {}, interior = 'StreetTile_1_A_1' } = {}) {
  const slab = new THREE.Mesh(new THREE.BoxGeometry(BLK, SW, BLK), baseMat);
  slab.position.set(cx, SW / 2 - 0.001, cz); slab.receiveShadow = true; scene.add(slab);
  const tile = 'StreetTile_1_A_1';
  for (let a = -23; a <= 23; a += 2) for (let b = -23; b <= 23; b += 2) {
    const ring = Math.abs(a) > 20 || Math.abs(b) > 20;
    if (ring) {
      const edge = a > 20 ? 'E' : a < -20 ? 'W' : b > 20 ? 'S' : 'N';
      const outer = Math.max(Math.abs(a), Math.abs(b)) === 23;
      if (outer && grassEdges[edge] && Math.min(Math.abs(a), Math.abs(b)) < 22) { put('GrassBed_1_A_6', cx + a, SW, cz + b, 0); continue; }
      put(tile, cx + a, SW - 0.1, cz + b, 0);
    } else if (interior.startsWith('StreetTile')) {
      put(interior, cx + a, SW - 0.1, cz + b, 0);
    }
  }
  if (interior === 'grass') for (let a = -18; a <= 18; a += 4) for (let b = -18; b <= 18; b += 4) put(chance(0.5) ? 'GrassTile_A_3' : 'GrassTile_B_3', cx + a, SW - 0.08, cz + b, 0);
  // kerbs
  for (let s = -20; s <= 20; s += 8) {
    put('Kerbstone_A_3', cx + 23.95, SW - 0.28, cz + s, 0); put('Kerbstone_A_3', cx - 23.95, SW - 0.28, cz + s, 0);
    put('Kerbstone_A_3', cx + s, SW - 0.28, cz + 23.95, Math.PI / 2); put('Kerbstone_A_3', cx + s, SW - 0.28, cz - 23.95, Math.PI / 2);
  }
}

// sidewalk furniture along the 4 edges
// opts.excl: { N:[[t0,t1],...], ... } ranges kept free (driveways, bus stops); opts.noBays
const OUT = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
const outRot = (e) => Math.atan2(-OUT[e][1], OUT[e][0]); // rotation that turns local +X toward the road
const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x4b4c52, roughness: 0.95 });
const paintMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 });
function flat(w, d, x, y, z, mat = asphaltMat) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat); m.position.set(x, y, z); m.receiveShadow = true; scene.add(m); return m; }
// asphalt driveway crossing the sidewalk of edge e, centred on t, width w
function driveway(cx, cz, e, t, w) {
  const [ox, oz] = OUT[e];
  if (ox) flat(4.2, w, cx + ox * 22, SW + 0.02, cz + t); else flat(w, 4.2, cx + t, SW + 0.02, cz + oz * 22);
}
function sidewalkProps(cx, cz, bi, bj, opts = {}) {
  const excl = opts.excl || {};
  const edges = [
    ['N', (t, d = 22.6) => [cx + t, cz - d], 0],
    ['S', (t, d = 22.6) => [cx + t, cz + d], Math.PI],
    ['W', (t, d = 22.6) => [cx - d, cz + t], -Math.PI / 2],
    ['E', (t, d = 22.6) => [cx + d, cz + t], Math.PI / 2],
  ];
  const isMain = { N: bj === MAIN, S: bj + 1 === MAIN, W: bi === MAIN, E: bi + 1 === MAIN };
  for (const [e, pos, rot] of edges) {
    const main = isMain[e] || opts.green;
    const ex = (excl[e] || []).slice();
    // roadside parking bay (parallel spots) on quieter streets
    if (!main && !opts.noBays && chance(0.45)) {
      const t0 = -12, t1 = 0.5;
      if (!ex.some(([a, b]) => b > t0 - 1 && a < t1 + 1)) {
        ex.push([t0 - 0.5, t1 + 0.5]);
        const [ox, oz] = OUT[e], mid = (t0 + t1) / 2, len = t1 - t0;
        if (ox) flat(2.4, len, cx + ox * 22.8, SW + 0.02, cz + mid); else flat(len, 2.4, cx + mid, SW + 0.02, cz + oz * 22.8);
        for (const tt of [t0, t0 + len / 2, t1]) { const [x, z] = pos(tt, 22.8); if (ox) flat(2.4, 0.12, x, SW + 0.03, z, paintMat); else flat(0.12, 2.4, x, SW + 0.03, z, paintMat); }
        for (const tt of [t0 + len / 4, t0 + len * 3 / 4]) if (chance(0.75)) {
          const [x, z] = pos(tt, 22.8);
          // car length along the edge, facing the traffic direction of the near lane
          const along = ox ? 0 : Math.PI / 2;
          parkCar(pick(CARS), x, z, along + (chance(0.5) ? Math.PI : 0));
        }
      }
    }
    const free = (t, m = 0.6) => !ex.some(([a, b]) => t > a - m && t < b + m);
    for (const t of [-14, 2, 18]) if (free(t)) { const [x, z] = pos(t); put(main ? 'Lights_5_B' : 'Lights_5_A', x, SW, z, rot + Math.PI / 2); }
    if (main) for (let t = -18; t <= 18; t += 6.5) { if (!free(t + 1.2, 1.5)) continue; const [x, z] = pos(t + 1.2); put(pick(['Tree_A_5', 'Tree_A_6', 'Tree_A_7', 'Tree_A_5', 'Tree_A_2']), x, SW, z, rr(0, 6.28), rr(1.5, 1.9)); }
    else for (let t = -16; t <= 16; t += 12) if (chance(0.55) && free(t + 4.5, 1.5)) { const [x, z] = pos(t + 4.5); put(pick(['Tree_A_3', 'Tree_A_6', 'Tree_A_7', 'Tree_A_4']), x, SW, z, rr(0, 6.28), rr(1.5, 1.9)); }
    const extras = [['Trashbin_1_A', 0.7], ['Bench_4_A', 0.45], ['Hydrant', 0.45], ['BinB', 0.15], ['PostBox_1_A', 0.2], ['NewspaperH', 0.15], ['Parkomat', 0.25], ['BikePlace', 0.15], ['FlowerPot_5_1_A', 0.3]];
    for (const [nm, p] of extras) if (chance(p)) { const t = rr(-19, 19); if (!free(t, 1)) continue; const [x, z] = pos(t, nm === 'Bench_4_A' ? 21.2 : 22.6); put(nm, x, SW, z, rot + (nm === 'Bench_4_A' ? Math.PI / 2 : 0)); }
    if (chance(0.15) && free(10, 2)) { const [x, z] = pos(10, 21.5); put('FoodCart_1_A', x, SW, z, rot); }
  }
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (chance(0.5)) put('Bollards_1_A', cx + sx * 22.5, SW, cz + sz * 21, 0);
  // bus stops on this block (from the bus lines), open side toward the road
  for (const st of busStops) if (st.block === bi + ',' + bj) {
    const [x, z] = edges.find(E => E[0] === st.edge)[1](st.t, 21.9);
    put(st.model, x, SW, z, outRot(st.edge));
    put('SignHolder_3_A', x + OUT[st.edge][0] * 1.2 + (OUT[st.edge][1] ? 2.8 : 0), SW, z + OUT[st.edge][1] * 1.2 + (OUT[st.edge][0] ? 2.8 : 0), outRot(st.edge));
  }
}

const BUILD = {};
function catBuildings() {
  BUILD.all = Object.keys(proto).filter(n => /^Building_\d+/.test(n));
  const dims = (n) => proto[n].bb.getSize(new THREE.Vector3());
  BUILD.solo = BUILD.all.filter(n => Math.min(dims(n).x, dims(n).z) > 19);
  BUILD.row = BUILD.all.filter(n => Math.min(dims(n).x, dims(n).z) <= 19);
  // tallest first (they go to the centre), light shuffle inside height bands
  BUILD.row.sort((a, b) => (proto[b].bb.max.y + rr(-4, 4)) - (proto[a].bb.max.y + rr(-4, 4)));
  BUILD.solo.sort(() => rnd() - 0.5);
}
const ROOF = ['Vent_2_A', 'ElectricBox_1_A_1', 'Chimney_4_A_1', 'Antene_2_A_1', 'WaterTank_1_A', 'WaterTank_2_A', 'RoofProp_5_A', 'Chimney_1_A_1'];
const smokers = [];
const _rc = new THREE.Raycaster(), _down = new THREE.Vector3(0, -1, 0), _nm3 = new THREE.Matrix3();
const ROOFSTAT = { ok: 0, skipped: 0 };
// roof props only where the real roof surface under them is flat (raycast on the building model)
function roofProps(x0, z0, f, nm, rot) {
  const w = f.maxx - f.minx, d = f.maxz - f.minz;
  let obj = null;
  if (nm) { obj = makeObject(nm); obj.position.set(x0 - f.minx, SW, z0 - f.minz); obj.rotation.y = rot || 0; obj.updateMatrixWorld(true); }
  const n = Math.floor(rr(1, 4));
  for (let i = 0; i < n; i++) {
    const pn = pick(ROOF);
    if (!proto[pn]) continue;
    const px = x0 + w * rr(0.3, 0.7), pz = z0 + d * rr(0.3, 0.7);
    let y = SW + f.h - 0.35;
    if (obj) {
      _rc.set(new THREE.Vector3(px, SW + f.h + 5, pz), _down); const hit = _rc.intersectObject(obj, true)[0];
      if (!hit || !hit.face) { ROOFSTAT.skipped++; continue; }
      const nrm = hit.face.normal.clone().applyMatrix3(_nm3.getNormalMatrix(hit.object.matrixWorld)).normalize();
      const pb = proto[pn].bb, r = Math.max(pb.max.x - pb.min.x, pb.max.z - pb.min.z) / 2;
      // the whole prop footprint must sit on the same flat level
      let flat = nrm.y > 0.97;
      for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) { if (!flat) break; _rc.set(new THREE.Vector3(px + ox, SW + f.h + 5, pz + oz), _down); const h2 = _rc.intersectObject(obj, true)[0]; flat = !!h2 && Math.abs(h2.point.y - hit.point.y) < 0.05; }
      if (!flat || hit.point.y < SW + 2.5) { ROOFSTAT.skipped++; continue; }
      y = hit.point.y;
    }
    put(pn, px, y, pz, (rr(0, 4) | 0) * 1.57); ROOFSTAT.ok++;
  }
  if (chance(0.04)) { const v = new THREE.Vector3(x0 + w * 0.5, SW + f.h + 1, z0 + d * 0.5); v.small = true; smokers.push(v); }
}

// row of buildings along an edge of the lot. side: 'N' (front faces -Z) or 'S'. Consumes the queue.
const placed = []; // footprints for overlap check

// which local side of a building model is its facade? -> the side with the most glass/window surface
const _front = new Map();
function frontAngle(name) {
  if (_front.has(name)) return _front.get(name);
  const acc = [0, 0, 0, 0]; // +Z, +X, -Z, -X
  const p = proto[name]; let any = false;
  if (p) for (const part of p.parts) {
    const glass = /window|glass/i.test(part.mat.name || '');
    const pos = part.geo.attributes.position, idx = part.geo.index; if (!pos) continue;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    const cnt = idx ? idx.count : pos.count;
    for (let i = 0; i < cnt; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(part.mtx); b.fromBufferAttribute(pos, i1).applyMatrix4(part.mtx); c.fromBufferAttribute(pos, i2).applyMatrix4(part.mtx);
      n.crossVectors(b.sub(a), c.sub(a)); const area = n.length() / 2; if (area < 1e-6) continue; n.normalize();
      if (Math.abs(n.y) > 0.5) continue;
      const w = area * (glass ? 1 : 0.02); // non-glass walls only break ties
      if (Math.abs(n.z) > Math.abs(n.x)) acc[n.z > 0 ? 0 : 2] += w; else acc[n.x > 0 ? 1 : 3] += w;
      if (glass) any = true;
    }
  }
  let best = 0; for (let i = 1; i < 4; i++) if (acc[i] > acc[best]) best = i;
  const ang = any ? [0, Math.PI / 2, Math.PI, -Math.PI / 2][best] : 0;
  _front.set(name, ang); return ang;
}
// rotation that turns the model's facade toward the world direction `want` (0 = +Z, PI = -Z)
function faceRot(name, want) { return want - frontAngle(name); }
const ROWSTAT = { n: 0, side: 0 };
function buildingRow(cx, cz, side, queue, maxDepth = 19.5) {
  const rot = side === 'N' ? Math.PI : 0;
  let x = cx - 20; const end = cx + 20; let maxd = 0; let guard = 0; let rowDoor = false;
  while (x < end - 3 && guard++ < 30 && queue.length) {
    let idx = -1, r = rot;
    // facade toward the street first; a sideways fallback only if no model in the queue fits that way
    for (let i = 0; i < Math.min(queue.length, 120) && idx < 0; i++) {
      const rt = faceRot(queue[i], rot === 0 ? 0 : Math.PI); const f = footprint(queue[i], rt);
      if ((f.maxx - f.minx) <= end - x + 0.01 && (f.maxz - f.minz) <= maxDepth) { idx = i; r = rt; }
    }
    for (let i = 0; i < Math.min(queue.length, 60) && idx < 0; i++) {
      for (const rt of [rot, rot + Math.PI / 2]) {
        const f = footprint(queue[i], rt);
        if ((f.maxx - f.minx) <= end - x + 0.01 && (f.maxz - f.minz) <= maxDepth) { idx = i; r = rt; ROWSTAT.side++; break; }
      }
    }
    if (idx >= 0) ROWSTAT.n++;
    if (idx < 0) break;
    const nm = queue.splice(idx, 1)[0];
    const f = footprint(nm, r);
    const w = f.maxx - f.minx, d = f.maxz - f.minz;
    const z0 = side === 'N' ? cz - 20 : cz + 20 - d;
    putAt(nm, x, z0, SW, r);
    placed.push({ nm, x0: x, z0, x1: x + w, z1: z0 + d });
    if (!rowDoor && w >= 5) { rowDoor = true; registerDoor(x + w / 2, side === 'N' ? cz - 20.7 : cz + 20.7, 0, side === 'N' ? -1 : 1); }
    roofProps(x, z0, f, nm, r);
    maxd = Math.max(maxd, d);
    x += w + 0.6;
  }
  return maxd;
}

function courtyard(cx, cz, z1, z2) {
  // fill leftover space between building rows with greenery
  if (z2 - z1 < 3) return;
  for (let x = -18; x <= 18; x += 6) {
    const z = rr(z1 + 1, z2 - 1);
    if (chance(0.7)) put(pick(['Tree_A_3', 'Tree_A_6', 'Tree_A_5', 'Bush_2_A_1']), cx + x, SW, z, rr(0, 6.28), rr(1.4, 1.9));
  }
}

function blockCity(cx, cz, pool, bi, bj) {
  blockBase(cx, cz, {});
  const d1 = buildingRow(cx, cz, 'N', pool);
  const d2 = buildingRow(cx, cz, 'S', pool, 40 - d1 - 0.8);
  const z1 = cz - 20 + d1 + 0.4, z2 = cz + 20 - d2 - 0.4, gap = z2 - z1;
  const excl = busExcl(bi, bj);
  if (gap >= 9) {
    // small car park in the courtyard, reached by a driveway from the E or W street
    const e = chance(0.5) ? 'E' : 'W', zm = (z1 + z2) / 2;
    excl[e] = (excl[e] || []).concat([[zm - cz - 3.4, zm - cz + 3.4]]);
    flat(40, gap, cx, SW + 0.015, zm);
    driveway(cx, cz, e, zm - cz, 6);
    for (let x = -18.5; x <= 18.5; x += 3) {
      flat(0.12, 4.6, cx + x, SW + 0.03, z1 + 2.4, paintMat);
      if (x < 18 && chance(0.6) && Math.abs(cx + x + 1.5 - (e === 'E' ? cx + 20 : cx - 20)) > 4) parkCar(pick(CARS), cx + x + 1.5, z1 + 2.5, chance(0.5) ? 0 : Math.PI);
    }
    lotsParking.push({ x: cx, z: zm });
  } else courtyard(cx, cz, z1, z2);
  sidewalkProps(cx, cz, bi, bj, { excl });
}
const lotsParking = [];

function blockTower(cx, cz, bi, bj, nm) {
  blockBase(cx, cz, { interior: 'StreetTile_1_A_1' });
  sidewalkProps(cx, cz, bi, bj, { excl: busExcl(bi, bj) });
  let rot = faceRot(nm, Math.PI), f = footprint(nm, rot);
  if ((f.maxz - f.minz) > 36 && (f.maxx - f.minx) < (f.maxz - f.minz)) { rot = Math.PI / 2; f = footprint(nm, rot); }
  const w = f.maxx - f.minx, d = f.maxz - f.minz;
  const x0 = cx - w / 2, z0 = cz - 20;
  putAt(nm, x0, z0, SW, rot);
  placed.push({ nm, x0, z0, x1: x0 + w, z1: z0 + d });
  registerDoor(cx, cz - 20.7, 0, -1);
  roofProps(x0, z0, f, nm, rot);
  const free = 20 - (z0 + d - cz);
  if (free > 3) for (const s of [-1, 1]) { put('Tree_A_5', cx + s * 16, SW, cz + 20 - free / 2, rr(0, 6), 1.4); put('Bench_4_A', cx + s * 8, SW, cz + 20 - free / 2, Math.PI / 2); }
  if (free > 6) put('Fountain_1_A', cx, SW, cz + 20 - free / 2, 0);
}

function blockPark(cx, cz, bi, bj, statue) {
  blockBase(cx, cz, { interior: 'grass' });
  sidewalkProps(cx, cz, bi, bj, { green: true, excl: busExcl(bi, bj) });
  // paths
  for (let t = -19; t <= 19; t += 4) { put('ParkRoad_1_A', cx, SW, cz + t, 0, 1); put('ParkRoad_1_A', cx + t, SW, cz, Math.PI / 2, 1); }
  if (statue) { const ped = new THREE.Mesh(new THREE.BoxGeometry(6, 1.6, 6), kerbMat); ped.position.set(cx, SW + 0.8, cz); ped.castShadow = ped.receiveShadow = true; scene.add(ped); put('Mayor_Statue_A', cx, SW + 1.6, cz, Math.PI * 0.25, 0.6); }
  else put('Fountain_1_A', cx, SW, cz, 0, 1.6);
  const trees = ['Tree_A_5', 'Tree_A_6', 'Tree_A_7', 'Tree_A_2', 'Tree_A_5', 'Tree_A_3', 'Tree_A_4', 'Tree_A_8'];
  for (let i = 0; i < 34; i++) {
    const x = rr(-19, 19), z = rr(-19, 19);
    if (Math.abs(x) < 2.5 || Math.abs(z) < 2.5 || Math.hypot(x, z) < 6) continue;
    put(chance(0.05) ? 'Tree_A_8' : pick(trees.slice(0, 7)), cx + x, SW, cz + z, rr(0, 6.28), rr(1.6, 2.4));
  }
  for (let i = 0; i < 30; i++) {
    const x = rr(-19, 19), z = rr(-19, 19);
    if (Math.abs(x) < 2 || Math.abs(z) < 2) continue;
    put(pick(['Bush_1_A_1', 'Bush_2_A_1', 'Flowers_1_A', 'Flowers_2_A', 'Flowers_3_A', 'Grass_A_1', 'Rock_1_A', 'Rock_2_A', 'Plant_1_A_1', 'Reed_1', 'Pebles_1_A_1']), cx + x, SW, cz + z, rr(0, 6.28), rr(1, 1.6));
  }
  put('RockFormation_1', cx + 13, SW, cz - 13, 0.7, 1.2);
  for (const t of [-14, -8, 8, 14]) { put('Bench_1_A', cx + 1.8, SW, cz + t, Math.PI); put('Bench_1_A', cx + t, SW, cz - 1.8, -Math.PI / 2); put('StreetLamp_3_A', cx - 1.6, SW, cz + t + 3, 0); }
  for (let i = 0; i < 6; i++) ducks.push({ c: new THREE.Vector3(cx + 10, SW, cz + 12), r: rr(1.5, 4), a: rr(0, 6.28), s: rr(0.2, 0.5) });
}

function blockBasket(cx, cz, bi, bj) {
  blockBase(cx, cz, { interior: 'grass' });
  sidewalkProps(cx, cz, bi, bj, { green: true, excl: busExcl(bi, bj) });
  const ox = cx - 9, oz = cz;
  put('Base_Basket_A', ox, SW, oz, 0);
  put('Basketball_Court_1', ox, SW + 0.21, oz, 0);
  put('Basketball_Stand_A', ox, SW + 0.2, oz - 9.2, 0);
  put('Basketball_Stand_A', ox, SW + 0.2, oz + 9.2, Math.PI);
  for (let t = -8; t <= 8; t += 4) { put('Fence_1_A_3', ox - 7, SW, oz + t, 0); put('Fence_1_A_3', ox + 7, SW, oz + t, 0); }
  for (const t of [-4.5, 0, 4.5]) { put('Fence_1_A_3', ox + t, SW, oz - 10, Math.PI / 2); put('Fence_1_A_3', ox + t, SW, oz + 10, Math.PI / 2); }
  for (const t of [-6, -2, 2, 6]) put('Bench_1_A_1', ox + 5.8, SW + 0.2, oz + t, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) put('Lamp_Court_1_A', ox + sx * 6.6, SW + 0.2, oz + sz * 9.6, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
  put('Basketball', ox + 1, SW + 0.42, oz - 6, 0);
  // side garden
  for (let i = 0; i < 14; i++) put(pick(['Tree_A_5', 'Tree_A_2', 'Tree_A_6', 'Bush_2_A_1', 'Flowers_1_A']), cx + rr(1, 19), SW, cz + rr(-19, 19), rr(0, 6), rr(1.5, 2.2));
  put('RockFormation_2', cx + 14, SW, cz - 12, 0.3, 1.3);
  for (let i = 0; i < 6; i++) players.push({ x: ox + rr(-3, 3), z: oz + rr(-6, 6), ox, oz });
}

function blockParking(cx, cz, bi, bj) {
  blockBase(cx, cz, { interior: 'none' });
  const excl = busExcl(bi, bj);
  for (const [e, t] of [['W', -10], ['W', 10], ['E', -10], ['E', 10]]) { excl[e] = (excl[e] || []).concat([[t - 3.4, t + 3.4]]); driveway(cx, cz, e, t, 6); }
  sidewalkProps(cx, cz, bi, bj, { excl, noBays: true });
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x4b4c52, roughness: 0.95 }));
  asphalt.rotation.x = -Math.PI / 2; asphalt.position.set(cx, SW + 0.015, cz); asphalt.receiveShadow = true; scene.add(asphalt);
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 });
  const yel = new THREE.MeshStandardMaterial({ color: 0xf2b630, roughness: 0.8 });
  const lineGeo = new THREE.PlaneGeometry(5, 0.15); lineGeo.rotateX(-Math.PI / 2);
  // 4 rows of bays (cars nose-in), aisles between
  const rows = [-15.5, -4.5, 4.5, 15.5];
  const lines = [];
  for (const rz of rows) for (let x = -19; x <= 19.01; x += 3) lines.push([cx + x, cz + rz]);
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.15, 5).rotateX(-Math.PI / 2), lineMat, lines.length);
  lines.forEach(([x, z], i) => { _m.makeTranslation(x, SW + 0.03, z); im.setMatrixAt(i, _m); });
  im.receiveShadow = true; im.computeBoundingSphere(); scene.add(im);
  for (const z of [-10, 10]) { const y = new THREE.Mesh(new THREE.PlaneGeometry(38, 0.2).rotateX(-Math.PI / 2), yel); y.position.set(cx, SW + 0.03, cz + z); scene.add(y); }
  for (const rz of rows) for (let x = -17.5; x <= 17.5; x += 3) if (chance(0.7)) {
    const back = Math.abs(rz) > 10 ? Math.sign(rz) : -Math.sign(rz);
    parkCar(pick(CARS), cx + x, cz + rz, back > 0 ? 0 : Math.PI);
  }
  put('Kiosk_1_A', cx + 17, SW, cz, Math.PI / 2);
  put('Parkomat', cx - 19, SW, cz - 4, 0); put('Parkomat', cx - 19, SW, cz + 4, 0);
  const lot = { x: cx, z: cz }; lotsParking.push(lot);
  // lifting barriers on every entrance (two half-arms per 6 m driveway), fences along the lot edges between entrances
  for (const sx of [-1, 1]) for (const t of [-10, 10]) { makeGate(cx + sx * 19.2, cz + t - 3, 0, lot); makeGate(cx + sx * 19.2, cz + t + 3, Math.PI, lot); }
  if (proto.WallFence_1_1_A) for (const sx of [-1, 1]) for (const [a, b] of [[-19, -13], [-7, 7], [13, 19]]) for (let z = a + 1.05; z <= b - 1.0; z += 2.1) { put('WallFence_1_1_A', cx + sx * 19.8, SW, cz + z, Math.PI / 2); propCols.push([cx + sx * 19.8 - 0.1, cz + z - 1, cx + sx * 19.8 + 0.1, cz + z + 1]); }
}

function blockFactory(cx, cz, bi, bj, big) {
  { const pos = new THREE.Vector3(cx + 6, SW, cz + 21); const mk = makeMarker(0xffb74d, 6); mk.position.copy(pos); jobSpots.push({ kind: 'factory', def: { label: '🏭 Usine', sell: true }, pos, mk }); const sp = textPlaque('🏭 Usine · achat ressources', '#6d4c41', 5); sp.position.set(cx, SW + 14, cz + 18); }
  blockBase(cx, cz, { interior: 'StreetTile_1_A_1' });
  sidewalkProps(cx, cz, bi, bj, { excl: busExcl(bi, bj), noBays: true });
  if (big) {
    putAt('Building_Factory_4_A', cx - 20, cz - 20, SW, 0);
    put('ChimneyPowerPlant_3_A', cx + 14, SW, cz + 13, 0); smokers.push(new THREE.Vector3(cx + 14, SW + 30, cz + 13));
    put('ChimneyPowerPlant_2_A', cx + 14, SW, cz + 2, 0); smokers.push(new THREE.Vector3(cx + 14, SW + 19.5, cz + 2));
    putC('GasTank_2_A', cx + 10, cz - 12, SW, 0);
    smokers.push(new THREE.Vector3(cx - 12, SW + 12.5, cz - 6), new THREE.Vector3(cx - 6, SW + 12.5, cz + 6));
  } else {
    putAt('Building_Factory_1_A', cx - 20, cz - 20, SW, 0);
    putAt('Building_Factory_2_A', cx + 4, cz - 20, SW, 0);
    for (let i = 0; i < 6; i++) put(pick(['Container_1_1', 'Container_1_2', 'Container_1_3', 'Container_1_4']), cx - 16 + i * 3, SW + (i % 3 === 0 ? 1.9 : 0) * 0, cz + 14, 0);
    put('GasTank_1_A', cx + 15, SW, cz + 12, 0);
    smokers.push(new THREE.Vector3(cx - 12, SW + 10, cz - 10));
  }
  for (let i = 0; i < 8; i++) put(pick(['Pallet_1_1', 'Barrel_1_1', 'WoodStock_1', 'PipesBulk']), cx + rr(-18, 18), SW, cz + rr(5, 18), rr(0, 6));
  put('ForkLift', cx - 4, SW, cz + 8, 1.2);
}

function blockConstruction(cx, cz, bi, bj) {
  blockBase(cx, cz, { interior: 'none' });
  sidewalkProps(cx, cz, bi, bj, { excl: busExcl(bi, bj), noBays: true });
  const g = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 1 }));
  g.rotation.x = -Math.PI / 2; g.position.set(cx, SW + 0.01, cz); g.receiveShadow = true; scene.add(g);
  putC('Fundaments_3_1', cx - 6, cz - 4, SW, 0);
  for (let i = 0; i < 6; i++) put('Pilar_A_1', cx - 9 + (i % 3) * 3.5, SW + 2.39, cz - 8 + Math.floor(i / 3) * 8, 0);
  put('Crane', cx + 8, SW, cz - 12, 0.4);
  put('Scaffolding_A_1', cx - 15, SW, cz + 8, 0);
  put('ConcrateTruck', cx + 10, SW, cz + 8, 0.3);
  put('SandHill_1_1', cx + 14, SW, cz - 2, 0);
  put('Generator_1_A', cx - 14, SW, cz + 15, 0);
  put('RubbleContainer_A_1', cx + 2, SW, cz + 14, Math.PI / 2);
  put('ConcrateSlabs_A_1_1', cx - 2, SW, cz + 6, 0);
  for (let i = 0; i < 8; i++) put('Cone_1', cx + rr(-18, 18), SW, cz + rr(-18, 18), 0);
  for (let t = -18; t <= 18; t += 4.1) { put('Barier_1_1', cx - 19.8, SW, cz + t, 0); put('Barier_1_1', cx + 19.8, SW, cz + t, 0); put('Barier_1_1', cx + t, SW, cz - 19.8, Math.PI / 2); if (Math.abs(t) > 5) put('Barier_1_1', cx + t, SW, cz + 19.8, Math.PI / 2); }
}

function blockMall(cx, cz, bi, bj) {
  blockBase(cx, cz, { interior: 'StreetTile_1_A_1' });
  sidewalkProps(cx, cz, bi, bj);
  putC('Building_22_1_A', cx, cz - 3, SW, faceRot('Building_22_1_A', 0));
  for (let t = -16; t <= 16; t += 8) put('Tree_A_5', cx + t, SW, cz + 18, rr(0, 6), 1.5);
}

// ---------------------------------------------------------------- ground & sky
function environment() {
  const g = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ color: 0x79c64b, roughness: 1 }));
  g.rotation.x = -Math.PI / 2; g.position.y = -0.02; g.receiveShadow = true; scene.add(g);
  // outer ring of greenery
  for (let i = 0; i < 600; i++) {
    const a = rr(0, 6.283), r = rr(HALF + 10, HALF + 90);
    const tx = Math.cos(a) * r, tz = Math.sin(a) * r;
    if ((tz > HALF && tx > -110 && tx < 120) || (tz < -HALF && tx > -70 && tx < 130)) continue;
    put(pick(['Tree_A_1', 'Tree_A_2', 'Tree_A_3', 'Tree_A_4', 'Tree_A_6', 'Tree_A_7', 'Tree_A_5']), Math.cos(a) * r, 0, Math.sin(a) * r, rr(0, 6), rr(1.3, 2.2));
  }
  const sky = loadTexBlob(BASE + 'tex/sky_panorama.jpg', t => {
    t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
    scene.background = t;
    const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromEquirectangular(t).texture;
    skyReady = true;
  });
  scene.backgroundIntensity = 1.0;
  scene.fog = MOBILE ? new THREE.Fog(0xcfe3f4, 250, 850) : new THREE.Fog(0xcfe3f4, 600, 1800);
}
let skyReady = false;

// ---------------------------------------------------------------- dynamic: traffic
const CARS = [];
const cars = [];
function initCarsList() {
  for (const n of Object.keys(proto)) if (/^(C_(Femintine|Thunderball|Chunkzer|Galacci|Neptune|Rosaro|Rammer|Mortli|Dante|Lavendra|Mascuilo|Unimo|Forge|car3)|SportCar_\d+|PickUp_\d+|PostCar_\d+|Van_\d+|Ambulance|IceCreamTruck_\d|PoliceCar|SMAT|Taxi|Car_\d+_[A-Z]+|Taxi_\d|Car_Police_\d_A_1|Ambulance_2_A|PostCar_1_A|IceTruck_1_A|Truck_A|RVCar_A|Car_3_1_A|Car_4_1_A)$/.test(n)) CARS.push(n);
}
function makeObject(name) {
  const g = new THREE.Group(); g.userData.name = name;
  for (const p of proto[name].parts) {
    const m = new THREE.Mesh(p.geo, p.mat); m.applyMatrix4(p.mtx); m.castShadow = true; m.receiveShadow = true;
    if (p.wheel) { // pivot at the wheel's centre so it rolls around its axle (car length is on Z, axle on X)
      p.geo.computeBoundingBox(); const b = p.geo.boundingBox.clone().applyMatrix4(p.mtx), c = b.getCenter(new THREE.Vector3());
      const pv = new THREE.Group(); pv.position.copy(c); m.position.sub(c); pv.add(m); g.add(pv);
      (g.userData.wheels = g.userData.wheels || []).push({ pv, r: Math.max(0.15, (b.max.y - b.min.y) / 2) });
    } else g.add(m);
  }
  return g;
}
const nodeKey = (i, j) => i + ',' + j;
function neighbors(i, j) { const r = []; if (i > 0) r.push([i - 1, j]); if (i < N) r.push([i + 1, j]); if (j > 0) r.push([i, j - 1]); if (j < N) r.push([i, j + 1]); return r; }
const LANE = 2.0, STOP = 5.0;
function laneEnds(a, b) { // start/end points of lane going a->b
  const ax = lineX(a[0]), az = lineX(a[1]), bx = lineX(b[0]), bz = lineX(b[1]);
  const dx = Math.sign(bx - ax), dz = Math.sign(bz - az);
  const rx = -dz, rz = dx; // right-hand side
  return { s: new THREE.Vector3(ax + dx * STOP + rx * LANE, RT + 0.24, az + dz * STOP + rz * LANE), e: new THREE.Vector3(bx - dx * STOP + rx * LANE, RT + 0.24, bz - dz * STOP + rz * LANE), d: [dx, dz] };
}
function spawnCars(n) {
  for (let k = 0; k < n; k++) {
    const a = [Math.floor(rr(0, N + 1)), Math.floor(rr(0, N + 1))];
    const nb = neighbors(...a); const b = pick(nb);
    const name = k % 9 === 0 ? pick(['Taxi_1', 'Taxi_2', 'Taxi_3']) : pick(CARS);
    const obj = makeObject(name); scene.add(obj);
    const car = { obj, a, b, seg: laneEnds(a, b), t: rnd(), mode: 'lane', speed: rr(7, 11), v: 0, curve: null }; cars.push(car);
    if (isTwo(obj)) addRider(car);
  }
}
const _v = new THREE.Vector3();
const obstacles = [];
function updateCars(dt) {
  for (const c of cars) {
    // simple following: slow down if a car ahead on same lane
    let target = c.speed;
    if (c.mode === 'lane') {
      for (const o of cars) if (o !== c && o.mode === 'lane' && o.a[0] === c.a[0] && o.a[1] === c.a[1] && o.b[0] === c.b[0] && o.b[1] === c.b[1]) {
        const gap = (o.t - c.t) * c.seg.s.distanceTo(c.seg.e);
        if (gap > 0 && gap < 8) target = Math.min(target, Math.max(0, (gap - 4.5) * 2));
      }
    }
    if (c.mode === 'lane') {
      const inter = intersections.get(c.b[0] + ',' + c.b[1]);
      if (inter) {
        const rem = c.seg.s.distanceTo(c.seg.e) * (1 - c.t);
        const st = lightState(inter, c.seg.d[0] !== 0 ? 'x' : 'z');
        if (st === 'r' || (st === 'y' && rem > 3.5)) if (rem < 12) target = Math.min(target, Math.max(0, (rem - 0.8) * 1.3));
      }
    }
    if (obstacles.length) {
      const ry = c.obj.rotation.y, fx = -Math.sin(ry), fz = -Math.cos(ry);
      for (const o of obstacles) {
        const rx = o.x - c.obj.position.x, rz = o.z - c.obj.position.z;
        const along = rx * fx + rz * fz, lat = Math.abs(rx * fz - rz * fx);
        if (along > 0 && along < 10 && lat < 2.3) target = Math.min(target, Math.max(0, (along - 4.2) * 1.6));
      }
    }
    if (c.route) target = busTarget(c, target, dt);
    c.v += (target - c.v) * Math.min(1, dt * 2);
    if (c.mode === 'lane') {
      const len = c.seg.s.distanceTo(c.seg.e);
      c.t += c.v * dt / len;
      if (c.t >= 1) {
        const nbs = neighbors(...c.b).filter(n => !(n[0] === c.a[0] && n[1] === c.a[1]));
        const nxt = c.route ? c.route[(c.ri + 2) % c.route.length] : pick(nbs.length ? nbs : [c.a]);
        const nseg = laneEnds(c.b, nxt);
        const p0 = c.seg.e.clone(), p2 = nseg.s.clone();
        const ctrl = new THREE.Vector3(c.seg.d[0] !== 0 ? p2.x : p0.x, RT + 0.24, c.seg.d[1] !== 0 ? p2.z : p0.z);
        if (c.seg.d[0] === nseg.d[0] && c.seg.d[1] === nseg.d[1]) ctrl.lerpVectors(p0, p2, 0.5);
        c.curve = new THREE.QuadraticBezierCurve3(p0, ctrl, p2); c.ct = 0; c.mode = 'turn';
        c.a = c.b; c.b = nxt; c.seg = nseg; c.t = 0;
        if (c.route) { c.ri = (c.ri + 1) % c.route.length; c.served = false; }
      } else {
        _v.lerpVectors(c.seg.s, c.seg.e, c.t); c.obj.position.copy(_v);
        c.obj.rotation.y = Math.atan2(c.seg.d[0], c.seg.d[1]) + Math.PI;
      }
    }
    if (c.mode === 'turn') {
      const len = c.curve.getLength();
      c.ct += c.v * dt / len;
      if (c.ct >= 1) { c.mode = 'lane'; c.t = 0; }
      else { const p = c.curve.getPoint(c.ct), tg = c.curve.getTangent(c.ct); c.obj.position.copy(p); c.obj.rotation.y = Math.atan2(tg.x, tg.z) + Math.PI; }
    }
  }
}

// ---------------------------------------------------------------- pedestrians
const peds = [], players = [], ducks = [];
const mixers = [];
const CHAR_POOL = () => Object.keys(skinned).filter(n => !/_Z_/.test(n) || chance(0.3));
function makeChar(name) {
  const o = SkeletonUtils.clone(skinned[name]);
  o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; } });
  const mixer = new THREE.AnimationMixer(o); mixers.push(mixer);
  scene.add(o);
  return { o, mixer };
}
function play(ch, clipName, ts = 1) {
  const clip = clips[clipName] || clips['Walk_A-loop'] || Object.values(clips)[0];
  if (!clip) return;
  const a = ch.mixer.clipAction(clip); a.timeScale = ts; a.reset().play(); a.time = rr(0, clip.duration);
}
function spawnPeds(perBlock) {
  const models = Object.keys(skinned);
  const total = Math.max(models.length, lots.length * perBlock);
  let mi = 0;
  for (let k = 0; k < total; k++) {
    const L = lots[k % lots.length];
    const ch = makeChar(models[mi++ % models.length]);
    const off = rr(21, 23.2);
    const walking = chance(0.8);
    const p = { ...ch, cx: L.cx, cz: L.cz, off, s: rr(0, 4), dir: chance(0.5) ? 1 : -1, speed: rr(1.0, 1.5), walking };
    const clip = walking ? (chance(0.12) ? 'Runing_A-loop' : pick(['Walk_A-loop', 'Walk_B-loop', 'Walk_C-loop'])) : pick(['Idle_A-loop', 'Idle_B-loop', 'LookingAround-loop']);
    play(ch, clip);
    if (/Runing/.test(clip)) p.speed *= 2.2;
    peds.push(p);
  }
  for (const pl of players) {
    const ch = makeChar(pick(models));
    Object.assign(pl, ch, { tx: pl.x, tz: pl.z, wait: 0 });
    play(pl, 'Runing_B-loop', 1);
    pl.o.position.set(pl.x, SW + 0.24, pl.z);
  }
  window.REPORT && (window.REPORT.npcModels = models.length, window.REPORT.npcs = peds.length + players.length);
  console.log('NPC ' + models.length + ' models, ' + (peds.length + players.length) + ' npcs');
}
function perimPos(off, s) { // s in [0,4): square path
  const side = Math.floor(((s % 4) + 4) % 4), t = (((s % 1) + 1) % 1) * 2 - 1;
  const v = t * off;
  return [[v, -off, 1, 0], [off, v, 0, 1], [-v, off, -1, 0], [-off, -v, 0, -1]][side];
}
function updatePeds(dt) {
  for (const p of peds) {
    if (game.on && !player.inCar && Math.abs(p.o.position.x - player.pos.x) < 1.1 && Math.abs(p.o.position.z - player.pos.z) < 1.1) { p.o.rotation.y = Math.atan2(player.pos.x - p.o.position.x, player.pos.z - p.o.position.z); continue; }
    if (!p.walking) { const [x, z, dx, dz] = perimPos(p.off, p.s); p.o.position.set(p.cx + x, SW, p.cz + z); p.o.rotation.y = Math.atan2(-dz, dx) + (p.dir > 0 ? 0 : 0); continue; }
    p.s += p.dir * p.speed * dt / (p.off * 2);
    const [x, z, dx, dz] = perimPos(p.off, p.s);
    p.o.position.set(p.cx + x, SW, p.cz + z);
    p.o.rotation.y = Math.atan2(dx * p.dir, dz * p.dir);
  }
  for (const pl of players) {
    if (!pl.o) continue;
    const dx = pl.tx - pl.o.position.x, dz = pl.tz - pl.o.position.z, d = Math.hypot(dx, dz);
    if (d < 0.3) { pl.tx = pl.ox + rr(-3.2, 3.2); pl.tz = pl.oz + rr(-7, 7); }
    else { const sp = 3.2 * dt; pl.o.position.x += dx / d * sp; pl.o.position.z += dz / d * sp; pl.o.rotation.y = Math.atan2(dx, dz); }
  }
}

// ---------------------------------------------------------------- smoke, sky traffic, ducks
let smokeMesh, puffs = [];
function initSmoke() {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa9a4a6, roughness: 1, flatShading: true, transparent: true, opacity: 0.92 });
  const per = 18;
  smokeMesh = new THREE.InstancedMesh(geo, mat, smokers.length * per);
  smokeMesh.castShadow = false; smokeMesh.frustumCulled = false;
  smokers.forEach((s, si) => { for (let k = 0; k < per; k++) puffs.push({ s, age: k / per * 6, life: 6, dx: rr(-0.4, 0.4), dz: rr(-0.4, 0.4) }); });
  scene.add(smokeMesh);
}
function updateSmoke(dt) {
  if (!smokeMesh) return;
  puffs.forEach((p, i) => {
    p.age += dt; if (p.age > p.life) { p.age -= p.life; p.dx = rr(-0.4, 0.4); p.dz = rr(-0.4, 0.4); }
    const k = p.age / p.life;
    const sc = (0.9 + k * 3.2) * (k > 0.85 ? (1 - k) / 0.15 : 1) * (p.s.small ? 0.35 : 1);
    const g = p.s.small ? 0.35 : 1; _p.set(p.s.x + (p.dx * k * 6 + k * 5) * g, p.s.y + k * 10 * g, p.s.z + p.dz * k * 6 * g);
    _s.setScalar(Math.max(0.01, sc));
    _q.identity();
    _m.compose(_p, _q, _s); smokeMesh.setMatrixAt(i, _m);
  });
  smokeMesh.instanceMatrix.needsUpdate = true;
}
const flyers = [];
function initFlyers() {
  ['Plane_2_A', 'Plane_1_B', 'Plane_3_B'].forEach((n, i) => { if (proto[n]) { const o = makeObject(n); scene.add(o); flyers.push({ o, r: 380 + i * 90, h: 100 + i * 25, sp: 0.07 - i * 0.015, a: i * 2 }); } });
  if (proto['Helicopter_1_A']) { const o = makeObject('Helicopter_1_A'); scene.add(o); flyers.push({ o, r: 120, h: 55, sp: -0.12, a: 2 }); }
  for (let i = 0; i < 14; i++) { const o = makeObject(pick(['Cloud_1', 'Cloud_2'])); o.scale.setScalar(rr(1.1, 1.8)); o.traverse(m => { if (m.isMesh) { m.castShadow = false; } }); scene.add(o); flyers.push({ o, cloud: true, x: rr(-500, 500), z: rr(-500, 500), h: rr(190, 260), sp: rr(1.5, 3) }); }
  for (const d of ducks) { d.o = makeObject(pick(['Duck_1', 'Duck_2'])); scene.add(d.o); }
}
function updateFlyers(dt, t) {
  for (const f of flyers) {
    if (f.cloud) { f.x += f.sp * dt; if (f.x > 600) f.x = -600; f.o.position.set(f.x, f.h, f.z); continue; }
    f.a += f.sp * dt;
    f.o.position.set(Math.cos(f.a) * f.r, f.h, Math.sin(f.a) * f.r);
    const tx = -Math.sin(f.a) * Math.sign(f.sp), tz = Math.cos(f.a) * Math.sign(f.sp);
    f.o.rotation.y = Math.atan2(tz, -tx) ;
  }
  for (const d of ducks) { d.a += d.s * dt; d.o.position.set(d.c.x + Math.cos(d.a) * d.r, d.c.y, d.c.z + Math.sin(d.a) * d.r); d.o.rotation.y = -d.a; }
}

// ---------------------------------------------------------------- build
const PRESETS = {
  overview: { p: [330, 360, 440], t: [0, 0, 0] },
  centre: { p: [blockC(6) + 70, 80, blockC(6) + 90], t: [blockC(6), 0, blockC(6)] },
  carrefour: { p: [lineX(8) + 40, 52, lineX(4) + 52], t: [lineX(8) - 6, 0, lineX(4) + 4] },
  basket: { p: [blockC(5) - 9 + 30, 36, blockC(8) + 30], t: [blockC(5) - 9, 0, blockC(8)] },
  rue: { p: [lineX(MAIN) + 0.1, 3.2, lineX(MAIN) + 50], t: [lineX(MAIN) + 0.1, 3.4, lineX(MAIN) + 20] },
  parking: { p: [blockC(7) + 30, 34, blockC(5) + 34], t: [blockC(7), 0, blockC(5)] },
  usine: { p: [blockC(0) + 70, 60, blockC(0) + 80], t: [blockC(0) + 10, 0, blockC(0) + 10] },
};
function setPreset(k) { if (game.on && !game.freeCam) setFreeCam(true); const p = PRESETS[k]; camera.position.set(...p.p); controls.target.set(...p.t); controls.update(); }

async function main() {
  await loadAll();
  await loadFBXVehicles();
  await loadJobsPack();
  await loadExtras();
  say('Construction de la ville…');
  catBuildings(); initCarsList();
  environment();
  initBusLines();
  roads();
  const plan = {};
  const T = (i, j, t) => plan[i + ',' + j] = t;
  T(0, 0, 'factoryBig'); T(1, 0, 'factory'); T(0, 1, 'factory'); T(12, 12, 'factoryBig');
  T(4, 9, 'park'); T(9, 4, 'park'); T(10, 10, 'park'); T(2, 5, 'park'); T(8, 7, 'statue');
  T(5, 8, 'basket'); T(9, 9, 'basket'); T(7, 5, 'parking'); T(3, 10, 'parking');
  T(0, 8, 'construction'); T(11, 2, 'construction');
  T(14, 3, 'job:fire'); T(14, 7, 'job:hospital'); T(7, 14, 'job:taxi'); T(10, 14, 'job:delivery'); T(4, 14, 'job:warehouse'); T(14, 11, 'job:garage'); T(14, 5, 'job:gas'); T(12, 14, 'job:gas'); T(0, 14, 'job:gas'); T(1, 14, 'job:garage'); T(14, 14, 'factory');
  // blocks for buildings, ordered from the centre outwards
  const free = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (!plan[i + ',' + j]) free.push([i, j]);
  free.sort((a, b) => Math.hypot(a[0] - 6, a[1] - 6) - Math.hypot(b[0] - 6, b[1] - 6));
  // big buildings: centre block + spread over the rest
  const solo = BUILD.solo.slice();
  const soloAt = new Set(['6,6']);
  const step = Math.max(2, Math.floor(free.length / solo.length));
  for (let k = 1; soloAt.size < solo.length && k < free.length; k += step) soloAt.add(free[k].join());
  for (let k = 0; soloAt.size < solo.length && k < free.length; k++) soloAt.add(free[k].join());
  const queue = BUILD.row.slice();
  const order = free.map(f => f.join());
  for (const key of order) if (!soloAt.has(key)) plan[key] = 'city';
  for (const key of soloAt) plan[key] = 'solo';
  for (const [i, j] of free) {
    const key = i + ',' + j, cx = blockC(i), cz = blockC(j);
    lots.push({ cx, cz });
    if (plan[key] === 'solo') blockTower(cx, cz, i, j, solo.shift());
    else if (queue.length) blockCity(cx, cz, queue, i, j);
    else blockPark(cx, cz, i, j, false);
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const t = plan[i + ',' + j]; if (t === 'city' || t === 'solo') continue;
    const cx = blockC(i), cz = blockC(j);
    lots.push({ cx, cz });
    if (t === 'park') blockPark(cx, cz, i, j, false);
    else if (t === 'statue') blockPark(cx, cz, i, j, true);
    else if (t === 'basket') blockBasket(cx, cz, i, j);
    else if (t === 'parking') blockParking(cx, cz, i, j);
    else if (t === 'factoryBig') blockFactory(cx, cz, i, j, true);
    else if (t === 'factory') blockFactory(cx, cz, i, j, false);
    else if (t === 'construction') blockConstruction(cx, cz, i, j);
    else if (t && t.startsWith('job:')) blockJob(cx, cz, i, j, t.slice(4));
  }
  // report: every building used? overlaps?
  const used = new Set(placed.map(p => p.nm));
  let overlaps = 0;
  for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) {
    const A = placed[a], B = placed[b];
    if (A.x0 < B.x1 - 0.05 && B.x0 < A.x1 - 0.05 && A.z0 < B.z1 - 0.05 && B.z0 < A.z1 - 0.05) overlaps++;
  }
  PLAN = plan;
  window.LEFT = queue.concat(solo); window.REPORT = { left: queue.concat(solo).length, buildingsTotal: BUILD.all.length, buildingsPlaced: placed.length, unique: used.size, leftInQueue: queue.length + solo.length, overlaps };
  console.log('REPORT ' + JSON.stringify(window.REPORT));
  assignServices(); buildFarm(); buildQuarry();
  clearDoorways(); console.log('DOORWAYS cleared ' + DOORWAY_CLEARED);
  const draws = buildInstances();
  buildColliders(); initSignals(); initDoorMarks();
  initSmoke(); initFlyers();
  spawnCars(+(Q.get('cars') || 320));
  spawnBuses();
  if (Q.get('hour')) GT.min = +Q.get('hour') * 60;
  spawnPeds(+(Q.get('peds') || (MOBILE ? 1 : 2)));
  say('');
  console.log('instanced draws', draws, 'buckets', buckets.size, 'FIXED', FIXED.length, 'parked', parkedSpots.length, 'stops', busStops.length, 'rows', JSON.stringify(ROWSTAT), 'roof', JSON.stringify(ROOFSTAT), 'lots', lotsParking.length);
  initDayNight();
  initPlayer(); initHud(); initMissions(); initPaidZone(); initPhone(); initTouchUI(); if (!SHOT) loadGame(); accountInit();
  if (!SHOT) document.getElementById('start').style.display = 'flex';
  setPreset(SHOT && SHOT !== 'play' ? SHOT : 'overview');
  start();
}

// ================================================================ GAMEPLAY
let PLAN = {};
const game = { on: false, freeCam: false };
const keys = new Set();
const player = { pos: new THREE.Vector3(), vy: 0, onGround: true, ch: null, actions: {}, cur: null, inCar: null, heading: 0 };
const cam = { yaw: 0.6, pitch: 0.42, dist: 9 };
const parkedPlayerCars = [];

// ---- colliders (spatial hash)
const CG = 16, cgrid = new Map();
function addCol(x0, z0, x1, z1, h = 0) {
  const c = { x0, z0, x1, z1, h };
  for (let gx = Math.floor(x0 / CG); gx <= Math.floor(x1 / CG); gx++)
    for (let gz = Math.floor(z0 / CG); gz <= Math.floor(z1 / CG); gz++) {
      const k = gx + ',' + gz; if (!cgrid.has(k)) cgrid.set(k, []); cgrid.get(k).push(c);
    }
}
function buildColliders() {
  for (const p of placed) addCol(p.x0 + 0.1, p.z0 + 0.1, p.x1 - 0.1, p.z1 - 0.1, SW + proto[p.nm].bb.max.y);
  for (const e of extraCols) addCol(...e, 30);
  for (const e of propCols) addCol(...e, 0);
  for (const t of camCols) { const k = Math.floor(t.x / CG) + ',' + Math.floor(t.z / CG); if (!camGrid.has(k)) camGrid.set(k, []); camGrid.get(k).push(t); }
}
const camGrid = new Map();
// is a camera point inside something solid?
function camBlocked(x, y, z) {
  const k = Math.floor(x / CG) + ',' + Math.floor(z / CG);
  const list = cgrid.get(k);
  if (list) for (const c of list) if (c.h > 0 && y < c.h && (c.x1 - c.x0 > 0.8 || c.z1 - c.z0 > 0.8) && x > c.x0 - 0.3 && x < c.x1 + 0.3 && z > c.z0 - 0.3 && z < c.z1 + 0.3) return true;
  const tl = camGrid.get(k);
  if (tl) for (const t of tl) if (y > t.y0 && y < t.y1 && (x - t.x) ** 2 + (z - t.z) ** 2 < t.r * t.r) return true;
  return y < 0.3;
}
// push a circle (x,z,r) out of colliders; returns true if it hit something
function collide(v, r) {
  let hit = false;
  const gx = Math.floor(v.x / CG), gz = Math.floor(v.z / CG);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = cgrid.get((gx + i) + ',' + (gz + j)); if (!list) continue;
    for (const c of list) {
      const qx = Math.max(c.x0, Math.min(v.x, c.x1)), qz = Math.max(c.z0, Math.min(v.z, c.z1));
      let dx = v.x - qx, dz = v.z - qz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = true;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); v.x = qx + dx / d * r; v.z = qz + dz / d * r; }
      else { // centre inside the box: leave by the nearest side
        const opts = [[v.x - c.x0, -1, 0], [c.x1 - v.x, 1, 0], [v.z - c.z0, 0, -1], [c.z1 - v.z, 0, 1]].sort((a, b) => a[0] - b[0]);
        const [pen, sx, sz] = opts[0]; v.x += sx * (pen + r); v.z += sz * (pen + r);
      }
    }
  }
  // city limits
  if (!inside && v.x < 5000) { const lim = HALF + 120; v.x = Math.max(-lim, Math.min(lim, v.x)); v.z = Math.max(-lim, Math.min(lim, v.z)); }
  return hit;
}
function groundY(x, z) {
  const lx = x + HALF, lz = z + HALF;
  if (lx < -4 || lz < -4 || lx > N * P + 4 || lz > N * P + 4) return 0;
  const mx = ((lx % P) + P) % P, mz = ((lz % P) + P) % P;
  const inBlock = mx > 4 && mx < P - 4 && mz > 4 && mz < P - 4 && lx > 4 && lz > 4 && lx < N * P - 4 && lz < N * P - 4;
  return inBlock ? SW : RT;
}

// ---- player
function setAnim(name, fade = 0.2) {
  const a = player.actions[name]; if (!a || player.cur === a) return;
  a.reset().play(); if (player.cur) player.cur.crossFadeTo(a, fade, false); player.cur = a;
}
function initPlayer() {
  const name = skinned['Character_1_1_1'] ? 'Character_1_1_1' : Object.keys(skinned)[0];
  player.ch = makeChar(name);
  for (const k of ['Idle_A-loop', 'Walk_A-loop', 'Runing_A-loop', 'Jump_B_InAir-loop']) if (clips[k]) player.actions[k] = player.ch.mixer.clipAction(clips[k]);
  setAnim('Idle_A-loop', 0);
  player.pos.set(lineX(MAIN) + 6, SW, lineX(MAIN) + 9);
  player.ch.o.position.copy(player.pos);
}

// ---- input
addEventListener('keydown', (e) => {
  if (!game.on || UI.open) return;
  keys.add(e.code);
  if (e.code === 'KeyE') { if (!player.onBus && lifeAction()) return; if (!player.onBus && !inside && jobAction()) return; if (!player.inCar && !player.onBus && interiorAction()) return; if (player.inCar || !busAction()) toggleCar(); }
  if (e.code === 'KeyC') setFreeCam(!game.freeCam);
  if (e.code === 'KeyM') document.getElementById('minimap').classList.toggle('hidden');
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
let dragging = false;
renderer.domElement.addEventListener('mousedown', () => {
  if (!game.on || game.freeCam) return;
  dragging = true;
  try { renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock(); } catch (e) {}
});
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (!game.on || game.freeCam) return;
  if (document.pointerLockElement === renderer.domElement || dragging) {
    cam.yaw -= e.movementX * 0.0028;
    cam.pitch = Math.max(0.05, Math.min(1.35, cam.pitch + e.movementY * 0.0022));
  }
});
renderer.domElement.addEventListener('wheel', (e) => {
  if (!game.on || game.freeCam) return;
  cam.dist = Math.max(3.5, Math.min(40, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
}, { passive: true });

// touch: left half = joystick, right half = camera
const touch = { id: null, sx: 0, sy: 0, x: 0, y: 0, cid: null, cx: 0, cy: 0 };
renderer.domElement.addEventListener('touchstart', (e) => {
  if (!game.on || game.freeCam) return;
  for (const t of e.changedTouches) {
    if (t.clientX < innerWidth / 2 && touch.id === null) { touch.id = t.identifier; touch.sx = touch.x = t.clientX; touch.sy = touch.y = t.clientY; }
    else if (touch.cid === null) { touch.cid = t.identifier; touch.cx = t.clientX; touch.cy = t.clientY; }
  }
}, { passive: true });
renderer.domElement.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touch.id) { touch.x = t.clientX; touch.y = t.clientY; }
    if (t.identifier === touch.cid) { cam.yaw -= (t.clientX - touch.cx) * 0.006; cam.pitch = Math.max(0.05, Math.min(1.35, cam.pitch + (t.clientY - touch.cy) * 0.004)); touch.cx = t.clientX; touch.cy = t.clientY; }
  }
}, { passive: true });
let pinch = null;
renderer.domElement.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && touch.id === null) { const [a, b] = e.touches; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); if (pinch) cam.dist = Math.max(3.5, Math.min(40, cam.dist * pinch / d)); pinch = d; } else pinch = null;
}, { passive: true });
renderer.domElement.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) { if (t.identifier === touch.id) touch.id = null; if (t.identifier === touch.cid) touch.cid = null; }
}, { passive: true });

function axis() {
  let f = 0, s = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  if (touch.id !== null) { const dx = (touch.x - touch.sx) / 60, dy = (touch.y - touch.sy) / 60; s += Math.max(-1, Math.min(1, dx)); f += Math.max(-1, Math.min(1, -dy)); }
  return { f: Math.max(-1, Math.min(1, f)), s: Math.max(-1, Math.min(1, s)) };
}

// ---- vehicles
function nearestCar() {
  let best = null, bd = 4.2;
  if (player.onBus) return null;
  for (const c of cars) { if (c.route) continue; const d = c.obj.position.distanceTo(player.pos); if (d < bd) { bd = d; best = { c, ai: true }; } }
  for (const sp of parkedSpots) { const d = Math.hypot(sp.x - player.pos.x, sp.z - player.pos.z); if (d < bd) { bd = d; best = { c: sp, spot: true }; } }
  for (const c of parkedPlayerCars) { const d = c.obj.position.distanceTo(player.pos); if (d < bd) { bd = d; best = { c, ai: false }; } }
  return best;
}
function toggleCar() {
  if (player.inCar) {
    const car = player.inCar;
    if (Math.abs(car.speed) > 4) return;
    const h = car.obj.rotation.y, fx = -Math.sin(h), fz = -Math.cos(h);
    for (const side of [1, -1]) {
      const v = new THREE.Vector3(car.obj.position.x + fz * 2.1 * side, 0, car.obj.position.z - fx * 2.1 * side);
      const before = v.clone(); collide(v, 0.4);
      if (v.distanceTo(before) < 0.01 || side === -1) { player.pos.set(v.x, groundY(v.x, v.z), v.z); break; }
    }
    car.speed = 0;
    parkedPlayerCars.push(car);
    player.inCar = null; onCarParked(car);
    player.ch.o.visible = true;
    return;
  }
  if (inside) return;
  const n = nearestCar(); if (!n) return;
  let car;
  if (n.spot) {
    const sp = n.c; parkedSpots.splice(parkedSpots.indexOf(sp), 1); hideInstance(sp.h);
    const obj = makeObject(sp.name); obj.position.set(sp.x, SW + 0.24, sp.z); obj.rotation.y = sp.rot; scene.add(obj);
    car = { obj, speed: 0 };
  } else if (n.ai) { cars.splice(cars.indexOf(n.c), 1); car = { obj: n.c.obj, speed: n.c.v || 0 }; }
  else { parkedPlayerCars.splice(parkedPlayerCars.indexOf(n.c), 1); car = n.c; }
  player.inCar = car;
  player.ch.o.visible = isTwo(car.obj); if (isTwo(car.obj)) play(player.ch, 'Idle_A-loop');
  cam.yaw = car.obj.rotation.y;
}
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
function updatePlayerCar(dt) {
  const car = player.inCar, o = car.obj;
  const { f, s } = axis();
  const brake = keys.has('Space');
  const MAXF = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 30 : 20) * (car.power ? Math.max(0.55, Math.min(1.35, car.power / 130)) : 1), MAXR = -7;
  if (f > 0 && (car.fuel ?? 100) > 0) car.speed += (car.speed < 0 ? 22 : 9) * f * dt;
  else if (f < 0) car.speed += (car.speed > 0 ? -24 : -7) * -f * dt;
  else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 4 * dt);
  if (brake) car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 30 * dt);
  car.speed = Math.max(MAXR, Math.min(MAXF * ((car.hp ?? 100) < 30 ? 0.5 : 1), car.speed));
  const steer = -s * Math.min(1, Math.abs(car.speed) / 5) * (car.speed >= 0 ? 1 : -1);
  o.rotation.y += steer * 1.8 * dt * (1 - Math.min(0.5, Math.abs(car.speed) / 60));
  const h = o.rotation.y, fx = -Math.sin(h), fz = -Math.cos(h);
  o.position.x += fx * car.speed * dt; o.position.z += fz * car.speed * dt;
  // collisions: two circles along the car
  let hit = false;
  for (const k of [1.25, -1.25]) {
    _c1.set(o.position.x + fx * k, 0, o.position.z + fz * k); _c2.copy(_c1);
    if (collide(_c1, 1.0)) { hit = true; o.position.x += _c1.x - _c2.x; o.position.z += _c1.z - _c2.z; }
  }
  for (const c of cars.concat(parkedPlayerCars)) {
    const dx = o.position.x - c.obj.position.x, dz = o.position.z - c.obj.position.z, d = Math.hypot(dx, dz);
    if (d < 2.6 && d > 0.01) { hit = true; o.position.x += dx / d * (2.6 - d); o.position.z += dz / d * (2.6 - d); }
  }
  for (const sp of parkedSpots) {
    const dx = o.position.x - sp.x, dz = o.position.z - sp.z; if (Math.abs(dx) > 4 || Math.abs(dz) > 4) continue;
    const d = Math.hypot(dx, dz); if (d < 2.4 && d > 0.01) { hit = true; o.position.x += dx / d * (2.4 - d); o.position.z += dz / d * (2.4 - d); }
  }
  for (const p of peds) {
    const dx = p.o.position.x - o.position.x, dz = p.o.position.z - o.position.z, d = Math.hypot(dx, dz);
    if (d < 1.9 && Math.abs(car.speed) > 0.5) { car.speed *= 0.5; }
  }
  if (gateBlock(car)) hit = true;
  if (hit) { car.hp = Math.max(0, (car.hp ?? 100) - Math.min(25, Math.abs(car.speed) * 1.2)); car.speed *= -0.25; }
  const gy = groundY(o.position.x, o.position.z) + 0.24;
  o.position.y += (gy - o.position.y) * Math.min(1, dt * 12);
  player.pos.copy(o.position);
  // camera trails behind the car
  if (Math.abs(car.speed) > 1 && !dragging && document.pointerLockElement !== renderer.domElement) {
    let d = h - cam.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); cam.yaw += d * Math.min(1, dt * 2.5);
  }
}
function updatePlayerFoot(dt) {
  const { f, s } = axis();
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const fwdx = -Math.sin(cam.yaw), fwdz = -Math.cos(cam.yaw);
  const rx = -fwdz, rz = fwdx;
  let mx = fwdx * f + rx * s, mz = fwdz * f + rz * s;
  const len = Math.hypot(mx, mz);
  const sp = run ? 6.2 : 2.4;
  if (len > 0.01) {
    mx /= len; mz /= len;
    const k = Math.min(1, len);
    player.pos.x += mx * sp * k * dt; player.pos.z += mz * sp * k * dt;
    const target = Math.atan2(mx, mz);
    let d = target - player.heading; d = Math.atan2(Math.sin(d), Math.cos(d)); player.heading += d * Math.min(1, dt * 12);
  }
  collide(player.pos, 0.38);
  for (const c of cars.concat(parkedPlayerCars)) {
    const dx = player.pos.x - c.obj.position.x, dz = player.pos.z - c.obj.position.z, d = Math.hypot(dx, dz);
    if (d < 1.7 && d > 0.01) { player.pos.x += dx / d * (1.7 - d); player.pos.z += dz / d * (1.7 - d); }
  }
  for (const sp of parkedSpots) {
    const dx = player.pos.x - sp.x, dz = player.pos.z - sp.z; if (Math.abs(dx) > 3 || Math.abs(dz) > 3) continue;
    const d = Math.hypot(dx, dz); if (d < 1.6 && d > 0.01) { player.pos.x += dx / d * (1.6 - d); player.pos.z += dz / d * (1.6 - d); }
  }
  const g = groundY(player.pos.x, player.pos.z);
  if (keys.has('Space') && player.onGround) { player.vy = 5.2; player.onGround = false; }
  player.vy -= 15 * dt; player.pos.y += player.vy * dt;
  if (player.pos.y <= g) { player.pos.y = g; player.vy = 0; player.onGround = true; }
  else if (player.onGround && player.pos.y - g < 0.35) { player.pos.y = g; player.vy = 0; } // step down kerbs
  else player.onGround = false;
  const o = player.ch.o; o.position.copy(player.pos); o.rotation.y = player.heading;
  if (!player.onGround) setAnim('Jump_B_InAir-loop', 0.1);
  else if (len < 0.01) setAnim('Idle_A-loop');
  else setAnim(run ? 'Runing_A-loop' : 'Walk_A-loop');
}
const _ct = new THREE.Vector3();
function updateGameCamera(dt) {
  const t = player.pos;
  const dist = player.onBus ? Math.max(cam.dist, 13) : player.inCar ? Math.max(cam.dist, 10) : cam.dist;
  _ct.set(t.x, t.y + (player.inCar || player.onBus ? 1.8 : 1.5), t.z);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const dx = Math.sin(cam.yaw) * cp, dy = sp, dz = Math.cos(cam.yaw) * cp;
  let d = 0.6;
  for (; d < dist; d += 0.25) if (camBlocked(_ct.x + dx * d, _ct.y + dy * d, _ct.z + dz * d)) { d = Math.max(0.6, d - 0.35); break; }
  d = Math.min(d, dist);
  cam.cur = cam.cur === undefined ? d : (d < cam.cur ? d : cam.cur + (d - cam.cur) * Math.min(1, dt * 3));
  camera.position.set(_ct.x + dx * cam.cur, _ct.y + dy * cam.cur, _ct.z + dz * cam.cur);
  if (camera.position.y < _ct.y - 1) camera.position.y = _ct.y - 1;
  camera.lookAt(_ct);
  controls.target.copy(_ct);
  // never look through the player's own head: hide the body when the camera is pushed right against it
  if (!player.inCar) player.ch.o.visible = cam.cur > 1.3;
}

// ---- HUD
const hud = {};
function initHud() {
  hud.speed = document.getElementById('speed');
  hud.prompt = document.getElementById('prompt');
  hud.mm = document.getElementById('minimap');
  hud.ctx = hud.mm.getContext('2d');
  // static background
  const S = 220, bg = document.createElement('canvas'); bg.width = bg.height = S;
  const g = bg.getContext('2d'), k = S / (N * P);
  g.fillStyle = '#7cc653'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#3c3f47'; g.fillRect(0, 0, S, S);
  const col = { park: '#5fbf4a', statue: '#5fbf4a', basket: '#4f9be8', parking: '#6a6d75', factoryBig: '#c46a5a', factory: '#c46a5a', construction: '#d6b06e', solo: '#8f9cc9', city: '#c9ccd6' };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    g.fillStyle = col[PLAN[i + ',' + j]] || '#c9ccd6';
    g.fillRect((i * P + 4) * k, (j * P + 4) * k, BLK * k, BLK * k);
  }
  g.fillStyle = 'rgba(40,44,60,.55)';
  for (const p of placed) g.fillRect((p.x0 + HALF) * k, (p.z0 + HALF) * k, Math.max(1, (p.x1 - p.x0) * k), Math.max(1, (p.z1 - p.z0) * k));
  hud.bg = bg; hud.k = k; hud.S = S;
}
let hudT = 0;
function updateHud(dt) {
  hudT += dt;
  const car = player.inCar;
  hud.speed.textContent = car ? Math.round(Math.abs(car.speed) * 3.6) + ' km/h' : '';
  hud.speed.style.display = car ? 'block' : 'none';
  let msg = lifePrompt() || jobPrompt() || interiorPrompt() || busPrompt();
  if (msg) {}
  else if (car) msg = Math.abs(car.speed) > 4 ? '' : 'E : descendre';
  else if (nearestCar()) msg = 'E : monter dans le véhicule';
  if (hud.prompt.textContent !== msg) { hud.prompt.textContent = msg; hud.prompt.style.display = msg ? 'block' : 'none'; }
  if (hudT < 0.1 || hud.mm.classList.contains('hidden')) return;
  hudT = 0;
  const c = hud.ctx, k = hud.k, S = hud.S;
  c.clearRect(0, 0, S, S); c.drawImage(hud.bg, 0, 0);
  c.fillStyle = '#ffd23f';
  for (const v of cars) c.fillRect((v.obj.position.x + HALF) * k - 1, (v.obj.position.z + HALF) * k - 1, 2, 2);
  c.fillStyle = '#ffffff';
  for (const v of parkedPlayerCars) c.fillRect((v.obj.position.x + HALF) * k - 1.5, (v.obj.position.z + HALF) * k - 1.5, 3, 3);
  drawPaidOnMap(c, k); drawBusOnMap(c, k); drawDoorsOnMap(c, k); drawJobsOnMap(c, k); drawLifeOnMap(c, k);
  drawMissionsOnMap(c, k);
  const px = (player.pos.x + HALF) * k, pz = (player.pos.z + HALF) * k;
  const h = car ? car.obj.rotation.y + Math.PI : player.heading;
  c.save(); c.translate(px, pz); c.rotate(-h + Math.PI);
  c.fillStyle = '#ff3b3b'; c.strokeStyle = '#fff'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, -7); c.lineTo(5, 5); c.lineTo(0, 2); c.lineTo(-5, 5); c.closePath(); c.fill(); c.stroke();
  c.restore();
}

function setFreeCam(v) {
  game.freeCam = v;
  controls.enabled = v;
  if (document.pointerLockElement) document.exitPointerLock();
  document.getElementById('modeBtn').textContent = v ? 'Reprendre le jeu (C)' : 'Caméra libre (C)';
  if (!v) controls.target.copy(player.pos);
}
window.setFreeCam = setFreeCam;
window.__dbg = () => ({ x: +player.pos.x.toFixed(2), z: +player.pos.z.toFixed(2), inCar: !!player.inCar, dist: +cam.dist.toFixed(1), yaw: +cam.yaw.toFixed(2), on: game.on, mobile: MOBILE, touchUI: document.body.classList.contains('touch') });
window.startGame = (free) => {
  if (MOBILE && !SHOT) { const el = document.documentElement; try { (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el)?.then?.(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch?.(() => {}); } catch (e) {} }
  document.getElementById('start').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  game.on = true;
  setFreeCam(!!free);
  if (free) setPreset('overview');
};

function updateGame(dt) {
  obstacles.length = 0;
  if (!game.on) return;
  if (player.onBus) player.pos.copy(player.onBus.obj.position);
  else if (player.inCar) updatePlayerCar(dt); else updatePlayerFoot(dt);
  updateMissions(dt);
  updateInterior(dt);
  updateJobs(dt);
  updateLife(dt);
  obstacles.push({ x: player.pos.x, z: player.pos.z });
  for (const c of parkedPlayerCars) obstacles.push({ x: c.obj.position.x, z: c.obj.position.z });
  if (!game.freeCam) updateGameCamera(dt);
  updateHud(dt);
}

// ================================================================ JOBS (métiers) & job buildings
async function loadJobsPack() {
  say('Chargement des métiers…');
  const idx = await (await fetch(BASE + 'jindex.json')).json();
  const buf = await (await fetch(BASE + 'jpack.bin')).arrayBuffer();
  const loader = new GLTFLoader();
  await Promise.all(Object.entries(idx).map(async ([name, [off, len]]) => {
    try {
      const g = await loader.parseAsync(buf.slice(off, off + len), '');
      g.scene.updateMatrixWorld(true);
      const parts = [];
      g.scene.traverse(o => { if (o.isMesh) { const mats = Array.isArray(o.material) ? o.material : [o.material]; if (mats.length === 1) parts.push({ geo: o.geometry, mat: sharedMat(mats[0]), mtx: o.matrixWorld.clone() }); else for (const grp of o.geometry.groups) { const geo = o.geometry.clone(); geo.clearGroups(); geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(grp.start, grp.start + grp.count), 1)); parts.push({ geo, mat: sharedMat(mats[grp.materialIndex]), mtx: o.matrixWorld.clone(), wheel: isWheel(o) }); } } });
      proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(g.scene) };
    } catch (e) { console.warn('job', name, e); }
  }));
}
const pickP = (re) => { const a = Object.keys(proto).filter(n => re.test(n)); return a.length ? a[Math.floor(rnd() * a.length)] : null; };

// ---- floating text signs
// flat sign plate fixed on a facade (faces +Z locally, rotate toward the street)
function textPlaque(text, bg, w = 2.8) {
  const s = textSprite(text, bg, '#ffffff', w); scene.remove(s);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: s.material.map, toneMapped: false, transparent: true }));
  scene.add(m); return m;
}
function textSprite(text, bg = '#1d2740', fg = '#ffffff', scale = 7) {
  if (typeof bg === 'number') bg = '#' + bg.toString(16).padStart(6, '0');
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, 504, 120, 28); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.stroke();
  let fs = 60; const fam = 'px system-ui, Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif';
  g.font = 'bold ' + fs + fam; while (fs > 24 && g.measureText(text).width > 470) { fs -= 4; g.font = 'bold ' + fs + fam; }
  g.fillStyle = fg;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, toneMapped: false, fog: false }));
  s.scale.set(scale, scale / 4, 1); scene.add(s); return s;
}

// ---- definitions
const JOBS = {
  pompier: { icon: '🚒', label: 'Pompier', color: 0xe53935, building: 'fire' },
  ambulancier: { icon: '🚑', label: 'Ambulancier', color: 0xf5f5f5, building: 'hospital' },
  taxi: { icon: '🚕', label: 'Chauffeur de taxi', color: 0xffc21a, building: 'taxi' },
  livreur: { icon: '📦', label: 'Livreur', color: 0x8d6e63, building: 'delivery' },
  fermier: { icon: '🌾', label: 'Fermier', color: 0x8bc34a, building: 'farm' },
  recolteur: { icon: '⛏️', label: 'Récolteur', color: 0x90a4ae, building: 'quarry' },
};
const JB = {
  fire: { label: '🚒 Caserne de pompiers', model: 'Building_12_A', color: '#c62828', job: 'pompier', veh: ['FIRE', 'FIRE', 'FIRE'] },
  hospital: { label: '🏥 Hôpital', model: 'Building_23_A', color: '#1e88e5', job: 'ambulancier', veh: ['C_Ambulance', 'Ambulance', 'C_Ambulance'] },
  taxi: { label: '🚕 Agence de taxis', model: 'Building_14_A', color: '#f9a825', job: 'taxi', veh: ['C_Taxi', 'Taxi', 'C_Taxi', 'Taxi_2'] },
  delivery: { label: '🚚 Dépôt de livraison', model: 'Building_Factory_2_A', color: '#6d4c41', job: 'livreur', veh: ['C_Pizza_Time', 'C_X_van', 'Van_3', 'PostCar_4'] },
  warehouse: { label: '📦 Entrepôt logistique', model: 'Building_Factory_1_A', color: '#5d4037', sell: true },
  gas: { label: '⛽ Station-service', model: 'X_Gas_station', color: '#f9a825', gas: true },
  garage: { label: '🔧 Garage & atelier', model: 'X_Garage', color: '#455a64', garage: true },
};
const jobSpots = [];
const pumpSpots = [], repairSpots = [], stationVisitors = [];
function stopRing(color) { const m = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.9, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false })); m.position.y = SW + 0.05; scene.add(m); return m; } // { kind, pos, label, sprite, mk, building }
const J = { job: null, task: null, inv: {}, cooldown: 0, spray: 0, fires: [] };
const INV_MAX = 40;
const PRICES = { pierre: 4, bois: 5, cuivre: 10, fer: 12, argent: 18, or: 30, gemme: 50, legumes: 8 };

// ---- job building block (placed on a city block)
const jobLots = [];
function blockJob(cx, cz, bi, bj, kind) {
  const def = JB[kind]; jobLots.push({ cx, cz });
  blockBase(cx, cz, { interior: 'StreetTile_1_A_1' });
  const excl = busExcl(bi, bj);
  const lanes = kind === 'gas' ? [-12, 12] : [0];
  excl.S = (excl.S || []).concat(lanes.map(t => [t - 4.2, t + 4.2]));
  if (kind !== 'gas' && kind !== 'garage') driveway(cx, cz, 'S', 0, 10);
  else for (const t of lanes) put('ParkingRoad_A_5', cx + t, SW - 0.3, cz + 20, 0);
  sidewalkProps(cx, cz, bi, bj, { excl, noBays: true });
  const nm = proto[def.model] ? def.model : pickP(/^Building_1_1_/);
  let f = footprint(nm, 0);
  if ((f.maxx - f.minx) > 40 || (f.maxz - f.minz) > 26) f = footprint(nm, Math.PI / 2);
  const rot = (footprint(nm, 0).maxx - footprint(nm, 0).minx) > 40 || (footprint(nm, 0).maxz - footprint(nm, 0).minz) > 26 ? Math.PI / 2 : 0;
  const w = f.maxx - f.minx, d = f.maxz - f.minz, x0 = cx - w / 2, z0 = cz - 20;
  putAt(nm, x0, z0, SW, rot);
  placed.push({ nm, x0, z0, x1: x0 + w, z1: z0 + d });
  // forecourt asphalt
  const fz0 = z0 + d + 0.5, fz1 = cz + 20;
  if ((kind === 'gas' || kind === 'garage')) { /* forecourt made of pack tiles below */ }
  else if (fz1 - fz0 > 2) flat(40, fz1 - fz0, cx, SW + 0.015, (fz0 + fz1) / 2);
  const sp = textPlaque(def.label, def.color, 4); sp.position.set(cx, SW + Math.min(proto[nm].bb.max.y, 10) + 1.5, z0 + d + 0.5);
  // service vehicles parked in the forecourt
  if (def.veh) def.veh.forEach((v, i) => {
    const x = cx - 14 + i * 4.5, z = Math.min(fz1 - 3, fz0 + 3.5);
    const vv = proto[v] ? v : v.replace(/^C_/, ''); const obj = v === 'FIRE' ? makeFireTruck() : (proto[vv] ? makeObject(vv) : null);
    if (!obj) return;
    obj.position.set(x, SW + 0.24, z); obj.rotation.y = Math.PI; scene.add(obj);
    parkedPlayerCars.push({ obj, speed: 0, kind: v === 'FIRE' ? 'fire' : v });
  });
  if (kind === 'warehouse') for (let k = 0; k < 10; k++) { const n = pickP(/^K_(Containers|Pallet|Parts|Fuel)/); if (n) put(n, cx + rr(6, 18), SW, cz + rr(fz0 - cz + 1, 18), rr(0, 6), 1.6); }
  if (kind === 'gas') {
    for (let x = -16; x <= 16; x += 8) for (const z of [4, 12]) put('ParkingRoad_A_5', cx + x, SW - 0.3, cz + z, 0);
    const pumps = [new THREE.Vector3(cx - 4.5, SW, cz + 7), new THREE.Vector3(cx + 4.5, SW, cz + 7)];
    for (const p of pumps) { const r = stopRing(0xf9a825); r.position.copy(p); pumpSpots.push(p); }
    for (let k = 0; k < 2; k++) stationVisitors.push({ cx, cz, pump: pumps[k], t: k * 14, car: null });
    if (proto.X_Station) { putAt('X_Station', cx + 9, cz - 20, SW, 0); const f = footprint('X_Station', 0); placed.push({ nm: 'X_Station', x0: cx + 9, z0: cz - 20, x1: cx + 9 + f.maxx - f.minx, z1: cz - 20 + f.maxz - f.minz }); registerDoor(cx + 9 + (f.maxx - f.minx) / 2, cz - 20 + (f.maxz - f.minz) + 0.7, 0, 1); const d = doors[doors.length - 1]; d.service = 'station'; d.type = 'service'; } return; }
  if (kind === 'garage') {
    const bays = [];
    for (let x = -16; x <= 16; x += 8) for (const [z, r] of [[4, Math.PI], [12, 0]]) {
      put('ParkingRoad_A_3', cx + x, SW - 0.39, cz + z, r);
      const dir = r === 0 ? -1 : 1; for (const dz of [-1.5, 1.5]) bays.push([cx + x + 0.8 * -dir, cz + z + dz, dir > 0 ? Math.PI / 2 : -Math.PI / 2]);
    }
    const free = bays.splice(4, 1)[0];
    for (const [x, z, r] of bays) if (chance(0.7)) parkCar(pick(CARS), x, z, r);
    const ring = stopRing(0x90caf9); ring.position.set(free[0], SW, free[1]); repairSpots.push(ring.position.clone());
    put('ForkLift', cx + 14, SW, cz + 14, 1); for (let k = 0; k < 6; k++) { const n = pickP(/^K_(Parts|Fuel)/); if (n) put(n, cx + rr(8, 18), SW, cz + rr(10, 18), rr(0, 6), 1.4); } }
  // interaction spot in front of the main door
  const pos = new THREE.Vector3(cx + 8, SW, Math.min(fz1 - 1.5, z0 + d + 2));
  if (def.gas) return;
  const mk = makeMarker(def.job ? JOBS[def.job].color : (def.garage ? 0x90caf9 : 0xffb74d), 6); mk.position.copy(pos);
  jobSpots.push({ kind, def, pos, sprite: sp, mk, cx, cz });
}
function makeFireTruck() {
  if (proto.C_Fire_Truck) { const g = makeObject('C_Fire_Truck'); g.userData.fire = true; return g; }
  const base = proto['Ambulance'] ? 'Ambulance' : 'Ambulance_2_A';
  const g = new THREE.Group();
  for (const p of proto[base].parts) {
    const m = new THREE.Mesh(p.geo, p.mat.clone()); m.material.color = new THREE.Color(1.0, 0.32, 0.26); m.applyMatrix4(p.mtx); m.castShadow = true; g.add(m);
  }
  // ladder on the roof
  const lad = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.15, 3.6), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.4 }));
  lad.position.set(0, proto[base].bb.max.y + 0.1, 0.2); g.add(lad);
  g.userData.fire = true;
  return g;
}

// ---- farm & quarry outside the grid
const plots = [], nodes = [], sheep = [];
function buildFarm() {
  const zc = HALF + 62, xc = -40;
  const ground = flat(150, 90, xc + 20, 0.02, zc, new THREE.MeshStandardMaterial({ color: 0x9ccc65, roughness: 1 }));
  const sp = textPlaque('🌾 Ferme', '#558b2f', 7); sp.position.set(xc - 30, 9, zc - 30);
  // farmhouse + barn-like shed + hay
  const house = pickP(/^Building_1_[23]_/) || 'Building_1_1_A'; putAt(house, xc - 48, zc - 40, 0, 0); { const f = footprint(house, 0); placed.push({ nm: house, x0: xc - 48, z0: zc - 40, x1: xc - 48 + f.maxx - f.minx, z1: zc - 40 + f.maxz - f.minz }); }
  for (let k = 0; k < 10; k++) put(pick(['N_Hay_1_A', 'N_Hay_2_A', 'N_Hay_1_C'].filter(n => proto[n])), xc - 40 + rr(-6, 10), 0, zc + rr(-5, 30), rr(0, 6));
  // 8 plots (5.2 x 13.4 each)
  for (let k = 0; k < 8; k++) {
    const x = xc - 10 + (k % 4) * 8, z = zc - 22 + Math.floor(k / 4) * 20;
    const pl = { x, z, state: 'vide', t: 0, objs: [] };
    plots.push(pl); setPlot(pl);
  }
  // fences around + sheep
  for (let x = xc - 55; x <= xc + 95; x += 4) { put('Fence_1_A_3', x, 0, zc - 45, Math.PI / 2); put('Fence_1_A_3', x, 0, zc + 45, Math.PI / 2); }
  for (let k = 0; k < 8; k++) if (proto.N_Sheep) { const o = makeObject('N_Sheep'); o.position.set(xc + 55 + rr(-15, 15), 0, zc + rr(-25, 25)); scene.add(o); sheep.push({ o, a: rr(0, 6), t: rr(0, 4) }); }
  // market stand to sell vegetables
  const mpos = new THREE.Vector3(xc - 25, 0, zc - 20);
  if (proto.MarketSign_1_A) put('MarketSign_1_A', mpos.x, 0, mpos.z - 2.5, 0);
  if (proto.K_Food_Crate_Large_Apples) put('K_Food_Crate_Large_Apples', mpos.x + 2, 0, mpos.z - 2, 0, 1.6);
  const mk = makeMarker(JOBS.fermier.color, 6); mk.position.copy(mpos);
  jobSpots.push({ kind: 'farm', def: { label: '🌾 Ferme', job: 'fermier' }, pos: mpos, mk, sprite: sp });
}
function setPlot(pl) {
  for (const o of pl.objs) scene.remove(o); pl.objs = [];
  const add = (n, x, z, r = 0, y = 0) => { if (!proto[n]) return; const o = makeObject(n); o.position.set(x, y, z); o.rotation.y = r; scene.add(o); pl.objs.push(o); };
  if (pl.state === 'mur') add('N_Field_1_2_A', pl.x, pl.z);
  else add('N_Field_1_1_A', pl.x, pl.z);
  if (pl.state === 'seme' || pl.state === 'pousse') for (let k = 0; k < 10; k++) add(pl.state === 'pousse' ? 'N_Lettuce_A' : 'N_Carrot_A', pl.x + rr(-1.8, 1.8), pl.z + rr(-5.5, 5.5), rr(0, 6), 0.25);
}
function buildQuarry() {
  const zc = -HALF - 62, xc = 30;
  flat(170, 90, xc, 0.02, zc, new THREE.MeshStandardMaterial({ color: 0xbcaaa4, roughness: 1 }));
  if (proto.C_Quarry) { const o = makeObject('C_Quarry'); o.position.set(xc - 70, 0.24, zc + 30); o.rotation.y = 1; scene.add(o); parkedPlayerCars.push({ obj: o, speed: 0 }); }
  if (proto.C_Truck) { const o = makeObject('C_Truck'); o.position.set(xc - 62, 0.24, zc + 30); o.rotation.y = 1; scene.add(o); parkedPlayerCars.push({ obj: o, speed: 0 }); }
  const sp = textPlaque('⛏️ Carrière & forêt', '#546e7a', 7); sp.position.set(xc - 60, 9, zc + 38);
  const kinds = [
    ['pierre', /^N_Rock_/, 30, 1.6], ['pierre', /^K_Stone_Chunks/, 8, 2.2], ['cuivre', /^K_Copper_Nugget/, 8, 3], ['fer', /^K_Iron_Nugget/, 8, 3],
    ['argent', /^K_Silver_Nugget/, 5, 3], ['or', /^K_Gold_Nugget/, 4, 3], ['gemme', /^K_Gem_Large/, 3, 3], ['bois', /^N_(Conifer|Big|Poplar)/, 24, 1.3],
  ];
  for (const [res, re, n, sc] of kinds) for (let k = 0; k < n; k++) {
    const name = pickP(re); if (!name) continue;
    const pos = new THREE.Vector3(xc + rr(-78, 78), 0, zc + rr(-40, 40));
    if (res === 'bois' && pos.x < xc + 20) pos.x += 60;
    const o = makeObject(name); o.position.copy(pos); o.rotation.y = rr(0, 6); o.scale.setScalar(sc); scene.add(o);
    nodes.push({ res, pos, o, alive: true, t: 0, sc });
    if (res === 'bois' || res === 'pierre') addCol(pos.x - 0.6, pos.z - 0.6, pos.x + 0.6, pos.z + 0.6, 0);
  }
}

// ---- tasks
function sidewalkTarget(minD, maxD, from = player.pos) { return sidewalkPoint(minD, maxD, from); }
function nearestSpot(kind) { return jobSpots.find(s => s.kind === kind); }
function startFire() {
  const cands = doors.filter(d => Math.hypot(d.x - player.pos.x, d.z - player.pos.z) > 80 && Math.hypot(d.x - player.pos.x, d.z - player.pos.z) < 350);
  const d = cands.length ? pick(cands) : pick(doors);
  const g = new THREE.Group(); scene.add(g);
  const flames = [];
  const fm = [new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0.9, toneMapped: false }), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, toneMapped: false })];
  for (let k = 0; k < 16; k++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(rr(0.5, 1.1), rr(1.8, 3.4), 7), fm[k % 2]);
    c.position.set(d.x - d.out[0] * 1.5 + (d.out[1] ? rr(-4, 4) : 0), SW + rr(0.8, 7), d.z - d.out[1] * 1.5 + (d.out[0] ? rr(-4, 4) : 0));
    g.add(c); flames.push({ c, base: c.position.y, ph: rr(0, 6) });
  }
  const smoke = [];
  const sm = new THREE.MeshStandardMaterial({ color: 0x555555, transparent: true, opacity: 0.6, roughness: 1, flatShading: true });
  for (let k = 0; k < 12; k++) { const s = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), sm); g.add(s); smoke.push({ s, t: k / 12 }); }
  const light = new THREE.PointLight(0xff7a1a, 30, 25); light.position.set(d.x, SW + 4, d.z); g.add(light);
  J.task = { type: 'fire', door: d, g, flames, smoke, pos: new THREE.Vector3(d.x + d.out[0] * 3, SW, d.z + d.out[1] * 3), hp: 100, t: 0, limit: 200, goal: 'Incendie signalé ! Prends le camion de pompiers' };
  banner('🚒 Incendie signalé !', 2000);
}
function startPatient() {
  const p = sidewalkTarget(80, 320);
  const ch = makeChar(pick(Object.keys(skinned)));
  ch.o.position.copy(p); const a = ch.mixer.clipAction(clips['Death_A'] || Object.values(clips)[0]); a.setLoop(THREE.LoopOnce); a.clampWhenFinished = true; a.play(); a.time = a.getClip().duration - 0.01;
  const hosp = nearestSpot('hospital');
  J.task = { type: 'patient', ch, pos: p, stage: 'pick', dest: hosp ? hosp.pos.clone() : p, t: 0, limit: 180, mk: makeMarker(0xffffff, 30), goal: 'Va chercher le blessé en ambulance' };
  J.task.mk.position.copy(p);
  banner('🚑 Urgence : blessé signalé', 2000);
}
function startFare() {
  const p = sidewalkTarget(30, 160), dest = sidewalkTarget(150, 450, p);
  const ch = makeChar(pick(Object.keys(skinned))); ch.o.position.copy(p); play(ch, 'Idle_B-loop');
  J.task = { type: 'fare', ch, pos: p, dest, stage: 'pick', t: 0, limit: 240, mk: makeMarker(0xffc21a, 30), goal: 'Va chercher le client' };
  J.task.mk.position.copy(p);
}
function startDeliveries() {
  const ds = []; const pool = doors.filter(d => Math.hypot(d.x - player.pos.x, d.z - player.pos.z) < 420);
  for (let k = 0; k < 4 && pool.length; k++) ds.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  J.task = { type: 'deliver', stage: 'load', list: ds, t: 0, limit: 400, mks: [], goal: 'Charge les colis au dépôt (E au marqueur, en véhicule)' };
}
function clearTask() {
  const t = J.task; if (!t) return;
  if (t.g) scene.remove(t.g);
  if (t.mk) scene.remove(t.mk);
  if (t.mks) t.mks.forEach(m => scene.remove(m));
  if (t.ch) { scene.remove(t.ch.o); const i = mixers.indexOf(t.ch.mixer); if (i >= 0) mixers.splice(i, 1); }
  J.task = null; J.cooldown = 4;
}
function pay(n, why) { n = garnish(n); M.money += n; banner(why + ' +' + n + ' $', 2200); updateMissionHud(); }
function invCount() { return Object.values(J.inv).reduce((a, b) => a + b, 0); }

// ---- E key
function jobAction() {
  const car = player.inCar;
  // job spots (take / quit job, sell, garage)
  for (const s of jobSpots) {
    if (Math.hypot(s.pos.x - player.pos.x, s.pos.z - player.pos.z) > (car ? 6 : 2.6)) continue;
    if (s.def.sell) { if (car) { sellAll(); return true; } openMenu(s.def.label || '🏭', [{ t: '💰 Vendre mes ressources (' + invCount() + ')', fn: () => sellAll() }, { t: '🏭 Travailler 25 s (+40 $)', fn: () => { closeMenu(); work(25, 40, s.kind === 'factory' ? 'Travail à l’usine' : 'Manutention'); }, keep: false }]); return true; }
    if (s.kind === 'farm' && J.job === 'fermier' && J.inv.legumes) { sellAll(['legumes']); return true; }
    if (s.def.garage) { if (car) { if (payMoney(20)) { car.hp = 100; car.speed = 0; banner('🔧 Véhicule réparé (−20 $)', 1600); } } else buyCar(s); return true; }
    if (s.kind === 'delivery' && J.task && J.task.type === 'deliver' && J.task.stage === 'load') {
      J.task.stage = 'go'; J.task.mks = J.task.list.map(d => { const m = makeMarker(0x8d6e63, 20); m.position.set(d.x, SW, d.z); return m; });
      J.task.goal = 'Livre les colis : ' + J.task.list.length + ' restants'; banner('📦 4 colis chargés', 1500); return true;
    }
    if (car) continue;
    if (s.kind === 'hospital') { const hd = hospitalDoor(); if (hd) enterDoor(hd); return true; }
    const jb = s.def.job; if (!jb) continue;
    if (J.job === jb) { clearTask(); J.job = null; banner('Tu as quitté le métier', 1500); }
    else { clearTask(); J.job = jb; J.cooldown = 1; banner(JOBS[jb].icon + ' Tu es maintenant ' + JOBS[jb].label, 2200); }
    updateJobHud(); return true;
  }
  const t = J.task;
  // deliveries: stop next to the door (on foot or in a vehicle)
  if (t && t.type === 'deliver' && t.stage === 'go') {
    for (let i = 0; i < t.list.length; i++) {
      const d = t.list[i];
      if (Math.hypot(d.x - player.pos.x, d.z - player.pos.z) < (car ? 9 : 3) && (!car || Math.abs(car.speed) < 2)) {
        t.list.splice(i, 1); scene.remove(t.mks[i]); t.mks.splice(i, 1); pay(60, '📦 Colis livré');
        t.goal = t.list.length ? 'Livre les colis : ' + t.list.length + ' restants' : 'Tournée finie !';
        if (!t.list.length) { pay(80, '🚚 Tournée complète'); clearTask(); }
        return true;
      }
    }
  }
  if (car) return false;
  // farm plots
  if (J.job === 'fermier') for (const pl of plots) {
    if (Math.abs(player.pos.x - pl.x) > 3.2 || Math.abs(player.pos.z - pl.z) > 7.5) continue;
    if (pl.state === 'vide') { if (M.money < 5) { banner('Il faut 5 $ de graines', 1400); return true; } M.money -= 5; pl.state = 'seme'; banner('🌱 Semé (−5 $) · arrose-le (E)', 1600); }
    else if (pl.state === 'seme') { pl.state = 'pousse'; pl.t = L.inv.arrosoir ? 17 : 35; banner('💧 Arrosé · ça pousse…', 1500); }
    else if (pl.state === 'pousse') banner('⏳ Encore ' + Math.ceil(pl.t) + ' s', 1000);
    else if (pl.state === 'mur') { if (invCount() + 10 > INV_MAX) { banner('Sac plein ! Va vendre', 1400); return true; } J.inv.legumes = (J.inv.legumes || 0) + 10; pl.state = 'vide'; banner('🥕 Récolte +10 légumes', 1500); }
    setPlot(pl); updateMissionHud(); updateJobHud(); return true;
  }
  return false;
}
function buyCar(s) {
  const price = 250;
  if (M.money < price) { banner('Une voiture coûte ' + price + ' $', 1500); return; }
  M.money -= price;
  const n = pickP(/^SportCar_\d+$/) || pick(CARS);
  const obj = makeObject(n); obj.position.set(s.cx - 6, SW + 0.24, s.pos.z); obj.rotation.y = Math.PI; scene.add(obj);
  parkedPlayerCars.push({ obj, speed: 0 }); banner('🔧 Nouvelle voiture : ' + n.replace('_', ' ') + ' (−' + price + ' $)', 2000); updateMissionHud();
}
function sellAll(only) {
  let tot = 0;
  for (const [k, v] of Object.entries(J.inv)) { if (only && !only.includes(k)) continue; if (k === 'legumes' && !only) continue; tot += v * (PRICES[k] || 1); delete J.inv[k]; }
  if (!tot) { banner(only ? 'Rien à vendre' : 'Rien à vendre ici (ressources)', 1400); return; }
  pay(tot, '💰 Vente'); updateJobHud();
}

// ---- update
let harvesting = null;
function updateVisitors(dt) {
  for (const v of stationVisitors) {
    if (!v.path) { const { cx, cz, pump } = v; const Y = (x, z) => groundY(x, z) + 0.24;
      const pts = [[cx - 44, cz + 30], [cx - 12, cz + 30], [cx - 12, cz + 20], [cx - 12, cz + 12], [pump.x, pump.z, 'stop'], [cx + 12, cz + 12], [cx + 12, cz + 20], [cx + 12, cz + 30], [cx + 44, cz + 30]];
      v.path = pts.map(([x, z, f]) => ({ p: new THREE.Vector3(x, Y(x, z), z), stop: !!f })); v.i = 0; v.wait = v.t; }
    if (v.wait > 0) { v.wait -= dt; if (v.car && v.i === 0) v.car.visible = false; continue; }
    if (!v.car) { v.car = makeObject(pick(CARS)); scene.add(v.car); }
    const o = v.car; if (v.i === 0) { o.position.copy(v.path[0].p); o.visible = true; v.i = 1; }
    const tgt = v.path[v.i], d = o.position.distanceTo(tgt.p), sp = 5.5 * dt;
    if (d < sp + 0.05) { o.position.copy(tgt.p); if (tgt.stop && !v.stopped) { v.stopped = true; v.wait = 6; continue; } v.stopped = false; v.i++; if (v.i >= v.path.length) { v.i = 0; v.wait = 6 + rnd() * 10; } continue; }
    _v.subVectors(tgt.p, o.position).normalize(); o.position.addScaledVector(_v, sp);
    const h = Math.atan2(_v.x, _v.z) + Math.PI; let dh = h - o.rotation.y; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); o.rotation.y += dh * Math.min(1, dt * 6);
  }
}
function updateJobs(dt) {
  updateVisitors(dt);
  for (const s of jobSpots) s.mk.rotation.y += dt;
  for (const sh of sheep) { sh.t -= dt; if (sh.t < 0) { sh.a += rr(-1.5, 1.5); sh.t = rr(2, 5); } sh.o.position.x += Math.sin(sh.a) * dt * 0.5; sh.o.position.z += Math.cos(sh.a) * dt * 0.5; sh.o.rotation.y = sh.a; }
  for (const pl of plots) if (pl.state === 'pousse') { pl.t -= dt; if (pl.t <= 0) { pl.state = 'mur'; setPlot(pl); } }
  for (const n of nodes) if (!n.alive) { n.t -= dt; if (n.t <= 0) { n.alive = true; n.o.visible = true; } }
  // fire visuals
  const t = J.task;
  if (t && t.type === 'fire') for (const f of t.flames) { const k = t.hp / 100; f.c.scale.setScalar(Math.max(0.01, k * (0.8 + 0.3 * Math.sin(performance.now() / 120 + f.ph)))); f.c.position.y = f.base + Math.sin(performance.now() / 200 + f.ph) * 0.2; }
  if (t && t.type === 'fire') for (const s of t.smoke) { s.t = (s.t + dt * 0.15) % 1; s.s.position.set(t.door.x - t.door.out[0] * 2 + s.t * 4, SW + 6 + s.t * 16, t.door.z - t.door.out[1] * 2); s.s.scale.setScalar((0.8 + s.t * 3) * (t.hp / 100 + 0.2)); }
  if (!game.on || !J.job) { updateJobHud(); return; }
  if (!t) { J.cooldown -= dt; if (J.cooldown <= 0) { if (J.job === 'pompier') startFire(); else if (J.job === 'ambulancier') startPatient(); else if (J.job === 'taxi') startFare(); else if (J.job === 'livreur') startDeliveries(); else J.cooldown = 1e9; } }
  const car = player.inCar, k = J.task;
  if (k) {
    k.t += dt; if (k.mk) k.mk.rotation.y += dt;
    if (k.t > k.limit) { banner('⏱️ Trop tard… mission ratée', 2000); clearTask(); }
    else if (k.type === 'fire') {
      const d = Math.hypot(k.pos.x - player.pos.x, k.pos.z - player.pos.z);
      const truck = car && car.obj.userData.fire;
      k.goal = !truck ? 'Prends le camion de pompiers (caserne)' : d > 14 ? 'Fonce vers l’incendie (' + Math.round(d) + ' m)' : 'Arrête-toi et maintiens F pour arroser';
      if (truck && d < 14 && Math.abs(car.speed) < 2 && keys.has('KeyF')) { k.hp -= dt * 14; sprayWater(car.obj.position, k.door, dt); if (k.hp <= 0) { pay(250, '🚒 Incendie éteint'); clearTask(); } }
      else hideWater();
    } else if (k.type === 'patient') {
      const amb = car && /Ambulance/.test(car.kind || '') || (car && car.obj.userData.amb);
      if (k.stage === 'pick') {
        k.goal = !car ? 'Prends une ambulance (hôpital)' : 'Va chercher le blessé';
        if (car && Math.hypot(k.pos.x - player.pos.x, k.pos.z - player.pos.z) < 7 && Math.abs(car.speed) < 3) { k.stage = 'drop'; k.ch.o.visible = false; k.mk.position.copy(k.dest); k.t = 0; k.limit = 150; banner('🚑 Blessé à bord, direction l’hôpital', 1800); }
      } else {
        k.goal = 'Emmène le blessé à l’hôpital';
        if (car && Math.hypot(k.dest.x - player.pos.x, k.dest.z - player.pos.z) < 12 && Math.abs(car.speed) < 3) { pay(200, '🏥 Patient sauvé'); clearTask(); }
      }
    } else if (k.type === 'fare') {
      if (k.stage === 'pick') {
        k.goal = !car ? 'Prends un taxi (agence)' : 'Va chercher le client';
        k.ch.o.rotation.y = Math.atan2(player.pos.x - k.pos.x, player.pos.z - k.pos.z);
        if (car && Math.hypot(k.pos.x - player.pos.x, k.pos.z - player.pos.z) < 7 && Math.abs(car.speed) < 3) { k.stage = 'drop'; k.ch.o.visible = false; k.mk.position.copy(k.dest); k.t = 0; k.limit = Math.round(k.pos.distanceTo(k.dest) / 8 + 40); banner('🚕 Client à bord', 1500); }
      } else {
        k.goal = car ? 'Dépose le client' : 'Remonte en voiture !';
        if (car && Math.hypot(k.dest.x - player.pos.x, k.dest.z - player.pos.z) < 7 && Math.abs(car.speed) < 3) { pay(Math.max(40, Math.round(k.pos.distanceTo(k.dest) / 5)), '🚕 Course terminée'); clearTask(); }
      }
    }
  }
  // resource harvesting: hold E next to a node
  if (J.job === 'recolteur' && !car) {
    let near = null; for (const n of nodes) if (n.alive && Math.hypot(n.pos.x - player.pos.x, n.pos.z - player.pos.z) < 2.2 + n.sc * 0.5) { near = n; break; }
    if (near && keys.has('KeyE')) {
      harvesting = harvesting && harvesting.n === near ? harvesting : { n: near, p: 0 };
      harvesting.p += dt / (L.inv.pioche ? 1.25 : 2.5);
      if (harvesting.p >= 1) {
        if (invCount() >= INV_MAX) banner('Sac plein ! Va vendre à l’entrepôt ou une usine', 1600);
        else { const q = near.res === 'pierre' || near.res === 'bois' ? 3 : 1; J.inv[near.res] = (J.inv[near.res] || 0) + q; near.alive = false; near.o.visible = false; near.t = 60; banner('⛏️ +' + q + ' ' + near.res, 1000); }
        harvesting = null;
      }
    } else harvesting = null;
    J.nearNode = near;
  }
  updateJobHud();
}
let waterMesh;
function sprayWater(from, door, dt) {
  if (!waterMesh) { waterMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.25, 6, 4), new THREE.MeshBasicMaterial({ color: 0x6ec6ff, transparent: true, opacity: 0.8 }), 30); waterMesh.frustumCulled = false; scene.add(waterMesh); }
  waterMesh.visible = true;
  const tx = door.x - door.out[0], tz = door.z - door.out[1], ph = performance.now() / 300;
  for (let i = 0; i < 30; i++) {
    const u = ((i / 30) + ph) % 1;
    _p.set(from.x + (tx - from.x) * u, from.y + 2.5 + Math.sin(u * Math.PI) * 4 + (SW + 3 - from.y) * u, from.z + (tz - from.z) * u);
    _m.makeTranslation(_p.x, _p.y, _p.z); waterMesh.setMatrixAt(i, _m);
  }
  waterMesh.instanceMatrix.needsUpdate = true;
}
function hideWater() { if (waterMesh) waterMesh.visible = false; }
function jobTarget() {
  const t = J.task;
  if (t) { if (t.type === 'fire') return t.pos; if (t.type === 'patient' || t.type === 'fare') return t.stage === 'pick' ? t.pos : t.dest; if (t.type === 'deliver') return t.stage === 'load' ? (nearestSpot('delivery') || {}).pos : t.list[0] && new THREE.Vector3(t.list[0].x, 0, t.list[0].z); }
  if (J.job === 'fermier') return nearestSpot('farm').pos;
  if (J.job === 'recolteur') return invCount() >= INV_MAX ? (nearestSpot('warehouse') || {}).pos : new THREE.Vector3(30, 0, -HALF - 40);
  return null;
}
function jobPrompt() {
  for (const s of jobSpots) {
    if (Math.hypot(s.pos.x - player.pos.x, s.pos.z - player.pos.z) > (player.inCar ? 6 : 2.6)) continue;
    if (s.def.sell) return 'E : vendre tes ressources (' + invCount() + ')';
    if (s.def.garage) return player.inCar ? 'E : réparer / laver le véhicule' : 'E : acheter une voiture de sport (250 $)';
    if (s.kind === 'delivery' && J.task && J.task.type === 'deliver' && J.task.stage === 'load') return 'E : charger les colis';
    if (s.kind === 'farm' && J.job === 'fermier' && J.inv.legumes) return 'E : vendre ' + J.inv.legumes + ' légumes';
    const jb = s.def.job; if (jb && !player.inCar) return J.job === jb ? 'E : quitter le métier ' + JOBS[jb].label : 'E : devenir ' + JOBS[jb].label;
  }
  if (J.job === 'fermier' && !player.inCar) for (const pl of plots) if (Math.abs(player.pos.x - pl.x) < 3.2 && Math.abs(player.pos.z - pl.z) < 7.5) return { vide: 'E : semer (5 $)', seme: 'E : arroser', pousse: 'Ça pousse… ' + Math.ceil(pl.t) + ' s', mur: 'E : récolter' }[pl.state];
  if (J.job === 'recolteur' && J.nearNode) return harvesting ? 'Récolte… ' + Math.round(harvesting.p * 100) + ' %' : 'Maintiens E : récolter (' + J.nearNode.res + ')';
  if (J.task && J.task.type === 'deliver' && J.task.stage === 'go') for (const d of J.task.list) if (Math.hypot(d.x - player.pos.x, d.z - player.pos.z) < (player.inCar ? 9 : 3)) return 'E : livrer le colis';
  if (J.task && J.task.type === 'fire' && player.inCar && player.inCar.obj.userData.fire && Math.hypot(J.task.pos.x - player.pos.x, J.task.pos.z - player.pos.z) < 14) return 'Maintiens F : arroser (' + Math.max(0, Math.round(J.task.hp)) + ' %)';
  return '';
}
function updateJobHud() {
  const el = document.getElementById('job'); if (!el) return;
  if (!J.job) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const jb = JOBS[J.job], t = J.task, tgt = jobTarget();
  const inv = Object.entries(J.inv).map(([k, v]) => v + ' ' + k).join(' · ');
  let goal = t ? t.goal : { fermier: 'Sème, arrose et récolte les parcelles de la ferme (au sud)', recolteur: 'Récolte pierre, bois et minerais à la carrière (au nord), vends à l’entrepôt ou une usine', pompier: 'En attente d’une alerte…', ambulancier: 'En attente d’une urgence…', taxi: 'En attente d’un client…', livreur: 'Préparation de la tournée…' }[J.job];
  const dist = tgt ? Math.round(Math.hypot(tgt.x - player.pos.x, tgt.z - player.pos.z)) + ' m' : '';
  const html = [jb.icon + ' ' + jb.label + (t && t.limit ? ' · ' + Math.max(0, Math.ceil(t.limit - t.t)) + ' s' : ''), goal, (dist ? 'Objectif à ' + dist : '') + (inv ? (dist ? ' · ' : '') + 'Sac : ' + inv : '')];
  if (el._last !== html.join('|')) { el._last = html.join('|'); el.innerHTML = ''; html.forEach((h, i) => { const s = document.createElement(i ? 'span' : 'b'); s.textContent = h; el.append(s); }); }
}
function drawJobsOnMap(c, k) {
  for (const s of jobSpots) { c.fillStyle = s.def.job ? '#' + JOBS[s.def.job].color.toString(16).padStart(6, '0') : '#ffb74d'; c.beginPath(); c.arc((s.pos.x + HALF) * k, (s.pos.z + HALF) * k, 4.5, 0, 7); c.fill(); c.strokeStyle = '#000'; c.lineWidth = 1; c.stroke(); }
  const t = jobTarget(); if (t) { c.strokeStyle = '#ffffff'; c.lineWidth = 2.5; c.beginPath(); c.arc((t.x + HALF) * k, (t.z + HALF) * k, 6, 0, 7); c.stroke(); }
}

// ================================================================ DAY / NIGHT (1 real hour = 1 game day)
const GT = { min: 8 * 60, day: 1 };          // game minutes since midnight
const DAY_SEC = 3600;
const nightU = { value: 0 };                 // 0 day .. 1 night (shared by window shaders)
const lampHeads = [];
function registerLamp(name, x, y, z, rot, sc) {
  let lx = 0, ly = 3.7, lz = 0, big = 1;
  if (/^Lights_5/.test(name)) { ly = 4.12; lz = -1.15; }
  else if (/^Lamp_Court/.test(name)) { ly = 6.3; lz = 1.2; big = 1.4; }
  else if (/^StreetLamp/.test(name)) { ly = 3.72; }
  else return;
  lampHeads.push(new THREE.Vector3(x + lz * Math.sin(rot) * sc + lx, y + ly * sc, z + lz * Math.cos(rot) * sc));
}
// windows: a random subset of window cells lights up at night
function patchWindows(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = nightU;
    sh.vertexShader = 'varying vec3 vWP;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      #ifdef USE_INSTANCING
        vWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif`);
    sh.fragmentShader = 'uniform float uNight;\nvarying vec3 vWP;\nfloat h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }\n' +
      sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { vec3 cell = floor(vWP / vec3(1.7, 1.6, 1.7)); float r = h31(cell);
          float on = step(0.52, r) * uNight;
          totalEmissiveRadiance += on * mix(vec3(1.0, 0.72, 0.38), vec3(0.75, 0.85, 1.0), step(0.9, r)) * 1.35; }`);
  };
  mat.customProgramCacheKey = () => 'win-night';
}
let stars, glow, pools, carGlow, carTail, carPool, lampLights = [], headSpot;
function initDayNight() {
  // stars
  const g = new THREE.BufferGeometry(), p = [];
  for (let i = 0; i < 1800; i++) { const u = rnd() * 2 - 1, a = rnd() * 6.283, r = 1400; const y = Math.abs(u); p.push(Math.cos(a) * Math.sqrt(1 - y * y) * r, y * r, Math.sin(a) * Math.sqrt(1 - y * y) * r); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  stars.renderOrder = -1; scene.add(stars);
  // lamp glows + light pools on the ground
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false, transparent: true, opacity: 0 });
  glow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.32, 10, 6), glowMat, lampHeads.length);
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,214,150,0.9)'); gr.addColorStop(0.5, 'rgba(255,190,110,0.35)'); gr.addColorStop(1, 'rgba(255,170,90,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const poolTex = new THREE.CanvasTexture(c);
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2), poolMat, lampHeads.length);
  lampHeads.forEach((h, i) => { _m.makeTranslation(h.x, h.y - 0.15, h.z); glow.setMatrixAt(i, _m); _m.makeTranslation(h.x, groundY(h.x, h.z) + 0.06, h.z); pools.setMatrixAt(i, _m); });
  for (const m of [glow, pools]) { m.computeBoundingSphere(); m.frustumCulled = false; scene.add(m); }
  // a few real lights that follow the player (nearest lamps)
  for (let i = 0; i < (MOBILE ? 2 : 6); i++) { const l = new THREE.PointLight(0xffc98a, 0, 16, 1.6); scene.add(l); lampLights.push(l); }
  // car head/tail lights
  const n = cars.length + 20;
  carGlow = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff6d8, toneMapped: false, transparent: true, opacity: 0 }), n * 2);
  carTail = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false, transparent: true, opacity: 0 }), n * 2);
  const beam = poolTex.clone(); beam.needsUpdate = true;
  carPool = new THREE.InstancedMesh(new THREE.PlaneGeometry(3.4, 7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: beam, color: 0xfff1d0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), n);
  for (const m of [carGlow, carTail, carPool]) { m.frustumCulled = false; scene.add(m); }
  headSpot = new THREE.SpotLight(0xfff1d0, 0, 45, 0.55, 0.5, 1.2); scene.add(headSpot, headSpot.target);
}
const KEYS = [ // hour, sun intensity, hemi intensity, exposure, fog colour, sun colour, hemi sky
  [0, 0.0, 0.22, 0.85, 0x0b1224, 0x8aa6ff, 0x34446e], [5, 0.0, 0.25, 0.85, 0x1a2140, 0x8aa6ff, 0x3a4876],
  [6.3, 0.9, 0.7, 0.95, 0xf3b38a, 0xffb27a, 0xffc9a8], [8, 2.3, 1.15, 1.0, 0xd5e6f5, 0xfff0d8, 0xdfefff],
  [17, 2.4, 1.2, 1.05, 0xcfe3f4, 0xfff4e0, 0xdfefff], [19.2, 1.0, 0.75, 0.98, 0xf2a070, 0xff9a5a, 0xffb88a],
  [20.5, 0.05, 0.32, 0.88, 0x2a2850, 0x8aa6ff, 0x3d3a70], [24, 0.0, 0.22, 0.85, 0x0b1224, 0x8aa6ff, 0x34446e],
];
const _c1c = new THREE.Color(), _c2c = new THREE.Color();
function lerpKey(h) {
  let a = KEYS[0], b = KEYS[1];
  for (let i = 0; i < KEYS.length - 1; i++) if (h >= KEYS[i][0] && h <= KEYS[i + 1][0]) { a = KEYS[i]; b = KEYS[i + 1]; break; }
  const t = (h - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const L = (i) => a[i] + (b[i] - a[i]) * t;
  const C = (i, out) => out.setHex(a[i]).lerp(_c2c.setHex(b[i]), t);
  return { sun: L(1), hemi: L(2), exp: L(3), fog: C(4, new THREE.Color()), sunC: C(5, new THREE.Color()), sky: C(6, new THREE.Color()) };
}
function hourStr() { const m = Math.floor(GT.min) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function phase(h) { return h < 5 ? 'Nuit' : h < 7.5 ? 'Aube' : h < 18.5 ? 'Jour' : h < 21 ? 'Coucher de soleil' : 'Nuit'; }
let lampT = 0;
function updateDayNight(dt) {
  GT.min += dt * 1440 / DAY_SEC; if (GT.min >= 1440) { GT.min -= 1440; GT.day++; }
  const h = GT.min / 60, k = lerpKey(h);
  const indoor = !!inside;
  // sun path: rises at 6:00 in the east, sets at 20:00 in the west
  const a = (h - 6) / 14 * Math.PI, elev = Math.sin(a);
  if (elev > -0.05) SUN_DIR.set(-Math.cos(a) * 0.9, Math.max(0.08, elev), 0.35).normalize();
  else SUN_DIR.set(0.4, 0.8, -0.3).normalize(); // moon
  sun.intensity = indoor ? 2.2 : Math.max(k.sun, 0.35);
  sun.color.copy(indoor ? _c1c.setHex(0xfff4e0) : k.sunC);
  hemi.intensity = indoor ? 1.25 : k.hemi; hemi.color.copy(indoor ? _c1c.setHex(0xdfefff) : k.sky);
  renderer.toneMappingExposure = indoor ? 1.05 : k.exp;
  const night = indoor ? 0 : THREE.MathUtils.clamp((0.75 - k.hemi) / 0.5, 0, 1);
  nightU.value = THREE.MathUtils.clamp((0.95 - k.hemi) / 0.55, 0, 1);
  scene.backgroundIntensity = indoor ? 1 : Math.max(0.05, Math.min(1, (k.hemi - 0.2) / 0.95));
  scene.environmentIntensity = 0.25 + 0.75 * (1 - night);
  if (scene.fog) scene.fog.color.copy(k.fog);
  if (stars) { stars.material.opacity = night * 0.9; stars.position.copy(camera.position); }
  const lampOn = nightU.value > 0.35 ? THREE.MathUtils.clamp((nightU.value - 0.35) / 0.3, 0, 1) : 0;
  if (glow) { glow.material.opacity = lampOn; pools.material.opacity = lampOn * 0.55; glow.visible = pools.visible = lampOn > 0.01; }
  lampT += dt;
  if (lampT > 0.5 && lampLights.length) {
    lampT = 0;
    const near = lampOn > 0.01 ? lampHeads.map(p => [p, (p.x - player.pos.x) ** 2 + (p.z - player.pos.z) ** 2]).sort((x, y) => x[1] - y[1]).slice(0, lampLights.length) : [];
    lampLights.forEach((l, i) => { if (near[i]) { l.position.copy(near[i][0]); l.position.y -= 0.4; l.intensity = 14 * lampOn; } else l.intensity = 0; });
  }
  // car lights
  if (carGlow) {
    const on = lampOn, list = cars.concat(parkedPlayerCars.filter(c => c === player.inCar));
    let i = 0, j = 0;
    if (on > 0.01) for (const c of list) {
      const o = c.obj, r = o.rotation.y, s = Math.sin(r), co = Math.cos(r), y = o.position.y + 0.55;
      const len = 1.95;
      for (const sx of [-0.55, 0.55]) {
        _p.set(o.position.x + sx * co - len * s, y, o.position.z - sx * s - len * co); _m.makeTranslation(_p.x, _p.y, _p.z); carGlow.setMatrixAt(i, _m);
        _p.set(o.position.x + sx * co + len * s, y, o.position.z - sx * s + len * co); _m.makeTranslation(_p.x, _p.y, _p.z); carTail.setMatrixAt(i, _m); i++;
      }
      _q.setFromAxisAngle(_up, r); _p.set(o.position.x - 5.6 * s, RT + 0.08, o.position.z - 5.6 * co); _s.set(1, 1, 1); _m.compose(_p, _q, _s); carPool.setMatrixAt(j++, _m);
      if (i >= carGlow.count - 1) break;
    }
    carGlow.count = carTail.count = i; carPool.count = j;
    carGlow.instanceMatrix.needsUpdate = carTail.instanceMatrix.needsUpdate = carPool.instanceMatrix.needsUpdate = true;
    carGlow.material.opacity = carTail.material.opacity = on; carPool.material.opacity = on * 0.45;
    const pc = player.inCar;
    if (pc && on > 0.01) { const r = pc.obj.rotation.y; headSpot.position.set(pc.obj.position.x - Math.sin(r) * 2, pc.obj.position.y + 0.9, pc.obj.position.z - Math.cos(r) * 2); headSpot.target.position.set(pc.obj.position.x - Math.sin(r) * 16, 0, pc.obj.position.z - Math.cos(r) * 16); headSpot.intensity = 60 * on; }
    else headSpot.intensity = 0;
  }
}

// ================================================================ ROOMS: partitions + service interiors
const IW = ['I_Wall_01', 'I_Wall_02', 'I_Wall_03', 'I_Wall_04', 'I_Wall_05'];
// wall line inside a room. axis 'x': runs along x at z=fixed from tile a to tile b (exclusive); gaps = tile indices left open (doorways)
function partition(axis, fixed, a, b, gaps = [], wall) {
  const r = curRoom, Tt = 2.5, w = wall || r.wallName || 'I_Wall_01';
  for (let t = a; t < b; t++) {
    if (gaps.includes(t)) { if (proto.I_Door_02 && chance(0.6)) { const dx = axis === 'x' ? t * Tt + 0.25 : fixed, dz = axis === 'x' ? fixed : t * Tt + 0.25; iput('I_Door_02', dx, dz, axis === 'x' ? Math.PI / 2 : 0, 0, false); } continue; }
    const cx = axis === 'x' ? t * Tt + Tt / 2 : fixed, cz = axis === 'x' ? fixed : t * Tt + Tt / 2;
    const o = makeObject(w); o.position.set(r.ox + cx, 0, r.oz + cz); o.rotation.y = axis === 'x' ? 0 : Math.PI / 2; o.scale.y = 0.55; r.group.add(o);
    r.cols.push(axis === 'x' ? [r.ox + t * Tt, r.oz + fixed - 0.12, r.ox + (t + 1) * Tt, r.oz + fixed + 0.12] : [r.ox + fixed - 0.12, r.oz + t * Tt, r.ox + fixed + 0.12, r.oz + (t + 1) * Tt]);
  }
}
const OFFICE = (x, z, rot = 0) => { iput(pickExisting(['I_OfficeTable_01', 'I_OfficeTable_02']), x, z, rot); iput('I_PC_Screen', x, z - 0.1 * Math.cos(rot), rot, topOf('I_OfficeTable_01'), false); iput('I_PC_Keyboard', x, z + 0.12 * Math.cos(rot), rot, topOf('I_OfficeTable_01'), false); iput(pickExisting(['I_OfficeChair_01', 'I_OfficeChair_02']), x, z + 0.75 * Math.cos(rot), rot + Math.PI); };
const DECO = (x, z) => iput(pickExisting(['I_Flower_01', 'I_Flower_03', 'I_Flower_05', 'I_Flower_07']), x, z);
function counter(x, z, n = 3) { for (let k = 0; k < n; k++) iput(pickExisting(['I_Bar_01', 'I_Bar_02']), x - (n - 1) * 0.6 + k * 1.2, z, Math.PI / 2); curRoom.counter = new THREE.Vector3(curRoom.ox + x, 0, curRoom.oz + z + 1.2); }
// template: 6 x 4 tiles (15 x 10 m). Hall in front (z 5..10), two back rooms (x 0..7.5 and 7.5..15, z 0..5)
// small sign on the back wall of a back room (like the reference plans)
function roomLabel(text, x) { const s = textPlaque(text, '#1d4ed8', 1.3); s.position.set(curRoom.ox + x, 2.3, curRoom.oz + 0.3); curRoom.group.add(s); }
function serviceShell(floor) {
  curRoom.wallName = pickExisting(IW);
  shell(6, 4, floor || pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12']), curRoom.wallName, 3);
  partition('x', 5, 0, 6, [1, 4]);
  partition('z', 7.5, 0, 2, []);
}
function buildService(kind) {
  const R = curRoom;
  const PLAN = { concession: buildConcession, police: buildPolice, mairie: buildMairie, bureaux: buildEntreprise, emploi: () => buildAgency('emploi'), immobilier: () => buildAgency('immobilier'), assurance: () => buildAgency('assurance'), banque: () => buildAgency('banque') }[kind]; if (PLAN) return PLAN();
  if (kind === 'concession') {
    shell(6, 4, pickExisting(['I_Floor_12', 'I_Floor_08']), pickExisting(IW), 3); curRoom.wallName = 'I_Wall_02';
    partition('x', 3.2, 3, 6, [4]);
    const cars = ['SportCar_1', 'SportCar_5', 'SportCar_9', 'PickUp_3'].filter(n => proto[n]);
    cars.forEach((c, i) => { const o = makeObject(c); o.position.set(R.ox + 2.2 + i * 3.2, 0.24, R.oz + 6.0); o.rotation.y = 0.5; R.group.add(o); R.cols.push([R.ox + 1.2 + i * 3.2, R.oz + 4.4, R.ox + 3.2 + i * 3.2, R.oz + 7.6]); });
    OFFICE(4, 1.4); OFFICE(1.6, 1.4); counter(11.2, 2.1, 2); roomNPC(11.2, 1.3, 'Idle_A-loop', 0); roomNPC(5, 7, 'LookingAround-loop', 0.4);
    for (const [n, x, z] of [['K_Parts_Pile_Large', 9, 0.8], ['K_Fuel_A_Barrels', 14, 0.8], ['K_Containers_Box_Large', 14.2, 2.4]]) iput(n, x, z, rr(0, 6));
    DECO(0.5, 9.5); DECO(14.5, 9.5); return;
  }
  serviceShell();
  // ---- hall (front room)
  const hall = { sofa: () => { iput(pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_07']), 2.3, 9.0, Math.PI); iput('I_RoomTable_01', 2.3, 7.8); iput(pickExisting(['I_Sofa_02', 'I_Sofa_04']), 13.0, 9.0, Math.PI); DECO(0.6, 5.8); DECO(14.4, 5.8); iput('I_Picture_04', 0.15, 7.6, Math.PI / 2, 1.5, false); iput('I_Clock_04', 14.85, 7.6, -Math.PI / 2, 1.8, false); } };
  if (kind === 'banque') {
    counter(7.5, 6.0, 3); for (const x of [6.3, 7.5, 8.7]) roomNPC(x, 5.45, 'Idle_A-loop', 0); hall.sofa();
    roomLabel('Bureau', 3.75); roomLabel('Coffre', 11.25);
    OFFICE(3.7, 2.0); iput('I_Library', 0.3, 2.5, Math.PI / 2); iput('I_Library', 3.7, 0.2, 0); roomNPC(3.7, 2.8, 'Idle_B-loop', Math.PI);
    for (const [n, x, z] of [['K_Gold_Bars_Stack_Large', 9.3, 1.2], ['K_Money_Pile_Large', 11.5, 1.0], ['K_Money_Bills_Stack_Large', 13.6, 1.3], ['K_Gold_Bars_Stack_Medium', 13.8, 3.6], ['K_Money_Coins_Stack_Large', 9.4, 3.6], ['K_Gems_Chest', 11.6, 3.7]]) iput(n, x, z, rr(-0.3, 0.3), 0, true, 1.6);
  } else if (kind === 'pharmacie') {
    counter(7.5, 6.0, 2); roomNPC(7.5, 5.45, 'Idle_A-loop', 0);
    wallShelves(0.25, 5.4, 9.6, -1, PHARMA); wallShelves(14.75, 5.4, 9.6, 1, PHARMA);
    if (proto.G_Screen_1) iput('G_Screen_1', 7.5, 6.0, Math.PI, topOf('I_Bar_01'), false);
    for (let k = 0; k < 8; k++) iput(pick(['K_Containers_Box_Medium', 'K_Containers_Box_Small', 'K_Containers_Box_Large']), rr(0.8, 6.6), rr(0.8, 4.2), rr(0, 6));
    OFFICE(11.25, 2.0); iput('I_Library', 14.7, 2.5, -Math.PI / 2); roomNPC(11.25, 2.8, 'Idle_B-loop', Math.PI); roomLabel('Réserve', 3.75); roomLabel('Préparation', 11.25);
    DECO(4, 9.5); DECO(11, 9.5);
  } else if (kind === 'police') {
    counter(7.5, 6.0, 3); roomNPC(7.5, 5.45, 'Idle_A-loop', 0); hall.sofa();
    OFFICE(2.0, 2.0); OFFICE(5.4, 2.0); iput('I_Library', 0.3, 3.8, Math.PI / 2); roomNPC(2.0, 2.8, 'Idle_B-loop', Math.PI);
    roomLabel('Bureaux enquête', 3.75); roomLabel('Cellule', 11.25);
    // cell with bars
    for (const x of [9.3, 13.3]) iput('Fence_1_A_3', x - 0.0, 3.5, Math.PI / 2, 0, true); iput('Bench_1_A', 11.3, 0.7, Math.PI / 2); iput('I_Toilet_01', 14.3, 0.5, -Math.PI / 2); if (chance(0.7)) roomNPC(11.3, 1.6, 'Idle_A-loop', Math.PI);
  } else if (kind === 'mairie') {
    roomLabel('Bureau du maire', 3.75); roomLabel('Salle du conseil', 11.25);
    counter(7.5, 6.0, 3); roomNPC(7.5, 5.45, 'Idle_A-loop', 0); hall.sofa();
    iput(pickExisting(['I_OfficeTable_02']), 3.7, 2.4, 0); iput('I_OfficeChair_02', 3.7, 1.6, 0); iput('I_Library', 1.3, 0.25, 0); iput('I_Library', 6.1, 0.25, 0); iput(pickExisting(['I_Fireplace_02', 'I_Fireplace_01']), 0.3, 3.4, Math.PI / 2); iput('I_Catpet_04', 3.7, 3.2, 0, 0.01, false); roomNPC(3.7, 1.6, 'Idle_B-loop', 0);
    iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_03']), 11.25, 2.4); for (const [dx, dz, r] of [[-0.5, -0.85, 0], [0.5, -0.85, 0], [-0.5, 0.85, Math.PI], [0.5, 0.85, Math.PI]]) iput('I_KitchenChair_01', 11.25 + dx, 2.4 + dz, r);
    iput('I_Picture_06', 11.25, 0.15, 0, 1.4, false);
  } else if (kind === 'bureaux' || kind === 'emploi' || kind === 'immobilier' || kind === 'assurance') {
    roomLabel('Bureaux', 3.75); roomLabel(kind === 'bureaux' ? 'Réunion' : 'Archives', 11.25);
    counter(7.5, 6.0, 2); roomNPC(7.5, 5.45, 'Idle_A-loop', 0); hall.sofa();
    for (const [x, z] of [[1.9, 1.5], [5.4, 1.5], [1.9, 3.7], [5.4, 3.7]]) { OFFICE(x, z); if (chance(0.6)) roomNPC(x, z + 0.8, 'Idle_B-loop', Math.PI); }
    if (kind === 'bureaux') { iput(pickExisting(['I_KitchenTable_02']), 11.25, 2.4); for (const [dx, dz, r] of [[-0.5, -0.85, 0], [0.5, -0.85, 0], [-0.5, 0.85, Math.PI], [0.5, 0.85, Math.PI]]) iput('I_OfficeChair_01', 11.25 + dx, 2.4 + dz, r); iput('I_TV', 11.25, 0.2, 0, 0.8, false); }
    else { for (const x of [8.4, 10.4, 12.4, 14.4]) iput('I_Library', x, 0.25, 0); for (let k = 0; k < 6; k++) iput(pick(['K_Containers_Box_Small', 'K_Containers_Box_Medium']), rr(8.5, 14), rr(2, 4.3), rr(0, 6)); }
  } else if (kind === 'meubles') {
    counter(7.5, 6.0, 2); roomNPC(7.5, 5.45, 'Idle_A-loop', 0);
    // showroom: bedroom (left back), kitchen (right back), living room in the hall
    iput(pickExisting(['I_Bed2_01', 'I_Bed2_03']), 3.7, 1.6); iput('I_Bed_Table_02', 1.8, 0.4); iput('I_Lamp_04', 1.8, 0.4, 0, topOf('I_Bed_Table_02'), false); iput('I_RoomFurniture_05', 6.4, 0.5); iput('I_Catpet_03', 3.7, 3.8, 0, 0.01, false);
    let kx = 8.5; for (let i = 0; i < 4; i++) { iput(i === 2 ? 'I_Oven' : pickExisting(['I_KitchenTabletop1_05', 'I_KitchenTabletop1_06', 'I_KitchenTabletop2_03']), kx, 0.4); kx += 1.14; } iput('I_KitchenTable_03', 11.5, 3.2); iput('I_KitchenChair_03', 11.0, 2.35); iput('I_KitchenChair_03', 12.0, 2.35);
    for (const [n, x, z, r] of [['I_Sofa_05', 2.5, 8.8, Math.PI], ['I_Sofa_08', 12.8, 8.8, Math.PI], ['I_Library', 14.7, 6.8, -Math.PI / 2], ['I_Lamp_02', 0.6, 9.4, 0], ['I_TV', 2.5, 5.7, 0], ['I_Catpet_01', 12.8, 7.4, 0]]) iput(n, x, z, r, 0, !/Catpet/.test(n));
    roomNPC(4, 7.6, 'LookingAround-loop', 0.6);
  } else if (kind === 'station') {
    counter(7.5, 6.0, 2); roomNPC(7.5, 5.45, 'Idle_A-loop', 0);
    for (const z of [7.0, 8.8]) { for (let k = 0; k < 4; k++) iput('R_StandShelf_1_A', 1.5 + k * 1.0, z, Math.PI / 2); stock(z < 8 ? GROCERY : BAKERY, 1.0, 5.0, z, topOf('R_StandShelf_1_A'), 0, 3, 1.6, 0.16); }
    for (let k = 0; k < 4; k++) if (proto.G_Fridge_2) iput('G_Fridge_2', 14.4, 5.8 + k * 1.05, -Math.PI / 2);
    if (proto.G_Cofe_Maker_1) iput('G_Cofe_Maker_1', 8.2, 6.0, Math.PI, topOf('I_Bar_01'), false);
    for (let k = 0; k < 6; k++) iput(pick(['K_Fuel_A_Barrels', 'K_Fuel_A_Barrel', 'K_Fuel_A_Jerrycan', 'K_Fuel_B_Barrels']), rr(0.8, 6.5), rr(0.8, 4.2), rr(0, 6));
    iput('I_Toilet_01', 9.0, 0.5); iput('I_Toilet_02', 11.0, 0.5); iput('I_ShowerTable_01', 13.5, 0.4);
  } else { hall.sofa(); counter(7.5, 6.0, 2); }
}

// ================================================================ LIFE: needs, items, money, housing, services
const L = {
  needs: { faim: 80, soif: 80, hygiene: 80, sommeil: 80, sante: 100 },
  sick: false, bank: 100, inv: {}, home: null, rentDue: 0, owned: [], fines: 0, permis: false, aide: 0,
  furn: [], props: [], visiting: null, carry: null, sitting: null, gps: null, gpsLabel: '', drops: [], placing: null, lastFine: '',
};
const NEED_ICONS = { faim: '🍔', soif: '💧', hygiene: '🧼', sommeil: '😴', sante: '❤️' };
// ---- items
const ITEMS = {
  eau: { n: 'Bouteille d’eau', p: 2, drink: 35 }, soda: { n: 'Soda', p: 3, drink: 25, eat: 5 }, lait: { n: 'Lait', p: 3, drink: 20, eat: 5 },
  cafe: { n: 'Café', p: 3, drink: 15, sleep: 15 }, jus: { n: 'Jus de fruits', p: 4, drink: 30, eat: 5 },
  pain: { n: 'Pain', p: 2, eat: 12 }, fromage: { n: 'Fromage', p: 4, eat: 10 }, tomate: { n: 'Tomate', p: 1, eat: 5 }, salade: { n: 'Salade', p: 1, eat: 5 },
  oeuf: { n: 'Œuf', p: 1, eat: 4 }, pates: { n: 'Pâtes', p: 3, eat: 6 }, viande: { n: 'Viande', p: 6, eat: 10 }, fruits: { n: 'Fruits', p: 3, eat: 10, drink: 5 },
  sucre: { n: 'Sucre', p: 1 }, grains: { n: 'Café en grains', p: 4 }, legumes: { n: 'Légumes', p: 2, eat: 6 },
  sandwich: { n: 'Sandwich', p: 9, eat: 45 }, salade_comp: { n: 'Salade composée', p: 9, eat: 40, drink: 5 }, omelette: { n: 'Omelette', p: 8, eat: 40 },
  pates_bolo: { n: 'Pâtes bolognaise', p: 12, eat: 60 }, smoothie: { n: 'Smoothie', p: 8, drink: 40, eat: 15 }, cafe_maison: { n: 'Café maison', p: 5, drink: 20, sleep: 20 },
  soupe: { n: 'Soupe de légumes', p: 8, eat: 35, drink: 25 },
  plat: { n: 'Plat du jour', p: 15, eat: 80 }, dessert: { n: 'Dessert', p: 6, eat: 20 }, biere: { n: 'Boisson du bar', p: 5, drink: 30 }, croissant: { n: 'Croissant', p: 3, eat: 15 },
  medicament: { n: 'Médicament', p: 20, cure: true }, bandage: { n: 'Bandage', p: 8, heal: 30 }, savon: { n: 'Lingettes / savon', p: 4, wash: 40 },
  vitamines: { n: 'Vitamines', p: 10, heal: 10, sleep: 10 },
  pioche: { n: 'Pioche (récolte ×2)', p: 60, tool: true }, arrosoir: { n: 'Arrosoir (pousse ×2)', p: 25, tool: true },
  cle: { n: 'Clé à molette (répare +50 %)', p: 40, tool: true }, jerrycan: { n: 'Jerrycan (+30 % essence)', p: 15 },
};
const RECIPES = [
  ['sandwich', { pain: 1, fromage: 1, tomate: 1 }], ['salade_comp', { salade: 1, tomate: 1, legumes: 1 }], ['omelette', { oeuf: 2, fromage: 1 }],
  ['pates_bolo', { pates: 1, viande: 1, tomate: 1 }], ['smoothie', { fruits: 2, lait: 1 }], ['cafe_maison', { grains: 1, eau: 1, sucre: 1 }], ['soupe', { legumes: 2, eau: 1 }],
];
const FURN = [
  ['I_Sofa_01', 'Canapé', 220], ['I_Sofa_05', 'Canapé (couleur)', 220], ['I_Bed1_01', 'Lit simple', 180], ['I_Bed2_02', 'Lit double', 300],
  ['I_KitchenTable_01', 'Table de cuisine', 90], ['I_KitchenChair_01', 'Chaise', 30], ['I_RoomTable_01', 'Table basse', 70], ['I_TV', 'Télévision', 250],
  ['I_Library', 'Bibliothèque', 120], ['I_Lamp_01', 'Lampadaire', 40], ['I_Lamp_05', 'Lampe', 30], ['I_Flower_02', 'Plante verte', 25], ['I_Flower_05', 'Grande plante', 35],
  ['I_Catpet_02', 'Tapis', 45], ['I_Catpet_05', 'Grand tapis', 60], ['I_Picture_02', 'Tableau', 50], ['I_PC_Table', 'Bureau', 110], ['I_PC', 'Ordinateur', 400],
  ['I_OfficeChair_01', 'Fauteuil de bureau', 80], ['I_Fireplace_01', 'Cheminée', 350], ['I_RoomFurniture_02', 'Commode', 130], ['I_ChristmasTree_01', 'Sapin de Noël', 60],
  ['I_Clock_03', 'Horloge', 35], ['I_Mirror_01', 'Miroir', 45], ['I_Washer_01', 'Lave-linge', 260], ['I_Bath', 'Baignoire', 300],
];
const have = (id) => (L.inv[id] || 0) + (id === 'legumes' ? (J.inv.legumes || 0) : 0);
function take(id, n = 1) { let a = Math.min(L.inv[id] || 0, n); L.inv[id] = (L.inv[id] || 0) - a; if (!L.inv[id]) delete L.inv[id]; n -= a; if (n > 0 && id === 'legumes') { J.inv.legumes -= n; if (!J.inv.legumes) delete J.inv.legumes; } }
function give(id, n = 1) { L.inv[id] = (L.inv[id] || 0) + n; }
const itemName = (id) => id.startsWith('F:') ? (FURN.find(f => f[0] === id.slice(2)) || [0, id.slice(2)])[1] : (ITEMS[id] ? ITEMS[id].n : id);
// ---- money (cash first, then bank card)
function payMoney(n) {
  if (M.money + L.bank < n) { banner('Pas assez d’argent (' + n + ' $)', 1500); return false; }
  const c = Math.min(M.money, n); M.money -= c; L.bank -= n - c; updateMissionHud(); return true;
}

// ---- generic menu
const UI = { open: false };
window._openMenu = (...a) => openMenu(...a);
function openMenu(title, rows, sub = '') {
  UI.open = true; keys.clear(); if (document.pointerLockElement) document.exitPointerLock();
  const m = document.getElementById('menu'); m.style.display = 'flex'; m.innerHTML = '';
  const h = document.createElement('div'); h.className = 'mh';
  const b = document.createElement('b'); b.textContent = title; h.append(b);
  const money = document.createElement('span'); money.textContent = '💵 ' + M.money + ' $ · 🏦 ' + L.bank + ' $'; h.append(money);
  m.append(h);
  if (sub) { const s = document.createElement('p'); s.textContent = sub; m.append(s); }
  const list = document.createElement('div'); list.className = 'ml';
  for (const r of rows) {
    if (r.sep) { const s = document.createElement('i'); s.textContent = r.sep; list.append(s); continue; }
    const btn = document.createElement('button'); btn.textContent = r.t; if (r.dis) btn.disabled = true;
    btn.onclick = () => { r.fn(); if (UI.open && r.keep !== false && m._refresh) m._refresh(); };
    list.append(btn);
  }
  m.append(list);
  const c = document.createElement('button'); c.className = 'mc'; c.textContent = 'Fermer (Échap)'; c.onclick = closeMenu; m.append(c);
}
function closeMenu() { UI.open = false; const m = document.getElementById('menu'); m.style.display = 'none'; m._refresh = null; }
function menu(fn) { const m = document.getElementById('menu'); m._refresh = fn; fn(); }
addEventListener('keydown', (e) => {
  if (e.code === 'Escape') { if (UI.open) closeMenu(); else if (L.placing) cancelPlace(); }
  if (!game.on || UI.open) return;
  if (e.code === 'KeyI') openInventory();
  if (e.code === 'KeyP') openPossessions();
  if (e.code === 'KeyR' && L.placing) L.placing.rot += Math.PI / 4;
  if (e.code === 'KeyX') pickFurniture();
});

// ---- inventory
function inCuisine() { return inside && ['appart', 'resto'].includes(inside.door.type); }
function openInventory() {
  menu(() => {
    const rows = [];
    const ids = Object.keys(L.inv).filter(k => L.inv[k] > 0);
    if (!ids.length && !Object.keys(J.inv).length) rows.push({ sep: 'Inventaire vide' });
    for (const id of ids) {
      const it = ITEMS[id] || {};
      const label = itemName(id) + ' ×' + L.inv[id];
      if (id.startsWith('F:')) rows.push({ t: '🪑 ' + label + ' — placer chez moi', fn: () => { closeMenu(); startPlace(id); } });
      else if (it.eat || it.drink || it.heal || it.cure || it.wash || it.sleep) rows.push({ t: (it.drink && !it.eat ? '🥤 ' : '🍽️ ') + label + ' — utiliser', fn: () => useItem(id) });
      else if (id === 'jerrycan') rows.push({ t: '⛽ ' + label + ' — utiliser sur le véhicule', fn: () => useItem(id) });
      else if (id === 'cle') rows.push({ t: '🔧 ' + label + ' — réparer le véhicule', fn: () => useItem(id) });
      else rows.push({ t: (it.tool ? '🛠️ ' : '📦 ') + label + (it.tool ? ' (équipé)' : ''), fn: () => {}, dis: true });
      if (!id.startsWith('F:') && !it.tool) rows.push({ t: '   ↳ déposer par terre', fn: () => dropItem(id) });
      if (!it.tool && !id.startsWith('F:')) rows.push({ t: '   ↳ porter dans les mains', fn: () => { L.carry = id; closeMenu(); banner('Tu portes : ' + itemName(id), 1200); updateCarry(); } });
    }
    const work = Object.entries(J.inv).map(([k, v]) => v + ' ' + k).join(', ');
    if (work) rows.push({ sep: 'Sac de travail : ' + work });
    rows.push({ sep: inCuisine() ? 'Cuisine (recettes)' : 'Recettes — va dans une cuisine (appartement, restaurant)' });
    for (const [out, ing] of RECIPES) {
      const ok = inCuisine() && Object.entries(ing).every(([k, n]) => have(k) >= n);
      rows.push({ t: '👩‍🍳 ' + ITEMS[out].n + ' = ' + Object.entries(ing).map(([k, n]) => n + ' ' + itemName(k)).join(' + '), dis: !ok, fn: () => { for (const [k, n] of Object.entries(ing)) take(k, n); give(out); banner('Préparé : ' + ITEMS[out].n, 1200); } });
    }
    openMenu('🎒 Inventaire', rows, 'I : inventaire · P : possessions');
  });
}
function useItem(id) {
  const it = ITEMS[id], n = L.needs;
  if (id === 'jerrycan' || id === 'cle') {
    const car = player.inCar || nearestOwnCar(); if (!car) { banner('Approche-toi d’un véhicule', 1200); return; }
    if (id === 'jerrycan') car.fuel = Math.min(100, (car.fuel ?? 100) + 30); else car.hp = Math.min(100, (car.hp ?? 100) + 50);
    if (id === 'jerrycan') take(id); banner(id === 'jerrycan' ? '⛽ +30 % d’essence' : '🔧 Véhicule réparé', 1200); return;
  }
  take(id);
  if (it.eat) n.faim = Math.min(100, n.faim + it.eat); if (it.drink) n.soif = Math.min(100, n.soif + it.drink);
  if (it.heal) n.sante = Math.min(hpMax(), n.sante + it.heal); if (it.sleep) n.sommeil = Math.min(100, n.sommeil + it.sleep);
  if (it.wash) n.hygiene = Math.min(100, n.hygiene + it.wash); if (it.cure) { L.sick = false; banner('💊 Tu es guéri', 1400); }
}
function nearestOwnCar() { let b = null, bd = 5; for (const c of parkedPlayerCars) { const d = c.obj.position.distanceTo(player.pos); if (d < bd) { bd = d; b = c; } } return b; }

// ---- drop / pick up / carry
let carryMesh = null;
function updateCarry() {
  if (carryMesh) { carryMesh.parent && carryMesh.parent.remove(carryMesh); carryMesh = null; }
  if (!L.carry || !player.ch) return;
  carryMesh = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0xc8a165 }));
  carryMesh.position.set(0, 1.0, 0.35); player.ch.o.add(carryMesh);
}
function dropItem(id) {
  take(id); if (L.carry === id && !L.inv[id]) { L.carry = null; updateCarry(); }
  const model = proto['K_Containers_Box_Small'] ? 'K_Containers_Box_Small' : null;
  const o = model ? makeObject(model) : new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xc8a165 }));
  o.position.set(player.pos.x + Math.sin(player.heading) * 0.8, player.pos.y, player.pos.z + Math.cos(player.heading) * 0.8); scene.add(o);
  L.drops.push({ id, o }); banner('Déposé : ' + itemName(id), 1000);
}
function nearDrop() { return L.drops.find(d => d.o.position.distanceTo(player.pos) < 1.6); }

// ---- benches (sit) & home spots
const benches = [];
function registerBench(x, z, rot) { benches.push({ x, z, rot }); }
function nearBench() { return benches.find(b => Math.hypot(b.x - player.pos.x, b.z - player.pos.z) < 1.6); }
function sit(b) { L.sitting = b; player.pos.set(b.x, player.pos.y, b.z); player.heading = b.rot; banner('Assis · E pour te lever', 1200); }

// ---- services on doors
const SERVICES = {
  banque: { label: '🏦 Banque', color: '#1565c0', n: 3 }, pharmacie: { label: '💊 Pharmacie', color: '#2e7d32', n: 3 },
  supermarche: { label: '🛒 Supermarché', color: '#ef6c00', n: 3, interior: 'epicerie' }, cafe: { label: '☕ Café / Bar', color: '#6d4c41', n: 4, interior: 'resto' },
  meubles: { label: '🪑 Magasin de meubles', color: '#8e24aa', n: 2 }, emploi: { label: '👔 Agence d’emploi', color: '#3949ab', n: 2 },
  immobilier: { label: '🏠 Agence immobilière', color: '#00897b', n: 2 }, mairie: { label: '🏛️ Mairie', color: '#5d4037', n: 1 },
  police: { label: '🚓 Commissariat', color: '#0d47a1', n: 2 }, bureaux: { label: '💼 Bureaux', color: '#455a64', n: 4 },
  concession: { label: '🚗 Concession auto', color: '#c62828', n: 2 }, assurance: { label: '🛡️ Assurance auto', color: '#00838f', n: 2 }, station: { label: '⛽ Station-service', color: '#f9a825', n: 0 },
};
function assignServices() {
  const order = doors.map((d, i) => i).sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101));
  let k = 0;
  for (const [kind, s] of Object.entries(SERVICES)) for (let c = 0; c < s.n; c++) {
    while (k < order.length && doors[order[k]].service) k++;
    const d = doors[order[k++]]; if (!d) break;
    d.service = kind; d.type = s.interior || 'service';
  }
  for (const d of doors) if (d.service === 'cafe' || (d.type === 'resto' && !d.service)) buildTerrace(d);
  for (const d of doors) {
    const s = d.service ? SERVICES[d.service] : null;
    if (s) { const sp = textPlaque(s.label, s.color, 2.8); sp.position.set(d.x - d.out[0] * 0.62, SW + (d.service === 'station' ? 6 : 3.9), d.z - d.out[1] * 0.62); sp.rotation.y = Math.atan2(d.out[0], d.out[1]);
      if (d.service === 'station' && proto.K_Fuel_A_Barrels) put('K_Fuel_A_Barrels', d.x + d.out[0] * 1.2 + d.out[1] * 2.5, SW, d.z + d.out[1] * 1.2 + d.out[0] * 2.5, 0, 1.4);
      if (d.service === 'police') { const o = proto.C_Police ? makeObject('C_Police') : proto.PoliceCar ? makeObject('PoliceCar') : null; if (o) { o.position.set(d.x + d.out[0] * 2.9 + d.out[1] * 4, SW + 0.24, d.z + d.out[1] * 2.9 + d.out[0] * 4); o.rotation.y = Math.atan2(d.out[1], -d.out[0]); scene.add(o); parkedPlayerCars.push({ obj: o, speed: 0 }); } }
    } else {
      const sign = { resto: 'PizzaSign_1_A', epicerie: 'MarketSign_1_A', jouets: 'GymSign_1_A', appart: d.id % 4 === 0 ? 'HotelSign_3_A' : null }[d.type];
      if (sign && proto[sign]) { // wall signs: thin along X, readable face on -X, origin on the wall plane
        const bb = proto[sign].bb, len = Math.max(bb.max.z - bb.min.z, bb.max.y - bb.min.y), sc = Math.min(1, 3.6 / len);
        const blade = sign === 'HotelSign_3_A';
        put(sign, d.x - d.out[0] * 0.7, SW + (blade ? 1.2 : 3.0), d.z - d.out[1] * 0.7, Math.atan2(d.out[1], -d.out[0]) + (blade ? Math.PI / 2 : 0), sc);
      }
    }
  }
}
function serviceMenu(d) {
  const kind = d.service;
  const enterRow = !inside ? [{ t: '🚪 Entrer dans le bâtiment', fn: () => { closeMenu(); enterDoor(d); }, keep: false }] : [];
  const openMenu = (T, rows, sub) => window._openMenu(T, [...rows], sub);
  const buy = (ids) => ids.map(id => ({ t: ITEMS[id].n + ' — ' + ITEMS[id].p + ' $', fn: () => { if (payMoney(ITEMS[id].p)) { give(id); banner('Acheté : ' + ITEMS[id].n, 900); } } }));
  menu(() => {
    const T = SERVICES[kind].label;
    if (kind === 'banque') {
      const r = [{ sep: 'Compte : ' + L.bank + ' $ · Liquide : ' + M.money + ' $' }];
      for (const v of [20, 100, 500]) r.push({ t: 'Déposer ' + v + ' $', dis: M.money < v, fn: () => { M.money -= v; L.bank += v; updateMissionHud(); } });
      r.push({ t: 'Déposer tout', dis: !M.money, fn: () => { L.bank += M.money; M.money = 0; updateMissionHud(); } });
      for (const v of [20, 100, 500]) r.push({ t: 'Retirer ' + v + ' $', dis: L.bank < v, fn: () => { L.bank -= v; M.money += v; updateMissionHud(); } });
      r.push({ t: '📋 Mes possessions', fn: openPossessions, keep: false });
      return openMenu(T, r, 'Les achats se paient en liquide, puis par carte bancaire.');
    }
    if (kind === 'pharmacie') return openMenu(T, [...buy(['medicament', 'bandage', 'savon', 'vitamines']), { t: '🩺 Consultation : soins complets — 40 $', fn: () => { if (payMoney(40)) { L.needs.sante = 100; L.sick = false; banner('Soigné', 1200); } } }], L.sick ? '🤒 Tu es malade : prends un médicament.' : '');
    if (kind === 'supermarche') return openMenu(T, [{ sep: 'Alimentation' }, ...buy(['pain', 'fromage', 'tomate', 'salade', 'oeuf', 'pates', 'viande', 'fruits', 'sucre', 'grains', 'legumes']), { sep: 'Boissons' }, ...buy(['eau', 'soda', 'lait', 'jus']), { sep: 'Produits' }, ...buy(['savon', 'jerrycan', 'arrosoir', 'pioche', 'cle'])]);
    if (kind === 'cafe') return openMenu(T, [...buy(['cafe', 'croissant', 'biere', 'jus', 'sandwich', 'dessert']), { t: '🍽️ Consommer sur place : café + croissant — 6 $', fn: () => { if (payMoney(6)) { L.needs.soif = Math.min(100, L.needs.soif + 20); L.needs.faim = Math.min(100, L.needs.faim + 15); L.needs.sommeil = Math.min(100, L.needs.sommeil + 10); } } }]);
    if (kind === 'meubles') return openMenu(T, FURN.map(([m, n, p]) => ({ t: n + ' — ' + p + ' $', fn: async () => { if (!payMoney(p)) return; await loadInteriorPack(); give('F:' + m); banner('Acheté : ' + n + ' (inventaire → placer chez moi)', 1600); } })), L.home === null ? 'Il te faut un logement pour placer les meubles (agence immobilière).' : 'Les meubles vont dans l’inventaire (I), puis « placer chez moi ».');
    if (kind === 'emploi') {
      const r = Object.entries(JOBS).map(([k, j]) => { const s = jobSpots.find(s => s.def.job === k); return { t: j.icon + ' ' + j.label + (J.job === k ? ' (ton métier)' : '') + ' — GPS', fn: () => { if (s) { L.gps = s.pos.clone(); L.gpsLabel = j.label; banner('GPS : ' + j.label, 1200); } }, keep: false }; });
      r.push({ t: '💼 Employé de bureau — GPS vers des bureaux', fn: () => gpsTo('bureaux', 'Bureaux') }, { t: '🏭 Ouvrier d’usine — GPS', fn: () => { const s = jobSpots.find(s => s.kind === 'factory'); if (s) { L.gps = s.pos.clone(); L.gpsLabel = 'Usine'; } } }, { t: '📦 Manutention en entrepôt — GPS', fn: () => { const s = jobSpots.find(s => s.kind === 'warehouse'); if (s) { L.gps = s.pos.clone(); L.gpsLabel = 'Entrepôt'; } } });
      return openMenu(T, r, 'Choisis un métier : le GPS t’y emmène (cercle blanc sur la minicarte).');
    }
    if (kind === 'immobilier') {
      const blds = doors.filter(x => x.type === 'appart' && !x.unit && !x.service).map(x => ({ x, d: Math.hypot(x.x - player.pos.x, x.z - player.pos.z) })).sort((a, b) => a.d - b.d).slice(0, 6);
      const r = [{ sep: '📂 Mes biens : ' + (L.props.length ? L.props.map(p => doors[p.uid].label + ' (' + MODE_LABEL[p.mode] + ')').join(', ') : 'aucun') }];
      for (const { x, d } of blds) { const free = unitsOf(x).filter(u => !u.npc && !propOf(u.id)); const min = free.length ? Math.min(...free.map(u => unitPrice(u, false))) : 0;
        r.push({ t: '🏢 Immeuble à ' + Math.round(d) + ' m — ' + free.length + ' appartement(s) libre(s)' + (free.length ? ' · dès ' + min + ' $' : '') + ' — GPS', fn: () => { L.gps = new THREE.Vector3(x.x, 0, x.z); L.gpsLabel = 'Immeuble'; } }); }
      return openMenu(T, r, 'Achat, location et visite à l’accueil de chaque immeuble. Max 2 résidences ; les autres biens peuvent être mis en location (investissement).');
    }
    if (kind === 'mairie') return openMenu(T, [
      { t: L.permis ? '🪪 Permis de conduire ✔' : '🪪 Permis de conduire — 100 $ (requis à la concession)', dis: L.permis, fn: () => { if (payMoney(100)) { L.permis = true; banner('Permis obtenu', 1200); } } },
      { t: '🤝 Aide sociale (+50 $, si moins de 20 $, toutes les 5 min)', dis: M.money + L.bank >= 20 || performance.now() - L.aide < 300000, fn: () => { M.money += 50; L.aide = performance.now(); updateMissionHud(); } },
      { t: '📋 Mes possessions', fn: openPossessions, keep: false }]);
    if (kind === 'police') return openMenu(T, [{ sep: 'Amendes impayées : ' + L.fines + ' $ (feux rouges grillés)' }, { t: 'Payer mes amendes', dis: !L.fines, fn: () => { if (payMoney(L.fines)) { L.fines = 0; banner('Amendes payées', 1200); } } }, { t: '🚓 Emprunter une voiture de patrouille (devant)', fn: () => banner('Monte dans la voiture de police garée devant (E)', 1600), keep: false }]);
    if (kind === 'bureaux') return openMenu(T, [{ t: '💼 Travailler 20 s au bureau (+45 $)', fn: () => { closeMenu(); work(20, 45, 'Travail de bureau'); }, keep: false }]);
    if (kind === 'concession') {
      const cat = [['C_Thunderball', 'Thunderball', 700], ['C_Neptune', 'Neptune', 550], ['C_Galacci', 'Galacci', 520], ['C_Rammer', 'Rammer', 480], ['C_Mascuilo', 'Mascuilo (mini)', 250], ['C_car3', 'Classique V3', 380], ['SportCar_1', 'Voiture de sport', 600], ['SportCar_7', 'Sportive rouge', 650], ['PickUp_2', 'Pick-up', 450], ['Van_2', 'Utilitaire', 400], ['Car_5_A', 'Citadine', 300], ['Taxi', 'Berline taxi', 350]].filter(c => proto[c[0]]);
      const r = cat.map(([m, n, p]) => ({ t: n + ' — ' + p + ' $', dis: !L.permis, fn: () => { if (!payMoney(p)) return; const o = makeObject(m); o.position.set(d.x + d.out[0] * 3 + d.out[1] * 5, SW + 0.24, d.z + d.out[1] * 3 + d.out[0] * 5); o.rotation.y = Math.atan2(d.out[1], -d.out[0]); scene.add(o); const car = { obj: o, speed: 0, owned: true, fuel: 100, hp: 100, name: n }; parkedPlayerCars.push(car); L.owned.push(car); banner('🚗 ' + n + ' achetée, garée devant', 1600); } }));
      const mine = nearestOwnCar(); if (mine && mine.owned) r.push({ t: 'Vendre « ' + mine.name + ' » (moitié prix)', fn: () => { const p = 200; M.money += p; scene.remove(mine.obj); parkedPlayerCars.splice(parkedPlayerCars.indexOf(mine), 1); L.owned.splice(L.owned.indexOf(mine), 1); banner('Véhicule vendu +' + p + ' $', 1400); } });
      return openMenu(T, r, L.permis ? 'Le véhicule t’appartient : il apparaît dans tes possessions.' : 'Il faut le permis de conduire (mairie).');
    }
    if (kind === 'station') {
      const car = nearestOwnCar() || player.inCar;
      return openMenu(T, [{ sep: car ? 'Véhicule : essence ' + Math.round(car.fuel ?? 100) + ' %' : 'Gare ton véhicule devant la station' }, { t: '⛽ Faire le plein (1 $ par 5 %)', dis: !car || (car.fuel ?? 100) >= 100, fn: () => { const n = Math.ceil((100 - (car.fuel ?? 100)) / 5); if (payMoney(n)) car.fuel = 100; } }, ...buy(['jerrycan', 'eau', 'soda', 'sandwich'])]);
    }
  });
}
function gpsTo(service, label) { const d = doors.filter(x => x.service === service).sort((a, b) => Math.hypot(a.x - player.pos.x, a.z - player.pos.z) - Math.hypot(b.x - player.pos.x, b.z - player.pos.z))[0]; if (d) { L.gps = new THREE.Vector3(d.x, 0, d.z); L.gpsLabel = label; } }
function setHome(x, rent) {
  const u = (x.unit ? [x] : unitsOf(x)).find(u => !u.npc && !propOf(u.id)); if (!u) { banner('Plus d’appartement libre ici', 1400); return; }
  for (const p of L.props) if (p.mode === 'principal') p.mode = 'secondaire';
  while (residences().length > 2) residences().find(p => p.mode === 'secondaire').mode = 'invest';
  L.props.push({ uid: u.id, own: !rent, mode: 'principal', furnished: true, due: RENT_PERIOD, furn: [], tenant: 0 }); syncHome();
  L.gps = new THREE.Vector3(u.x, 0, u.z); L.gpsLabel = 'Maison'; banner(rent ? '🔑 Appartement ' + u.label + ' loué !' : '🏠 Appartement ' + u.label + ' acheté !', 1800);
}
// timed work (offices, factories, warehouses)
function work(sec, payN, label) {
  const f = document.getElementById('fade'); f.style.display = 'flex'; f.textContent = '⏳ ' + label + '…';
  L.working = { t: sec, payN, label };
}
// ---- possessions
function openPossessions() {
  menu(() => {
    const h = L.home !== null ? doors[L.home] : null;
    const r = [{ sep: '💵 Liquide : ' + M.money + ' $ · 🏦 Banque : ' + L.bank + ' $ · Amendes : ' + L.fines + ' $' },
      ...(L.props.length ? L.props.map(p => ({ sep: '🏠 Appartement ' + doors[p.uid].label + ' : ' + (p.own ? 'propriétaire' : 'locataire') + ' · ' + MODE_LABEL[p.mode] + (p.furnished ? ' · meublé' : ' · vide') + (p.own && p.mode !== 'invest' ? '' : ' · ' + unitRent(doors[p.uid], p.furnished) + ' $ / 5 min') })) : [{ sep: '🏠 Logement : aucun' }]),
      { sep: '🚗 Véhicules : ' + (L.owned.length ? L.owned.map(c => c.name + ' (' + Math.round(c.fuel) + ' % essence, état ' + Math.round(c.hp) + ' %)').join(', ') : 'aucun') },
      { sep: '🪪 Permis : ' + (L.permis ? 'oui' : 'non') + ' · Métier : ' + (J.job ? JOBS[J.job].label : 'aucun') },
      { sep: '🪑 Meubles placés : ' + L.props.reduce((a, p) => a + (p.furn || []).length, 0) + ' · Objets : ' + Object.values(L.inv).reduce((a, b) => a + b, 0) }];
    if (h) r.push({ t: '📍 GPS vers mon logement', fn: () => { L.gps = new THREE.Vector3(h.x, 0, h.z); L.gpsLabel = 'Maison'; } });
    r.push({ t: '💾 Sauvegarder maintenant', fn: saveGame });
    openMenu('📋 Mes possessions', r);
  });
}

// ---- home interior: furniture, bed, bath, chest
function homeRoom() { return inside && isRes(inside.door.id) ? inside.room : null; }
function roomSpot(name) { const r = inside && inside.room; return r && r.spots && r.spots[name]; }
function startPlace(id) {
  const r = homeRoom(); if (!r) { banner('Entre chez toi pour placer un meuble', 1500); return; }
  const m = id.slice(2); if (!proto[m]) { banner('Meuble pas encore chargé', 1200); return; }
  const g = makeObject(m); g.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.6; } }); scene.add(g);
  L.placing = { id, m, g, rot: 0 }; banner('Placer : R tourner · E poser · Échap annuler', 2500);
}
function cancelPlace() { if (!L.placing) return; scene.remove(L.placing.g); L.placing = null; }
function confirmPlace() {
  const p = L.placing, r = homeRoom(); if (!p || !r) return;
  const x = p.g.position.x - r.ox, z = p.g.position.z - r.oz;
  if (x < 0.3 || z < 0.3 || x > r.w - 0.3 || z > r.d - 0.3) { banner('Hors de la pièce', 1000); return; }
  // no overlap with walls, partitions or other furniture
  const f = footprint(p.m, p.rot), ax0 = r.ox + x + f.minx + 0.05, ax1 = r.ox + x + f.maxx - 0.05, az0 = r.oz + z + f.minz + 0.05, az1 = r.oz + z + f.maxz - 0.05;
  if (r.cols.some(c => ax0 < c[2] && ax1 > c[0] && az0 < c[3] && az1 > c[1])) { banner('🚫 Pas de place ici (mur ou meuble)', 1200); return false; }
  if (r.exit && Math.hypot(r.exit.x - (r.ox + x), r.exit.z - (r.oz + z)) < 1.6) { banner('🚫 Ne bloque pas la porte', 1200); return false; }
  scene.remove(p.g); take(p.id);
  const e = { m: p.m, x, z, r: p.rot }; furnOf(inside.door.id).push(e); spawnFurn(r, e); L.placing = null; banner('Meuble posé · X près d’un meuble pour le reprendre', 1800); return true;
}
function spawnFurn(r, e) { const o = makeObject(e.m); o.position.set(r.ox + e.x, 0, r.oz + e.z); o.rotation.y = e.r; r.group.add(o); e.o = o; const f = footprint(e.m, e.r); e.col = [r.ox + e.x + f.minx, r.oz + e.z + f.minz, r.ox + e.x + f.maxx, r.oz + e.z + f.maxz]; r.cols.push(e.col); }
function pickFurniture() {
  const r = homeRoom(); if (!r) return;
  let best = null, bd = 1.8; for (const e of furnOf(inside.door.id)) { const d = Math.hypot(r.ox + e.x - player.pos.x, r.oz + e.z - player.pos.z); if (d < bd) { bd = d; best = e; } }
  if (!best) return; r.group.remove(best.o); if (best.col) { const i = r.cols.indexOf(best.col); if (i >= 0) r.cols.splice(i, 1); } furnOf(inside.door.id).splice(furnOf(inside.door.id).indexOf(best), 1); give('F:' + best.m); banner('Meuble repris (inventaire) : déplace-le en le replaçant', 1600);
}
function onRoomBuilt(room, door) {
  addCounterRing(room);
  if (door.type === 'service' || door.type === 'epicerie' || door.type === 'jouets' || door.type === 'lobby') { roomActor(hallPoints(4, room), room); if (chance(0.6)) roomActor(hallPoints(4, room), room); }
  if (door.type === 'appart' && room.flat2) room.spots = flatSpots(room);
  else if (door.type === 'appart') room.spots = { bed: new THREE.Vector3(room.ox + 2.0, 0, room.oz + 1.6), bath: new THREE.Vector3(room.ox + 11.0, 0, room.oz + 6.8), kitchen: new THREE.Vector3(room.ox + 9.0, 0, room.oz + 1.4), chest: new THREE.Vector3(room.ox + 5.6, 0, room.oz + 0.6) };
  if (door.type === 'appart' && proto.K_Containers_Crate_Large) { /* chest */ }
  if (door.type === 'appart') { const c = proto['K_Containers_Box_Large'] ? makeObject('K_Containers_Box_Large') : null; if (c) { c.position.copy(room.spots.chest); room.group.add(c); } }
  if (propOf(door.id)) for (const e of furnOf(door.id)) spawnFurn(room, e);
}
const chest = {};
function openChest() {
  menu(() => {
    const r = [{ sep: 'Dans le coffre' }];
    for (const [id, n] of Object.entries(chest)) if (n > 0) r.push({ t: '⬆️ Prendre ' + itemName(id) + ' ×' + n, fn: () => { chest[id]--; give(id); } });
    r.push({ sep: 'Dans ton inventaire' });
    for (const [id, n] of Object.entries(L.inv)) if (n > 0 && !ITEMS[id]?.tool) r.push({ t: '⬇️ Ranger ' + itemName(id) + ' ×' + n, fn: () => { take(id); chest[id] = (chest[id] || 0) + 1; } });
    openMenu('🧰 Coffre', r);
  });
}

// ---- E key (highest priority)
function lifeAction() {
  if (UI.open) return true;
  if (L.placing) { confirmPlace(); return true; }
  if (L.sitting) { L.sitting = null; return true; }
  if (L.working) return true;
  if (player.inCar && gateAction()) return true;
  if (inside && inside.door.type === 'lobby' && lobbyAction()) return true;
  if (parkomatNear()) { if (L.street) payStreet(1); else banner('Aucune voiture à payer ici', 1200); return true; }
  if (player.inCar) {
    const c = player.inCar, at = (list) => list.find(p => Math.hypot(p.x - c.obj.position.x, p.z - c.obj.position.z) < 2.2);
    if (Math.abs(c.speed) < 1 && at(pumpSpots)) { const n = Math.ceil((100 - (c.fuel ?? 100)) / 5); if (n <= 0) banner('Réservoir déjà plein', 1000); else if (payMoney(n)) { c.fuel = 100; banner('⛽ Plein fait (−' + n + ' $)', 1400); } return true; }
    if (Math.abs(c.speed) < 1 && at(repairSpots)) { if ((c.hp ?? 100) >= 100) banner('Véhicule en parfait état', 1000); else if (payMoney(repairPrice(20))) { c.hp = 100; banner('🔧 Réparé par le garagiste (−20 $)', 1500); } return true; }
    return false;
  }
  const dr = nearDrop(); if (dr) { scene.remove(dr.o); L.drops.splice(L.drops.indexOf(dr), 1); give(dr.id); banner('Ramassé : ' + itemName(dr.id), 900); return true; }
  if (inside) {
    const near = (s, r = 1.8) => s && Math.hypot(s.x - player.pos.x, s.z - player.pos.z) < r;
    const home = homeRoom();
    if (inside.room.counter && near(inside.room.counter, 1.6)) { counterMenu(inside.door); return true; }
    if (inside.room.seats) { const s = inside.room.seats.find(s => near(s, 1.3)); if (s) { tableUI(s); return true; } }
    if (L.itask && inside.door.id === L.itask.door && inside.room.counter && near(inside.room.counter, 3)) { const o = L.itask; L.itask = null; o.done = true; L.gps = null; closeMenu(); work(o.sec, o.pay, o.label); return true; }
    if (near(roomSpot('bed'), 2.2)) { if (!home) { banner('Ce n’est pas chez toi', 1200); return true; } sleepNow(100); return true; }
    if (near(roomSpot('bath'), 2.0)) { if (!home) { banner('Ce n’est pas chez toi', 1200); return true; } if (!L.util) { banner('🚱 Pas d’eau : souscris le pack énergie/eau à la mairie', 1800); return true; } L.needs.hygiene = 100; if (L.sick && Math.random() < 0.3) L.sick = false; banner('🛁 Tu t’es lavé', 1200); return true; }
    if (near(roomSpot('chest'), 1.8) && home) { openChest(); return true; }
    if (near(roomSpot('kitchen'), 2.4)) { if (home && !L.util) { banner('⚡ Pas de gaz ni d’électricité : pack énergie/eau à la mairie', 1800); return true; } openInventory(); return true; }
    if (inside.room.shelves) for (const s of inside.room.shelves) if (near(s, 1.6)) {
      const id = pick(['pain', 'fromage', 'tomate', 'salade', 'oeuf', 'pates', 'viande', 'fruits', 'eau', 'lait', 'jus', 'soda']);
      if (payMoney(ITEMS[id].p)) { give(id); banner('Pris sur l’étagère : ' + ITEMS[id].n + ' (−' + ITEMS[id].p + ' $)', 1200); } return true;
    }
    return false;
  }
  const d = nearDoor(); if (d && d.service) { enterDoor(d); return true; }
  if (hoopNear()) { gymMenu(); return true; }
  const b = nearBench(); if (b) { sit(b); return true; }
  return false;
}
function sleepNow(q) {
  const f = document.getElementById('fade'); f.style.display = 'flex'; f.textContent = '😴 Zzz…';
  setTimeout(() => { GT.min += 8 * 60; if (GT.min >= 1440) { GT.min -= 1440; GT.day++; } L.needs.sommeil = q; L.needs.faim = Math.max(0, L.needs.faim - 20); L.needs.soif = Math.max(0, L.needs.soif - 25); f.style.display = 'none'; banner('Bien dormi !', 1200); }, 1800);
}
function faint(reason) {
  const hosp = jobSpots.find(s => s.kind === 'hospital');
  const f = document.getElementById('fade'); f.style.display = 'flex'; f.textContent = '💫 ' + reason + '… réveil à l’hôpital';
  if (player.inCar) { player.inCar.speed = 0; parkedPlayerCars.push(player.inCar); player.inCar = null; player.ch.o.visible = true; }
  if (inside) inside = null; L.sitting = null;
  setTimeout(() => {
    if (hosp) player.pos.set(hosp.pos.x, SW, hosp.pos.z + 1);
    const fee = Math.min(50, M.money + L.bank); if (fee) payMoney(fee);
    Object.assign(L.needs, { sommeil: Math.max(L.needs.sommeil, 60), sante: 70, faim: Math.max(L.needs.faim, 40), soif: Math.max(L.needs.soif, 40) });
    L.sick = false; f.style.display = 'none'; banner('🏥 Soigné à l’hôpital (−' + fee + ' $)', 2200);
  }, 2200);
}

// ---- per-frame
let lifeT = 0, saveT = 0;
function updateLife(dt) {
  if (!game.on) return;
  const n = L.needs, car = player.inCar;
  // placement ghost
  if (L.placing) { const p = L.placing; p.g.position.set(player.pos.x + Math.sin(player.heading) * 1.6, 0, player.pos.z + Math.cos(player.heading) * 1.6); p.g.rotation.y = p.rot; }
  if (L.sitting) { player.pos.x = L.sitting.x; player.pos.z = L.sitting.z; player.ch.o.position.y = player.pos.y - 0.35; n.sommeil = Math.min(100, n.sommeil + dt * 0.6); }
  if (L.working) { const w = L.working; w.t -= dt; n.sommeil -= dt * 0.4; n.faim -= dt * 0.2; if (w.t <= 0) { L.working = null; document.getElementById('fade').style.display = 'none'; pay(w.payN, '💼 ' + w.label); } }
  // needs decay (per second): a full bar lasts ~8-15 min
  const run = keys.has('ShiftLeft') && !car;
  n.faim -= dt * (0.11 + (run ? 0.05 : 0)); n.soif -= dt * (0.15 + (run ? 0.08 : 0)); n.hygiene -= dt * (0.09 + (run ? 0.05 : 0)); n.sommeil -= dt * (L.sick ? 0.16 : 0.1);
  if (n.faim <= 0 || n.soif <= 0) n.sante -= dt * 0.8;
  if (L.sick) n.sante -= dt * 0.12;
  for (const k in n) n[k] = Math.max(0, Math.min(100, n[k]));
  lifeT += dt;
  if (lifeT > 5) { lifeT = 0; if (n.hygiene < 20 && !L.sick && Math.random() < 0.15) { L.sick = true; banner('🤒 Tu es tombé malade (hygiène) : médicament ou hôpital', 2600); } }
  if ((n.sommeil <= 0 || n.sante <= 0) && !L.fainting) { L.fainting = true; faint(n.sommeil <= 0 ? 'Épuisé, tu tombes dans les pommes' : 'Tu t’effondres'); setTimeout(() => { L.fainting = false; }, 3000); }
  // vehicle fuel, damage, red lights
  if (car) {
    car.fuel = car.fuel ?? rr(45, 100); car.hp = car.hp ?? 100;
    car.fuel = Math.max(0, car.fuel - Math.abs(car.speed) * dt * 0.018);
    for (const it of intersections.values()) {
      if (Math.abs(it.x - car.obj.position.x) < 3 && Math.abs(it.z - car.obj.position.z) < 3 && Math.abs(car.speed) > 6) {
        const h = car.obj.rotation.y, axis = Math.abs(Math.sin(h)) > Math.abs(Math.cos(h)) ? 'x' : 'z';
        const key = it.i + ',' + it.j;
        if (lightState(it, axis) === 'r' && L.lastFine !== key) { L.lastFine = key; L.fines += 30; banner('🚨 Feu rouge grillé : amende 30 $ (commissariat)', 2000); }
      } else if (L.lastFine === it.i + ',' + it.j && Math.hypot(it.x - car.obj.position.x, it.z - car.obj.position.z) > 10) L.lastFine = '';
    }
  }
  // rent
  updateProps(dt);
  if (L.gps && !inside && Math.hypot(L.gps.x - player.pos.x, L.gps.z - player.pos.z) < 8) { L.gps = null; banner('Arrivé : ' + L.gpsLabel, 1200); }
  saveT += dt; if (saveT > 15) { saveT = 0; saveGame(true); }
  updateNeedsHud();
}
function updateNeedsHud() {
  const el = document.getElementById('needs'); if (!el) return;
  const mo = document.getElementById('money'); if (mo && mo.textContent !== M.money + ' $') mo.textContent = M.money + ' $';
  const n = L.needs; let h = '<em>🕗 ' + hourStr() + ' · Jour ' + GT.day + ' · ' + phase(GT.min / 60) + '</em>';
  for (const k of Object.keys(NEED_ICONS)) { const v = Math.round(n[k]), c = v < 20 ? '#ff5a3c' : v < 45 ? '#ffc21a' : '#3cff8a'; h += '<div><span>' + NEED_ICONS[k] + '</span><i><b style="width:' + v + '%;background:' + c + '"></b></i></div>'; }
  if (L.sick) h += '<em>🤒 Malade</em>';
  const car = player.inCar; if (car) h += '<em>⛽ ' + Math.round(car.fuel ?? 100) + ' % · 🔧 ' + Math.round(car.hp ?? 100) + ' %</em>';
  if (L.gps && !inside) h += '<em>📍 ' + L.gpsLabel + ' : ' + Math.round(Math.hypot(L.gps.x - player.pos.x, L.gps.z - player.pos.z)) + ' m</em>';
  h += '<em>🏦 ' + L.bank + ' $</em>';
  if (el._h !== h) { el._h = h; el.innerHTML = h; }
}
function lifePrompt() {
  if (L.placing) return 'R : tourner · E : poser · Échap : annuler';
  if (L.sitting) return 'Assis (repos) · E : se lever';
  if (player.inCar && gatePrompt()) return gatePrompt();
  if (inside && inside.door.type === 'lobby' && lobbyPrompt()) return lobbyPrompt();
  if (parkomatNear()) return L.street ? 'E : horodateur — payer 1 h (' + PAID.price + ' $)' : 'Horodateur';
  if (player.inCar) {
    const c = player.inCar, at = (list) => list.find(p => Math.hypot(p.x - c.obj.position.x, p.z - c.obj.position.z) < 2.2);
    if (at(pumpSpots)) return Math.abs(c.speed) < 1 ? 'E : faire le plein (' + Math.ceil((100 - (c.fuel ?? 100)) / 5) + ' $) · essence ' + Math.round(c.fuel ?? 100) + ' %' : 'Arrête-toi dans le cercle';
    if (at(repairSpots)) return Math.abs(c.speed) < 1 ? 'E : faire réparer (20 $) · état ' + Math.round(c.hp ?? 100) + ' %' : 'Arrête-toi sur la place';
    return (c.fuel ?? 100) <= 0 ? '⛽ Panne d’essence ! Jerrycan (I) ou station-service' : '';
  }
  if (nearDrop()) return 'E : ramasser ' + itemName(nearDrop().id);
  if (inside) {
    const near = (s, r = 1.8) => s && Math.hypot(s.x - player.pos.x, s.z - player.pos.z) < r;
    const home = homeRoom();
    if (inside.room.counter && near(inside.room.counter, 1.6)) return 'E : ' + (inside.door.service ? 'guichet · ' + SERVICES[inside.door.service].label : inside.door.type === 'resto' ? 'comptoir (à emporter · livreur)' : 'accueil');
    if (inside.room.seats && inside.room.seats.some(s => near(s, 1.3))) return 'E : s’asseoir et commander';
    if (near(roomSpot('bed'), 2.2)) return home ? 'E : dormir' : 'Lit (pas chez toi)';
    if (near(roomSpot('bath'), 2.0)) return home ? 'E : se laver' : 'Baignoire (pas chez toi)';
    if (near(roomSpot('chest')) && home) return 'E : ouvrir le coffre';
    if (near(roomSpot('kitchen'), 2.4)) return 'E : cuisiner (recettes)';
    if (inside.room.shelves) for (const s of inside.room.shelves) if (near(s, 1.6)) return 'E : prendre un produit sur l’étagère';
    if (home) for (const e of furnOf(inside.door.id)) if (Math.hypot(inside.room.ox + e.x - player.pos.x, inside.room.oz + e.z - player.pos.z) < 1.8) return 'X : reprendre ce meuble';
    return '';
  }
  const d = nearDoor(); if (d && d.service) return 'E : ' + SERVICES[d.service].label;
  if (d && d.type === 'appart' && L.props.some(p => doors[p.uid] && doors[p.uid].of === d)) return 'E : entrer dans mon immeuble';
  if (nearBench()) return 'E : s’asseoir';
  return '';
}
function drawLifeOnMap(c, k) {
  for (const d of doors) if (d.service) { c.fillStyle = SERVICES[d.service].color; c.fillRect((d.x + HALF) * k - 2.5, (d.z + HALF) * k - 2.5, 5, 5); }
  if (L.home !== null) { const h = doors[L.home]; c.fillStyle = '#fff'; c.font = '11px sans-serif'; c.fillText('🏠', (h.x + HALF) * k - 6, (h.z + HALF) * k + 4); }
  { const gt = gpsTarget(); if (gt && !L.gps) { c.strokeStyle = '#ffd54f'; c.lineWidth = 2; c.setLineDash([3, 3]); c.beginPath(); c.moveTo((player.pos.x + HALF) * k, (player.pos.z + HALF) * k); c.lineTo((gt.x + HALF) * k, (gt.z + HALF) * k); c.stroke(); c.setLineDash([]); } }
  if (L.gps) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.setLineDash([3, 3]); c.beginPath(); c.moveTo((player.pos.x + HALF) * k, (player.pos.z + HALF) * k); c.lineTo((L.gps.x + HALF) * k, (L.gps.z + HALF) * k); c.stroke(); c.setLineDash([]); }
}
// ---- save / load (this browser)
function saveGame(quiet) {
  try { localStorage.setItem('cartooncity_save', JSON.stringify({ t: Date.now(), money: M.money, bank: L.bank, inv: L.inv, needs: L.needs, sick: L.sick, props: L.props.map(p => ({ b: doors[p.uid].of.id, k: doors[p.uid].of.units.indexOf(doors[p.uid]), own: p.own, mode: p.mode, furnished: p.furnished, due: p.due, tenant: p.tenant, furn: (p.furn || []).map(e => ({ m: e.m, x: e.x, z: e.z, r: e.r })) })), fines: L.fines, permis: L.permis, x2: { interim: L.interim, util: L.util, utilDay: L.utilDay, loan: L.loan, loanBase: L.loanBase, loanDay: L.loanDay, ins: L.ins, insDay: L.insDay, gymUntil: L.gymUntil }, chest, job: J.job, jinv: J.inv })); if (!quiet) banner('💾 Sauvegardé', 900); } catch (e) {}
  cloudPush();
}
function loadGame() {
  try {
    const s = JSON.parse(localStorage.getItem('cartooncity_save') || 'null'); if (!s) return;
    M.money = s.money; L.bank = s.bank; L.inv = s.inv || {}; Object.assign(L.needs, s.needs || {}); L.sick = !!s.sick; L.props = [];
    for (const q of s.props || []) { const b = doors[q.b]; if (!b) continue; const u = unitsOf(b)[q.k]; if (!u) continue; u.npc = false; u.furnished = q.furnished; L.props.push({ uid: u.id, own: q.own, mode: q.mode, furnished: q.furnished, due: q.due || RENT_PERIOD, tenant: q.tenant || 0, furn: q.furn || [] }); }
    if (!s.props && s.home != null && doors[s.home]) { setHome(doors[s.home], !!s.homeRent); const p = L.props[0]; if (p) p.furn = s.furn || []; }
    syncHome(); L.furn = []; L.fines = s.fines || 0; L.permis = !!s.permis; Object.assign(L, s.x2 || {}); Object.assign(chest, s.chest || {}); J.job = s.job || null; J.inv = s.jinv || {};
    if (L.props.some(p => p.furn.length)) loadInteriorPack();
    updateMissionHud();
  } catch (e) {}
}

// ================================================================ INTERIORS (enterable buildings)
const doors = [];          // { id, x, z, out:[ox,oz], type, built }
const INT_TYPES = {
  lobby: { label: 'Hall', color: 0xb0bec5 },
  appart: { label: 'Appartement', color: 0x7ad3ff },
  resto: { label: 'Restaurant', color: 0xff8a3c },
  epicerie: { label: 'Épicerie', color: 0x6ee06e },
  jouets: { label: 'Jouets & Sport', color: 0xff5ad0 },
  entrepot: { label: 'Entrepôt', color: 0xc9a46a },
  service: { label: 'Service', color: 0xffffff },
};
const INT_W = [['appart', 45], ['resto', 15], ['epicerie', 15], ['jouets', 13], ['entrepot', 12]];
function pickIntType(i) { let r = ((i * 2654435761) >>> 0) % 100; for (const [t, w] of INT_W) { if (r < w) return t; r -= w; } return 'appart'; }
// called during layout for each building that gets a street door
function registerDoor(x, z, ox, oz) {
  const id = doors.length, type = pickIntType(id + 7);
  doors.push({ id, x, z, out: [ox, oz], type, built: null });

}
let doorMarks = null;
function initDoorMarks() {
  const g = new THREE.RingGeometry(0.55, 0.85, 28); g.rotateX(-Math.PI / 2);
  doorMarks = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false }), doors.length);
  const c = new THREE.Color();
  doors.forEach((d, i) => { _m.makeTranslation(d.x, SW + 0.05, d.z); doorMarks.setMatrixAt(i, _m); doorMarks.setColorAt(i, c.setHex(INT_TYPES[d.type].color)); });
  doorMarks.computeBoundingSphere(); doorMarks.frustumCulled = false; scene.add(doorMarks);
}

// ---- lazy asset loading
let ipackReady = null;
function loadInteriorPack() {
  if (ipackReady) return ipackReady;
  ipackReady = (async () => {
    say('Chargement des intérieurs…');
    const loader = new GLTFLoader();
    for (const [ix, bin] of [['iindex.json', 'ipack.bin'], ['gindex.json', 'gpack.bin']]) {
    const idx = await (await fetch(BASE + ix)).json();
    const buf = await (await fetch(BASE + bin)).arrayBuffer();
    await Promise.all(Object.entries(idx).map(async ([name, [off, len]]) => {
      try {
        const g = await loader.parseAsync(buf.slice(off, off + len), '');
        g.scene.updateMatrixWorld(true);
        const parts = [];
        g.scene.traverse(o => { if (o.isMesh) { const mats = Array.isArray(o.material) ? o.material : [o.material]; if (mats.length === 1) parts.push({ geo: o.geometry, mat: sharedMat(mats[0]), mtx: o.matrixWorld.clone() }); else for (const grp of o.geometry.groups) { const geo = o.geometry.clone(); geo.clearGroups(); geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(grp.start, grp.start + grp.count), 1)); parts.push({ geo, mat: sharedMat(mats[grp.materialIndex]), mtx: o.matrixWorld.clone(), wheel: isWheel(o) }); } } });
        proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(g.scene) };
      } catch (e) { console.warn('int', name, e); }
    }));
    }
    await loadX2();
    say('');
  })();
  return ipackReady;
}
const fbxSets = {};
async function loadFbxSet(set) {
  if (fbxSets[set]) return fbxSets[set];
  fbxSets[set] = (async () => {
    say('Chargement des objets…');
    const list = (await (await fetch(BASE + 'int/sets.json')).json())[set] || [];
    const tex = set === 'toys' ? 'cc_models' : 'cc_food';
    const mgr = new THREE.LoadingManager(); mgr.setURLModifier(u => /\.(png|jpg|tga)$/i.test(u) ? 'data:,' : u);
    const L = new FBXLoader(mgr);
    let n = 0;
    await Promise.all(list.map(async (name) => {
      let o; try { o = await L.loadAsync(BASE + 'int/' + name + '.fbx'); } catch (e) { return; }
      o.traverse(m => { if (!m.isMesh) return; const ms = Array.isArray(m.material) ? m.material : [m.material];
        const out = ms.map(mt => { const f = new THREE.MeshStandardMaterial({ name: 'CC_' + tex, color: 0xffffff, roughness: 0.85, metalness: 0 }); f.userData = { tex }; return sharedMat(f); });
        m.material = Array.isArray(m.material) ? out : out[0]; });
      const wrap = new THREE.Group(); wrap.add(o); wrap.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(wrap), c = bb.getCenter(new THREE.Vector3());
      o.position.set(-c.x, -bb.min.y, -c.z); wrap.updateMatrixWorld(true);
      const parts = [];
      wrap.traverse(m => { if (!m.isMesh) return; const ms = Array.isArray(m.material) ? m.material : [m.material];
        if (ms.length === 1 || !m.geometry.groups.length) parts.push({ geo: m.geometry, mat: ms[0], mtx: m.matrixWorld.clone() });
        else for (const g of m.geometry.groups) { const geo = m.geometry.clone(); geo.clearGroups(); if (geo.index) geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(g.start, g.start + g.count), 1)); else for (const key in geo.attributes) { const at = geo.attributes[key]; geo.setAttribute(key, new THREE.BufferAttribute(at.array.slice(g.start * at.itemSize, (g.start + g.count) * at.itemSize), at.itemSize)); } parts.push({ geo, mat: ms[g.materialIndex], mtx: m.matrixWorld.clone(), wheel: isWheel(m) }); } });
      proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(wrap) };
      if (++n % 40 === 0) say(`Chargement des objets… ${n}/${list.length}`);
    }));
    say('');
    return list.filter(nm => proto[nm]);
  })();
  return fbxSets[set];
}

// ---- room building helpers
let curRoom = null;         // room being built
function iput(name, x, z, rot = 0, y = 0, col = true, sc = 1) {
  if (!proto[name]) return null;
  const o = makeObject(name);
  o.position.set(curRoom.ox + x, y, curRoom.oz + z); o.rotation.y = rot; o.scale.setScalar(sc);
  curRoom.group.add(o);
  if (col) {
    const f = footprint(name, rot);
    if ((f.maxx - f.minx) > 0.25 || (f.maxz - f.minz) > 0.25) curRoom.cols.push([curRoom.ox + x + f.minx * sc, curRoom.oz + z + f.minz * sc, curRoom.ox + x + f.maxx * sc, curRoom.oz + z + f.maxz * sc]);
  }
  return o;
}
const topOf = (name, sc = 1) => proto[name] ? proto[name].bb.max.y * sc : 0.8;
const pickExisting = (arr) => { const a = arr.filter(n => proto[n]); return a.length ? a[Math.floor(rnd() * a.length)] : null; };
function iputOn(baseName, items, x, z, rot, n = 4, spread = 0.5, sc = 1) {
  const y = topOf(baseName);
  for (let k = 0; k < n; k++) { const it = pickExisting(items); if (!it) continue; const a = rot, lx = rr(-spread, spread), lz = rr(-spread * 0.5, spread * 0.5); iput(it, x + lx * Math.cos(a) + lz * Math.sin(a), z - lx * Math.sin(a) + lz * Math.cos(a), rr(0, 6.28), y, false, sc); }
}
// room shell: W x D tiles of 2.5 m, door gap on the south wall at tile doorI
function shell(W, D, floor, wall, doorI) {
  const r = curRoom, T = 2.5;
  r.w = W * T; r.d = D * T;
  r.walls = { N: new THREE.Group(), S: new THREE.Group(), W: new THREE.Group(), E: new THREE.Group() };
  for (const k in r.walls) r.group.add(r.walls[k]);
  for (let i = 0; i < W; i++) for (let j = 0; j < D; j++) iput(floor, i * T + T / 2, j * T + T / 2, 0, -topOf(floor), false);
  const wallAt = (side, cx, cz, rot) => { const o = makeObject(wall); o.position.set(r.ox + cx, 0, r.oz + cz); o.rotation.y = rot; r.walls[side].add(o); };
  for (let i = 0; i < W; i++) {
    wallAt('N', i * T + T / 2, 0, 0);
    if (i !== doorI) wallAt('S', i * T + T / 2, r.d, Math.PI);
  }
  for (let j = 0; j < D; j++) { wallAt('W', 0, j * T + T / 2, Math.PI / 2); wallAt('E', r.w, j * T + T / 2, -Math.PI / 2); }
  // wall colliders (south wall leaves the door gap)
  const t = 0.2;
  r.cols.push([r.ox - t, r.oz - t, r.ox + r.w + t, r.oz + t], [r.ox - t, r.oz, r.ox + t, r.oz + r.d], [r.ox + r.w - t, r.oz, r.ox + r.w + t, r.oz + r.d]);
  r.cols.push([r.ox - t, r.oz + r.d - t, r.ox + doorI * T, r.oz + r.d + t], [r.ox + (doorI + 1) * T, r.oz + r.d - t, r.ox + r.w + t, r.oz + r.d + t]);
  // door leaf standing open beside the gap + exit marker
  iput(pickExisting(['I_Door_01', 'I_Door_02', 'I_Door_03']) || 'I_Door_01', doorI * T + 0.1, r.d - 0.05, Math.PI / 2, 0, false);
  r.exit = new THREE.Vector3(r.ox + doorI * T + T / 2, 0, r.oz + r.d - 0.6);
  r.spawn = new THREE.Vector3(r.ox + doorI * T + T / 2, 0, r.oz + r.d - 1.8);
  const mk = makeMarker(0x3cff8a, 2.2); mk.position.copy(r.exit); mk.scale.set(0.55, 1, 0.55); r.group.add(mk);
  r.exitMk = mk;
}
function roomNPC(x, z, clip = 'Idle_A-loop', face = 0) {
  const names = Object.keys(skinned);
  const ch = makeChar(names[Math.floor(rnd() * names.length)]);
  ch.o.position.set(curRoom.ox + x, 0, curRoom.oz + z); ch.o.rotation.y = face; play(ch, clip);
  curRoom.npcs.push(ch);
  return ch;
}

// ---- the five interior layouts (all coordinates inside the room: x right, z toward the entrance)
const BOOKS = ['I_Book_01', 'I_Book_02', 'I_Book_03', 'I_Book_04', 'I_Candle_01', 'I_Clock_01', 'I_PhotoFrame', 'I_KubikRubik', 'I_NoteBook_01'];
const KITCHEN_OBJ = ['I_Kettle', 'I_Toaster', 'I_Microvawe', 'I_Pot_01', 'I_Pan_01', 'I_Plate_01', 'I_Cup_01', 'I_Bread', 'I_Apple', 'I_Banana', 'I_Orange'];
function buildAppartOld() {
  curRoom.wallName = pickExisting(['I_Wall_01', 'I_Wall_02', 'I_Wall_03', 'I_Wall_04', 'I_Wall_05']);
  shell(5, 4, pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12']), curRoom.wallName, 2);
  partition('x', 5, 0, 5, [1, 2]); partition('z', 5, 0, 2, []); partition('z', 10, 2, 4, [2]);
  // living room (south-west)
  iput(pickExisting(['I_Catpet_01', 'I_Catpet_02', 'I_Catpet_03']), 2.6, 7.4, 0, 0.01, false);
  iput(pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_05', 'I_Sofa_07']), 2.6, 5.6, Math.PI); // faces the TV (south)
  iput('I_TV_Shelf', 2.6, 9.6, Math.PI, 0.45, false); iput('I_RoomTable_01', 2.6, 9.55, Math.PI); iput('I_TV', 2.6, 9.6, Math.PI, topOf('I_RoomTable_01'), false);
  iput('I_Lamp_01', 0.5, 5.9); iput('I_Library', 0.25, 7.6, Math.PI / 2); iputOn('I_Library', BOOKS, 0.25, 7.6, Math.PI / 2, 0);
  iput(pickExisting(['I_Flower_01', 'I_Flower_02', 'I_Flower_03']), 0.5, 9.5); iput(pickExisting(['I_Fireplace_01', 'I_Fireplace_02']), 4.7, 9.75, Math.PI);
  // bedroom (north-west)
  iput(pickExisting(['I_Bed1_01', 'I_Bed1_02', 'I_Bed2_01', 'I_Bed2_02']), 2.0, 1.45, 0);
  iput(pickExisting(['I_Bed_Table_01', 'I_Bed_Table_02']), 0.55, 0.35); iput('I_Lamp_03', 0.55, 0.35, 0, topOf('I_Bed_Table_01'), false);
  iput(pickExisting(['I_RoomFurniture_01', 'I_RoomFurniture_02', 'I_RoomFurniture_03', 'I_RoomFurniture_04']), 4.6, 0.4);
  iput(pickExisting(['I_Catpet_04', 'I_Catpet_05']), 2.0, 3.2, 0, 0.01, false);
  for (const [n, x] of [['I_Picture_01', 2.0], ['I_Picture_03', 6.5], ['I_Clock_02', 9]]) iput(n, x, 0.16, 0, 1.55, false);
  // kitchen (north-east)
  const tops = ['I_KitchenTabletop1_01', 'I_KitchenTabletop1_02', 'I_KitchenTabletop1_03', 'I_KitchenTabletop1_04'];
  let kx = 7.9; for (let i = 0; i < 4; i++) { const n = i === 2 ? 'I_Oven' : pickExisting(tops); iput(n, kx, 0.4, 0); if (i !== 2) iputOn(n, KITCHEN_OBJ, kx, 0.4, 0, 1, 0.3); kx += 1.14; }
  iput('I_RangeHood', 7.9 + 2 * 1.14, 0.25, 0, 1.75, false);
  iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_02', 'I_KitchenTable_03']), 10.2, 3.0, 0);
  for (const [dx, dz, r] of [[-0.55, -0.85, 0], [0.55, -0.85, 0], [-0.55, 0.85, Math.PI], [0.55, 0.85, Math.PI]]) iput(pickExisting(['I_KitchenChair_01', 'I_KitchenChair_02']), 10.2 + dx, 3.0 + dz, r);
  iputOn('I_KitchenTable_01', ['I_Plate_01', 'I_Cup_02', 'I_Pizza_01', 'I_Cake', 'I_Watermelon_01'], 10.2, 3.0, 0, 3, 0.5);
  // bathroom corner (south-east)
  iput('I_Bath', 11.6, 6.8, Math.PI / 2); iput(pickExisting(['I_Toilet_01', 'I_Toilet_02']), 12.1, 9.3, -Math.PI / 2);
  iput('I_Washer_01', 12.1, 5.6, -Math.PI / 2); iput(pickExisting(['I_ShowerCarpet_01', 'I_ShowerCarpet_02']), 10.7, 6.8, Math.PI / 2, 0.01, false);
  iput('I_Towel_01', 12.3, 8.2, -Math.PI / 2, 1.2, false); iput('I_Trash_01', 10.6, 9.6);
  // office corner
  iput('I_PC_Table', 8.4, 8.9, Math.PI); iput('I_PC_Screen', 8.4, 9.0, Math.PI, topOf('I_PC_Table'), false); iput('I_OfficeChair_01', 8.4, 8.1, Math.PI);
  
}
function buildResto() {
  shell(6, 4, pickExisting(['I_Floor_10', 'I_Floor_14', 'I_Floor_20']), pickExisting(['I_Wall_06', 'I_Wall_07', 'I_Wall_08', 'I_Wall_01']), 3);
  // kitchen line on the north wall (restaurant pack)
  const line = ['R_Furnit_A_1_A', 'R_Furnit_A_2_A', 'R_Owen_A', 'R_Furnit_A_4_A', 'R_Sink_A', 'R_Furnit_A_6_A', 'R_Furnit_A_5_A', 'R_Furnit_A_2_A'];
  let x = 0.6;
  for (const n of line) { if (!proto[n]) continue; const f = footprint(n, 0); iput(n, x + (f.maxx - f.minx) / 2, 0.5, 0); if (n !== 'R_Owen_A' && n !== 'R_Sink_A') iputOn(n, ['R_Pan_1_A', 'R_CookingPot_1_A', 'R_CuttingBoard_1_A', 'R_KnifeHolder', 'R_Bowl_1_A', 'R_Toster_1_A', 'R_CoffeeMachine_1_A', 'R_Microvawe_A'], x + (f.maxx - f.minx) / 2, 0.5, 0, 1, 0.2); if (n === 'R_Owen_A') iput('R_RangeHood_A', x + 0.5, 0.35, 0, 1.8, false); x += f.maxx - f.minx + 0.02; }
  iput('R_StationTable_3_A', 4.5, 2.6, 0); iputOn('R_StationTable_3_A', ['R_Dish_1_PlateReady', 'R_Dish_3_Ready', 'R_Cake_1_A', 'R_Bread_1', 'R_Plate_3_A'], 4.5, 2.6, 0, 4, 1);
  roomNPC(4.5, 1.6, 'Idle_A-loop', 0);
  // bar
  iput(pickExisting(['I_Bar_01', 'I_Bar_02']), 11.5, 2.4, 0); for (const dx of [-0.8, 0, 0.8]) iput(pickExisting(['I_BarChair_01', 'I_BarChair_02']), 11.5 + dx, 3.3, 0);
  // dining room
  const dishes = ['R_Dish_1_PlateReady', 'R_Dish_2_Ready', 'R_Dish_3_Ready', 'R_Dish_4_Ready', 'R_Dish_5_Ready', 'R_Dish_6_Ready', 'R_Coffy_A', 'R_ChessBurger_Ready', 'R_Cake_3_Ready'];
  for (const tx of [2.5, 6.5, 10.5]) for (const tz of [5.4, 8.2]) {
    if (tx === 6.5 && tz === 8.2) continue; // keep the entrance free
    iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_03']), tx, tz, 0);
    for (const [dx, dz, r] of [[-0.45, -0.85, 0], [0.45, -0.85, 0], [-0.45, 0.85, Math.PI], [0.45, 0.85, Math.PI]]) iput(pickExisting(['R_Chair_1_A', 'R_Chair_2_A', 'R_Chair_3_A']), tx + dx, tz + dz, r);
    iputOn('I_KitchenTable_01', dishes, tx, tz, 0, 2, 0.4);
    (curRoom.seats = curRoom.seats || []).push({ x: curRoom.ox + tx + 0.45, z: curRoom.oz + tz + 0.85, rot: 0 });
    if (chance(0.6)) { const c = roomNPC(tx - 0.45, tz - 0.85, 'Idle_B-loop', 0); if (c) sitters.push(c); }
  }
  curRoom.counter = new THREE.Vector3(curRoom.ox + 10.4, 0, curRoom.oz + 2.4); roomNPC(12.4, 2.4, 'Idle_A-loop', -Math.PI / 2);
  iput('R_Sofa_2_A', 14.4, 6.8, -Math.PI / 2); iput('R_Gramophone', 14.5, 9.4, -Math.PI / 2);
  for (const vx of [1, 5, 9, 13]) iput(pickExisting(['R_Vines_1_1', 'R_Vines_3_1']), vx, 0.15, 0, 2.0, false);
  iput(pickExisting(['I_Flower_04', 'I_Flower_05']), 0.5, 9.5); iput(pickExisting(['I_Flower_06', 'I_Flower_07']), 14.5, 4.5);
}
// products lined up in tidy rows (assets only)
const GROCERY = ['G_Can_1', 'G_Can_2', 'G_Can_3', 'G_Milk_1', 'G_Milk_2', 'G_Milk_3', 'G_Juice_Carton_1', 'G_Juice_Carton_4', 'G_Juice_Carton_5', 'G_Bottle_1', 'G_Bottle_2', 'G_Bottle_4', 'G_Fish_Can_1', 'G_Fish_Can_3', 'G_Honey_Container_1', 'G_Salt_Pot_1', 'G_Food_Box'];
const PRODUCE = ['G_Apple_1', 'G_Apple_2', 'G_Orange_1', 'G_Lemon_1', 'G_Tomato_1', 'G_Carrot_1', 'G_Pear_1', 'G_Peach_1', 'G_Potato_1', 'G_Eggplant_1', 'G_Corn_1', 'G_Cucumber_1', 'G_Pepper_1'];
const BAKERY = ['G_Bread_1_Tall', 'G_Bread_2_Tall', 'G_Bread_1_Small', 'G_Croissant_1', 'G_Donut_1', 'G_Cake_1', 'G_Cake_2', 'G_Chocolate_1', 'G_Pizza_1'];
const PHARMA = ['G_Pills_1', 'G_Pills_2', 'G_Pills_3', 'G_Fluid_Soap_1', 'G_Fluid_Soap_2', 'G_Fluid_Soap_3', 'G_Solid_Soap_1', 'G_Solid_Soap_2', 'G_Bottle_3', 'G_Bottle_5'];
function stock(items, x0, x1, z, y, rot = 0, rows = 2, sc = 1.6, depth = 0.18) {
  const pool = items.filter(n => proto[n]); if (!pool.length) return;
  for (let r = 0; r < rows; r++) {
    const it = pool[Math.floor(rnd() * pool.length)], b = proto[it].bb, w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * sc + 0.05;
    for (let x = x0 + w / 2; x + w / 2 <= x1; x += w) {
      const lz = (r - (rows - 1) / 2) * depth;
      const wx = rot ? z + lz : x, wz = rot ? x : z + lz;
      iput(it, wx, wz, rot, y, false, sc);
    }
  }
}
function wallShelves(x, z0, z1, side, items, levels = [0.75, 1.25, 1.75]) { // planks on a side wall, along z
  const rot = side < 0 ? Math.PI / 2 : -Math.PI / 2;
  for (let z = z0; z + 1.16 <= z1; z += 1.2) for (const y of levels) { iput('G_Shelf_1', x, z + 0.58, rot, y, false); stock(items, z + 0.05, z + 1.11, x, y + 0.1, Math.PI / 2, 1, 1.5); }
}
function buildEpicerie(food) {
  shell(5, 4, pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12']), pickExisting(['I_Wall_02', 'I_Wall_09', 'I_Wall_10']), 2);
  const R = curRoom; R.shelves = [];
  // refrigerated wall (north)
  const fr = ['G_Fridge_1', 'G_Fridge_2', 'G_Fridge_3'].filter(n => proto[n]);
  for (let k = 0; k < 9 && fr.length; k++) iput(fr[k % fr.length], 1.6 + k * 1.05, 0.55, 0);
  // two aisles of stand shelves, products in rows on top
  const st = proto.R_StandShelf_1_A ? 'R_StandShelf_1_A' : null, y = st ? topOf(st) : 0.9;
  for (const [z, items] of [[3.6, GROCERY], [6.0, BAKERY]]) {
    for (let k = 0; k < 6; k++) if (st) iput(st, 2.5 + k * 1.0, z, Math.PI / 2);
    stock(items, 2.0, 8.0, z, y, 0, 3, 1.6, 0.16);
    R.shelves.push(new THREE.Vector3(R.ox + 4, 0, R.oz + z + 0.9), new THREE.Vector3(R.ox + 7, 0, R.oz + z + 0.9));
  }
  // wall shelves (west) and fruit tables
  wallShelves(0.25, 2.0, 8.2, -1, GROCERY);
  for (const [x, z] of [[10.6, 3.4], [10.6, 5.2]]) { iput('G_Table_1', x, z); stock(PRODUCE, x - 0.6, x + 0.6, z, topOf('G_Table_1'), 0, 4, 1.8, 0.28); R.shelves.push(new THREE.Vector3(R.ox + x - 1.1, 0, R.oz + z)); }
  for (const [n, x, z] of [['K_Food_Crate_Large_Apples', 1.0, 8.9], ['K_Food_Basket_A_Berries', 2.1, 9.3], ['K_Food_Barrel_Fish', 3.1, 8.9]]) iput(n, x, z, 0);
  // checkout: kitchen counter + screen + laptop (no cash-register model in the packs)
  if (proto.G_Kitchen_Cabinet_1) { iput('G_Kitchen_Cabinet_1', 9.9, 7.6, 0); const t = topOf('G_Kitchen_Cabinet_1'); iput('G_Screen_1', 9.2, 7.5, Math.PI, t, false); iput('G_Laptop_1', 10.6, 7.5, Math.PI, t, false); }
  roomNPC(9.9, 7.0, 'Idle_A-loop', 0); curRoom.counter = new THREE.Vector3(curRoom.ox + 9.9, 0, curRoom.oz + 8.5); roomNPC(5, 4.9, 'LookingAround-loop', 0); if (chance(0.5)) roomNPC(7.5, 7.2, 'Idle_B-loop', Math.PI);
}
function buildJouets(toys) {
  shell(5, 4, pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12', 'I_Floor_10', 'I_Floor_14', 'I_Floor_20']), pickExisting(['I_Wall_03', 'I_Wall_11', 'I_Wall_12']), 2);
  const tables = toys.filter(n => /^T_(Table|Clothes_Table)_/.test(n)), carpets = toys.filter(n => /^T_Carpet_/.test(n));
  const small = toys.filter(n => /^T_(Car_Toy|Robot_Toy|Star_Toy|Pig_Toy|Cube_Toy|Bat_Toy|Mashroom|Dice|Color_Cube|Joystick|Cap|Helmet|Boxer|Basketball_Ball|Football|Volleyball|Rugby|Beach_Ball|Bowling_Pin|Water_Gun|Referee|Laptop|Speaker|Boombox)/.test(n));
  const gym = toys.filter(n => /^T_Gym_/.test(n)), games = toys.filter(n => /^T_(Game|Bowling)_/.test(n));
  if (carpets.length) { iput(carpets[0], 3.5, 4.5, 0, 0.01, false); iput(carpets[1 % carpets.length], 9.5, 5.5, 0, 0.01, false); }
  for (const tz of [3.0, 6.0]) for (const tx of [2.0, 4.8]) { const t = tables.length ? pick(tables) : 'R_StationTable_1_A'; iput(t, tx, tz, 0); iputOn(t, small, tx, tz, 0, 5, 0.6); }
  // games corner + gym corner
  games.slice(0, 4).forEach((g, i) => iput(g, 1.0 + i * 1.6, 0.8, 0));
  gym.forEach((g, i) => iput(g, 8.0 + (i % 4) * 1.2, 1.2 + Math.floor(i / 4) * 1.6, rr(-0.2, 0.2)));
  const net = toys.find(n => /^T_Basketball_Net/.test(n)); if (net) iput(net, 12.3, 7.5, -Math.PI / 2);
  for (let k = 0; k < 6; k++) { const b = pick(small.filter(n => /Ball|Pin/.test(n)).concat(small).slice(0, 12)); iput(b, rr(8, 12), rr(6, 9.5), rr(0, 6), 0, false); }
  iput('R_StationTable_1_A', 10.5, 9.0, 0); roomNPC(10.5, 8.1, 'Idle_A-loop', Math.PI);
  roomNPC(3.4, 4.5, 'LookingAround-loop', 0); if (chance(0.6)) roomNPC(9.0, 3.4, 'Runing_B-loop', 1.2);
}
function buildEntrepot() {
  shell(6, 4, pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12', 'I_Floor_10', 'I_Floor_14', 'I_Floor_20']), pickExisting(['I_Wall_13', 'I_Wall_14', 'I_Wall_02']), 3);
  const kk = Object.keys(proto).filter(n => n.startsWith('K_'));
  const big = kk.filter(n => /Containers|Pile|Stack|Barrel|Crate/.test(n)), smallk = kk.filter(n => !big.includes(n));
  for (let row = 0; row < 3; row++) for (let i = 0; i < 6; i++) {
    const x = 1.5 + i * 2.2, z = 1.2 + row * 2.6;
    if (x > 6 && x < 9 && row === 2) continue;
    iput('R_StandShelf_1_A', x, z, 0); iputOn('R_StandShelf_1_A', smallk, x, z, 0, 3, 0.4);
  }
  for (let k = 0; k < 14; k++) iput(pick(big), rr(0.8, 14.2), rr(8, 9.6), rr(0, 6.28));
  roomNPC(4, 8.8, 'LookingAround-loop', 0); roomNPC(11, 6.4, 'Idle_A-loop', Math.PI);
}

// ---- enter / exit
const interiors = [];
let inside = null; // { door, room }
async function buildInterior(door) {
  await loadInteriorPack();
  let extra = [];
  if (door.type === 'epicerie') extra = await loadFbxSet('food');
  if (door.type === 'jouets') extra = await loadFbxSet('toys');
  if (!interiors.length) { const g = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a9a7a, roughness: 1 })); g.position.set(6250, -0.2, 900); g.receiveShadow = true; scene.add(g); }
  const k = interiors.length;
  curRoom = { door, group: new THREE.Group(), cols: [], npcs: [], ox: 6000 + (k % 12) * 40, oz: 600 + Math.floor(k / 12) * 40 };
  scene.add(curRoom.group);
  const saved = seed; seed = 1000 + door.id * 7919;
  ({ service: () => buildService(door.service), appart: buildAppart, resto: buildRestoPlan, epicerie: () => buildEpicerie(extra), jouets: () => buildJouets(extra), entrepot: buildEntrepot, lobby: () => buildLobby(door) })[door.type]();
  seed = saved;
  for (const c of curRoom.cols) addCol(...c, 0);
  const room = curRoom; curRoom = null;
  onRoomBuilt(room, door);
  interiors.push(room); door.built = room;
  return room;
}
let entering = false;
async function enterDoor(door) {
  if (door.type === 'appart' && !door._viaLobby) door = lobbyFor(door);
  if (entering) return; entering = true;
  try {
    const room = door.built || await buildInterior(door);
    inside = { door, room };
    player.pos.copy(room.spawn); player.heading = Math.PI; cam.yaw = 0; cam.pitch = 0.75; cam.prevDist = cam.dist; cam.dist = 8;
    banner(door.type === 'lobby' ? (door.kind === 'hopital' ? '🏥 Hall de l’hôpital' : '🏢 Hall de l’immeuble') : door.service ? SERVICES[door.service].label : INT_TYPES[door.type].label, 1400);
  } finally { entering = false; }
}
function exitInterior() {
  const d = inside.door;
  player.pos.set(d.x + d.out[0] * 1.6, SW, d.z + d.out[1] * 1.6);
  player.heading = Math.atan2(d.out[0], d.out[1]); cam.yaw = Math.atan2(-d.out[0], -d.out[1]) + Math.PI; cam.pitch = 0.42; cam.dist = cam.prevDist || 9;
  inside = null;
}
function nearDoor() {
  if (player.inCar || player.onBus || inside) return null;
  let best = null, bd = 1.6;
  for (const d of doors) { const dd = Math.hypot(d.x - player.pos.x, d.z - player.pos.z); if (dd < bd) { bd = dd; best = d; } }
  return best;
}
function interiorAction() {
  if (inside) { if (inside.room.exit.distanceTo(player.pos) < 1.8) { exitInterior(); return true; } return false; }
  const d = nearDoor(); if (d) { enterDoor(d); return true; }
  return false;
}
function interiorPrompt() {
  if (inside) return inside.room.exit.distanceTo(player.pos) < 1.8 ? 'E : sortir' : (inside.door.type === 'lobby' ? '' : inside.door.service ? SERVICES[inside.door.service].label : INT_TYPES[inside.door.type].label);
  const d = nearDoor(); return d ? 'E : entrer · ' + INT_TYPES[d.type].label : '';
}
// cut-away: hide the walls between the camera and the room
function updateInterior(dt) {
  for (const r of interiors) for (const n of r.npcs) n.mixer.update(dt);
  if (!inside) return;
  const r = inside.room, cx = camera.position.x - r.ox, cz = camera.position.z - r.oz;
  r.walls.N.visible = cz > 0.5; r.walls.S.visible = cz < r.d - 0.5; r.walls.W.visible = cx > 0.5; r.walls.E.visible = cx < r.w - 0.5;
  r.exitMk.rotation.y += dt;
}
function drawDoorsOnMap(c, k) {
  for (const d of doors) {
    const dx = d.x - player.pos.x, dz = d.z - player.pos.z; if (dx * dx + dz * dz > 180 * 180) continue;
    c.fillStyle = '#' + INT_TYPES[d.type].color.toString(16).padStart(6, '0'); c.fillRect((d.x + HALF) * k - 1.5, (d.z + HALF) * k - 1.5, 3, 3);
  }
}

// ================================================================ BUS LINES
const BUS_LINES = [
  { name: 'Ligne 1', color: 0xe53935, loop: [[2, 2], [11, 2], [11, 11], [2, 11]] },
  { name: 'Ligne 2', color: 0x1e88e5, loop: [[4, 4], [4, 9], [9, 9], [9, 4]] },
  { name: 'Ligne 3', color: 0x2e9e4f, loop: [[1, 6], [13, 6], [13, 13], [1, 13]] },
];
const BUS_MODELS = ['RVCar_A', 'RVCar_B', 'RVCar_C', 'RVCar_D', 'RVCar_E', 'RVCar_F', 'RVCar_G', 'RVCar_H', 'RVCar_J', 'RVCar_K', 'RVCar_L'];
const busStops = [], buses = [];
const STOP_U = 0.55; // position of the stop along a 56 m segment
const STOP_NAMES = ['Mairie', 'Grand Parc', 'Gare', 'Marché', 'Stade', 'Hôpital', 'Bibliothèque', 'Usine', 'Musée', 'Lycée', 'Port', 'Théâtre', 'Cinéma', 'Piscine', 'Église', 'Banque', 'Poste', 'Zoo', 'Université', 'Centre', 'Fontaine', 'Basket', 'Pompiers', 'Commissariat', 'Hôtel', 'Pharmacie', 'Boulangerie', 'Square', 'Belvédère', 'Les Tours'];
function expandLoop(loop) {
  const nodes = [];
  for (let k = 0; k < loop.length; k++) {
    const [a, b] = [loop[k], loop[(k + 1) % loop.length]];
    const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[1] - a[1]);
    let [x, z] = a;
    while (x !== b[0] || z !== b[1]) { nodes.push([x, z]); x += dx; z += dz; }
  }
  return nodes;
}
function initBusLines() {
  let nameI = 0;
  BUS_LINES.forEach((L, li) => {
    L.nodes = expandLoop(L.loop);
    L.stops = {};
    L.nodes.forEach((a, k) => {
      if (k % 3 !== 1) return;
      const b = L.nodes[(k + 1) % L.nodes.length];
      const ax = lineX(a[0]), az = lineX(a[1]), dx = Math.sign(lineX(b[0]) - ax), dz = Math.sign(lineX(b[1]) - az);
      const rx = -dz, rz = dx; // right-hand side
      const along = P * STOP_U;
      const qx = ax + dx * along + rx * 6, qz = az + dz * along + rz * 6;
      const bi = Math.floor((qx + HALF) / P), bj = Math.floor((qz + HALF) / P);
      if (bi < 0 || bj < 0 || bi >= N || bj >= N) return;
      const cx = blockC(bi), cz = blockC(bj);
      let edge, t;
      if (Math.abs(qx - cx) > Math.abs(qz - cz)) { edge = qx > cx ? 'E' : 'W'; t = qz - cz; } else { edge = qz > cz ? 'S' : 'N'; t = qx - cx; }
      t = Math.max(-17, Math.min(17, t));
      const stop = {
        line: li, seg: k, segT: (along - STOP) / (P - 2 * STOP), block: bi + ',' + bj, edge, t,
        model: ['BusStop_A', 'BusStop_B', 'BusStop_C'][li % 3],
        pos: new THREE.Vector3(qx, SW, qz), name: STOP_NAMES[nameI++ % STOP_NAMES.length],
      };
      L.stops[k] = stop; busStops.push(stop);
    });
  });
}
function busExcl(bi, bj) {
  const ex = {};
  for (const st of busStops) if (st.block === bi + ',' + bj) (ex[st.edge] || (ex[st.edge] = [])).push([st.t - 3.4, st.t + 3.4]);
  return ex;
}
function spawnBuses() {
  BUS_LINES.forEach((L, li) => {
    const n = 3, len = L.nodes.length;
    for (let k = 0; k < n; k++) {
      const ri = Math.floor(k * len / n);
      const name = proto['Bus_1'] ? 'Bus_1' : (BUS_MODELS.filter(m => proto[m])[(li * 3 + k) % BUS_MODELS.filter(m => proto[m]).length] || 'RVCar_A');
      const obj = makeObject(name); scene.add(obj);
      const a = L.nodes[ri], b = L.nodes[(ri + 1) % len];
      const bus = { obj, a, b, seg: laneEnds(a, b), t: 0.05, mode: 'lane', speed: 8, v: 0, curve: null, route: L.nodes, ri, line: li, served: false, dwell: 0, atStop: null };
      cars.push(bus); buses.push(bus);
    }
  });
}
// called from updateCars for buses: returns a speed cap
function busTarget(c, target, dt) {
  if (c.dwell > 0) { c.dwell -= dt; if (c.dwell <= 0) { c.atStop = null; } return 0; }
  const st = BUS_LINES[c.line].stops[c.ri];
  if (c.mode === 'lane' && st && !c.served) {
    const rem = (st.segT - c.t) * c.seg.s.distanceTo(c.seg.e);
    if (rem < 14) target = Math.min(target, Math.max(0.4, rem * 1.1));
    if (rem < 0.35) { c.served = true; c.dwell = 7; c.atStop = st; c.v = 0; return 0; }
  }
  return target;
}
function nextStopOf(bus) {
  const L = BUS_LINES[bus.line], len = L.nodes.length;
  for (let k = 0; k < len; k++) {
    const idx = (bus.ri + k) % len, st = L.stops[idx];
    if (st && !(k === 0 && (bus.served || bus.t > st.segT))) return st;
  }
  return null;
}
function stopNearPlayer() {
  let best = null, bd = 5;
  for (const st of busStops) { const d = Math.hypot(st.pos.x - player.pos.x, st.pos.z - player.pos.z); if (d < bd) { bd = d; best = st; } }
  return best;
}
function busAtStop(st) { return buses.find(b => b.atStop === st); }
const BUS_FARE = 2;
function busAction() { // E key while on foot near a stop, or on a bus
  if (player.onBus) {
    const b = player.onBus;
    if (!b.atStop) { banner('Attends le prochain arrêt', 1400); return true; }
    player.pos.copy(b.atStop.pos); player.pos.y = SW; collide(player.pos, 0.5);
    player.onBus = null; player.ch.o.visible = true; banner('Arrêt ' + b.atStop.name, 1400);
    return true;
  }
  const st = stopNearPlayer(); if (!st) return false;
  const b = busAtStop(st); if (!b) return false;
  if (M.money < BUS_FARE) { banner('Pas assez d’argent (' + BUS_FARE + ' $)', 1600); return true; }
  M.money -= BUS_FARE; updateMissionHud();
  b.dwell = Math.max(b.dwell, 2.5);
  player.onBus = b; player.ch.o.visible = false; cam.yaw = b.obj.rotation.y;
  banner(BUS_LINES[b.line].name + ' · ' + BUS_FARE + ' $', 1500);
  return true;
}
function busPrompt() {
  if (player.onBus) {
    const b = player.onBus, nx = nextStopOf(b);
    return BUS_LINES[b.line].name + (b.atStop ? ' · Arrêt ' + b.atStop.name + ' · E : descendre' : ' · Prochain arrêt : ' + (nx ? nx.name : '…'));
  }
  if (player.inCar) return '';
  const st = stopNearPlayer(); if (!st) return '';
  const b = busAtStop(st);
  return b ? 'E : monter dans le bus ' + BUS_LINES[st.line].name + ' (' + BUS_FARE + ' $)' : 'Arrêt ' + st.name + ' · ' + BUS_LINES[st.line].name + ' · attends le bus';
}
function drawBusOnMap(c, k) {
  for (const L of BUS_LINES) {
    c.strokeStyle = '#' + L.color.toString(16).padStart(6, '0'); c.lineWidth = 2.5; c.globalAlpha = 0.85;
    c.beginPath();
    L.nodes.forEach(([i, j], n) => { const x = (lineX(i) + HALF) * k, z = (lineX(j) + HALF) * k; n ? c.lineTo(x, z) : c.moveTo(x, z); });
    c.closePath(); c.stroke(); c.globalAlpha = 1;
  }
  for (const st of busStops) { c.fillStyle = '#fff'; c.fillRect((st.pos.x + HALF) * k - 2, (st.pos.z + HALF) * k - 2, 4, 4); }
  for (const b of buses) { c.fillStyle = '#' + BUS_LINES[b.line].color.toString(16).padStart(6, '0'); c.fillRect((b.obj.position.x + HALF) * k - 3, (b.obj.position.z + HALF) * k - 3, 6, 6); }
}

// ================================================================ TRAFFIC LIGHTS
let simTime = 0;
const CYCLE = 24;
function lightState(inter, axis) {
  const t = (simTime + inter.off) % CYCLE;
  if (axis === 'x') return t < 10 ? 'g' : t < 12 ? 'y' : 'r';
  return t < 12 ? 'r' : t < 22 ? 'g' : 'y';
}
let sigMesh, sigT = 1;
const SIGOFF = { g: new THREE.Color(0x0b3315), y: new THREE.Color(0x3a2a05), r: new THREE.Color(0x3a0909) };
const SIGCOL = { g: new THREE.Color(0x29ff5a), y: new THREE.Color(0xffc21a), r: new THREE.Color(0xff2a2a) };
function initSignals() {
  sigMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.075, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), signals.length);
  signals.forEach((s, i) => { _m.makeTranslation(s.p.x, s.p.y, s.p.z); sigMesh.setMatrixAt(i, _m); sigMesh.setColorAt(i, SIGCOL.r); });
  sigMesh.computeBoundingSphere(); sigMesh.frustumCulled = false;
  scene.add(sigMesh);
}
function updateSignals(dt) {
  simTime += dt; sigT += dt;
  if (!sigMesh || sigT < 0.25) return; sigT = 0;
  signals.forEach((s, i) => sigMesh.setColorAt(i, lightState(s.inter, s.axis) === s.c ? SIGCOL[s.c] : SIGOFF[s.c]));
  sigMesh.instanceColor.needsUpdate = true;
}

// ================================================================ MISSIONS
const M = { money: 20, active: null, givers: [], done: 0 };
const markerGeo = new THREE.CylinderGeometry(1.6, 1.6, 40, 24, 1, true);
const ringGeo = new THREE.RingGeometry(1.2, 1.8, 32); ringGeo.rotateX(-Math.PI / 2);
function makeMarker(color, h = 40) {
  const g = new THREE.Group();
  const beam = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  beam.position.y = h / 2; beam.scale.y = h / 40;
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false }));
  ring.position.y = 0.06;
  g.add(beam, ring); scene.add(g); return g;
}
// random point on a sidewalk
function sidewalkPoint(minD = 0, maxD = 1e9, from = player.pos) {
  for (let k = 0; k < 400; k++) {
    const L = lots[Math.floor(rnd() * lots.length)];
    const s = rr(0, 4), [x, z] = perimPos(22, s);
    const p = new THREE.Vector3(L.cx + x, SW, L.cz + z);
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    if (d < minD || d > maxD) continue;
    const v = p.clone(); if (collide(v, 0.6)) continue;
    return p;
  }
  return new THREE.Vector3(lineX(MAIN) + 6, SW, lineX(MAIN) + 9);
}
const MTYPES = [
  { id: 'race', title: 'Contre la montre', color: 0x3aa0ff },
  { id: 'taxi', title: 'Taxi', color: 0xffc21a },
  { id: 'coins', title: 'Collecte', color: 0x3cff8a },
];
function initMissions() {
  const spots = [
    [lineX(MAIN) + 10, lineX(MAIN) + 6], [blockC(5) - 22, blockC(8) + 2], [blockC(7) + 22, blockC(5)],
    [blockC(3) + 2, blockC(10) - 22], [blockC(9) - 22, blockC(4) + 4], [blockC(10) + 3, blockC(10) + 22],
  ];
  spots.forEach(([x, z], i) => {
    const t = MTYPES[i % MTYPES.length];
    const p = new THREE.Vector3(x, SW, z); collide(p, 1.2); p.y = groundY(p.x, p.z);
    const mk = makeMarker(t.color, 26); mk.position.copy(p);
    M.givers.push({ p, t, mk });
  });
  updateMissionHud();
}
function banner(text, ms = 2600) {
  const b = document.getElementById('banner'); if (!b) return;
  b.textContent = text; b.style.display = 'block'; clearTimeout(banner.t);
  banner.t = setTimeout(() => { b.style.display = 'none'; }, ms);
}
function startMission(g) {
  const type = g.t.id;
  const a = { type, title: g.t.title, giver: g, t: 0 };
  g.mk.visible = false;
  if (type === 'race') {
    a.dest = sidewalkPoint(180, 380);
    a.limit = Math.round(Math.hypot(a.dest.x - player.pos.x, a.dest.z - player.pos.z) / 5.2 + 15);
    a.goal = 'Rejoins le point bleu'; a.reward = 150;
    a.mk = makeMarker(0x3aa0ff); a.mk.position.copy(a.dest);
  } else if (type === 'taxi') {
    a.pick = sidewalkPoint(40, 160);
    a.dest = sidewalkPoint(200, 420, a.pick);
    a.stage = 'pick'; a.limit = 150; a.reward = 300;
    a.goal = 'Prends une voiture (E) et va chercher le client';
    a.client = makeChar(pick(Object.keys(skinned)));
    a.client.o.position.copy(a.pick); play(a.client, 'Idle_B-loop');
    a.mk = makeMarker(0xffc21a); a.mk.position.copy(a.pick);
  } else if (type === 'coins') {
    a.coins = [];
    const coinGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.12, 20); coinGeo.rotateX(Math.PI / 2);
    const coinMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, metalness: 0.6, roughness: 0.3, emissive: 0x553300 });
    for (let k = 0; k < 10; k++) {
      const p = sidewalkPoint(20, 140);
      const c = new THREE.Mesh(coinGeo, coinMat); c.position.set(p.x, p.y + 1, p.z); c.castShadow = true; scene.add(c);
      a.coins.push(c);
    }
    a.limit = 120; a.reward = 200; a.goal = 'Ramasse les 10 pièces';
  }
  M.active = a;
  banner('Mission : ' + a.title); if (typeof phoneNotify === 'function') phoneNotify('🎯 Mission', a.title + ' — le GPS te guide');
  updateMissionHud();
}
function endMission(ok) {
  const a = M.active; if (!a) return;
  if (a.mk) scene.remove(a.mk);
  if (a.coins) a.coins.forEach(c => scene.remove(c));
  if (a.client) { scene.remove(a.client.o); const i = mixers.indexOf(a.client.mixer); if (i >= 0) mixers.splice(i, 1); }
  if (ok) { M.money += a.reward; M.done++; banner('Mission réussie ! +' + a.reward + ' $'); }
  else banner('Mission échouée');
  phoneNotify('🎯 Mission', ok ? 'Réussie : +' + a.reward + ' $' : 'Échouée');
  const g = a.giver; setTimeout(() => { g.mk.visible = true; }, 4000);
  M.active = null;
  updateMissionHud();
}
const near = (p, r) => Math.hypot(player.pos.x - p.x, player.pos.z - p.z) < r;
function updateMissions(dt) {
  for (const g of M.givers) {
    g.mk.rotation.y += dt;
    if (!M.active && g.mk.visible && near(g.p, 2.2)) startMission(g);
  }
  const a = M.active; if (!a) return;
  a.t += dt;
  if (a.mk) a.mk.rotation.y += dt;
  if (a.t > a.limit) return endMission(false);
  if (a.type === 'race') { if (near(a.dest, 3)) return endMission(true); }
  else if (a.type === 'taxi') {
    const car = player.inCar;
    if (a.stage === 'pick') {
      a.goal = car ? 'Arrête-toi près du client' : 'Prends une voiture (E) et va chercher le client';
      if (a.client) a.client.o.rotation.y = Math.atan2(player.pos.x - a.pick.x, player.pos.z - a.pick.z);
      if (car && near(a.pick, 7) && Math.abs(car.speed) < 3) {
        a.stage = 'drop'; a.client.o.visible = false; a.mk.position.copy(a.dest);
        a.goal = 'Dépose le client au point jaune'; a.t = 0; a.limit = Math.round(Math.hypot(a.dest.x - a.pick.x, a.dest.z - a.pick.z) / 9 + 25);
        banner('Client à bord !', 1500);
      }
    } else if (a.stage === 'drop') {
      if (!car) a.goal = 'Remonte en voiture !';
      else a.goal = 'Dépose le client au point jaune';
      if (car && near(a.dest, 7) && Math.abs(car.speed) < 3) {
        a.client.o.position.copy(a.dest); a.client.o.visible = true;
        return endMission(true);
      }
    }
  } else if (a.type === 'coins') {
    for (let i = a.coins.length - 1; i >= 0; i--) {
      const c = a.coins[i]; c.rotation.y += dt * 3;
      if (Math.hypot(player.pos.x - c.position.x, player.pos.z - c.position.z) < 1.6 && Math.abs(player.pos.y + 1 - c.position.y) < 2.5) {
        scene.remove(c); a.coins.splice(i, 1); M.money += 10;
      }
    }
    a.goal = 'Ramasse les pièces : ' + (10 - a.coins.length) + ' / 10';
    if (!a.coins.length) return endMission(true);
  }
  updateMissionHud();
}
function missionTarget() {
  const a = M.active; if (!a) return null;
  if (a.type === 'coins') { let best = null, bd = 1e9; for (const c of a.coins) { const d = c.position.distanceTo(player.pos); if (d < bd) { bd = d; best = c.position; } } return best; }
  if (a.type === 'taxi') return a.stage === 'pick' ? a.pick : a.dest;
  return a.dest;
}
function updateMissionHud() {
  const el = document.getElementById('mission'), money = document.getElementById('money');
  if (money) money.textContent = M.money + ' $';
  if (!el) return;
  const a = M.active;
  if (!a) { el.innerHTML = '<b>Missions</b><span>Marche dans une colonne de lumière pour commencer</span>'; return; }
  const tgt = missionTarget();
  const dist = tgt ? Math.round(Math.hypot(tgt.x - player.pos.x, tgt.z - player.pos.z)) + ' m' : '';
  const left = Math.max(0, Math.ceil(a.limit - a.t));
  el.innerHTML = '';
  const b = document.createElement('b'); b.textContent = a.title + ' · ' + left + ' s';
  const s1 = document.createElement('span'); s1.textContent = a.goal;
  const s2 = document.createElement('span'); s2.textContent = dist ? 'Objectif à ' + dist : '';
  el.append(b, s1, s2);
  if (left <= 10) b.style.color = '#ff5a3c';
}
function drawMissionsOnMap(c, k) {
  for (const g of M.givers) if (g.mk.visible) {
    c.fillStyle = '#' + g.t.color.toString(16).padStart(6, '0'); c.beginPath();
    c.arc((g.p.x + HALF) * k, (g.p.z + HALF) * k, 4, 0, 7); c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.stroke();
  }
  const a = M.active; if (!a) return;
  const pts = a.type === 'coins' ? a.coins.map(c => c.position) : [missionTarget()];
  for (const p of pts) { if (!p) continue; c.fillStyle = '#ffffff'; c.beginPath(); c.arc((p.x + HALF) * k, (p.z + HALF) * k, a.type === 'coins' ? 2.5 : 5, 0, 7); c.fill(); c.strokeStyle = '#ff3b3b'; c.lineWidth = 2; c.stroke(); }
}

// ---------------------------------------------------------------- loop / post
let composer, gtao, useAO = !Q.has('noao');
function setupPost() {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 2, scale: 1.2, samples: 16 });
  gtao.blendIntensity = 0.9;
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
}

// ---- mobile: on-screen buttons + visible joystick
function initTouchUI() {
  const isTouch = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window || Q.get('touch');
  if (!isTouch) return; document.body.classList.add('touch');
  for (const b of document.querySelectorAll('#touchUI .tb')) {
    if (b.dataset.zoom) { const z = +b.dataset.zoom; const f = (e) => { e.preventDefault(); e.stopPropagation(); cam.dist = Math.max(3.5, Math.min(40, cam.dist * z)); }; b.addEventListener('touchstart', f, { passive: false }); b.addEventListener('mousedown', f); continue; }
    const code = b.dataset.k, hold = !!b.dataset.hold;
    const down = (e) => { e.preventDefault(); e.stopPropagation(); b.classList.add('down'); if (hold) keys.add(code); dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); };
    const up = (e) => { e.preventDefault(); b.classList.remove('down'); if (hold) keys.delete(code); dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); };
    b.addEventListener('touchstart', down, { passive: false }); b.addEventListener('touchend', up, { passive: false }); b.addEventListener('touchcancel', up, { passive: false });
    b.addEventListener('mousedown', down); b.addEventListener('mouseup', up);
  }
  const joy = document.getElementById('joy'), knob = joy.firstChild;
  setInterval(() => {
    const on = touch.id !== null; joy.style.display = on ? 'block' : 'none';
    if (on) { joy.style.left = touch.sx + 'px'; joy.style.top = touch.sy + 'px'; let dx = touch.x - touch.sx, dy = touch.y - touch.sy; const d = Math.hypot(dx, dy); if (d > 45) { dx *= 45 / d; dy *= 45 / d; } knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; }
    document.getElementById('tR').style.display = document.getElementById('tX').style.display = L.placing ? 'block' : (inside && L.home === (inside.door && inside.door.id) ? 'block' : 'none');
    document.getElementById('tE').textContent = player.inCar ? '🚗' : 'E';
  }, 50);
}

// ---- GPS (phone): destination, distance, arrow, ETA, arrival time; follows the active mission/job automatically
function navTarget() {
  const nearestOf = (list) => { let b = null, bd = 1e9; for (const p of list) { const d = Math.hypot(p.x - player.pos.x, p.z - player.pos.z); if (d < bd) { bd = d; b = p; } } return b; };
  const a = M.active;
  if (a) { const p = missionTarget(); if (p) return { x: p.x, z: p.z, label: '🎯 ' + a.title + (a.goal ? ' — ' + a.goal : '') }; }
  const k = J.task;
  if (k) {
    if (k.mks && k.mks.length) { const c = nearestOf(k.mks.filter(m => m.parent).map(m => m.position)); if (c) return { x: c.x, z: c.z, label: '📦 ' + (k.goal || 'Livraison') }; }
    if (k.stage === 'load') { const s = nearestSpot('delivery'); if (s) return { x: s.pos.x, z: s.pos.z, label: '📦 Dépôt' }; }
    const p = k.mk && k.mk.parent ? k.mk.position : (k.stage === 'drop' || k.stage === 'go') && k.dest ? k.dest : k.pos;
    if (p) return { x: p.x, z: p.z, label: '💼 ' + (k.goal || JOBS[J.job]?.label || 'Métier') };
  }
  return null;
}
function gpsTarget() { if (L.gps) return { x: L.gps.x, z: L.gps.z, label: L.gpsLabel || 'Destination', manual: true }; return navTarget(); }
function gpsInfo() {
  const g = gpsTarget(); if (!g) return null;
  const dx = g.x - player.pos.x, dz = g.z - player.pos.z, d = Math.hypot(dx, dz);
  // direction relative to where the player is looking (car heading when driving)
  const yaw = player.inCar ? player.inCar.obj.rotation.y : cam.yaw;
  let rel = Math.atan2(dx, dz) - Math.atan2(-Math.sin(yaw), -Math.cos(yaw)); rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  const v = player.inCar ? Math.max(8, Math.abs(player.inCar.speed)) : (keys.has('ShiftLeft') ? 7 : 4);
  const sec = d * 1.3 / v; // 1.3 = detour factor along streets
  const gmin = sec * 0.4; // 1 real hour = 1440 game min
  const arr = (GT.min + gmin) % 1440;
  return { ...g, d, rel, sec, arr: String(Math.floor(arr / 60)).padStart(2, '0') + ':' + String(Math.floor(arr % 60)).padStart(2, '0') };
}
const fmtD = (d) => d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
const fmtT = (s) => s < 60 ? Math.round(s) + ' s' : Math.round(s / 60) + ' min';
function updateGpsStrip() {
  const el = document.getElementById('gpsStrip'); if (!el) return;
  const g = !inside && gpsInfo(); if (!g) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.querySelector('i').style.transform = 'rotate(' + (-g.rel) + 'rad)';
  el.querySelector('b').textContent = g.label;
  el.querySelector('span').textContent = fmtD(g.d) + ' · ' + fmtT(g.sec) + ' · arrivée ' + g.arr;
}

// ---- two-wheelers (C_Femintine / C_Mascuilo scooters): visible riders with a seated pose built from the character rig
const TWO_WHEEL = /^C_(Femintine|Mascuilo)$/;
const isTwo = (obj) => obj && TWO_WHEEL.test(obj.userData.name || '');
const SEAT = { y: 0.22, z: 0.32 }; // seat point in scooter space (forward is -Z); tuned on the model
const riders = [];
function legBones(o) { const b = {}; o.traverse(n => { if (!n.isBone) return; const k = n.name.replace(/[^A-Za-z]/g, ''); if (/^UpperLeg[LR]$/.test(k)) b[k] = n; if (/^Leg[LR]$/.test(k)) b[k] = n; if (/^Hips$/.test(k)) b.Hips = n; if (/^Arm[LR]$/.test(k)) b[k] = n; if (/^ForeArm[LR]$/.test(k)) b[k] = n; }); return b; }
function seatPose(ch) {
  if (!ch.bones) ch.bones = legBones(ch.o);
  const b = ch.bones, P = SEATPOSE;
  for (const s of ['L', 'R']) {
    if (b['UpperLeg' + s]) b['UpperLeg' + s].rotation.x = P.thigh;
    if (b['Leg' + s]) b['Leg' + s].rotation.x = P.knee;
    if (b['Arm' + s]) b['Arm' + s].rotation.x = P.arm;
  }
}
const SEATPOSE = { thigh: -1.5, knee: 1.5, arm: -0.9 };
function placeRider(ch, obj) {
  const h = obj.rotation.y, c = Math.cos(h), s = Math.sin(h);
  ch.o.position.set(obj.position.x + s * SEAT.z, obj.position.y + SEAT.y, obj.position.z + c * SEAT.z);
  ch.o.rotation.y = h + Math.PI;
}
function addRider(car) {
  const models = Object.keys(skinned); if (!models.length) return;
  const ch = makeChar(pick(models)); play(ch, 'Idle_A-loop'); car.rider = ch; riders.push({ ch, car });
}
function updateRiders() {
  for (const r of riders) { if (!r.car.obj.parent) { r.ch.o.visible = false; continue; } r.ch.o.visible = true; placeRider(r.ch, r.car.obj); seatPose(r.ch); }
  if (L.sitting && !player.inCar) seatPose(player.ch);
  for (const s of sitters) seatPose(s);
  if (player.inCar && isTwo(player.inCar.obj)) { player.ch.o.visible = true; placeRider(player.ch, player.inCar.obj); seatPose(player.ch); }
}
// ================================================================ PUBLIC BUILDINGS: counters, tables, contracts
// state kept in L: interim, offers, itask, util, utilDay, loan, loanDay, ins, insDay, gymUntil
const counterRings = [];
function addCounterRing(room) {
  if (!room.counter) return;
  const r = stopRing(0xffd54f); r.scale.setScalar(0.45); r.position.set(room.counter.x, 0.03, room.counter.z); room.group.add(r); counterRings.push(r);
}
const weekly = (key) => { const d = L[key + 'Day'] ?? GT.day; if (GT.day - d >= 7) { L[key + 'Day'] = GT.day; return true; } if (L[key + 'Day'] == null) L[key + 'Day'] = GT.day; return false; };
function updateContracts(dt) {
  if (L.util && L.home !== null && weekly('util')) { if (payMoney(UTIL_PRICE)) phoneNotify('🏛️ Mairie', 'Électricité, gaz et eau : −' + UTIL_PRICE + ' $ (semaine)'); else { L.util = false; phoneNotify('🏛️ Mairie', 'Abonnement énergie/eau suspendu (impayé)'); } }
  if (L.ins && weekly('ins')) { const p = INSURANCE[L.ins].p; if (payMoney(p)) phoneNotify('🛡️ Assurance', INSURANCE[L.ins].n + ' : −' + p + ' $ (semaine)'); else { L.ins = null; phoneNotify('🛡️ Assurance', 'Contrat résilié (impayé)'); } }
  if (L.loan > 0 && weekly('loan')) { const p = Math.min(L.loan, Math.ceil(L.loanBase / 10)); if (payMoney(p)) { L.loan -= p; phoneNotify('🏦 Banque', 'Remboursement prêt : −' + p + ' $ · reste ' + L.loan + ' $'); } }
  if (L.gymUntil && gameNow() > L.gymUntil) { L.gymUntil = 0; phoneNotify('🏀 Sport', 'Abonnement terminé'); }
  // temp agency: a new offer every ~90 s while registered
  if (L.interim) { L.offerT = (L.offerT ?? 20) - dt; if (L.offerT <= 0) { L.offerT = 90; newOffer(); } }
}
const UTIL_PRICE = 35;
const INSURANCE = { basique: { n: 'Formule Tiers', p: 10, c: 0.3 }, confort: { n: 'Formule Confort', p: 20, c: 0.6 }, premium: { n: 'Tous risques', p: 35, c: 0.9 } };
function repairPrice(base) { const c = L.ins ? INSURANCE[L.ins].c : 0; return Math.max(1, Math.round(base * (1 - c))); }
function hpMax() { return L.gymUntil && gameNow() < L.gymUntil ? 120 : 100; }

// ---- temp agency offers
const OFFERS = [['bureaux', '💼 Saisie de dossiers', 15, 55], ['banque', '🏦 Classement d’archives', 12, 45], ['supermarche', '🛒 Mise en rayon', 15, 50], ['mairie', '🏛️ Accueil du public', 12, 45], ['meubles', '🪑 Montage de meubles', 18, 65], ['pharmacie', '💊 Inventaire', 12, 40]];
function newOffer() {
  L.offers = (L.offers || []).filter(o => !o.done).slice(-3);
  const [svc, label, sec, payN] = pick(OFFERS);
  const d = doors.filter(x => x.service === svc).sort((a, b) => Math.hypot(a.x - player.pos.x, a.z - player.pos.z) - Math.hypot(b.x - player.pos.x, b.z - player.pos.z))[0]; if (!d) return;
  const o = { id: Date.now() % 100000, svc, label, sec, pay: payN, door: d.id };
  L.offers.push(o); phoneNotify('👔 Intérim', label + ' — ' + payN + ' $ (appli Missions)');
}
function acceptOffer(o) { L.itask = o; const d = doors[o.door]; L.gps = new THREE.Vector3(d.x, 0, d.z); L.gpsLabel = o.label; phoneNotify('👔 Intérim', 'Mission acceptée : va au guichet, le GPS te guide'); }
function offerRows() {
  const r = [];
  if (L.itask) r.push({ sep: 'En cours : ' + L.itask.label + ' (' + L.itask.pay + ' $) — présente-toi au guichet' });
  for (const o of (L.offers || []).filter(o => o !== L.itask && !o.done)) r.push({ t: o.label + ' — ' + o.pay + ' $ · ' + o.sec + ' s', fn: () => acceptOffer(o) });
  if (!r.length) r.push({ sep: 'Pas d’offre pour l’instant (une nouvelle toutes les ~90 s)' });
  return r;
}

// ---- dealership catalogue: image rendered from the model + specs
const DEALER = [
  ['C_Thunderball', 'Thunderball', 700, 'Berline sportive, la plus rapide du catalogue.', 180, 8.5, 4, 380],
  ['C_Neptune', 'Neptune', 550, 'Familiale confortable et polyvalente.', 130, 6.4, 5, 480],
  ['C_Galacci', 'Galacci', 520, 'Compacte élégante pour la ville.', 120, 6.0, 4, 300],
  ['C_Rammer', 'Rammer', 480, 'Robuste et facile à garer.', 110, 7.2, 5, 420],
  ['C_Mascuilo', 'Mascuilo (scooter)', 250, 'Scooter économique, se faufile partout.', 15, 2.4, 2, 30],
  ['C_Femintine', 'Femintine (scooter)', 250, 'Scooter urbain au look rétro.', 15, 2.4, 2, 30],
  ['C_car3', 'Classique V3', 380, 'Petite citadine increvable.', 90, 5.5, 4, 260],
  ['SportCar_1', 'Voiture de sport', 600, 'Deux portes, beaucoup de chevaux.', 210, 9.8, 2, 180],
  ['SportCar_7', 'Sportive rouge', 650, 'Coupé sport au freinage précis.', 230, 10.2, 2, 160],
  ['PickUp_2', 'Pick-up', 450, 'Benne pour transporter du matériel.', 150, 9.5, 3, 900],
];
const thumbs = {};
let thumbR = null;
function carThumb(name) {
  if (thumbs[name]) return thumbs[name];
  try {
    if (!thumbR) { thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); thumbR.setSize(220, 140); thumbR.outputColorSpace = THREE.SRGBColorSpace; }
    const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.2)); const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(3, 5, 4); sc.add(dl);
    const o = makeObject(name); sc.add(o); const bb = new THREE.Box3().setFromObject(o), c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3()).length();
    const cm = new THREE.PerspectiveCamera(30, 220 / 140, 0.1, 100); cm.position.set(c.x - s * 1.1, c.y + s * 0.55, c.z - s * 1.2); cm.lookAt(c);
    thumbR.render(sc, cm); thumbs[name] = thumbR.domElement.toDataURL();
  } catch (e) { thumbs[name] = ''; }
  return thumbs[name];
}
function dealerUI(d) {
  UI.open = true; keys.clear(); if (document.pointerLockElement) document.exitPointerLock();
  const m = document.getElementById('menu'); m.style.display = 'flex'; m.innerHTML = ''; m._refresh = null;
  const h = document.createElement('div'); h.className = 'mh'; h.innerHTML = '<b>🚗 Concession — véhicules disponibles</b><span>💵 ' + M.money + ' $ · 🏦 ' + L.bank + ' $</span>'; m.append(h);
  if (!L.permis) { const p = document.createElement('p'); p.textContent = 'Il te faut le permis de conduire (mairie) pour acheter.'; m.append(p); }
  const grid = document.createElement('div'); grid.className = 'dgrid'; m.append(grid);
  for (const v of DEALER.filter(v => proto[v[0]])) {
    const [model, n, price, desc, ch, conso, seats, trunk] = v;
    const c = document.createElement('div'); c.className = 'dcar';
    c.innerHTML = '<img src="' + carThumb(model) + '"><b></b><p></p><ul><li>⚡ Puissance : ' + ch + ' ch</li><li>⛽ Consommation : ' + conso + ' L/100 km</li><li>💺 Places : ' + seats + '</li><li>🧳 Coffre : ' + trunk + ' L</li></ul>';
    c.querySelector('b').textContent = n + ' — ' + price + ' $'; c.querySelector('p').textContent = desc;
    const btn = document.createElement('button'); btn.textContent = 'Choisir'; btn.disabled = !L.permis;
    btn.onclick = () => { btn.textContent = 'Confirmer l’achat (' + price + ' $)'; btn.onclick = () => { if (!payMoney(price)) return; buyDealerCar(d, v); closeMenu(); }; };
    c.append(btn); grid.append(c);
  }
  const cl = document.createElement('button'); cl.className = 'mc'; cl.textContent = 'Fermer (Échap)'; cl.onclick = closeMenu; m.append(cl);
}
function buyDealerCar(d, v) {
  const [model, n, , , ch] = v; const o = makeObject(model);
  o.position.set(d.x + d.out[0] * 3 + d.out[1] * 5, SW + 0.24, d.z + d.out[1] * 3 + d.out[0] * 5); o.rotation.y = Math.atan2(d.out[1], -d.out[0]); scene.add(o);
  const car = { obj: o, speed: 0, owned: true, fuel: 100, hp: 100, name: n, power: ch }; parkedPlayerCars.push(car); L.owned.push(car);
  banner('🚗 ' + n + ' achetée, garée devant la concession', 2000); phoneNotify('🚗 Concession', n + ' achetée');
}

// ---- restaurant: tables (sit + order) and counter (takeaway + food delivery job)
const RESTO_DISHES = ['plat', 'pates_bolo', 'sandwich', 'salade_comp', 'soupe', 'omelette', 'dessert', 'smoothie', 'biere', 'cafe'];
function tableUI(seat) {
  L.sitting = seat; player.pos.set(seat.x, 0, seat.z); player.heading = seat.rot;
  const q = {};
  const draw = () => {
    UI.open = true; keys.clear();
    const m = document.getElementById('menu'); m.style.display = 'flex'; m.innerHTML = ''; m._refresh = null;
    const h = document.createElement('div'); h.className = 'mh'; h.innerHTML = '<b>🍽️ Menu du restaurant</b><span>💵 ' + M.money + ' $</span>'; m.append(h);
    const list = document.createElement('div'); list.className = 'ml'; m.append(list);
    let tot = 0;
    for (const id of RESTO_DISHES) { const it = ITEMS[id]; if (!it) continue; const n = q[id] || 0; tot += n * it.p;
      const row = document.createElement('div'); row.className = 'qrow';
      const lab = document.createElement('span'); lab.textContent = it.n + ' — ' + it.p + ' $'; row.append(lab);
      const minus = document.createElement('button'); minus.textContent = '−'; minus.disabled = !n; minus.onclick = () => { q[id] = n - 1; draw(); };
      const qty = document.createElement('b'); qty.textContent = n;
      const plus = document.createElement('button'); plus.textContent = '+'; plus.onclick = () => { q[id] = n + 1; draw(); };
      row.append(minus, qty, plus); list.append(row); }
    const go = document.createElement('button'); go.className = 'mc'; go.textContent = tot ? '🍴 Commander et manger — ' + tot + ' $' : 'Choisis des plats';
    go.disabled = !tot; go.onclick = () => { if (!payMoney(tot)) return; for (const [id, n] of Object.entries(q)) for (let k = 0; k < n; k++) consume(id); banner('😋 Bon appétit ! (−' + tot + ' $)', 1600); closeMenu(); };
    const cl = document.createElement('button'); cl.className = 'mc'; cl.textContent = 'Se lever'; cl.onclick = () => { closeMenu(); L.sitting = null; };
    m.append(go, cl);
  };
  draw();
}
function consume(id) {
  const it = ITEMS[id], n = L.needs; if (!it) return;
  if (it.eat) n.faim = Math.min(100, n.faim + it.eat); if (it.drink) n.soif = Math.min(100, n.soif + it.drink); if (it.sleep) n.sommeil = Math.min(100, n.sommeil + it.sleep);
}
function restoCounterMenu() {
  openMenu('🍕 Comptoir du restaurant', [
    { sep: 'À emporter (dans ton inventaire)' },
    ...['plat', 'pates_bolo', 'sandwich', 'dessert', 'smoothie'].filter(id => ITEMS[id]).map(id => ({ t: ITEMS[id].n + ' — ' + ITEMS[id].p + ' $', fn: () => { if (payMoney(ITEMS[id].p)) { give(id); banner('À emporter : ' + ITEMS[id].n, 900); } } })),
    { sep: 'Travail' },
    { t: J.task && J.task.food ? '🛵 Tournée en cours…' : '🛵 Devenir livreur : livrer 3 repas à domicile', dis: !!(J.task && J.task.food), fn: () => { closeMenu(); startFoodRun(); }, keep: false },
  ]);
}
function startFoodRun() {
  if (J.task) clearTask();
  J.job = 'livreur';
  const list = doors.filter(d => d.type === 'appart' && !d.unit).sort(() => rnd() - 0.5).slice(0, 3);
  const mks = list.map(d => { const m = makeMarker(0xff7043, 20); m.position.set(d.x, SW, d.z); return m; });
  J.task = { type: 'deliver', food: true, stage: 'go', list, mks, t: 0, limit: 600, goal: 'Livre les repas : ' + list.length + ' clients' };
  updateJobHud(); banner('🛵 3 repas à livrer : suis le GPS', 2000);
}

// ---- gym / sport: basketball hoops of the city pack (no gym machines in the packs)
const hoops = [];
function hoopNear() { if (player.inCar || inside) return null; return hoops.find(h => Math.hypot(h.x - player.pos.x, h.z - player.pos.z) < 3) || null; }
function gymMenu() {
  const active = L.gymUntil && gameNow() < L.gymUntil;
  openMenu('🏀 Terrain de sport', [
    { sep: active ? 'Abonnement actif : santé max 120 %' : 'Pas d’abonnement' },
    { t: '🏋️ S’entraîner 10 s', fn: () => { closeMenu(); work(10, 0, 'Entraînement'); setTimeout(() => { L.needs.sante = Math.min(hpMax(), L.needs.sante + 25); L.needs.sommeil = Math.max(0, L.needs.sommeil - 10); L.needs.hygiene = Math.max(0, L.needs.hygiene - 20); banner('💪 Entraînement terminé', 1400); }, 10500); }, keep: false },
    { t: '🎟️ Abonnement hebdomadaire — 15 $', dis: active, fn: () => { if (payMoney(15)) { L.gymUntil = gameNow() + 7 * 1440; L.needs.sante = Math.min(120, L.needs.sante + 20); phoneNotify('🏀 Sport', 'Abonnement actif 7 jours : santé max +20 %'); } } },
  ]);
}

// ---- counters: one entry point per building type
function counterMenu(door) {
  const k = door.service || door.type;
  if (k === 'concession') return dealerUI(door);
  if (k === 'resto') return restoCounterMenu();
  if (k === 'emploi') return openMenu('👔 Agence d’intérim', [
    { t: L.interim ? '✔ Inscrit à l’agence' : '📝 S’inscrire (gratuit)', dis: L.interim, fn: () => { L.interim = true; L.offerT = 3; phoneNotify('👔 Intérim', 'Inscription validée : les offres arrivent sur ton téléphone'); } },
    ...(L.interim ? offerRows() : []),
    { sep: 'Métiers de la ville' },
    ...Object.entries(JOBS).map(([j, def]) => { const s = jobSpots.find(s => s.def.job === j); return { t: def.icon + ' ' + def.label + ' — GPS', fn: () => { if (s) { L.gps = s.pos.clone(); L.gpsLabel = def.label; } }, keep: false }; }),
  ], 'Inscris-toi pour recevoir des missions sur ton téléphone (appli Missions).');
  if (k === 'mairie') return openMenu('🏛️ Mairie — accueil', [
    { sep: 'Électricité + gaz + eau : ' + UTIL_PRICE + ' $ / semaine, prélevé automatiquement' },
    { t: L.util ? '✔ Abonné — résilier' : '⚡ Souscrire le pack énergie/eau', dis: !L.util && L.home === null, fn: () => { L.util = !L.util; L.utilDay = GT.day; if (L.util && !payMoney(UTIL_PRICE)) L.util = false; phoneNotify('🏛️ Mairie', L.util ? 'Pack énergie/eau actif' : 'Pack résilié'); } },
    { t: L.permis ? '🪪 Permis de conduire ✔' : '🪪 Permis de conduire — 100 $', dis: L.permis, fn: () => { if (payMoney(100)) { L.permis = true; banner('Permis obtenu', 1200); } } },
    { t: '🤝 Aide sociale (+50 $ si moins de 20 $)', dis: M.money + L.bank >= 20 || performance.now() - (L.aide || -1e9) < 300000, fn: () => { M.money += 50; L.aide = performance.now(); updateMissionHud(); } },
  ], L.home === null ? 'Il faut un logement pour souscrire le pack énergie/eau.' : 'Sans le pack, pas d’eau ni de cuisine chez toi.');
  if (k === 'banque') {
    const r = [{ sep: '🏦 Solde : ' + L.bank + ' $ · 💵 Liquide : ' + M.money + ' $' + (L.loan ? ' · Prêt restant : ' + L.loan + ' $' : '') }];
    for (const v of [20, 100, 500]) r.push({ t: 'Déposer ' + v + ' $', dis: M.money < v, fn: () => { M.money -= v; L.bank += v; updateMissionHud(); } });
    for (const v of [20, 100, 500]) r.push({ t: 'Retirer ' + v + ' $', dis: L.bank < v, fn: () => { L.bank -= v; M.money += v; updateMissionHud(); } });
    for (const v of [500, 2000]) r.push({ t: '💳 Demander un prêt de ' + v + ' $ (rembourse ' + Math.round(v * 1.1) + ' $ en 10 semaines)', dis: L.loan > 0, fn: () => { L.bank += v; L.loan = L.loanBase = Math.round(v * 1.1); L.loanDay = GT.day; phoneNotify('🏦 Banque', 'Prêt accordé : +' + v + ' $'); } });
    if (L.loan) r.push({ t: 'Rembourser le prêt maintenant (' + L.loan + ' $)', fn: () => { if (payMoney(L.loan)) { L.loan = 0; phoneNotify('🏦 Banque', 'Prêt soldé'); } } });
    return openMenu('🏦 Banque — guichet', r);
  }
  if (k === 'assurance') return openMenu('🛡️ Assurance auto', [
    { sep: L.ins ? 'Contrat : ' + INSURANCE[L.ins].n + ' (rembourse ' + INSURANCE[L.ins].c * 100 + ' % des réparations)' : 'Aucun contrat' },
    ...Object.entries(INSURANCE).map(([id, f]) => ({ t: f.n + ' — ' + f.p + ' $ / semaine · rembourse ' + f.c * 100 + ' %', dis: L.ins === id, fn: () => { if (payMoney(f.p)) { L.ins = id; L.insDay = GT.day; phoneNotify('🛡️ Assurance', f.n + ' souscrite'); } } })),
    { t: 'Résilier', dis: !L.ins, fn: () => { L.ins = null; } },
  ], 'Les réparations au garage et via l’appli Réparateur sont remboursées selon la formule.');
  if (k === 'police') return openMenu('🚓 Commissariat — accueil', [
    { sep: 'Amendes impayées : ' + L.fines + ' $' + (L.fines >= FINE_LIMIT ? ' — au-delà de ' + FINE_LIMIT + ' $, retenue automatique sur tes salaires' : '') },
    { t: 'Payer mes amendes', dis: !L.fines, fn: () => { if (payMoney(L.fines)) { L.fines = 0; banner('Amendes payées', 1200); } } },
  ]);
  if (!door.service) { if (k === 'epicerie') return serviceMenu({ ...door, service: 'supermarche' }); return openMenu('🧸 Caisse', [{ sep: 'Les articles se prennent directement sur les étagères (E) et sont payés à ce moment-là.' }]); }
  return serviceMenu(door);
}
const FINE_LIMIT = 150;
// salary garnishment: called from pay()
function garnish(n) {
  if (L.fines < FINE_LIMIT || n <= 0) return n;
  const cut = Math.min(L.fines, Math.ceil(n / 2)); L.fines -= cut; phoneNotify('🚓 Police', 'Retenue sur salaire : ' + cut + ' $ (amendes)'); return n - cut;
}

// ---- café / restaurant terraces (city pack Table_1_A, Chair_1_A, Parasol_1_A) with seated customers
const sitters = [];
function buildTerrace(d) {
  if (!proto.Table_1_A || !proto.Chair_1_A) return;
  const ox = d.out[0], oz = d.out[1], tx = -oz, tz = ox; // out = toward street, t = along facade
  const fx = d.x - ox * 0.7, fz = d.z - oz * 0.7; // facade point
  const models = Object.keys(skinned);
  for (const lat of [-3.2, 3.2, -6.0]) {
    const x = fx + ox * 1.9 + tx * lat, z = fz + oz * 1.9 + tz * lat;
    if (propCols.some(c => Math.hypot((c[0] + c[2]) / 2 - x, (c[1] + c[3]) / 2 - z) < 1.9) || parkedSpots.some(p => { const rx = p.x - x, rz = p.z - z; return Math.abs(rx * tx + rz * tz) < 4 && Math.abs(rx * ox + rz * oz) < 4.5; }) || busStops.some(b => Math.hypot(b.x - x, b.z - z) < 4) || doors.some(o => o !== d && Math.hypot(o.x - x, o.z - z) < 2.5)) continue;
    put('Table_1_A', x, SW, z, 0); propCols.push([x - 0.6, z - 0.6, x + 0.6, z + 0.6]); addCol(x - 0.6, z - 0.6, x + 0.6, z + 0.6, 0);
    if (proto.Parasol_1_A) put('Parasol_1_A', x, SW + 0.86, z, 0, 1.2);
    for (const side of [-1, 1]) {
      const cx = x + tx * side * 0.95, cz = z + tz * side * 0.95, face = Math.atan2(x - cx, z - cz);
      put('Chair_1_A', cx, SW, cz, face);
      if (models.length && chance(0.85)) { const ch = makeChar(pick(models)); play(ch, chance(0.5) ? 'Idle_A-loop' : 'Idle_B-loop'); ch.o.position.set(cx, SW + TERR.y, cz); ch.o.rotation.y = face; sitters.push(ch); }
    }
  }
}
const TERR = { y: 0.0 };

// ---- rolling wheels: angle follows the distance driven
function spinWheels(obj, v, dt) { const w = obj && obj.userData.wheels; if (!w) return; for (const x of w) x.pv.rotation.x -= v * dt / x.r; }
function updateWheels(dt) {
  for (const c of cars) spinWheels(c.obj, c.v || 0, dt);
  if (typeof buses !== 'undefined') for (const b of buses) spinWheels(b.obj, b.v || b.speed || 0, dt);
  if (player.inCar) spinWheels(player.inCar.obj, player.inCar.speed || 0, dt);
  if (typeof stationVisitors !== 'undefined') for (const s of stationVisitors) if (s.obj) spinWheels(s.obj, s.v || 0, dt);
}

// ---- NPC activities: indoor actors walk between activity points (sit / use / look), outdoor errands, benches, night
const actors = [];
function roomActor(points, room = curRoom) {
  const names = Object.keys(skinned); if (!names.length || points.length < 2) return;
  const ch = makeChar(pick(names)); const a = { ch, room, points, i: Math.floor(rnd() * points.length), state: 'do', t: rr(2, 8) };
  const p = points[a.i]; ch.o.position.set(room.ox + p.x, 0, room.oz + p.z); ch.o.rotation.y = p.face; play(ch, p.clip || 'Idle_A-loop');
  room.group.add(ch.o); room.npcs.push(ch); actors.push(a);
}
function updateActors(dt) {
  for (const a of actors) {
    if (!inside || inside.room !== a.room) continue;
    const o = a.ch.o; o.visible = !(inside.door.unit && !inside.door.npc);
    if (a.state === 'do') { a.t -= dt; if (a.points[a.i].sit) seatPose(a.ch); if (a.t <= 0) { a.i = (a.i + 1 + Math.floor(rnd() * (a.points.length - 1))) % a.points.length; a.state = 'go'; play(a.ch, 'Walk_A-loop'); } continue; }
    const p = a.points[a.i], tx = a.room.ox + p.x, tz = a.room.oz + p.z, dx = tx - o.position.x, dz = tz - o.position.z, d = Math.hypot(dx, dz);
    if (d < 0.08) { a.state = 'do'; a.t = rr(6, 14); o.rotation.y = p.face; play(a.ch, p.clip || 'Idle_A-loop'); continue; }
    const s = Math.min(d, 1.3 * dt); o.position.x += dx / d * s; o.position.z += dz / d * s; o.rotation.y = Math.atan2(dx, dz);
  }
}
const APPART_POINTS = [
  { x: 2.6, z: 5.75, face: 0, sit: true }, { x: 8.5, z: 1.25, face: Math.PI, clip: 'Idle_B-loop' }, { x: 9.65, z: 2.2, face: 0, sit: true },
  { x: 8.4, z: 8.15, face: Math.PI, sit: true }, { x: 2.0, z: 3.0, face: Math.PI, clip: 'LookingAround-loop' }, { x: 11.0, z: 8.3, face: Math.PI / 2 }, { x: 0.9, z: 7.6, face: -Math.PI / 2, clip: 'Idle_B-loop' },
];
function hallPoints(n, room) { const hb = room && room.hallBox || [4.2, 10.8, 7.4, 8.8]; const r = []; for (let k = 0; k < n; k++) r.push({ x: rr(hb[0], hb[1]), z: rr(hb[2], hb[3]), face: rr(-3, 3), clip: pick(['Idle_A-loop', 'LookingAround-loop', 'Idle_B-loop']) }); return r; }
// outdoor: errands into shops, benches, fewer people at night
const benchSpots = [];
function updatePedLife(dt) {
  const night = GT.min < 6 * 60 || GT.min > 22 * 60;
  for (const p of peds) {
    p.lt = (p.lt ?? rr(0, 20)) - dt;
    if (p.away) { if (p.lt <= 0 && !(night && p.nightHome)) { p.away = false; p.o.visible = true; p.walking = true; play(p, pick(['Walk_A-loop', 'Walk_B-loop'])); } continue; }
    if (p.benched) { seatPose(p); if (p.lt <= 0) { p.benched = false; p.walking = true; play(p, 'Walk_A-loop'); } continue; }
    if (night && p.nightHome === undefined) p.nightHome = chance(0.6);
    if (!night) p.nightHome = undefined;
    if (p.lt > 0) continue;
    p.lt = rr(8, 25);
    const x = p.o.position.x, z = p.o.position.z;
    if (night && p.nightHome) { p.away = true; p.o.visible = false; p.lt = 30; continue; }
    const d = doors.find(d => (d.service || d.type === 'resto') && Math.hypot(d.x - x, d.z - z) < 6);
    if (d && chance(0.5)) { p.away = true; p.o.visible = false; p.lt = rr(15, 45); continue; } // goes into the shop
    const b = benchSpots.find(b => !b.used && Math.hypot(b.x - x, b.z - z) < 8);
    if (b && chance(0.6)) { b.used = true; p.benched = true; p.walking = false; p.o.position.set(b.x, SW, b.z); p.o.rotation.y = b.rot; play(p, 'Idle_A-loop'); p.lt = rr(20, 60); setTimeout(() => b.used = false, p.lt * 1000); continue; }
    if (!p.walking) { p.walking = true; play(p, pick(['Walk_A-loop', 'Walk_B-loop', 'Walk_C-loop'])); }
  }
}
// ================================================================ PLAN-BASED INTERIORS (hospital, dealership, company, flat, police, town hall)
// extra packs: AR Hospital Assets (H_*) and Tiny Treats House Plants (P_*), loaded with the interiors
const X2_HOSP = ['bed_1', 'bed_2', 'bed_4', 'cupboard_bottom', 'cupboard_top', 'machine_1', 'machine_2', 'overhead_light', 'tray_1'];
const X2_PLANTS = ['monstera', 'pothos', 'sansevieria', 'yucca', 'zzplant'].flatMap(p => ['large', 'medium', 'small'].map(s => p + '_plant_' + s + '_potted'));
async function loadX2() {
  const loader = new GLTFLoader();
  const one = async (url, name, scale, targetH) => {
    try {
      const g = await loader.loadAsync(BASE + url);
      const root = new THREE.Group(); root.add(g.scene); root.updateMatrixWorld(true);
      let k = scale;
      if (targetH) { const b = new THREE.Box3().setFromObject(root); k = targetH / Math.max(0.01, b.max.y - b.min.y); }
      root.scale.setScalar(k); root.updateMatrixWorld(true);
      const parts = [];
      root.traverse(o => { if (!o.isMesh) return; const mats = Array.isArray(o.material) ? o.material : [o.material]; parts.push({ geo: o.geometry, mat: mats[0], mtx: o.matrixWorld.clone() }); });
      proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(root) };
    } catch (e) { console.warn('x2 missing', url); }
  };
  await Promise.all([
    ...X2_HOSP.map(n => one('x2/hosp/' + n + '.glb', 'H_' + n, 1.45)),
    ...X2_PLANTS.map(n => one('x2/plants/' + n + '.gltf', 'P_' + n, 1, /large/.test(n) ? 1.35 : /medium/.test(n) ? 0.95 : 0.55)),
  ]);
}
const PLANT = (size, x, z) => iput(pickExisting(X2_PLANTS.filter(n => n.includes('_' + size + '_')).map(n => 'P_' + n)) || pickExisting(['I_Flower_01', 'I_Flower_03', 'I_Flower_05']), x, z, rr(0, 6));
function labelAt(text, x, z, rot = 0) { const s = textPlaque(text, '#1d4ed8', 1.4); s.position.set(curRoom.ox + x, 2.25, curRoom.oz + z); s.rotation.y = rot; curRoom.group.add(s); }
const H = (n, x, z, rot = 0, y = 0, col = true) => iput('H_' + n, x, z, rot, y, col);
// 17.5 x 15 m plan: hall in the middle, rooms on the back row and on both sides
function planShell(floor, wall, D = 6) {
  curRoom.wallName = wall || pickExisting(IW);
  shell(7, D, floor || pickExisting(['I_Floor_08', 'I_Floor_12', 'I_Floor_03']), curRoom.wallName, 3);
  curRoom.hallBox = [6.2, 11.3, 9.4, D * 2.5 - 2.2];
}
function waitingArea(z = 11.6) {
  const sofa = pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_07']), sofa2 = pickExisting(['I_Sofa_02', 'I_Sofa_04']) || sofa;
  iput(sofa, 6.6, z, Math.PI / 2); iput(sofa2, 10.9, z, -Math.PI / 2); iput('I_RoomTable_01', 8.75, z);
  PLANT('large', 5.6, 13.9); PLANT('large', 11.9, 13.9); PLANT('medium', 5.6, 5.6); PLANT('medium', 11.9, 5.6);
}

// ---- HOSPITAL (plan: Urgences, Service de soins, Consultation / Radiologie, Laboratoire / Bureau médical, Administration)
function buildHospital() {
  planShell('I_Floor_03', 'I_Wall_01');
  partition('x', 5, 0, 7, [1, 3, 5]); partition('z', 5, 0, 2, []); partition('z', 12.5, 0, 2, []);
  partition('z', 5, 2, 6, [2, 4]); partition('x', 10, 0, 2, []);
  partition('z', 12.5, 2, 6, [2, 4]); partition('x', 10, 5, 7, []);
  // urgences
  labelAt('🚑 Urgences', 2.5, 0.3); H('bed_4', 1.4, 2.2, 0); H('machine_1', 0.5, 0.6, 0); H('cupboard_bottom', 3.7, 0.25, 0); H('cupboard_top', 3.7, 0.25, 0, 1.55, false); H('tray_1', 2.8, 3.2, 0); roomNPC(2.6, 2.4, 'Idle_B-loop', -Math.PI / 2);
  // service de soins
  labelAt('Service de soins', 8.75, 0.3); for (const x of [6.2, 8.75, 11.3]) { H('bed_1', x, 1.5, 0); H('machine_2', x + 0.95, 0.5, 0); }
  roomNPC(10.0, 3.4, 'Idle_A-loop', Math.PI);
  // consultation
  labelAt('Consultation', 15, 0.3); H('bed_2', 16.6, 1.8, 0); OFFICE(14.2, 2.2); H('cupboard_bottom', 16.6, 4.4, Math.PI); roomNPC(14.2, 3.0, 'Idle_B-loop', Math.PI);
  // radiologie (no scanner in the packs: machines + exam table)
  labelAt('Radiologie', 2.5, 5.3); H('bed_2', 1.6, 7.4, Math.PI / 2); H('machine_2', 0.5, 6.0, 0); H('machine_1', 0.5, 9.0, Math.PI / 2); OFFICE(3.6, 8.9, Math.PI);
  // laboratoire
  labelAt('Laboratoire', 2.5, 10.3); for (const z of [11.1, 12.6, 14.1]) { H('cupboard_bottom', 0.05, z, Math.PI / 2); H('cupboard_top', 0.05, z, Math.PI / 2, 1.55, false); }
  H('tray_1', 2.8, 12.4, 0); H('machine_1', 3.8, 14.4, Math.PI); roomNPC(2.0, 12.6, 'Idle_B-loop', -Math.PI / 2);
  // bureau médical
  labelAt('Bureau médical', 15, 5.3); OFFICE(15.0, 6.8); iput('I_Library', 17.3, 8.6, -Math.PI / 2); PLANT('medium', 13.1, 9.4); roomNPC(15.0, 7.6, 'Idle_A-loop', Math.PI);
  // administration
  labelAt('Administration', 15, 10.3); OFFICE(14.1, 11.8); OFFICE(16.2, 11.8); iput('I_Library', 17.3, 14.0, -Math.PI / 2); PLANT('small', 13.1, 14.4);
  // hall: reception + waiting room
  counter(8.75, 6.6, 3); roomNPC(8.15, 5.95, 'Idle_A-loop', 0); roomNPC(9.35, 5.95, 'Idle_A-loop', 0); waitingArea();
  labelAt('➕ Accueil', 8.75, 5.3);
  curRoom.lift = null;
}

// ---- CAR DEALERSHIP (plan: Vente, Financement, Direction, Atelier + showroom with cars and lounge)
function buildConcession() {
  planShell('I_Floor_12', 'I_Wall_02');
  partition('x', 5, 0, 2, [1]); partition('z', 5, 0, 2, []); partition('x', 5, 5, 7, [5]); partition('z', 12.5, 0, 2, []);
  labelAt('Vente', 2.5, 0.3); OFFICE(2.5, 2.0); iput('I_Library', 0.3, 2.4, Math.PI / 2); roomNPC(2.5, 2.8, 'Idle_B-loop', Math.PI);
  labelAt('Direction / Financement', 15, 0.3); OFFICE(15.0, 2.0); iput('I_Library', 17.2, 2.4, -Math.PI / 2); PLANT('medium', 13.2, 0.6); roomNPC(15.0, 2.8, 'Idle_B-loop', Math.PI);
  labelAt('🚗 Concession', 8.75, 0.3); counter(8.75, 2.6, 3); roomNPC(8.75, 1.9, 'Idle_A-loop', 0);
  // showroom: the cars on sale, each on its spot
  const show = DEALER.map(v => v[0]).filter(n => proto[n] && !TWO_WHEEL.test(n)).slice(0, 4);
  [[2.6, 8.0, 0.6], [2.6, 12.6, 0.6], [14.9, 8.0, -0.6], [14.9, 12.6, -0.6]].forEach(([x, z, r], i) => {
    const n = show[i % show.length]; if (!n) return; const o = makeObject(n); o.position.set(curRoom.ox + x, 0.24, curRoom.oz + z); o.rotation.y = r; curRoom.group.add(o);
    curRoom.cols.push([curRoom.ox + x - 1.4, curRoom.oz + z - 2.2, curRoom.ox + x + 1.4, curRoom.oz + z + 2.2]);
  });
  // lounge in the middle
  iput(pickExisting(['I_Catpet_01', 'I_Catpet_02']), 8.75, 10.0, 0, 0.01, false); for (const [x, z, r] of [[7.6, 9.2, Math.PI / 4], [9.9, 9.2, -Math.PI / 4], [7.6, 10.9, 3 * Math.PI / 4], [9.9, 10.9, -3 * Math.PI / 4]]) iput(pickExisting(['I_Sofa_06', 'I_Sofa_08', 'I_Sofa_04']), x, z, r);
  iput('I_RoomTable_01', 8.75, 10.0); PLANT('large', 5.6, 14.2); PLANT('large', 11.9, 14.2); PLANT('medium', 5.6, 5.6); PLANT('medium', 11.9, 5.6);
  curRoom.hallBox = [6.0, 11.5, 12.4, 13.4];
}

// ---- COMPANY OFFICES (plan: open space, salle de réunion, direction, bureaux, cafétéria, toilettes)
function buildEntreprise() {
  planShell('I_Floor_08', 'I_Wall_03');
  partition('x', 7.5, 0, 2, [1]); partition('z', 5, 0, 3, [2]); partition('x', 5, 2, 5, [3]); partition('z', 12.5, 0, 6, [1, 4]); partition('x', 7.5, 5, 7, []);
  partition('x', 10, 0, 2, []);
  labelAt('Open space', 2.5, 0.3); for (const [x, z] of [[1.4, 1.6], [3.6, 1.6], [1.4, 4.4], [3.6, 4.4]]) { OFFICE(x, z); if (chance(0.7)) roomNPC(x, z + 0.8, 'Idle_B-loop', Math.PI); }
  labelAt('Salle de réunion', 8.75, 0.3); iput(pickExisting(['I_KitchenTable_02', 'I_KitchenTable_01']), 8.75, 2.4); for (const [dx, dz, r] of [[-0.5, -0.85, 0], [0.5, -0.85, 0], [-0.5, 0.85, Math.PI], [0.5, 0.85, Math.PI]]) iput('I_OfficeChair_01', 8.75 + dx, 2.4 + dz, r); iput('I_TV', 8.75, 0.25, 0, 1.2, false); PLANT('medium', 5.6, 0.6);
  labelAt('Direction', 15, 0.3); OFFICE(15, 2.2); iput('I_Library', 17.2, 3.0, -Math.PI / 2); iput(pickExisting(['I_Sofa_06', 'I_Sofa_04']), 15, 5.6, Math.PI); PLANT('large', 13.2, 0.6); roomNPC(15, 3.0, 'Idle_B-loop', Math.PI);
  labelAt('Bureau', 15, 7.8); OFFICE(15, 9.6); PLANT('small', 17.0, 8.4);
  labelAt('Cafétéria', 2.5, 7.8); iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_03']), 2.5, 12.0); for (const [dx, dz, r] of [[-0.5, -0.85, 0], [0.5, -0.85, 0], [-0.5, 0.85, Math.PI], [0.5, 0.85, Math.PI]]) iput('I_KitchenChair_01', 2.5 + dx, 12.0 + dz, r);
  if (proto.G_Fridge_2) iput('G_Fridge_2', 0.5, 8.4, Math.PI / 2); if (proto.G_Cofe_Maker_1) iput('G_Cofe_Maker_1', 0.4, 9.6, Math.PI / 2, 0.8, false);
  labelAt('Toilettes', 15, 12.8); iput('I_Toilet_01', 16.9, 13.9, -Math.PI / 2); iput('I_Toilet_02', 14.1, 14.4, Math.PI);
  labelAt('🏢 Entreprise', 8.75, 7.8); counter(8.75, 9.0, 3); roomNPC(8.75, 8.3, 'Idle_A-loop', 0); PLANT('large', 6.0, 13.8); PLANT('large', 11.5, 13.8);
  curRoom.hallBox = [6.2, 11.3, 11.2, 13.4];
}

// ---- POLICE STATION (plan: Bureau du commandant, Bureaux enquête, Cellules, Interrogatoire)
function buildPolice() {
  planShell('I_Floor_12', 'I_Wall_04');
  partition('z', 5, 0, 6, [1, 4]); partition('x', 7.5, 0, 2, []); partition('z', 12.5, 0, 6, [1, 4]); partition('x', 7.5, 5, 7, []);
  labelAt('Bureau du commandant', 2.5, 0.3); OFFICE(2.5, 2.4); iput('I_Library', 0.3, 3.4, Math.PI / 2); PLANT('medium', 4.4, 0.6); roomNPC(2.5, 3.2, 'Idle_B-loop', Math.PI);
  labelAt('Bureaux enquête', 2.5, 7.8); OFFICE(1.6, 10.2); OFFICE(3.6, 10.2); iput('I_Library', 0.3, 13.6, Math.PI / 2); roomNPC(1.6, 11.0, 'Idle_B-loop', Math.PI);
  labelAt('Cellules', 15, 0.3); iput('Fence_1_A_3', 15.0, 4.2, Math.PI / 2, 0, true); // one 4 m barred front inside the cell room iput('Bench_1_A', 15, 0.7, 0); iput('I_Toilet_01', 17.0, 0.5, -Math.PI / 2); if (chance(0.7)) roomNPC(14.4, 1.6, 'Idle_A-loop', Math.PI);
  labelAt('Interrogatoire', 15, 7.8); iput(pickExisting(['I_KitchenTable_01']), 15, 10.6); iput('I_OfficeChair_02', 15, 9.7, 0); iput('I_OfficeChair_02', 15, 11.5, Math.PI); iput('I_Lamp_02', 17.1, 8.4);
  labelAt('🚓 Accueil', 8.75, 0.3); counter(8.75, 2.6, 3); roomNPC(8.75, 1.9, 'Idle_A-loop', 0); waitingArea(10.6);
  curRoom.hallBox = [6.2, 11.3, 12.4, 13.4];
}

// ---- TOWN HALL (plan: Secrétariat, Salle du conseil, Bureau du maire, État civil, Archives)
function buildMairie() {
  planShell('I_Floor_08', 'I_Wall_05');
  partition('x', 5, 0, 7, [1, 5]); partition('z', 5, 0, 2, []); partition('z', 12.5, 0, 2, []);
  partition('z', 5, 2, 6, [3]); partition('z', 12.5, 2, 6, [3]);
  labelAt('Secrétariat', 2.5, 0.3); OFFICE(2.5, 2.2); iput('I_Library', 0.3, 2.6, Math.PI / 2); roomNPC(2.5, 3.0, 'Idle_B-loop', Math.PI);
  labelAt('Salle du conseil', 8.75, 0.3); for (const dx of [-1.2, 1.2]) iput(pickExisting(['I_KitchenTable_02', 'I_KitchenTable_01']), 8.75 + dx, 2.2); for (const dx of [-1.7, -0.6, 0.6, 1.7]) { iput('I_OfficeChair_02', 8.75 + dx, 1.3, 0); iput('I_OfficeChair_02', 8.75 + dx, 3.1, Math.PI); } PLANT('large', 5.6, 0.6); PLANT('large', 11.9, 0.6);
  labelAt('Bureau du maire', 15, 0.3); OFFICE(15, 2.2); iput('I_Library', 17.2, 2.6, -Math.PI / 2); iput(pickExisting(['I_Fireplace_02', 'I_Fireplace_01']), 15, 4.6, Math.PI); roomNPC(15, 3.0, 'Idle_B-loop', Math.PI);
  labelAt('État civil', 2.5, 5.3); OFFICE(1.5, 7.2); OFFICE(3.6, 7.2); OFFICE(2.5, 11.4); roomNPC(1.5, 8.0, 'Idle_B-loop', Math.PI); iput('I_Library', 0.3, 13.6, Math.PI / 2);
  labelAt('Archives', 15, 5.3); for (const z of [7.0, 9.5, 12.0]) { iput('I_Library', 13.4, z, Math.PI / 2); iput('I_Library', 17.2, z, -Math.PI / 2); } for (let k = 0; k < 5; k++) iput(pick(['K_Containers_Box_Small', 'K_Containers_Box_Medium']), rr(14.4, 16.2), rr(6.5, 14), rr(0, 6));
  labelAt('🏛️ Mairie', 8.75, 5.3); counter(8.75, 6.6, 3); roomNPC(8.75, 5.95, 'Idle_A-loop', 0); waitingArea();
}

// ---- FLAT (plan: 3 bedrooms, kitchen + dining, living room, bathroom, laundry)
const FLAT2_POINTS = [
  { x: 6.7, z: 9.0, face: Math.PI / 2, sit: true }, { x: 7.5, z: 1.25, face: Math.PI, clip: 'Idle_B-loop' }, { x: 8.3, z: 3.5, face: 0, sit: true },
  { x: 15.2, z: 8.4, face: Math.PI, sit: true }, { x: 2.5, z: 3.7, face: Math.PI, clip: 'LookingAround-loop' }, { x: 14.6, z: 3.6, face: 0 }, { x: 2.5, z: 10.2, face: 0, clip: 'Idle_B-loop' },
];
function buildAppart() {
  curRoom.wallName = pickExisting(IW);
  shell(7, 5, pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12']), curRoom.wallName, 3);
  partition('z', 5, 0, 5, [1, 3]); partition('x', 6.25, 0, 2, []); partition('z', 12.5, 0, 5, [1, 3]); partition('x', 5, 5, 7, []);
  const EMPTY = curRoom.door && curRoom.door.unit && !curRoom.door.furnished;
  const fur = EMPTY ? () => null : iput; // movable furniture only when furnished
  // bedroom 1 (north-west)
  labelAt('Chambre', 2.5, 0.3); fur(pickExisting(['I_Bed2_01', 'I_Bed2_02', 'I_Bed1_01']), 2.5, 1.6, 0); fur('I_Bed_Table_01', 0.6, 0.4); fur('I_Lamp_03', 0.6, 0.4, 0, topOf('I_Bed_Table_01'), false); fur('I_Bed_Table_02', 4.4, 0.4);
  fur(pickExisting(['I_Catpet_04', 'I_Catpet_05']), 2.5, 4.3, 0, 0.01, false); EMPTY || PLANT('small', 4.4, 5.6);
  // bedroom 2 (south-west) with wardrobe
  fur(pickExisting(['I_Bed1_01', 'I_Bed1_02']), 1.4, 10.6, Math.PI / 2); fur(pickExisting(['I_RoomFurniture_01', 'I_RoomFurniture_02', 'I_RoomFurniture_03']), 4.6, 7.6, -Math.PI / 2); fur('I_Bed_Table_01', 0.5, 8.6); EMPTY || PLANT('medium', 4.4, 12.0);
  // kitchen + dining (north, centre)
  const tops = ['I_KitchenTabletop1_01', 'I_KitchenTabletop1_02', 'I_KitchenTabletop1_03', 'I_KitchenTabletop1_04'];
  let kx = 5.8; for (let i = 0; i < 5; i++) { const n = i === 2 ? 'I_Oven' : pickExisting(tops); iput(n, kx, 0.4, 0); if (i !== 2) iputOn(n, KITCHEN_OBJ, kx, 0.4, 0, 1, 0.2); kx += 1.14; } iput('I_RangeHood', 5.8 + 2 * 1.14, 0.25, 0, 1.75, false);
  if (proto.G_Fridge_2) iput('G_Fridge_2', 11.6, 0.5, 0);
  fur(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_02', 'I_KitchenTable_03']), 8.75, 4.3, 0);
  for (const [dx, dz, r] of [[-0.55, -0.85, 0], [0.55, -0.85, 0], [-0.55, 0.85, Math.PI], [0.55, 0.85, Math.PI]]) fur(pickExisting(['I_KitchenChair_01', 'I_KitchenChair_02']), 8.75 + dx, 4.3 + dz, r);
  if (!EMPTY) iputOn('I_KitchenTable_01', ['I_Plate_01', 'I_Cup_02', 'I_Pizza_01', 'I_Watermelon_01'], 8.75, 4.3, 0, 3, 0.5);
  // living room (south, centre): sofa facing the TV
  fur(pickExisting(['I_Catpet_01', 'I_Catpet_02', 'I_Catpet_03']), 8.75, 9.4, 0, 0.01, false);
  fur(pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_05', 'I_Sofa_07']), 6.3, 9.0, -Math.PI / 2); fur('I_RoomTable_01', 8.0, 9.0);
  fur('I_TV_Shelf', 11.9, 9.0, -Math.PI / 2, 0.45, false); fur('I_RoomTable_01', 11.85, 9.0, -Math.PI / 2); fur('I_TV', 11.9, 9.0, -Math.PI / 2, topOf('I_RoomTable_01'), false);
  fur('I_Lamp_01', 5.6, 7.0); EMPTY || PLANT('large', 5.6, 11.8); EMPTY || PLANT('large', 11.9, 11.8); fur('I_Library', 12.2, 6.4, -Math.PI / 2); if (!EMPTY) iputOn('I_Library', BOOKS, 12.2, 6.4, -Math.PI / 2, 0);
  // bathroom (north-east)
  labelAt('Salle de bain', 15, 0.3); iput('I_Bath', 16.4, 2.0, Math.PI / 2); iput(pickExisting(['I_Toilet_01', 'I_Toilet_02']), 13.3, 0.5, 0); iput('I_Washer_01', 13.2, 4.4, Math.PI / 2);
  iput(pickExisting(['I_ShowerCarpet_01', 'I_ShowerCarpet_02']), 15.2, 2.0, Math.PI / 2, 0.01, false); iput('I_Towel_01', 17.3, 4.0, -Math.PI / 2, 1.2, false);
  // bedroom 3 / office (south-east)
  fur('I_PC_Table', 15.2, 7.4, 0); fur('I_PC_Screen', 15.2, 7.3, 0, topOf('I_PC_Table'), false); fur('I_OfficeChair_01', 15.2, 8.2, Math.PI);
  fur(pickExisting(['I_Bed1_01', 'I_Bed1_03']), 16.4, 11.0, -Math.PI / 2); EMPTY || PLANT('small', 13.1, 12.0);
  if (!curRoom.door || !curRoom.door.unit || curRoom.door.npc) { roomActor(FLAT2_POINTS); if (chance(0.6)) roomActor(FLAT2_POINTS); }
  curRoom.flat2 = true;
}
function flatSpots(room) {
  return { bed: new THREE.Vector3(room.ox + 2.5, 0, room.oz + 3.0), bath: new THREE.Vector3(room.ox + 15.0, 0, room.oz + 2.4), kitchen: new THREE.Vector3(room.ox + 8.0, 0, room.oz + 1.4), chest: new THREE.Vector3(room.ox + 11.8, 0, room.oz + 11.6) };
}

// ---- FAST FOOD / RESTAURANT (plan: réserve, cuisine, vestiaire, toilettes, comptoir, salle)
function buildRestoPlan() {
  planShell(pickExisting(['I_Floor_10', 'I_Floor_14', 'I_Floor_20']), pickExisting(['I_Wall_06', 'I_Wall_07', 'I_Wall_08']));
  partition('z', 5, 0, 2, [1]); partition('z', 12.5, 0, 4, [1, 3]); partition('x', 5, 5, 7, []); partition('x', 10, 5, 7, []);
  labelAt('Réserve', 2.5, 0.3); for (const x of [1.0, 2.6, 4.2]) iput('I_Library', x, 0.25, 0); for (let k = 0; k < 7; k++) iput(pick(['K_Containers_Box_Medium', 'K_Containers_Box_Small', 'K_Containers_Box_Large']), rr(0.8, 4.2), rr(1.8, 4.4), rr(0, 6));
  labelAt('Cuisine', 8.75, 0.3);
  const line = ['R_Furnit_A_1_A', 'R_Owen_A', 'R_Furnit_A_4_A', 'R_Sink_A', 'R_Furnit_A_6_A'];
  let x = 5.4; for (const n of line) { if (!proto[n]) continue; const f = footprint(n, 0); iput(n, x + (f.maxx - f.minx) / 2, 0.5, 0); if (n !== 'R_Owen_A' && n !== 'R_Sink_A') iputOn(n, ['R_Pan_1_A', 'R_CookingPot_1_A', 'R_CuttingBoard_1_A', 'R_Bowl_1_A'], x + (f.maxx - f.minx) / 2, 0.5, 0, 2, 0.3); x += f.maxx - f.minx; }
  if (proto.G_Fridge_2) iput('G_Fridge_2', 12.0, 0.5, 0);
  roomNPC(7.5, 1.7, 'Idle_A-loop', Math.PI); roomNPC(10.2, 1.7, 'Idle_B-loop', Math.PI);
  labelAt('Vestiaire', 15, 0.3); iput(pickExisting(['I_RoomFurniture_01', 'I_RoomFurniture_02']), 15, 0.4, 0); iput('Bench_1_A', 15, 3.6, 0, 0, true, 0.7);
  labelAt('Toilettes', 15, 5.3); iput('I_Toilet_01', 13.3, 9.4, Math.PI); iput('I_Toilet_02', 16.8, 9.4, Math.PI);
  // counter facing the dining room
  counter(8.75, 3.6, 4); roomNPC(8.75, 2.9, 'Idle_A-loop', 0); curRoom.counter = new THREE.Vector3(curRoom.ox + 8.75, 0, curRoom.oz + 4.9);
  const dishes = ['R_Dish_1_PlateReady', 'R_Dish_3_Ready', 'R_ChessBurger_Ready', 'R_Coffy_A', 'R_Cake_3_Ready'];
  curRoom.seats = [];
  for (const [tx, tz] of [[2.3, 7.4], [2.3, 11.6], [6.6, 7.6], [11.0, 7.6], [6.6, 11.4], [11.0, 11.4], [15.0, 12.6]]) {
    iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_03']), tx, tz, 0);
    for (const [dx, dz, r] of [[-0.45, -0.85, 0], [0.45, -0.85, 0], [-0.45, 0.85, Math.PI], [0.45, 0.85, Math.PI]]) iput(pickExisting(['R_Chair_1_A', 'R_Chair_2_A', 'R_Chair_3_A']), tx + dx, tz + dz, r);
    iputOn('I_KitchenTable_01', dishes, tx, tz, 0, 2, 0.4);
    curRoom.seats.push({ x: curRoom.ox + tx + 0.45, z: curRoom.oz + tz + 0.85, rot: 0 });
    if (chance(0.6)) { const c = roomNPC(tx - 0.45, tz - 0.85, 'Idle_B-loop', 0); if (c) sitters.push(c); }
  }
  PLANT('large', 4.4, 14.2); PLANT('large', 13.1, 14.2); PLANT('medium', 8.75, 9.5);
}
// ---- AGENCIES (plan "Accueil": two offices, reception, lounge, coffee corner) — intérim, immobilier, assurance, banque
function buildAgency(kind) {
  planShell(pickExisting(['I_Floor_08', 'I_Floor_12']), pickExisting(IW));
  partition('z', 5, 0, 2, []); partition('x', 5, 0, 2, [1]); partition('z', 12.5, 0, 2, []); partition('x', 5, 5, 7, [5]);
  const T = { emploi: ['👔 Agence d’intérim', 'Conseiller', 'Conseillère'], immobilier: ['🏠 Agence immobilière', 'Ventes', 'Locations'], assurance: ['🛡️ Assurance auto', 'Contrats', 'Sinistres'], banque: ['🏦 Banque', 'Conseiller', 'Coffre'] }[kind];
  labelAt(T[0], 8.75, 0.3); counter(8.75, 2.4, 3); roomNPC(8.75, 1.7, 'Idle_A-loop', 0); PLANT('large', 6.0, 0.7); PLANT('large', 11.5, 0.7);
  labelAt(T[1], 2.5, 0.3); OFFICE(2.5, 2.2); iput('I_Library', 0.3, 2.6, Math.PI / 2); for (const dx of [-0.5, 0.5]) iput('I_OfficeChair_02', 2.5 + dx, 3.6, Math.PI); roomNPC(2.5, 3.0, 'Idle_B-loop', Math.PI);
  labelAt(T[2], 15, 0.3);
  if (kind === 'banque') { for (const [n, x, z] of [['K_Gold_Bars_Stack_Large', 13.6, 1.0], ['K_Money_Pile_Large', 15.4, 1.0], ['K_Money_Bills_Stack_Large', 17.0, 1.2], ['K_Gems_Chest', 15.4, 3.4]]) iput(n, x, z, rr(0, 6)); }
  else { OFFICE(15, 2.2); iput('I_Library', 17.2, 2.6, -Math.PI / 2); for (const dx of [-0.5, 0.5]) iput('I_OfficeChair_02', 15 + dx, 3.6, Math.PI); roomNPC(15, 3.0, 'Idle_B-loop', Math.PI); }
  // lounge
  iput(pickExisting(['I_Catpet_01', 'I_Catpet_02']), 8.75, 10.2, 0, 0.01, false); iput('I_RoomTable_01', 8.75, 10.2);
  for (const [x, z, r] of [[7.5, 9.3, Math.PI / 4], [10.0, 9.3, -Math.PI / 4], [7.5, 11.1, 3 * Math.PI / 4], [10.0, 11.1, -3 * Math.PI / 4]]) iput(pickExisting(['I_Sofa_06', 'I_Sofa_08', 'I_Sofa_04']), x, z, r);
  iput(pickExisting(['I_Sofa_01', 'I_Sofa_03']), 0.9, 10.5, Math.PI / 2); PLANT('medium', 0.6, 8.0); iput('I_Lamp_01', 0.6, 13.2);
  if (proto.G_Cofe_Maker_1) { iput('I_RoomFurniture_05', 16.9, 10.5, -Math.PI / 2); iput('G_Cofe_Maker_1', 16.9, 10.5, -Math.PI / 2, 0.9, false); }
  PLANT('large', 16.8, 13.8); PLANT('large', 5.4, 13.8); PLANT('medium', 12.1, 13.8);
  curRoom.hallBox = [6.0, 11.5, 12.2, 13.4];
}
// ================================================================ REAL ESTATE: several flats per building, residences and investments
// L.props: [{ uid, own, mode: 'principal'|'secondaire'|'invest', furnished, due, furn: [], tenant }]
const UNITS_PER_BUILDING = 6;
const RENT_PERIOD = 300; // s between rents (same rhythm as before)
const FURNISHED_ITEMS = ['I_Sofa_01', 'I_Bed2_02', 'I_Bed1_01', 'I_Bed1_01', 'I_KitchenTable_01', 'I_KitchenChair_01', 'I_KitchenChair_01', 'I_KitchenChair_01', 'I_KitchenChair_01', 'I_RoomTable_01', 'I_TV', 'I_Library', 'I_Lamp_01', 'I_Flower_05', 'I_Flower_05', 'I_PC_Table', 'I_Catpet_02'];
function furnitureValue() { let s = 0; for (const n of FURNISHED_ITEMS) { const f = FURN.find(f => f[0] === n); s += f ? f[2] : 0; } return s; }
function unitsOf(b) {
  if (b.unit) return [];
  if (!b.units) {
    b.units = [];
    for (let k = 0; k < UNITS_PER_BUILDING; k++) {
      const floor = 1 + Math.floor(k / 2), u = { id: doors.length, type: 'appart', unit: true, of: b, floor, label: floor + (k % 2 ? 'B' : 'A'), x: b.x, z: b.z, out: b.out, built: null, _viaLobby: true,
        base: 1200 + floor * 150, npc: hash01(b.id * 7 + k) < 0.45, furnished: true };
      doors.push(u); b.units.push(u);
    }
  }
  return b.units;
}
function hash01(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
const propOf = (uid) => L.props.find(p => p.uid === uid);
const isRes = (uid) => { const p = propOf(uid); return !!p && (p.mode === 'principal' || p.mode === 'secondaire'); };
const residences = () => L.props.filter(p => p.mode === 'principal' || p.mode === 'secondaire');
function syncHome() { const p = L.props.find(p => p.mode === 'principal') || residences()[0]; L.home = p ? p.uid : null; L.homeRent = !!(p && !p.own); L.rentDue = p && !p.own ? p.due : 0; }
function unitPrice(u, furnished) { return u.base + (furnished ? furnitureValue() : 0); }
function unitRent(u, furnished) { return Math.round((35 + u.floor * 5) * (furnished ? 1.35 : 1)); }
function furnOf(uid) { const p = propOf(uid); return p ? (p.furn = p.furn || []) : []; }
function rebuildUnit(u) { if (u.built) { scene.remove(u.built.group); u.built = null; } }
// buy or rent a unit; mode decided by the player (max 2 residences)
function acquire(u, own, furnished, mode) {
  if (u.npc || propOf(u.id)) { banner('Cet appartement n’est pas disponible', 1400); return false; }
  if (mode !== 'invest' && residences().length >= 2) { banner('🏠 Maximum 2 résidences (principale + secondaire)', 1800); return false; }
  if (!own && mode === 'invest') return false;
  const cost = own ? unitPrice(u, furnished) : unitRent(u, furnished);
  if (!payMoney(cost)) return false;
  if (mode === 'principal') for (const p of L.props) if (p.mode === 'principal') p.mode = 'secondaire';
  L.props.push({ uid: u.id, own, mode, furnished, due: RENT_PERIOD, furn: [], tenant: mode === 'invest' ? 120 : 0 });
  if (u.furnished !== furnished) { u.furnished = furnished; rebuildUnit(u); }
  syncHome();
  const what = (own ? 'Acheté' : 'Loué') + ' : appartement ' + u.label + (furnished ? ' (meublé)' : ' (vide)') + ' — ' + cost + ' $';
  banner('🏠 ' + what, 2000); phoneNotify('🏠 Immobilier', what + ' · ' + MODE_LABEL[mode]);
  return true;
}
const MODE_LABEL = { principal: 'résidence principale', secondaire: 'résidence secondaire', invest: 'investissement (mis en location)' };
function setMode(p, mode) {
  if (!p.own && mode === 'invest') { banner('Il faut être propriétaire pour mettre en location', 1600); return; }
  if (mode !== 'invest' && p.mode === 'invest' && residences().length >= 2) { banner('🏠 Maximum 2 résidences', 1600); return; }
  if (mode === 'principal') for (const q of L.props) if (q !== p && q.mode === 'principal') q.mode = 'secondaire';
  p.mode = mode; p.tenant = mode === 'invest' ? 120 : 0; p.due = RENT_PERIOD;
  if (mode === 'invest' && inside && inside.door.id === p.uid) exitInterior();
  syncHome(); phoneNotify('🏠 Immobilier', 'Appartement ' + doors[p.uid].label + ' : ' + MODE_LABEL[mode]);
}
function release(p, sell) {
  const u = doors[p.uid];
  if (sell && p.own) { const v = Math.round(unitPrice(u, p.furnished) * 0.8); M.money += v; banner('💰 Vendu ' + v + ' $ (80 % du prix)', 1800); phoneNotify('🏠 Immobilier', 'Appartement ' + u.label + ' vendu : +' + v + ' $'); }
  else banner('Location résiliée', 1400);
  for (const e of p.furn || []) give('F:' + e.m); // your own furniture comes back to the inventory
  if (inside && inside.door.id === p.uid) exitInterior();
  L.props.splice(L.props.indexOf(p), 1); syncHome();
}
// rents: as a tenant you pay, as an investor your tenant pays you
function updateProps(dt) {
  for (const p of L.props.slice()) {
    const u = doors[p.uid]; if (!u) continue;
    if (!p.own) {
      p.due -= dt; if (p.due <= 0) { const r = unitRent(u, p.furnished); if (payMoney(r)) { p.due = RENT_PERIOD; banner('🔑 Loyer payé (' + r + ' $)', 1500); } else { banner('Expulsé de l’appartement ' + u.label + ' : loyer impayé', 2500); release(p, false); } }
    } else if (p.mode === 'invest') {
      if (p.tenant > 0) { p.tenant -= dt; if (p.tenant <= 0) phoneNotify('🏠 Immobilier', 'Un locataire s’installe dans l’appartement ' + u.label); continue; }
      p.due -= dt; if (p.due <= 0) { p.due = RENT_PERIOD; const r = unitRent(u, p.furnished); L.bank += r; phoneNotify('🏠 Immobilier', 'Loyer reçu : +' + r + ' $ (appartement ' + u.label + ')'); }
    }
  }
  syncHome();
}
// ---- building lobby: every flat of the building
function lobbyUnitsMenu(b) {
  const rows = [];
  for (const u of unitsOf(b)) {
    const p = propOf(u.id);
    if (p) {
      rows.push({ sep: '🔑 ' + u.label + ' — ' + (p.own ? 'à toi' : 'loué par toi') + ' · ' + MODE_LABEL[p.mode] + (p.furnished ? ' · meublé' : ' · vide') + (p.mode === 'invest' ? (p.tenant > 0 ? ' · recherche de locataire' : ' · loué ' + unitRent(u, p.furnished) + ' $ / 5 min') : '') });
      if (p.mode !== 'invest') rows.push({ t: '⬆️ Monter à l’appartement ' + u.label, fn: () => goUnit(u), keep: false });
      if (p.mode !== 'principal') rows.push({ t: '🏠 En faire ma résidence principale', fn: () => setMode(p, 'principal') });
      if (p.mode === 'principal' || p.mode === 'invest') rows.push({ t: '🏡 Résidence secondaire', dis: p.mode === 'invest' && residences().length >= 2, fn: () => setMode(p, 'secondaire') });
      if (p.own && p.mode !== 'invest') rows.push({ t: '📈 Mettre en investissement (le louer ; tu n’y vis plus)', fn: () => setMode(p, 'invest') });
      rows.push({ t: p.own ? '💰 Vendre (' + Math.round(unitPrice(u, p.furnished) * 0.8) + ' $)' : '❌ Résilier la location', fn: () => release(p, true) });
    } else if (u.npc) rows.push({ sep: '🚪 ' + u.label + ' — occupé' });
    else {
      rows.push({ sep: '✨ ' + u.label + ' — libre (étage ' + u.floor + ')' });
      rows.push({ t: '👀 Visiter', fn: () => goUnit(u, true), keep: false });
      for (const f of [false, true]) {
        rows.push({ t: '🏠 Acheter ' + (f ? 'meublé' : 'vide') + ' — ' + unitPrice(u, f) + ' $', fn: () => chooseMode(u, true, f), keep: false });
        rows.push({ t: '🔑 Louer ' + (f ? 'meublé' : 'vide') + ' — ' + unitRent(u, f) + ' $ / 5 min', fn: () => chooseMode(u, false, f), keep: false });
      }
    }
  }
  openMenu('🛎️ Accueil — appartements de l’immeuble', rows, 'Max 2 résidences (principale + secondaire). Un bien en investissement est loué : tu ne peux plus y vivre. Meublé : prix des meubles inclus, loyer un peu plus cher.');
}
function chooseMode(u, own, furnished) {
  const opts = [];
  if (!L.props.some(p => p.mode === 'principal')) opts.push(['principal', '🏠 Résidence principale']);
  if (residences().length < 2) opts.push(['secondaire', '🏡 Résidence secondaire']);
  if (own) opts.push(['invest', '📈 Investissement (à louer)']);
  if (!opts.length) { banner('🏠 Tu as déjà 2 résidences', 1600); return; }
  setTimeout(() => openMenu('Appartement ' + u.label + ' — ' + (own ? 'achat' : 'location') + (furnished ? ' meublé' : ' vide'), opts.map(([m, t]) => ({ t, fn: () => acquire(u, own, furnished, m), keep: false }))), 50);
}
async function goUnit(u, visit) {
  const p = propOf(u.id);
  if (!visit && (!p || p.mode === 'invest')) { banner(p ? '📈 Appartement loué à un locataire' : '🔒 Réservé aux résidents', 1500); return; }
  closeMenu(); inside = null; L.visiting = visit ? u.id : null; await enterDoor(u);
  if (visit) banner('👀 Visite de l’appartement ' + u.label + (u.furnished ? ' (meublé)' : ' (vide)') + ' · E à la porte pour sortir', 2200);
}

// ================================================================ ONLINE ACCOUNT + CLOUD SAVE (Supabase)
// public project URL + publishable key (safe in the browser; data protected by RLS on the `saves` table)
const SUPABASE_URL = 'https://oedocghuqyqksrtbopdk.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8c8Ds6ytzlzUib4EJXoAIg_BDeUUXlm';
let sb = null, sbUser = null;
try { sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } }); } catch (e) { console.warn('supabase', e); }
function accountUI(msg) {
  const st = document.getElementById('accStatus'); if (!st) return;
  st.textContent = msg || (sbUser ? '✔ Connecté : ' + sbUser.email + ' — ta partie est sauvegardée en ligne' : 'Non connecté : sauvegarde seulement sur cet appareil');
  document.getElementById('accForm').style.display = sbUser ? 'none' : 'flex';
  document.getElementById('accOut').style.display = sbUser ? 'inline-block' : 'none';
}
async function accountInit() {
  if (!sb || SHOT) return;
  const { data } = await sb.auth.getSession(); sbUser = data.session ? data.session.user : null; accountUI();
  sb.auth.onAuthStateChange((_e, s) => { sbUser = s ? s.user : null; accountUI(); });
  const em = document.getElementById('accEmail'), pw = document.getElementById('accPw');
  const go = async (signup) => {
    accountUI('…'); const fn = signup ? sb.auth.signUp.bind(sb.auth) : sb.auth.signInWithPassword.bind(sb.auth);
    const { data, error } = await fn({ email: em.value.trim(), password: pw.value });
    if (error) return accountUI('⚠️ ' + error.message);
    sbUser = data.user || (data.session && data.session.user) || null;
    if (signup && !data.session) return accountUI('📧 Compte créé : confirme ton e-mail puis connecte-toi');
    accountUI(); await cloudPull();
  };
  document.getElementById('accIn').onclick = () => go(false);
  document.getElementById('accUp').onclick = () => go(true);
  document.getElementById('accOut').onclick = async () => { await sb.auth.signOut(); sbUser = null; accountUI(); };
  for (const i of [em, pw]) i.addEventListener('keydown', e => e.stopPropagation());
  if (sbUser) await cloudPull();
}
// cloud -> this device (the most recent of the two wins)
async function cloudPull() {
  if (!sb || !sbUser) return;
  const { data, error } = await sb.from('saves').select('data, updated_at').eq('user_id', sbUser.id).maybeSingle();
  if (error) { accountUI('⚠️ Sauvegarde en ligne indisponible : ' + error.message); return; }
  if (!data) { cloudPush(); return; }
  const local = JSON.parse(localStorage.getItem('cartooncity_save') || 'null');
  if (!local || (data.data && (data.data.t || 0) >= (local.t || 0))) { localStorage.setItem('cartooncity_save', JSON.stringify(data.data)); loadGame(); accountUI('☁️ Partie en ligne chargée — ' + sbUser.email); }
}
let cloudBusy = false;
async function cloudPush() {
  if (!sb || !sbUser || cloudBusy) return; cloudBusy = true;
  try { const d = JSON.parse(localStorage.getItem('cartooncity_save') || 'null'); if (d) { const { error } = await sb.from('saves').upsert({ user_id: sbUser.id, data: d, updated_at: new Date().toISOString() }); if (error) console.warn('cloud save', error.message); } }
  finally { cloudBusy = false; }
}
// ================================================================ PARKING BARRIERS, PAID ZONE, LOBBIES, PHONE
// ---- lifting barrier (RoadStop_1_A from the city pack: the arm is its own node, we pivot it)
const gates = [];
function makeGate(x, z, rot, lot) {
  if (!proto.RoadStop_1_A) return null;
  const g = makeObject('RoadStop_1_A');
  let arm = null, best = 0;
  for (const m of g.children) { m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix); const s = b.max.z - b.min.z; if (s > best) { best = s; arm = m; } }
  let pivot = null;
  if (arm && best > 2) {
    arm.geometry.computeBoundingBox(); const b = arm.geometry.boundingBox.clone().applyMatrix4(arm.matrix);
    pivot = new THREE.Group(); pivot.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z);
    g.remove(arm); arm.position.sub(pivot.position); pivot.add(arm); g.add(pivot);
  }
  g.position.set(x, SW, z); g.rotation.y = rot; scene.add(g);
  const gate = { g, pivot, lift: 0, open: 0, x, z, rot, len: best || 3.3, lot };
  gates.push(gate); return gate;
}
// world-space segment covered by the arm
function gateSeg(gt) { const dx = Math.sin(gt.rot), dz = Math.cos(gt.rot); return [gt.x, gt.z, gt.x + dx * gt.len, gt.z + dz * gt.len]; }
function distSeg(px, pz, [ax, az, bx, bz]) { const vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz))); return Math.hypot(px - ax - vx * t, pz - az - vz * t); }
function nearGate(maxD = 5) {
  if (!player.inCar) return null; const o = player.inCar.obj.position; let best = null, bd = maxD;
  for (const gt of gates) { const d = distSeg(o.x, o.z, gateSeg(gt)); if (d < bd) { bd = d; best = gt; } } return best;
}
function openGate(gt) { for (const o of gates) if (o.lot === gt.lot) o.open = 6; }
function updateGates(dt) {
  const ng = nearGate(7);
  if (ng && L.lotTicket === ng.lot) openGate(ng);
  if (L.lotTicket && player.inCar) { const o = player.inCar.obj.position; if (Math.hypot(o.x - L.lotTicket.x, o.z - L.lotTicket.z) > 60) L.lotTicket = null; }
  for (const gt of gates) {
    gt.open = Math.max(0, gt.open - dt);
    gt.lift += ((gt.open > 0 ? 1 : 0) - gt.lift) * Math.min(1, dt * 3);
    if (gt.pivot) gt.pivot.rotation.x = -1.45 * gt.lift;
  }
}
// called from updatePlayerCar after movement: a closed arm is solid for the player's car
function gateBlock(car) {
  const o = car.obj.position; let hit = false;
  for (const gt of gates) {
    if (gt.lift > 0.8) continue;
    const s = gateSeg(gt); const d = distSeg(o.x, o.z, s);
    if (d < 1.4) { const nx = Math.cos(gt.rot), nz = -Math.sin(gt.rot); const side = Math.sign((o.x - gt.x) * nx + (o.z - gt.z) * nz) || 1; o.x += nx * side * (1.4 - d); o.z += nz * side * (1.4 - d); hit = true; }
  }
  if (hit) car.speed = 0;
  return hit;
}
const LOT_PRICE = 5;
function gateAction() {
  const gt = nearGate(5); if (!gt || L.lotTicket === gt.lot) return false;
  if (Math.abs(player.inCar.speed) > 1) { banner('Arrête-toi devant la barrière', 1200); return true; }
  if (!payMoney(LOT_PRICE)) return true;
  L.lotTicket = gt.lot; openGate(gt); banner('🅿️ Ticket parking payé (−' + LOT_PRICE + ' $) · la barrière se lève', 1800); phoneNotify('🅿️ Parking', 'Ticket payé : ' + LOT_PRICE + ' $'); return true;
}
function gatePrompt() { const gt = nearGate(5); return gt && L.lotTicket !== gt.lot ? 'E : payer le parking (' + LOT_PRICE + ' $) · la barrière se lève' : ''; }

// ---- paid street parking zone (city centre)
const PAID = { x0: 0, z0: 0, x1: 0, z1: 0, price: 3 };
function initPaidZone() { PAID.x0 = blockC(5) - 28; PAID.x1 = blockC(8) + 28; PAID.z0 = blockC(5) - 28; PAID.z1 = blockC(8) + 28; }
function inPaid(x, z) { return x > PAID.x0 && x < PAID.x1 && z > PAID.z0 && z < PAID.z1; }
// L.street = { car, x, z, paidUntil (game minutes absolute), since }
function gameNow() { return GT.day * 1440 + GT.min; }
function onCarParked(car) {
  const p = car.obj.position; if (!inPaid(p.x, p.z) || lotsParking.some(l => Math.abs(p.x - l.x) < 21 && Math.abs(p.z - l.z) < 21)) { L.street = null; return; }
  L.street = { car, x: p.x, z: p.z, paidUntil: 0, since: gameNow(), fined: false };
  banner('🅿️ Zone payante : ' + PAID.price + ' $ / heure — paie dans l’appli Parking du téléphone (T) ou à l’horodateur', 3200);
}
function updatePaid() {
  const s = L.street; if (!s) return;
  if (player.inCar === s.car || Math.hypot(s.car.obj.position.x - s.x, s.car.obj.position.z - s.z) > 3) { L.street = null; return; }
  const now = gameNow();
  if (!s.fined && now > Math.max(s.paidUntil, s.since + 20)) { s.fined = true; L.fines += 25; phoneNotify('🚓 Police', 'Amende stationnement : 25 $ (zone payante sans ticket)'); banner('🚨 Amende de stationnement : 25 $', 2200); }
}
function payStreet(hours) { const s = L.street; if (!s) return; if (!payMoney(PAID.price * hours)) return; s.paidUntil = Math.max(s.paidUntil, gameNow()) + hours * 60; s.fined = false; phoneNotify('🅿️ Parking', 'Stationnement payé : ' + hours + ' h'); }
function parkomatNear() { if (player.inCar || inside) return null; return parkomats.find(p => Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < 1.8) || null; }
const parkomats = [];
function drawPaidOnMap(c, k) {
  c.fillStyle = 'rgba(66,165,245,0.18)'; c.fillRect((PAID.x0 + HALF) * k, (PAID.z0 + HALF) * k, (PAID.x1 - PAID.x0) * k, (PAID.z1 - PAID.z0) * k);
  c.strokeStyle = 'rgba(66,165,245,0.8)'; c.lineWidth = 1; c.strokeRect((PAID.x0 + HALF) * k, (PAID.z0 + HALF) * k, (PAID.x1 - PAID.x0) * k, (PAID.z1 - PAID.z0) * k);
}

// ---- lobbies (halls d'immeuble) for apartment buildings and the hospital
function lobbyFor(door) {
  if (!door.lobbyDoor) door.lobbyDoor = { id: 60000 + door.id, type: 'lobby', of: door, kind: 'appart', x: door.x, z: door.z, out: door.out, built: null };
  return door.lobbyDoor;
}
let hospDoor = null;
function hospitalDoor() {
  const h = nearestSpot('hospital'); if (!h) return null;
  if (!hospDoor) hospDoor = { id: 70001, type: 'lobby', kind: 'hopital', x: h.pos.x, z: h.pos.z, out: [0, 1], built: null };
  return hospDoor;
}
function buildLobby(door) {
  const R = curRoom;
  if (door.kind === 'hopital') return buildHospital();
  serviceShell(pickExisting(['I_Floor_08', 'I_Floor_12', 'I_Floor_03']));
  counter(7.5, 6.0, 3); roomNPC(7.5, 5.45, 'Idle_A-loop', 0);
  if (proto.G_Screen_1) iput('G_Screen_1', 6.3, 6.0, Math.PI, topOf('I_Bar_01'), false);
  iput(pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_07']), 2.3, 9.0, Math.PI); iput('I_RoomTable_01', 2.3, 7.8);
  iput(pickExisting(['I_Sofa_02', 'I_Sofa_04']), 13.0, 9.0, Math.PI); DECO(0.6, 5.8); DECO(14.4, 5.8);
  iput('I_Clock_04', 14.85, 7.6, -Math.PI / 2, 1.8, false);
  if (door.kind === 'appart') {
    // mailboxes + stairs/lift corridor in the back
    for (let k = 0; k < 4; k++) if (proto.PostBox_2_A) iput('PostBox_2_A', 0.4, 6.4 + k * 0.7, Math.PI / 2, 0, true, 0.8);
    iput('I_Picture_04', 0.15, 8.4, Math.PI / 2, 1.5, false); roomLabel('Escalier', 11.25);
    for (const x of [1.5, 3.5]) iput('I_Library', x, 0.25, 0);
    R.lift = new THREE.Vector3(R.ox + 11.2, 0, R.oz + 2.4);
    roomNPC(3.0, 7.8, 'LookingAround-loop', 0.4);
  } else {
    // hospital: waiting chairs in the hall, beds in the back rooms
    const ch = pickExisting(['G_Chair_10', 'G_Chair_11', 'I_OfficeChair_01']);
    for (let k = 0; k < 5; k++) iput(ch, 4.4 + k * 0.8, 9.3, Math.PI);
    for (const [x, z] of [[1.6, 1.4], [4.0, 1.4], [9.6, 1.4], [12.0, 1.4]]) { iput(pickExisting(['I_Bed1_01', 'I_Bed1_03']), x, z); iput('I_Bed_Table_01', x + 1.2, z - 0.8); }
    roomNPC(4.0, 2.8, 'Idle_B-loop', 0); roomNPC(12.0, 2.8, 'Idle_B-loop', 0); roomNPC(5.2, 8.6, 'Idle_A-loop', Math.PI);
    roomLabel('Urgences', 3.75); roomLabel('Service de soins', 11.25);
    R.lift = null;
  }
}
function lobbyAction() {
  const r = inside.room, d = inside.door, near = (v, m) => v && Math.hypot(v.x - player.pos.x, v.z - player.pos.z) < m;
  if (near(r.counter, 2.2)) {
    if (d.kind === 'hopital') { hospitalMenu(); return true; }
    lobbyUnitsMenu(d.of);
    return true;
  }
  if (r.lift && near(r.lift, 1.8)) {
    const mine = unitsOf(d.of).filter(u => isRes(u.id));
    if (!mine.length) { banner('🔒 Escalier réservé aux résidents (accueil pour acheter, louer ou visiter)', 1800); return true; }
    if (mine.length === 1) goUnit(mine[0]); else openMenu('⬆️ Escalier', mine.map(u => ({ t: 'Appartement ' + u.label + ' (' + MODE_LABEL[propOf(u.id).mode] + ')', fn: () => goUnit(u), keep: false })));
    return true;
  }
  return false;
}
function lobbyPrompt() {
  const r = inside.room, near = (v, m) => v && Math.hypot(v.x - player.pos.x, v.z - player.pos.z) < m;
  if (near(r.counter, 2.2)) return inside.door.kind === 'hopital' ? 'E : accueil des urgences' : 'E : accueil (acheter, louer, visiter, mes appartements)';
  if (r.lift && near(r.lift, 1.8)) return unitsOf(inside.door.of).some(u => isRes(u.id)) ? 'E : monter à mon appartement' : 'Escalier — réservé aux résidents';
  return '';
}
function hospitalMenu() {
  openMenu('🏥 Hôpital — accueil', [
    { t: '🩺 Se faire soigner (60 $)', fn: () => { if (payMoney(60)) { L.needs.sante = 100; L.sick = false; banner('Soigné', 1200); } }, keep: false },
    { t: J.job === 'ambulancier' ? 'Quitter le métier d’ambulancier' : '🚑 Devenir ambulancier', fn: () => { clearTask(); J.job = J.job === 'ambulancier' ? null : 'ambulancier'; J.cooldown = 1; updateJobHud(); banner(J.job ? '🚑 Tu es ambulancier' : 'Métier quitté', 1500); }, keep: false },
    { t: '💊 Acheter un médicament (20 $)', fn: () => { if (payMoney(20)) give('medicament'); } },
  ]);
}

// ================================================================ PHONE (Smart Phone Asset by PogoNR + Free Icon Pack)
const PH = { open: false, app: null, stack: [], notifs: [], battery: 100, q: '' };
const APPS = [
  { id: 'carte', n: 'Carte', ic: 'Location_Pin' }, { id: 'taxi', n: 'Taxi', ic: 'Star' }, { id: 'urgences', n: 'Urgences', ic: 'Heart' },
  { id: 'reparateur', n: 'Réparateur', ic: 'Hammer' }, { id: 'livraison', n: 'Livraison', ic: 'Pizza' }, { id: 'banque', n: 'Banque', ic: 'Credit_Card' },
  { id: 'meteo', n: 'Météo', ic: 'Cloud' }, { id: 'missions', n: 'Missions', ic: 'Scroll' }, { id: 'parking', n: 'Parking', ic: 'Cash' },
  { id: 'logement', n: 'Logement', ic: 'Blue_House' }, { id: 'fournisseurs', n: 'Fournisseurs', ic: 'Box' }, { id: 'internet', n: 'Internet', ic: 'Planet' },
];
const $ = (id) => document.getElementById(id);
function phoneNotify(app, text) {
  const hh = String(Math.floor(GT.min / 60)).padStart(2, '0') + ':' + String(Math.floor(GT.min % 60)).padStart(2, '0');
  PH.notifs.unshift({ app, text, hh }); PH.notifs.length = Math.min(PH.notifs.length, 20);
  const b = $('phBadge'); if (b) { b.textContent = PH.notifs.length; b.style.display = 'block'; }
  if (PH.open && !PH.app) phoneRender();
}
function togglePhone(v = !PH.open) {
  PH.open = v; $('phone').classList.toggle('on', v); document.body.classList.toggle('phon', v);
  if (v) { keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); $('phBadge').style.display = 'none'; phoneRender(); }
}
function phoneGo(app) { PH.stack.push(PH.app); PH.app = app; phoneRender(); }
function phoneBack() { if (PH.app) { PH.app = PH.stack.pop() || null; phoneRender(); } else togglePhone(false); }
function phoneHome() { PH.app = null; PH.stack = []; phoneRender(); }
function pel(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function prow(label, fn, dis) { const b = pel('button', 'pr', label); if (dis) b.disabled = true; b.onclick = () => { fn(); phoneRender(); }; return b; }
function gpsSet(x, z, label) { L.gps = new THREE.Vector3(x, 0, z); L.gpsLabel = label; phoneNotify('📍 GPS', 'Itinéraire vers ' + label); }
const pdist = (x, z) => Math.hypot(x - player.pos.x, z - player.pos.z);
function travelTo(x, z, label, price) {
  if (player.inCar || inside) { banner(inside ? 'Sors du bâtiment d’abord' : 'Descends de voiture d’abord', 1400); return false; }
  if (!payMoney(price)) return false;
  togglePhone(false);
  const f = $('fade'); f.style.display = 'flex'; f.textContent = '🚕 Trajet vers ' + label + '…';
  setTimeout(() => { const v = new THREE.Vector3(x, SW, z); collide(v, 0.6); player.pos.set(v.x, groundY(v.x, v.z), v.z); GT.min += Math.min(60, Math.round(Math.hypot(x, z) / 40) + 5); f.style.display = 'none'; banner('Arrivé : ' + label, 1400); phoneNotify('🚕 Taxi', 'Arrivé : ' + label); }, 1500);
  return true;
}
function destinations() {
  const r = [];
  if (L.home !== null) { const h = doors[L.home]; r.push(['🏠 Mon logement', h.x + h.out[0] * 2, h.z + h.out[1] * 2]); }
  const hs = nearestSpot('hospital'); if (hs) r.push(['🏥 Hôpital', hs.pos.x, hs.pos.z + 2]);
  for (const [k, s] of Object.entries(SERVICES)) { const d = doors.filter(x => x.service === k).sort((a, b) => pdist(a.x, a.z) - pdist(b.x, b.z))[0]; if (d) r.push([s.label, d.x + d.out[0] * 2, d.z + d.out[1] * 2]); }
  for (const s of jobSpots) if (s.def && s.def.label && !r.some(e => e[0] === s.def.label)) r.push([s.def.label, s.pos.x, s.pos.z]);
  return r;
}
const RESTO_MENU = ['plat', 'pates_bolo', 'sandwich', 'salade_comp', 'soupe', 'dessert', 'smoothie', 'biere'];
const APP = {
  carte(s) { const c = pel('canvas', 'pmap'); c.width = 240; c.height = 240; s.append(c); PH.mapCanvas = c; drawPhoneMap();
    const box = pel('div', 'pgps'); s.append(box); PH.gpsBox = box; drawPhoneGps();
    if (L.gps) s.append(prow('Effacer l’itinéraire', () => { L.gps = null; }));
    const mt = navTarget(); if (mt) s.append(prow('🎯 Suivre la mission : ' + mt.label, () => { L.gps = null; }));
    s.append(prow('🔎 Choisir une destination (Internet)', () => { phoneGo('internet'); })); },
  taxi(s) {
    s.append(pel('p', 'pt', 'Un taxi t’emmène où tu veux. 2 $ + 1 $ / 50 m.'));
    for (const [n, x, z] of destinations()) { const p = 2 + Math.round(pdist(x, z) / 50); s.append(prow(n + ' · ' + p + ' $', () => travelTo(x, z, n, p))); }
  },
  urgences(s) {
    s.append(pel('p', 'pt', 'Santé : ' + Math.round(L.needs.sante ?? 100) + ' %' + (L.sick ? ' · malade' : '')));
    s.append(prow('🚑 Appeler une ambulance (80 $, soins compris)', () => { const h = nearestSpot('hospital'); if (!h) return; if (M.money + L.bank < 80) { banner('Pas assez d’argent', 1200); return; } if (travelTo(h.pos.x, h.pos.z + 2, 'Hôpital', 80)) setTimeout(() => { L.needs.sante = 100; L.sick = false; phoneNotify('🏥 Hôpital', 'Tu as été soigné'); }, 1600); }));
    s.append(prow('🚓 Police — payer mes amendes (' + L.fines + ' $)', () => { if (L.fines && payMoney(L.fines)) { L.fines = 0; phoneNotify('🚓 Police', 'Amendes réglées'); } }, !L.fines));
    s.append(prow('🚒 Caserne — GPS', () => { const f = nearestSpot('fire'); if (f) gpsSet(f.pos.x, f.pos.z, 'Caserne'); }));
  },
  reparateur(s) {
    const mine = L.owned || []; if (!mine.length) s.append(pel('p', 'pt', 'Tu n’as pas de voiture (concession auto).'));
    for (const c of mine) { const dmg = 100 - Math.round(c.hp ?? 100), p = repairPrice(Math.ceil(dmg * 1.5) + 15);
      s.append(pel('p', 'pt', '🚗 ' + (c.name || 'Voiture') + ' — état ' + (100 - dmg) + ' % · essence ' + Math.round(c.fuel ?? 100) + ' %'));
      s.append(prow('🔧 Dépanneuse : réparation sur place (' + p + ' $)', () => { if (payMoney(p)) { c.hp = 100; phoneNotify('🔧 Réparateur', (c.name || 'Voiture') + ' réparée'); } }, dmg <= 0));
      s.append(prow('⛽ Livraison d’essence (' + (10 + Math.ceil((100 - (c.fuel ?? 100)) / 5) * 2) + ' $)', () => { if (payMoney(10 + Math.ceil((100 - (c.fuel ?? 100)) / 5) * 2)) { c.fuel = 100; phoneNotify('⛽', 'Plein livré'); } }, (c.fuel ?? 100) >= 99)); }
    const g = jobSpots.filter(x => x.kind === 'garage').sort((a, b) => pdist(a.pos.x, a.pos.z) - pdist(b.pos.x, b.pos.z))[0];
    if (g) s.append(prow('📍 GPS vers le garage le plus proche', () => gpsSet(g.pos.x, g.pos.z, 'Garage')));
  },
  livraison(s) {
    if (L.home === null) { s.append(pel('p', 'pt', 'Livraison à domicile : il te faut un logement.')); return; }
    if (PH.order) { s.append(pel('p', 'pt', '🛵 Commande en route : ' + Math.ceil(PH.order.t) + ' s')); return; }
    const restos = doors.filter(d => d.type === 'resto' || d.service === 'cafe').sort((a, b) => pdist(a.x, a.z) - pdist(b.x, b.z)).slice(0, 5);
    if (!PH.resto) { s.append(pel('p', 'pt', 'Restaurants à proximité')); restos.forEach((d, i) => s.append(prow((d.service ? '☕ Café n°' : '🍕 Restaurant n°') + (d.id) + ' — ' + Math.round(pdist(d.x, d.z)) + ' m', () => { PH.resto = d; }))); return; }
    s.append(pel('p', 'pt', 'Menu · livraison 4 $')); s.append(prow('← autres restaurants', () => { PH.resto = null; }));
    for (const id of RESTO_MENU) if (ITEMS[id]) s.append(prow(ITEMS[id].n + ' — ' + (ITEMS[id].p + 4) + ' $', () => { if (payMoney(ITEMS[id].p + 4)) { PH.order = { id, t: 25 }; PH.resto = null; phoneNotify('🛵 Livraison', ITEMS[id].n + ' commandé, livraison dans 25 s'); } }));
  },
  banque(s) {
    s.append(pel('p', 'pt', '💵 Liquide : ' + M.money + ' $\n🏦 Compte : ' + L.bank + ' $\n🚓 Amendes : ' + L.fines + ' $' + (L.loan ? '\n💳 Prêt restant : ' + L.loan + ' $' : '') + (L.ins ? '\n🛡️ ' + INSURANCE[L.ins].n : '') + (L.util ? '\n⚡ Pack énergie/eau actif' : '')));
    for (const n of [20, 100]) { s.append(prow('Déposer ' + n + ' $', () => { if (M.money >= n) { M.money -= n; L.bank += n; } }, M.money < n)); s.append(prow('Retirer ' + n + ' $', () => { if (L.bank >= n) { L.bank -= n; M.money += n; } }, L.bank < n)); }
    s.append(prow('Payer mes amendes', () => { if (payMoney(L.fines)) L.fines = 0; }, !L.fines));
  },
  meteo(s) {
    const h = GT.min / 60, ph = h < 5 || h >= 21 ? '🌙 Nuit' : h < 7.5 ? '🌅 Aube' : h < 18.5 ? '☀️ Jour' : '🌇 Coucher de soleil';
    s.append(pel('p', 'pbig', String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.floor(GT.min % 60)).padStart(2, '0')));
    s.append(pel('p', 'pt', 'Jour ' + GT.day + ' · ' + ph + '\nLever ~6 h · coucher ~20 h\n1 h réelle = 1 journée'));
    s.append(pel('p', 'pt dim', 'Pas de pluie ni de nuages dans le jeu pour l’instant : aucun asset météo dans tes packs.'));
  },
  missions(s) {
    const m = $('mission'); s.append(pel('p', 'pt', m && m.textContent ? m.textContent : 'Aucune mission active.'));
    if (J.job) s.append(pel('p', 'pt', JOBS[J.job].icon + ' Métier : ' + JOBS[J.job].label + (J.task ? '\n' + (J.task.goal || '') : '')));
    if (L.interim) { s.append(pel('p', 'pt', '👔 Offres d’intérim')); for (const r of offerRows()) s.append(r.sep ? pel('p', 'pt dim', r.sep) : prow(r.t, r.fn)); }
    for (const g of M.givers) s.append(prow('📍 ' + g.t.title + ' — ' + Math.round(pdist(g.p.x, g.p.z)) + ' m', () => gpsSet(g.p.x, g.p.z, g.t.title)));
  },
  parking(s) {
    const st = L.street;
    if (!st) s.append(pel('p', 'pt', 'Aucune voiture garée en zone payante.\nZone payante = centre-ville (bleu sur la carte), ' + PAID.price + ' $ / h.\nParkings à barrière : ' + LOT_PRICE + ' $ à l’entrée.'));
    else { const left = Math.max(0, st.paidUntil - gameNow()); s.append(pel('p', 'pt', '🚗 Garée en zone payante\n' + (left > 0 ? 'Ticket valable encore ' + Math.round(left) + ' min (jeu)' : st.fined ? 'Amende reçue — paie un ticket' : 'Sans ticket !')));
      for (const hh of [1, 3, 6]) s.append(prow('Payer ' + hh + ' h — ' + PAID.price * hh + ' $', () => payStreet(hh))); }
    const lot = lotsParking.slice().sort((a, b) => pdist(a.x, a.z) - pdist(b.x, b.z))[0];
    if (lot) s.append(prow('📍 GPS vers le parking le plus proche', () => gpsSet(lot.x, lot.z, 'Parking')));
  },
  logement(s) {
    if (!L.props.length) s.append(pel('p', 'pt', 'Aucun bien. Va à l’accueil d’un immeuble (acheter, louer, visiter) ou à l’agence immobilière.'));
    for (const p of L.props) { const u = doors[p.uid];
      s.append(pel('p', 'pt', '🏠 ' + u.label + ' — ' + (p.own ? 'à toi' : 'loué') + ' · ' + MODE_LABEL[p.mode] + (p.furnished ? ' · meublé' : ' · vide') + (p.mode === 'invest' ? (p.tenant > 0 ? '\nRecherche de locataire…' : '\nRevenu : ' + unitRent(u, p.furnished) + ' $ / 5 min') : !p.own ? '\nLoyer : ' + unitRent(u, p.furnished) + ' $ dans ' + Math.ceil(p.due) + ' s' : '')));
      s.append(prow('📍 GPS', () => gpsSet(u.x, u.z, 'Appartement ' + u.label)));
      if (p.mode !== 'principal') s.append(prow('🏠 Résidence principale', () => setMode(p, 'principal')));
      if (p.own && p.mode !== 'invest') s.append(prow('📈 Mettre en investissement', () => setMode(p, 'invest')));
      if (p.mode === 'invest') s.append(prow('🏡 Reprendre comme résidence secondaire', () => setMode(p, 'secondaire'), residences().length >= 2)); }
    const a = doors.filter(d => d.type === 'appart' && !d.unit).sort((x, y) => pdist(x.x, x.z) - pdist(y.x, y.z)).slice(0, 3);
    for (const d of a) s.append(prow('🏢 Immeuble à ' + Math.round(pdist(d.x, d.z)) + ' m — GPS', () => gpsSet(d.x, d.z, 'Immeuble')));
  },
  fournisseurs(s) { s.append(pel('p', 'pt', '🔒 S’activera avec le système d’entreprise (pas encore dans le jeu).')); },
  internet(s) {
    const bar = pel('input', 'psearch'); bar.placeholder = 'Rechercher dans Cartoon City…'; bar.value = PH.web || ''; s.append(bar);
    const out = pel('div'); s.append(out);
    const run = () => { PH.web = bar.value; out.innerHTML = ''; const q = bar.value.toLowerCase().trim(); if (!q) { out.append(pel('p', 'pt dim', 'Ex. : banque, pizza, hôpital, garage, métier, appartement')); return; }
      const res = destinations().filter(([n]) => n.toLowerCase().includes(q));
      if (/resto|pizza|manger|faim/.test(q)) res.push(...doors.filter(d => d.type === 'resto').slice(0, 3).map(d => ['🍕 Restaurant n°' + d.id, d.x, d.z]));
      if (/appart|logement|immeuble|louer/.test(q)) res.push(...doors.filter(d => d.type === 'appart').sort((a, b) => pdist(a.x, a.z) - pdist(b.x, b.z)).slice(0, 3).map(d => ['🏢 Immeuble (accueil)', d.x, d.z]));
      if (/m[ée]tier|job|travail|emploi/.test(q)) for (const [k, j] of Object.entries(JOBS)) { const sp = jobSpots.find(x => x.def.job === k); if (sp) res.push([j.icon + ' ' + j.label, sp.pos.x, sp.pos.z]); }
      if (!res.length) out.append(pel('p', 'pt dim', 'Aucun résultat'));
      for (const [n, x, z] of res.slice(0, 8)) { const b = pel('button', 'pr', n + ' · ' + Math.round(pdist(x, z)) + ' m'); b.onclick = () => { gpsSet(x, z, n); }; out.append(b); } };
    bar.oninput = run; bar.onkeydown = (e) => e.stopPropagation(); run(); setTimeout(() => bar.focus(), 50);
  },
};
function phoneRender() {
  const scr = $('phScreen'); if (!scr) return;
  const sb = $('phStatus'); const hh = String(Math.floor(GT.min / 60)).padStart(2, '0') + ':' + String(Math.floor(GT.min % 60)).padStart(2, '0');
  sb.innerHTML = ''; sb.append(pel('span', '', hh), pel('span', '', (PH.battery < 20 ? '🪫 ' : '🔋 ') + Math.round(PH.battery) + ' %'));
  const body = $('phBody'); body.innerHTML = ''; PH.mapCanvas = null; PH.gpsBox = null;
  if (!PH.app) {
    const q = pel('input', 'psearch'); q.placeholder = '🔎 Rechercher une appli'; q.value = PH.q; body.append(q);
    const grid = pel('div', 'pgrid'); body.append(grid);
    const fill = () => { grid.innerHTML = ''; for (const a of APPS.filter(a => a.n.toLowerCase().includes(PH.q.toLowerCase()))) { const b = pel('button', 'papp'); const im = pel('img'); im.src = 'ui/' + a.ic + '.png'; b.append(im, pel('span', '', a.n)); b.onclick = () => phoneGo(a.id); grid.append(b); } };
    q.oninput = () => { PH.q = q.value; fill(); }; q.onkeydown = (e) => e.stopPropagation(); fill();
    const nt = pel('div', 'pnot'); nt.append(pel('b', '', 'Notifications'));
    if (!PH.notifs.length) nt.append(pel('p', 'dim', 'Rien de nouveau'));
    for (const n of PH.notifs.slice(0, 5)) nt.append(pel('p', '', n.hh + ' · ' + n.app + ' — ' + n.text));
    body.append(nt);
  } else {
    const a = APPS.find(x => x.id === PH.app); const h = pel('div', 'phead'); const im = pel('img'); im.src = 'ui/' + a.ic + '.png'; h.append(im, pel('b', '', a.n)); body.append(h);
    APP[PH.app](body);
  }
}
function drawPhoneGps() {
  const b = PH.gpsBox; if (!b) return; const g = gpsInfo();
  b.innerHTML = g ? '<i style="transform:rotate(' + (-g.rel) + 'rad)">⬆</i><div><b></b><br>' + fmtD(g.d) + ' restants · ' + fmtT(g.sec) + '<br>Arrivée prévue ' + g.arr + (g.manual ? '' : ' · mission') + '</div>' : '<div>Aucune destination. Choisis-en une dans Internet, Taxi, Logement ou prends une mission.</div>';
  if (g) b.querySelector('b').textContent = g.label;
}
function drawPhoneMap() {
  const c = PH.mapCanvas; if (!c || !hud.mm) return; const g = c.getContext('2d'); g.drawImage(hud.mm, 0, 0, c.width, c.height);
}
let phTick = 0;
function updatePhone(dt) {
  PH.battery = Math.max(0, PH.battery - dt * (PH.open ? 0.12 : 0.02));
  if (inside && isRes(inside.door.id)) PH.battery = Math.min(100, PH.battery + dt * 2);
  if (PH.order) { PH.order.t -= dt; if (PH.order.t <= 0) { chest[PH.order.id] = (chest[PH.order.id] || 0) + 1; phoneNotify('🛵 Livraison', ITEMS[PH.order.id].n + ' livré chez toi (coffre)'); PH.order = null; } }
  updatePaid(); updateGates(dt); updateGpsStrip(); updateContracts(dt);
  if (J.task !== PH.lastTask) { PH.lastTask = J.task; if (J.task) phoneNotify(JOBS[J.job] ? JOBS[J.job].icon + ' ' + JOBS[J.job].label : '💼 Métier', J.task.goal || 'Nouvelle tâche'); }
  phTick += dt; if (PH.open && phTick > 0.5) { phTick = 0; if (PH.app === 'carte') { drawPhoneMap(); drawPhoneGps(); } else { const sb = $('phStatus'); if (sb && sb.firstChild) sb.firstChild.textContent = String(Math.floor(GT.min / 60)).padStart(2, '0') + ':' + String(Math.floor(GT.min % 60)).padStart(2, '0'); } }
}
function initPhone() {
  const p = $('phone'); if (!p) return;
  $('phBackBtn').onclick = phoneBack; $('phHomeBtn').onclick = phoneHome; $('phClose').onclick = () => togglePhone(false); $('phOpen').onclick = () => togglePhone(true);
  // the phone replaces the always-on map
  if (hud.mm) hud.mm.classList.add('hidden');
  addEventListener('keydown', (e) => { if (!game.on) return; if (e.code === 'KeyT' && !UI.open && document.activeElement.tagName !== 'INPUT') togglePhone(); else if (e.code === 'Escape' && PH.open) togglePhone(false); });
  phoneNotify('📱 Téléphone', 'Bienvenue à Cartoon City ! T pour ouvrir/fermer');
}

const clock = new THREE.Clock();
function updateShadowCam() {
  const d = Math.min(260, Math.max(60, camera.position.distanceTo(controls.target) * 1.1));
  const sc = sun.shadow.camera; sc.left = -d; sc.right = d; sc.top = d; sc.bottom = -d; sc.near = 1; sc.far = 900; sc.updateProjectionMatrix();
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).addScaledVector(SUN_DIR, 400);
}
function frame() {
  const dt = Math.min(0.05, clock.getDelta()); const t = clock.elapsedTime;
  updateSignals(dt);
  updateDayNight(dt);
  updateGame(dt);
  if (game.on) updatePhone(dt);
  if (!game.on || game.freeCam) controls.update();
  updateCars(dt); updatePeds(dt); updateSmoke(dt); updateFlyers(dt, t);
  for (const m of mixers) m.update(dt);
  updateRiders(); updateWheels(dt); updateActors(dt); if (game.on) updatePedLife(dt);
  updateShadowCam();
  if (useAO) composer.render(); else renderer.render(scene, camera);
}
function start() {
  setupPost();
  if (SHOT) {
    // advance simulation a little so cars/people are spread, then render once
    const step = () => { try { updateRiders(); } catch (e) {}  updateSignals(0.05); updateDayNight(0.05); updateGame(0.05); updatePhone(0.05); updateCars(0.05); updatePeds(0.05); updateSmoke(0.05); updateFlyers(0.05, 0); for (const m of mixers) m.update(0.05); };
    for (let i = 0; i < 40; i++) step();
    if (SHOT === 'play') {
      window.startGame(false);
      const auto = Q.get('auto') || 'walk';
      if (auto === 'drive') {
        const c = cars[0]; player.pos.set(c.obj.position.x + 2, RT, c.obj.position.z + 2); step(); toggleCar();
        keys.add('KeyW'); for (let i = 0; i < 70; i++) step(); keys.add('KeyD'); for (let i = 0; i < 12; i++) step(); keys.delete('KeyD');
      } else if (auto === 'redlight') {
        for (let i = 0; i < 120; i++) step();
        window.REDTEST = signals.length;
        const it = intersections.get('6,6'); camera.position.set(it.x + 26, 22, it.z + 26); controls.target.set(it.x, 0, it.z); setFreeCam(true); controls.update();
      } else if (auto === 'mission') {
        const g = M.givers[0]; player.pos.copy(g.p); step(); step();
        window.MSTATE = M.active && { type: M.active.type, goal: M.active.goal };
      } else if (auto === 'coins') {
        const g = M.givers[2]; player.pos.copy(g.p); step(); step();
        const c = M.active.coins[0]; player.pos.set(c.position.x, SW, c.position.z); step(); step();
        window.MSTATE = { money: M.money, left: M.active.coins.length };
      } else if (auto === 'treecam') {
        // stand on a park path with trees around, camera low
        player.pos.set(blockC(4), SW, blockC(9) + 8); cam.yaw = 0.3; cam.pitch = 0.25; cam.dist = 14; for (let i = 0; i < 6; i++) step();
      } else if (auto === 'bus') {
        // wait for a bus to stop at a stop, put player there, board, ride
        let st = null; for (let i = 0; i < 600 && !st; i++) { step(); const b = buses.find(b => b.atStop); if (b) st = b.atStop; }
        player.pos.copy(st.pos); step();
        const ok = busAction(); for (let i = 0; i < 60; i++) step();
        window.MSTATE = { boarded: ok && !!player.onBus, money: M.money, line: player.onBus && player.onBus.line, prompt: busPrompt() };
      } else if (auto === 'busstop') {
        const st = busStops.find(s => s.line === 1) ; const o = OUT[st.edge]; player.pos.set(st.pos.x - o[0] * 4, SW, st.pos.z - o[1] * 4); cam.yaw = Math.atan2(-o[0] + o[1] * 0.8, -o[1] - o[0] * 0.8); cam.dist = 10; cam.pitch = 0.3;
        for (let i = 0; i < 4; i++) step();
      } else if (auto === 'parking') {
        const sp = parkedSpots[0]; player.pos.set(sp.x + 2, SW, sp.z + 2); step(); toggleCar();
        window.MSTATE = { inCar: !!player.inCar, parked: parkedSpots.length };
        keys.add('KeyW'); for (let i = 0; i < 30; i++) step(); keys.clear();
      } else if (auto === 'lot') {
        const L = lotsParking[3]; setFreeCam(true); camera.position.set(L.x + 26, 30, L.z + 30); controls.target.set(L.x, 0, L.z); controls.update();
      } else if (auto === 'veh') {
        const names = (Q.get('v') || 'C_Fire_Truck,C_Ambulance,C_Police,C_Taxi,C_Pizza_Time,C_Thunderball,C_car3,Taxi_1').split(',').filter(n => proto[n]);
        const x0 = 2000, z0 = 0;
        const gnd = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x777777 })); gnd.position.set(x0, 0.4, z0); scene.add(gnd);
        names.forEach((n, i) => { const o = makeObject(n); o.position.set(x0 - 12 + i * 5, 0.64, z0); o.rotation.y = i * 0.8; scene.add(o); if (isTwo(o)) addRider({ obj: o }); });
        // arrow showing the direction of travel (-Z)
        const ar = new THREE.Mesh(new THREE.ConeGeometry(1, 3, 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff0000 })); ar.position.set(x0, 1, z0 - 9); scene.add(ar);
        window.MSTATE = names.map(n => n + ':' + proto[n].bb.getSize(new THREE.Vector3()).toArray().map(v => v.toFixed(1)).join('x'));
        setFreeCam(true); camera.position.set(x0 + 14, 14, z0 + 22); controls.target.set(x0, 1, z0 - 2); controls.update();
      } else if (auto === 'int') {
        const d = doors.find(d => d.type === (Q.get('t') || 'appart'));
        window.PENDING = (async () => { await enterDoor(d); const r = inside.room; player.pos.set(r.ox + r.w / 2, 0, r.oz + r.d - 2); cam.pitch = +(Q.get('p') || 0.95); cam.dist = +(Q.get('d') || 15); cam.yaw = 0; for (let i = 0; i < 8; i++) step(); window.MSTATE = { type: d.type, doors: doors.length, objs: r.group.children.length }; console.log('INT ' + JSON.stringify(window.MSTATE)); })();
      } else if (auto === 'door') {
        const d = doors[5]; player.pos.set(d.x + d.out[0] * 0.8, SW, d.z + d.out[1] * 0.8); cam.yaw = Math.atan2(d.out[0], d.out[1]); cam.pitch = 0.3; cam.dist = 7; for (let i = 0; i < 4; i++) step();
        window.MSTATE = { prompt: interiorPrompt(), doors: doors.length };
      } else if (auto === 'job') {
        const kind = Q.get('k') || 'fire';
        const s = jobSpots.find(s => s.kind === kind);
        player.pos.copy(s.pos); step(); const ok = jobAction(); J.cooldown = 0; for (let i = 0; i < 4; i++) step();
        if (kind === 'fire') { const tr = parkedPlayerCars.find(c => c.obj.userData.fire); player.pos.copy(tr.obj.position); player.pos.x += 2; step(); toggleCar(); const t = J.task; tr.obj.position.set(t.pos.x, RT + 0.24, t.pos.z); player.pos.copy(tr.obj.position); keys.add('KeyF'); for (let i = 0; i < 20; i++) step(); window.MSTATE = { job: J.job, hp: Math.round(J.task && J.task.hp), money: M.money }; cam.yaw = Math.atan2(t.door.out[0], t.door.out[1]) + 0.6; cam.dist = 16; cam.pitch = 0.45; step(); }
        else window.MSTATE = { ok, job: J.job, task: J.task && J.task.type, prompt: jobPrompt() };
      } else if (auto === 'farm') {
        const s = jobSpots.find(s => s.kind === 'farm'); player.pos.copy(s.pos); step(); jobAction();
        const pl = plots[0]; player.pos.set(pl.x + 2.9, 0, pl.z); step(); jobAction(); jobAction(); pl.t = 0; step(); step(); jobAction();
        window.MSTATE = { job: J.job, inv: J.inv, plots: plots.map(p => p.state) }; plots[1].state = 'mur'; setPlot(plots[1]); plots[2].state = 'pousse'; setPlot(plots[2]);
        cam.yaw = -0.6; cam.dist = 24; cam.pitch = 0.6; for (let i = 0; i < 3; i++) step();
      } else if (auto === 'quarry') {
        const s = jobSpots.find(s => s.kind === 'quarry') ; J.job = 'recolteur';
        const n = nodes.find(n => n.res === 'or') || nodes[0]; player.pos.set(n.pos.x + 2, 0, n.pos.z); keys.add('KeyE'); for (let i = 0; i < 60; i++) step(); keys.delete('KeyE');
        window.MSTATE = { inv: J.inv, nodes: nodes.length }; cam.dist = 30; cam.pitch = 0.6; for (let i = 0; i < 3; i++) step();
      } else if (auto === 'pump') {
        const p = pumpSpots[0]; const c = parkedPlayerCars.find(c => c.obj.userData.fire) || parkedPlayerCars[0]; c.obj.position.set(p.x, SW + 0.24, p.z); player.pos.copy(c.obj.position); player.pos.x += 2; step(); toggleCar(); player.inCar.fuel = 30; step();
        window.MSTATE = { prompt: lifePrompt() }; const ok = lifeAction(); window.MSTATE.fuel = player.inCar.fuel; window.MSTATE.ok = ok;
        for (let i = 0; i < 160; i++) step(); setFreeCam(true); camera.position.set(p.x + 22, 20, p.z + 26); controls.target.set(p.x, 0, p.z - 4); controls.update();
      } else if (auto === 'jobview') {
        const s = jobSpots.find(s => s.kind === (Q.get('k') || 'fire')) || (() => { const d = doors.find(d => d.service === 'station'); return { cx: d.x - 12, cz: d.z - 8 }; })(); setFreeCam(true); camera.position.set(s.cx + 30, 28, s.cz + 48); controls.target.set(s.cx, 2, s.cz + 4); controls.update();
      } else if (auto === 'bank') {
        const d = doors.find(d => d.service === (Q.get('k') || 'banque')); player.pos.set(d.x + d.out[0] * 0.8, SW, d.z + d.out[1] * 0.8); step(); M.money = 260; lifeAction(); step();
        window.MSTATE = { prompt: lifePrompt(), open: UI.open, services: doors.filter(d => d.service).length, benches: benches.length };
      } else if (auto === 'home') {
        const d = doors.find(d => d.type === 'appart' && !d.service); setHome(d, true); M.money = 900; d._viaLobby = true; L.util = true;
        window.PENDING = (async () => { await loadInteriorPack(); give('F:I_Sofa_05'); give('F:I_Flower_05'); give('pain'); give('fromage'); give('tomate'); L.needs.hygiene = 10; L.needs.faim = 30;
          await enterDoor(d); const r = inside.room; player.pos.set(r.ox + 6, 0, r.oz + 5); player.heading = 0; startPlace('F:I_Sofa_05'); step(); confirmPlace(); player.pos.set(r.ox + 9, 0, r.oz + 6); startPlace('F:I_Flower_05'); step(); confirmPlace();
          player.pos.copy(r.spots.bath); lifeAction(); player.pos.copy(r.spots.kitchen); lifeAction();
          window.MSTATE = { furn: L.furn.length, hyg: Math.round(L.needs.hygiene), menu: UI.open, prompt: lifePrompt() };
          player.pos.set(r.ox + r.w / 2, 0, r.oz + r.d - 2); cam.pitch = 0.95; cam.dist = 15; cam.yaw = 0; for (let i = 0; i < 6; i++) step(); console.log('LIFE ' + JSON.stringify(window.MSTATE)); })();
      } else if (auto === 'faint') {
        L.needs.sommeil = 0.01; for (let i = 0; i < 3; i++) step();
        window.PENDING = new Promise(r => setTimeout(() => { for (let i = 0; i < 4; i++) step(); window.MSTATE = { pos: player.pos.toArray().map(Math.round), sommeil: Math.round(L.needs.sommeil), sante: L.needs.sante }; console.log('LIFE ' + JSON.stringify(window.MSTATE)); r(); }, 2600));
      } else if (auto === 'svc') {
        const d = doors.find(d => d.service === (Q.get('k') || 'banque'));
        window.PENDING = (async () => { await enterDoor(d); const r = inside.room; player.pos.set(r.ox + 7.5, 0, r.oz + 8.5); player.heading = Math.PI; cam.pitch = 1.0; cam.dist = 17; cam.yaw = 0; for (let i = 0; i < 6; i++) step(); window.MSTATE = { prompt: lifePrompt(), objs: r.group.children.length }; console.log('INT ' + JSON.stringify(window.MSTATE)); })();
      } else if (auto === 'gate') {
        const lot = gates[0].lot; const c = parkedPlayerCars.find(c => !c.obj.userData.fire) || parkedPlayerCars[0];
        c.obj.position.set(lot.x - 30, SW + 0.24, lot.z - 10); c.obj.rotation.y = -Math.PI / 2; player.pos.copy(c.obj.position); player.pos.z += 2; step(); toggleCar(); M.money = 50;
        keys.add('KeyW'); for (let i = 0; i < 50; i++) step(); keys.clear(); const blockedX = +player.inCar.obj.position.x.toFixed(1);
        window.MSTATE = { gates: gates.length, blockedX, gateX: lot.x - 19.2, prompt: lifePrompt() }; player.inCar.speed = 0; const ok = lifeAction(); window.MSTATE.paid = ok; window.MSTATE.money = M.money;
        for (let i = 0; i < 30; i++) step(); keys.add('KeyW'); for (let i = 0; i < 40; i++) step(); keys.clear(); window.MSTATE.afterX = +player.inCar.obj.position.x.toFixed(1); player.inCar.speed = 0;
        setFreeCam(true); camera.position.set(lot.x - 34, 9, lot.z - 22); controls.target.set(lot.x - 19, 1, lot.z - 10); controls.update();
      } else if (auto === 'lobby') {
        const d = doors.find(d => d.type === 'appart' && !d.service); M.money = 900;
        window.PENDING = (async () => { player.pos.set(d.x + d.out[0] * 0.8, SW, d.z + d.out[1] * 0.8); step(); console.log('L1'); await enterDoor(d); console.log('L2 '+!!inside); const r = inside.room; const st = { type: inside.door.type };
          player.pos.copy(r.lift); st.liftPrompt = lifePrompt(); player.pos.set(r.counter.x, 0, r.counter.z); st.prompt = lifePrompt(); lifeAction(); st.menu = UI.open; closeMenu(); setHome(d, true); st.home = L.home === d.id;
          if (Q.get('up')) { player.pos.copy(r.lift); lifeAction(); await new Promise(res => setTimeout(res, 1500)); st.after = inside && inside.door.type; }
          else { player.pos.set(r.ox + 7.5, 0, r.oz + 8.5); player.heading = Math.PI; cam.pitch = 1.0; cam.dist = 17; cam.yaw = 0; }
          for (let i = 0; i < 4; i++) step(); window.MSTATE = st; console.log('LOBBY '+JSON.stringify(st)); })().catch(e => console.log('ERR ' + e.stack));
      } else if (auto === 'hosp') {
        window.PENDING = (async () => { const hd = hospitalDoor(); await enterDoor(hd); const r = inside.room; player.pos.set(r.counter.x, 0, r.counter.z); const st = { prompt: lifePrompt() }; player.pos.set(r.ox + 7.5, 0, r.oz + 8.5); player.heading = Math.PI; cam.pitch = 1.0; cam.dist = 17; cam.yaw = 0; for (let i = 0; i < 4; i++) step(); console.log('HOSP '+JSON.stringify(st)); })().catch(e => console.log('ERR ' + e.stack));
      } else if (auto === 'phone') {
        game.on = true; M.money = 120; togglePhone(true); const a = Q.get('app'); if (a) phoneGo(a); if (a === 'internet') { PH.web = 'banque'; phoneRender(); }
        window.MSTATE = { apps: document.querySelectorAll('.papp').length, rows: document.querySelectorAll('#phBody .pr').length };
      } else if (auto === 'wheels') {
        const all = [...new Set([...CARS, ...Object.keys(proto).filter(n => /^(veh_|C_|Bus|Taxi|Police|Ambulance|SportCar|PickUp|Van)/.test(n))])];
        const res = all.map(n => [n, proto[n].parts.filter(p => p.wheel).length]); console.log('WHEELS ' + JSON.stringify(res.filter(r => r[1] === 0).map(r => r[0])) + ' withWheels=' + res.filter(r => r[1] > 0).length + ' total=' + res.length);
      } else if (auto === 'carsizes') {
        console.log('SIZES ' + JSON.stringify(CARS.map(n => { const s = proto[n].bb.getSize(new THREE.Vector3()); return [n, +s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)]; }).filter(a => Math.min(a[1], a[3]) < 1.4)));
      } else if (auto === 'counter') {
        const k = Q.get('k') || 'concession'; const d = k === 'resto' ? doors.find(d => d.type === 'resto') : doors.find(d => d.service === k); M.money = 2000; L.permis = true; L.home = doors.find(d => d.type === 'appart').id;
        window.PENDING = (async () => { await enterDoor(d); const r = inside.room; const st = { ring: counterRings.length };
          if (Q.get('seat')) { player.pos.set(r.seats[0].x, 0, r.seats[0].z); st.prompt = lifePrompt(); lifeAction(); document.querySelectorAll('.qrow button')[1].click(); document.querySelectorAll('.qrow button')[1].click(); }
          else { player.pos.set(r.counter.x, 0, r.counter.z); st.prompt = lifePrompt(); lifeAction(); }
          st.open = UI.open; st.rows = document.querySelectorAll('#menu button').length; await new Promise(res => setTimeout(res, 300)); for (let i = 0; i < 3; i++) step(); console.log('CTR ' + JSON.stringify(st)); })().catch(e => console.log('ERR ' + e.stack));
      } else if (auto === 'terrace') {
        const d = doors.find(d => d.service === 'cafe'); setFreeCam(true); camera.position.set(d.x + d.out[0] * 9 + d.out[1] * 4, 4, d.z + d.out[1] * 9 + d.out[0] * 4); controls.target.set(d.x + d.out[0] * 2, 1, d.z + d.out[1] * 2); controls.update(); console.log('TERR ' + sitters.length);
      } else if (auto === 'tlight') {
        const s = signals[+(Q.get('n') || 0) * 3]; const inter = s.inter; setFreeCam(true); camera.position.set(inter.x + 9, 4.5, inter.z + 9); controls.target.set(inter.x, 3.4, inter.z); controls.update();
      } else if (auto === 'flat') {
        const d = Q.get('k') ? (Q.get('k') === 'resto' ? doors.find(d => d.type === 'resto') : doors.find(d => d.service === Q.get('k') || d.type === Q.get('k'))) : doors.filter(d => d.type === 'appart')[3]; d._viaLobby = true;
        window.PENDING = (async () => { await enterDoor(d); const r = inside.room; for (let i = 0; i < +(Q.get('n') || 40); i++) step(); setFreeCam(true); camera.position.set(r.ox + r.w / 2, r.d * 1.45, r.oz + r.d * 1.35); controls.target.set(r.ox + r.w / 2, 0, r.oz + r.d * 0.45); controls.update(); console.log('FLAT ' + actors.length + ' ' + actors.map(a => a.state + a.i).join(',')); })().catch(e => console.log('ERR ' + e.stack));
      } else if (auto === 'audit') {
        const isB = (n) => placed.some(p => p.nm === n);
        let ov = []; for (let a = 0; a < placed.length; a++) for (let b = a + 1; b < placed.length; b++) { const A = placed[a], B = placed[b]; const ix = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), iz = Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0); if (ix > 0.3 && iz > 0.3) ov.push([A.nm, B.nm, +ix.toFixed(1), +iz.toFixed(1)]); }
        const inside = []; for (const [n, x, y, z] of PUTLOG) { if (isB(n) || /Road|Sidewalk|Grass|Ground|Floor|Parking|Line|Cross/.test(n)) continue; const p = placed.find(p => x > p.x0 + 0.4 && x < p.x1 - 0.4 && z > p.z0 + 0.4 && z < p.z1 - 0.4); if (p) inside.push([n, p.nm, +y.toFixed(1)]); }
        const cnt = {}; for (const i of inside) cnt[i[0]] = (cnt[i[0]] || 0) + 1;
        console.log('AUDIT overlaps=' + ov.length + ' ' + JSON.stringify(ov.slice(0, 15)) + ' propsInBuildings=' + inside.length + ' ' + JSON.stringify(cnt));
      } else if (auto === 'tour') {
        const kinds = (Q.get('ks') || 'banque').split(',');
        const show = async (k) => {
          if (inside) exitInterior && exitInterior();
          const d = k === 'resto' ? doors.find(d => d.type === 'resto') : k === 'hopital' ? hospitalDoor() : k === 'lobby' ? lobbyFor(doors.find(d => d.type === 'appart')) : k === 'appart' ? Object.assign(doors.filter(d => d.type === 'appart')[5], { _viaLobby: true }) : doors.find(d => d.service === k || d.type === k);
          await enterDoor(d); const r = inside.room; setFreeCam(true); camera.position.set(r.ox + r.w / 2, r.d * 1.45, r.oz + r.d * 1.35); controls.target.set(r.ox + r.w / 2, 0, r.oz + r.d * 0.45); controls.update(); console.log('TOUR ' + k);
        };
        let qi = 0; window.PENDING = show(kinds[qi++]);
        const nx = () => { show(kinds[qi++]).then(() => { if (qi >= kinds.length) window.NEXT = null; setTimeout(() => { window.DONE = 1; }, 2500); }).catch(e => { console.log('ERR ' + e.stack); window.DONE = 1; }); };
        window.NEXT = qi < kinds.length ? nx : null;
      } else if (auto === 'chk') {
        const w = Q.get('w'), n = +(Q.get('n') || 0); setFreeCam(true); let P, T;
        if (w === 'terr') { const d = doors.filter(d => d.service === 'cafe' || d.type === 'resto')[n]; P = [d.x + d.out[0] * 6 + d.out[1] * 3, 2.6, d.z + d.out[1] * 6 + d.out[0] * 3]; T = [d.x + d.out[0] * 1.9, 0.8, d.z + d.out[1] * 1.9]; }
        if (w === 'sign') { const d = doors.filter(d => d.service)[n]; P = [d.x + d.out[0] * 12, 4, d.z + d.out[1] * 12]; T = [d.x, 3, d.z]; }
        if (w === 'gate') { const g = gates[n]; P = [g.x - 8, 4, g.z - 6]; T = [g.x, 1, g.z + 1.5]; }
        if (w === 'fence') { const l = gates[n * 8].lot; P = [l.x - 34, 7, l.z + 14]; T = [l.x - 20, 1, l.z]; }
        if (w === 'bench') { const b = benchSpots[n]; const p = peds.find(p => p.benched) ; const s = p ? p.o.position : b; P = [s.x + 3, 2.2, s.z + 3]; T = [s.x, 0.7, s.z]; }
        camera.position.set(...P); controls.target.set(...T); controls.update();
      } else if (auto === 'mall') {
        game.on = true; const out = {};
        const run = (g) => { player.pos.copy(g.p); step(); const a = M.active; if (!a) return 'no start';
          if (a.type === 'race') { player.pos.set(a.dest.x, a.dest.y, a.dest.z); step(); }
          if (a.type === 'coins') for (const c of a.coins.slice()) { player.pos.set(c.position.x, c.position.y - 1, c.position.z); step(); }
          if (a.type === 'taxi') { const c = parkedPlayerCars[0] || cars[0]; player.pos.copy(a.pick); c.obj.position.set(a.pick.x + 2, SW + 0.24, a.pick.z); player.pos.x += 3; step(); toggleCar(); player.inCar.speed = 0; player.inCar.obj.position.set(a.pick.x + 1, SW + 0.24, a.pick.z); step(); player.inCar.obj.position.set(a.dest.x + 1, SW + 0.24, a.dest.z); player.inCar.speed = 0; step(); step(); toggleCar(); }
          return M.active ? 'still active: ' + M.active.goal : 'done'; };
        for (const g of M.givers) { const m0 = M.money; const r = run(g); out[g.t.id + '_' + M.givers.indexOf(g)] = r + ' +' + (M.money - m0); for (let i = 0; i < 2; i++) step(); }
        // housing: rent in a lobby, rent charged, buy at the agency, sell
        const flat = doors.find(d => d.type === 'appart'); M.money = 2000; setHome(flat, true); out.rent = L.home === flat.id && L.homeRent; L.rentDue = 0.01; step(); out.rentCharged = M.money === 1960;
        const other = doors.filter(d => d.type === 'appart')[4]; if (payMoney(1500)) setHome(other, false); out.buy = L.home === other.id && !L.homeRent;
        console.log('MALL ' + JSON.stringify(out) + ' money=' + M.money + ' done=' + M.done);
      } else if (auto === 'plans2') {
        game.on = true; const out = {};
        window.PENDING = (async () => {
          const click = (re) => { const b = [...document.querySelectorAll('#menu button')].find(b => re.test(b.textContent)); if (b && !b.disabled) { b.click(); return true; } return false; };
          // dealership: catalogue -> choose -> confirm
          const cd = doors.find(d => d.service === 'concession'); M.money = 3000; L.permis = true; const n0 = L.owned.length;
          await enterDoor(cd); player.pos.copy(inside.room.counter); lifeAction(); out.dealerCards = document.querySelectorAll('.dcar').length;
          const btn = document.querySelectorAll('.dcar button')[1]; btn.click(); btn.click(); out.bought = L.owned.length - n0; out.carName = L.owned[L.owned.length - 1] && L.owned[L.owned.length - 1].name; out.moneyAfterCar = M.money; closeMenu(); exitInterior();
          // flat: rent at the lobby, resign, buy, sell, eviction
          const flat = doors.filter(d => d.type === 'appart')[2]; await enterDoor(flat); player.pos.copy(inside.room.counter); lifeAction(); out.rentClick = click(/Louer/); out.rented = L.home === flat.id && L.homeRent; closeMenu();
          lifeAction(); out.resignClick = click(/Résilier/); out.afterResign = L.home; closeMenu();
          M.money = 2000; lifeAction(); out.buyClick = click(/Acheter/); out.owner = L.home === flat.id && !L.homeRent; closeMenu();
          const m1 = M.money; lifeAction(); out.sellClick = click(/Vendre/); out.sold = L.home === null && M.money - m1 === 1000; closeMenu();
          setHome(flat, true); M.money = 0; L.bank = 0; L.rentDue = 0.01; step(); out.evicted = L.home === null;
          exitInterior();
          // company: work at the desk
          const bd = doors.find(d => d.service === 'bureaux'); M.money = 10; await enterDoor(bd); player.pos.copy(inside.room.counter); lifeAction(); out.workClick = click(/Travailler/); for (let i = 0; i < 440; i++) step(); out.paidWork = M.money - 10;
          console.log('PLANS2 ' + JSON.stringify(out));
        })().catch(e => console.log('ERR ' + e.stack));
      } else if (auto === 'place') {
        game.on = true; const out = {};
        window.PENDING = (async () => {
          await loadInteriorPack(); const d = doors.filter(x => x.type === 'appart')[6]; setHome(d, false); d._viaLobby = true; L.util = true;
          for (const id of ['F:I_Sofa_05', 'F:I_Flower_05', 'F:I_Lamp_02', 'F:I_Sofa_05']) give(id);
          await enterDoor(d); const r = inside.room; out.size = [r.w, r.d];
          const tryAt = (id, x, z) => { player.pos.set(r.ox + x, 0, r.oz + z); player.heading = 0; startPlace(id); step(); if (L.placing) L.placing.g.position.set(r.ox + x, 0, r.oz + z); const ok = confirmPlace(); if (L.placing) { scene.remove(L.placing.g); L.placing = null; } return !!ok; };
          out.freeSpot = tryAt('F:I_Flower_05', 7.0, 6.4);
          out.farCorner = tryAt('F:I_Lamp_02', 13.3, 6.0);
          out.inPartition = tryAt('F:I_Sofa_05', 5.0, 2.0);
          out.onDoor = tryAt('F:I_Sofa_05', 8.75, 11.8);
          out.onOther = tryAt('F:I_Sofa_05', 7.0, 6.4);
          out.furn = L.furn.length;
          player.pos.set(r.ox + 7.0, 0, r.oz + 6.4); pickFurniture(); out.afterPick = L.furn.length; out.backInInv = !!L.inv['F:I_Flower_05'];
          saveGame(true); const saved = JSON.parse(localStorage.getItem('cartooncity_save')); out.saved = (saved.furn || saved.L?.furn || []).length;
          exitInterior(); d._viaLobby = true; await enterDoor(d); out.afterReenter = inside.room.group.children.filter(o => L.furn.some(e => e.o === o)).length;
          setFreeCam(true); const r2 = inside.room; camera.position.set(r2.ox + r2.w / 2, r2.d * 1.45, r2.oz + r2.d * 1.35); controls.target.set(r2.ox + r2.w / 2, 0, r2.oz + r2.d * 0.45); controls.update();
          console.log('PLACE ' + JSON.stringify(out));
        })().catch(e => console.log('ERR ' + e.stack));
      } else if (auto === 'immo') {
        game.on = true; const out = {};
        window.PENDING = (async () => {
          await loadInteriorPack();
          const b = doors.filter(d => d.type === 'appart' && !d.unit)[3]; const us = unitsOf(b); us.forEach(u => u.npc = false); us[5].npc = true;
          M.money = 20000; L.bank = 0; out.furnValue = furnitureValue();
          const m0 = M.money; out.buyFurnished = acquire(us[0], true, true, 'principal'); out.paid1 = m0 - M.money; out.expected1 = us[0].base + furnitureValue();
          const m1 = M.money; out.rentEmpty2nd = acquire(us[1], false, false, 'secondaire'); out.paid2 = m1 - M.money; out.rentFurnished = unitRent(us[1], true); out.rentEmpty = unitRent(us[1], false);
          out.thirdResidenceRefused = !acquire(us[2], true, false, 'secondaire');
          out.investBuy = acquire(us[2], true, false, 'invest');
          out.occupiedRefused = !acquire(us[5], true, false, 'invest');
          out.rentedCantInvest = (setMode(propOf(us[1].id), 'invest'), propOf(us[1].id).mode === 'secondaire');
          await enterDoor(b); player.pos.copy(inside.room.counter); lifeAction(); out.lobbyRows = document.querySelectorAll('#menu button').length; closeMenu();
          await goUnit(us[2]); out.investLocked = inside.door.id !== us[2].id;
          const pI = propOf(us[2].id); pI.tenant = 0.01; step(); pI.due = 0.01; step(); out.investIncome = L.bank;
          const pR = propOf(us[1].id); const m2 = M.money; pR.due = 0.01; step(); out.rentPaid = m2 - M.money;
          await goUnit(us[3], true); out.visitInside = inside.door.id === us[3].id; out.visitNoHome = !homeRoom(); exitInterior();
          await goUnit(us[0]); out.homeInside = !!homeRoom(); give('F:I_Flower_05'); const r = inside.room; player.pos.set(r.ox + 7, 0, r.oz + 6.4); startPlace('F:I_Flower_05'); step(); L.placing.g.position.set(r.ox + 7, 0, r.oz + 6.4); out.placed = !!confirmPlace(); exitInterior();
          // empty vs furnished interior
          const n0 = (await buildInterior(us[1])).group.children.length, n1 = (await buildInterior(us[0])).group.children.length; out.emptyLess = n0 < n1; out.counts = [n0, n1];
          setMode(propOf(us[1].id), 'principal'); out.principalNow = L.home === us[1].id;
          saveGame(true); const before = L.props.length; L.props = []; loadGame(); out.reload = L.props.length === before && L.props.find(p => p.uid === us[0].id).furn.length === 1;
          const m3 = M.money; release(propOf(us[0].id), true); out.sold = M.money - m3; out.expectedSale = Math.round((us[0].base + furnitureValue()) * 0.8);
          const js = JSON.stringify(out); for (let i = 0; i < js.length; i += 250) console.log('IMMO' + i + ' ' + js.slice(i, i + 250));
        })().catch(e => console.log('ERR ' + e.stack));
      } else if (auto === 'view') {
        const bx = blockC(+Q.get('i')), bz = blockC(+Q.get('j')); const o = (Q.get('o') || '0,30,40').split(',').map(Number); const tg = (Q.get('t') || '0,0,0').split(',').map(Number);
        setFreeCam(true); camera.position.set(bx + o[0], o[1], bz + o[2]); controls.target.set(bx + tg[0], tg[1], bz + tg[2]); controls.update();
      } else if (auto === 'gps') {
        game.on = true; startMission(M.givers[+(Q.get('g') || 1)]); for (let i = 0; i < 3; i++) step(); const g1 = gpsInfo(); keys.add('KeyW'); cam.yaw = Math.atan2(-(g1.x - player.pos.x), -(g1.z - player.pos.z)); for (let i = 0; i < 40; i++) step(); keys.clear(); const g2 = gpsInfo();
        togglePhone(true); phoneGo('carte'); window.MSTATE = { label: g1.label, d1: Math.round(g1.d), d2: Math.round(g2.d), rel: +g2.rel.toFixed(2), arr: g2.arr, strip: document.getElementById('gpsStrip').style.display, box: PH.gpsBox && PH.gpsBox.textContent.slice(0, 80), notifs: PH.notifs.length };
      } else if (auto === 'paid') {
        const c = parkedPlayerCars[0]; c.obj.position.set(blockC(6) + 26, SW + 0.24, blockC(6)); player.pos.copy(c.obj.position); player.pos.x += 2; step(); toggleCar(); step(); toggleCar(); M.money = 50;
        const st = { street: !!L.street }; GT.min += 30; step(); st.fines = L.fines; payStreet(1); st.paid = L.street && L.street.paidUntil > gameNow(); window.MSTATE = st;
      } else if (auto === 'night') {
        setFreeCam(true); const it = intersections.get('4,9'); camera.position.set(it.x + 34, 22, it.z + 40); controls.target.set(it.x, 0, it.z); controls.update(); player.pos.set(it.x + 30, SW, it.z + 30);
        for (let i = 0; i < 12; i++) step();
      } else if (auto === 'wall') {
        keys.add('KeyW'); keys.add('ShiftLeft'); cam.yaw = Math.PI / 2; for (let i = 0; i < 160; i++) step();
      } else { keys.add('KeyW'); keys.add('ShiftLeft'); cam.yaw = 0.5; for (let i = 0; i < 30; i++) step(); }
      keys.clear(); if (auto !== 'drive') for (let i = 0; i < 2; i++) step();
      window.GAMESTATE = { m: window.MSTATE, pos: player.pos.toArray().map(v => +v.toFixed(2)), inCar: !!player.inCar, speed: player.inCar ? +player.inCar.speed.toFixed(1) : 0 };
      console.log('GAME ' + JSON.stringify(window.GAMESTATE));
    }
    controls.enabled = false;
    const wait = () => { if (!skyReady) return setTimeout(wait, 200); if (window.PENDING && !window.PENDING_DONE) { window.PENDING.then(() => { window.PENDING_DONE = 1; }); return setTimeout(wait, 300); } setTimeout(() => { updateShadowCam(); if (!game.on || game.freeCam) controls.update(); if (useAO) composer.render(); else renderer.render(scene, camera); window.DONE = 1; }, 1500); };
    wait();
    return;
  }
  renderer.setAnimationLoop(frame);
}
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer && composer.setSize(innerWidth, innerHeight);
});
window.setPreset = setPreset;
window.toggleAO = () => { useAO = !useAO; return useAO; };
main().catch(e => { console.error(e); say('Erreur : ' + e.message); });
