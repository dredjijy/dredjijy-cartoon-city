// ================================================================ PUBLIC BUILDINGS: counters, tables, contracts
// state kept in L: interim, offers, itask, util, utilDay, loan, loanDay, ins, insDay, gymUntil
const counterRings = [];
function addCounterRing(room) {
  if (!room.counter) return;
  const r = stopRing(0xffd54f); r.scale.setScalar(0.45); r.position.set(room.counter.x, 0.03, room.counter.z); room.group.add(r); counterRings.push(r);
}
const weekly = (key) => { const d = L[key + 'Day'] ?? GT.day; if (GT.day - d >= 7) { L[key + 'Day'] = GT.day; return true; } if (L[key + 'Day'] == null) L[key + 'Day'] = GT.day; return false; };
function updateContracts(dt) {
  if (L.util && L.home !== null && weekly('util')) { if (payMoney(UTIL_PRICE)) phoneNotify('🏛️ Mairie', 'Électricité, gaz et eau : −' + UTIL_PRICE + ' $ (semaine)'); else { L.util = false; phoneNotify('🏛️ Mairie', 'Abonnement énergie/eau suspendu (impayé)'); } }
  if (L.ins && weekly('ins')) { const p = INSURANCE[L.ins].p; if (payMoney(p)) phoneNotify('🛡️ Assurance', INSURANCE[L.ins].n + ' : −' + p + ' $ (semaine)'); else { L.ins = null; phoneNotify('🛡️ Assurance', 'Contrat résilié (impayé)'); } }
  if (L.loan > 0 && weekly('loan')) { const p = Math.min(L.loan, Math.ceil(L.loanBase / 10)); if (payMoney(p)) { L.loan -= p; phoneNotify('🏦 Banque', 'Remboursement prêt : −' + p + ' $ · reste ' + L.loan + ' $'); } }
  if (L.gymUntil && gameNow() > L.gymUntil) { L.gymUntil = 0; phoneNotify('🏀 Sport', 'Abonnement terminé'); }
  // temp agency: a new offer every ~90 s while registered
  if (L.interim) { L.offerT = (L.offerT ?? 20) - dt; if (L.offerT <= 0) { L.offerT = 90; newOffer(); } }
}
const UTIL_PRICE = 35;
const INSURANCE = { basique: { n: 'Formule Tiers', p: 10, c: 0.3 }, confort: { n: 'Formule Confort', p: 20, c: 0.6 }, premium: { n: 'Tous risques', p: 35, c: 0.9 } };
function repairPrice(base) { const c = L.ins ? INSURANCE[L.ins].c : 0; return Math.max(1, Math.round(base * (1 - c))); }
function hpMax() { return L.gymUntil && gameNow() < L.gymUntil ? 120 : 100; }

// ---- temp agency offers
const OFFERS = [['bureaux', '💼 Saisie de dossiers', 15, 55], ['banque', '🏦 Classement d’archives', 12, 45], ['supermarche', '🛒 Mise en rayon', 15, 50], ['mairie', '🏛️ Accueil du public', 12, 45], ['meubles', '🪑 Montage de meubles', 18, 65], ['pharmacie', '💊 Inventaire', 12, 40]];
function newOffer() {
  L.offers = (L.offers || []).filter(o => !o.done).slice(-3);
  const [svc, label, sec, payN] = pick(OFFERS);
  const d = doors.filter(x => x.service === svc).sort((a, b) => Math.hypot(a.x - player.pos.x, a.z - player.pos.z) - Math.hypot(b.x - player.pos.x, b.z - player.pos.z))[0]; if (!d) return;
  const o = { id: Date.now() % 100000, svc, label, sec, pay: payN, door: d.id };
  L.offers.push(o); phoneNotify('👔 Intérim', label + ' — ' + payN + ' $ (appli Missions)');
}
function acceptOffer(o) { L.itask = o; const d = doors[o.door]; L.gps = new THREE.Vector3(d.x, 0, d.z); L.gpsLabel = o.label; phoneNotify('👔 Intérim', 'Mission acceptée : va au guichet, le GPS te guide'); }
function offerRows() {
  const r = [];
  if (L.itask) r.push({ sep: 'En cours : ' + L.itask.label + ' (' + L.itask.pay + ' $) — présente-toi au guichet' });
  for (const o of (L.offers || []).filter(o => o !== L.itask && !o.done)) r.push({ t: o.label + ' — ' + o.pay + ' $ · ' + o.sec + ' s', fn: () => acceptOffer(o) });
  if (!r.length) r.push({ sep: 'Pas d’offre pour l’instant (une nouvelle toutes les ~90 s)' });
  return r;
}

