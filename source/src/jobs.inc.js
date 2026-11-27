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
      g.scene.traverse(o => { if (o.isMesh) { const mats = Array.isArray(o.material) ? o.material : [o.material]; if (mats.length === 1) parts.push({ geo: o.geometry, mat: sharedMat(mats[0]), mtx: o.matrixWorld.clone() }); else for (const grp of o.geometry.groups) { const geo = o.geometry.clone(); geo.clearGroups(); geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(grp.start, grp.start + grp.count), 1)); parts.push({ geo, mat: sharedMat(mats[grp.materialIndex]), mtx: o.matrixWorld.clone() }); } } });
      proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(g.scene) };
    } catch (e) { console.warn('job', name, e); }
  }));
}
const pickP = (re) => { const a = Object.keys(proto).filter(n => re.test(n)); return a.length ? a[Math.floor(rnd() * a.length)] : null; };

// ---- floating text signs
function textSprite(text, bg = '#1d2740', fg = '#ffffff', scale = 7) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, 504, 120, 28); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.stroke();
  g.fillStyle = fg; g.font = 'bold 60px system-ui, Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false }));
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
  hospital: { label: '🏥 Hôpital', model: 'Building_23_A', color: '#1e88e5', job: 'ambulancier', veh: ['Ambulance', 'Ambulance', 'Ambulance_2_A'] },
  taxi: { label: '🚕 Agence de taxis', model: 'Building_14_A', color: '#f9a825', job: 'taxi', veh: ['Taxi', 'Taxi_1', 'Taxi_2', 'Taxi_3'] },
  delivery: { label: '🚚 Dépôt de livraison', model: 'Building_Factory_2_A', color: '#6d4c41', job: 'livreur', veh: ['Van_1', 'PostCar_1', 'Van_3', 'PostCar_4'] },
  warehouse: { label: '📦 Entrepôt logistique', model: 'Building_Factory_1_A', color: '#5d4037', sell: true },
  garage: { label: '🔧 Garage & atelier', model: 'Building_1_1_A', color: '#455a64', garage: true },
};
const jobSpots = []; // { kind, pos, label, sprite, mk, building }
const J = { job: null, task: null, inv: {}, cooldown: 0, spray: 0, fires: [] };
const INV_MAX = 40;
const PRICES = { pierre: 4, bois: 5, cuivre: 10, fer: 12, argent: 18, or: 30, gemme: 50, legumes: 8 };

// ---- job building block (placed on a city block)
function blockJob(cx, cz, bi, bj, kind) {
  const def = JB[kind];
  blockBase(cx, cz, { interior: 'StreetTile_1_A_1' });
  const excl = busExcl(bi, bj);
  excl.S = (excl.S || []).concat([[-6, 6]]);
  driveway(cx, cz, 'S', 0, 10);
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
  if (fz1 - fz0 > 2) flat(40, fz1 - fz0, cx, SW + 0.015, (fz0 + fz1) / 2);
  const sp = textSprite(def.label, def.color); sp.position.set(cx, SW + Math.min(proto[nm].bb.max.y, 14) + 3, z0 + d + 0.5);
  // service vehicles parked in the forecourt
  if (def.veh) def.veh.forEach((v, i) => {
    const x = cx - 14 + i * 4.5, z = Math.min(fz1 - 3, fz0 + 3.5);
    const obj = v === 'FIRE' ? makeFireTruck() : (proto[v] ? makeObject(v) : null);
    if (!obj) return;
    obj.position.set(x, SW + 0.24, z); obj.rotation.y = Math.PI; scene.add(obj);
    parkedPlayerCars.push({ obj, speed: 0, kind: v === 'FIRE' ? 'fire' : v });
  });
  if (kind === 'warehouse') for (let k = 0; k < 10; k++) { const n = pickP(/^K_(Containers|Pallet|Parts|Fuel)/); if (n) put(n, cx + rr(6, 18), SW, cz + rr(fz0 - cz + 1, 18), rr(0, 6), 1.6); }
  if (kind === 'garage') { put('ForkLift', cx + 14, SW, cz + 14, 1); for (let k = 0; k < 6; k++) { const n = pickP(/^K_(Parts|Fuel)/); if (n) put(n, cx + rr(8, 18), SW, cz + rr(10, 18), rr(0, 6), 1.4); } }
  // interaction spot in front of the main door
  const pos = new THREE.Vector3(cx + 8, SW, Math.min(fz1 - 1.5, z0 + d + 2));
  const mk = makeMarker(def.job ? JOBS[def.job].color : (def.garage ? 0x90caf9 : 0xffb74d), 6); mk.position.copy(pos);
  jobSpots.push({ kind, def, pos, sprite: sp, mk, cx, cz });
}
function makeFireTruck() {
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
  const sp = textSprite('🌾 Ferme', '#558b2f'); sp.position.set(xc - 30, 9, zc - 30);
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
  const sp = textSprite('⛏️ Carrière & forêt', '#546e7a'); sp.position.set(xc - 60, 9, zc + 38);
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
function pay(n, why) { M.money += n; banner(why + ' +' + n + ' $', 2200); updateMissionHud(); }
function invCount() { return Object.values(J.inv).reduce((a, b) => a + b, 0); }

// ---- E key
function jobAction() {
  const car = player.inCar;
  // job spots (take / quit job, sell, garage)
  for (const s of jobSpots) {
    if (Math.hypot(s.pos.x - player.pos.x, s.pos.z - player.pos.z) > (car ? 6 : 2.6)) continue;
    if (s.def.sell) { sellAll(); return true; }
    if (s.kind === 'farm' && J.job === 'fermier' && J.inv.legumes) { sellAll(['legumes']); return true; }
    if (s.def.garage) { if (car) { car.speed = 0; banner('🔧 Véhicule réparé et lavé', 1600); } else buyCar(s); return true; }
    if (s.kind === 'delivery' && J.task && J.task.type === 'deliver' && J.task.stage === 'load') {
      J.task.stage = 'go'; J.task.mks = J.task.list.map(d => { const m = makeMarker(0x8d6e63, 20); m.position.set(d.x, SW, d.z); return m; });
      J.task.goal = 'Livre les colis : ' + J.task.list.length + ' restants'; banner('📦 4 colis chargés', 1500); return true;
    }
    if (car) continue;
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
    else if (pl.state === 'seme') { pl.state = 'pousse'; pl.t = 35; banner('💧 Arrosé · ça pousse…', 1500); }
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
function updateJobs(dt) {
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
      harvesting.p += dt / 2.5;
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
