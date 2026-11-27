// ================================================================ INTERIORS (enterable buildings)
const doors = [];          // { id, x, z, out:[ox,oz], type, built }
const INT_TYPES = {
  appart: { label: 'Appartement', color: 0x7ad3ff },
  resto: { label: 'Restaurant', color: 0xff8a3c },
  epicerie: { label: 'Épicerie', color: 0x6ee06e },
  jouets: { label: 'Jouets & Sport', color: 0xff5ad0 },
  entrepot: { label: 'Entrepôt', color: 0xc9a46a },
};
const INT_W = [['appart', 45], ['resto', 15], ['epicerie', 15], ['jouets', 13], ['entrepot', 12]];
function pickIntType(i) { let r = ((i * 2654435761) >>> 0) % 100; for (const [t, w] of INT_W) { if (r < w) return t; r -= w; } return 'appart'; }
// called during layout for each building that gets a street door
function registerDoor(x, z, ox, oz) {
  const id = doors.length;
  doors.push({ id, x, z, out: [ox, oz], type: pickIntType(id + 7), built: null });
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
    const idx = await (await fetch(BASE + 'iindex.json')).json();
    const buf = await (await fetch(BASE + 'ipack.bin')).arrayBuffer();
    const loader = new GLTFLoader();
    await Promise.all(Object.entries(idx).map(async ([name, [off, len]]) => {
      try {
        const g = await loader.parseAsync(buf.slice(off, off + len), '');
        g.scene.updateMatrixWorld(true);
        const parts = [];
        g.scene.traverse(o => { if (o.isMesh) { const mats = Array.isArray(o.material) ? o.material : [o.material]; if (mats.length === 1) parts.push({ geo: o.geometry, mat: sharedMat(mats[0]), mtx: o.matrixWorld.clone() }); else for (const grp of o.geometry.groups) { const geo = o.geometry.clone(); geo.clearGroups(); geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(grp.start, grp.start + grp.count), 1)); parts.push({ geo, mat: sharedMat(mats[grp.materialIndex]), mtx: o.matrixWorld.clone() }); } } });
        proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(g.scene) };
      } catch (e) { console.warn('int', name, e); }
    }));
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
        else for (const g of m.geometry.groups) { const geo = m.geometry.clone(); geo.clearGroups(); if (geo.index) geo.setIndex(new THREE.BufferAttribute(geo.index.array.slice(g.start, g.start + g.count), 1)); else for (const key in geo.attributes) { const at = geo.attributes[key]; geo.setAttribute(key, new THREE.BufferAttribute(at.array.slice(g.start * at.itemSize, (g.start + g.count) * at.itemSize), at.itemSize)); } parts.push({ geo, mat: ms[g.materialIndex], mtx: m.matrixWorld.clone() }); } });
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
}

