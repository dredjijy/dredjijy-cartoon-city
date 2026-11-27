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
      const name = BUS_MODELS.filter(m => proto[m])[(li * 3 + k) % BUS_MODELS.filter(m => proto[m]).length] || 'RVCar_A';
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
