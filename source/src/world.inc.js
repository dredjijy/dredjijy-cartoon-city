// ================================================================ DAY / NIGHT (1 real hour = 1 game day)
const T = { min: 8 * 60, day: 1 };          // game minutes since midnight
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
  for (let i = 0; i < 6; i++) { const l = new THREE.PointLight(0xffc98a, 0, 16, 1.6); scene.add(l); lampLights.push(l); }
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
function hourStr() { const m = Math.floor(T.min) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function phase(h) { return h < 5 ? 'Nuit' : h < 7.5 ? 'Aube' : h < 18.5 ? 'Jour' : h < 21 ? 'Coucher de soleil' : 'Nuit'; }
let lampT = 0;
function updateDayNight(dt) {
  T.min += dt * 1440 / DAY_SEC; if (T.min >= 1440) { T.min -= 1440; T.day++; }
  const h = T.min / 60, k = lerpKey(h);
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
function serviceShell(floor) {
  curRoom.wallName = pickExisting(IW);
  shell(6, 4, floor || pickExisting(['I_Floor_10', 'I_Floor_14', 'I_Floor_20', 'I_Floor_05', 'I_Floor_12']), curRoom.wallName, 3);
  partition('x', 5, 0, 6, [1, 4]);
  partition('z', 7.5, 0, 2, []);
}
function buildService(kind) {
  const R = curRoom;
  if (kind === 'concession') {
    shell(6, 4, pickExisting(['I_Floor_12', 'I_Floor_20']), pickExisting(IW), 3); curRoom.wallName = 'I_Wall_02';
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
    OFFICE(3.7, 2.0); iput('I_Library', 0.3, 2.5, Math.PI / 2); iput('I_Library', 3.7, 0.2, 0); roomNPC(3.7, 2.8, 'Idle_B-loop', Math.PI);
    for (const [n, x, z] of [['K_Gold_Bars_Stack_Large', 9.3, 1.2], ['K_Money_Pile_Large', 11.5, 1.0], ['K_Money_Bills_Stack_Large', 13.6, 1.3], ['K_Gold_Bars_Stack_Medium', 13.8, 3.6], ['K_Money_Coins_Stack_Large', 9.4, 3.6], ['K_Gems_Chest', 11.6, 3.7]]) iput(n, x, z, rr(-0.3, 0.3), 0, true, 1.6);
  } else if (kind === 'pharmacie') {
    counter(7.5, 6.0, 2); roomNPC(7.5, 5.45, 'Idle_A-loop', 0);
    const goods = ['I_SoapBottle_01', 'I_SoapBottle_02', 'I_Toothbrush_01', 'I_GlassToothbrush_01', 'I_Towel_02', 'I_ToiletPaper', 'I_Candle_02', 'I_Bottle'];
    for (const z of [6.4, 8.2]) for (const x of [0.6, 14.4]) { iput('R_StandShelf_1_A', x, z, x < 7 ? Math.PI / 2 : -Math.PI / 2); iputOn('R_StandShelf_1_A', goods, x, z, Math.PI / 2, 5, 0.6, 1.4); }
    for (let k = 0; k < 8; k++) iput(pick(['K_Containers_Box_Medium', 'K_Containers_Box_Small', 'K_Containers_Box_Large']), rr(0.8, 6.6), rr(0.8, 4.2), rr(0, 6));
    iput(pickExisting(['I_Bed1_01', 'I_Bed1_03']), 12.0, 1.4); iput('I_OfficeChair_01', 9.4, 2.2); iput('I_Bed_Table_01', 13.9, 3.6); roomNPC(9.4, 3.0, 'Idle_B-loop', 0);
    DECO(4, 9.5); DECO(11, 9.5);
  } else if (kind === 'police') {
    counter(7.5, 6.0, 3); roomNPC(7.5, 5.45, 'Idle_A-loop', 0); hall.sofa();
    OFFICE(2.0, 2.0); OFFICE(5.4, 2.0); iput('I_Library', 0.3, 3.8, Math.PI / 2); roomNPC(2.0, 2.8, 'Idle_B-loop', Math.PI);
    // cell with bars
    for (const x of [9.3, 13.3]) iput('Fence_1_A_3', x - 0.0, 3.5, Math.PI / 2, 0, true); iput('Bench_1_A', 11.3, 0.7, Math.PI / 2); iput('I_Toilet_01', 14.3, 0.5, -Math.PI / 2); if (chance(0.7)) roomNPC(11.3, 1.6, 'Idle_A-loop', Math.PI);
  } else if (kind === 'mairie') {
    counter(7.5, 6.0, 3); roomNPC(7.5, 5.45, 'Idle_A-loop', 0); hall.sofa();
    iput(pickExisting(['I_OfficeTable_02']), 3.7, 2.4, 0); iput('I_OfficeChair_02', 3.7, 1.6, 0); iput('I_Library', 1.3, 0.25, 0); iput('I_Library', 6.1, 0.25, 0); iput(pickExisting(['I_Fireplace_02', 'I_Fireplace_01']), 0.3, 3.4, Math.PI / 2); iput('I_Catpet_04', 3.7, 3.2, 0, 0.01, false); roomNPC(3.7, 1.6, 'Idle_B-loop', 0);
    iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_03']), 11.25, 2.4); for (const [dx, dz, r] of [[-0.5, -0.85, 0], [0.5, -0.85, 0], [-0.5, 0.85, Math.PI], [0.5, 0.85, Math.PI]]) iput('I_KitchenChair_01', 11.25 + dx, 2.4 + dz, r);
    iput('I_Picture_06', 11.25, 0.15, 0, 1.4, false);
  } else if (kind === 'bureaux' || kind === 'emploi' || kind === 'immobilier') {
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
    const goods = ['R_Bread_1', 'R_CoffyCup_P', 'R_Donat', 'R_Cruassant', 'R_ChessBurger_Ready', 'R_Butter', 'R_Cheese_1', 'I_Cola', 'I_Chocolate', 'I_HotDog', 'I_Sandwich'];
    for (const x of [2.2, 4.6]) for (const z of [7.2, 9.0]) { iput('R_StationTable_1_A', x, z); iputOn('R_StationTable_1_A', goods, x, z, 0, 6, 0.4, 1.3); }
    for (const z of [6.6, 8.4]) iput('R_StandShelf_1_A', 14.4, z, -Math.PI / 2);
    for (let k = 0; k < 6; k++) iput(pick(['K_Fuel_A_Barrels', 'K_Fuel_A_Barrel', 'K_Fuel_A_Jerrycan', 'K_Fuel_B_Barrels']), rr(0.8, 6.5), rr(0.8, 4.2), rr(0, 6));
    iput('I_Toilet_01', 9.0, 0.5); iput('I_Toilet_02', 11.0, 0.5); iput('I_ShowerTable_01', 13.5, 0.4);
  } else { hall.sofa(); counter(7.5, 6.0, 2); }
}
