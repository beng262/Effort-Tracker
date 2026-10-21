// Effort Tracker front end. Plain modules, no build step. All text goes in through textContent, never innerHTML.

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
let me = null;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** The server restarts for a few seconds after every update: wait for it instead of showing "Failed to fetch". */
let netBar = null;
function showNet(on) {
  if (on && !netBar) { netBar = h('div', { class: 'netbar', role: 'status' }, h('span', { class: 'spinner' }), 'Bağlantı yeniden kuruluyor…'); document.body.append(netBar); }
  if (!on && netBar) { netBar.remove(); netBar = null; }
}
async function fetchRetry(path, opts) {
  const idempotent = !opts.method || opts.method === 'GET';
  const waits = idempotent ? [800, 1600, 3200, 6400, 8000] : [1500, 4000];
  for (let attempt = 0; ; attempt++) {
    try { const r = await fetch(path, opts); if (r.status !== 502 && r.status !== 503 && r.status !== 504) { showNet(false); return r; } if (attempt >= waits.length) { showNet(false); return r; } }
    catch (e) { if (attempt >= waits.length) { showNet(false); throw new Error('Sunucuya ulaşılamıyor. Birkaç saniye sonra yeniden deneyin.'); } }
    showNet(true);
    await new Promise((ok) => setTimeout(ok, waits[attempt]));
  }
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetchRetry(path, opts);
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : null;
  if (r.status === 401) { me = null; await boot(); throw new Error('Oturum gerekli'); }
  if (!r.ok) { const e = new Error(data?.error || `Hata ${r.status}`); e.status = r.status; e.data = data; throw e; }
  return data;
}

const CATEGORIES = ['SLA', 'Proje', 'Satış Destek', 'Teknik Çözüm / Ar-Ge', 'İç Operasyon', 'Eğitim / Gelişim'];
const catChip = (c) => (c ? h('span', { class: 'chip cat-' + Math.max(0, CATEGORIES.indexOf(c)) }, c) : null);
const linkChip = (kind, text) => h('span', { class: 'chip ' + ({ itsm: 'info', planner: 'good', project: 'violet' }[kind] || '') }, text);
const linkLabel = (k) => ({ itsm: 'ITSM', project: 'Plan', planner: 'Planner' }[k] || k);
const fmtH = (n) => (n === null || n === undefined ? '–' : String(n).replace('.', ','));
const fmtDate = (iso) => (iso ? `${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '–');
const DAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const FLAG_TEXT = {
  future_date: 'gelecek tarih', over_10h_day: 'günde 10 saat üstü', weekend: 'hafta sonu', duplicate: 'tekrar', closed_period: 'kapalı dönem',
  no_date: 'tarih yok', not_quarter_hour: 'çeyrek saat değil', name_mismatch: 'çalışan adı sizinle uyuşmuyor', unknown_category: 'kategori geçersiz ya da boş', no_customer: 'müşteri / iç çalışma yok', no_effort: 'efor yok', number_not_in_source: 'sayı kaynakta yok', low_confidence: 'düşük güven', zero_effort: 'sıfır efor',
};
const BLOCKING = ['no_date', 'no_effort', 'zero_effort', 'number_not_in_source', 'closed_period', 'duplicate'];
const flagChips = (flags) => (flags || []).map((f) => h('span', { class: 'chip ' + (BLOCKING.includes(f) ? 'bad' : 'warn') }, FLAG_TEXT[f] || f));

/* ---------- theme: follows the system until the person picks one ---------- */

function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  return set || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function themeLabel() { return currentTheme() === 'dark' ? 'Açık tema' : 'Koyu tema'; }
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('efor.theme', next); } catch { /* private mode: the choice just lasts for this visit */ }
  renderNav(location.hash.split('/')[1] || 'hafta');
}
try { const t = localStorage.getItem('efor.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch { /* ignore */ }

/** replaceChildren that skips null/false instead of printing them. */
const add = (...kids) => app.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
function msg(kind, text) { return h('div', { class: kind }, text); }
async function guard(host, fn) {
  try { return await fn(); } catch (e) { host.prepend(msg('err', e.message)); }
}

/* ---------- small UI helpers: icons and toasts ---------- */

const ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  filePlus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  paperclip: '<path d="M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  ticket: '<path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z"/><path d="M13 5v14" stroke-dasharray="2 3"/>',
};
/** Static, trusted SVG paths only; no user text ever goes through here. */
function icon(name, size = 18) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s;
}

let toastTimer;
/** A short message that fades by itself. An optional action ({label, run}) adds a button, e.g. undo. */
function toast(text, kind = 'ok', action = null) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
  t.className = 'toast ' + kind;
  t.replaceChildren(h('span', {}, text));
  if (action) t.append(h('button', { class: 'action', onclick: async () => { t.classList.remove('show'); await action.run(); } }, action.label));
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 8000 : kind === 'err' ? 6000 : 3200);
}

/* ---------- shell ---------- */

// [route id, label, minimum role, icon]
const ROUTES = [
  ['hafta', 'Haftam', 'Employee', 'calendar'], ['dosya', 'Dosyadan Ekle', 'Employee', 'filePlus'], ['asistan', 'Asistan', 'Employee', 'sparkles'],
  ['biletler', 'Biletler', 'Employee', 'ticket'], ['raporlar', 'Raporlar', 'Employee', 'chart'], ['projeler', 'Projeler', 'PM', 'folder'], ['yonetim', 'Yönetim', 'Admin', 'shield'], ['rehber', 'Rehber', 'Employee', 'info'],
];
// Old bookmarks keep working after the renames.
const ALIAS = { yukle: 'dosya', sohbet: 'asistan' };
const RANK = { Employee: 0, PM: 1, Admin: 2 };
const ROLE_TR = { Employee: 'Çalışan', PM: 'Proje yöneticisi', Admin: 'Yönetici' };

function renderNav(current) {
  const nav = $('#nav');
  nav.replaceChildren(...ROUTES.filter(([, , r]) => me && RANK[me.role] >= RANK[r]).map(([id, label, , ic]) =>
    h('a', { href: '#/' + id, class: current === id ? 'on' : '', 'aria-current': current === id ? 'page' : null }, icon(ic, 17), h('span', {}, label))));
  $('#who').replaceChildren(...(me ? [
    h('button', { class: 'theme', title: 'Açık / koyu tema', onclick: toggleTheme }, themeLabel()),
    h('span', { class: 'me' }, h('strong', {}, me.name), h('span', { class: 'muted' }, ROLE_TR[me.role] || me.role)),
    h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await fetch('/auth/logout', { method: 'POST' }); me = null; boot(); } }, 'Çıkış')] : []));
}

async function boot() {
  try { me = await (await fetch('/api/me')).json().then((j) => (j.error ? null : j)); } catch { me = null; }
  if (!me) return renderLogin();
  route();
}

async function renderLogin() {
  renderNav('');
  const mode = (await (await fetch('/auth/mode')).json()).mode;
  const logo = document.querySelector('.brand .logo')?.cloneNode(true);
  const card = h('div', { class: 'card login' }, logo || null, h('h1', {}, 'Efor takibi'), h('p', { class: 'muted' }, 'Teknik ekipler için efor takibi.'));
  if (mode === 'dev') {
    const email = h('input', { placeholder: 'e-posta', value: 'dev@alpha.example.com' });
    const name = h('input', { placeholder: 'ad', value: 'Geliştirici' });
    const role = h('select', {}, ['Employee', 'PM', 'Admin'].map((r) => h('option', {}, r)));
    card.append(h('p', { class: 'err' }, 'Geliştirme kipi: gerçek giriş kapalı.'), email, name, role,
      h('button', { class: 'pri', onclick: async () => { await api('POST', '/auth/dev', { email: email.value, name: name.value, role: role.value }); boot(); } }, 'Giriş'));
  } else {
    card.append(h('a', { class: 'btn pri', href: '/auth/login' }, 'Microsoft ile giriş'));
  }
  app.replaceChildren(card);
}

window.addEventListener('hashchange', () => me && route());
// The logo always goes to the main screen (Haftam, this week), even when that page is already open.
document.querySelector('.brand')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (!me) return;
  weekDate = todayIso();
  window.scrollTo(0, 0);
  if (location.hash === '#/hafta') route(); else location.hash = '#/hafta';
});

function route() {
  let [, page = 'hafta', arg] = location.hash.split('/');
  page = ALIAS[page] || page;
  renderNav(page === 'inceleme' ? 'dosya' : page);
  const pages = { biletler: ticketsPage, hafta: weekPage, dosya: dosyaPage, inceleme: reviewPage, asistan: asistanPage, raporlar: reportsPage, projeler: projectsPage, yonetim: adminPage, rehber: guidePage };
  app.replaceChildren();
  (pages[page] || weekPage)(arg)
    .then(() => addIntro(page))
    .catch((e) => app.prepend(msg('err', e.message)));
}

// One short line under each page title saying what the page is for.
const INTRO = {
  hafta: 'Bu hafta ne kadar çalıştığınızı burada görür ve doldurursunuz. Size atanan görevlere saat yazın, dosyadan ekleyin ya da asistana söyleyin.',
  dosya: 'Standart günlük efor formunu indirip doldurun ve buraya bırakın; satırlar sabit kurallarla okunur. Başka düzendeki Excel, CSV ya da Not Defteri dosyaları da okunur. Siz kontrol edip onaylamadan hiçbir şey kaydedilmez.',
  asistan: 'Yazarak ya da dosya bırakarak efor ekleyin, eforunuzla ilgili soru sorun. Proje yöneticisiyseniz proje planını da buradan güncelleyebilirsiniz.',
  biletler: 'ITSM sistemindeki (ITSM) açık biletler: kim, hangi müşteri için, hangi durumda ve ne kadardır açık. Çalışanlar kendi biletlerini, proje yöneticileri ekiplerinin, yöneticiler herkesin biletlerini görür. Bilet numarasını efor satırına yazarsanız (örn. #3951) efor o bilete bağlanır.',
  raporlar: 'Hazır ya da kendi oluşturduğunuz raporlarla eforu kişi, proje, müşteri veya görev bazında görün; Excel ya da PDF olarak indirin, e-postayla zamanlayın.',
  projeler: 'Projeleri, ekiplerini ve planlarını yönetin. Planner planı bağlayın, Excel proje planını aktarın ya da planı yapay zekâ asistanıyla güncelleyin.',
  rehber: 'Her sayfanın ne işe yaradığını ve nasıl kullanılacağını adım adım anlatır.',
  yonetim: 'Kişileri, rollerini ve ikinci hesaplarını yönetin; dönem kapatın; sistem durumunu ve denetim kaydını izleyin.',
};
function addIntro(page) {
  const text = INTRO[page];
  const h1 = app.querySelector('h1');
  if (!text || !h1 || app.querySelector('.intro')) return;
  (h1.parentElement === app ? h1 : h1.parentElement).after(h('p', { class: 'intro muted' }, text, GUIDE.some((g) => g.id === page) ? h('a', { class: 'more', href: `#/rehber/${page}` }, 'Ayrıntılı anlatım ›') : null));
}

/* ---------- my week ---------- */

let weekDate = todayIso();

async function weekPage() {
  // The three answers do not depend on each other, so they are asked for together.
  const [w, myTasks, myProjects, cfg, customers, calStatus] = await Promise.all([api('GET', `/api/week?date=${weekDate}`), api('GET', '/api/my-tasks'), api('GET', '/api/projects'), api('GET', '/api/settings'), api('GET', '/api/customers'), api('GET', '/api/calendar/status').catch(() => ({ enabled: false }))]);
  const host = h('div', { class: 'card' });
  const nav = h('div', { class: 'row' },
    h('button', { onclick: () => { weekDate = addDays(w.start, -7); route(); } }, '‹ Önceki'),
    h('strong', { class: 'grow' }, `${fmtDate(w.start)} – ${fmtDate(addDays(w.start, 6))}`),
    h('span', {}, `Toplam: ${fmtH(w.total)} saat`),
    h('button', { onclick: () => { weekDate = addDays(w.start, 7); route(); } }, 'Sonraki ›'),
    h('button', { onclick: () => { weekDate = todayIso(); route(); } }, 'Bu hafta'));
  host.append(nav);
  const allIds = w.days.flatMap((d) => d.entries.map((e) => e.id));
  for (const id of [...picked]) if (!allIds.includes(id)) picked.delete(id);
  const selCount = h('strong', {});
  const bar = h('div', { class: 'selbar', hidden: true },
    selCount,
    h('button', { class: 'danger', onclick: () => { if (confirm(`${picked.size} kayıt silinsin mi? Hemen ardından "Geri al" diyebilirsiniz.`)) removeEntries([...picked], () => route()); } }, 'Seçilenleri sil'),
    h('button', { onclick: () => { picked.clear(); route(); } }, 'Seçimi kaldır'));
  const onPick = () => { bar.hidden = picked.size === 0; selCount.textContent = `${picked.size} kayıt seçili`; };
  if (allIds.length) host.append(h('div', { class: 'row' }, h('button', { onclick: () => { const all = allIds.some((i) => !picked.has(i)); allIds.forEach((i) => (all ? picked.add(i) : picked.delete(i))); route(); } }, 'Tüm haftayı seç / kaldır')), bar);
  onPick();
  for (const d of w.days) {
    host.append(h('div', { class: 'day' + (d.missing ? ' missing' : '') + (d.date === todayIso() ? ' today' : '') },
      h('h3', {}, h('span', {}, `${DAYS[d.weekday]} ${fmtDate(d.date)}`), h('span', {}, d.missing ? 'efor girilmemiş' : `${fmtH(d.hours)} sa`, d.overtime > 0 ? h('span', { class: 'chip ot' }, `ekstra mesai ${fmtH(d.overtime)} sa`) : null, d.dayOff && d.entries.length ? h('span', { class: 'chip' }, 'mesai dışı gün') : null)),
      d.entries.length ? entriesTable(d.entries, () => route(), onPick, { projects: myProjects, customers }) : null));
  }
  // An empty week explains how it gets filled; the task list below is the fastest way.
  const empty = w.days.every((d) => d.entries.length === 0);
  const how = empty ? h('div', { class: 'card how' },
    h('h2', {}, 'Haftanız nasıl dolar?'),
    h('ol', {},
      h('li', {}, h('strong', {}, 'Görevlerim: '), 'aşağıdaki listeden bir göreve saat yazıp "Ekle"ye basın.'),
      h('li', {}, h('strong', {}, 'Dosya: '), h('a', { href: '#/dosya' }, 'Dosyadan Ekle'), ' sayfasından Excel ya da Not Defteri dosyanızı bırakın; satırlar okunur, siz onaylarsınız.'),
      h('li', {}, h('strong', {}, 'Asistan: '), h('a', { href: '#/asistan' }, 'Asistan'), ' sayfasına "bugün 3 saat switch kurulumu yaptım" yazın.'),
      h('li', {}, h('strong', {}, 'Elle: '), 'en alttaki "Elle ekle" formunu kullanın.'))) : null;
  const target = (me.dayHours || 8) * 5;
  const pct = Math.min(100, Math.round((w.total / target) * 100));
  const missing = w.days.filter((d) => d.missing).length;
  const summary = h('div', { class: 'summary' },
    h('div', { class: 'stat' }, h('span', { class: 'big' }, fmtH(w.total)), h('span', { class: 'muted' }, `saat · hedef ${target}`)),
    h('div', { class: 'stat grow' }, h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: `width:${pct}%` })), h('span', { class: 'muted' }, `Haftanın %${pct}’i tamam`)),
    h('div', { class: 'stat' }, h('span', { class: 'big' }, fmtH(w.overtime || 0)), h('span', { class: 'muted' }, `ekstra mesai (${cfg.workStart}–${cfg.workEnd} dışı)`)),
    h('div', { class: 'stat' }, h('span', { class: 'big ' + (missing ? 'warnc' : 'okc') }, missing ? String(missing) : '✓'), h('span', { class: 'muted' }, missing ? 'eksik gün' : 'eksik gün yok')));
  add(h('h1', {}, `Merhaba, ${me.name.split(' ')[0]}`), summary, how, host, calendarCard(w.start, calStatus, myProjects, customers), myTasksCard(w.start, todayIso(), myTasks), manualForm(w.start, myProjects, customers));
}


/* ---------- customers and quick projects, shared by the forms ---------- */

/**
 * A customer box: type to filter the ITSM customer list; a name that is not in it shows
 * "+ ... müşterisini ekle", which saves it so everyone can pick it from then on.
 */