// ---- dealership catalogue: image rendered from the model + specs
const DEALER = [
  ['C_Thunderball', 'Thunderball', 700, 'Berline sportive, la plus rapide du catalogue.', 180, 8.5, 4, 380],
  ['C_Neptune', 'Neptune', 550, 'Familiale confortable et polyvalente.', 130, 6.4, 5, 480],
  ['C_Galacci', 'Galacci', 520, 'Compacte élégante pour la ville.', 120, 6.0, 4, 300],
  ['C_Rammer', 'Rammer', 480, 'Robuste et facile à garer.', 110, 7.2, 5, 420],
  ['C_Mascuilo', 'Mascuilo (scooter)', 250, 'Scooter économique, se faufile partout.', 15, 2.4, 2, 30],
  ['C_Femintine', 'Femintine (scooter)', 250, 'Scooter urbain au look rétro.', 15, 2.4, 2, 30],
  ['C_car3', 'Classique V3', 380, 'Petite citadine increvable.', 90, 5.5, 4, 260],
  ['SportCar_1', 'Voiture de sport', 600, 'Deux portes, beaucoup de chevaux.', 210, 9.8, 2, 180],
  ['SportCar_7', 'Sportive rouge', 650, 'Coupé sport au freinage précis.', 230, 10.2, 2, 160],
  ['PickUp_2', 'Pick-up', 450, 'Benne pour transporter du matériel.', 150, 9.5, 3, 900],
].filter(v => proto[v[0]]);
const thumbs = {};
let thumbR = null;
function carThumb(name) {
  if (thumbs[name]) return thumbs[name];
  try {
    if (!thumbR) { thumbR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); thumbR.setSize(220, 140); thumbR.outputColorSpace = THREE.SRGBColorSpace; }
    const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight(0xffffff, 0x667788, 2.2)); const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(3, 5, 4); sc.add(dl);
    const o = makeObject(name); sc.add(o); const bb = new THREE.Box3().setFromObject(o), c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3()).length();
    const cm = new THREE.PerspectiveCamera(30, 220 / 140, 0.1, 100); cm.position.set(c.x - s * 1.1, c.y + s * 0.55, c.z - s * 1.2); cm.lookAt(c);
    thumbR.render(sc, cm); thumbs[name] = thumbR.domElement.toDataURL();
  } catch (e) { thumbs[name] = ''; }
  return thumbs[name];
}
function dealerUI(d) {
  UI.open = true; keys.clear(); if (document.pointerLockElement) document.exitPointerLock();
  const m = document.getElementById('menu'); m.style.display = 'flex'; m.innerHTML = ''; m._refresh = null;
  const h = document.createElement('div'); h.className = 'mh'; h.innerHTML = '<b>🚗 Concession — véhicules disponibles</b><span>💵 ' + M.money + ' $ · 🏦 ' + L.bank + ' $</span>'; m.append(h);
  if (!L.permis) { const p = document.createElement('p'); p.textContent = 'Il te faut le permis de conduire (mairie) pour acheter.'; m.append(p); }
  const grid = document.createElement('div'); grid.className = 'dgrid'; m.append(grid);
  for (const v of DEALER) {
    const [model, n, price, desc, ch, conso, seats, trunk] = v;
    const c = document.createElement('div'); c.className = 'dcar';
    c.innerHTML = '<img src="' + carThumb(model) + '"><b></b><p></p><ul><li>⚡ Puissance : ' + ch + ' ch</li><li>⛽ Consommation : ' + conso + ' L/100 km</li><li>💺 Places : ' + seats + '</li><li>🧳 Coffre : ' + trunk + ' L</li></ul>';
    c.querySelector('b').textContent = n + ' — ' + price + ' $'; c.querySelector('p').textContent = desc;
    const btn = document.createElement('button'); btn.textContent = 'Choisir'; btn.disabled = !L.permis;
    btn.onclick = () => { btn.textContent = 'Confirmer l’achat (' + price + ' $)'; btn.onclick = () => { if (!payMoney(price)) return; buyCar(d, v); closeMenu(); }; };
    c.append(btn); grid.append(c);
  }
  const cl = document.createElement('button'); cl.className = 'mc'; cl.textContent = 'Fermer (Échap)'; cl.onclick = closeMenu; m.append(cl);
}
function buyCar(d, v) {
  const [model, n, , , ch] = v; const o = makeObject(model);
  o.position.set(d.x + d.out[0] * 3 + d.out[1] * 5, SW + 0.24, d.z + d.out[1] * 3 + d.out[0] * 5); o.rotation.y = Math.atan2(d.out[1], -d.out[0]); scene.add(o);
  const car = { obj: o, speed: 0, owned: true, fuel: 100, hp: 100, name: n, power: ch }; parkedPlayerCars.push(car); L.owned.push(car);
  banner('🚗 ' + n + ' achetée, garée devant la concession', 2000); phoneNotify('🚗 Concession', n + ' achetée');
}

