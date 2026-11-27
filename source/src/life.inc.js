// ================================================================ LIFE: needs, items, money, housing, services
const L = {
  needs: { faim: 80, soif: 80, hygiene: 80, sommeil: 80, sante: 100 },
  sick: false, bank: 100, inv: {}, home: null, rentDue: 0, owned: [], fines: 0, permis: false, aide: 0,
  furn: [], carry: null, sitting: null, gps: null, gpsLabel: '', drops: [], placing: null, lastFine: '',
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
  if (it.heal) n.sante = Math.min(100, n.sante + it.heal); if (it.sleep) n.sommeil = Math.min(100, n.sommeil + it.sleep);
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
  concession: { label: '🚗 Concession auto', color: '#c62828', n: 2 }, station: { label: '⛽ Station-service', color: '#f9a825', n: 4 },
};
function assignServices() {
  const order = doors.map((d, i) => i).sort((a, b) => ((a * 7919) % 101) - ((b * 7919) % 101));
  let k = 0;
  for (const [kind, s] of Object.entries(SERVICES)) for (let c = 0; c < s.n; c++) {
    while (k < order.length && doors[order[k]].service) k++;
    const d = doors[order[k++]]; if (!d) break;
    d.service = kind; if (s.interior) d.type = s.interior;
  }
  for (const d of doors) {
    const s = d.service ? SERVICES[d.service] : null;
    if (s) { const sp = textSprite(s.label, s.color, 6); sp.position.set(d.x - d.out[0] * 0.6, SW + 4.4, d.z - d.out[1] * 0.6);
      if (d.service === 'station' && proto.K_Fuel_A_Barrels) put('K_Fuel_A_Barrels', d.x + d.out[0] * 1.2 + d.out[1] * 2.5, SW, d.z + d.out[1] * 1.2 + d.out[0] * 2.5, 0, 1.4);
      if (d.service === 'police') { const o = proto.PoliceCar ? makeObject('PoliceCar') : null; if (o) { o.position.set(d.x + d.out[0] * 2.9 + d.out[1] * 4, SW + 0.24, d.z + d.out[1] * 2.9 + d.out[0] * 4); o.rotation.y = Math.atan2(d.out[1], -d.out[0]); scene.add(o); parkedPlayerCars.push({ obj: o, speed: 0 }); } }
    } else {
      const sign = { resto: 'PizzaSign_1_A', epicerie: 'MarketSign_1_A', jouets: 'GymSign_1_A', appart: d.id % 4 === 0 ? 'HotelSign_3_A' : null }[d.type];
      if (sign && proto[sign]) put(sign, d.x - d.out[0] * 0.9, SW + 3.2, d.z - d.out[1] * 0.9, Math.atan2(d.out[0], d.out[1]) - Math.PI / 2, 0.8);
    }
  }
}
function serviceMenu(d) {
  const kind = d.service;
  const enterRow = SERVICES[kind].interior ? [{ t: '🚪 Entrer dans le magasin', fn: () => { closeMenu(); enterDoor(d); } }] : [];
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
    if (kind === 'supermarche') return openMenu(T, [...enterRow, { sep: 'Alimentation' }, ...buy(['pain', 'fromage', 'tomate', 'salade', 'oeuf', 'pates', 'viande', 'fruits', 'sucre', 'grains', 'legumes']), { sep: 'Boissons' }, ...buy(['eau', 'soda', 'lait', 'jus']), { sep: 'Produits' }, ...buy(['savon', 'jerrycan', 'arrosoir', 'pioche', 'cle'])]);
    if (kind === 'cafe') return openMenu(T, [...enterRow, ...buy(['cafe', 'croissant', 'biere', 'jus', 'sandwich', 'dessert']), { t: '🍽️ Consommer sur place : café + croissant — 6 $', fn: () => { if (payMoney(6)) { L.needs.soif = Math.min(100, L.needs.soif + 20); L.needs.faim = Math.min(100, L.needs.faim + 15); L.needs.sommeil = Math.min(100, L.needs.sommeil + 10); } } }]);
    if (kind === 'meubles') return openMenu(T, FURN.map(([m, n, p]) => ({ t: n + ' — ' + p + ' $', fn: async () => { if (!payMoney(p)) return; await loadInteriorPack(); give('F:' + m); banner('Acheté : ' + n + ' (inventaire → placer chez moi)', 1600); } })), L.home === null ? 'Il te faut un logement pour placer les meubles (agence immobilière).' : 'Les meubles vont dans l’inventaire (I), puis « placer chez moi ».');
    if (kind === 'emploi') {
      const r = Object.entries(JOBS).map(([k, j]) => { const s = jobSpots.find(s => s.def.job === k); return { t: j.icon + ' ' + j.label + (J.job === k ? ' (ton métier)' : '') + ' — GPS', fn: () => { if (s) { L.gps = s.pos.clone(); L.gpsLabel = j.label; banner('GPS : ' + j.label, 1200); } }, keep: false }; });
      r.push({ t: '💼 Employé de bureau — GPS vers des bureaux', fn: () => gpsTo('bureaux', 'Bureaux') }, { t: '🏭 Ouvrier d’usine — GPS', fn: () => { const s = jobSpots.find(s => s.kind === 'factory'); if (s) { L.gps = s.pos.clone(); L.gpsLabel = 'Usine'; } } }, { t: '📦 Manutention en entrepôt — GPS', fn: () => { const s = jobSpots.find(s => s.kind === 'warehouse'); if (s) { L.gps = s.pos.clone(); L.gpsLabel = 'Entrepôt'; } } });
      return openMenu(T, r, 'Choisis un métier : le GPS t’y emmène (cercle blanc sur la minicarte).');
    }
    if (kind === 'immobilier') {
      const apps = doors.filter(x => x.type === 'appart' && !x.service).map(x => ({ x, d: Math.hypot(x.x - player.pos.x, x.z - player.pos.z) })).sort((a, b) => a.d - b.d).slice(0, 5);
      const r = [{ sep: L.home !== null ? 'Ton logement : ' + (L.rentDue ? 'location' : 'propriétaire') : 'Tu n’as pas de logement' }];
      for (const { x, d } of apps) {
        r.push({ t: '🔑 Louer l’appartement à ' + Math.round(d) + ' m — 40 $ / 5 min', dis: L.home === x.id, fn: () => { if (payMoney(40)) setHome(x, true); } });
        r.push({ t: '🏠 Acheter l’appartement à ' + Math.round(d) + ' m — 1500 $', dis: L.home === x.id && !L.rentDue, fn: () => { if (payMoney(1500)) setHome(x, false); } });
      }
      if (L.home !== null) r.push({ t: '📍 GPS vers mon logement', fn: () => { const h = doors[L.home]; L.gps = new THREE.Vector3(h.x, 0, h.z); L.gpsLabel = 'Maison'; } }, { t: (L.rentDue ? 'Résilier la location' : 'Vendre mon logement (+1000 $)'), fn: () => { if (!L.rentDue) M.money += 1000; L.home = null; L.rentDue = 0; banner('Logement libéré', 1200); } });
      return openMenu(T, r, 'Chez toi : dormir (lit), te laver (baignoire), cuisiner, coffre, placer tes meubles.');
    }
    if (kind === 'mairie') return openMenu(T, [
      { t: L.permis ? '🪪 Permis de conduire ✔' : '🪪 Permis de conduire — 100 $ (requis à la concession)', dis: L.permis, fn: () => { if (payMoney(100)) { L.permis = true; banner('Permis obtenu', 1200); } } },
      { t: '🤝 Aide sociale (+50 $, si moins de 20 $, toutes les 5 min)', dis: M.money + L.bank >= 20 || performance.now() - L.aide < 300000, fn: () => { M.money += 50; L.aide = performance.now(); updateMissionHud(); } },
      { t: '📋 Mes possessions', fn: openPossessions, keep: false }]);
    if (kind === 'police') return openMenu(T, [{ sep: 'Amendes impayées : ' + L.fines + ' $ (feux rouges grillés)' }, { t: 'Payer mes amendes', dis: !L.fines, fn: () => { if (payMoney(L.fines)) { L.fines = 0; banner('Amendes payées', 1200); } } }, { t: '🚓 Emprunter une voiture de patrouille (devant)', fn: () => banner('Monte dans la voiture de police garée devant (E)', 1600), keep: false }]);
    if (kind === 'bureaux') return openMenu(T, [{ t: '💼 Travailler 20 s au bureau (+45 $)', fn: () => { closeMenu(); work(20, 45, 'Travail de bureau'); }, keep: false }]);
    if (kind === 'concession') {
      const cat = [['SportCar_1', 'Voiture de sport', 600], ['SportCar_7', 'Sportive rouge', 650], ['PickUp_2', 'Pick-up', 450], ['Van_2', 'Utilitaire', 400], ['Car_5_A', 'Citadine', 300], ['Taxi', 'Berline taxi', 350]].filter(c => proto[c[0]]);
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
function setHome(x, rent) { L.home = x.id; L.rentDue = rent ? 300 : 0; L.homeRent = rent; L.gps = new THREE.Vector3(x.x, 0, x.z); L.gpsLabel = 'Maison'; banner(rent ? '🔑 Appartement loué !' : '🏠 Appartement acheté !', 1600); }
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
      { sep: '🏠 Logement : ' + (h ? (L.homeRent ? 'location (prochain loyer dans ' + Math.ceil(L.rentDue) + ' s)' : 'propriétaire') : 'aucun') },
      { sep: '🚗 Véhicules : ' + (L.owned.length ? L.owned.map(c => c.name + ' (' + Math.round(c.fuel) + ' % essence, état ' + Math.round(c.hp) + ' %)').join(', ') : 'aucun') },
      { sep: '🪪 Permis : ' + (L.permis ? 'oui' : 'non') + ' · Métier : ' + (J.job ? JOBS[J.job].label : 'aucun') },
      { sep: '🪑 Meubles placés chez toi : ' + L.furn.length + ' · Objets : ' + Object.values(L.inv).reduce((a, b) => a + b, 0) }];
    if (h) r.push({ t: '📍 GPS vers mon logement', fn: () => { L.gps = new THREE.Vector3(h.x, 0, h.z); L.gpsLabel = 'Maison'; } });
    r.push({ t: '💾 Sauvegarder maintenant', fn: saveGame });
    openMenu('📋 Mes possessions', r);
  });
}