function customerField(list, { value = '', placeholder = 'Müşteri', onchange = null } = {}) {
  const id = 'cl' + Math.random().toString(36).slice(2, 8);
  const input = h('input', { placeholder, list: id, value, autocomplete: 'off', size: 22 });
  // "İç Çalışma" (internal work) is always a valid answer, so it is offered and never suggested as a new customer.
  const INTERNAL = 'iç çalışma';
  const dl = h('datalist', { id }, [{ name: 'İç Çalışma' }, ...list].map((c) => h('option', { value: c.name })));
  const addBtn = h('button', { type: 'button', class: 'link-btn add-cust', hidden: true });
  const known = () => input.value.trim().toLocaleLowerCase('tr') === INTERNAL || list.some((c) => c.name.toLowerCase() === input.value.trim().toLowerCase());
  const refresh = () => { const v = input.value.trim(); addBtn.hidden = !v || known(); addBtn.textContent = `+ “${v}” müşterisini ekle`; };
  input.addEventListener('input', refresh);
  input.addEventListener('change', () => { if (onchange && (!input.value.trim() || known())) onchange(input.value.trim()); });
  addBtn.addEventListener('click', async () => {
    try {
      const c = await api('POST', '/api/customers', { name: input.value });
      if (!list.some((x) => x.name === c.name)) { list.push(c); dl.append(h('option', { value: c.name })); }
      input.value = c.name; refresh(); toast('Müşteri eklendi.'); onchange?.(c.name);
    } catch (e) { toast(e.message, 'err'); }
  });
  refresh();
  return { el: h('span', { class: 'custfield' }, input, dl, addBtn), input };
}

/** Adds "+ Yeni proje ekle…" to a project <select>; choosing it opens a small form and the new project is selected. */
function projectAdder(sel, customers, onAdded = null) {
  const name = h('input', { placeholder: 'Proje adı', class: 'grow' });
  const cf = customerField(customers, { placeholder: 'Müşteri (listeden seçin ya da yazın)' });
  const host = h('div', { class: 'inline-add', hidden: true },
    h('strong', {}, 'Yeni proje'),
    h('div', { class: 'row' }, name, cf.el,
      h('button', { class: 'pri', onclick: async () => {
        try {
          const r = await api('POST', '/api/projects/quick', { name: name.value, customer: cf.input.value.trim() || null });
          sel.querySelector('option[value="__new"]').before(h('option', { value: r.id }, r.name));
          sel.value = r.id; name.value = ''; cf.input.value = ''; host.hidden = true;
          toast(`“${r.name}” projesi eklendi.`);
          onAdded?.(r);
          sel.dispatchEvent(new Event('change'));
        } catch (e) { toast(e.message, 'err'); }
      } }, 'Projeyi ekle'),
      h('button', { onclick: () => { host.hidden = true; } }, 'Vazgeç')));
  sel.append(h('option', { value: '__new' }, '+ Yeni proje ekle…'));
  let last = sel.value;
  sel.addEventListener('change', () => {
    if (sel.value === '__new') { sel.value = last; host.hidden = false; name.focus(); }
    else last = sel.value;
  });
  return host;
}

/** Customer · project/SLA · product, as one muted line under a description. */
function formLine(e) {
  const bits = [e.customer, e.work_item, e.product].filter(Boolean);
  return bits.length ? h('div', { class: 'muted small' }, bits.join(' · ')) : null;
}

/** Rows picked for deletion in the week view (ids). */
const picked = new Set();

async function removeEntries(ids, refresh) {
  try {
    const r = await api('POST', '/api/entries/delete', { ids });
    ids.forEach((i) => picked.delete(i));
    const n = r.deleted.length;
    if (!n) { toast('Hiçbir kayıt silinemedi: onaylanmış ya da kapalı dönemdeki kayıtlar silinemez.', 'err'); return; }
    const msgText = `${n} kayıt silindi.` + (r.skipped ? ` ${r.skipped} kayıt silinemedi (onaylı ya da kapalı dönem).` : '');
    toast(msgText, 'ok', { label: 'Geri al', run: async () => {
      for (const id of r.deleted) { try { await api('POST', `/api/entries/${id}/restore`); } catch { /* already restored or locked */ } }
      refresh();
    } });
    refresh();
  } catch (x) { toast(x.message, 'err'); }
}

/** Hours between two HH:MM times, or null when they do not make a range. */
function rangeHours(start, end) {
  if (!start || !end) return null;
  const [a, z] = [start, end].map((x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5)));
  return z > a ? Math.round(((z - a) / 60) * 100) / 100 : null;
}

/**
 * Everything about a saved row can be changed here: its name (description), category, customer, project, product,
 * date and times. Only what really changed is sent, so a project the person is no longer on is never re-checked.
 */
function entryEditor(e, { projects = [], customers = [] }, close, refresh) {
  const clock = (t) => (t ? t.slice(0, 5) : '');
  const fld = (label, el) => h('label', { class: 'fld' }, h('span', { class: 'muted small' }, label), el);
  const desc = h('input', { value: e.description || '', class: 'grow', 'aria-label': 'Açıklama (ad)', placeholder: 'Açıklama' });
  const cat = h('select', { 'aria-label': 'Kategori' }, h('option', { value: '' }, 'Kategori: yok'),
    CATEGORIES.map((c) => h('option', { value: c, selected: e.category === c }, c)),
    e.category && !CATEGORIES.includes(e.category) ? h('option', { value: e.category, selected: true }, e.category) : null);
  const custF = customerField(customers, { value: e.customer || '', placeholder: 'Müşteri / İç Çalışma' });
  const proj = h('select', { 'aria-label': 'Proje' }, h('option', { value: '' }, 'Proje: yok'),
    e.project_id && !projects.some((p) => p.id === e.project_id) ? h('option', { value: e.project_id, selected: true }, 'Şu anki proje') : null,
    projects.map((p) => h('option', { value: p.id, selected: e.project_id === p.id }, p.name)));
  const adder = projectAdder(proj, customers, (r) => projects.push({ id: r.id, name: r.name, customer: null }));
  const work = h('input', { value: e.work_item || '', placeholder: 'Proje / SLA / Fırsat adı', 'aria-label': 'Proje / iş adı', size: 24 });
  const product = h('input', { value: e.product || '', placeholder: 'Ürün / Teknoloji', 'aria-label': 'Ürün / Teknoloji', size: 18 });
  const date = h('input', { type: 'date', value: e.work_date || '', 'aria-label': 'Tarih' });
  const from = h('input', { type: 'time', value: clock(e.start_time), 'aria-label': 'Başlangıç' });
  const till = h('input', { type: 'time', value: clock(e.end_time), 'aria-label': 'Bitiş' });
  const hours = h('input', { value: fmtH(e.hours), size: 8, 'aria-label': 'Süre' });

  // Choosing a project fills in what follows from it, unless the person has already typed something of their own.
  let prev = projects.find((x) => x.id === e.project_id) || null;
  proj.addEventListener('change', () => {
    const p = projects.find((x) => x.id === proj.value) || null;
    const c = custF.input.value.trim();
    if (p) {
      if (p.customer && (!c || c === 'İç Çalışma' || c === (prev?.customer || ''))) { custF.input.value = p.customer; custF.input.dispatchEvent(new Event('input')); }
      if (!work.value.trim() || work.value.trim() === (prev?.name || '')) work.value = p.name;
      if (!cat.value || cat.value === 'İç Operasyon') cat.value = 'Proje';
    }
    prev = p;
  });

  const save = h('button', { class: 'pri', onclick: async () => {
    const body = {};
    const text = (k, v, old) => { if (v !== (old || '')) body[k] = v || null; };
    if (desc.value.trim() !== (e.description || '').trim()) body.description = desc.value.trim();
    text('category', cat.value, e.category);
    text('customer', custF.input.value.trim(), e.customer);
    text('workItem', work.value.trim(), e.work_item);
    text('product', product.value.trim(), e.product);
    if (proj.value !== (e.project_id || '')) body.projectId = proj.value || null;
    if (date.value && date.value !== e.work_date) body.date = date.value;
    if (from.value !== clock(e.start_time)) body.start = from.value || null;
    if (till.value !== clock(e.end_time)) body.end = till.value || null;
    const hv = hours.value.trim();
    if (hv !== fmtH(e.hours)) body.hours = hv;
    else if (body.start !== undefined || body.end !== undefined) { const rh = rangeHours(from.value, till.value); if (rh !== null) body.hours = rh; }
    if (!Object.keys(body).length) { toast('Değişiklik yok.'); close(); return; }
    save.disabled = true;
    try { await api('PATCH', `/api/entries/${e.id}`, body); toast('Satır güncellendi.'); refresh(); }
    catch (x) { toast(x.message, 'err'); save.disabled = false; }
  } }, 'Kaydet');

  return h('div', { class: 'entry-edit' },
    h('div', { class: 'row' }, fld('Açıklama (ad)', desc)),
    h('div', { class: 'row' }, fld('Kategori', cat), fld('Müşteri', custF.el), fld('Proje', proj), fld('Proje / iş adı', work), fld('Ürün / Teknoloji', product)),
    h('div', { class: 'row' }, fld('Tarih', date), fld('Başlangıç', from), fld('Bitiş', till), fld('Süre', hours)),
    adder,
    h('div', { class: 'row' }, save, h('button', { onclick: close }, 'Vazgeç')));
}

function entriesTable(entries, refresh, onPick = () => {}, lists = {}) {
  const t = h('table', {}, h('tr', {}, h('th', { class: 'chk' }), ...['Saat', 'Açıklama', 'Bağlantı', 'Durum', ''].map((x, i) => h('th', { class: i === 0 ? 'num' : '' }, x))));
  for (const e of entries) {
    const box = h('input', { type: 'checkbox', 'aria-label': 'Seç', checked: picked.has(e.id), onchange: () => { box.checked ? picked.add(e.id) : picked.delete(e.id); onPick(); } });
    const editRow = h('tr', { class: 'editrow', hidden: true }, h('td', { colspan: 6 }));
    const toggle = () => {
      if (!editRow.firstChild.firstChild) editRow.firstChild.append(entryEditor(e, lists, () => { editRow.hidden = true; }, refresh));
      editRow.hidden = !editRow.hidden;
    };
    t.append(h('tr', {},
      h('td', { class: 'chk' }, box),
      h('td', { class: 'num' }, fmtH(e.hours), Number(e.overtime_hours) > 0 ? h('div', { class: 'muted small' }, `ekstra ${fmtH(Number(e.overtime_hours))}`) : null),
      h('td', {}, catChip(e.category), ' ', e.description || '–', formLine(e), e.progress ? h('span', { class: 'chip' + (e.progress === 'Bloke' ? ' bad' : '') }, e.progress) : null, e.start_time ? h('div', { class: 'muted' }, `${e.start_time.slice(0, 5)}–${(e.end_time || '').slice(0, 5)}`) : null),
      h('td', {}, e.link_id ? linkChip(e.link_kind, linkLabel(e.link_kind) + ' ' + e.link_id.slice(0, 10)) : h('span', { class: 'muted' }, '–')),
      h('td', {}, h('span', { class: 'chip ' + (e.status === 'draft' ? 'warn' : 'good') }, e.status === 'draft' ? 'taslak' : 'kayıtlı'), flagChips(e.flags)),
      h('td', {},
        h('button', { disabled: e.status === 'approved', title: e.status === 'approved' ? 'Onaylanmış kayıt değiştirilemez' : 'Ad, kategori, müşteri, proje, saat ve süreyi düzenle', onclick: toggle }, 'Düzenle'), ' ',
        h('button', { class: 'danger', onclick: () => removeEntries([e.id], refresh) }, 'Sil'))), editRow);
  }
  return h('div', { class: 'scroll' }, t);
}

function manualForm(weekStart, projects, customers = []) {
  const date = h('input', { type: 'date', value: todayIso() });
  const hours = h('input', { placeholder: 'Süre: 3 saat, 2,5s…', size: 16, 'aria-label': 'Süre' });
  const from = h('input', { type: 'time', 'aria-label': 'Başlangıç', title: 'Başlangıç (isteğe bağlı)' });
  const till = h('input', { type: 'time', 'aria-label': 'Bitiş', title: 'Bitiş (isteğe bağlı)' });
  const desc = h('input', { placeholder: 'Açıklama', class: 'grow' });
  const cat = h('select', { 'aria-label': 'Kategori' }, h('option', { value: '' }, 'Kategori'), CATEGORIES.map((c) => h('option', { value: c }, c)));
  const custField = customerField(customers, { placeholder: 'Müşteri / İç Çalışma' });
  const cust = custField.input;
  const proj = h('select', {}, h('option', { value: '' }, projects.length ? 'Proje (seçiniz)' : 'Atanmış proje yok'), projects.map((p) => h('option', { value: p.id }, p.name)));
  if (projects.length === 1) proj.value = projects[0].id;
  const adder = projectAdder(proj, customers);
  const host = h('div', { class: 'card' }, h('h2', {}, 'Elle ekle'));
  host.append(h('div', { class: 'row' }, date, from, till, hours, cat, custField.el, proj, desc,
    h('button', { class: 'pri', onclick: () => guard(host, async () => {
      const r = await api('POST', '/api/entries', { date: date.value, hours: hours.value || undefined, start: from.value || undefined, end: till.value || undefined, description: desc.value, projectId: proj.value || null, category: cat.value || null, customer: cust.value.trim() || null });
      if (!r.saved) throw new Error('Kayıt taslak olarak kaldı: ' + (r.flags || []).map((f) => FLAG_TEXT[f] || f).join(', '));
      weekDate = date.value; route();
    }) }, 'Kaydet')), adder);
  return host;
}

/* ---------- add from a file, and review ---------- */

const FILE_TYPES = '.xlsx,.xlsm,.csv,.txt,.md';

/** A drop target that also opens the file picker. Calls onFile(file) with the chosen file. */
function dropzone(onFile, { label = 'Dosyanızı buraya bırakın', hint = 'ya da bilgisayarınızdan seçin' } = {}) {
  const input = h('input', { type: 'file', accept: FILE_TYPES, hidden: true });
  const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Dosya seç' },
    h('span', { class: 'dz-ico' }, icon('upload', 28)),
    h('strong', {}, label), h('span', { class: 'muted' }, hint),
    h('span', { class: 'btn pri' }, 'Dosya seç'), input);
  const pick = () => input.click();
  zone.addEventListener('click', (e) => { if (e.target !== input) pick(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  for (const ev of ['dragenter', 'dragover']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  zone.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); });
  return zone;
}

async function dosyaPage() {
  const [projects, list, customers] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/uploads'), api('GET', '/api/customers')]);
  const proj = h('select', { 'aria-label': 'Proje' }, h('option', { value: '' }, 'Proje: dosyadan anlaşılsın'), projects.map((p) => h('option', { value: p.id }, p.name)));
  const adder = projectAdder(proj, customers);
  const status = h('div', {});

  const send = async (file) => {
    put(status, h('div', { class: 'working' }, h('span', { class: 'spinner' }), `“${file.name}” okunuyor… Bu birkaç saniye sürebilir.`));
    try {
      const f = new FormData(); f.set('file', file); if (proj.value) f.set('projectId', proj.value);
      const r = await api('POST', '/api/uploads', f);
      location.hash = `#/inceleme/${r.uploadId}`;
    } catch (e) {
      if (e.status === 409 && e.data?.uploadId) put(status, h('div', { class: 'err' }, 'Bu dosyayı daha önce eklemişsiniz. ', h('a', { href: `#/inceleme/${e.data.uploadId}` }, 'Önceki sonucu aç')));
      else put(status, msg('err', e.message));
    }
  };

  const form = h('div', { class: 'card formcard' },
    h('div', { class: 'grow' },
      h('h2', {}, 'Standart günlük efor formu'),
      h('p', { class: 'muted' }, 'Herkes aynı Excel formunu doldurur: tarih, kategori (SLA, Proje, Satış Destek…), müşteri, proje/SLA adı, ürün, yapılan çalışma, başlangıç ve bitiş. Her çalışma için tek satır yazın; süre kendiliğinden hesaplanır. Formu doldurup aşağıya bırakmanız yeterli.')),
    h('a', { class: 'btn pri', href: '/api/template', download: 'Gunluk_Efor_Giris_Sablonu.xlsx' }, icon('upload', 16), 'Formu indir'));
  const hero = h('div', { class: 'card hero-upload' },
    h('h2', {}, 'Doldurduğunuz formu ekleyin'),
    dropzone(send, { label: 'Doldurduğunuz formu buraya bırakın', hint: 'ya da bilgisayarınızdan seçin (başka düzendeki Excel/CSV/Not Defteri dosyaları da okunur)' }),
    h('div', { class: 'row' }, h('label', { class: 'inline' }, 'Hangi proje için?', proj), h('span', { class: 'muted' }, 'İsteğe bağlı; boş bırakırsanız satırlardan anlaşılır. Listede yoksa “+ Yeni proje ekle…” seçin.')),
    adder,
    status,
    h('ol', { class: 'steps' },
      h('li', {}, h('b', {}, 'Dosyayı seçin. '), 'Excel, CSV ya da Not Defteri; kendi düzeninizle hazırladığınız dosya olabilir.'),
      h('li', {}, h('b', {}, 'Satırları kontrol edin. '), 'Tarih, saat ve görev eşleşmelerini görürsünüz; yanlış olanı düzeltirsiniz.'),
      h('li', {}, h('b', {}, 'Onaylayın. '), 'Siz onaylamadan hiçbir şey kaydedilmez.')));

  const STATUS_TR = { review: ['Onay bekliyor', 'warn'], confirmed: ['Kaydedildi', 'good'], failed: ['Okunamadı', 'bad'], discarded: ['Vazgeçildi', ''], processing: ['İşleniyor', 'warn'] };
  const hist = h('div', { class: 'card' }, h('h2', {}, 'Son eklediğiniz dosyalar'),
    list.length ? h('div', { class: 'scroll' }, h('table', {}, h('tr', {}, ...['Dosya', 'Tarih', 'Satır', 'Durum', ''].map((x) => h('th', {}, x))),
      list.map((u) => h('tr', {}, h('td', {}, u.file_name), h('td', {}, new Date(u.created_at).toLocaleString('tr-TR')), h('td', {}, u.rows),
        h('td', {}, h('span', { class: 'chip ' + (STATUS_TR[u.status]?.[1] || '') }, STATUS_TR[u.status]?.[0] || u.status)),
        h('td', {}, u.status === 'review' ? h('a', { class: 'btn', href: `#/inceleme/${u.id}` }, 'Devam et') : null, ' ',
          u.status === 'discarded' ? null : h('button', { class: 'danger', onclick: async () => {
            if (!confirm(`“${u.file_name}” silinsin mi? Bu dosyadan gelen ${u.rows} satır da silinir.`)) return;
            try { const r = await api('DELETE', `/api/uploads/${u.id}`); toast(`Dosya ve ${r.deleted} satır silindi.`); route(); } catch (e) { toast(e.message, 'err'); }
          } }, 'Sil'))))))
      : h('p', { class: 'muted' }, 'Henüz dosya eklemediniz.'));
  add(h('h1', {}, 'Dosyadan Ekle'), form, hero, hist);
}

