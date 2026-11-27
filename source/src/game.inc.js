// ================================================================ GAMEPLAY
let PLAN = {};
const game = { on: false, freeCam: false };
const keys = new Set();
const player = { pos: new THREE.Vector3(), vy: 0, onGround: true, ch: null, actions: {}, cur: null, inCar: null, heading: 0 };
const cam = { yaw: 0.6, pitch: 0.42, dist: 9 };
const parkedPlayerCars = [];

// ---- colliders (spatial hash)
const CG = 16, cgrid = new Map();
function addCol(x0, z0, x1, z1) {
  const c = { x0, z0, x1, z1 };
  for (let gx = Math.floor(x0 / CG); gx <= Math.floor(x1 / CG); gx++)
    for (let gz = Math.floor(z0 / CG); gz <= Math.floor(z1 / CG); gz++) {
      const k = gx + ',' + gz; if (!cgrid.has(k)) cgrid.set(k, []); cgrid.get(k).push(c);
    }
}
function buildColliders() {
  for (const p of placed) addCol(p.x0 + 0.1, p.z0 + 0.1, p.x1 - 0.1, p.z1 - 0.1);
  for (const e of extraCols) addCol(...e);
}
// push a circle (x,z,r) out of colliders; returns true if it hit something
function collide(v, r) {
  let hit = false;
  const gx = Math.floor(v.x / CG), gz = Math.floor(v.z / CG);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = cgrid.get((gx + i) + ',' + (gz + j)); if (!list) continue;
    for (const c of list) {
      const qx = Math.max(c.x0, Math.min(v.x, c.x1)), qz = Math.max(c.z0, Math.min(v.z, c.z1));
      let dx = v.x - qx, dz = v.z - qz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = true;
      if (d2 > 1e-8) { const d = Math.sqrt(d2); v.x = qx + dx / d * r; v.z = qz + dz / d * r; }
      else { // centre inside the box: leave by the nearest side
        const opts = [[v.x - c.x0, -1, 0], [c.x1 - v.x, 1, 0], [v.z - c.z0, 0, -1], [c.z1 - v.z, 0, 1]].sort((a, b) => a[0] - b[0]);
        const [pen, sx, sz] = opts[0]; v.x += sx * (pen + r); v.z += sz * (pen + r);
      }
    }
  }
  // city limits
  const lim = HALF + 120; v.x = Math.max(-lim, Math.min(lim, v.x)); v.z = Math.max(-lim, Math.min(lim, v.z));
  return hit;
}
function groundY(x, z) {
  const lx = x + HALF, lz = z + HALF;
  if (lx < -4 || lz < -4 || lx > N * P + 4 || lz > N * P + 4) return 0;
  const mx = ((lx % P) + P) % P, mz = ((lz % P) + P) % P;
  const inBlock = mx > 4 && mx < P - 4 && mz > 4 && mz < P - 4 && lx > 4 && lz > 4 && lx < N * P - 4 && lz < N * P - 4;
  return inBlock ? SW : RT;
}

// ---- player
function setAnim(name, fade = 0.2) {
  const a = player.actions[name]; if (!a || player.cur === a) return;
  a.reset().play(); if (player.cur) player.cur.crossFadeTo(a, fade, false); player.cur = a;
}
function initPlayer() {
  const name = skinned['Character_1_1_1'] ? 'Character_1_1_1' : Object.keys(skinned)[0];
  player.ch = makeChar(name);
  for (const k of ['Idle_A-loop', 'Walk_A-loop', 'Runing_A-loop', 'Jump_B_InAir-loop']) if (clips[k]) player.actions[k] = player.ch.mixer.clipAction(clips[k]);
  setAnim('Idle_A-loop', 0);
  player.pos.set(lineX(MAIN) + 6, SW, lineX(MAIN) + 9);
  player.ch.o.position.copy(player.pos);
}

