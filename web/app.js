/* ═══════════════════════════════════════════════════════════
   GUNPLA REGISTRY — client
   Loads the full collection once, then filters/sorts/searches
   client-side. A personal stash is dozens of kits, not
   thousands, so round-tripping the API per keystroke would
   cost latency and buy nothing.
   ═══════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);

const GRADE_ORDER = { PG: 0, MG: 1, RG: 2, HG: 3, SD: 4, Other: 5 };

// Scale is a property of the grade, not something worth typing every time.
// SD is non-scale by definition; Other is unknowable.
const GRADE_SCALE = { HG: '1/144', RG: '1/144', MG: '1/100', PG: '1/60', SD: '', Other: '' };
const AUTO_SCALES = new Set(Object.values(GRADE_SCALE).filter(Boolean));
const STATUS_LABEL = { wishlist: 'WISHLIST', owned: 'STASH', building: 'BUILDING', built: 'BUILT' };

let KITS = [];
let filterStatus = '';
let searchTerm = '';
let sortMode = 'recent';
let detailId = null;
let pendingFile = null;
let pendingArtUrl = null;   // wiki image to import once the kit row exists

const peso = (n) =>
  n === null || n === undefined || n === ''
    ? '—'
    : '₱' + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 0 });

const pesoExact = (n) =>
  n === null || n === undefined
    ? '—'
    : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Every call funnels through here, so one check covers session expiry
    // across the whole app.
    if (res.status === 401) {
      showGate('SESSION EXPIRED — SIGN IN AGAIN');
      throw new Error('SESSION EXPIRED');
    }
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ─────────── toasts ─────────── */

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' toast--err' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function guard(fn) {
  try { await fn(); }
  catch (err) { toast(err.message || 'OPERATION FAILED', true); }
}

/* ─────────── confirm dialog ─────────── */