async function reviewPage(id) {
  const [d, src, projects, customers] = await Promise.all([api('GET', `/api/uploads/${id}`), api('GET', `/api/uploads/${id}/source`).catch(() => null), api('GET', '/api/projects'), api('GET', '/api/customers')]);
  const up = d.upload;
  const header = h('div', { class: 'card' }, h('h1', {}, up.file_name),
    h('div', { class: 'muted' }, `Okuma yolu: ${{ standard: 'standart efor formu (sabit kurallarla; yapay zekâ kullanılmadı)', template: 'kayıtlı şablon (yapay zekâ kullanılmadı)', ai: 'yapay zekâ', 'text-ai': 'yapay zekâ (metin)' }[up.path_taken] || '–'} · Hafta: ${fmtDate(up.week_start)}`),
    (up.notes || []).map((n) => h('div', { class: 'muted' }, 'ℹ ' + n)));
  if (up.status !== 'review') { app.append(header, msg(up.status === 'confirmed' ? 'ok' : 'err', up.status === 'confirmed' ? 'Bu dosya kaydedildi.' : `Durum: ${up.status} ${up.error || ''}`)); return; }

  // Source pane with highlight
  const cells = new Map();
  const srcPane = h('div', { class: 'card' }, h('h2', {}, 'Özgün dosya'));
  if (src) {
    for (const sh of src.sheets) {
      if (src.kind === 'text') {
        const box = h('div', { class: 'src' });
        sh.rows.forEach((r, i) => { const el = h('div', {}, `${i + 1}  ${r[0] || ''}`); cells.set(`L${i + 1}`, el); box.append(el); });
        srcPane.append(box);
      } else {
        const t = h('table', { class: 'src' });
        sh.rows.forEach((r, ri) => { const tr = h('tr', {}, h('td', { class: 'muted' }, ri + 1), r.map((c, ci) => { const td = h('td', {}, c); cells.set(`${sh.name}!${colLetter(ci)}${ri + 1}`, td); return td; })); t.append(tr); cells.set(`${sh.name}!R${ri + 1}`, tr); });
        srcPane.append(h('strong', {}, sh.name), h('div', { class: 'scroll' }, t));
      }
    }
  }
  const highlight = (source, on) => { const el = cells.get(source) || cells.get((source || '').replace(/![A-Z]+(\d+)$/, '!R$1')); if (el) { el.classList.toggle('hl', on); if (on) el.scrollIntoView({ block: 'nearest' }); } };

  const rowsHost = h('div', { class: 'card' });
  const redraw = async () => { const fresh = await api('GET', `/api/uploads/${id}`); drawRows(fresh); };

  // No effort rows. If the file is a project plan, offer to send it to a project instead of a dead end.
  const drawEmpty = (data) => {
    const isPM = RANK[me.role] >= 1;
    const planOffer = data.plan_tasks > 0;
    const msgBox = h('div', {});
    const parts = [h('div', { class: 'empty' },
      h('h2', {}, planOffer ? `Bu dosya bir proje planı gibi görünüyor (${data.plan_tasks} görev)` : 'Bu dosyada efor satırı bulunamadı'),
      h('p', {}, planOffer
        ? 'Çalışılan gün ya da saat yok, ama görevler, sorumlular ve hedef tarihler var. Bunu bir projeye aktarırsanız ekip eforunu bu görevlere bağlayabilir.'
        : 'Dosyada çalışılan gün, saat ya da efor sütunu görünmüyor; bu yüzden onaylanacak bir şey yok. Yukarıdaki notlar dosyada ne bulunduğunu açıklıyor.'))];
    if (planOffer && isPM) {
      api('GET', '/api/projects').then((projects) => {
        const sel = h('select', {}, h('option', { value: '' }, 'Hangi proje?'), projects.map((p) => h('option', { value: p.id }, p.name)));
        const go = h('button', { class: 'pri', onclick: async () => {
          if (!sel.value) { toast('Önce bir proje seçin.', 'err'); return; }
          go.disabled = true;
          try { showPlanProposal(msgBox, await api('POST', `/api/uploads/${id}/as-plan`, { projectId: sel.value }), () => { toast('Plan projeye aktarıldı.'); location.hash = '#/projeler'; }); }
          catch (e) { msgBox.replaceChildren(msg('err', e.message)); }
          finally { go.disabled = false; }
        } }, 'Planı projeye aktar');
        rowsHost.querySelector('.plan-actions')?.append(sel, go);
      });
      parts.push(h('div', { class: 'row plan-actions' }), msgBox);
    } else if (planOffer) {
      parts.push(h('p', { class: 'muted' }, 'Proje planlarını proje yöneticileri projeye aktarır. Bu dosyayı onlara iletebilirsiniz.'));
    }
    parts.push(h('div', { class: 'row' },
      h('button', { class: planOffer ? '' : 'pri', onclick: async () => { await api('POST', `/api/uploads/${id}/discard`); location.hash = '#/dosya'; } }, 'Başka dosya ekle'),
      h('a', { class: 'btn', href: '#/hafta' }, 'Eforu elle gir')));
    put(rowsHost, parts);
  };

  const drawRows = (data) => {
    if (!data.rows.length) return drawEmpty(data);
    const t = h('table', {}, h('tr', {}, ...['Tarih', 'Efor', 'Kategori', 'Açıklama', 'Bağlantı', 'Uyarı', ''].map((x) => h('th', {}, x))));
    for (const e of data.rows) {
      const cat = h('select', { 'aria-label': 'Kategori', onchange: () => patch(e.id, { category: cat.value || null }) }, h('option', { value: '' }, '–'), CATEGORIES.map((c) => h('option', { value: c, selected: e.category === c }, c)), e.category && !CATEGORIES.includes(e.category) ? h('option', { value: '', selected: true }, e.category + ' (geçersiz)') : null);
      const hoursInput = h('input', { value: fmtH(e.hours), size: 7, onchange: () => patch(e.id, { hours: hoursInput.value }) });
      const dateInput = h('input', { type: 'date', value: e.work_date || '', onchange: () => patch(e.id, { date: dateInput.value }) });
      const descInput = h('input', { value: e.description, onchange: () => patch(e.id, { description: descInput.value }) });
      const projSel = h('select', { 'aria-label': 'Proje', onchange: () => { if (projSel.value !== '__new') patch(e.id, { projectId: projSel.value || null }); } },
        h('option', { value: '' }, 'Proje: yok'), projects.map((p) => h('option', { value: p.id, selected: e.project_id === p.id }, p.name)));
      const projAdd = projectAdder(projSel, customers, (r) => projects.push({ id: r.id, name: r.name }));
      const custF = customerField(customers, { value: e.customer || '', placeholder: 'Müşteri', onchange: (v) => patch(e.id, { customer: v || null }) });
      const link = h('td', {}, e.link_id ? linkChip(e.link_kind, `${linkLabel(e.link_kind)} ${e.link_id.slice(0, 12)} (${e.link_via})`) : h('button', { onclick: () => pickTask(e, link) }, 'Görev seç'));
      t.append(h('tr', { onmouseenter: () => highlight(e.source, true), onmouseleave: () => highlight(e.source, false) },
        h('td', {}, dateInput), h('td', {}, hoursInput, e.hours_rule && !['manual', 'decimal'].includes(e.hours_rule) ? h('div', { class: 'muted' }, e.hours_rule) : null, Number(e.overtime_hours) > 0 ? h('div', { class: 'chip ot' }, `ekstra mesai ${fmtH(Number(e.overtime_hours))} sa`) : null),
        h('td', {}, cat), h('td', {}, descInput, formLine(e), h('div', { class: 'row tight' }, projSel, custF.el), projAdd), link, h('td', {}, flagChips(e.flags)),
        h('td', {}, h('button', { class: 'danger', onclick: async () => { await api('DELETE', `/api/entries/${e.id}`); redraw(); } }, 'Sil'))));
    }
    const confirmBtn = h('button', { class: 'pri', disabled: data.blocked > 0, onclick: () => guard(rowsHost, async () => { const r = await api('POST', `/api/uploads/${id}/confirm`); location.hash = '#/hafta'; toast(`${r.confirmed} satır kaydedildi.`); }) }, `${data.rows.length} satırı onayla (${fmtH(data.total)} saat)`);
    put(rowsHost, h('h2', {}, 'Okunan satırlar'),
      data.blocked ? msg('err', `${data.blocked} satır onaylanamaz: kırmızı uyarıları düzeltin veya satırı silin.`) : null,
      h('div', { class: 'scroll' }, t),
      h('div', { class: 'row' }, confirmBtn, h('button', { class: 'danger', onclick: async () => { if (confirm('Bu dosya atılsın mı?')) { await api('POST', `/api/uploads/${id}/discard`); location.hash = '#/dosya'; } } }, 'Vazgeç')));
  };
  const patch = (eid, body) => guard(rowsHost, async () => { await api('PATCH', `/api/entries/${eid}`, body); await redraw(); });
  const pickTask = async (e, cell) => {
    const opts = await api('GET', `/api/entries/${e.id}/options`);
    const sel = h('select', {}, h('option', { value: '' }, opts.length ? 'Görev / bilet seçin' : 'Aday yok'), opts.map((o) => h('option', { value: o.id }, `${linkLabel(o.kind)} · ${o.title}`)));
    sel.onchange = () => { const o = opts.find((x) => x.id === sel.value); if (o) patch(e.id, { link: { kind: o.kind, id: o.id, tenantId: o.tenantId } }); };
    cell.replaceChildren(sel);
  };
  drawRows(d);
  app.append(header, h('div', { class: 'split' }, srcPane, rowsHost));
}

/** The list of changes a staged action would make, with Apply/Cancel. Nothing is saved before "Uygula". */
function showPlanProposal(host, r, onApplied) {
  if (!r.actionId) { put(host, msg('err', [...(r.notes || []), ...(r.rejected || [])].join(' ') || 'Uygulanabilir bir değişiklik çıkmadı.')); return; }
  const apply = h('button', { class: 'pri', onclick: async () => {
    apply.disabled = true;
    try { await api('POST', `/api/pending/${r.actionId}/apply`); onApplied(); } catch (e) { put(host, msg('err', e.message)); }
  } }, `Uygula (${r.lines.length})`);
  put(host, h('div', { class: 'proposal' },
    h('strong', {}, `${r.lines.length} değişiklik önerildi. Henüz hiçbiri uygulanmadı.`),
    h('ul', {}, r.lines.map((l) => h('li', {}, l))),
    (r.rejected || []).length ? msg('err', 'Reddedilen: ' + r.rejected.join('; ')) : null,
    (r.notes || []).map((n) => h('div', { class: 'muted' }, 'ℹ ' + n)),
    h('div', { class: 'row' }, apply, h('button', { onclick: async () => { await api('POST', `/api/pending/${r.actionId}/cancel`); put(host); } }, 'Vazgeç'))));
}

const colLetter = (i) => { let n = i + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };


/* ---------- guide: what each page does, in detail ---------- */

