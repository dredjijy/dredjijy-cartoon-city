// ================================================================ CITY SERVICES 2: hotel, map picking, tow truck / ambulance on call, sirens, prison, public services, debt
const DEBT_LIMIT = 500;       // the bank account may go down to -500 $ for automatic bills
const ARREST_LIMIT = 300;     // unpaid fines above this -> arrested
const PRISON_MIN = 30;        // game minutes behind bars
// automatic bills (rent, utilities, insurance, loan...) may overdraw the account up to the limit
function payBill(n, label) {
  if (M.money + L.bank - n < -DEBT_LIMIT) return false;
  const c = Math.min(Math.max(0, L.bank), n); L.bank -= c; n -= c; if (n > 0) { const m = Math.min(M.money, n); M.money -= m; n -= m; } if (n > 0) L.bank -= n;
  if (L.bank < 0) phoneNotify('🏦 Banque', 'Compte à découvert : ' + L.bank + ' $ (limite −' + DEBT_LIMIT + ' $)');
  updateMissionHud(); return true;
}
// ---- taxes: accrue every game day, paid at the town hall
function updateTaxes() { if (L.taxDay == null) L.taxDay = GT.day; if (GT.day > L.taxDay) { const n = (GT.day - L.taxDay) * (8 + L.props.filter(p => p.own).length * 6); L.taxDay = GT.day; L.taxes = (L.taxes || 0) + n; phoneNotify('🏛️ Impôts', 'Nouvel impôt : ' + n + ' $ (à payer à la mairie)'); } }
// ---- prison
function arrest() {
  if (L.prison) return; if (player.inCar) toggleCar();
  const p = doors.find(d => d.service === 'police'); if (!p) return;
  L.prison = { until: gameNow() + PRISON_MIN }; L.fines = 0; banner('🚓 Arrêté par la police : ' + PRISON_MIN + ' min de prison', 3000); phoneNotify('🚓 Police', 'Arrêté pour amendes impayées');
  inside = null; enterDoor(p).then(() => { const r = inside.room; player.pos.set(r.ox + 15, 0, r.oz + 2.2); });
}
function updatePrison() {
  if (!L.prison) { if (L.fines > ARREST_LIMIT && !inside && !UI.open) arrest(); return; }
  const left = L.prison.until - gameNow();
  if (inside) { const r = inside.room; if (player.pos.x < r.ox + 12.6 || player.pos.z > r.oz + 4.0) player.pos.set(Math.max(player.pos.x, r.ox + 12.8), 0, Math.min(player.pos.z, r.oz + 3.8)); }
  if (left <= 0) { L.prison = null; banner('🔓 Libéré', 2000); phoneNotify('🚓 Police', 'Tu es libre'); if (inside) exitInterior(true); }
  else if (Math.random() < 0.01) banner('⛓️ Prison : encore ' + Math.ceil(left) + ' min', 1200);
}
// ---- sirens on service vehicles (police, ambulance, fire): flashing lights, no fines while on duty
const SIREN_RE = /Police|Ambulance|Fire|SMAT/i;
const sirenLights = [new THREE.PointLight(0xff1a1a, 0, 18, 1.5), new THREE.PointLight(0x1a4dff, 0, 18, 1.5)];
sirenLights.forEach(l => scene.add(l));
function isServiceCar(c) { return c && SIREN_RE.test(c.obj.userData.name || c.name || ''); }
function sirenOn() { return player.inCar && isServiceCar(player.inCar) && (L.siren || J.task); }
function updateSirens(t) {
  const on = sirenOn();
  sirenLights.forEach((l, i) => { if (!on) { l.intensity = 0; return; } const o = player.inCar.obj, h = o.rotation.y, side = i ? 0.5 : -0.5; l.position.set(o.position.x + Math.cos(h) * side, o.position.y + 2.2, o.position.z - Math.sin(h) * side); l.intensity = (Math.floor(t * 6) % 2 === i) ? 40 : 0; });
}
// ---- vehicles sent to the player (tow truck, ambulance)
const callouts = [];
function callVehicle(model, label, onArrive) {
  if (!proto[model]) model = ['Ambulance', 'Ambulance_2_A', 'PickUp_3', 'PickUp_1'].find(m => proto[m]);
  const o = makeObject(model); const a = Math.random() * 6.28, R = 90;
  o.position.set(player.pos.x + Math.cos(a) * R, SW + 0.24, player.pos.z + Math.sin(a) * R); scene.add(o);
  callouts.push({ o, label, onArrive, t: 0 }); banner(label + ' en route…', 1800); phoneNotify('📞 ' + label, 'En route vers toi');
}
function updateCallouts(dt, t) {
  for (const c of callouts.slice()) {
    const tx = player.pos.x + 3, tz = player.pos.z + 2, dx = tx - c.o.position.x, dz = tz - c.o.position.z, d = Math.hypot(dx, dz);
    if (c.done) { c.t += dt; if (c.t > 6) { scene.remove(c.o); callouts.splice(callouts.indexOf(c), 1); } continue; }
    if (d < 2) { c.done = true; c.onArrive(); continue; }
    const s = Math.min(d, 16 * dt); c.o.position.x += dx / d * s; c.o.position.z += dz / d * s; c.o.rotation.y = Math.atan2(dx, dz); spinWheels(c.o, 16, dt);
    if (SIREN_RE.test(c.o.userData.name)) { const l = sirenLights[Math.floor(t * 6) % 2]; if (!sirenOn()) { l.position.set(c.o.position.x, 2.4, c.o.position.z); l.intensity = 40; sirenLights[1 - Math.floor(t * 6) % 2].intensity = 0; } }
  }
}
// ---- hotel: rooms for one night (studio: double bed, plants, table, TV)
function buildHotelRoom() {
  curRoom.wallName = pickExisting(IW); shell(4, 3, pickExisting(['I_Floor_05', 'I_Floor_08']), curRoom.wallName, 3);
  iput(pickExisting(['I_Bed2_01', 'I_Bed2_02']), 2.4, 1.6, 0); iput('I_Bed_Table_01', 0.6, 0.4); iput('I_Bed_Table_02', 4.2, 0.4); iput('I_Lamp_03', 0.6, 0.4, 0, topOf('I_Bed_Table_01'), false);
  iput('I_RoomTable_01', 7.6, 1.2, -Math.PI / 2); iput('I_TV', 7.6, 1.2, -Math.PI / 2, topOf('I_RoomTable_01'), false);
  iput(pickExisting(['I_KitchenTable_01', 'I_KitchenTable_03']), 5.6, 5.0); iput('I_KitchenChair_01', 5.6, 5.8, Math.PI); PLANT('medium', 5.6, 5.0 - 0.0 + 0.0); 
  PLANT('large', 0.6, 6.8); PLANT('small', 7.4, 6.8); iput(pickExisting(['I_Sofa_06', 'I_Sofa_04']), 2.4, 5.6, 0);
  iput('I_Toilet_01', 7.6, 3.6, -Math.PI / 2);
  curRoom.spots = { bed: new THREE.Vector3(curRoom.ox + 2.4, 0, curRoom.oz + 3.0) }; curRoom.hotel = true;
}
function hotelMenu(door) {
  const mine = L.hotel && L.hotel.until > gameNow();
  openMenu('🏨 Hôtel — réception', [
    { sep: mine ? 'Ta chambre est réservée jusqu’à demain ' + String(Math.floor((L.hotel.until % 1440) / 60)).padStart(2, '0') + ' h' : 'Chambre studio : lit double, TV, coin salon' },
    { t: '🛏️ Louer une chambre pour la nuit — 45 $', dis: mine, fn: () => { if (payMoney(45)) { L.hotel = { until: (Math.floor(gameNow() / 1440) + 1) * 1440 + 11 * 60 }; phoneNotify('🏨 Hôtel', 'Chambre réservée jusqu’à 11 h demain'); } } },
    { t: '🛗 Monter à ma chambre', dis: !mine, fn: () => { closeMenu(); inside = null; enterDoor(hotelRoomDoor(door)); }, keep: false },
  ]);
}
function hotelRoomDoor(d) { if (!d.room) d.room = { id: 80000 + d.id, type: 'hotelroom', of: d, x: d.x, z: d.z, out: d.out, built: null, _viaLobby: true }; return d.room; }
// ---- big map: tap to choose a destination (GPS) or to send the taxi there
function openBigMap(mode) {
  togglePhone(false);
  const ov = document.createElement('div'); ov.id = 'bigmap'; ov.innerHTML = '<div class="bmh"><b></b><button>✕</button></div><canvas></canvas><p class="bmt"></p>';
  document.body.append(ov); UI.open = true; keys.clear(); if (document.pointerLockElement) document.exitPointerLock();
  ov.querySelector('b').textContent = mode === 'taxi' ? '🚕 Touche l’endroit où le taxi doit t’emmener' : '📍 Touche une destination (tes biens en jaune)';
  const c = ov.querySelector('canvas'), S = Math.min(innerWidth - 40, innerHeight - 140); c.width = c.height = S; const k = S / (2 * HALF);
  const g = c.getContext('2d'); g.drawImage(hud.mm, 0, 0, S, S);
  const dot = (x, z, col, r, txt) => { g.fillStyle = col; g.beginPath(); g.arc((x + HALF) * k, (z + HALF) * k, r, 0, 7); g.fill(); if (txt) { g.font = 'bold 12px sans-serif'; g.fillStyle = '#fff'; g.fillText(txt, (x + HALF) * k + r + 2, (z + HALF) * k + 4); } };
  for (const p of L.props) { const u = doors[p.uid]; dot(u.x, u.z, '#ffd54f', 7, '🏠 ' + u.label); }
  for (const [n, x, z] of destinations()) dot(x, z, '#90caf9', 4, '');
  dot(player.pos.x, player.pos.z, '#fff', 6, 'Moi');
  const close = () => { ov.remove(); UI.open = false; };
  ov.querySelector('button').onclick = close;
  c.onclick = (e) => {
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 2 * HALF - HALF, z = (e.clientY - r.top) / r.height * 2 * HALF - HALF;
    const near = [...destinations(), ...L.props.map(p => ['🏠 Appartement ' + doors[p.uid].label, doors[p.uid].x, doors[p.uid].z])].sort((a, b) => Math.hypot(a[1] - x, a[2] - z) - Math.hypot(b[1] - x, b[2] - z))[0];
    const pickN = near && Math.hypot(near[1] - x, near[2] - z) < 30 ? near : ['📍 Point choisi', x, z];
    close();
    if (mode === 'taxi') { const p = 2 + Math.round(Math.hypot(pickN[1] - player.pos.x, pickN[2] - player.pos.z) / 50); travelTo(pickN[1], pickN[2], pickN[0], p); }
    else gpsSet(pickN[1], pickN[2], pickN[0]);
  };
}