let confirmResolve = null;
function confirmDialog(msg) {
  $('confirm-msg').textContent = msg;
  openModal($('confirm-backdrop'));
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function settleConfirm(val) {
  closeModal($('confirm-backdrop'));
  if (confirmResolve) { confirmResolve(val); confirmResolve = null; }
}
$('confirm-yes').addEventListener('click', () => settleConfirm(true));
$('confirm-no').addEventListener('click', () => settleConfirm(false));

/* ─────────── modal plumbing ─────────── */

let lastFocus = null;

function openModal(el) {
  lastFocus = document.activeElement;
  el.classList.add('open');
  const first = el.querySelector('input:not([type=hidden]), button, select, textarea');
  if (first) setTimeout(() => first.focus(), 40);
}
function closeModal(el) {
  el.classList.remove('open');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
function anyModalOpen() { return document.querySelector('.backdrop.open'); }

document.querySelectorAll('.backdrop').forEach((bd) => {
  bd.addEventListener('mousedown', (e) => {
    if (e.target !== bd) return;
    // The access gate is the one modal you can't click your way out of.
    if (bd.id === 'auth-backdrop') return;
    if (bd.id === 'confirm-backdrop') { settleConfirm(false); return; }
    closeModal(bd);
  });
});

/* ─────────── data load + render ─────────── */

async function loadAll() {
  KITS = await api('/api/kits');
  renderStats();
  renderGrid();
}

function renderStats() {
  const by = { wishlist: 0, owned: 0, building: 0, built: 0 };
  let spent = 0, wishValue = 0;
  for (const k of KITS) {
    by[k.status] = (by[k.status] || 0) + 1;
    if (k.status !== 'wishlist' && k.price_paid) spent += k.price_paid;
    if (k.status === 'wishlist' && k.price_msrp) wishValue += k.price_msrp;
  }
  $('stat-total').textContent = KITS.length;
  $('stat-backlog').textContent = by.owned;
  $('stat-building').textContent = by.building;
  $('stat-built').textContent = by.built;
  $('stat-spent').textContent = peso(spent);
  $('stat-wishlist').textContent = peso(wishValue);

  $('c-all').textContent = KITS.length;
  for (const s of ['wishlist', 'owned', 'building', 'built']) $('c-' + s).textContent = by[s];

  // Clear rate = built / kits actually acquired (wishlist isn't a backlog yet)
  const owned = KITS.length - by.wishlist;
  const pct = owned ? Math.round((by.built / owned) * 100) : 0;
  $('clear-rate-pct').textContent = owned ? `${pct}%  (${by.built}/${owned})` : '—';
  $('clear-rate-fill').style.width = pct + '%';
}

function visibleKits() {
  let list = KITS.slice();
  if (filterStatus) list = list.filter((k) => k.status === filterStatus);
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter((k) =>
      [k.name, k.series, k.grade, k.scale, k.store, k.notes]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  const cmp = {
    recent: (a, b) => b.id - a.id,
    name: (a, b) => a.name.localeCompare(b.name),
    grade: (a, b) => (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9) || a.name.localeCompare(b.name),
    'price-desc': (a, b) => (b.price_paid ?? b.price_msrp ?? 0) - (a.price_paid ?? a.price_msrp ?? 0),
    'price-asc': (a, b) => (a.price_paid ?? a.price_msrp ?? 0) - (b.price_paid ?? b.price_msrp ?? 0),
  }[sortMode];
  return list.sort(cmp);
}

function renderGrid() {
  const list = visibleKits();
  const grid = $('grid');
  grid.innerHTML = '';

  if (!list.length) {
    $('empty').hidden = false;
    if (!KITS.length) {
      $('empty-msg').textContent = 'NO UNITS IN REGISTRY';
      $('empty-sub').textContent = 'Deploy your first kit to begin the log.';
    } else {
      $('empty-msg').textContent = 'NO MATCHING UNITS';
      $('empty-sub').textContent = 'Adjust the filter or search query.';
    }
    return;
  }
  $('empty').hidden = true;

  list.forEach((kit, i) => grid.appendChild(card(kit, i)));
}

function card(kit, i) {
  const node = $('card-tpl').content.cloneNode(true);
  const art = node.querySelector('.card');
  art.classList.add('g-' + kit.grade, 's-' + kit.status);
  art.style.animationDelay = Math.min(i * 22, 320) + 'ms';
  art.setAttribute('aria-label', `${kit.name}, ${kit.grade}, ${STATUS_LABEL[kit.status]}`);

  const img = node.querySelector('.card__img');
  if (kit.thumbnail) {
    img.src = kit.thumbnail;
    img.alt = kit.name;
    img.onload = () => img.classList.add('on');
  }

  node.querySelector('.card__grade').textContent = kit.grade;
  node.querySelector('.card__photos').textContent = kit.photo_count > 1 ? `▣ ${kit.photo_count}` : '';
  node.querySelector('.card__name').textContent = kit.name;
  node.querySelector('.card__meta').textContent =
    [kit.scale, kit.series].filter(Boolean).join(' · ') || '—';
  node.querySelector('.card__status em').textContent = STATUS_LABEL[kit.status];
  node.querySelector('.card__price').textContent =
    kit.status === 'wishlist' ? peso(kit.price_msrp) : peso(kit.price_paid);

  art.addEventListener('click', () => openDetail(kit.id));
  art.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(kit.id); }
  });
  return node;
}

/* ─────────── filters ─────────── */

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t === btn);
    t.setAttribute('aria-selected', t === btn ? 'true' : 'false');
  });
  filterStatus = btn.dataset.status;
  renderGrid();
});

$('search').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderGrid(); });
$('sort').addEventListener('change', (e) => { sortMode = e.target.value; renderGrid(); });

/* ─────────── segmented status controls ─────────── */

function wireSegmented(seg, onPick) {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setSegmented(seg, btn.dataset.val);
    if (onPick) onPick(btn.dataset.val);
  });
}
function setSegmented(seg, val) {
  seg.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-checked', b.dataset.val === val ? 'true' : 'false'));
}