// ---- input
addEventListener('keydown', (e) => {
  if (!game.on) return;
  keys.add(e.code);
  if (e.code === 'KeyE') toggleCar();
  if (e.code === 'KeyC') setFreeCam(!game.freeCam);
  if (e.code === 'KeyM') document.getElementById('minimap').classList.toggle('hidden');
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
let dragging = false;
renderer.domElement.addEventListener('mousedown', () => {
  if (!game.on || game.freeCam) return;
  dragging = true;
  try { renderer.domElement.requestPointerLock && renderer.domElement.requestPointerLock(); } catch (e) {}
});
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (!game.on || game.freeCam) return;
  if (document.pointerLockElement === renderer.domElement || dragging) {
    cam.yaw -= e.movementX * 0.0028;
    cam.pitch = Math.max(0.05, Math.min(1.35, cam.pitch + e.movementY * 0.0022));
  }
});
renderer.domElement.addEventListener('wheel', (e) => {
  if (!game.on || game.freeCam) return;
  cam.dist = Math.max(3.5, Math.min(40, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
}, { passive: true });

// touch: left half = joystick, right half = camera
const touch = { id: null, sx: 0, sy: 0, x: 0, y: 0, cid: null, cx: 0, cy: 0 };
renderer.domElement.addEventListener('touchstart', (e) => {
  if (!game.on || game.freeCam) return;
  for (const t of e.changedTouches) {
    if (t.clientX < innerWidth / 2 && touch.id === null) { touch.id = t.identifier; touch.sx = touch.x = t.clientX; touch.sy = touch.y = t.clientY; }
    else if (touch.cid === null) { touch.cid = t.identifier; touch.cx = t.clientX; touch.cy = t.clientY; }
  }
}, { passive: true });
renderer.domElement.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === touch.id) { touch.x = t.clientX; touch.y = t.clientY; }
    if (t.identifier === touch.cid) { cam.yaw -= (t.clientX - touch.cx) * 0.006; cam.pitch = Math.max(0.05, Math.min(1.35, cam.pitch + (t.clientY - touch.cy) * 0.004)); touch.cx = t.clientX; touch.cy = t.clientY; }
  }
}, { passive: true });
renderer.domElement.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) { if (t.identifier === touch.id) touch.id = null; if (t.identifier === touch.cid) touch.cid = null; }
}, { passive: true });