// ---- restaurant: tables (sit + order) and counter (takeaway + food delivery job)
const RESTO_DISHES = ['plat', 'pates_bolo', 'sandwich', 'salade_comp', 'soupe', 'omelette', 'dessert', 'smoothie', 'biere', 'cafe'];
function tableUI(seat) {
  L.sitting = seat; player.pos.set(seat.x, 0, seat.z); player.heading = seat.rot;
  const q = {};
  const draw = () => {
    UI.open = true; keys.clear();
    const m = document.getElementById('menu'); m.style.display = 'flex'; m.innerHTML = ''; m._refresh = null;
    const h = document.createElement('div'); h.className = 'mh'; h.innerHTML = '<b>🍽️ Menu du restaurant</b><span>💵 ' + M.money + ' $</span>'; m.append(h);
    const list = document.createElement('div'); list.className = 'ml'; m.append(list);
    let tot = 0;
    for (const id of RESTO_DISHES) { const it = ITEMS[id]; if (!it) continue; const n = q[id] || 0; tot += n * it.p;
      const row = document.createElement('div'); row.className = 'qrow';
      const lab = document.createElement('span'); lab.textContent = it.n + ' — ' + it.p + ' $'; row.append(lab);
      const minus = document.createElement('button'); minus.textContent = '−'; minus.disabled = !n; minus.onclick = () => { q[id] = n - 1; draw(); };
      const qty = document.createElement('b'); qty.textContent = n;
      const plus = document.createElement('button'); plus.textContent = '+'; plus.onclick = () => { q[id] = n + 1; draw(); };
      row.append(minus, qty, plus); list.append(row); }
    const go = document.createElement('button'); go.className = 'mc'; go.textContent = tot ? '🍴 Commander et manger — ' + tot + ' $' : 'Choisis des plats';
    go.disabled = !tot; go.onclick = () => { if (!payMoney(tot)) return; for (const [id, n] of Object.entries(q)) for (let k = 0; k < n; k++) consume(id); banner('😋 Bon appétit ! (−' + tot + ' $)', 1600); closeMenu(); };
    const cl = document.createElement('button'); cl.className = 'mc'; cl.textContent = 'Se lever'; cl.onclick = () => { closeMenu(); L.sitting = null; };
    m.append(go, cl);
  };
  draw();
}
function consume(id) {
  const it = ITEMS[id], n = L.needs; if (!it) return;
  if (it.eat) n.faim = Math.min(100, n.faim + it.eat); if (it.drink) n.soif = Math.min(100, n.soif + it.drink); if (it.sleep) n.sommeil = Math.min(100, n.sommeil + it.sleep);
}
function restoCounterMenu() {
  openMenu('🍕 Comptoir du restaurant', [
    { sep: 'À emporter (dans ton inventaire)' },
    ...['plat', 'pates_bolo', 'sandwich', 'dessert', 'smoothie'].filter(id => ITEMS[id]).map(id => ({ t: ITEMS[id].n + ' — ' + ITEMS[id].p + ' $', fn: () => { if (payMoney(ITEMS[id].p)) { give(id); banner('À emporter : ' + ITEMS[id].n, 900); } } })),
    { sep: 'Travail' },
    { t: J.task && J.task.food ? '🛵 Tournée en cours…' : '🛵 Devenir livreur : livrer 3 repas à domicile', dis: !!(J.task && J.task.food), fn: () => { closeMenu(); startFoodRun(); }, keep: false },
  ]);
}
function startFoodRun() {
  if (J.task) clearTask();
  J.job = 'livreur';
  const list = doors.filter(d => d.type === 'appart' && d.id !== L.home).sort(() => rnd() - 0.5).slice(0, 3);
  const mks = list.map(d => { const m = makeMarker(0xff7043, 20); m.position.set(d.x, SW, d.z); return m; });
  J.task = { type: 'deliver', food: true, stage: 'go', list, mks, t: 0, limit: 600, goal: 'Livre les repas : ' + list.length + ' clients' };
  updateJobHud(); banner('🛵 3 repas à livrer : suis le GPS', 2000);
}