wireSegmented($('f-status-seg'), (val) => { $('f-status').value = val; });
wireSegmented($('d-status-seg'), (val) => {
  guard(async () => {
    await api(`/api/kits/${detailId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: val }),
    });
    toast(`STATUS → ${STATUS_LABEL[val]}`);
    await loadAll();
    await openDetail(detailId, true);
  });
});

/* ─────────── kit form ─────────── */

function openForm(kit) {
  $('kit-form').reset();
  clearLookupResults();
  clearPickedArt();
  $('f-id').value = kit ? kit.id : '';
  $('kit-title').textContent = kit ? 'EDIT UNIT' : 'DEPLOY NEW UNIT';
  $('btn-delete').hidden = !kit;

  const status = kit ? kit.status : 'wishlist';
  $('f-status').value = status;
  setSegmented($('f-status-seg'), status);

  if (kit) {
    $('f-name').value = kit.name || '';
    $('f-grade').value = kit.grade || 'Other';
    $('f-scale').value = kit.scale || '';
    $('f-series').value = kit.series || '';
    $('f-msrp').value = kit.price_msrp ?? '';
    $('f-paid').value = kit.price_paid ?? '';
    $('f-store').value = kit.store || '';
    $('f-date').value = kit.date_acquired || '';
    $('f-notes').value = kit.notes || '';
  }
  openModal($('kit-backdrop'));
}

/* ─────────── grade → scale ─────────── */

// Only overwrite a scale the user hasn't personally chosen: blank, or still
// carrying another grade's canonical value.
$('f-grade').addEventListener('change', (e) => {
  const scale = $('f-scale');
  const cur = scale.value.trim();
  if (cur === '' || AUTO_SCALES.has(cur)) scale.value = GRADE_SCALE[e.target.value] ?? '';
});

/* ─────────── wiki lookup ─────────── */

function clearLookupResults() {
  const box = $('lookup-results');
  box.hidden = true;
  box.innerHTML = '';
}

function clearPickedArt() {
  pendingArtUrl = null;
  $('lookup-picked').hidden = true;
}

$('lookup-clear').addEventListener('click', clearPickedArt);

$('btn-lookup').addEventListener('click', () => {
  const q = $('f-name').value.trim();
  const box = $('lookup-results');
  if (q.length < 2) { toast('TYPE A NAME TO SEARCH', true); return; }

  box.hidden = false;
  box.innerHTML = '<div class="lookup-results__msg">SCANNING ARCHIVE…</div>';

  guard(async () => {
    let hits;
    try {
      hits = await api('/api/lookup?q=' + encodeURIComponent(q));
    } catch (err) {
      box.innerHTML = `<div class="lookup-results__msg">LOOKUP FAILED — ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (!hits.length) {
      box.innerHTML = '<div class="lookup-results__msg">NO MATCHES IN ARCHIVE</div>';
      return;
    }
    box.innerHTML = '';
    for (const hit of hits) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lookup-hit';
      btn.innerHTML =
        (hit.thumb
          ? `<img src="${escapeHtml(hit.thumb)}" alt="">`
          : '<span class="lookup-hit__noimg">—</span>') +
        `<span class="lookup-hit__t">${escapeHtml(hit.title)}</span>` +
        (hit.is_kit ? '<span class="lookup-hit__tag">KIT</span>' : '');
      btn.addEventListener('click', () => pickHit(hit));
      box.appendChild(btn);
    }
  });
});

function pickHit(hit) {
  const box = $('lookup-results');
  box.innerHTML = '<div class="lookup-results__msg">PULLING RECORD…</div>';

  guard(async () => {
    let d;
    try {
      d = await api(`/api/lookup/${hit.pageid}`);
    } catch (err) {
      box.innerHTML = `<div class="lookup-results__msg">FAILED — ${escapeHtml(err.message)}</div>`;
      return;
    }
    clearLookupResults();

    const filled = [];
    $('f-name').value = d.title || hit.title;
    if (d.grade)  { $('f-grade').value = d.grade;  filled.push(d.grade); }
    // Trust the wiki's scale over the grade default: SD and oddities like
    // 1/48 head busts do not follow the usual grade→scale rule.
    if (d.scale)  { $('f-scale').value = d.scale;  filled.push(d.scale); }
    else if (d.grade === 'SD') $('f-scale').value = '';
    if (d.series) { $('f-series').value = d.series; filled.push('series'); }

    // Reference data, not a peso price — JP retail differs from PH retail and
    // converting would invent a number. Never clobber notes already written.
    const notes = $('f-notes');
    if (!notes.value.trim()) {
      const bits = [];
      if (d.price_jpy) bits.push(`JP MSRP ${d.price_jpy}`);
      if (d.released) bits.push(`released ${d.released}`);
      if (d.classification) bits.push(d.classification);
      notes.value = (bits.join(' · ') + (d.url ? `\n${d.url}` : '')).trim();
    }

    // The kit may not exist yet (new unit), so hold the URL and import it
    // after save rather than uploading now.
    pendingArtUrl = d.image || hit.thumb || null;
    const picked = $('lookup-picked');
    if (pendingArtUrl) {
      picked.hidden = false;
      picked.querySelector('img').src = hit.thumb || d.image;
      picked.querySelector('span').textContent = 'BOX ART WILL BE IMPORTED ON SAVE';
    } else {
      picked.hidden = true;
    }
    toast('KIT LOADED' + (filled.length ? ` · ${filled.join(' · ')}` : ''));
  });
}