const GUIDE = [
  { id: 'hafta', icon: 'calendar', title: 'Haftam', role: 'Herkes', short: 'Haftalık eforunuzu görür, doldurur ve düzeltirsiniz.',
    what: 'Haftam, o haftaki çalışmanızın tamamını tek ekranda gösterir. Üstteki dört kutu haftanın özetidir: toplam saat (günlük 8 saat × 5 gün = 40 saat hedef), haftanın yüzde kaçının tamamlandığı, ekstra mesai saatiniz ve eforu girilmemiş gün sayısı.',
    steps: [
      ['Takvimden toplantılar: ', 'Takvim bağlantısı açıksa “Takvimimi bağla” ile Outlook / Teams takviminizi bir kez bağlayın (yalnızca kendi takviminiz, salt okuma). “Bu haftanın toplantılarını getir” toplantıları listeler; istediklerinizi seçin; toplantının adını, projesini, müşterisini ve kategorisini eklemeden önce değiştirebilirsiniz, sonra “Seçilenleri efora ekle”ye basın. Süre ve saatler takvimden gelir; eklenmiş toplantı ikinci kez eklenmez.'],
      ['Görevlerim: ', 'Size atanmış Planner görevleri, proje planı görevleri ve açık ITSM biletleri listelenir. Saati yazıp "Ekle"ye basmanız yeter; kayıt hemen haftanıza işlenir.'],
      ['Elle ekle: ', 'Tarih, isteğe bağlı başlangıç ve bitiş saati, süre, kategori, müşteri, proje ve açıklamayı yazıp "Kaydet"e basın. Başlangıç ve bitişi yazarsanız süre kendiliğinden hesaplanır. Müşteri kutusuna yazarken ITSM’deki müşteriler önerilir; listede yoksa "+ müşterisini ekle", projeniz yoksa "+ Yeni proje ekle…" seçin.'],
      ['Dosya ya da asistan: ', 'Kayıtları dosyadan (Dosyadan Ekle) veya yazarak (Asistan) da ekleyebilirsiniz; ikisi de önce size taslak gösterir.'],
      ['Haftalık tablo: ', 'Kayıtlar günlere göre listelenir. "Düzenle" bir düzenleme formu açar: açıklamayı (adı), kategoriyi, müşteriyi, projeyi, proje / iş adını, ürünü, tarihi, başlangıç-bitiş saatini ve süreyi değiştirebilirsiniz (proje seçince müşteri ve iş adı kendiliğinden dolar). "Sil" ile kaldırırsınız. Kutuları işaretleyip birden çok kaydı birlikte silebilirsiniz. "Önceki", "Sonraki" ve "Bu hafta" ile haftalar arasında gezinin.'],
    ],
    tips: ['Eforu girilmemiş günler sarı çizgiyle işaretlenir.', 'Mesai 09:00–18:00 arasıdır. Bu saatlerin dışı, hafta sonu ve resmî tatiller "ekstra mesai" sayılır. Yalnızca süre yazarsanız günün ilk 9 saati normal, fazlası ekstra mesai olur; başlangıç ve bitiş yazarsanız bölünme saatlere göre yapılır.', 'Onaylanmış ya da kapatılmış döneme ait kayıtlar değiştirilemez.'] },
  { id: 'dosya', icon: 'filePlus', title: 'Dosyadan Ekle', role: 'Herkes', short: 'Excel, CSV ya da Not Defteri dosyasından toplu efor ekleyin.',
    what: 'Bir haftalık eforu tek seferde, dosyadan eklemenizi sağlar. Hiçbir şey siz onaylamadan kaydedilmez.',
    steps: [
      ['Formu indirin: ', '"Formu indir" ile standart günlük efor Excel formunu alın. Sütunlar: Tarih, İş Kategorisi (SLA, Proje, Satış Destek, Teknik Çözüm / Ar-Ge, İç Operasyon, Eğitim / Gelişim), Müşteri / İç Çalışma, Proje / SLA / Fırsat Adı, Ürün / Teknoloji, Yapılan Çalışma, Başlangıç, Bitiş. Süre kendiliğinden hesaplanır; her çalışma için bir satır yazın.'],
      ['Dosyayı bırakın: ', 'Doldurduğunuz formu kutuya sürükleyin ya da "Dosya seç"e basın. Bu formdaki satırlar sabit kurallarla okunur. Başka düzendeki Excel, CSV ve Not Defteri dosyalarını yapay zekâ okur.'],
      ['Proje seçin (isteğe bağlı): ', '"Hangi proje için?" alanı boşsa proje satırlardan anlaşılır. Projeniz listede yoksa "+ Yeni proje ekle…" ile ekleyebilirsiniz.'],
      ['Satırları kontrol edin: ', 'Açılan inceleme ekranında solda özgün dosyanız, sağda okunan satırlar vardır; bir satırın üzerine gelince dosyadaki karşılığı vurgulanır. Tarih, efor, kategori, açıklama, proje, müşteri ve bağlı görevi buradan düzeltebilirsiniz.'],
      ['Onaylayın: ', '"… satırı onayla" ile kayıtlar haftanıza işlenir. Vazgeçerseniz dosya atılır.'],
    ],
    tips: ['Kırmızı uyarı (örn. tarih ya da efor yok) satırı düzeltene kadar onayı engeller; diğer uyarılar (çeyrek saat değil, müşteri yok) bilgi içindir.', 'Aynı dosyayı ikinci kez eklemeye çalışırsanız önceki sonucu açmanız önerilir.', '"Son eklediğiniz dosyalar" listesinden onay bekleyen dosyaya "Devam et" ile dönebilir, "Sil" ile dosyayı ve ondan gelen satırları kaldırabilirsiniz.', 'Dosya bir proje planıysa (görev, sorumlu, tarih) ve efor satırı yoksa, proje yöneticileri onu doğrudan bir projeye aktarabilir.'] },
  { id: 'asistan', icon: 'sparkles', title: 'Asistan', role: 'Herkes', short: 'Yazarak efor ekleyin, eforunuzla ilgili soru sorun.',
    what: 'Asistan, ne yaptığınızı kendi cümlelerinizle yazmanızı sağlar; sizin yerinize taslak satırları hazırlar. Siz "Onayla" demeden hiçbir şey kaydetmez.',
    steps: [
      ['Efor eklemek için yazın: ', 'Örn. "Dün 8 saat Alder projesinde çalıştım" ya da "Bugün 3 saat müşteri toplantısı". Altta taslak tablo çıkar; "Onayla" ile kaydedin, "Düzenle / proje ekle" ile incelemeye geçin.'],
      ['Soru sorun: ', 'Örn. "Bu ay ne kadar çalıştım?", "Bu haftayı günlere göre göster", "Ekstra mesaim ne kadar?". Cevaptaki her sayı bir rapor sonucuna dayanır; doğrulanamayan sayı gösterilmez. Raporun ayrıntısı için "Raporlar sayfasında aç" bağlantısını kullanın.'],
      ['Dosya bırakın: ', 'Kağıt ataç düğmesiyle ya da sürükleyip bırakarak bir efor dosyası ekleyebilirsiniz; Dosyadan Ekle ile aynı şekilde okunur.'],
      ['Yeni sohbet: ', 'Konuyu değiştirmek için üstteki "Yeni sohbet"e basın.'],
    ],
    tips: ['Proje yöneticileri ve yöneticiler ayrıca şunları sorabilir: "Açık biletler neler, kimin ne görevi var?", "Teknisyen bazında açık bilet raporu". Proje yöneticileri planı da güncelleyebilir: "W1.4 tamamlandı olarak işaretle" (önce öneri gösterilir, "Uygula" ile işlenir).', 'Tarih ve süreyi yazmazsanız asistan taslak çıkaramaz; "dün 8 saat X projesi" gibi her ikisini de içeren cümleler en iyi sonucu verir.'] },
  { id: 'biletler', icon: 'ticket', title: 'Biletler', role: 'Herkes (görünürlük role göre)', short: 'ITSM biletlerini görün.',
    what: 'ITSM sistemindeki biletleri gösterir: kim, hangi müşteri için, hangi durumda ve ne kadardır açık. Çalışanlar yalnızca kendi biletlerini, proje yöneticileri ekiplerinin, yöneticiler herkesin biletlerini görür.',
    steps: [
      ['Filtreleyin: ', 'Atanan kişiye, müşteriye ve açık / tüm biletlere göre daraltın.'],
      ['Detay: ', 'Bir satırdaki "Detay" düğmesi ITSM sisteminden canlı ayrıntıyı getirir: durum, öncelik, aciliyet, etki, tür, kategori, grup, talep eden, teknisyen, tarihler, açıklama ve çözüm. "ITSM sisteminde aç" bileti kendi sayfasında açar.'],
      ['Eforu bilete bağlayın: ', 'Efor satırına bilet numarasını yazın (örn. #3951); efor o bilete bağlanır ve raporlarda görünür.'],
    ],
    tips: ['Kapanmış biletler Görevlerim listesinde çıkmaz; yine de numarasıyla (son 45 gün) efor bağlanabilir.', 'Bağlantı kurulu değilse sayfa bunu belirtir; yönetici bağlantıyı Yönetim sayfasından kurar.'] },
  { id: 'raporlar', icon: 'chart', title: 'Raporlar', role: 'Herkes (kapsam role göre)', short: 'Eforu kişi, proje, müşteri ve göreve göre inceleyin; Excel/PDF alın.',
    what: 'Girilen eforu istediğiniz kırılımda gösterir. Çalışanlar yalnızca kendi eforunu, proje yöneticileri ekibini, yöneticiler herkesi görür.',
    steps: [
      ['Hazır rapor seçin: ', 'Örn. SLA kullanımı, kategori ve müşteri, proje eforu, ürün eforu, ekstra mesai (kişi / gün) ve "Ekstra mesaim".'],
      ['Kendi raporunuzu kurun: ', 'Dönemi seçin, hangi alanlara göre gruplanacağını belirleyin (kişi, proje, görev / bilet, müşteri, kategori, gün, hafta, ay…) ve filtre ekleyin; "Yalnızca ekstra mesai" filtresi de vardır.'],
      ['İndirin ve paylaşın: ', 'Sonucu Excel ya da PDF olarak indirin; raporu kaydedin ve e-postayla düzenli gönderilecek şekilde zamanlayın.'],
    ],
    tips: ['Raporlarda yalnızca onaylanmış kayıtlar sayılır; taslaklar sayılmaz.', 'Toplamlara ekstra mesai dâhildir; ayrı sütunda da gösterilir.'] },
  { id: 'projeler', icon: 'folder', title: 'Projeler', role: 'Proje yöneticisi ve yönetici', short: 'Projeleri, ekiplerini ve planlarını yönetin.',
    what: 'Projeler kart olarak listelenir (ad, müşteri, kişi sayısı, Planner ve plan görev sayıları). Bir karta tıklayınca projenin ayrıntısı açılır; "Tüm projeler", "Önceki" ve "Sonraki" ile gezinirsiniz.',
    steps: [
      ['Yeni proje: ', '"＋ Yeni proje" bölümünde ad ve müşteri yazın (müşteri ITSM listesinden önerilir, yoksa eklenir). İsterseniz şirketi seçip "Planları getir" ile Planner planlarını listeleyin ve bağlanacakları işaretleyin; bir Planner planı yalnızca tek projeye bağlanabilir.'],
      ['Ekip: ', 'Projede çalışan kişileri işaretleyip "Ekibi kaydet"e basın. Ekipteki kişiler eforlarını projenin görevlerine bağlayabilir.'],
      ['Planner: ', 'Bağlı planın görevleri otomatik eşitlenir; "Şimdi eşitle" ile hemen yenileyebilir, "Görevleri göster" ile listeyi görebilirsiniz.'],
      ['Proje planı: ', 'Görev, sorumlu, bağımlılık ve hedef tarihleri üç yolla ekleyin: "Excel’den plan yükle", "Planner’dan aktar" ya da "Yapay zekâ ile güncelle" (örn. "W1.4 tamamlandı, W2.1 hedef tarihi 30 Ekim"). Her yol önce değişiklik listesi gösterir; "Uygula"ya basana kadar hiçbir şey değişmez. Durum ve tarihleri tabloda doğrudan değiştirebilirsiniz.'],
      ['Silme: ', '"Planı sil" yalnızca plan görevlerini, "Projeyi sil" projeyi listelerden kaldırır. Girilen efor ve raporlar her durumda korunur.'],
    ],
    tips: ['Yeni bir projeyi çalışanlar da eforlarını girerken ("+ Yeni proje ekle…") açabilir; açan kişi projenin ekibine eklenir.'] },
  { id: 'yonetim', icon: 'shield', title: 'Yönetim', role: 'Yalnızca yönetici', short: 'Kişiler, roller, bağlantılar, tatiller ve sistem durumu.',
    what: 'Uygulamanın ayarlarını yönettiğiniz sayfadır.',
    steps: [
      ['Kişiler ve roller: ', 'Çalışan, proje yöneticisi ya da yönetici rolünü verin. Aynı kişinin ikinci şirket hesabını "Hesap bağla" ile tek kişiye bağlayın.'],
      ['ITSM bağlantısı: ', 'ITSM anahtarını girin; anahtar doğrudan Key Vault’a kaydedilir, ekranda ve kayıtlarda görünmez. "Şimdi eşitle" biletleri yeniler.'],
      ['Mesai saatleri ve resmî tatiller: ', 'Sabit tarihli resmî tatiller hazırdır. Ramazan ve Kurban Bayramı gibi her yıl değişen günleri buradan ekleyin; eklediğiniz ya da sildiğiniz günde herkesin ekstra mesaisi yeniden hesaplanır.'],
      ['Dönem kapatma, sistem durumu, denetim kaydı: ', 'Geçmiş bir dönemi kapatarak değişikliği engelleyebilir, eşitleme durumunu ve kimin neyi yaptığını izleyebilirsiniz.'],
    ],
    tips: ['Kullanıcı listesindeki her kişi için e-posta adresleri önceden tanımlıdır; ilk girişte hesap otomatik eşleşir.'] },
];

async function guidePage(open) {
  const first = me.name.split(' ')[0];
  const allowed = GUIDE.filter((g) => !(g.id === 'projeler' && RANK[me.role] < 1) && !(g.id === 'yonetim' && RANK[me.role] < 2));
  const section = (g) => {
    const d = h('details', { id: 'g-' + g.id, open: g.id === open },
      h('summary', {}, h('span', { class: 'gi' }, icon(g.icon, 18)), h('span', {}, h('strong', {}, g.title), h('span', { class: 'muted' }, g.short))),
      h('div', { class: 'gbody' },
        h('div', { class: 'roles' }, h('span', { class: 'chip violet' }, g.role)),
        h('div', {}, h('h3', {}, 'Ne işe yarar'), h('p', {}, g.what)),
        h('div', {}, h('h3', {}, 'Nasıl kullanılır'), h('ol', {}, g.steps.map(([b, t]) => h('li', {}, h('strong', {}, b), t)))),
        g.tips?.length ? h('div', {}, h('h3', {}, 'İpuçları'), h('ul', {}, g.tips.map((t) => h('li', {}, t)))) : null,
        h('a', { class: 'btn', href: '#/' + g.id }, `${g.title} sayfasına git ›`)));
    return d;
  };
  const start = h('div', { class: 'card' }, h('h2', {}, `Hoş geldiniz, ${first}`),
    h('p', { class: 'muted' }, 'Effort Tracker, çalışma saatlerinizi tek yerde toplar. Hiçbir kayıt siz onaylamadan kaydedilmez; sayıları hep siz kontrol edersiniz.'),
    h('div', { class: 'start' },
      h('div', {}, h('b', {}, '1. Eforunuzu ekleyin'), h('span', { class: 'muted' }, 'Haftam’da görevinize saat yazın, Dosyadan Ekle’de formu bırakın ya da Asistan’a ne yaptığınızı yazın.')),
      h('div', {}, h('b', {}, '2. Kontrol edip onaylayın'), h('span', { class: 'muted' }, 'Taslak satırları gözden geçirin, gerekirse düzeltin ve "Onayla"ya basın.')),
      h('div', {}, h('b', {}, '3. Haftanızı izleyin'), h('span', { class: 'muted' }, 'Haftam’da eksik günleri, ekstra mesaiyi ve toplamı; Raporlar’da ayrıntıları görün.'))));
  add(h('h1', {}, 'Rehber'), start, h('div', { class: 'guide' }, allowed.map(section)));
  if (open) document.getElementById('g-' + open)?.scrollIntoView({ block: 'start' });
}

/* ---------- the assistant ---------- */

let conversationId = null;

/** Plain text with **bold** spans turned into <strong>; no HTML is ever parsed. */
function richText(text) {
  return String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? h('strong', {}, part.slice(2, -2)) : part));
}


/**
 * Assistant answers: a small, safe Markdown renderer. It only ever builds DOM nodes (no innerHTML), so nothing
 * the model writes can run as HTML. Supports headings, bullet / numbered lists, tables, **bold**, *italic*, `code`,
 * [links](https://…) and horizontal rules.
 */
function mdInline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
    else if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)));
    else if (t.startsWith('[')) { const [, label, url] = /^\[([^\]]+)\]\((.+)\)$/.exec(t); out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label)); }
    else out.push(h('em', {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const root = h('div', { class: 'md' });
  let i = 0;
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { root.append(h('div', { class: 'md-h md-h' + m[1].length }, mdInline(m[2]))); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { root.append(h('hr')); i++; continue; }
    if (isRow(line)) {
      const rows = [];
      while (i < lines.length && isRow(lines[i])) { rows.push(lines[i]); i++; }
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(r)).map(cells);
      if (body.length) {
        const [head, ...rest] = body;
        const num = (c) => /^[\d.,:%\s]+(saat|sa|gün|g|dk)?$/i.test(c) && /\d/.test(c);
        root.append(h('div', { class: 'scroll md-table' }, h('table', {},
          h('tr', {}, head.map((c) => h('th', {}, mdInline(c)))),
          rest.map((r) => h('tr', {}, r.map((c) => h('td', { class: num(c) ? 'num' : '' }, mdInline(c))))))));
      }
      continue;
    }
    if (/^\s*([-*•])\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = h(ordered ? 'ol' : 'ul');
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/).test(lines[i])) {
        list.append(h('li', {}, mdInline(lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*([-*•])\s+/, ''))));
        i++;
      }
      root.append(list);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !isRow(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { para.push(lines[i].replace(/\s{2,}$/, '')); i++; }
    const p = h('p', {});
    para.forEach((l, k) => { if (k) p.append(h('br')); p.append(...mdInline(l)); });
    root.append(p);
  }
  return root;
}

const avatar = () => h('span', { class: 'avatar', 'aria-hidden': 'true' }, icon('sparkles', 16));

