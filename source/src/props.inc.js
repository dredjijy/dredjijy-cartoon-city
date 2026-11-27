// ================================================================ REAL ESTATE: several flats per building, residences and investments
// L.props: [{ uid, own, mode: 'principal'|'secondaire'|'invest', furnished, due, furn: [], tenant }]
const UNITS_PER_BUILDING = 6;
const RENT_PERIOD = 300; // s between rents (same rhythm as before)
const FURNISHED_ITEMS = ['I_Sofa_01', 'I_Bed2_02', 'I_Bed1_01', 'I_Bed1_01', 'I_KitchenTable_01', 'I_KitchenChair_01', 'I_KitchenChair_01', 'I_KitchenChair_01', 'I_KitchenChair_01', 'I_RoomTable_01', 'I_TV', 'I_Library', 'I_Lamp_01', 'I_Flower_05', 'I_Flower_05', 'I_PC_Table', 'I_Catpet_02'];
function furnitureValue() { let s = 0; for (const n of FURNISHED_ITEMS) { const f = FURN.find(f => f[0] === n); s += f ? f[2] : 0; } return s; }
function unitsOf(b) {
  if (b.unit) return [];
  if (!b.units) {
    b.units = [];
    for (let k = 0; k < UNITS_PER_BUILDING; k++) {
      const floor = 1 + Math.floor(k / 2), u = { id: doors.length, type: 'appart', unit: true, of: b, floor, label: floor + (k % 2 ? 'B' : 'A'), x: b.x, z: b.z, out: b.out, built: null, _viaLobby: true,
        base: 1200 + floor * 150, npc: hash01(b.id * 7 + k) < 0.45, furnished: true };
      doors.push(u); b.units.push(u);
    }
  }
  return b.units;
}
function hash01(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
const propOf = (uid) => L.props.find(p => p.uid === uid);
const isRes = (uid) => { const p = propOf(uid); return !!p && (p.mode === 'principal' || p.mode === 'secondaire'); };
const residences = () => L.props.filter(p => p.mode === 'principal' || p.mode === 'secondaire');
function syncHome() { const p = L.props.find(p => p.mode === 'principal') || residences()[0]; L.home = p ? p.uid : null; L.homeRent = !!(p && !p.own); L.rentDue = p && !p.own ? p.due : 0; }
function unitPrice(u, furnished) { return u.base + (furnished ? furnitureValue() : 0); }
function unitRent(u, furnished) { return Math.round((35 + u.floor * 5) * (furnished ? 1.35 : 1)); }
function furnOf(uid) { const p = propOf(uid); return p ? (p.furn = p.furn || []) : []; }
function rebuildUnit(u) { if (u.built) { scene.remove(u.built.group); u.built = null; } }
// buy or rent a unit; mode decided by the player (max 2 residences)
function acquire(u, own, furnished, mode) {
  if (u.npc || propOf(u.id)) { banner('Cet appartement n’est pas disponible', 1400); return false; }
  if (mode !== 'invest' && residences().length >= 2) { banner('🏠 Maximum 2 résidences (principale + secondaire)', 1800); return false; }
  if (!own && mode === 'invest') return false;
  const cost = own ? unitPrice(u, furnished) : unitRent(u, furnished);
  if (!payMoney(cost)) return false;
  if (mode === 'principal') for (const p of L.props) if (p.mode === 'principal') p.mode = 'secondaire';
  L.props.push({ uid: u.id, own, mode, furnished, due: RENT_PERIOD, furn: [], tenant: mode === 'invest' ? 120 : 0 });
  if (u.furnished !== furnished) { u.furnished = furnished; rebuildUnit(u); }
  syncHome();
  const what = (own ? 'Acheté' : 'Loué') + ' : appartement ' + u.label + (furnished ? ' (meublé)' : ' (vide)') + ' — ' + cost + ' $';
  banner('🏠 ' + what, 2000); phoneNotify('🏠 Immobilier', what + ' · ' + MODE_LABEL[mode]);
  return true;
}
const MODE_LABEL = { principal: 'résidence principale', secondaire: 'résidence secondaire', invest: 'investissement (mis en location)' };
function setMode(p, mode) {
  if (!p.own && mode === 'invest') { banner('Il faut être propriétaire pour mettre en location', 1600); return; }
  if (mode !== 'invest' && p.mode === 'invest' && residences().length >= 2) { banner('🏠 Maximum 2 résidences', 1600); return; }
  if (mode === 'principal') for (const q of L.props) if (q !== p && q.mode === 'principal') q.mode = 'secondaire';
  p.mode = mode; p.tenant = mode === 'invest' ? 120 : 0; p.due = RENT_PERIOD;
  if (mode === 'invest' && inside && inside.door.id === p.uid) exitInterior();
  syncHome(); phoneNotify('🏠 Immobilier', 'Appartement ' + doors[p.uid].label + ' : ' + MODE_LABEL[mode]);
}
function release(p, sell) {
  const u = doors[p.uid];
  if (sell && p.own) { const v = Math.round(unitPrice(u, p.furnished) * 0.8); M.money += v; banner('💰 Vendu ' + v + ' $ (80 % du prix)', 1800); phoneNotify('🏠 Immobilier', 'Appartement ' + u.label + ' vendu : +' + v + ' $'); }
  else banner('Location résiliée', 1400);
  for (const e of p.furn || []) give('F:' + e.m); // your own furniture comes back to the inventory
  if (inside && inside.door.id === p.uid) exitInterior();
  L.props.splice(L.props.indexOf(p), 1); syncHome();
}
// rents: as a tenant you pay, as an investor your tenant pays you
function updateProps(dt) {
  for (const p of L.props.slice()) {
    const u = doors[p.uid]; if (!u) continue;
    if (!p.own) {
      p.due -= dt; if (p.due <= 0) { const r = unitRent(u, p.furnished); if (payMoney(r)) { p.due = RENT_PERIOD; banner('🔑 Loyer payé (' + r + ' $)', 1500); } else { banner('Expulsé de l’appartement ' + u.label + ' : loyer impayé', 2500); release(p, false); } }
    } else if (p.mode === 'invest') {
      if (p.tenant > 0) { p.tenant -= dt; if (p.tenant <= 0) phoneNotify('🏠 Immobilier', 'Un locataire s’installe dans l’appartement ' + u.label); continue; }
      p.due -= dt; if (p.due <= 0) { p.due = RENT_PERIOD; const r = unitRent(u, p.furnished); L.bank += r; phoneNotify('🏠 Immobilier', 'Loyer reçu : +' + r + ' $ (appartement ' + u.label + ')'); }
    }
  }
  syncHome();
}
// ---- building lobby: every flat of the building
function lobbyUnitsMenu(b) {
  const rows = [];
  for (const u of unitsOf(b)) {
    const p = propOf(u.id);
    if (p) {
      rows.push({ sep: '🔑 ' + u.label + ' — ' + (p.own ? 'à toi' : 'loué par toi') + ' · ' + MODE_LABEL[p.mode] + (p.furnished ? ' · meublé' : ' · vide') + (p.mode === 'invest' ? (p.tenant > 0 ? ' · recherche de locataire' : ' · loué ' + unitRent(u, p.furnished) + ' $ / 5 min') : '') });
      if (p.mode !== 'invest') rows.push({ t: '⬆️ Monter à l’appartement ' + u.label, fn: () => goUnit(u), keep: false });
      if (p.mode !== 'principal') rows.push({ t: '🏠 En faire ma résidence principale', fn: () => setMode(p, 'principal') });
      if (p.mode === 'principal' || p.mode === 'invest') rows.push({ t: '🏡 Résidence secondaire', dis: p.mode === 'invest' && residences().length >= 2, fn: () => setMode(p, 'secondaire') });
      if (p.own && p.mode !== 'invest') rows.push({ t: '📈 Mettre en investissement (le louer ; tu n’y vis plus)', fn: () => setMode(p, 'invest') });
      rows.push({ t: p.own ? '💰 Vendre (' + Math.round(unitPrice(u, p.furnished) * 0.8) + ' $)' : '❌ Résilier la location', fn: () => release(p, true) });
    } else if (u.npc) rows.push({ sep: '🚪 ' + u.label + ' — occupé' });
    else {
      rows.push({ sep: '✨ ' + u.label + ' — libre (étage ' + u.floor + ')' });
      rows.push({ t: '👀 Visiter', fn: () => goUnit(u, true), keep: false });
      for (const f of [false, true]) {
        rows.push({ t: '🏠 Acheter ' + (f ? 'meublé' : 'vide') + ' — ' + unitPrice(u, f) + ' $', fn: () => chooseMode(u, true, f), keep: false });
        rows.push({ t: '🔑 Louer ' + (f ? 'meublé' : 'vide') + ' — ' + unitRent(u, f) + ' $ / 5 min', fn: () => chooseMode(u, false, f), keep: false });
      }
    }
  }
  openMenu('🛎️ Accueil — appartements de l’immeuble', rows, 'Max 2 résidences (principale + secondaire). Un bien en investissement est loué : tu ne peux plus y vivre. Meublé : prix des meubles inclus, loyer un peu plus cher.');
}
function chooseMode(u, own, furnished) {
  const opts = [];
  if (!L.props.some(p => p.mode === 'principal')) opts.push(['principal', '🏠 Résidence principale']);
  if (residences().length < 2) opts.push(['secondaire', '🏡 Résidence secondaire']);
  if (own) opts.push(['invest', '📈 Investissement (à louer)']);
  if (!opts.length) { banner('🏠 Tu as déjà 2 résidences', 1600); return; }
  setTimeout(() => openMenu('Appartement ' + u.label + ' — ' + (own ? 'achat' : 'location') + (furnished ? ' meublé' : ' vide'), opts.map(([m, t]) => ({ t, fn: () => acquire(u, own, furnished, m), keep: false }))), 50);
}
async function goUnit(u, visit) {
  const p = propOf(u.id);
  if (!visit && (!p || p.mode === 'invest')) { banner(p ? '📈 Appartement loué à un locataire' : '🔒 Réservé aux résidents', 1500); return; }
  closeMenu(); inside = null; L.visiting = visit ? u.id : null; await enterDoor(u);
  if (visit) banner('👀 Visite de l’appartement ' + u.label + (u.furnished ? ' (meublé)' : ' (vide)') + ' · E à la porte pour sortir', 2200);
}
