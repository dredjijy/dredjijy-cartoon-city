// ================================================================ MAIN MENU: title → account → sex & name → body → style & colours → play
// the menu is shown at once; the city keeps loading behind it (progress bar at the bottom)
const KEYACT = [['forward', 'Avancer', 'KeyW'], ['back', 'Reculer', 'KeyS'], ['left', 'Gauche', 'KeyA'], ['right', 'Droite', 'KeyD'], ['run', 'Courir', 'ShiftLeft'], ['jump', 'Sauter / freiner', 'Space'],
  ['action', 'Action', 'KeyE'], ['inv', 'Inventaire', 'KeyI'], ['phone', 'Téléphone', 'KeyT'], ['cam', 'Caméra libre', 'KeyC'], ['map', 'Minicarte', 'KeyM'], ['water', 'Arroser (pompier)', 'KeyF']];
let KEYMAP = {}; try { KEYMAP = JSON.parse(localStorage.getItem('cc_keys') || '{}'); } catch (e) {}
const keyLabel = (c) => c.replace(/^Key/, '').replace(/^Digit/, '').replace('ShiftLeft', 'Maj').replace('Space', 'Espace').replace('ControlLeft', 'Ctrl').replace(/^Arrow/, 'Flèche ');
for (const type of ['keydown', 'keyup']) addEventListener(type, (e) => {
  if (e._cc || document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const act = KEYACT.find(a => KEYMAP[a[0]] && KEYMAP[a[0]] === e.code && a[2] !== e.code); if (!act) return;
  e.stopImmediatePropagation(); e.preventDefault(); const ev = new KeyboardEvent(type, { code: act[2], key: e.key, bubbles: true }); ev._cc = 1; (document.activeElement || document.body).dispatchEvent(ev);
}, true);
// ---- loading progress shown in the menu
let LOADP = 0, WORLD_READY = false;
function loadProgress(p, txt) { LOADP = Math.max(LOADP, p); const b = document.getElementById('ldBar'), t = document.getElementById('ldTxt'); if (b) b.style.width = Math.round(LOADP) + '%'; if (t) t.textContent = (txt || 'Chargement de la ville') + ' · ' + Math.round(LOADP) + ' %'; }
// ---- characters of the pack, by sex (looked at one by one: 3, 4 and 11 are the women)
const FEMALE_BODY = new Set(['3', '4', '11']);
const charGroups = () => { const g = {}; for (const n of Object.keys(skinned)) { if (!/^Character_/.test(n) || /_Z_/.test(n)) continue; const [, a, b] = n.split('_'); ((g[a] = g[a] || {})[b] = g[a][b] || []).push(n); } return g; };
const sexOf = (a) => FEMALE_BODY.has(a) ? 'f' : 'h';
let CHAR = null; try { CHAR = JSON.parse(localStorage.getItem('cc_char') || 'null'); } catch (e) {}
let DRAFT = null;
const PAL = {
  hair: ['#1b1b1b', '#3b2416', '#6b3e1f', '#a0522d', '#d9a441', '#f3d27a', '#c0392b', '#e8e8e8', '#8e44ad', '#2e86de', '#ff6fae'],
  skin: ['#f8d5c0', '#eebd9a', '#d89c72', '#b87a52', '#8d5a3b', '#5c3a26'],
  top: ['#ffffff', '#1d2740', '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#e84393', '#7f8c8d', '#111111'],
  pants: ['#1d2740', '#2c3e50', '#111111', '#7f8c8d', '#8b5a2b', '#c2a477', '#2980b9', '#27ae60', '#c0392b', '#ffffff'],
  shoes: ['#111111', '#ffffff', '#8b4513', '#c0392b', '#2980b9', '#f1c40f', '#7f8c8d'],
};
const PAL_N = { hair: 'Cheveux', skin: 'Peau', top: 'Haut', pants: 'Bas', shoes: 'Chaussures' };
// ---- recolouring: each part of a character takes its colour from one strip of the shared city atlas;
// we find which strip is the skin / top / bottom / shoes / hair (by where the vertices sit on the body) and repaint those strips on a private copy of the atlas
const PARTMAP = {};
function partStrips(name) {
  if (PARTMAP[name]) return PARTMAP[name];
  const o = SkeletonUtils.clone(skinned[name]); o.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(o), H = box.max.y - box.min.y || 1, y0 = box.min.y, v = new THREE.Vector3();
  const cnt = { skin: {}, top: {}, pants: {}, shoes: {}, hair: {} };
  o.traverse(m => {
    if (!m.isMesh) return; const g = m.geometry, uv = g.attributes.uv, pos = g.attributes.position; if (!uv) return;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index ? g.index.count : pos.count, materialIndex: 0 }], mats = [].concat(m.material);
    for (const gr of groups) {
      const hairMat = /hair/i.test((mats[gr.materialIndex] || mats[0]).name);
      for (let i = gr.start; i < gr.start + gr.count; i++) {
        const vi = g.index ? g.index.getX(i) : i; if (m.isSkinnedMesh) m.getVertexPosition(vi, v); else v.fromBufferAttribute(pos, vi); v.applyMatrix4(m.matrixWorld);
        const h = (v.y - y0) / H, col = Math.floor(uv.getX(vi) * 48), row = Math.floor(uv.getY(vi) * 6), k = col + ',' + row;
        const cls = hairMat ? 'hair' : h > 0.8 ? 'skin' : h > 0.5 ? 'top' : h > 0.1 ? 'pants' : 'shoes';
        cnt[cls][k] = (cnt[cls][k] || 0) + 1;
      }
    }
  });
  const best = (c, ex) => Object.entries(c).filter(([k]) => !ex.includes(k)).sort((a, b) => b[1] - a[1])[0]?.[0];
  const r = {}; r.skin = best(cnt.skin, []); r.hair = best(cnt.hair, []); r.top = best(cnt.top, [r.skin]); r.pants = best(cnt.pants, [r.skin, r.top]); r.shoes = best(cnt.shoes, [r.skin, r.top, r.pants]);
  return PARTMAP[name] = r;
}
function tintedAtlas(name, colors) {
  const src = getTex('city_atlas').image; if (!src || !src.width) return null;
  const W = src.width, Hh = src.height, cv = document.createElement('canvas'); cv.width = W; cv.height = Hh; const g = cv.getContext('2d'); g.drawImage(src, 0, 0);
  const S = partStrips(name), cw = W / 48, rh = Hh / 6;
  for (const [part, hex] of Object.entries(colors || {})) {
    if (!hex || !S[part]) continue; const [c, r] = S[part].split(',').map(Number), x = Math.floor(c * cw), y = Math.floor(r * rh), w = Math.ceil(cw), h = Math.ceil(rh);
    const im = g.getImageData(x, y, w, h), d = im.data, t = new THREE.Color(hex); let mean = 0; for (let i = 0; i < d.length; i += 4) mean += d[i] + d[i + 1] + d[i + 2]; mean /= d.length / 4 * 3 || 1;
    for (let i = 0; i < d.length; i += 4) { const k = ((d[i] + d[i + 1] + d[i + 2]) / 3) / (mean || 1); d[i] = Math.min(255, t.r * 255 * k); d[i + 1] = Math.min(255, t.g * 255 * k); d[i + 2] = Math.min(255, t.b * 255 * k); }
    g.putImageData(im, x, y);
  }
  const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace; tx.flipY = false; tx.wrapS = tx.wrapT = THREE.RepeatWrapping; return tx;
}
function applyColors(o, name, colors) {
  if (!colors || !Object.values(colors).some(Boolean)) return;
  const tx = tintedAtlas(name, colors); if (!tx) return;
  o.traverse(m => { if (!m.isMesh) return; m.material = [].concat(m.material).map(mm => { const c = mm.clone(); c.map = tx; return c; }); if (m.material.length === 1) m.material = m.material[0]; });
}
function setPlayerModel(name, colors) {
  if (!skinned[name] || !player.ch) return;
  const pos = player.ch.o.position.clone(), rot = player.ch.o.rotation.y, old = player.ch;
  old.o.parent && old.o.parent.remove(old.o); const i = mixers.indexOf(old.mixer); if (i >= 0) mixers.splice(i, 1);
  player.ch = makeChar(name); applyColors(player.ch.o, name, colors); player.ch.o.position.copy(pos); player.ch.o.rotation.y = rot; player.actions = {}; player.cur = null;
  for (const k of ['Idle_A-loop', 'Walk_A-loop', 'Runing_A-loop', 'Jump_B_InAir-loop']) if (clips[k]) player.actions[k] = player.ch.mixer.clipAction(clips[k]);
  setAnim('Idle_A-loop', 0); player.ch.bones = null; updateCarry();
}
const CHAR_THUMB = {};
function charThumb(name, colors, size = 128) {
  const key = name + JSON.stringify(colors || {}) + size; if (CHAR_THUMB[key]) return CHAR_THUMB[key];
  ensureThumb(); if (thumbRT.width !== size) thumbRT.setSize(size, size);
  const o = SkeletonUtils.clone(skinned[name]); applyColors(o, name, colors); thumbScene.add(o);
  if (clips['Idle_A-loop']) { const mx = new THREE.AnimationMixer(o); mx.clipAction(clips['Idle_A-loop']).play(); mx.update(0.3); }
  o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o), c = b.getCenter(new THREE.Vector3()), h = b.max.y - b.min.y || 1.6;
  thumbCam.position.set(c.x + h * 0.5, c.y + h * 0.3, c.z + h * 2.3); thumbCam.lookAt(c.x, c.y, c.z); thumbCam.near = 0.05; thumbCam.far = 50; thumbCam.updateProjectionMatrix();
  const prev = renderer.getRenderTarget(); renderer.setRenderTarget(thumbRT); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(thumbScene, thumbCam);
  const px = new Uint8Array(size * size * 4); renderer.readRenderTargetPixels(thumbRT, 0, 0, size, size, px); renderer.setRenderTarget(prev); thumbScene.remove(o);
  const cv = document.createElement('canvas'); cv.width = cv.height = size; const g = cv.getContext('2d'), im = g.createImageData(size, size);
  for (let y = 0; y < size; y++) im.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4); g.putImageData(im, 0, 0);
  return CHAR_THUMB[key] = cv.toDataURL();
}
let setReturn = 'scrMenu';
function showScr(id) {
  document.querySelectorAll('#start .scr').forEach(s => s.classList.toggle('on', s.id === id));
  if (id === 'scrBody') fillBody(); if (id === 'scrStyle') fillStyle(); if (id === 'scrSet') fillKeys(); if (id === 'scrMenu') menuWho();
}
function menuWho() { const w = document.getElementById('menuWho'); if (w) w.textContent = (CHAR ? '🧍 ' + (CHAR.name || 'Joueur') : '') + (sbUser ? ' · ☁️ ' + sbUser.email : ' · 💾 sauvegarde locale'); }
const whenWorld = (scr, fn) => { const p = document.querySelector('#' + scr + ' .wait'); if (WORLD_READY) { if (p) p.textContent = ''; return fn(); } if (p) p.textContent = '⏳ Les personnages arrivent… (' + Math.round(LOADP) + ' %)'; setTimeout(() => { if (document.getElementById(scr).classList.contains('on')) whenWorld(scr, fn); }, 1000); };
function fillBody() {
  const grid = document.getElementById('bodyGrid'); grid.innerHTML = '';
  whenWorld('scrBody', () => {
    const G = charGroups(); grid.innerHTML = '';
    for (const a of Object.keys(G).sort((x, y) => (+x || 99) - (+y || 99))) { if (sexOf(a) !== DRAFT.sex) continue;
      const first = G[a][Object.keys(G[a]).sort((x, y) => x - y)[0]].sort()[0], d = document.createElement('div'); d.innerHTML = '<img src="' + charThumb(first) + '">'; d.className = DRAFT.body === a ? 'sel' : '';
      d.onclick = () => { grid.querySelectorAll('div').forEach(q => q.classList.remove('sel')); d.classList.add('sel'); if (DRAFT.body !== a) { DRAFT.body = a; DRAFT.model = null; } }; grid.append(d); }
    if (!DRAFT.body || sexOf(DRAFT.body) !== DRAFT.sex) grid.firstChild && grid.firstChild.click();
  });
}
function fillStyle() {
  whenWorld('scrStyle', () => {
    const G = charGroups()[DRAFT.body] || {}, grid = document.getElementById('styleGrid'); grid.innerHTML = '';
    const models = Object.keys(G).sort((x, y) => x - y).flatMap(b => G[b].sort((x, y) => +x.split('_')[3] - +y.split('_')[3]));
    if (!DRAFT.model || !models.includes(DRAFT.model)) DRAFT.model = models[0];
    for (const n of models) { const d = document.createElement('div'); d.innerHTML = '<img src="' + charThumb(n, null, 96) + '">'; d.className = n === DRAFT.model ? 'sel' : ''; d.onclick = () => { grid.querySelectorAll('div').forEach(q => q.classList.remove('sel')); d.classList.add('sel'); DRAFT.model = n; prev(); }; grid.append(d); }
    const pals = document.getElementById('pals'); pals.innerHTML = ''; DRAFT.colors = DRAFT.colors || {};
    for (const [part, list] of Object.entries(PAL)) {
      const row = document.createElement('div'); row.className = 'pal'; row.innerHTML = '<b>' + PAL_N[part] + '</b>';
      for (const hex of [null, ...list]) { const s = document.createElement('span'); if (hex) s.style.background = hex; else { s.className = 'no'; s.title = 'couleur d’origine'; } if ((DRAFT.colors[part] || null) === hex) s.classList.add('sel');
        s.onclick = () => { row.querySelectorAll('span').forEach(q => q.classList.remove('sel')); s.classList.add('sel'); DRAFT.colors[part] = hex; prev(); }; row.append(s); }
      pals.append(row);
    }
    prev();
  });
  function prev() { document.getElementById('charPrev').src = charThumb(DRAFT.model, DRAFT.colors, 256); }
}
function fillKeys() {
  const L2 = document.getElementById('keyList'); L2.innerHTML = '';
  for (const [id, lab, def] of KEYACT) {
    const b = document.createElement('button'); b.textContent = keyLabel(KEYMAP[id] || def);
    b.onclick = () => { b.classList.add('wait'); b.textContent = '…'; const h = (e) => { e.preventDefault(); e.stopImmediatePropagation(); removeEventListener('keydown', h, true); if (e.code !== 'Escape') { KEYMAP[id] = e.code; localStorage.setItem('cc_keys', JSON.stringify(KEYMAP)); } fillKeys(); }; addEventListener('keydown', h, true); };
    L2.append(Object.assign(document.createElement('span'), { textContent: lab }), b);
  }
}
function launch(free) {
  if (!WORLD_READY) { const t = document.getElementById('ldTxt'); if (t) t.textContent = '⏳ Encore un instant, la ville finit de charger… ' + Math.round(LOADP) + ' %'; LAUNCH_WAIT = free; return; }
  window.startGame(free);
}
let LAUNCH_WAIT = undefined;
function initMenuEarly() {
  if (SHOT) { document.getElementById('start').style.display = 'none'; document.body.classList.remove('menu'); return; }
  document.querySelectorAll('#start [data-go]').forEach(b => b.onclick = () => showScr(b.dataset.go));
  document.querySelectorAll('#start [data-tab]').forEach(b => b.onclick = () => { document.querySelectorAll('#start [data-tab]').forEach(q => q.classList.toggle('on', q === b)); document.querySelectorAll('#start .tab').forEach(t => t.style.display = t.id === b.dataset.tab ? 'block' : 'none'); });
  document.getElementById('titleGo').onclick = () => showScr('scrAcc');
  document.getElementById('accNext').onclick = () => showScr(CHAR ? 'scrMenu' : 'scrSex');
  document.querySelectorAll('.sexb').forEach(b => b.onclick = () => { document.querySelectorAll('.sexb').forEach(q => q.classList.toggle('sel', q === b)); DRAFT.sex = b.dataset.sex; });
  document.querySelector('#scrMenu [data-go="scrSex"]').onclick = () => { DRAFT = JSON.parse(JSON.stringify(CHAR || {})); showScr('scrSex'); syncSex(); };
  const syncSex = () => { DRAFT = DRAFT || { sex: 'h', colors: {} }; document.querySelectorAll('.sexb').forEach(q => q.classList.toggle('sel', q.dataset.sex === DRAFT.sex)); document.getElementById('charName').value = DRAFT.name || ''; };
  DRAFT = CHAR ? JSON.parse(JSON.stringify(CHAR)) : { sex: 'h', colors: {} }; syncSex();
  document.getElementById('sexOk').onclick = () => { DRAFT.name = document.getElementById('charName').value.trim() || (DRAFT.sex === 'f' ? 'Joueuse' : 'Joueur'); showScr('scrBody'); };
  document.getElementById('bodyOk').onclick = () => { if (DRAFT.body) showScr('scrStyle'); };
  document.getElementById('styleOk').onclick = () => {
    if (!DRAFT.model) return; const first = !CHAR; CHAR = JSON.parse(JSON.stringify(DRAFT)); localStorage.setItem('cc_char', JSON.stringify(CHAR));
    if (WORLD_READY) setPlayerModel(CHAR.model, CHAR.colors);
    if (first) launch(false); else showScr('scrMenu');
  };
  document.getElementById('btnSet').onclick = () => { setReturn = 'scrMenu'; showScr('scrSet'); };
  document.getElementById('setBack').onclick = () => { if (setReturn === 'pause') { document.getElementById('start').style.display = 'none'; document.getElementById('pause').classList.add('on'); window.PAUSED = true; } else showScr(setReturn); };
  document.getElementById('keyReset').onclick = () => { KEYMAP = {}; localStorage.removeItem('cc_keys'); fillKeys(); };
  const vol = document.getElementById('volAll'); vol.value = localStorage.getItem('cc_vol') || 80; vol.oninput = () => localStorage.setItem('cc_vol', vol.value);
  document.querySelector('#scrMenu .btn.go').onclick = () => launch(false);
  document.querySelector('#scrMenu [onclick="startGame(true)"]').onclick = () => launch(true);
  document.getElementById('btnOnline').onclick = () => {
    if (!sbUser) { showScr('scrAcc'); document.getElementById('accStatus').textContent = 'Connecte-toi (ou crée un compte) pour jouer en ligne'; return; }
    launch(false); setTimeout(() => game.on && banner('🌐 En ligne : ta partie est synchronisée sur ton compte', 3000), 500);
  };
  document.getElementById('btnQuit').onclick = () => { if (game.started) saveGame(true); try { window.close(); } catch (e) {} document.getElementById('menuWho').textContent = '💾 Partie sauvegardée — tu peux fermer cet onglet.'; };
  document.getElementById('pResume').onclick = () => { document.getElementById('pause').classList.remove('on'); window.PAUSED = false; };
  document.getElementById('pSave').onclick = () => { saveGame(); banner('💾 Partie sauvegardée', 1400); };
  document.getElementById('pSet').onclick = () => { document.getElementById('pause').classList.remove('on'); setReturn = 'pause'; document.getElementById('start').style.display = 'flex'; showScr('scrSet'); };
  document.getElementById('pMenu').onclick = () => { saveGame(true); document.getElementById('pause').classList.remove('on'); window.PAUSED = false; game.on = false; document.getElementById('hud').style.display = 'none'; document.getElementById('start').style.display = 'flex'; document.body.classList.add('menu'); showScr('scrMenu'); };
  loadProgress(1);
}
function onWorldReady() {
  WORLD_READY = true; loadProgress(100, 'Ville prête'); const ld = document.getElementById('ld'); if (ld) setTimeout(() => ld.classList.add('done'), 800);
  if (CHAR && CHAR.model) setPlayerModel(CHAR.model, CHAR.colors);
  if (LAUNCH_WAIT !== undefined) { const f = LAUNCH_WAIT; LAUNCH_WAIT = undefined; window.startGame(f); }
}
function togglePause() { const p = document.getElementById('pause'); const on = !p.classList.contains('on'); p.classList.toggle('on', on); window.PAUSED = on; if (on) { keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); } }