async function asistanPage() {
  const isPM = RANK[me.role] >= 1;
  const first = me.name.split(' ')[0];
  const list = h('div', { class: 'chat', 'aria-live': 'polite' });
  let pendingFile = null;
  // Projects the person can attach a file to; if none load, the file is simply read as before (project found from the text).
  let myProjects = [];
  try { myProjects = await api('GET', '/api/projects'); } catch { /* optional */ }

  const fileChip = h('div', { class: 'filechip', hidden: true });
  const projPick = h('select', { 'aria-label': 'Dosyanın projesi', title: 'Bu dosya hangi projeye ait?' },
    h('option', { value: '' }, 'Proje: otomatik bul'), myProjects.map((p) => h('option', { value: p.id }, p.name)));
  const showFile = () => {
    if (!pendingFile) { fileChip.hidden = true; fileChip.replaceChildren(); projPick.value = ''; return; }
    fileChip.hidden = false;
    put(fileChip, icon('paperclip', 15), h('span', {}, pendingFile.name), myProjects.length ? projPick : null, h('button', { class: 'x', title: 'Dosyayı kaldır', 'aria-label': 'Dosyayı kaldır', onclick: () => { pendingFile = null; showFile(); } }, '×'));
  };

  const input = h('textarea', { rows: 1, class: 'grow', placeholder: 'Ne yaptığınızı yazın ya da bir soru sorun…', 'aria-label': 'Mesajınız' });
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
  input.addEventListener('input', autosize);

  const addMsg = (role, text, cards) => {
    // One bubble for the words; each card sits under it as its own panel, never inside the bubble.
    const col = h('div', { class: 'msgcol' }, text ? h('div', { class: 'bubble' + (role === 'assistant' ? ' formatted' : '') }, role === 'assistant' ? renderMarkdown(text) : richText(text)) : null);
    for (const c of cards || []) { const el = renderCard(c); if (el) col.append(c.type === 'report' ? el : h('div', { class: 'cardx' }, el)); }
    const m = h('div', { class: 'msg ' + role }, role === 'assistant' ? avatar() : null, col);
    list.append(m); list.scrollTop = list.scrollHeight;
    return m;
  };

  const chips = [
    ['Bu ay ne kadar çalıştım?', true],
    ['Bu haftayı günlere göre göster', true],
    ['Bugün 3 saat … yaptım', false],
    ...(isPM ? [['Açık biletler neler, kimin ne görevi var?', true], ['Teknisyen bazında açık bilet raporu', true], ['Projemde W1.4 tamamlandı olarak işaretle', false]] : []),
  ];
  const hero = h('div', { class: 'ai-hero' },
    h('span', { class: 'avatar big', 'aria-hidden': 'true' }, icon('sparkles', 26)),
    h('h2', {}, `Merhaba ${first}, size nasıl yardımcı olabilirim?`),
    h('p', { class: 'muted' }, 'Ne yaptığınızı yazın, bir efor dosyası bırakın ya da bir şey sorun. Önce size gösteririm; siz “Onayla” demeden hiçbir şey kaydedilmez.'),
    h('div', { class: 'chips' }, chips.map(([text, direct]) => h('button', { class: 'suggest', onclick: () => {
      input.value = text; autosize(); input.focus();
      if (direct) send();
      else { const i = text.indexOf('…'); if (i >= 0) input.setSelectionRange(i, i + 1); }
    } }, text))));

  const send = async () => {
    const text = input.value.trim(); const f = pendingFile;
    if (!text && !f) return;
    const projectId = f ? projPick.value : '';
    const projectName = projectId ? myProjects.find((x) => x.id === projectId)?.name : '';
    hero.remove();
    addMsg('user', (f ? `📎 ${f.name}${projectName ? ` (Proje: ${projectName})` : ''}\n` : '') + text);
    input.value = ''; autosize(); pendingFile = null; showFile();
    const fd = new FormData(); fd.set('message', text); if (conversationId) fd.set('conversationId', conversationId); if (f) fd.set('file', f); if (projectId) fd.set('projectId', projectId);
    sendBtn.disabled = true;
    const typing = h('div', { class: 'msg assistant' }, avatar(), h('div', { class: 'bubble typing' }, h('i'), h('i'), h('i')));
    list.append(typing); list.scrollTop = list.scrollHeight;
    try {
      const r = await api('POST', '/api/chat', fd);
      conversationId = r.conversationId; typing.remove(); addMsg('assistant', r.reply, r.cards);
    } catch (e) {
      typing.remove(); addMsg('assistant', e.status === 409 ? 'Bu dosyayı daha önce eklemişsiniz.' : 'Üzgünüm, bir sorun oldu: ' + e.message);
      if (e.data?.conversationId) conversationId = e.data.conversationId;
    } finally { sendBtn.disabled = false; input.focus(); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  const picker = h('input', { type: 'file', accept: FILE_TYPES, hidden: true, onchange: () => { pendingFile = picker.files[0] || null; showFile(); picker.value = ''; input.focus(); } });
  const attach = h('button', { class: 'icon-btn', title: 'Dosya ekle', 'aria-label': 'Dosya ekle', onclick: () => picker.click() }, icon('paperclip', 20));
  const sendBtn = h('button', { class: 'send', title: 'Gönder', 'aria-label': 'Gönder', onclick: send }, icon('send', 20));

  const panel = h('div', { class: 'card assistant' },
    h('div', { class: 'row head' }, avatar(), h('div', { class: 'grow headtext' }, h('strong', {}, 'Efor asistanı'), h('span', { class: 'muted small' }, 'Önce size gösterir; siz onaylamadan hiçbir şey kaydetmez')), h('button', { onclick: () => { conversationId = null; route(); } }, 'Yeni sohbet')),
    list, fileChip,
    h('div', { class: 'composer' }, attach, input, sendBtn, picker),
    h('div', { class: 'muted small' }, 'Enter ile gönderin, Shift+Enter ile yeni satır. Dosyayı sürükleyip bırakabilirsiniz.'));

  // Drop a file anywhere on the panel.
  for (const ev of ['dragenter', 'dragover']) panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.remove('over'); });
  panel.addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) { pendingFile = f; showFile(); input.focus(); } });

  let restored = false;
  if (conversationId) {
    try { for (const m of await api('GET', `/api/chat/${conversationId}/messages`)) { addMsg(m.role, m.content, m.card); restored = true; } } catch { conversationId = null; }
  }
  if (!restored) list.append(hero);
  add(h('h1', {}, 'Asistan'), panel);
  input.focus();
}

function renderCard(c) {
  if (c.type === 'draft') {
    const notes = (c.notes || []).map((n) => h('div', { class: 'note' }, icon('info', 14), h('span', {}, n)));
    if (!c.rows.length) {
      return h('div', { class: 'cardbody' }, h('div', { class: 'cardhead' }, h('strong', {}, 'Efor satırı çıkarılamadı')), notes,
        h('div', { class: 'muted small' }, 'Tarih, süre ve çalışmayı birlikte yazın. Örnek: “dün Alder projesinde 8 saat kurulum yaptım”.'));
    }
    const t = h('table', { class: 'mini' }, h('tr', {}, ...['Tarih', 'Efor', 'Açıklama', 'Bağlantı', ''].map((x) => h('th', {}, x))),
      c.rows.map((r) => h('tr', {}, h('td', {}, fmtDate(r.date)), h('td', {}, fmtH(r.hours)), h('td', {}, r.description), h('td', {}, r.link || '–'), h('td', {}, flagChips(r.flags)))));
    const wrap = h('div', { class: 'cardbody' },
      h('div', { class: 'cardhead' }, h('strong', {}, 'Taslak kayıtlar'), h('span', { class: 'chip info' }, `${c.rows.length} satır · ${fmtH(c.total)} saat`)),
      h('div', { class: 'scroll' }, t), notes);
    const status = h('span', {});
    const ok = h('button', { class: 'pri', disabled: c.blocked > 0, onclick: async () => {
      try { const r = await api('POST', `/api/uploads/${c.uploadId}/confirm`); ok.disabled = true; status.replaceChildren(msg('ok', `Kaydedildi: ${r.confirmed} satır, ${fmtH(c.total)} saat.`)); }
      catch (e) { status.replaceChildren(msg('err', e.message)); }
    } }, `${c.rows.length} satırı onayla`);
    wrap.append(h('div', { class: 'row actions' }, ok, h('a', { class: 'btn', href: `#/inceleme/${c.uploadId}`, title: 'Proje, müşteri ve görevi seçin; yeni proje ekleyin' }, 'Düzenle / proje ekle'), status));
    return wrap;
  }
  if (c.type === 'pending') {
    const status = h('span', {});
    const apply = h('button', { class: 'pri', onclick: async () => { try { await api('POST', `/api/pending/${c.actionId}/apply`); apply.disabled = true; status.replaceChildren(msg('ok', 'Uygulandı')); } catch (e) { status.replaceChildren(msg('err', e.message)); } } }, 'Uygula');
    return h('div', { class: 'cardbody' }, h('div', { class: 'cardhead' }, h('strong', {}, 'Önerilen değişiklik')), h('div', { class: 'pre' }, c.summary), h('div', { class: 'row' }, apply, h('button', { onclick: async () => { await api('POST', `/api/pending/${c.actionId}/cancel`); apply.disabled = true; status.textContent = 'İptal edildi'; } }, 'İptal'), status));
  }
  if (c.type === 'report') {
    return h('a', { class: 'inline-link', href: '#/raporlar', title: c.title, onclick: () => sessionStorage.setItem('efor.report', JSON.stringify(c.definition)) }, icon('chart', 15), 'Raporlar sayfasında aç ›');
  }
  return null;
}

/* ---------- tickets (ITSM) ---------- */

const when = (iso) => (iso ? new Date(iso).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

/** A ticket row plus its details panel, which is only fetched (live from ITSM) when opened. */
function ticketRow(b) {
  const panel = h('td', { colspan: 7, class: 'ticket-detail' });
  const detailRow = h('tr', { hidden: true }, panel);
  const btn = h('button', { 'aria-expanded': 'false', onclick: async () => {
    if (!detailRow.hidden) { detailRow.hidden = true; btn.textContent = 'Detay'; btn.setAttribute('aria-expanded', 'false'); return; }
    detailRow.hidden = false; btn.textContent = 'Kapat'; btn.setAttribute('aria-expanded', 'true');
    put(panel, h('div', { class: 'working' }, h('span', { class: 'spinner' }), 'Ayrıntılar ITSM sisteminden alınıyor…'));
    try { drawTicketDetail(panel, await api('GET', `/api/tickets/${encodeURIComponent(b.no)}`), b); }
    catch (e) { put(panel, msg('err', e.message)); }
  } }, 'Detay');
  const row = h('tr', {}, h('td', { class: 'mono' }, '#' + b.no), h('td', {}, b.konu), h('td', {}, b.musteri || '–'), h('td', {}, h('span', { class: 'chip ' + (/(çözül|kapal|resolved|closed)/i.test(b.durum || '') ? 'good' : /(bekle|hold|pending)/i.test(b.durum || '') ? 'warn' : 'info') }, b.durum || '–')), h('td', {}, b.sorumlu), h('td', { class: 'num' }, b.yas_gun ?? '–'), h('td', {}, btn));
  const frag = document.createDocumentFragment();
  frag.append(row, detailRow);
  return frag;
}

function drawTicketDetail(panel, r, b) {
  const d = r.detail;
  if (!d) {
    // The list data is still shown, with the reason the rest could not be fetched.
    const l = r.local || {};
    put(panel, r.error ? msg('err', r.error) : null,
      h('div', { class: 'kv' }, h('span', { class: 'muted' }, 'Konu'), h('span', {}, l.title || b.konu), h('span', { class: 'muted' }, 'Müşteri'), h('span', {}, l.customer || '–'), h('span', { class: 'muted' }, 'Durum'), h('span', {}, l.status || '–')));
    return;
  }
  const field = (label, value) => (value ? [h('span', { class: 'muted' }, label), h('span', {}, value)] : null);
  put(panel,
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, `#${d.no} · ${d.title}`),
      d.overdue ? h('span', { class: 'chip bad' }, 'süresi geçmiş') : null,
      d.url ? h('a', { class: 'btn', href: d.url, target: '_blank', rel: 'noopener noreferrer' }, 'ITSM sisteminde aç ↗') : null),
    h('div', { class: 'kv' },
      field('Durum', d.status), field('Öncelik', d.priority), field('Aciliyet', d.urgency), field('Etki', d.impact),
      field('Tür', d.requestType), field('Kategori', [d.category, d.subcategory].filter(Boolean).join(' › ')),
      field('Müşteri', d.customer), field('Grup', d.group), field('Site', d.site),
      field('Talep eden', [d.requester.name, d.requester.department, d.requester.email].filter(Boolean).join(' · ')),
      field('Sorumlu teknisyen', [d.technician.name, d.technician.email].filter(Boolean).join(' · ')),
      field('Açılış', when(d.createdAt)), field('İlk yanıt', d.respondedAt ? when(d.respondedAt) : null), field('Hedef bitiş', d.dueAt ? when(d.dueAt) : null),
      field('Çözüm zamanı', d.resolvedAt ? when(d.resolvedAt) : null), field('Kapanış', d.completedAt ? when(d.completedAt) : null)),
    d.description ? h('div', {}, h('strong', {}, 'Açıklama'), h('div', { class: 'pre ticket-text' }, d.description)) : h('p', { class: 'muted' }, 'Açıklama girilmemiş.'),
    d.resolution ? h('div', {}, h('strong', {}, 'Çözüm'), h('div', { class: 'pre ticket-text' }, d.resolution)) : null);
}

async function ticketsPage() {
  const state = { assignee: '', customer: '', open: '1' };
  const host = h('div', { class: 'card' });
  const who = h('input', { placeholder: 'Kişi ara', 'aria-label': 'Kişi' });
  const cust = h('input', { placeholder: 'Müşteri ara', 'aria-label': 'Müşteri' });
  const openSel = h('select', { 'aria-label': 'Durum' }, h('option', { value: '1' }, 'Yalnızca açık'), h('option', { value: '0' }, 'Tüm biletler'));

  const draw = async () => {
    const q = new URLSearchParams({ open: openSel.value });
    if (who.value.trim()) q.set('assignee', who.value.trim());
    if (cust.value.trim()) q.set('customer', cust.value.trim());
    const t = await api('GET', `/api/tickets?${q}`);
    const stateChip = t.connected
      ? h('span', { class: 'chip good' }, 'ITSM bağlı' + (t.last ? ` · son eşitleme ${new Date(t.last.last_run_at).toLocaleString('tr-TR')}` : ''))
      : h('span', { class: 'chip warn' }, 'ITSM bağlı değil');
    const people = h('div', { class: 'row' }, t.kisi_bazinda.map((p) => h('button', { class: 'suggest', onclick: () => { who.value = p.kisi; draw(); } }, `${p.kisi}: ${p.adet}`)));
    const table = t.biletler.length ? h('div', { class: 'scroll' }, h('table', {}, h('tr', {}, ...['No', 'Konu', 'Müşteri', 'Durum', 'Sorumlu', 'Açık (gün)', ''].map((x, i) => h('th', { class: i === 5 ? 'num' : '' }, x))),
      t.biletler.map((b) => ticketRow(b))))
      : h('div', { class: 'empty' }, h('h2', {}, t.connected ? 'Bu filtreyle bilet bulunamadı' : 'ITSM henüz bağlı değil'),
          h('p', {}, t.connected ? 'Açık bilet yok ya da size gösterilebilecek bilet bulunmuyor. Çalışanlar yalnızca kendilerine atanan biletleri görür.' : (me.role === 'Admin' ? 'Yönetim sayfasındaki ITSM kartına API anahtarını girin.' : 'Bir yönetici Yönetim sayfasından API anahtarını girince biletler burada görünür.')));
    put(host, h('div', { class: 'row' }, h('h2', { class: 'grow' }, t.scope === 'Employee' ? 'Biletlerim' : 'Biletler'), stateChip,
        me.role === 'Admin' ? h('button', { onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; try { const r = await api('POST', '/api/itsm/sync'); r.error ? toast('Eşitleme hatası: ' + r.error, 'err') : toast(`${r.tickets} bilet güncellendi.`); draw(); } catch (e) { toast(e.message, 'err'); b.disabled = false; } } }, 'Şimdi eşitle') : null),
      h('div', { class: 'summary' },
        h('div', { class: 'stat' }, h('span', { class: 'big' }, t.toplam_acik), h('span', { class: 'muted' }, openSel.value === '1' ? 'açık bilet' : 'bilet')),
        h('div', { class: 'stat grow' }, h('span', { class: 'muted' }, 'Kişi bazında (tıklayınca filtrelenir)'), people)),
      h('div', { class: 'row' }, who, cust, openSel, h('button', { onclick: () => { who.value = ''; cust.value = ''; draw(); } }, 'Filtreyi temizle')),
      table, t.gosterilmeyen ? h('p', { class: 'muted small' }, `${t.gosterilmeyen} bilet daha var; filtreyle daraltın.`) : null);
  };
  for (const el of [who, cust]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') draw(); });
  openSel.addEventListener('change', draw);
  add(h('h1', {}, 'Biletler'), host);
  await draw();
}

/* ---------- reports ---------- */

const GROUP_LABELS = { person: 'Kişi', project: 'Proje', task: 'Görev / bilet', customer: 'Müşteri', tenant: 'Şirket', link: 'Bağlantı', source: 'Kaynak', day: 'Gün', week: 'Hafta', month: 'Ay', category: 'Kategori', entry_customer: 'Müşteri / İç Çalışma', work_item: 'Proje / SLA / Fırsat', product: 'Ürün / Teknoloji' };

