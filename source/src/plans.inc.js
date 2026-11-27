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
  H('overhead_light', 7.5, 3.6, 0, 0, true); roomNPC(10.0, 3.4, 'Idle_A-loop', Math.PI);
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
  labelAt('Cellules', 15, 0.3); for (const x of [13.2, 15.2, 17.2]) iput('Fence_1_A_3', x, 4.2, Math.PI / 2, 0, true); iput('Bench_1_A', 15, 0.7, 0); iput('I_Toilet_01', 17.0, 0.5, -Math.PI / 2); if (chance(0.7)) roomNPC(14.4, 1.6, 'Idle_A-loop', Math.PI);
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
  { x: 8.75, z: 7.55, face: Math.PI, sit: true }, { x: 7.5, z: 1.25, face: Math.PI, clip: 'Idle_B-loop' }, { x: 8.3, z: 3.5, face: 0, sit: true },
  { x: 15.2, z: 8.4, face: Math.PI, sit: true }, { x: 2.5, z: 3.7, face: Math.PI, clip: 'LookingAround-loop' }, { x: 14.6, z: 3.6, face: 0 }, { x: 2.5, z: 10.2, face: 0, clip: 'Idle_B-loop' },
];
function buildAppart() {
  curRoom.wallName = pickExisting(IW);
  shell(7, 5, pickExisting(['I_Floor_03', 'I_Floor_05', 'I_Floor_08', 'I_Floor_12']), curRoom.wallName, 3);
  partition('z', 5, 0, 5, [1, 3]); partition('x', 6.25, 0, 2, []); partition('z', 12.5, 0, 5, [1, 3]); partition('x', 5, 5, 7, []);
  // bedroom 1 (north-west)
  labelAt('Chambre', 2.5, 0.3); iput(pickExisting(['I_Bed2_01', 'I_Bed2_02', 'I_Bed1_01']), 2.5, 1.6, 0); iput('I_Bed_Table_01', 0.6, 0.4); iput('I_Lamp_03', 0.6, 0.4, 0, topOf('I_Bed_Table_01'), false); iput('I_Bed_Table_02', 4.4, 0.4);
  iput(pickExisting(['I_Catpet_04', 'I_Catpet_05']), 2.5, 4.3, 0, 0.01, false); PLANT('small', 4.4, 5.6);
  // bedroom 2 (south-west) with wardrobe
  iput(pickExisting(['I_Bed1_01', 'I_Bed1_02']), 1.4, 10.6, Math.PI / 2); iput(pickExisting(['I_RoomFurniture_01', 'I_RoomFurniture_02', 'I_RoomFurniture_03']), 4.6, 7.6, -Math.PI / 2); iput('I_Bed_Table_01', 0.5, 8.6); PLANT('medium', 4.4, 12.0);
  // kitchen + dining (north, centre)
  const tops = ['I_KitchenTabletop1_01', 'I_KitchenTabletop1_02', 'I_KitchenTabletop1_03', 'I_KitchenTabletop1_04'];
  let kx = 5.8; for (let i = 0; i < 5; i++) { const n = i === 2 ? 'I_Oven' : pickExisting(tops); iput(n, kx, 0.4, 0); if (i !== 2) iputOn(n, KITCHEN_OBJ, kx, 0.4, 0, 1, 0.2); kx += 1.14; } iput('I_RangeHood', 5.8 + 2 * 1.14, 0.25, 0, 1.75, false);
  if (proto.G_Fridge_2) iput('G_Fridge_2', 11.6, 0.5, 0);
  iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_02', 'I_KitchenTable_03']), 8.75, 4.3, 0);
  for (const [dx, dz, r] of [[-0.55, -0.85, 0], [0.55, -0.85, 0], [-0.55, 0.85, Math.PI], [0.55, 0.85, Math.PI]]) iput(pickExisting(['I_KitchenChair_01', 'I_KitchenChair_02']), 8.75 + dx, 4.3 + dz, r);
  iputOn('I_KitchenTable_01', ['I_Plate_01', 'I_Cup_02', 'I_Pizza_01', 'I_Watermelon_01'], 8.75, 4.3, 0, 3, 0.5);
  // living room (south, centre): sofa facing the TV
  iput(pickExisting(['I_Catpet_01', 'I_Catpet_02', 'I_Catpet_03']), 8.75, 9.4, 0, 0.01, false);
  iput(pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_05', 'I_Sofa_07']), 8.75, 7.2, Math.PI); iput('I_RoomTable_01', 8.75, 9.2);
  iput('I_TV_Shelf', 8.75, 11.9, Math.PI, 0.45, false); iput('I_RoomTable_01', 8.75, 11.85, Math.PI); iput('I_TV', 8.75, 11.9, Math.PI, topOf('I_RoomTable_01'), false);
  iput('I_Lamp_01', 5.6, 7.0); PLANT('large', 5.6, 11.8); PLANT('large', 11.9, 11.8); iput('I_Library', 12.2, 9.4, -Math.PI / 2); iputOn('I_Library', BOOKS, 12.2, 9.4, -Math.PI / 2, 0);
  // bathroom (north-east)
  labelAt('Salle de bain', 15, 0.3); iput('I_Bath', 16.4, 2.0, Math.PI / 2); iput(pickExisting(['I_Toilet_01', 'I_Toilet_02']), 13.3, 0.5, 0); iput('I_Washer_01', 13.2, 4.4, Math.PI / 2);
  iput(pickExisting(['I_ShowerCarpet_01', 'I_ShowerCarpet_02']), 15.2, 2.0, Math.PI / 2, 0.01, false); iput('I_Towel_01', 17.3, 4.0, -Math.PI / 2, 1.2, false);
  // bedroom 3 / office (south-east)
  iput('I_PC_Table', 15.2, 7.4, 0); iput('I_PC_Screen', 15.2, 7.3, 0, topOf('I_PC_Table'), false); iput('I_OfficeChair_01', 15.2, 8.2, Math.PI);
  iput(pickExisting(['I_Bed1_01', 'I_Bed1_03']), 16.4, 11.0, -Math.PI / 2); PLANT('small', 13.1, 12.0);
  roomActor(FLAT2_POINTS); if (chance(0.6)) roomActor(FLAT2_POINTS);
  curRoom.flat2 = true;
}
function flatSpots(room) {
  return { bed: new THREE.Vector3(room.ox + 2.5, 0, room.oz + 3.0), bath: new THREE.Vector3(room.ox + 15.0, 0, room.oz + 2.4), kitchen: new THREE.Vector3(room.ox + 8.0, 0, room.oz + 1.4), chest: new THREE.Vector3(room.ox + 11.8, 0, room.oz + 11.6) };
}