function axis() {
  let f = 0, s = 0;
  if (keys.has('KeyW') || keys.has('KeyZ') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  if (keys.has('KeyA') || keys.has('KeyQ') || keys.has('ArrowLeft')) s -= 1;
  if (touch.id !== null) { const dx = (touch.x - touch.sx) / 60, dy = (touch.y - touch.sy) / 60; s += Math.max(-1, Math.min(1, dx)); f += Math.max(-1, Math.min(1, -dy)); }
  return { f: Math.max(-1, Math.min(1, f)), s: Math.max(-1, Math.min(1, s)) };
}

// ---- vehicles
function nearestCar() {
  let best = null, bd = 4.2;
  for (const c of cars) { const d = c.obj.position.distanceTo(player.pos); if (d < bd) { bd = d; best = { c, ai: true }; } }
  for (const c of parkedPlayerCars) { const d = c.obj.position.distanceTo(player.pos); if (d < bd) { bd = d; best = { c, ai: false }; } }
  return best;
}
function toggleCar() {
  if (player.inCar) {
    const car = player.inCar;
    if (Math.abs(car.speed) > 4) return;
    const h = car.obj.rotation.y, fx = -Math.sin(h), fz = -Math.cos(h);
    for (const side of [1, -1]) {
      const v = new THREE.Vector3(car.obj.position.x + fz * 2.1 * side, 0, car.obj.position.z - fx * 2.1 * side);
      const before = v.clone(); collide(v, 0.4);
      if (v.distanceTo(before) < 0.01 || side === -1) { player.pos.set(v.x, groundY(v.x, v.z), v.z); break; }
    }
    car.speed = 0;
    parkedPlayerCars.push(car);
    player.inCar = null;
    player.ch.o.visible = true;
    return;
  }
  const n = nearestCar(); if (!n) return;
  let car;
  if (n.ai) { cars.splice(cars.indexOf(n.c), 1); car = { obj: n.c.obj, speed: n.c.v || 0 }; }
  else { parkedPlayerCars.splice(parkedPlayerCars.indexOf(n.c), 1); car = n.c; }
  player.inCar = car;
  player.ch.o.visible = false;
  cam.yaw = car.obj.rotation.y;
}
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
function updatePlayerCar(dt) {
  const car = player.inCar, o = car.obj;
  const { f, s } = axis();
  const brake = keys.has('Space');
  const MAXF = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 30 : 20, MAXR = -7;
  if (f > 0) car.speed += (car.speed < 0 ? 22 : 9) * f * dt;
  else if (f < 0) car.speed += (car.speed > 0 ? -24 : -7) * -f * dt;
  else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 4 * dt);
  if (brake) car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 30 * dt);
  car.speed = Math.max(MAXR, Math.min(MAXF, car.speed));
  const steer = -s * Math.min(1, Math.abs(car.speed) / 5) * (car.speed >= 0 ? 1 : -1);
  o.rotation.y += steer * 1.8 * dt * (1 - Math.min(0.5, Math.abs(car.speed) / 60));
  const h = o.rotation.y, fx = -Math.sin(h), fz = -Math.cos(h);
  o.position.x += fx * car.speed * dt; o.position.z += fz * car.speed * dt;
  // collisions: two circles along the car
  let hit = false;
  for (const k of [1.25, -1.25]) {
    _c1.set(o.position.x + fx * k, 0, o.position.z + fz * k); _c2.copy(_c1);
    if (collide(_c1, 1.0)) { hit = true; o.position.x += _c1.x - _c2.x; o.position.z += _c1.z - _c2.z; }
  }
  for (const c of cars.concat(parkedPlayerCars)) {
    const dx = o.position.x - c.obj.position.x, dz = o.position.z - c.obj.position.z, d = Math.hypot(dx, dz);
    if (d < 2.6 && d > 0.01) { hit = true; o.position.x += dx / d * (2.6 - d); o.position.z += dz / d * (2.6 - d); }
  }
  for (const p of peds) {
    const dx = p.o.position.x - o.position.x, dz = p.o.position.z - o.position.z, d = Math.hypot(dx, dz);
    if (d < 1.9 && Math.abs(car.speed) > 0.5) { car.speed *= 0.5; }
  }
  if (hit) car.speed *= -0.25;
  const gy = groundY(o.position.x, o.position.z) + 0.24;
  o.position.y += (gy - o.position.y) * Math.min(1, dt * 12);
  player.pos.copy(o.position);
  // camera trails behind the car
  if (Math.abs(car.speed) > 1 && !dragging && document.pointerLockElement !== renderer.domElement) {
    let d = h - cam.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); cam.yaw += d * Math.min(1, dt * 2.5);
  }
}
function updatePlayerFoot(dt) {
  const { f, s } = axis();
  const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const fwdx = -Math.sin(cam.yaw), fwdz = -Math.cos(cam.yaw);
  const rx = -fwdz, rz = fwdx;
  let mx = fwdx * f + rx * s, mz = fwdz * f + rz * s;
  const len = Math.hypot(mx, mz);
  const sp = run ? 6.2 : 2.4;
  if (len > 0.01) {
    mx /= len; mz /= len;
    const k = Math.min(1, len);
    player.pos.x += mx * sp * k * dt; player.pos.z += mz * sp * k * dt;
    const target = Math.atan2(mx, mz);
    let d = target - player.heading; d = Math.atan2(Math.sin(d), Math.cos(d)); player.heading += d * Math.min(1, dt * 12);
  }
  collide(player.pos, 0.38);
  for (const c of cars.concat(parkedPlayerCars)) {
    const dx = player.pos.x - c.obj.position.x, dz = player.pos.z - c.obj.position.z, d = Math.hypot(dx, dz);
    if (d < 1.7 && d > 0.01) { player.pos.x += dx / d * (1.7 - d); player.pos.z += dz / d * (1.7 - d); }
  }
  const g = groundY(player.pos.x, player.pos.z);
  if (keys.has('Space') && player.onGround) { player.vy = 5.2; player.onGround = false; }
  player.vy -= 15 * dt; player.pos.y += player.vy * dt;
  if (player.pos.y <= g) { player.pos.y = g; player.vy = 0; player.onGround = true; }
  else if (player.onGround && player.pos.y - g < 0.35) { player.pos.y = g; player.vy = 0; } // step down kerbs
  else player.onGround = false;
  const o = player.ch.o; o.position.copy(player.pos); o.rotation.y = player.heading;
  if (!player.onGround) setAnim('Jump_B_InAir-loop', 0.1);
  else if (len < 0.01) setAnim('Idle_A-loop');
  else setAnim(run ? 'Runing_A-loop' : 'Walk_A-loop');
}
const _ct = new THREE.Vector3();
function updateGameCamera(dt) {
  const t = player.pos;
  const dist = player.inCar ? Math.max(cam.dist, 10) : cam.dist;
  _ct.set(t.x, t.y + (player.inCar ? 1.6 : 1.5), t.z);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  camera.position.set(_ct.x + Math.sin(cam.yaw) * cp * dist, _ct.y + sp * dist, _ct.z + Math.cos(cam.yaw) * cp * dist);
  if (camera.position.y < _ct.y - 1) camera.position.y = _ct.y - 1;
  camera.lookAt(_ct);
  controls.target.copy(_ct);
}