async function reportsPage() {
  const [presets, projects, saved] = await Promise.all([api('GET', '/api/reports/presets'), api('GET', '/api/projects'), api('GET', '/api/reports/saved')]);
  const isPM = RANK[me.role] >= 1;
  const from = h('input', { type: 'date', value: todayIso().slice(0, 8) + '01' });
  const to = h('input', { type: 'date', value: todayIso() });
  const preset = h('select', {}, h('option', { value: '' }, 'Hazır rapor seçin…'), presets.map((p) => h('option', { value: p.id }, p.name)));
  const groups = Object.entries(GROUP_LABELS).map(([k, label]) => ({ k, box: h('input', { type: 'checkbox', value: k }), label }));
  const projSel = h('select', { multiple: true, size: 3 }, projects.map((p) => h('option', { value: p.id }, p.name)));
  const otOnly = h('input', { type: 'checkbox' });
  const catSel = h('select', {}, h('option', { value: '' }, 'Kategori: hepsi'), CATEGORIES.map((c) => h('option', { value: c }, c)));
  const linkKind = h('select', {}, [['', 'Bağlantı: hepsi'], ['planner', 'Planner'], ['project', 'Proje planı'], ['itsm', 'ITSM'], ['none', 'Bağlantısız']].map(([v, l]) => h('option', { value: v }, l)));
  const out = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Yalnızca onaylanmış kayıtlar sayılır.'));
  let current = null;

  const definition = () => ({
    kind: 'effort', from: from.value, to: to.value, groupBy: groups.filter((g) => g.box.checked).map((g) => g.k),
    filters: { ...(projSel.selectedOptions.length ? { projectIds: [...projSel.selectedOptions].map((o) => o.value) } : {}), ...(linkKind.value ? { linkKind: linkKind.value } : {}), ...(catSel.value ? { category: catSel.value } : {}), ...(otOnly.checked ? { overtimeOnly: true } : {}) },
  });
  const run = async (body) => {
    current = body;
    const r = await api('POST', '/api/reports/run', body);
    const t = h('table', {}, h('tr', {}, r.columns.map((c) => h('th', { class: ['hours', 'overtime', 'entries', 'missing'].includes(c.key) ? 'num' : '' }, c.label))),
      r.rows.map((row) => h('tr', {}, r.columns.map((c) => h('td', { class: ['hours', 'overtime', 'entries', 'missing'].includes(c.key) ? 'num' : '' }, ['hours', 'overtime'].includes(c.key) ? fmtH(row[c.key]) : row[c.key])))),
      h('tr', {}, h('td', {}, h('strong', {}, 'Toplam')), r.columns.slice(1).map((c) => h('td', { class: 'num' }, h('strong', {}, c.key === 'hours' || c.key === 'missing' ? fmtH(r.total) : c.key === 'overtime' ? fmtH(r.overtime) : c.key === 'entries' ? r.entries : '')))));
    const q = encodeURIComponent(JSON.stringify(body));
    put(out, h('h2', {}, r.title), h('div', { class: 'muted' }, `${fmtDate(r.from)} – ${fmtDate(r.to)} · ${r.filters.join('; ') || 'filtre yok'} · çalıştırıldı ${new Date(r.generatedAt).toLocaleString('tr-TR')}`),
      r.rows.length ? h('div', { class: 'scroll' }, t) : h('p', { class: 'muted' }, 'Bu dönemde kayıt yok.'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: `/api/reports/export?format=xlsx&q=${q}` }, 'Excel'), h('a', { class: 'btn', href: `/api/reports/export?format=pdf&q=${q}` }, 'PDF'), saveControls(r.definition)));
  };
  const saveControls = (definition) => {
    const name = h('input', { placeholder: 'Rapor adı' });
    const sched = isPM ? h('select', {}, [['', 'Zamanlama yok'], ['monthly', 'Her ayın 1’i 08:00 (önceki ay)'], ['weekly', 'Her Cuma 08:00 (son 7 gün)']].map(([v, l]) => h('option', { value: v }, l))) : null;
    const rec = isPM ? h('input', { placeholder: 'alıcılar (virgülle)', size: 24, value: me.email }) : null;
    return h('span', { class: 'row' }, name, sched, rec, h('button', { onclick: () => guard(out, async () => {
      const schedule = sched?.value ? { kind: sched.value, day: sched.value === 'monthly' ? 1 : 5, hour: 8, recipients: rec.value.split(',').map((s) => s.trim()).filter(Boolean) } : null;
      await api('POST', '/api/reports/saved', { name: name.value, definition, schedule });
      route();
    }) }, 'Kaydet'));
  };

  const form = h('div', { class: 'card' }, h('h2', {}, 'Rapor oluştur'),
    h('div', { class: 'row' }, preset, h('button', { class: 'pri', onclick: () => preset.value && guard(out, () => run({ preset: preset.value, from: from.value, to: to.value })) }, 'Hazır raporu çalıştır')),
    h('fieldset', {}, h('legend', {}, 'Özel rapor'),
      h('div', { class: 'row' }, h('label', {}, 'Başlangıç', from), h('label', {}, 'Bitiş', to), isPM ? h('label', {}, 'Projeler', projSel) : null, h('label', {}, 'Bağlantı', linkKind), h('label', {}, 'Kategori', catSel), h('label', { class: 'row' }, otOnly, 'Yalnızca ekstra mesai')),
      h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Grupla:'), groups.map((g) => h('label', { class: 'row' }, g.box, g.label))),
      h('button', { class: 'pri', onclick: () => guard(out, () => run({ definition: definition() })) }, 'Çalıştır')));
  const savedCard = saved.length ? h('div', { class: 'card' }, h('h2', {}, 'Kayıtlı raporlar'), saved.map((s) => h('div', { class: 'row' }, h('strong', { class: 'grow' }, s.name), s.schedule ? h('span', { class: 'chip' }, s.schedule.kind === 'monthly' ? 'aylık e-posta' : 'haftalık e-posta') : null,
    h('button', { onclick: () => guard(out, () => run({ definition: s.definition })) }, 'Çalıştır'), h('button', { class: 'danger', onclick: async () => { await api('DELETE', `/api/reports/saved/${s.id}`); route(); } }, 'Sil')))) : null;
  add(h('h1', {}, 'Raporlar'), form, savedCard, out);
  const fromChat = sessionStorage.getItem('efor.report');
  if (fromChat) { sessionStorage.removeItem('efor.report'); guard(out, () => run({ definition: JSON.parse(fromChat) })); }
}

/* ---------- projects (PM) ---------- */

/** Projects as cards; opening one shows its detail with back / previous / next, and the browser's back button works too. */
async function projectsPage(openId) {
  const [projects, people, tenants, customers] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/employees'), api('GET', '/api/tenants'), api('GET', '/api/customers')]);
  if (openId) {
    const i = projects.findIndex((p) => p.id === openId);
    if (i < 0) { add(h('a', { class: 'btn', href: '#/projeler' }, '‹ Projeler'), msg('err', 'Bu proje bulunamadı ya da silinmiş.')); return; }
    const near = (k) => { const p = projects[i + k]; return p ? h('a', { class: 'btn', href: `#/projeler/${p.id}`, title: p.name }, k < 0 ? '‹ Önceki' : 'Sonraki ›') : h('span', {}); };
    add(h('div', { class: 'row projnav' }, h('a', { class: 'btn', href: '#/projeler' }, '‹ Tüm projeler'), h('span', { class: 'grow' }), h('span', { class: 'muted' }, `${i + 1} / ${projects.length}`), near(-1), near(1)),
      projectDetail(projects[i], people, customers));
    return;
  }
  const name = h('input', { placeholder: 'Proje adı' }); const custF = customerField(customers, { placeholder: 'Müşteri (ITSM listesi)' }); const customer = custF.input;
  const tenant = h('select', {}, tenants.map((t) => h('option', { value: t.id }, t.name)));
  const planBox = h('div', { class: 'muted' }, 'Planner planı bağlamak için şirketi seçip "Planları getir"e basın.');
  let plans = [];
  const planList = h('div', { class: 'planlist' });
  const checks = new Map();
  const create = h('div', { class: 'card' }, h('h2', {}, 'Yeni proje'));
  // Ticking exactly one plan sets the project name to that plan's Planner name (edit the name afterwards to override).
  // Ticking several plans merges their tasks into one project, so the name is cleared and has to be typed on purpose.
  const pickedInfo = h('div', { class: 'muted small' });
  const syncName = () => {
    const picked = plans.filter((p) => checks.get(p.id)?.checked);
    if (picked.length === 1) { name.value = picked[0].title.trim(); name.dataset.auto = '1'; }
    else if (name.dataset.auto === '1') { name.value = ''; name.dataset.auto = ''; }
    pickedInfo.textContent = picked.length > 1 ? `${picked.length} plan işaretli: görevleri tek projede birleşir; proje için bir ad yazın.`
      : picked.length === 1 ? 'Proje adı işaretlediğiniz Planner planından alındı (isterseniz değiştirebilirsiniz).' : '';
  };
  name.addEventListener('input', () => { name.dataset.auto = ''; });
  // A search box: type a word from the project name to narrow the plan list instead of typing it into the name field.
  const planFilter = h('input', { type: 'search', placeholder: 'Planlarda ara (adından bir kelime yazın)', hidden: true, oninput: () => {
    const q = planFilter.value.trim().toLocaleLowerCase('tr');
    for (const row of planList.children) row.hidden = !!q && !row.textContent.toLocaleLowerCase('tr').includes(q);
  } });
  create.append(h('div', { class: 'row' }, name, custF.el, tenant, h('button', { onclick: () => guard(create, async () => {
    const found = await api('GET', `/api/planner/plans?tenantId=${encodeURIComponent(tenant.value)}`);
    plans = found.plans;
    checks.clear();
    planFilter.value = ''; planFilter.hidden = !plans.length; syncName();
    put(planList, plans.map((p) => {
      const holder = p.project ? { name: p.project } : projects.find((pr) => (pr.plans || []).some((x) => x.planId === p.id));
      const box = h('input', { type: 'checkbox', onchange: syncName, disabled: !!holder });
      if (!holder) checks.set(p.id, box);
      return h('label', { class: 'planrow' + (holder ? ' taken' : '') }, box, h('span', {}, `${p.groupName} › ${p.title.trim()}`),
        holder ? h('span', { class: 'chip' }, `zaten “${holder.name}” projesinde`) : null);
    }));
    const free = plans.filter((p) => !p.project && !projects.some((pr) => (pr.plans || []).some((x) => x.planId === p.id)));
    planBox.replaceChildren(
      plans.length ? 'Projeye bağlanacak planları işaretleyin (bir plan tek projeye bağlanabilir; zaten bağlı olanlar işaretlenemez). Tek plan işaretlerseniz proje adı o plandan gelir; birden fazla plan işaretlerseniz görevleri tek projede birleşir ve bir ad yazmanız gerekir.' : 'Plan bulunamadı. Yönetici onayı verildi mi?',
      h('div', { class: 'muted small' }, `${found.groups} Microsoft 365 grubu tarandı, ${plans.length} plan bulundu (${free.length} tanesi henüz bir projeye bağlı değil).`),
      found.skipped.length ? h('div', { class: 'err small' }, `${found.skipped.length} grubun planları okunamadı: ` + found.skipped.slice(0, 5).map((x) => `${x.group} (${x.reason})`).join('; ')) : null,
      free.length ? h('button', { onclick: async (ev) => {
        if (!confirm(`Bağlı olmayan ${free.length} planın her biri için ayrı bir proje oluşturulsun mu? İstemediklerinizi sonradan “Projeyi sil” ile kaldırabilirsiniz.`)) return;
        const b = ev.currentTarget; b.disabled = true; b.textContent = 'Projeler oluşturuluyor…';
        try { const r = await api('POST', '/api/projects/from-plans', { tenantId: tenant.value }); toast(`${r.created} proje oluşturuldu. Planner görevleri eşitleniyor…`); route(); }
        catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = `Bağlı olmayan ${free.length} planı proje yap`; }
      } }, `Bağlı olmayan ${free.length} planı proje yap`) : null);
  }) }, 'Planları getir')), planBox, planFilter, planList, pickedInfo,
  h('button', { class: 'pri', onclick: () => guard(create, async () => {
    const chosen = plans.filter((p) => checks.get(p.id)?.checked);
    if (!name.value.trim() && !chosen.length) throw new Error('Bir proje adı yazın ya da Planner planı işaretleyin.');
    if (!name.value.trim() && chosen.length > 1) throw new Error('Birden fazla plan işaretlediniz; proje için bir ad yazın.');
    if (chosen.length > 1 && !confirm(`${chosen.length} planın görevleri tek projede (“${name.value.trim()}”) birleşecek:\n\n${chosen.map((p) => '• ' + p.title.trim()).join('\n')}\n\nEmin misiniz? Ayrı projeler istiyorsanız İptal’e basıp planları tek tek kaydedin.`)) return;
    await api('POST', '/api/projects', { name: name.value.trim() || undefined, customer: customer.value.trim() || null, tenantId: tenant.value, plans: chosen.map((p) => ({ tenantId: tenant.value, planId: p.id, title: p.title.trim() })) });
    route();
  }) }, 'Oluştur'));

  const cards = projects.map((p) => projectCardTile(p));
  const sync = h('button', { onclick: () => guard(app, async () => { const r = await api('POST', '/api/planner/sync'); toast(r.map((x) => `${x.tasks} görev, ${x.plans} plan${x.error ? ' – hata: ' + x.error : ''}`).join('\n') || 'Bağlı plan yok'); }) }, 'Planner’ı şimdi eşitle');
  const guide = projects.length ? null : h('div', { class: 'card how' },
    h('h2', {}, 'İlk projenizi oluşturun'),
    h('ol', {},
      h('li', {}, h('strong', {}, 'Şirketi seçip “Planları getir”e basın. '), 'Planner’daki planlar listelenir; projeye bağlamak istediklerinizi işaretleyin.'),
      h('li', {}, h('strong', {}, 'Proje adını yazın '), '(tek plan işaretlerseniz ad plandan gelir) ve “Oluştur”a basın. Planner görevleri hemen eşitlenir.'),
      h('li', {}, h('strong', {}, 'Ekibi seçin '), 've “Ekibi kaydet”e basın; seçilen kişiler eforlarını bu projenin görevlerine bağlayabilir.'),
      h('li', {}, h('strong', {}, 'İsterseniz proje planını ekleyin: '), '“Excel’den plan yükle” ile görev, sorumlu ve hedef tarihleri aktarın.')));
  const newBox = h('details', { class: 'planbox', open: !projects.length }, h('summary', {}, h('strong', {}, '＋ Yeni proje')), create);
  add(h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Projeler'), sync), guide, newBox, h('div', { class: 'pgrid' }, cards));
}

function projectCardTile(p) {
  const n = (p.members || []).length;
  const chip = (t, cls = '') => h('span', { class: 'chip ' + cls }, t);
  return h('a', { class: 'pcard', href: `#/projeler/${p.id}` },
    h('strong', {}, p.name), h('span', { class: 'muted' }, p.customer || 'Müşteri belirtilmemiş'),
    h('div', { class: 'row tight' }, chip(`${n} kişi`, n ? 'info' : 'warn'),
      (p.plans || []).length ? chip(`Planner: ${p.task_count || 0} görev`, 'good') : null,
      p.plan_count ? chip(`Plan: ${p.plan_count} görev`, 'violet') : null),
    h('span', { class: 'open-hint' }, 'Aç ›'));
}