// ---- the five interior layouts (all coordinates inside the room: x right, z toward the entrance)
const BOOKS = ['I_Book_01', 'I_Book_02', 'I_Book_03', 'I_Book_04', 'I_Candle_01', 'I_Clock_01', 'I_PhotoFrame', 'I_KubikRubik', 'I_NoteBook_01'];
const KITCHEN_OBJ = ['I_Kettle', 'I_Toaster', 'I_Microvawe', 'I_Pot_01', 'I_Pan_01', 'I_Plate_01', 'I_Cup_01', 'I_Bread', 'I_Apple', 'I_Banana', 'I_Orange'];
function buildAppart() {
  shell(5, 4, pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12']), pickExisting(['I_Wall_01', 'I_Wall_02', 'I_Wall_03', 'I_Wall_04', 'I_Wall_05']), 2);
  // living room (south-west)
  iput(pickExisting(['I_Catpet_01', 'I_Catpet_02', 'I_Catpet_03']), 2.6, 7.4, 0, 0.01, false);
  iput(pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_05', 'I_Sofa_07']), 2.6, 5.6, 0);
  iput('I_TV_Shelf', 2.6, 9.6, Math.PI, 0.45, false); iput('I_RoomTable_01', 2.6, 9.55, Math.PI); iput('I_TV', 2.6, 9.6, Math.PI, topOf('I_RoomTable_01'), false);
  iput('I_Lamp_01', 0.5, 5.3); iput('I_Library', 0.25, 7.6, Math.PI / 2); iputOn('I_Library', BOOKS, 0.25, 7.6, Math.PI / 2, 0);
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
  roomNPC(2.6, 6.6, 'Idle_B-loop', Math.PI); if (chance(0.6)) roomNPC(10.2, 4.2, 'LookingAround-loop', Math.PI);
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
    if (chance(0.6)) roomNPC(tx - 0.45, tz - 0.85, 'Idle_B-loop', 0);
  }
  iput('R_Sofa_2_A', 14.4, 6.8, -Math.PI / 2); iput('R_Gramophone', 14.5, 9.4, -Math.PI / 2);
  for (const vx of [1, 5, 9, 13]) iput(pickExisting(['R_Vines_1_1', 'R_Vines_3_1']), vx, 0.15, 0, 2.0, false);
  iput(pickExisting(['I_Flower_04', 'I_Flower_05']), 0.5, 9.5); iput(pickExisting(['I_Flower_06', 'I_Flower_07']), 14.5, 4.5);
}
function buildEpicerie(food) {
  shell(5, 4, pickExisting(['I_Floor_16', 'I_Floor_18', 'I_Floor_22']), pickExisting(['I_Wall_02', 'I_Wall_09', 'I_Wall_10']), 2);
  const shelves = food.filter(n => /^F_Shelf_/.test(n)), fridges = food.filter(n => /^F_Fridge_/.test(n)), tables = food.filter(n => /^F_Table_/.test(n));
  const goods = food.filter(n => !/^F_(Shelf|Fridge|Table|Kitchen|Cooker|Oven|Range|Restaurant|Waste|Wall|Ground|Faucet|Chair|Clock|Tree|Flower)/.test(n));
  // fridges along the east wall, shelves along the north wall
  for (let k = 0; k < 4 && fridges.length; k++) iput(fridges[k % fridges.length], 12.0, 1.4 + k * 1.15, -Math.PI / 2);
  for (let k = 0; k < 4 && shelves.length; k++) { const s = shelves[k % shelves.length]; iput(s, 1.4 + k * 2.3, 0.55, 0); iputOn(s, goods, 1.4 + k * 2.3, 0.55, 0, 6, 0.8); }
  // two aisles of display tables
  for (const tz of [3.6, 6.2]) for (const tx of [2.2, 5.2, 8.2]) { const t = tables.length ? tables[(tx + tz) % tables.length | 0] : 'R_StationTable_1_A'; iput(t, tx, tz, 0); iputOn(t, goods, tx, tz, 0, 7, 0.9); }
  // market crates near the entrance (KayKit)
  for (const [n, x, z] of [['K_Food_Crate_Large_Apples', 1.0, 8.6], ['K_Food_Basket_A_Berries', 2.2, 9.2], ['K_Food_Barrel_Fish', 3.2, 8.4], ['K_Food_Crate_Small_Berries', 0.9, 7.3], ['K_Food_Pile_Large', 10.0, 8.8]]) iput(n, x, z, rr(-0.3, 0.3));
  // cashier
  iput('R_StationTable_1_A', 10.5, 7.0, Math.PI / 2); iput('R_CoffeeMachine_1_A', 10.5, 7.0, Math.PI / 2, topOf('R_StationTable_1_A'), false);
  roomNPC(11.4, 7.0, 'Idle_A-loop', -Math.PI / 2); roomNPC(5.2, 4.9, 'LookingAround-loop', 0); if (chance(0.5)) roomNPC(8.2, 7.4, 'Idle_B-loop', Math.PI);
}
function buildJouets(toys) {
  shell(5, 4, pickExisting(['I_Floor_06', 'I_Floor_11', 'I_Floor_25']), pickExisting(['I_Wall_03', 'I_Wall_11', 'I_Wall_12']), 2);
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
  shell(6, 4, pickExisting(['I_Floor_19', 'I_Floor_23', 'I_Floor_27']), pickExisting(['I_Wall_13', 'I_Wall_14', 'I_Wall_02']), 3);
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
  const k = interiors.length;
  curRoom = { group: new THREE.Group(), cols: [], npcs: [], ox: 6000 + (k % 12) * 40, oz: 600 + Math.floor(k / 12) * 40 };
  scene.add(curRoom.group);
  const saved = seed; seed = 1000 + door.id * 7919;
  ({ appart: buildAppart, resto: buildResto, epicerie: () => buildEpicerie(extra), jouets: () => buildJouets(extra), entrepot: buildEntrepot })[door.type]();
  seed = saved;
  for (const c of curRoom.cols) addCol(...c, 0);
  const room = curRoom; curRoom = null;
  interiors.push(room); door.built = room;
  return room;
}
let entering = false;
async function enterDoor(door) {
  if (entering) return; entering = true;
  try {
    const room = door.built || await buildInterior(door);
    inside = { door, room };
    player.pos.copy(room.spawn); player.heading = Math.PI; cam.yaw = 0; cam.pitch = 0.75; cam.prevDist = cam.dist; cam.dist = 8;
    banner(INT_TYPES[door.type].label, 1400);
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
  if (inside) return inside.room.exit.distanceTo(player.pos) < 1.8 ? 'E : sortir' : INT_TYPES[inside.door.type].label;
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
