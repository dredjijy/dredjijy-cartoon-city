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
  serviceShell(pickExisting(['I_Floor_08', 'I_Floor_12', 'I_Floor_03']));
  counter(7.5, 6.0, 3); roomNPC(7.5, 5.45, 'Idle_A-loop', 0);
  if (proto.G_Screen_1) iput('G_Screen_1', 6.3, 6.0, Math.PI, topOf('I_Bar_01'), false);
  iput(pickExisting(['I_Sofa_01', 'I_Sofa_03', 'I_Sofa_07']), 2.3, 9.0, Math.PI); iput('I_RoomTable_01', 2.3, 7.8);
  iput(pickExisting(['I_Sofa_02', 'I_Sofa_04']), 13.0, 9.0, Math.PI); DECO(0.6, 5.8); DECO(14.4, 5.8);
  iput('I_Clock_04', 14.85, 7.6, -Math.PI / 2, 1.8, false);
  if (door.kind === 'appart') {
    // mailboxes + stairs/lift corridor in the back
    for (let k = 0; k < 4; k++) if (proto.PostBox_2_A) iput('PostBox_2_A', 0.4, 6.4 + k * 0.7, Math.PI / 2, 0, true, 0.8);
    iput('I_Picture_04', 0.15, 8.4, Math.PI / 2, 1.5, false);
    for (const x of [1.5, 3.5]) iput('I_Library', x, 0.25, 0);
    R.lift = new THREE.Vector3(R.ox + 11.2, 0, R.oz + 2.4);
    roomNPC(3.0, 7.8, 'LookingAround-loop', 0.4);
  } else {
    // hospital: waiting chairs in the hall, beds in the back rooms
    const ch = pickExisting(['G_Chair_10', 'G_Chair_11', 'I_OfficeChair_01']);
    for (let k = 0; k < 5; k++) iput(ch, 4.4 + k * 0.8, 9.3, Math.PI);
    for (const [x, z] of [[1.6, 1.4], [4.0, 1.4], [9.6, 1.4], [12.0, 1.4]]) { iput(pickExisting(['I_Bed1_01', 'I_Bed1_03']), x, z); iput('I_Bed_Table_01', x + 1.2, z - 0.8); }
    roomNPC(4.0, 2.8, 'Idle_B-loop', 0); roomNPC(12.0, 2.8, 'Idle_B-loop', 0); roomNPC(5.2, 8.6, 'Idle_A-loop', Math.PI);
    R.lift = null;
  }
}
function lobbyAction() {
  const r = inside.room, d = inside.door, near = (v, m) => v && Math.hypot(v.x - player.pos.x, v.z - player.pos.z) < m;
  if (near(r.counter, 2.2)) {
    if (d.kind === 'hopital') { hospitalMenu(); return true; }
    const flat = d.of; const mine = L.home === flat.id;
    openMenu('🛎️ Accueil de l’immeuble', [
      { sep: mine ? (L.homeRent ? 'Tu loues un appartement ici' : 'Tu es propriétaire ici') : 'Appartement disponible dans cet immeuble' },
      { t: '🔑 Louer — 40 $ / 5 min', dis: mine, fn: () => { if (payMoney(40)) setHome(flat, true); } },
      { t: '🏠 Acheter — 1500 $', dis: mine && !L.homeRent, fn: () => { if (payMoney(1500)) setHome(flat, false); } },
      { t: mine ? (L.homeRent ? 'Résilier la location' : 'Vendre (+1000 $)') : '—', dis: !mine, fn: () => { if (!L.homeRent) M.money += 1000; L.home = null; L.rentDue = 0; banner('Logement libéré', 1200); } },
    ], 'Les clés te donnent accès à l’escalier au fond du hall.');
    return true;
  }
  if (r.lift && near(r.lift, 1.8)) {
    if (L.home !== d.of.id) { banner('🔒 Accès réservé aux résidents (accueil)', 1500); return true; }
    const flat = d.of; inside = null; flat._viaLobby = true; enterDoor(flat).then(() => { flat._viaLobby = false; }); return true;
  }
  return false;
}
function lobbyPrompt() {
  const r = inside.room, near = (v, m) => v && Math.hypot(v.x - player.pos.x, v.z - player.pos.z) < m;
  if (near(r.counter, 2.2)) return inside.door.kind === 'hopital' ? 'E : accueil des urgences' : 'E : accueil (louer / acheter)';
  if (r.lift && near(r.lift, 1.8)) return L.home === inside.door.of.id ? 'E : monter à mon appartement' : 'Escalier — réservé aux résidents';
  return '';
}
function hospitalMenu() {
  openMenu('🏥 Hôpital — accueil', [
    { t: '🩺 Se faire soigner (60 $)', fn: () => { if (payMoney(60)) { L.needs.sante = 100; L.sick = false; banner('Soigné', 1200); } }, keep: false },
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
  PH.open = v; $('phone').classList.toggle('on', v);
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
  if (player.inCar || inside) { banner(inside ? 'Sors du bâtiment d’abord' : 'Descends de voiture d’abord', 1400); return; }
  if (!payMoney(price)) return;
  togglePhone(false);
  const f = $('fade'); f.style.display = 'flex'; f.textContent = '🚕 Trajet vers ' + label + '…';
  setTimeout(() => { const v = new THREE.Vector3(x, SW, z); collide(v, 0.6); player.pos.set(v.x, groundY(v.x, v.z), v.z); GT.min += Math.min(60, Math.round(Math.hypot(x, z) / 40) + 5); f.style.display = 'none'; banner('Arrivé : ' + label, 1400); }, 1500);
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
  carte(s) { const c = pel('canvas', 'pmap'); c.width = 240; c.height = 240; s.append(c); PH.mapCanvas = c; drawPhoneMap(); s.append(pel('p', 'pt', L.gps ? '📍 ' + L.gpsLabel + ' — ' + Math.round(pdist(L.gps.x, L.gps.z)) + ' m' : 'Pas d’itinéraire. Choisis une destination dans Internet ou Taxi.')); if (L.gps) s.append(prow('Effacer l’itinéraire', () => { L.gps = null; })); },
  taxi(s) {
    s.append(pel('p', 'pt', 'Un taxi t’emmène où tu veux. 2 $ + 1 $ / 50 m.'));
    for (const [n, x, z] of destinations()) { const p = 2 + Math.round(pdist(x, z) / 50); s.append(prow(n + ' · ' + p + ' $', () => travelTo(x, z, n, p))); }
  },
  urgences(s) {
    s.append(pel('p', 'pt', 'Santé : ' + Math.round(L.needs.sante ?? 100) + ' %' + (L.sick ? ' · malade' : '')));
    s.append(prow('🚑 Appeler une ambulance (80 $, soins compris)', () => { const h = nearestSpot('hospital'); if (!h) return; if (M.money + L.bank < 80) { banner('Pas assez d’argent', 1200); return; } travelTo(h.pos.x, h.pos.z + 2, 'Hôpital', 80); setTimeout(() => { L.needs.sante = 100; L.sick = false; phoneNotify('🏥 Hôpital', 'Tu as été soigné'); }, 1600); }));
    s.append(prow('🚓 Police — payer mes amendes (' + L.fines + ' $)', () => { if (L.fines && payMoney(L.fines)) { L.fines = 0; phoneNotify('🚓 Police', 'Amendes réglées'); } }, !L.fines));
    s.append(prow('🚒 Caserne — GPS', () => { const f = nearestSpot('fire'); if (f) gpsSet(f.pos.x, f.pos.z, 'Caserne'); }));
  },
  reparateur(s) {
    const mine = L.owned || []; if (!mine.length) s.append(pel('p', 'pt', 'Tu n’as pas de voiture (concession auto).'));
    for (const c of mine) { const dmg = 100 - Math.round(c.hp ?? 100), p = Math.ceil(dmg * 1.5) + 15;
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
    s.append(pel('p', 'pt', '💵 Liquide : ' + M.money + ' $\n🏦 Compte : ' + L.bank + ' $\n🚓 Amendes : ' + L.fines + ' $'));
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
    for (const g of M.givers) s.append(prow('📍 ' + (g.t.label || g.t.id) + ' — ' + Math.round(pdist(g.p.x, g.p.z)) + ' m', () => gpsSet(g.p.x, g.p.z, g.t.label || 'Mission')));
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
    const h = L.home !== null ? doors[L.home] : null;
    s.append(pel('p', 'pt', h ? (L.homeRent ? '🔑 Location · loyer dans ' + Math.ceil(L.rentDue) + ' s' : '🏠 Propriétaire') : 'Pas de logement. Va à l’accueil d’un immeuble ou à l’agence immobilière.'));
    if (h) s.append(prow('📍 GPS vers mon logement', () => gpsSet(h.x, h.z, 'Maison')));
    const a = doors.filter(d => d.type === 'appart' && d.id !== L.home).sort((x, y) => pdist(x.x, x.z) - pdist(y.x, y.z)).slice(0, 4);
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
  const body = $('phBody'); body.innerHTML = ''; PH.mapCanvas = null;
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
function drawPhoneMap() {
  const c = PH.mapCanvas; if (!c || !hud.mm) return; const g = c.getContext('2d'); g.drawImage(hud.mm, 0, 0, c.width, c.height);
}
let phTick = 0;
function updatePhone(dt) {
  PH.battery = Math.max(0, PH.battery - dt * (PH.open ? 0.12 : 0.02));
  if (inside && L.home === inside.door.id) PH.battery = Math.min(100, PH.battery + dt * 2);
  if (PH.order) { PH.order.t -= dt; if (PH.order.t <= 0) { chest[PH.order.id] = (chest[PH.order.id] || 0) + 1; phoneNotify('🛵 Livraison', ITEMS[PH.order.id].n + ' livré chez toi (coffre)'); PH.order = null; } }
  updatePaid(); updateGates(dt);
  phTick += dt; if (PH.open && phTick > 0.5) { phTick = 0; if (PH.app === 'carte') drawPhoneMap(); else { const sb = $('phStatus'); if (sb && sb.firstChild) sb.firstChild.textContent = String(Math.floor(GT.min / 60)).padStart(2, '0') + ':' + String(Math.floor(GT.min % 60)).padStart(2, '0'); } }
}
function initPhone() {
  const p = $('phone'); if (!p) return;
  $('phBackBtn').onclick = phoneBack; $('phHomeBtn').onclick = phoneHome; $('phClose').onclick = () => togglePhone(false); $('phOpen').onclick = () => togglePhone(true);
  // the phone replaces the always-on map
  if (hud.mm) hud.mm.classList.add('hidden');
  addEventListener('keydown', (e) => { if (!game.on) return; if (e.code === 'KeyT' && !UI.open && document.activeElement.tagName !== 'INPUT') togglePhone(); else if (e.code === 'Escape' && PH.open) togglePhone(false); });
  phoneNotify('📱 Téléphone', 'Bienvenue à Cartoon City ! T pour ouvrir/fermer');
}