function projectDetail(p, people, customers = []) {
  {
    const members = new Set(p.members || []);
    // Team as a checklist: tick the people who work on this project.
    const boxes = people.filter((x) => x.active).map((x) => ({ id: x.id, box: h('input', { type: 'checkbox', checked: members.has(x.id) }), x }));
    const count = h('span', { class: 'muted' });
    const saved = h('span', {});
    const refreshCount = () => { count.textContent = `${boxes.filter((b) => b.box.checked).length} kişi seçili`; };
    boxes.forEach((b) => b.box.addEventListener('change', refreshCount));
    refreshCount();
    const list = h('div', { class: 'planlist' }, boxes.map((b) => h('label', { class: 'planrow' }, b.box, h('span', {}, b.x.name), h('span', { class: 'muted' }, b.x.email))));
    // Edit the project's own details: name, customer, code. Only the creator and admins may save (the server decides).
    const nameIn = h('input', { value: p.name, class: 'grow', 'aria-label': 'Proje adı', placeholder: 'Proje adı' });
    const custEdit = customerField(customers, { value: p.customer || '', placeholder: 'Müşteri (listeden seçin ya da yazın)' });
    const codeIn = h('input', { value: p.code || '', 'aria-label': 'Proje kodu', placeholder: 'Kod (isteğe bağlı)', size: 12 });
    const editBox = h('div', { class: 'inline-add', hidden: true },
      h('strong', {}, 'Projeyi düzenle'),
      h('div', { class: 'row' }, nameIn, custEdit.el, codeIn),
      h('div', { class: 'row' },
        h('button', { class: 'pri', onclick: async (ev) => {
          const btn = ev.currentTarget; btn.disabled = true;
          try {
            await api('PATCH', `/api/projects/${p.id}`, { name: nameIn.value, customer: custEdit.input.value.trim() || null, code: codeIn.value.trim() || null });
            toast('Proje güncellendi.'); route();
          } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
        } }, 'Kaydet'),
        h('button', { onclick: () => { editBox.hidden = true; nameIn.value = p.name; custEdit.input.value = p.customer || ''; codeIn.value = p.code || ''; } }, 'Vazgeç')));
    return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, p.name), h('button', { onclick: () => { editBox.hidden = !editBox.hidden; if (!editBox.hidden) nameIn.focus(); } }, 'Düzenle')), editBox,
      h('div', { class: 'muted' }, [p.code, p.customer, ...(p.plans || []).map((x) => 'Plan: ' + (x.title || x.planId))].filter(Boolean).join(' · ')),
      plannerBlock(p),
      planBlock(p),
      h('strong', {}, 'Ekip'), list,
      h('div', { class: 'row' },
        h('button', { class: 'pri', onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const ids = boxes.filter((b) => b.box.checked).map((b) => b.id);
            await api('PUT', `/api/projects/${p.id}/members`, { employeeIds: ids });
            put(saved, msg('ok', `Ekip kaydedildi: ${ids.length} kişi.`));
          } catch (e) {
            put(saved, msg('err', `Kaydedilemedi: ${e.message}`));
          } finally { btn.disabled = false; }
        } }, 'Ekibi kaydet'),
        h('button', { onclick: () => { const all = boxes.some((b) => !b.box.checked); boxes.forEach((b) => { b.box.checked = all; }); refreshCount(); } }, 'Tümünü seç / kaldır'), count, saved),
      h('div', { class: 'danger-zone' }, h('button', { class: 'danger', onclick: async () => {
        if (!confirm(`“${p.name}” projesi silinsin mi? Proje listelerden kalkar ve Planner eşitlemesi durur. Girilen efor ve raporlar korunur.`)) return;
        try { await api('DELETE', `/api/projects/${p.id}`); toast('Proje silindi.'); route(); } catch (e) { toast(e.message, 'err'); }
      } }, 'Projeyi sil')));
  }
}

/** Planner status of one project: what was synced, when, a sync button, and the task list itself. */
function plannerBlock(p) {
  const linked = (p.plans || []).length > 0;
  const info = h('div', {}, p.task_count
    ? [h('strong', {}, `${p.task_count} Planner görevi`), h('span', { class: 'muted' }, ` eşitlendi · son eşitleme ${new Date(p.synced_at).toLocaleString('tr-TR')}`)]
    : h('span', { class: 'muted' }, linked ? 'Henüz görev eşitlenmedi. "Şimdi eşitle"ye basın.' : 'Bu projeye Planner planı bağlı değil.'));
  const status = h('span', {});
  const list = h('div', { class: 'scroll' });
  const syncBtn = h('button', { disabled: !linked, onclick: async () => {
    syncBtn.disabled = true; syncBtn.textContent = 'Eşitleniyor…';
    try {
      const r = await api('POST', `/api/projects/${p.id}/sync`);
      const err = r.find((x) => x.error);
      if (err) put(status, msg('err', `Eşitleme hatası: ${err.error}`));
      else { put(status, msg('ok', `${r.reduce((s, x) => s + x.tasks, 0)} görev okundu.`)); setTimeout(route, 1200); }
    } catch (e) { put(status, msg('err', `Eşitlenemedi: ${e.message}`)); }
    finally { syncBtn.disabled = !linked; syncBtn.textContent = 'Şimdi eşitle'; }
  } }, 'Şimdi eşitle');
  const showBtn = h('button', { disabled: !p.task_count, onclick: async () => {
    if (list.firstChild) { list.replaceChildren(); showBtn.textContent = 'Görevleri göster'; return; }
    const tasks = await api('GET', `/api/projects/${p.id}/tasks`);
    list.replaceChildren(h('table', {}, h('tr', {}, ...['Kova', 'Görev', 'Atanan', 'Bitiş', '%'].map((x) => h('th', {}, x))),
      tasks.map((t) => h('tr', {}, h('td', {}, t.bucket || '–'), h('td', {}, t.title),
        h('td', {}, t.assignees.length ? t.assignees.join(', ') : (t.assignee_count ? `${t.assignee_count} kişi (sistemde eşleşme yok)` : '–')),
        h('td', {}, fmtDate(t.due_date)), h('td', {}, t.percent_complete)))));
    showBtn.textContent = 'Görevleri gizle';
  } }, 'Görevleri göster');
  const links = (p.plans || []).map((x) => h('span', { class: 'chip' }, x.title || x.planId, h('button', { class: 'link-btn', title: 'Bu Planner planının bağlantısını kaldır', onclick: async () => {
    if (!confirm(`“${x.title || x.planId}” planının bağlantısı kaldırılsın mı? Eşitlenen görevleri bu projeden silinir (Planner’daki plan etkilenmez).`)) return;
    try { const r = await api('DELETE', `/api/projects/${p.id}/plans/${encodeURIComponent(x.tenantId)}/${encodeURIComponent(x.planId)}`); toast(`Bağlantı kaldırıldı (${r.removedTasks} görev).`); route(); } catch (e) { toast(e.message, 'err'); }
  } }, '×')));
  return h('div', { class: 'planner' }, h('strong', {}, 'Planner'), links.length ? h('div', { class: 'row' }, links) : null, info, h('div', { class: 'row' }, syncBtn, showBtn, status), list);
}

/** The project's own plan: import from Excel, edit status and dates, or describe a change to the assistant. */
const PLAN_STATUS = ['Planlandı', 'Devam', 'Tamamlandı', 'Bloke'];
const STATUS_CLASS = { Planlandı: 'info', Devam: 'warn', Tamamlandı: 'good', Bloke: 'bad' };

function planBlock(p) {
  const msgBox = h('div', {});
  const table = h('div', { class: 'scroll' });
  const summary = h('span', { class: 'muted' }, p.plan_count ? `${p.plan_count} görev` : 'Henüz plan yok');

  const loadPlan = async () => {
    const rows = await api('GET', `/api/projects/${p.id}/plan`);
    summary.textContent = rows.length ? `${rows.length} görev` : 'Henüz plan yok';
    if (!rows.length) { put(table, h('p', { class: 'muted' }, 'Excel proje planınızı yükleyin ya da yapay zekâ asistanına görevleri yazdırın.')); return; }
    const today = todayIso();
    const counts = PLAN_STATUS.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, n]) => n);
    const t = h('table', {}, h('tr', {}, ...['ID', 'Görev', 'Sahip', 'Bağımlılık', 'Hedef tarih', 'Durum'].map((x) => h('th', {}, x)), h('th', {})));
    let section = Symbol();
    for (const r of rows) {
      if (r.section !== section) {
        section = r.section;
        t.append(h('tr', {}, h('td', { colspan: 7, class: 'sect' }, r.section || 'Bölümsüz')));
      }
      const late = r.due_date && r.due_date < today && r.status !== 'Tamamlandı';
      const date = h('input', { type: 'date', value: r.due_date || '', onchange: () => save(r.id, { due_date: date.value || null }) });
      const st = h('select', { onchange: () => save(r.id, { status: st.value }) }, PLAN_STATUS.map((x) => h('option', { value: x, selected: r.status === x }, x)));
      t.append(h('tr', {}, h('td', { class: 'mono' }, r.ext_id), h('td', {}, r.title), h('td', {}, r.owner_name || '–'),
        h('td', { class: 'muted' }, r.depends_on || '–'), h('td', {}, date, late ? h('span', { class: 'chip bad' }, 'gecikmiş') : null), h('td', {}, st),
        h('td', {}, h('button', { class: 'danger', title: 'Görevi sil', onclick: async () => {
          if (!confirm(`${r.ext_id} görevi silinsin mi? Bu göreve girilen efor silinmez, yalnızca görev bağlantısı kalkar.`)) return;
          try { await api('DELETE', `/api/projects/${p.id}/plan/${r.id}`); toast('Görev silindi.'); await loadPlan(); } catch (e) { put(msgBox, msg('err', e.message)); }
        } }, 'Sil'))));
    }
    put(table, h('div', { class: 'row' }, counts.map(([s, n]) => h('span', { class: 'chip ' + STATUS_CLASS[s] }, `${s}: ${n}`))), h('div', { class: 'scroll' }, t));
  };
  const save = async (taskId, body) => {
    try { await api('PATCH', `/api/projects/${p.id}/plan/${taskId}`, body); put(msgBox, msg('ok', 'Kaydedildi.')); setTimeout(() => put(msgBox), 1500); await loadPlan(); }
    catch (e) { put(msgBox, msg('err', e.message)); }
  };

  // A proposal (from the import or from the assistant) is shown as a list of changes; nothing happens until "Uygula".
  const showProposal = (r) => {
    box.open = true;
    if (!r.actionId) {
      put(msgBox, msg('err', [...(r.notes || []), ...(r.rejected || [])].join(' ') || 'Uygulanabilir bir değişiklik çıkmadı.'));
      return;
    }
    const apply = h('button', { class: 'pri', onclick: async () => {
      apply.disabled = true;
      try { const a = await api('POST', `/api/pending/${r.actionId}/apply`); put(msgBox, msg('ok', a.summary)); await loadPlan(); setTimeout(route, 1500); }
      catch (e) { put(msgBox, msg('err', e.message)); }
    } }, `Uygula (${r.lines.length})`);
    put(msgBox, h('div', { class: 'proposal' },
      h('strong', {}, `${r.lines.length} değişiklik önerildi. Henüz hiçbiri uygulanmadı.`),
      h('ul', {}, r.lines.map((l) => h('li', {}, l))),
      (r.rejected || []).length ? msg('err', 'Reddedilen: ' + r.rejected.join('; ')) : null,
      (r.notes || []).map((n) => h('div', { class: 'muted' }, 'ℹ ' + n)),
      h('div', { class: 'row' }, apply, h('button', { onclick: async () => { await api('POST', `/api/pending/${r.actionId}/cancel`); put(msgBox); } }, 'Vazgeç'))));
  };

  const file = h('input', { type: 'file', accept: '.xlsx,.xlsm,.csv', hidden: true, onchange: async () => {
    const f = file.files[0]; if (!f) return;
    box.open = true;
    put(msgBox, h('span', { class: 'muted' }, 'Dosya okunuyor…'));
    try { const fd = new FormData(); fd.set('file', f); showProposal(await api('POST', `/api/projects/${p.id}/plan/import`, fd)); }
    catch (e) { put(msgBox, msg('err', e.message)); }
    file.value = '';
  } });
  const fromPlanner = h('button', { title: 'Bağlı Planner planındaki görevleri proje planına aktarır', onclick: async () => {
    box.open = true;
    fromPlanner.disabled = true; put(msgBox, h('span', { class: 'muted' }, 'Planner okunuyor…'));
    try { showProposal(await api('POST', `/api/projects/${p.id}/plan/from-planner`)); }
    catch (e) { put(msgBox, msg('err', e.message)); }
    finally { fromPlanner.disabled = false; }
  } }, 'Planner’dan aktar');
  const instr = h('input', { class: 'grow', placeholder: 'Örn: W1.4 tamamlandı, W2.1 hedef tarihi 30 Ekim olsun, "Dashboard" görevi ekle' });
  const ask = h('button', { onclick: async () => {
    if (!instr.value.trim()) return;
    box.open = true;
    ask.disabled = true; put(msgBox, h('span', { class: 'muted' }, 'Asistan planı inceliyor…'));
    try { showProposal(await api('POST', `/api/projects/${p.id}/plan/assist`, { instruction: instr.value })); }
    catch (e) { put(msgBox, msg('err', e.message)); }
    finally { ask.disabled = false; }
  } }, 'Yapay zekâ ile güncelle');
  instr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask.click(); });

  const box = h('details', { class: 'planbox', open: p.plan_count > 0 },
    h('summary', {}, h('strong', {}, 'Proje planı '), summary),
    h('div', { class: 'row' }, h('button', { onclick: () => file.click() }, 'Excel’den plan yükle'), file, fromPlanner, instr, ask,
      h('button', { class: 'danger', onclick: async () => {
        if (!p.plan_count) { toast('Silinecek plan yok.', 'err'); return; }
        if (!confirm(`“${p.name}” projesinin planındaki tüm görevler (${p.plan_count}) silinsin mi? Proje, ekip ve girilen efor kalır.`)) return;
        try { const r = await api('DELETE', `/api/projects/${p.id}/plan`); toast(`${r.deleted} görev silindi.`); route(); } catch (e) { put(msgBox, msg('err', e.message)); }
      } }, 'Planı sil')),
    msgBox, table);
  if (p.plan_count > 0) loadPlan().catch((e) => put(table, msg('err', e.message)));
  else put(table, h('p', { class: 'muted' }, 'Excel proje planınızı yükleyin ya da yapay zekâ asistanına görevleri yazdırın.'));
  return box;
}

/** "Görevlerim": what I can log effort against, with a quick hours field per task. */
/**
 * Calendar meetings as effort: connect the calendar once (read-only, your own calendar), fetch the week's meetings,
 * tick the ones to add. Nothing is saved before the click, and a meeting already added is shown as added.
 */
function calendarCard(weekStart, status, projects, customers = []) {
  if (!status?.enabled) return null;
  const head = h('h2', {}, 'Takvimden toplantılar');
  if (!status.connected) {
    return h('div', { class: 'card calcard' }, head,
      h('p', { class: 'muted' }, 'Outlook / Teams takviminizdeki toplantıları efor olarak ekleyin. Yalnızca kendi takviminiz okunur (salt okuma izni); siz seçip eklemeden hiçbir şey kaydedilmez. Bağlantıyı istediğiniz zaman kaldırabilirsiniz.'),
      h('a', { class: 'btn pri', href: '/auth/calendar/connect' }, 'Takvimimi bağla'));
  }
  const today = todayIso();
  const weekEnd = addDays(weekStart, 6);
  const to = weekEnd < today ? weekEnd : today;
  const out = h('div', {});
  const fetchBtn = h('button', { class: 'pri', disabled: to < weekStart, onclick: () => guard(out, async () => {
    fetchBtn.disabled = true; fetchBtn.textContent = 'Takvim okunuyor…';
    try { draw(await api('GET', `/api/calendar/meetings?from=${weekStart}&to=${to}`)); }
    finally { fetchBtn.disabled = to < weekStart; fetchBtn.textContent = 'Bu haftanın toplantılarını getir'; }
  }) }, 'Bu haftanın toplantılarını getir');
  const draw = (r) => {
    if (!r.meetings.length) { put(out, h('p', { class: 'muted' }, `${fmtDate(weekStart)} – ${fmtDate(to)} arasında eklenecek toplantı yok.` + (r.skipped ? ` (${r.skipped} olay listelenmedi: iptal, tüm gün, boşta ya da reddedilmiş.)` : ''))); return; }
    const rows = r.meetings.map((m) => {
      const box = h('input', { type: 'checkbox', checked: !m.imported, disabled: m.imported, 'aria-label': m.subject });
      const name = h('input', { value: m.subject, class: 'grow', 'aria-label': 'Toplantı adı (değiştirebilirsiniz)', title: 'Efora bu adla eklenir; değiştirebilirsiniz' });
      const proj = h('select', { 'aria-label': 'Proje', disabled: m.imported }, h('option', { value: '' }, 'Proje: yok'), projects.map((p) => h('option', { value: p.id, selected: p.id === m.projectId }, p.name)));
      const cat = h('select', { 'aria-label': 'Kategori', disabled: m.imported }, CATEGORIES.map((c) => h('option', { value: c, selected: c === m.category }, c)));
      const guess = projects.find((p) => p.id === m.projectId);
      const cust = customerField(customers, { value: guess?.customer || '', placeholder: 'Müşteri / İç Çalışma' });
      let prev = guess || null;
      proj.addEventListener('change', () => {
        const p = projects.find((x) => x.id === proj.value) || null;
        const c = cust.input.value.trim();
        if (p) {
          if (p.customer && (!c || c === 'İç Çalışma' || c === (prev?.customer || ''))) { cust.input.value = p.customer; cust.input.dispatchEvent(new Event('input')); }
          if (cat.value === 'İç Operasyon') cat.value = 'Proje';
        }
        prev = p;
      });
      box.addEventListener('change', () => count());
      const day = DAYS[(new Date(m.date + 'T00:00:00Z').getUTCDay() + 6) % 7];
      const meta = [m.online ? 'çevrimiçi' : null, m.organizer, m.attendees ? `${m.attendees} katılımcı` : null].filter(Boolean).join(' · ');
      const tr = h('tr', {}, h('td', {}, box), h('td', {}, `${day} ${fmtDate(m.date).slice(0, 5)}`), h('td', {}, `${m.start}–${m.end}`),
        h('td', {}, m.imported ? m.subject : name, meta ? h('div', { class: 'muted small' }, meta) : null),
        h('td', { class: 'num' }, fmtH(m.hours)), h('td', {}, m.imported ? h('span', { class: 'chip good' }, 'eklendi') : proj),
        h('td', {}, m.imported ? null : cust.el), h('td', {}, m.imported ? null : cat));
      return { m, box, name, proj, cat, cust, tr };
    });
    const addBtn = h('button', { class: 'pri', onclick: () => guard(out, async () => {
      const items = rows.filter((x) => x.box.checked && !x.m.imported).map((x) => ({ id: x.m.id, projectId: x.proj.value || null, category: x.cat.value || null, description: x.name.value.trim() || null, customer: x.cust.input.value.trim() || null }));
      if (!items.length) return;
      addBtn.disabled = true;
      const res = await api('POST', '/api/calendar/import', { from: weekStart, to, items });
      toast(`${res.created} toplantı efora eklendi.`); route();
    }) }, 'Seçilenleri efora ekle');
    const count = () => { const n = rows.filter((x) => x.box.checked && !x.m.imported).length; addBtn.textContent = `Seçilenleri efora ekle (${n})`; addBtn.disabled = n === 0; };
    count();
    put(out, h('div', { class: 'scroll' }, h('table', {}, h('tr', {}, ...['', 'Gün', 'Saat', 'Toplantı (adını değiştirebilirsiniz)', 'Süre', 'Proje', 'Müşteri', 'Kategori'].map((x) => h('th', {}, x))), rows.map((x) => x.tr))),
      h('div', { class: 'row' }, addBtn, r.skipped ? h('span', { class: 'muted small' }, `${r.skipped} olay listelenmedi (iptal, tüm gün, boşta ya da reddedilmiş).`) : null));
  };
  return h('div', { class: 'card calcard' }, head,
    h('p', { class: 'muted' }, to < weekStart ? 'Bu hafta henüz başlamadı.' : `${fmtDate(weekStart)} – ${fmtDate(to)} arasındaki toplantıları getirip istediklerinizi ekleyin; adını, projesini ve müşterisini eklemeden önce değiştirebilirsiniz. Eklediğiniz toplantı ikinci kez eklenmez.`),
    h('div', { class: 'row' }, fetchBtn, h('button', { class: 'link-btn', onclick: async () => {
      if (!confirm('Takvim bağlantısı kaldırılsın mı? Daha önce eklenen eforlar silinmez.')) return;
      try { await api('DELETE', '/api/calendar'); toast('Takvim bağlantısı kaldırıldı.'); route(); } catch (e) { toast(e.message, 'err'); }
    } }, 'Bağlantıyı kaldır')), out);
}

