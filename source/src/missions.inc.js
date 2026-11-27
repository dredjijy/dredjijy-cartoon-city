// ================================================================ TRAFFIC LIGHTS
let simTime = 0;
const CYCLE = 24;
function lightState(inter, axis) {
  const t = (simTime + inter.off) % CYCLE;
  if (axis === 'x') return t < 10 ? 'g' : t < 12 ? 'y' : 'r';
  return t < 12 ? 'r' : t < 22 ? 'g' : 'y';
}
let sigMesh, sigT = 1;
const SIGCOL = { g: new THREE.Color(0x29ff5a), y: new THREE.Color(0xffc21a), r: new THREE.Color(0xff2a2a) };
function initSignals() {
  sigMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.26, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), signals.length);
  signals.forEach((s, i) => { _m.makeTranslation(s.p.x, s.p.y, s.p.z); sigMesh.setMatrixAt(i, _m); sigMesh.setColorAt(i, SIGCOL.r); });
  sigMesh.computeBoundingSphere(); sigMesh.frustumCulled = false;
  scene.add(sigMesh);
}
function updateSignals(dt) {
  simTime += dt; sigT += dt;
  if (!sigMesh || sigT < 0.25) return; sigT = 0;
  signals.forEach((s, i) => sigMesh.setColorAt(i, SIGCOL[lightState(s.inter, s.axis)]));
  sigMesh.instanceColor.needsUpdate = true;
}

// ================================================================ MISSIONS
const M = { money: 0, active: null, givers: [], done: 0 };
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
  banner('Mission : ' + a.title);
  updateMissionHud();
}
function endMission(ok) {
  const a = M.active; if (!a) return;
  if (a.mk) scene.remove(a.mk);
  if (a.coins) a.coins.forEach(c => scene.remove(c));
  if (a.client) { scene.remove(a.client.o); const i = mixers.indexOf(a.client.mixer); if (i >= 0) mixers.splice(i, 1); }
  if (ok) { M.money += a.reward; M.done++; banner('Mission réussie ! +' + a.reward + ' $'); }
  else banner('Mission échouée');
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