$('btn-add').addEventListener('click', () => openForm(null));
$('kit-close').addEventListener('click', () => closeModal($('kit-backdrop')));
$('btn-cancel').addEventListener('click', () => closeModal($('kit-backdrop')));

$('kit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  guard(async () => {
    const id = $('f-id').value;
    const payload = {
      name: $('f-name').value,
      grade: $('f-grade').value,
      scale: $('f-scale').value,
      series: $('f-series').value,
      status: $('f-status').value,
      price_msrp: $('f-msrp').value,
      price_paid: $('f-paid').value,
      store: $('f-store').value,
      date_acquired: $('f-date').value,
      notes: $('f-notes').value,
    };
    const opts = {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
    const saved = await api(id ? `/api/kits/${id}` : '/api/kits', opts);
    closeModal($('kit-backdrop'));
    toast(id ? 'UNIT UPDATED' : 'UNIT DEPLOYED');

    // Import wiki art only after the row exists. A failure here must not read
    // as "the kit didn't save" — it did.
    if (pendingArtUrl) {
      const url = pendingArtUrl;
      clearPickedArt();
      try {
        await api(`/api/kits/${saved.id || id}/photos/from-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, caption: 'official art', is_box_art: true }),
        });
        toast('OFFICIAL ART IMPORTED');
      } catch (err) {
        toast('SAVED, BUT ART IMPORT FAILED', true);
      }
    }

    await loadAll();
    if (id && detailId) await openDetail(Number(id), true);
  });
});

$('btn-delete').addEventListener('click', () => {
  guard(async () => {
    const id = $('f-id').value;
    const kit = KITS.find((k) => k.id === Number(id));
    const ok = await confirmDialog(
      `Decommission "${kit ? kit.name : 'this unit'}"? This deletes the record and all its photos permanently.`);
    if (!ok) return;
    await api(`/api/kits/${id}`, { method: 'DELETE' });
    closeModal($('kit-backdrop'));
    closeModal($('detail-backdrop'));
    detailId = null;
    toast('UNIT DECOMMISSIONED');
    await loadAll();
  });
});

/* ─────────── detail view ─────────── */

async function openDetail(id, keepOpen = false) {
  detailId = id;
  const kit = await api(`/api/kits/${id}`);

  $('d-name').textContent = kit.name;
  const gt = $('d-grade');
  gt.textContent = kit.grade;
  gt.className = 'grade-tag g-' + kit.grade;
  const sc = $('d-status');
  sc.textContent = STATUS_LABEL[kit.status];
  sc.className = 'status-chip s-' + kit.status;

  $('d-specs').innerHTML = [
    ['SCALE', kit.scale || '—'],
    ['SERIES', kit.series || '—'],
    ['MSRP', pesoExact(kit.price_msrp)],
    ['PAID', pesoExact(kit.price_paid)],
    ['STORE', kit.store || '—'],
    ['ACQUIRED', kit.date_acquired || '—'],
    ['NOTES', kit.notes || '—'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');

  setSegmented($('d-status-seg'), kit.status);
  renderPhotos(kit.photos);
  resetDropzone();

  $('btn-price').href =
    'https://www.google.com/search?q=' + encodeURIComponent(kit.name + ' gunpla price philippines');
  $('btn-edit').onclick = () => openForm(kit);

  if (!keepOpen) openModal($('detail-backdrop'));
}

$('detail-close').addEventListener('click', () => { closeModal($('detail-backdrop')); detailId = null; });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPhotos(photos) {
  const wrap = $('photos');
  wrap.innerHTML = '';
  if (!photos.length) {
    wrap.innerHTML = '<p style="font-size:10px;letter-spacing:.14em;color:var(--text-3);grid-column:1/-1;margin:0 0 .2rem">NO IMAGES ON FILE</p>';
    return;
  }
  for (const p of photos) {
    const div = document.createElement('div');
    div.className = 'photo';
    div.innerHTML =
      `<img src="${p.url}" alt="${escapeHtml(p.caption || 'kit photo')}">` +
      (p.is_box_art ? '<span class="photo__flag">BOX ART</span>' : '') +
      '<button class="photo__del" type="button" aria-label="Delete photo">✕</button>';

    div.querySelector('img').addEventListener('click', () => {
      $('lightbox-img').src = p.url;
      $('lightbox-cap').textContent = p.caption || '';
      openModal($('lightbox'));
    });
    div.querySelector('.photo__del').addEventListener('click', (e) => {
      e.stopPropagation();
      guard(async () => {
        const ok = await confirmDialog('Delete this image from the visual record?');
        if (!ok) return;
        await api(`/api/photos/${p.id}`, { method: 'DELETE' });
        toast('IMAGE PURGED');
        await loadAll();
        await openDetail(detailId, true);
      });
    });
    wrap.appendChild(div);
  }
}

$('lightbox-close').addEventListener('click', () => closeModal($('lightbox')));

/* ─────────── photo upload: click / drop / paste ─────────── */

const dropzone = $('dropzone');
const fileInput = $('photo-file');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => setPending(fileInput.files[0]));

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('hot'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('hot'); }));
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) setPending(f);
});

document.addEventListener('paste', (e) => {
  if (!$('detail-backdrop').classList.contains('open')) return;
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (item) setPending(item.getAsFile());
});

function setPending(file) {
  if (!file || !file.type.startsWith('image/')) return;
  pendingFile = file;
  const prev = $('drop-preview');
  prev.hidden = false;
  prev.querySelector('img').src = URL.createObjectURL(file);
  prev.querySelector('span').textContent =
    `${file.name || 'pasted image'} · ${(file.size / 1024).toFixed(0)} KB`;
  document.querySelector('.dropzone__hint').style.display = 'none';
  $('btn-upload').disabled = false;
}

function resetDropzone() {
  pendingFile = null;
  fileInput.value = '';
  $('photo-caption').value = '';
  $('photo-boxart').checked = false;
  $('drop-preview').hidden = true;
  document.querySelector('.dropzone__hint').style.display = '';
  $('btn-upload').disabled = true;
}

$('photo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!pendingFile) return;
  guard(async () => {
    const fd = new FormData();
    fd.append('photo', pendingFile);
    fd.append('caption', $('photo-caption').value);
    fd.append('is_box_art', $('photo-boxart').checked ? '1' : '0');
    $('btn-upload').disabled = true;
    await api(`/api/kits/${detailId}/photos`, { method: 'POST', body: fd });
    toast('IMAGE ARCHIVED');
    await loadAll();
    await openDetail(detailId, true);
  });
});

/* ─────────── keyboard shortcuts ─────────── */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const open = anyModalOpen();
    if (open) {
      if (open.id === 'auth-backdrop') return;   // not dismissible
      if (open.id === 'confirm-backdrop') settleConfirm(false);
      else { closeModal(open); if (open.id === 'detail-backdrop') detailId = null; }
    }
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (typing || anyModalOpen()) return;

  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openForm(null); }
  if (e.key === '/') { e.preventDefault(); $('search').focus(); }
});

/* ─────────── clock ─────────── */

setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('en-GB');
}, 1000);

/* ─────────── boot sequence ─────────── */

const BOOT_MS = 3750;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

function playBoot() {
  const boot = $('boot');
  document.body.classList.add('boot-active');
  boot.classList.remove('done');
  boot.classList.add('run');

  const openAt = setTimeout(() => boot.classList.add('open'), 2900);
  const endAt = setTimeout(endBoot, BOOT_MS);

  function endBoot() {
    clearTimeout(openAt); clearTimeout(endAt);
    boot.classList.remove('run', 'open');
    boot.classList.add('done');
    document.body.classList.remove('boot-active');
  }
  $('boot-skip').onclick = endBoot;
  const skipKeys = (e) => {
    if (['Escape', ' ', 'Enter'].includes(e.key)) { endBoot(); document.removeEventListener('keydown', skipKeys); }
  };
  document.addEventListener('keydown', skipKeys);
}

$('replay-boot').addEventListener('click', () => {
  // Re-inserting a pristine clone restarts every CSS animation for free.
  const boot = $('boot');
  const fresh = boot.cloneNode(true);
  boot.replaceWith(fresh);
  playBoot();
});

function maybePlayBoot() {
  // Once per browser session — an opening when you sit down, not a
  // replay on every refresh while you're logging kits.
  if (reduced || sessionStorage.getItem('booted')) return;
  sessionStorage.setItem('booted', '1');
  playBoot();
}

/* ─────────── auth ─────────── */

let authMode = 'login';   // or 'signup'

function authError(msg) {
  const el = $('auth-err');
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = msg;
  el.hidden = false;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('auth-title').textContent = signup ? 'PILOT REGISTRATION' : 'PILOT AUTHENTICATION';
  $('auth-blurb').textContent = signup
    ? 'Pick a callsign and an access code. No email, no confirmation — you are in as soon as you register.'
    : "Identify yourself to open your hangar. Each pilot's registry is their own.";
  $('auth-submit').textContent = signup ? '▸ REGISTER' : '▸ AUTHENTICATE';
  $('auth-toggle').textContent = signup ? 'HAVE AN ACCOUNT?' : 'NEED AN ACCOUNT?';
  $('a-invite-field').hidden = !signup;
  $('a-password').autocomplete = signup ? 'new-password' : 'current-password';
  authError('');
}

function showGate(msg) {
  $('topbar-pilot').hidden = true;
  $('btn-logout').hidden = true;
  // Nothing behind the gate should be readable once the session is gone.
  KITS = [];
  renderStats();
  renderGrid();
  document.querySelectorAll('.backdrop.open').forEach((bd) => bd.classList.remove('open'));
  $('auth-backdrop').classList.add('open');
  authError(msg || '');
  setTimeout(() => $('a-username').focus(), 40);
}

function hideGate() {
  $('auth-backdrop').classList.remove('open');
  $('auth-form').reset();
  authError('');
}

async function enter(user) {
  const callsign = (user.display_name || user.username).toUpperCase();
  $('boot-pilot').textContent = callsign;
  $('topbar-pilot').textContent = callsign;
  $('topbar-pilot').hidden = false;
  $('btn-logout').hidden = false;
  hideGate();
  maybePlayBoot();
  await loadAll();
}

$('auth-toggle').addEventListener('click', () => {
  setAuthMode(authMode === 'login' ? 'signup' : 'login');
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  const username = $('a-username').value.trim();
  const password = $('a-password').value;
  if (!username || !password) return;

  const body = { username, password };
  if (authMode === 'signup') {
    const code = $('a-invite').value.trim();
    if (code) body.code = code;
  }

  btn.disabled = true;
  authError('');
  try {
    const res = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { authError(data.error || `HTTP ${res.status}`); return; }
    await enter(data);
    toast(authMode === 'signup' ? 'HANGAR REGISTERED' : 'LINK ESTABLISHED');
  } catch (err) {
    authError(err.message || 'CONNECTION FAILED');
  } finally {
    btn.disabled = false;
  }
});

$('btn-logout').addEventListener('click', async () => {
  // Only the boot animation is per-session; clearing this means the next
  // pilot to sign in on this browser gets the opening too.
  sessionStorage.removeItem('booted');
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    setAuthMode('login');
    showGate('');
  }
});

/* ─────────── go ─────────── */

async function start() {
  setAuthMode('login');
  let user = null;
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) user = await res.json();
  } catch {
    // offline or the Worker is down; the gate explains itself below
  }

  if (!user) { showGate(''); return; }
  await guard(() => enter(user));
}

start();
