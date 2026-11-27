// ================================================================ LOWPOLY VEHICLE MEGA PACK: catalogue (price, power, consumption, electric, business-only), lazy loading
let VCAT = [];
const VCATN = { car: 'Voitures', race: 'Sport & course', emergency: 'Urgence & service', truck: 'Camions & bus', bike: 'Deux-roues', construction: 'Chantier & ferme' };
function hv(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (Math.abs(h) % 1000) / 1000; }
function vehSpecs(n, cat) {
  const r = hv(n), r2 = hv(n + 'x');
  const B = { car: [6000, 26000, 70, 190, 4.5, 8.5, 5, 380], race: [30000, 160000, 250, 650, 9, 16, 2, 120], emergency: [35000, 90000, 150, 380, 9, 18, 4, 900], truck: [45000, 160000, 230, 520, 22, 38, 3, 12000], bike: [800, 9000, 5, 90, 1.8, 4.5, 2, 20], construction: [40000, 140000, 120, 420, 15, 30, 1, 2000] }[cat];
  const electric = (cat === 'car' && r2 < 0.25) || (cat === 'bike' && r2 < 0.4);
  const price = Math.round((B[0] + (B[1] - B[0]) * r) / 50) * 50;
  return { price, power: Math.round(B[2] + (B[3] - B[2]) * r), cons: electric ? +(12 + 10 * r).toFixed(1) : +(B[4] + (B[5] - B[4]) * r).toFixed(1), electric,
    seats: B[6], trunk: Math.round(B[7] * (0.7 + 0.6 * r2)), business: cat === 'truck' || cat === 'construction' || cat === 'emergency' };
}
async function loadVCat() {
  try { const info = await (await fetch(BASE + 'vmp/info.json')).json(); VCAT = info.map(i => ({ n: i.n, cat: i.cat, ...vehSpecs(i.n, i.cat) })); } catch (e) { VCAT = []; }
}
const vLoading = {};
function loadVeh(n) {
  if (proto['V_' + n]) return Promise.resolve();
  return vLoading[n] = vLoading[n] || new GLTFLoader().loadAsync(BASE + 'vmp/' + n + '.glb').then(g => {
    const root = g.scene; root.updateMatrixWorld(true);
    let bb = new THREE.Box3().setFromObject(root); const s = bb.getSize(new THREE.Vector3());
    const wrap = new THREE.Group(); wrap.add(root); if (s.x > s.z) root.rotation.y = Math.PI / 2; wrap.updateMatrixWorld(true);
    bb = new THREE.Box3().setFromObject(wrap); const c = bb.getCenter(new THREE.Vector3()); root.position.set(-c.x, -bb.min.y - 0.24, -c.z); wrap.updateMatrixWorld(true);
    const parts = []; wrap.traverse(o => { if (!o.isMesh) return; const mats = Array.isArray(o.material) ? o.material : [o.material]; parts.push({ geo: o.geometry, mat: mats[0], mtx: o.matrixWorld.clone(), wheel: /wheel/i.test(o.name) || /wheel/i.test(o.parent && o.parent.name || '') }); });
    proto['V_' + n] = { parts: mergeParts(parts), bb: new THREE.Box3().setFromObject(wrap) };
  }).catch(e => console.warn('vmp', n, e));
}
const DSTATE = { cat: 'car', page: 0, sel: null };
async function dealerUI2(d) {
  UI.open = true; keys.clear(); if (document.pointerLockElement) document.exitPointerLock();
  const m = document.getElementById('menu'); m.style.display = 'flex'; m.innerHTML = ''; m._refresh = null;
  const h = document.createElement('div'); h.className = 'mh'; h.innerHTML = '<b>🚗 Concession — catalogue</b><span>💵 ' + M.money + ' $ · 🏦 ' + L.bank + ' $</span>'; m.append(h);
  const tabs = document.createElement('div'); tabs.className = 'dtabs'; m.append(tabs);
  for (const [k, lab] of Object.entries(VCATN)) { const b = document.createElement('button'); b.textContent = lab; b.className = DSTATE.cat === k ? 'on' : ''; b.onclick = () => { DSTATE.cat = k; DSTATE.page = 0; dealerUI2(d); }; tabs.append(b); }
  if (!L.permis) { const p = document.createElement('p'); p.textContent = '⚠️ Il te faut le permis de conduire (mairie) pour acheter.'; m.append(p); }
  const list = VCAT.filter(v => v.cat === DSTATE.cat), PER = 8, pages = Math.max(1, Math.ceil(list.length / PER)), page = list.slice(DSTATE.page * PER, DSTATE.page * PER + PER);
  const grid = document.createElement('div'); grid.className = 'dgrid'; m.append(grid);
  await Promise.all(page.map(v => loadVeh(v.n)));
  for (const v of page) {
    const c = document.createElement('div'); c.className = 'dcar';
    c.innerHTML = '<img src="' + carThumb('V_' + v.n) + '"><b></b><ul><li>💰 ' + v.price.toLocaleString('fr-FR') + ' $</li><li>⚡ Puissance : ' + v.power + ' ch</li><li>' + (v.electric ? '🔋 Électrique : ' + v.cons + ' kWh/100 km' : '⛽ Consommation : ' + v.cons + ' L/100 km') + '</li><li>💺 Places : ' + v.seats + ' · 🧳 ' + v.trunk + ' L</li>' + (v.business ? '<li>🏢 Réservé aux entreprises</li>' : '') + '</ul>';
    c.querySelector('b').textContent = v.n.replace(/_/g, ' ');
    const btn = document.createElement('button'); btn.textContent = v.business ? 'Entreprises uniquement' : 'Choisir'; btn.disabled = !L.permis || v.business;
    btn.onclick = () => { btn.textContent = 'Confirmer l’achat (' + v.price.toLocaleString('fr-FR') + ' $)'; btn.onclick = () => { if (!payMoney(v.price)) return; buyVeh(d, v); closeMenu(); }; };
    c.append(btn); grid.append(c);
  }
  const nav = document.createElement('div'); nav.className = 'dnav';
  const prev = document.createElement('button'); prev.textContent = '◀'; prev.disabled = DSTATE.page === 0; prev.onclick = () => { DSTATE.page--; dealerUI2(d); };
  const lab = document.createElement('span'); lab.textContent = 'Page ' + (DSTATE.page + 1) + ' / ' + pages + ' · ' + list.length + ' véhicules';
  const next = document.createElement('button'); next.textContent = '▶'; next.disabled = DSTATE.page >= pages - 1; next.onclick = () => { DSTATE.page++; dealerUI2(d); };
  nav.append(prev, lab, next); m.append(nav);
  const cl = document.createElement('button'); cl.className = 'mc'; cl.textContent = 'Fermer (Échap)'; cl.onclick = closeMenu; m.append(cl);
}
async function buyVeh(d, v, pos) {
  await loadVeh(v.n); const o = makeObject('V_' + v.n);
  if (pos) { o.position.set(pos.x, SW + 0.24, pos.z); o.rotation.y = pos.r || 0; }
  else { o.position.set(d.x + d.out[0] * 3 + d.out[1] * 5, SW + 0.24, d.z + d.out[1] * 3 + d.out[0] * 5); o.rotation.y = Math.atan2(d.out[1], -d.out[0]); }
  scene.add(o);
  const car = { obj: o, speed: 0, owned: true, fuel: 100, hp: 100, name: v.n.replace(/_/g, ' '), vmp: v.n, power: v.power, cons: v.cons, electric: v.electric };
  parkedPlayerCars.push(car); L.owned.push(car);
  if (!pos) { banner('🚗 ' + car.name + ' achetée, garée devant la concession', 2000); phoneNotify('🚗 Concession', car.name + ' achetée'); }
  return car;
}