function myTasksCard(weekStart, today, tasks) {
  const card = h('div', { class: 'card' }, h('h2', {}, 'Görevlerim'),
    h('p', { class: 'muted' }, 'Size atanan Planner görevleri ve proje planı görevleri. Saati yazıp "Ekle"ye basın; kayıt hemen haftanıza işlenir.'));
  if (!tasks.length) {
    card.append(h('p', { class: 'muted' }, 'Henüz size atanmış görev yok. Proje yöneticiniz sizi bir projenin ekibine eklediğinde görevler burada görünür. Bu arada dosya yükleyerek, sohbetle ya da aşağıdan elle efor girebilirsiniz.'));
    return card;
  }
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dateSel = h('select', {}, days.map((d, i) => h('option', { value: d, selected: d === (days.includes(today) ? today : weekStart) }, `${DAYS[i]} ${fmtDate(d)}`)));
  card.append(h('label', {}, 'Hangi güne işlensin?', dateSel));
  const byProject = new Map();
  for (const t of tasks) byProject.set(t.project || 'Diğer', [...(byProject.get(t.project || 'Diğer') || []), t]);
  for (const [name, list] of byProject) {
    const t = h('table', {}, h('tr', {}, ...['Tür', 'Görev', 'Bitiş', 'Saat', ''].map((x) => h('th', {}, x))));
    for (const task of list) {
      const hours = h('input', { size: 6, placeholder: '3 saat', 'aria-label': 'Saat' });
      const status = h('span', {});
      const add = h('button', { class: 'pri', onclick: async () => {
        if (!hours.value.trim()) { put(status, msg('err', 'Saat girin')); return; }
        add.disabled = true;
        try {
          const r = await api('POST', '/api/entries', { date: dateSel.value, hours: hours.value, description: task.title, projectId: task.projectId || null, link: { kind: task.kind, id: task.id, tenantId: task.tenantId || undefined } });
          if (!r.saved) throw new Error('Taslak kaldı: ' + (r.flags || []).map((f) => FLAG_TEXT[f] || f).join(', '));
          put(status, msg('ok', 'Eklendi')); weekDate = dateSel.value; setTimeout(route, 700);
        } catch (e) { put(status, msg('err', e.message)); add.disabled = false; }
      } }, 'Ekle');
      const late = task.due && task.due < today && task.status !== 'Tamamlandı';
      t.append(h('tr', {}, h('td', {}, linkChip(task.kind, linkLabel(task.kind))), h('td', {}, task.title, task.status && task.status !== 'Planlandı' ? h('span', { class: 'chip ' + (STATUS_CLASS[task.status] || '') }, task.status) : null),
        h('td', {}, fmtDate(task.due), late ? h('span', { class: 'chip bad' }, 'gecikmiş') : null), h('td', {}, hours), h('td', {}, add, status)));
    }
    card.append(h('h3', {}, name), h('div', { class: 'scroll' }, t));
  }
  return card;
}

/* ---------- admin ---------- */

function roleSelect(p) {
  const sel = h('select', { title: 'Rol' }, [['Employee', 'Çalışan'], ['PM', 'Proje yöneticisi'], ['Admin', 'Yönetici']].map(([v, l]) => h('option', { value: v, selected: p.role === v }, l)));
  sel.onchange = async () => {
    try { await api('PATCH', `/api/employees/${p.id}`, { role: sel.value }); sel.classList.add('saved'); setTimeout(() => sel.classList.remove('saved'), 1200); }
    catch (e) { toast(e.message, 'err'); sel.value = p.role; }
  };
  return sel;
}

/** ITSM connection: address, state, and a write-only box that saves the API key straight into Key Vault. */
async function itsmCard() {
  const card = h('div', { class: 'card' });
  const draw = async () => {
    const i = await api('GET', '/api/itsm');
    let last = null;
    try { last = i.last?.last_detail ? JSON.parse(i.last.last_detail) : null; } catch { /* old format */ }
    const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', class: 'grow', placeholder: i.keySet ? 'Yeni anahtar girerseniz eskisinin yerine geçer' : 'ITSM API anahtarı', 'aria-label': 'ITSM API anahtarı' });
    const status = h('div', {});
    const save = h('button', { class: 'pri', onclick: async () => {
      const value = key.value.trim();
      if (value.length < 8) { put(status, msg('err', 'Anahtarı yapıştırın.')); return; }
      save.disabled = true; put(status, h('div', { class: 'working' }, h('span', { class: 'spinner' }), 'Anahtar ITSM ile deneniyor…'));
      try {
        await api('POST', '/api/itsm/key', { key: value });
        key.value = '';
        toast('Anahtar doğrulandı ve Key Vault’a kaydedildi. Biletler okunuyor…');
        setTimeout(draw, 4000);
      } catch (e) { put(status, msg('err', e.message)); save.disabled = false; }
    } }, 'Doğrula ve Key Vault’a kaydet');
    const sync = h('button', { disabled: !i.keySet, onclick: async () => {
      sync.disabled = true; sync.textContent = 'Eşitleniyor…';
      try { const r = await api('POST', '/api/itsm/sync'); r.error ? toast('Eşitleme hatası: ' + r.error, 'err') : toast(`${r.tickets} bilet okundu.`); draw(); }
      catch (e) { toast(e.message, 'err'); sync.disabled = false; sync.textContent = 'Biletleri şimdi eşitle'; }
    } }, 'Biletleri şimdi eşitle');
    put(card,
      h('h2', {}, 'ITSM bağlantısı'),
      h('div', { class: 'kv' },
        h('span', { class: 'muted' }, 'Adres'), h('span', {}, i.baseUrl || 'tanımlı değil'),
        h('span', { class: 'muted' }, 'Anahtar'), h('span', {}, i.keySet ? h('span', { class: 'chip good' }, 'Key Vault’ta kayıtlı') : h('span', { class: 'chip warn' }, 'henüz girilmedi'), i.keyUpdatedAt ? ` · ${new Date(i.keyUpdatedAt).toLocaleString('tr-TR')}` : ''),
        h('span', { class: 'muted' }, 'Biletler'), h('span', {}, `${i.tickets} bilet` + (i.last ? ` · son eşitleme ${new Date(i.last.last_run_at).toLocaleString('tr-TR')}` + (i.last.last_status === 'error' ? ' (hata)' : '') : '')),
        i.last?.last_status === 'error' && last?.error ? [h('span', { class: 'muted' }, 'Son hata'), h('span', { class: 'errtext' }, last.error)] : null),
      h('div', { class: 'row' }, key, save, sync),
      status,
      h('p', { class: 'muted small' }, 'Anahtarı ITSM sisteminde Yönetici → API bölümünden bir teknisyen için oluşturabilirsiniz. Anahtar yalnızca Key Vault’ta tutulur; veritabanına yazılmaz ve bir daha gösterilmez. Kaydetmeden önce ITSM ile denenir.'));
  };
  await draw();
  return card;
}

/** Public holidays: every hour on these days counts as extra overtime. Fixed-date national holidays are filled in; religious ones are added here. */
async function holidaysCard() {
  const card = h('div', { class: 'card' });
  let year = new Date().getFullYear();
  const draw = async () => {
    const [list, cfg] = await Promise.all([api('GET', `/api/holidays?year=${year}`), api('GET', '/api/settings')]);
    const date = h('input', { type: 'date', 'aria-label': 'Tarih' });
    const name = h('input', { placeholder: 'Örn. Kurban Bayramı 1. gün', class: 'grow', 'aria-label': 'Adı' });
    put(card, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Mesai saatleri ve resmî tatiller'),
        h('button', { onclick: () => { year--; draw(); } }, '‹'), h('strong', {}, String(year)), h('button', { onclick: () => { year++; draw(); } }, '›')),
      h('p', { class: 'muted' }, `Mesai: hafta içi ${cfg.workStart}–${cfg.workEnd}. Bunun dışındaki saatler, hafta sonları ve aşağıdaki tatil günleri “ekstra mesai” sayılır. Bayramlar her yıl değiştiği için onları siz ekleyin.`),
      list.length ? h('div', { class: 'scroll' }, h('table', {}, list.map((x) => h('tr', {}, h('td', {}, fmtDate(x.date)), h('td', {}, x.name),
        h('td', {}, h('button', { class: 'danger', onclick: async () => { if (!confirm(`${x.name} tatil günü kaldırılsın mı? O günün efor kayıtları yeniden hesaplanır.`)) return; try { await api('DELETE', `/api/holidays/${x.date}`); toast('Tatil kaldırıldı.'); draw(); } catch (e) { toast(e.message, 'err'); } } }, 'Kaldır')))))) : h('p', { class: 'muted' }, 'Bu yıl için tatil günü yok.'),
      h('div', { class: 'row' }, date, name, h('button', { class: 'pri', onclick: async () => {
        if (!date.value || !name.value.trim()) { toast('Tarih ve ad girin.', 'err'); return; }
        try { await api('POST', '/api/holidays', { date: date.value, name: name.value.trim() }); toast('Tatil günü eklendi; o günün eforları ekstra mesaiye çevrildi.'); year = Number(date.value.slice(0, 4)); draw(); } catch (e) { toast(e.message, 'err'); }
      } }, 'Tatil ekle')));
  };
  await draw();
  return card;
}

async function adminPage() {
  const [people, tenants, audit, status] = await Promise.all([api('GET', '/api/employees'), api('GET', '/api/tenants'), api('GET', '/api/admin/audit'), api('GET', '/api/status')]);
  const hidden = people.filter((p) => !p.active).length;
  const peopleCard = h('div', { class: 'card' }, h('h2', {}, 'Çalışanlar'), hidden ? h('p', { class: 'muted small' }, `${hidden} pasif kayıt gizlendi (ikinci hesapları birleştirilmiş kişiler).`) : null, h('div', { class: 'scroll' }, h('table', {}, h('tr', {}, ...['Ad', 'E-posta', 'Rol', 'Hesaplar', 'Günlük saat', ''].map((x) => h('th', {}, x))),
    people.filter((p) => p.active).map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, p.email), h('td', {}, roleSelect(p)),
      h('td', {}, p.identities.map((i) => h('span', { class: 'chip ' + (i.linked ? 'good' : 'warn'), title: i.email }, `${(tenants.find((t) => t.id === i.tenantId) || {}).name || i.tenantId}${i.linked ? '' : ' · giriş yok'}`))),
      h('td', {}, h('input', { size: 3, value: p.day_hours, onchange: (e) => api('PATCH', `/api/employees/${p.id}`, { dayHours: Number(e.target.value) }).catch((x) => toast(x.message, 'err')) })),
      h('td', {}, h('button', { onclick: async () => {
        const t = prompt(`${p.name} için ikinci hesabın şirket kimliği (${tenants.map((x) => x.id).join(', ')})`); const em = t && prompt('İkinci hesabın e-postası');
        if (t && em) { try { await api('POST', `/api/employees/${p.id}/identities`, { tenantId: t, email: em }); route(); } catch (x) { toast(x.message, 'err'); } }
      } }, 'Hesap bağla')))))));
  const seed = h('textarea', { rows: 5, cols: 60, placeholder: '[{"name":"Ayşe Yılmaz","email":"ayse@alpha.example.com","tenantIds":["<tenant-id>"]}]' });
  const seedCard = h('div', { class: 'card' }, h('h2', {}, 'Çalışan listesini yükle (JSON)'), seed,
    h('button', { onclick: () => guard(seedCard, async () => { const r = await api('POST', '/api/employees', { people: JSON.parse(seed.value) }); toast(`${r.people} kişi işlendi`); route(); }) }, 'Yükle'));
  const period = h('input', { type: 'date' });
  const periodCard = h('div', { class: 'card' }, h('h2', {}, 'Dönem kapatma'), h('p', { class: 'muted' }, 'Bu tarihten önceki kayıtlar değiştirilemez.'),
    h('div', { class: 'row' }, period, h('button', { onclick: () => guard(periodCard, async () => { await api('POST', '/api/admin/period', { closedBefore: period.value }); toast('Dönem kapatıldı'); }) }, 'Kapat')));
  const itsmLine = h('div', { class: 'row' },
    h('span', {}, status.itsm.configured ? `ITSM: bağlı · ${status.itsm.tickets} bilet` : 'ITSM: henüz bağlanmadı'),
    status.itsm.configured ? h('button', { onclick: async (ev) => {
      const b = ev.currentTarget; b.disabled = true; b.textContent = 'Eşitleniyor…';
      try { const r = await api('POST', '/api/itsm/sync'); r.error ? toast('ITSM eşitleme hatası: ' + r.error, 'err') : toast(`${r.tickets} bilet okundu.`); route(); }
      catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'Biletleri şimdi eşitle'; }
    } }, 'Biletleri şimdi eşitle') : h('span', { class: 'muted' }, 'Adres ve anahtar tanımlanınca bilet eşitlemesi kendiliğinden başlar.'));
  const stat = h('div', { class: 'card' }, h('h2', {}, 'Durum'), h('div', { class: 'muted' }, `Model: ${status.ai}`), itsmLine,
    tenants.map((t) => h('div', {}, `${t.name} (${t.id}) · Graph: ${t.graph_state}${t.graph_checked_at ? ' · ' + new Date(t.graph_checked_at).toLocaleString('tr-TR') : ''}`)),
    status.jobs.map((j) => h('div', { class: 'muted' }, `${j.name}: ${j.last_status} ${new Date(j.last_run_at).toLocaleString('tr-TR')}`)));
  const log = h('div', { class: 'card' }, h('h2', {}, 'Denetim kaydı (son 200)'), h('div', { class: 'scroll' }, h('table', {}, audit.slice(0, 50).map((a) => h('tr', {}, h('td', {}, new Date(a.at).toLocaleString('tr-TR')), h('td', {}, a.actor || '–'), h('td', {}, a.action), h('td', { class: 'muted' }, a.target || ''))))));
  app.append(h('h1', {}, 'Yönetim'), stat, await itsmCard(), await holidaysCard(), peopleCard, seedCard, periodCard, log);
}

boot();