// ---- gym / sport: basketball hoops of the city pack (no gym machines in the packs)
const hoops = [];
function hoopNear() { if (player.inCar || inside) return null; return hoops.find(h => Math.hypot(h.x - player.pos.x, h.z - player.pos.z) < 3) || null; }
function gymMenu() {
  const active = L.gymUntil && gameNow() < L.gymUntil;
  openMenu('🏀 Terrain de sport', [
    { sep: active ? 'Abonnement actif : santé max 120 %' : 'Pas d’abonnement' },
    { t: '🏋️ S’entraîner 10 s', fn: () => { closeMenu(); work(10, 0, 'Entraînement'); setTimeout(() => { L.needs.sante = Math.min(hpMax(), L.needs.sante + 25); L.needs.sommeil = Math.max(0, L.needs.sommeil - 10); L.needs.hygiene = Math.max(0, L.needs.hygiene - 20); banner('💪 Entraînement terminé', 1400); }, 10500); }, keep: false },
    { t: '🎟️ Abonnement hebdomadaire — 15 $', dis: active, fn: () => { if (payMoney(15)) { L.gymUntil = gameNow() + 7 * 1440; L.needs.sante = Math.min(120, L.needs.sante + 20); phoneNotify('🏀 Sport', 'Abonnement actif 7 jours : santé max +20 %'); } } },
  ]);
}

