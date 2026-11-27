// ================================================================ MAIN MENU: account → character → solo / online / settings / quit, pause menu, key remapping
const KEYACT = [['forward', 'Avancer', 'KeyW'], ['back', 'Reculer', 'KeyS'], ['left', 'Gauche', 'KeyA'], ['right', 'Droite', 'KeyD'], ['run', 'Courir', 'ShiftLeft'], ['jump', 'Sauter / freiner', 'Space'],
  ['action', 'Action', 'KeyE'], ['inv', 'Inventaire', 'KeyI'], ['phone', 'Téléphone', 'KeyT'], ['cam', 'Caméra libre', 'KeyC'], ['map', 'Minicarte', 'KeyM'], ['water', 'Arroser (pompier)', 'KeyF']];
let KEYMAP = {}; try { KEYMAP = JSON.parse(localStorage.getItem('cc_keys') || '{}'); } catch (e) {}
const keyLabel = (c) => c.replace(/^Key/, '').replace(/^Digit/, '').replace('ShiftLeft', 'Maj').replace('Space', 'Espace').replace('ControlLeft', 'Ctrl').replace('Arrow', '↑→↓←'.includes ? 'Flèche ' : '');
// translate the player's chosen key into the default code the game listens to (capture phase, before every other handler)
for (const type of ['keydown', 'keyup']) addEventListener(type, (e) => {
  if (e._cc || document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const act = KEYACT.find(a => KEYMAP[a[0]] && KEYMAP[a[0]] === e.code && a[2] !== e.code); if (!act) return;
  e.stopImmediatePropagation(); e.preventDefault(); const ev = new KeyboardEvent(type, { code: act[2], key: e.key, bubbles: true }); ev._cc = 1; (document.activeElement || document.body).dispatchEvent(ev);
}, true);
let CHAR = null; try { CHAR = JSON.parse(localStorage.getItem('cc_char') || 'null'); } catch (e) {}
function setPlayerModel(name) {
  if (!skinned[name] || !player.ch) return;
  const pos = player.ch.o.position.clone(), rot = player.ch.o.rotation.y, old = player.ch;
  old.o.parent && old.o.parent.remove(old.o); const i = mixers.indexOf(old.mixer); if (i >= 0) mixers.splice(i, 1);
  player.ch = makeChar(name); player.ch.o.position.copy(pos); player.ch.o.rotation.y = rot; player.actions = {}; player.cur = null;
  for (const k of ['Idle_A-loop', 'Walk_A-loop', 'Runing_A-loop', 'Jump_B_InAir-loop']) if (clips[k]) player.actions[k] = player.ch.mixer.clipAction(clips[k]);
  setAnim('Idle_A-loop', 0); player.ch.bones = null; updateCarry();
}
const CHAR_THUMB = {};
function charThumb(name) {
  if (CHAR_THUMB[name]) return CHAR_THUMB[name];
  if (!thumbRT) itemThumb('__init__');
  const o = SkeletonUtils.clone(skinned[name]); thumbScene.add(o);
  if (clips['Idle_A-loop']) { const mx = new THREE.AnimationMixer(o); mx.clipAction(clips['Idle_A-loop']).play(); mx.update(0.3); }
  o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o), c = b.getCenter(new THREE.Vector3()), h = b.max.y - b.min.y || 1.6;
  thumbCam.position.set(c.x + h * 0.35, c.y + h * 0.25, c.z + h * 1.55); thumbCam.lookAt(c.x, c.y + h * 0.05, c.z); thumbCam.near = 0.05; thumbCam.far = 50; thumbCam.updateProjectionMatrix();
  const prev = renderer.getRenderTarget(); renderer.setRenderTarget(thumbRT); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(thumbScene, thumbCam);
  const px = new Uint8Array(128 * 128 * 4); renderer.readRenderTargetPixels(thumbRT, 0, 0, 128, 128, px); renderer.setRenderTarget(prev); thumbScene.remove(o);
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g = cv.getContext('2d'), im = g.createImageData(128, 128);
  for (let y = 0; y < 128; y++) im.data.set(px.subarray((127 - y) * 512, (128 - y) * 512), y * 512); g.putImageData(im, 0, 0);
  return CHAR_THUMB[name] = cv.toDataURL();
}
let setReturn = 'scrMenu';
function showScr(id) {
  document.querySelectorAll('#start .scr').forEach(s => s.classList.toggle('on', s.id === id));
  if (id === 'scrChar') fillChars(); if (id === 'scrSet') fillKeys(); if (id === 'scrMenu') menuWho();
}
function menuWho() { const w = document.getElementById('menuWho'); if (w) w.textContent = (CHAR ? '🧍 ' + (CHAR.name || 'Joueur') : '') + (sbUser ? ' · ☁️ ' + sbUser.email : ' · 💾 sauvegarde locale'); }
function fillChars() {
  const g = document.getElementById('charGrid'); if (g.childElementCount) return; let sel = CHAR && CHAR.model || 'Character_1_1_1';
  document.getElementById('charName').value = CHAR && CHAR.name || '';
  for (const n of Object.keys(skinned).filter(n => !/_Z_/.test(n) && !/^PoliceMan/.test(n)).sort()) {
    const d = document.createElement('div'); d.innerHTML = '<img src="' + charThumb(n) + '">'; d.className = n === sel ? 'sel' : '';
    d.onclick = () => { g.querySelectorAll('div').forEach(q => q.classList.remove('sel')); d.classList.add('sel'); sel = n; }; d.dataset.n = n; g.append(d);
  }
  document.getElementById('charOk').onclick = () => {
    const name = document.getElementById('charName').value.trim() || 'Joueur'; const s = g.querySelector('.sel'); CHAR = { name, model: s ? s.dataset.n : sel };
    localStorage.setItem('cc_char', JSON.stringify(CHAR)); setPlayerModel(CHAR.model); showScr('scrMenu');
  };
}
function fillKeys() {
  const L2 = document.getElementById('keyList'); L2.innerHTML = '';
  for (const [id, lab, def] of KEYACT) {
    const b = document.createElement('button'); b.textContent = keyLabel(KEYMAP[id] || def);
    b.onclick = () => { b.classList.add('wait'); b.textContent = '…'; const h = (e) => { e.preventDefault(); e.stopImmediatePropagation(); removeEventListener('keydown', h, true); if (e.code !== 'Escape') { KEYMAP[id] = e.code; localStorage.setItem('cc_keys', JSON.stringify(KEYMAP)); } fillKeys(); }; addEventListener('keydown', h, true); };
    L2.append(Object.assign(document.createElement('span'), { textContent: lab }), b);
  }
}
function initMenu() {
  document.querySelectorAll('#start [data-go]').forEach(b => b.onclick = () => showScr(b.dataset.go));
  document.querySelectorAll('#start [data-tab]').forEach(b => b.onclick = () => { document.querySelectorAll('#start [data-tab]').forEach(q => q.classList.toggle('on', q === b)); document.querySelectorAll('#start .tab').forEach(t => t.style.display = t.id === b.dataset.tab ? 'block' : 'none'); });
  document.querySelector('#start [data-go="scrSet"]').onclick = () => { setReturn = 'scrMenu'; showScr('scrSet'); };
  document.getElementById('setBack').onclick = () => { if (setReturn === 'pause') { document.getElementById('start').style.display = 'none'; document.getElementById('pause').classList.add('on'); } else showScr(setReturn); };
  document.getElementById('accNext').onclick = () => showScr(CHAR ? 'scrMenu' : 'scrChar');
  document.getElementById('keyReset').onclick = () => { KEYMAP = {}; localStorage.removeItem('cc_keys'); fillKeys(); };
  const vol = document.getElementById('volAll'); vol.value = localStorage.getItem('cc_vol') || 80; vol.oninput = () => localStorage.setItem('cc_vol', vol.value);
  document.getElementById('btnOnline').onclick = () => {
    if (!sbUser) { showScr('scrAcc'); document.getElementById('accStatus').textContent = 'Connecte-toi (ou crée un compte) pour jouer en ligne'; return; }
    cloudPull && cloudPull(); window.startGame(false); banner('🌐 En ligne : ta partie est synchronisée sur ton compte', 3000);
  };
  document.getElementById('btnQuit').onclick = () => { if (game.started) saveGame(true); try { window.close(); } catch (e) {} document.getElementById('menuWho').textContent = '💾 Partie sauvegardée — tu peux fermer cet onglet.'; };
  document.getElementById('pResume').onclick = () => document.getElementById('pause').classList.remove('on');
  document.getElementById('pSave').onclick = () => { saveGame(); banner('💾 Partie sauvegardée', 1400); };
  document.getElementById('pSet').onclick = () => { document.getElementById('pause').classList.remove('on'); setReturn = 'pause'; document.getElementById('start').style.display = 'flex'; showScr('scrSet'); };
  document.getElementById('pMenu').onclick = () => { saveGame(true); document.getElementById('pause').classList.remove('on'); game.on = false; document.getElementById('hud').style.display = 'none'; document.getElementById('start').style.display = 'flex'; showScr('scrMenu'); };
  if (CHAR && CHAR.model) setPlayerModel(CHAR.model);
  showScr('scrAcc');
}
function togglePause() { const p = document.getElementById('pause'); const on = !p.classList.contains('on'); p.classList.toggle('on', on); if (on) { keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); } }
