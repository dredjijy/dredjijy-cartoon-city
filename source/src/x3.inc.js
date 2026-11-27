// ================================================================ PACKS: Gas Station 24h Kit (GS_), KayKit RPG Tools (T_), Kay Lousberg crates (CR_), billboard (BB_)
const GS_NAMES = ['Canopy_Column_Round', 'Canopy_Fascia_Straight', 'Canopy_Light_Panel', 'Canopy_Roof_Corner', 'Canopy_Roof_Straight_4m', 'Wash_Tunnel_Entry', 'Wash_Tunnel_Mid_4m', 'Apron_Concrete_Slab_4m', 'Crash_Bollard_Yellow', 'Fire_Extinguisher_Post', 'Neon_Clock_Moon_Open', 'Neon_Drop_Large', 'Island_Curb_End', 'Island_Curb_Straight_4m', 'Payment_Terminal_Post', 'Pump_Modern_Double', 'Bay_Wall_Module', 'Pylon_Tall_Modern', 'Store24_Floor_Tile_4m', 'Store24_Roof_Flat_4m', 'Store24_Wall_Corner', 'Store24_Wall_Door_Auto', 'Store24_Wall_Plain', 'Store24_Wall_Window_Big', 'Coffee_Island_Self_Serve', 'Counter_Checkout_Station', 'Drink_Cooler_Wall_Doors', 'Ice_Bag_Freezer', 'Shelf_Snack_Wall_Station'];
const T_NAMES = ['anvil', 'axe', 'bucket_metal', 'chisel', 'file', 'grindstone', 'hammer', 'handdrill', 'handplane', 'knife', 'lantern', 'mallet', 'pickaxe', 'rope_bundle_A', 'rope_bundle_B', 'saw', 'scissors', 'shovel', 'tongs', 'trowel', 'wrench_A', 'wrench_B', 'screwdriver_A_long_color', 'screwdriver_B_long_color', 'nail', 'blueprint_stacked', 'journal_closed', 'map_rolled', 'torch'];
const CR_NAMES = ['crate_onions', 'crate_lettuce', 'crate_carrots', 'crate_tomatoes'];
function protoFrom(name, root, scale = 1, lift = 0) {
  const w = new THREE.Group(); w.add(root); w.scale.setScalar(scale); w.updateMatrixWorld(true);
  const bb0 = new THREE.Box3().setFromObject(w); if (lift !== null) { root.position.y -= bb0.min.y / scale; w.updateMatrixWorld(true); }
  const parts = []; w.traverse(o => { if (!o.isMesh) return; const ms = Array.isArray(o.material) ? o.material : [o.material]; parts.push({ geo: o.geometry, mat: sharedMat(ms[0]), mtx: o.matrixWorld.clone() }); });
  proto[name] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(w) };
}
async function loadX3() {
  const gl = new GLTFLoader();
  const job = [];
  for (const n of GS_NAMES) job.push(gl.loadAsync(BASE + 'x3/gas/' + n + '.glb').then(g => protoFrom('GS_' + n, g.scene, 1, null)).catch(() => console.warn('missing GS', n)));
  for (const n of T_NAMES) job.push(gl.loadAsync(BASE + 'x3/tools/' + n + '.gltf').then(g => protoFrom('T_' + n, g.scene, 1)).catch(() => console.warn('missing T', n)));
  const fl = new FBXLoader();
  for (const n of CR_NAMES) job.push(fl.loadAsync(BASE + 'x3/crates/' + n + '.fbx').then(o => { const b = new THREE.Box3().setFromObject(o), s = b.getSize(new THREE.Vector3()); protoFrom('CR_' + n, o, 0.6 / Math.max(s.x, s.z)); }).catch(() => console.warn('missing CR', n)));
  job.push(new MTLLoader().loadAsync(BASE + 'x3/bb/materials.mtl').then(m => { m.preload(); const ol = new OBJLoader(); ol.setMaterials(m); return ol.loadAsync(BASE + 'x3/bb/model.obj'); }).then(o => { const b = new THREE.Box3().setFromObject(o), s = b.getSize(new THREE.Vector3()); protoFrom('BB_billboard', o, 9 / Math.max(s.x, s.z)); }).catch(e => console.warn('missing billboard', e)));
  await Promise.all(job);
}
// ---- modular gas station (kit on its 4 m grid); the shop door keeps the existing interior
function buildGasStation(cx, cz) {
  const G = (n, x, z, r = 0, y = SW) => { if (proto['GS_' + n]) put('GS_' + n, x, y, z, r); };
  // forecourt slabs under the canopy
  for (let x = -8; x <= 8; x += 4) for (const z of [1, 5, 9, 13]) G('Apron_Concrete_Slab_4m', cx + x, cz + z, 0, SW + 0.17);
  // canopy 4 x 2 cells centred on the pumps
  const xs = [-6, -2, 2, 6], zs = [5, 9];
  for (const x of xs) for (const z of zs) { G('Canopy_Roof_Straight_4m', cx + x, cz + z); G('Canopy_Light_Panel', cx + x, cz + z); }
  for (const x of xs) { G('Canopy_Fascia_Straight', cx + x, cz + 9, 0); G('Canopy_Fascia_Straight', cx + x, cz + 5, Math.PI); }
  for (const z of zs) { G('Canopy_Fascia_Straight', cx + 6, cz + z, Math.PI / 2); G('Canopy_Fascia_Straight', cx - 6, cz + z, -Math.PI / 2); }
  for (const [x, z] of [[-7.5, 3.5], [7.5, 3.5], [-7.5, 10.5], [7.5, 10.5]]) { G('Canopy_Column_Round', cx + x, cz + z); addCol(cx + x - 0.4, cz + z - 0.4, cx + x + 0.4, cz + z + 0.4, 5); }
  // pump islands along the lanes (cars stop on the rings at x = ±4.5)
  for (const px of [-4.5, 4.5]) {
    const ix = cx + px + (px < 0 ? -1.6 : 1.6), iz = cz + 7;
    G('Island_Curb_Straight_4m', ix, iz, Math.PI / 2); G('Island_Curb_End', ix, iz - 2.6, Math.PI / 2); G('Island_Curb_End', ix, iz + 2.6, -Math.PI / 2);
    G('Pump_Modern_Double', ix, iz, Math.PI / 2, SW + 0.15); G('Payment_Terminal_Post', ix, iz + 1.6, Math.PI / 2, SW + 0.15);
    G('Crash_Bollard_Yellow', ix, iz - 3.6); G('Crash_Bollard_Yellow', ix, iz + 3.6);
    addCol(ix - 0.6, iz - 3.2, ix + 0.6, iz + 3.2, 1.2);
  }
  // 24h store (8 x 8 m) where the old shop stood: walls on the 2 m grid, front door to the forecourt
  const sx = cx + 9, sz = cz - 20, W = 8, D = 8;
  for (let x = 2; x < W; x += 4) for (let z = 2; z < D; z += 4) { G('Store24_Floor_Tile_4m', sx + x, sz + z, 0, SW + 0.17); G('Store24_Roof_Flat_4m', sx + x, sz + z); }
  for (let i = 0; i < 4; i++) {
    const x = sx + 1 + i * 2; G(i === 1 ? 'Store24_Wall_Door_Auto' : 'Store24_Wall_Window_Big', x, sz + D, 0); G('Store24_Wall_Plain', x, sz, Math.PI);
    const z = sz + 1 + i * 2; G('Store24_Wall_Plain', sx, z, -Math.PI / 2); G(i === 2 ? 'Store24_Wall_Window_Big' : 'Store24_Wall_Plain', sx + W, z, Math.PI / 2);
  }
  for (const [x, z] of [[0, 0], [W, 0], [0, D], [W, D]]) G('Store24_Wall_Corner', sx + x, sz + z);
  placed.push({ nm: 'GS_store', x0: sx, z0: sz, x1: sx + W, z1: sz + D }); addCol(sx, sz, sx + W, sz + D, 4.1);
  G('Neon_Clock_Moon_Open', sx + 5.6, sz + D + 0.25, 0, SW + 3.1); G('Neon_Drop_Large', sx + 1.2, sz + D + 0.25, 0, SW + 3.1);
  G('Fire_Extinguisher_Post', sx + W + 0.8, sz + D + 0.8); G('Crash_Bollard_Yellow', sx + 1, sz + D + 1.4); G('Crash_Bollard_Yellow', sx + 7, sz + D + 1.4);
  // pylon at the street corner, car wash tunnel and lube bay at the back of the lot
  G('Pylon_Tall_Modern', cx - 17, cz + 17, 0); addCol(cx - 18, cz + 16.6, cx - 16, cz + 17.4, 7);
  G('Wash_Tunnel_Entry', cx - 14, cz - 16, 0); G('Wash_Tunnel_Mid_4m', cx - 14, cz - 12, 0); placed.push({ nm: 'GS_wash', x0: cx - 16.2, z0: cz - 18, x1: cx - 11.8, z1: cz - 10 }); addCol(cx - 16.2, cz - 18, cx - 15.8, cz - 10, 4); addCol(cx - 12.2, cz - 18, cx - 11.8, cz - 10, 4);
  for (const x of [-6, -2]) G('Bay_Wall_Module', cx + x, cz - 19, 0); addCol(cx - 8, cz - 19.3, cx, cz - 18.7, 5);
  return { door: [sx + W / 2 - 2, sz + D + 0.7] };
}