// ---- counters: one entry point per building type
function counterMenu(door) {
  const k = door.service || door.type;
  if (k === 'concession') return dealerUI(door);
  if (k === 'resto') return restoCounterMenu();
  if (k === 'emploi') return openMenu('👔 Agence d’intérim', [
    { t: L.interim ? '✔ Inscrit à l’agence' : '📝 S’inscrire (gratuit)', dis: L.interim, fn: () => { L.interim = true; L.offerT = 3; phoneNotify('👔 Intérim', 'Inscription validée : les offres arrivent sur ton téléphone'); } },
    ...(L.interim ? offerRows() : []),
    { sep: 'Métiers de la ville' },
    ...Object.entries(JOBS).map(([j, def]) => { const s = jobSpots.find(s => s.def.job === j); return { t: def.icon + ' ' + def.label + ' — GPS', fn: () => { if (s) { L.gps = s.pos.clone(); L.gpsLabel = def.label; } }, keep: false }; }),
  ], 'Inscris-toi pour recevoir des missions sur ton téléphone (appli Missions).');
  if (k === 'mairie') return openMenu('🏛️ Mairie — accueil', [
    { sep: 'Électricité + gaz + eau : ' + UTIL_PRICE + ' $ / semaine, prélevé automatiquement' },
    { t: L.util ? '✔ Abonné — résilier' : '⚡ Souscrire le pack énergie/eau', dis: !L.util && L.home === null, fn: () => { L.util = !L.util; L.utilDay = GT.day; if (L.util && !payMoney(UTIL_PRICE)) L.util = false; phoneNotify('🏛️ Mairie', L.util ? 'Pack énergie/eau actif' : 'Pack résilié'); } },
    { t: L.permis ? '🪪 Permis de conduire ✔' : '🪪 Permis de conduire — 100 $', dis: L.permis, fn: () => { if (payMoney(100)) { L.permis = true; banner('Permis obtenu', 1200); } } },
    { t: '🤝 Aide sociale (+50 $ si moins de 20 $)', dis: M.money + L.bank >= 20 || performance.now() - (L.aide || -1e9) < 300000, fn: () => { M.money += 50; L.aide = performance.now(); updateMissionHud(); } },
  ], L.home === null ? 'Il faut un logement pour souscrire le pack énergie/eau.' : 'Sans le pack, pas d’eau ni de cuisine chez toi.');
  if (k === 'banque') {
    const r = [{ sep: '🏦 Solde : ' + L.bank + ' $ · 💵 Liquide : ' + M.money + ' $' + (L.loan ? ' · Prêt restant : ' + L.loan + ' $' : '') }];
    for (const v of [20, 100, 500]) r.push({ t: 'Déposer ' + v + ' $', dis: M.money < v, fn: () => { M.money -= v; L.bank += v; updateMissionHud(); } });
    for (const v of [20, 100, 500]) r.push({ t: 'Retirer ' + v + ' $', dis: L.bank < v, fn: () => { L.bank -= v; M.money += v; updateMissionHud(); } });
    for (const v of [500, 2000]) r.push({ t: '💳 Demander un prêt de ' + v + ' $ (rembourse ' + Math.round(v * 1.1) + ' $ en 10 semaines)', dis: L.loan > 0, fn: () => { L.bank += v; L.loan = L.loanBase = Math.round(v * 1.1); L.loanDay = GT.day; phoneNotify('🏦 Banque', 'Prêt accordé : +' + v + ' $'); } });
    if (L.loan) r.push({ t: 'Rembourser le prêt maintenant (' + L.loan + ' $)', fn: () => { if (payMoney(L.loan)) { L.loan = 0; phoneNotify('🏦 Banque', 'Prêt soldé'); } } });
    return openMenu('🏦 Banque — guichet', r);
  }
  if (k === 'assurance') return openMenu('🛡️ Assurance auto', [
    { sep: L.ins ? 'Contrat : ' + INSURANCE[L.ins].n + ' (rembourse ' + INSURANCE[L.ins].c * 100 + ' % des réparations)' : 'Aucun contrat' },
    ...Object.entries(INSURANCE).map(([id, f]) => ({ t: f.n + ' — ' + f.p + ' $ / semaine · rembourse ' + f.c * 100 + ' %', dis: L.ins === id, fn: () => { if (payMoney(f.p)) { L.ins = id; L.insDay = GT.day; phoneNotify('🛡️ Assurance', f.n + ' souscrite'); } } })),
    { t: 'Résilier', dis: !L.ins, fn: () => { L.ins = null; } },
  ], 'Les réparations au garage et via l’appli Réparateur sont remboursées selon la formule.');
  if (k === 'police') return openMenu('🚓 Commissariat — accueil', [
    { sep: 'Amendes impayées : ' + L.fines + ' $' + (L.fines >= FINE_LIMIT ? ' — au-delà de ' + FINE_LIMIT + ' $, retenue automatique sur tes salaires' : '') },
    { t: 'Payer mes amendes', dis: !L.fines, fn: () => { if (payMoney(L.fines)) { L.fines = 0; banner('Amendes payées', 1200); } } },
  ]);
  return serviceMenu(door);
}
const FINE_LIMIT = 150;
// salary garnishment: called from pay()
function garnish(n) {
  if (L.fines < FINE_LIMIT || n <= 0) return n;
  const cut = Math.min(L.fines, Math.ceil(n / 2)); L.fines -= cut; phoneNotify('🚓 Police', 'Retenue sur salaire : ' + cut + ' $ (amendes)'); return n - cut;
}