// ---- home interior: furniture, bed, bath, chest
function homeRoom() { return inside && L.home === inside.door.id ? inside.room : null; }
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
  scene.remove(p.g); take(p.id);
  const e = { m: p.m, x, z, r: p.rot }; L.furn.push(e); spawnFurn(r, e); L.placing = null; banner('Meuble posé · X près d’un meuble pour le reprendre', 1800);
}
function spawnFurn(r, e) { const o = makeObject(e.m); o.position.set(r.ox + e.x, 0, r.oz + e.z); o.rotation.y = e.r; r.group.add(o); e.o = o; }
function pickFurniture() {
  const r = homeRoom(); if (!r) return;
  let best = null, bd = 1.8; for (const e of L.furn) { const d = Math.hypot(r.ox + e.x - player.pos.x, r.oz + e.z - player.pos.z); if (d < bd) { bd = d; best = e; } }
  if (!best) return; r.group.remove(best.o); L.furn.splice(L.furn.indexOf(best), 1); give('F:' + best.m); banner('Meuble repris (inventaire) : déplace-le en le replaçant', 1600);
}
function onRoomBuilt(room, door) {
  if (door.type === 'appart') room.spots = { bed: new THREE.Vector3(room.ox + 2.0, 0, room.oz + 1.6), bath: new THREE.Vector3(room.ox + 11.0, 0, room.oz + 6.8), kitchen: new THREE.Vector3(room.ox + 9.0, 0, room.oz + 1.4), chest: new THREE.Vector3(room.ox + 5.6, 0, room.oz + 0.6) };
  if (door.type === 'appart' && proto.K_Containers_Crate_Large) { /* chest */ }
  if (door.type === 'appart') { const c = proto['K_Containers_Box_Large'] ? makeObject('K_Containers_Box_Large') : null; if (c) { c.position.copy(room.spots.chest); room.group.add(c); } }
  if (L.home === door.id) for (const e of L.furn) spawnFurn(room, e);
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
  if (player.inCar) return false;
  const dr = nearDrop(); if (dr) { scene.remove(dr.o); L.drops.splice(L.drops.indexOf(dr), 1); give(dr.id); banner('Ramassé : ' + itemName(dr.id), 900); return true; }
  if (inside) {
    const near = (s, r = 1.8) => s && Math.hypot(s.x - player.pos.x, s.z - player.pos.z) < r;
    const home = homeRoom();
    if (near(roomSpot('bed'), 2.2)) { if (!home) { banner('Ce n’est pas chez toi', 1200); return true; } sleepNow(100); return true; }
    if (near(roomSpot('bath'), 2.0)) { if (!home) { banner('Ce n’est pas chez toi', 1200); return true; } L.needs.hygiene = 100; if (L.sick && Math.random() < 0.3) L.sick = false; banner('🛁 Tu t’es lavé', 1200); return true; }
    if (near(roomSpot('chest'), 1.8) && home) { openChest(); return true; }
    if (near(roomSpot('kitchen'), 2.4) || (inside.door.type === 'resto' && inside.room.exit.distanceTo(player.pos) > 2)) { openInventory(); return true; }
    if (inside.room.shelves) for (const s of inside.room.shelves) if (near(s, 1.6)) {
      const id = pick(['pain', 'fromage', 'tomate', 'salade', 'oeuf', 'pates', 'viande', 'fruits', 'eau', 'lait', 'jus', 'soda']);
      if (payMoney(ITEMS[id].p)) { give(id); banner('Pris sur l’étagère : ' + ITEMS[id].n + ' (−' + ITEMS[id].p + ' $)', 1200); } return true;
    }
    return false;
  }
  const d = nearDoor(); if (d && d.service) { serviceMenu(d); return true; }
  if (d && L.home === d.id) return false; // enter home normally
  const b = nearBench(); if (b) { sit(b); return true; }
  return false;
}
function sleepNow(q) {
  const f = document.getElementById('fade'); f.style.display = 'flex'; f.textContent = '😴 Zzz…';
  setTimeout(() => { L.needs.sommeil = q; L.needs.faim = Math.max(0, L.needs.faim - 20); L.needs.soif = Math.max(0, L.needs.soif - 25); f.style.display = 'none'; banner('Bien dormi !', 1200); }, 1800);
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
  if (L.home !== null && L.homeRent) { L.rentDue -= dt; if (L.rentDue <= 0) { if (payMoney(40)) { L.rentDue = 300; banner('🔑 Loyer payé (40 $)', 1500); } else { L.home = null; L.homeRent = false; banner('Expulsé : loyer impayé', 2500); } } }
  if (L.gps && Math.hypot(L.gps.x - player.pos.x, L.gps.z - player.pos.z) < 8) { L.gps = null; banner('Arrivé : ' + L.gpsLabel, 1200); }
  saveT += dt; if (saveT > 15) { saveT = 0; saveGame(true); }
  updateNeedsHud();
}
function updateNeedsHud() {
  const el = document.getElementById('needs'); if (!el) return;
  const n = L.needs; let h = '';
  for (const k of Object.keys(NEED_ICONS)) { const v = Math.round(n[k]), c = v < 20 ? '#ff5a3c' : v < 45 ? '#ffc21a' : '#3cff8a'; h += '<div><span>' + NEED_ICONS[k] + '</span><i><b style="width:' + v + '%;background:' + c + '"></b></i></div>'; }
  if (L.sick) h += '<em>🤒 Malade</em>';
  const car = player.inCar; if (car) h += '<em>⛽ ' + Math.round(car.fuel ?? 100) + ' % · 🔧 ' + Math.round(car.hp ?? 100) + ' %</em>';
  if (L.gps) h += '<em>📍 ' + L.gpsLabel + ' : ' + Math.round(Math.hypot(L.gps.x - player.pos.x, L.gps.z - player.pos.z)) + ' m</em>';
  h += '<em>🏦 ' + L.bank + ' $</em>';
  if (el._h !== h) { el._h = h; el.innerHTML = h; }
}
function lifePrompt() {
  if (L.placing) return 'R : tourner · E : poser · Échap : annuler';
  if (L.sitting) return 'Assis (repos) · E : se lever';
  if (player.inCar) return (player.inCar.fuel ?? 100) <= 0 ? '⛽ Panne d’essence ! Jerrycan (I) ou station-service' : '';
  if (nearDrop()) return 'E : ramasser ' + itemName(nearDrop().id);
  if (inside) {
    const near = (s, r = 1.8) => s && Math.hypot(s.x - player.pos.x, s.z - player.pos.z) < r;
    const home = homeRoom();
    if (near(roomSpot('bed'), 2.2)) return home ? 'E : dormir' : 'Lit (pas chez toi)';
    if (near(roomSpot('bath'), 2.0)) return home ? 'E : se laver' : 'Baignoire (pas chez toi)';
    if (near(roomSpot('chest')) && home) return 'E : ouvrir le coffre';
    if (near(roomSpot('kitchen'), 2.4)) return 'E : cuisiner (recettes)';
    if (inside.room.shelves) for (const s of inside.room.shelves) if (near(s, 1.6)) return 'E : prendre un produit sur l’étagère';
    if (home) for (const e of L.furn) if (Math.hypot(inside.room.ox + e.x - player.pos.x, inside.room.oz + e.z - player.pos.z) < 1.8) return 'X : reprendre ce meuble';
    return '';
  }
  const d = nearDoor(); if (d && d.service) return 'E : ' + SERVICES[d.service].label;
  if (d && L.home === d.id) return 'E : rentrer chez moi';
  if (nearBench()) return 'E : s’asseoir';
  return '';
}
function drawLifeOnMap(c, k) {
  for (const d of doors) if (d.service) { c.fillStyle = SERVICES[d.service].color; c.fillRect((d.x + HALF) * k - 2.5, (d.z + HALF) * k - 2.5, 5, 5); }
  if (L.home !== null) { const h = doors[L.home]; c.fillStyle = '#fff'; c.font = '11px sans-serif'; c.fillText('🏠', (h.x + HALF) * k - 6, (h.z + HALF) * k + 4); }
  if (L.gps) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.setLineDash([3, 3]); c.beginPath(); c.moveTo((player.pos.x + HALF) * k, (player.pos.z + HALF) * k); c.lineTo((L.gps.x + HALF) * k, (L.gps.z + HALF) * k); c.stroke(); c.setLineDash([]); }
}
// ---- save / load (this browser)
function saveGame(quiet) {
  try { localStorage.setItem('cartooncity_save', JSON.stringify({ money: M.money, bank: L.bank, inv: L.inv, needs: L.needs, sick: L.sick, home: L.home, homeRent: L.homeRent, rentDue: L.rentDue, furn: L.furn.map(e => ({ m: e.m, x: e.x, z: e.z, r: e.r })), fines: L.fines, permis: L.permis, chest, job: J.job, jinv: J.inv })); if (!quiet) banner('💾 Sauvegardé', 900); } catch (e) {}
}
function loadGame() {
  try {
    const s = JSON.parse(localStorage.getItem('cartooncity_save') || 'null'); if (!s) return;
    M.money = s.money; L.bank = s.bank; L.inv = s.inv || {}; Object.assign(L.needs, s.needs || {}); L.sick = !!s.sick; L.home = s.home; L.homeRent = s.homeRent; L.rentDue = s.rentDue || 0;
    L.furn = s.furn || []; L.fines = s.fines || 0; L.permis = !!s.permis; Object.assign(chest, s.chest || {}); J.job = s.job || null; J.inv = s.jinv || {};
    if (L.furn.length) loadInteriorPack();
    updateMissionHud();
  } catch (e) {}
}