// ---- HUD
const hud = {};
function initHud() {
  hud.speed = document.getElementById('speed');
  hud.prompt = document.getElementById('prompt');
  hud.mm = document.getElementById('minimap');
  hud.ctx = hud.mm.getContext('2d');
  // static background
  const S = 220, bg = document.createElement('canvas'); bg.width = bg.height = S;
  const g = bg.getContext('2d'), k = S / (N * P);
  g.fillStyle = '#7cc653'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#3c3f47'; g.fillRect(0, 0, S, S);
  const col = { park: '#5fbf4a', statue: '#5fbf4a', basket: '#4f9be8', parking: '#6a6d75', factoryBig: '#c46a5a', factory: '#c46a5a', construction: '#d6b06e', solo: '#8f9cc9', city: '#c9ccd6' };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    g.fillStyle = col[PLAN[i + ',' + j]] || '#c9ccd6';
    g.fillRect((i * P + 4) * k, (j * P + 4) * k, BLK * k, BLK * k);
  }
  g.fillStyle = 'rgba(40,44,60,.55)';
  for (const p of placed) g.fillRect((p.x0 + HALF) * k, (p.z0 + HALF) * k, Math.max(1, (p.x1 - p.x0) * k), Math.max(1, (p.z1 - p.z0) * k));
  hud.bg = bg; hud.k = k; hud.S = S;
}
let hudT = 0;
function updateHud(dt) {
  hudT += dt;
  const car = player.inCar;
  hud.speed.textContent = car ? Math.round(Math.abs(car.speed) * 3.6) + ' km/h' : '';
  hud.speed.style.display = car ? 'block' : 'none';
  let msg = '';
  if (car) msg = Math.abs(car.speed) > 4 ? '' : 'E : descendre';
  else if (nearestCar()) msg = 'E : monter dans le véhicule';
  if (hud.prompt.textContent !== msg) { hud.prompt.textContent = msg; hud.prompt.style.display = msg ? 'block' : 'none'; }
  if (hudT < 0.1 || hud.mm.classList.contains('hidden')) return;
  hudT = 0;
  const c = hud.ctx, k = hud.k, S = hud.S;
  c.clearRect(0, 0, S, S); c.drawImage(hud.bg, 0, 0);
  c.fillStyle = '#ffd23f';
  for (const v of cars) c.fillRect((v.obj.position.x + HALF) * k - 1, (v.obj.position.z + HALF) * k - 1, 2, 2);
  c.fillStyle = '#ffffff';
  for (const v of parkedPlayerCars) c.fillRect((v.obj.position.x + HALF) * k - 1.5, (v.obj.position.z + HALF) * k - 1.5, 3, 3);
  const px = (player.pos.x + HALF) * k, pz = (player.pos.z + HALF) * k;
  const h = car ? car.obj.rotation.y + Math.PI : player.heading;
  c.save(); c.translate(px, pz); c.rotate(-h + Math.PI);
  c.fillStyle = '#ff3b3b'; c.strokeStyle = '#fff'; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, -7); c.lineTo(5, 5); c.lineTo(0, 2); c.lineTo(-5, 5); c.closePath(); c.fill(); c.stroke();
  c.restore();
}

function setFreeCam(v) {
  game.freeCam = v;
  controls.enabled = v;
  if (document.pointerLockElement) document.exitPointerLock();
  document.getElementById('modeBtn').textContent = v ? 'Reprendre le jeu (C)' : 'Caméra libre (C)';
  if (!v) controls.target.copy(player.pos);
}
window.setFreeCam = setFreeCam;
window.startGame = (free) => {
  document.getElementById('start').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  game.on = true;
  setFreeCam(!!free);
  if (free) setPreset('overview');
};

function updateGame(dt) {
  obstacles.length = 0;
  if (!game.on) return;
  if (player.inCar) updatePlayerCar(dt); else updatePlayerFoot(dt);
  obstacles.push({ x: player.pos.x, z: player.pos.z });
  for (const c of parkedPlayerCars) obstacles.push({ x: c.obj.position.x, z: c.obj.position.z });
  if (!game.freeCam) updateGameCamera(dt);
  updateHud(dt);
}
