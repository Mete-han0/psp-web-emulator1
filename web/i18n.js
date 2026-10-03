// UI localisation.
//
// Scope, deliberately narrow: this translates INTERFACE strings only. Game
// titles, subtitles and badges come from library.json and are shown verbatim --
// translating a game's name would misrepresent it.
//
// No framework, no bundler: the dictionary is a flat map and every element that
// needs translating carries data-i18n. Dynamic strings go through t().

const DICT = {
  en: {
    // top bar
    'bar.gpu': 'GPU',
    'bar.pad': 'Pad',
    'bar.speed': 'Speed',
    'bar.settings': 'Settings',
    'bar.search': 'Search games',
    'bar.lang': 'Language',

    // gpu panel
    'gpu.heading': 'Graphics',
    'gpu.renderer': 'Renderer',
    'gpu.vendor': 'Vendor',
    'gpu.api': 'API',
    'gpu.backend': 'Backend',
    'gpu.isolated': 'Isolated',
    'gpu.canvas': 'Canvas',
    'gpu.display': 'Display',
    'gpu.scale': 'Render scale',
    'gpu.fit': 'Fit window',
    'gpu.fullscreen': 'Fullscreen',
    'gpu.toggle': 'Toggle',
    'gpu.hint': 'This build is compiled with GLES2 only, so there is no backend to choose. Internal resolution is in PPSSPP: Settings → Display.',
    'gpu.unavailable': 'unavailable',

    // pad panel
    'pad.heading': 'Controllers',
    'pad.none': 'No controller detected.',
    'pad.noneShort': 'none',
    'pad.noneHint': 'Browsers only reveal a pad after you press a button on it — press one now and it will appear here.',
    'pad.noapi': 'This browser has no Gamepad API, so controllers cannot be used.',
    'pad.slot': 'Slot',
    'pad.p1': 'P1',
    'pad.mapping': 'mapping',
    'pad.hint': 'Slot 0 is player 1. PPSSPP assigns by SDL device index and offers no way to reorder it from the page. Remap buttons in PPSSPP: pause menu → Settings → Controls.',
    'pad.btn': 'button',
    'pad.btns': 'buttons',
    'pad.axis': 'axis',
    'pad.axes': 'axes',
    'pad.held': 'held',
    'pad.moved': 'moved',

    // settings panel
    'set.speedHead': 'Emulation speed',
    'set.loopRate': 'Loop rate',
    'set.rate30': '30 fps — correct for most PSP games',
    'set.rate60': '60 fps — only for 60fps titles',
    'set.speedHint': 'Emulation speed follows the loop rate: one iteration advances one game frame. Running a 30fps title at 60 makes it play at double speed.',
    'set.overlays': 'Overlays',
    'set.loopOverlay': 'Loop-rate overlay',
    'set.shownPlaying': 'Shown while playing',
    'set.hidden': 'Hidden',
    'set.session': 'Session',
    'set.loop': 'Emulator loop',
    'set.saves': 'Saves',
    'set.savesVal': 'IndexedDB, this browser',
    'set.sessionHint': 'Escaping the emulator reloads the page — the wasm instance cannot be reused — so saves are flushed first.',
    'set.notRunning': 'not running',

    // library page
    'lib.ownedTitle': 'Library',
    'lib.publicTitle': 'Public',
    'lib.catalogTabs': 'Catalog views',
    'lib.ownedHint': 'Your added games, ready to play.',
    'lib.publicHint': 'Find a game, visit its source, then add your own file to Library.',
    'lib.ownedEmpty': 'Your Library is empty. Add a game file below to get started.',
    'lib.addGame': 'Choose & Play',
    'lib.addToLibrary': 'Add & Play',
    'lib.remove': 'Remove',
    'lib.selectFile': 'Select file',
    'lib.localBadge': 'YOUR GAME',
    'lib.openTitle': 'Choose a game to add to Library and play',
    'lib.openHint': 'Choose a .cso, .iso, .pbp, or .chd file to add it and start playing. The file stays on your device and may need to be selected again later.',
    'lib.choose': 'Choose & Play',
    'st.added': 'Added {name} to your Library.',
    'st.invalidFile': 'Choose a supported game file (.cso, .iso, .pbp, or .chd).',
    'st.removed': 'Removed {name} from your Library.',
    'lib.ready': 'Ready.',
    'lib.searchEmpty': 'No games match that search.',
    'lib.extBadge': 'EXTERNAL',
    'lib.extSub': 'opens source page',
    'lib.srcLink': 'Source page ↗',
    'lib.download': 'Download',
    'lib.play': 'Play',
    'lib.forget': 'Forget',
    'lib.forgetHint': 'Stop using this remembered file location.',
    'lib.downloadHint': 'Save the image to your device.',
    'st.preparing': 'Preparing {name}…',
    'st.missingMembers': 'This game needs: {names}',
    'st.pickFirst': 'Choose a file from your device to play.',
    'lib.searchReset': 'Clear search',
    'lib.note1': 'Nothing is uploaded. Library images come from this origin; local files are read from disk. Either way the bytes go straight into the emulator.',
    'lib.note2': 'Saves persist in this browser\'s IndexedDB.',
    'lib.note3': 'PPSSPP is GPL-2.0-or-later. Unofficial build, not affiliated with the PPSSPP project.',

    // stage / status
    'st.backToPicker': 'Back to picker',
    'st.ready': 'Ready. Load a game to begin.',
    'st.idle': 'Idle',
    'st.starting': 'Starting emulator…',
    'st.fetching': 'Fetching {name}…',
    'st.startingName': 'Starting {name}…',
    'st.reading': 'Reading {name} ({size})…',
    'st.loaded': 'Loaded {size} in {secs}s — writing into the emulator…',
    'st.returning': 'Emulator stopped. Returning to the picker…',
    'st.alreadyRunning': 'The emulator is already running. Reload the page to pick another game.',
    'st.loadFailed': 'Could not load game: {msg}',
    'st.fetchFailed': 'Could not load {name}: {msg}',
    'st.envFailed': 'Cannot start: {msg}',
    'st.unavailable': 'unavailable',
  },

  tr: {
    'bar.gpu': 'GPU',
    'bar.pad': 'Kontrol',
    'bar.speed': 'Hız',
    'bar.settings': 'Ayarlar',
    'bar.search': 'Oyun ara',
    'bar.lang': 'Dil',

    'gpu.heading': 'Grafikler',
    'gpu.renderer': 'İşleyici',
    'gpu.vendor': 'Üretici',
    'gpu.api': 'API',
    'gpu.backend': 'Arka uç',
    'gpu.isolated': 'İzolasyon',
    'gpu.canvas': 'Tuval',
    'gpu.display': 'Ekran',
    'gpu.scale': 'Render ölçeği',
    'gpu.fit': 'Pencereye sığdır',
    'gpu.fullscreen': 'Tam ekran',
    'gpu.toggle': 'Değiştir',
    'gpu.hint': 'Bu derleme yalnızca GLES2 ile yapılmıştır, bu yüzden seçilecek bir arka uç yoktur. Dahili çözünürlük PPSSPP içindedir: Ayarlar → Ekran.',
    'gpu.unavailable': 'kullanılamıyor',

    'pad.heading': 'Kontroller',
    'pad.none': 'Kontrolcük bulunamadı.',
    'pad.noneShort': 'yok',
    'pad.noneHint': 'Tarayıcılar bir kontrolcüğü yalnızca üzerinde bir tuşa bastığınızda gösterir — şimdi bir tuşa basın, burada görünecektir.',
    'pad.noapi': 'Bu tarayıcının Gamepad API\'si yok, bu yüzden kontrolcükler kullanılamaz.',
    'pad.slot': 'Yuva',
    'pad.p1': 'O1',
    'pad.mapping': 'eşleme',
    'pad.hint': 'Yuva 0 birinci oyuncudur. PPSPP oyuncuları SDL cihaz dizinine göre atar ve bunu sayfadan değiştirmeye izin vermez. Tuşları PPSSPP içinde yeniden eşleyin: duraklatma menüsü → Ayarlar → Kontroller.',
    'pad.btn': 'tuş',
    'pad.btns': 'tuş',
    'pad.axis': 'eksen',
    'pad.axes': 'eksen',
    'pad.held': 'basılı',
    'pad.moved': 'hareketli',
    'pad.slotNum': 'Yuva {n}',

    'set.speedHead': 'Emülasyon hızı',
    'set.loopRate': 'Döngü hızı',
    'set.rate30': '30 fps — çoğu PSP oyunu için doğru',
    'set.rate60': '60 fps — yalnızca 60 fps oyunlar için',
    'set.speedHint': 'Emülasyon hızı döngü hızına bağlıdır: her yineleme bir oyun karesi ilerletir. 30 fps\'lik bir oyunu 60\'ta çalıştırmak iki kat hızında oynatır.',
    'set.overlays': 'Katmanlar',
    'set.loopOverlay': 'Döngü hızı göstergesi',
    'set.shownPlaying': 'Oynarken göster',
    'set.hidden': 'Gizli',
    'set.session': 'Oturum',
    'set.loop': 'Emülatör döngüsü',
    'set.saves': 'Kayıtlar',
    'set.savesVal': 'IndexedDB, bu tarayıcı',
    'set.sessionHint': 'Emülatörden çıkmak sayfayı yeniden yükler — wasm örneği yeniden kullanılamaz — bu yüzden kayıtlar önce boşaltılır.',
    'set.notRunning': 'çalışmıyor',

    'lib.ownedTitle': 'Library',
    'lib.publicTitle': 'Public',
    'lib.catalogTabs': 'Katalog görünümleri',
    'lib.ownedHint': 'Eklediğiniz oyunlar, oynamaya hazır.',
    'lib.publicHint': 'Bir oyun bulun, kaynağını ziyaret edin, ardından kendi dosyanızı Library’ye ekleyin.',
    'lib.ownedEmpty': 'Library boş. Başlamak için aşağıdan bir oyun dosyası ekleyin.',
    'lib.addGame': 'Seç ve Oynat',
    'lib.addToLibrary': 'Library’ye ekle ve oynat',
    'lib.remove': 'Kaldır',
    'lib.selectFile': 'Dosya seç',
    'lib.localBadge': 'OYUNUNUZ',
    'lib.openTitle': 'Library’ye ekleyip oynamak için oyun seçin',
    'lib.openHint': 'Oyunu ekleyip başlatmak için .cso, .iso, .pbp veya .chd dosyası seçin. Dosya cihazınızda kalır ve daha sonra yeniden seçmeniz gerekebilir.',
    'lib.choose': 'Seç ve Oynat',
    'st.added': '{name}, Library’ye eklendi.',
    'st.invalidFile': 'Desteklenen bir oyun dosyası seçin (.cso, .iso, .pbp veya .chd).',
    'st.removed': '{name}, Library’den kaldırıldı.',
    'lib.ready': 'Hazır.',
    'lib.searchEmpty': 'Aramayla eşleşen oyun yok.',
    'lib.extBadge': 'DIŞ',
    'lib.extSub': 'kaynak sayfasını açar',
    'lib.srcLink': 'Kaynak sayfası ↗',
    'lib.download': 'İndir',
    'lib.play': 'Oynat',
    'lib.forget': 'Unut',
    'lib.forgetHint': 'Bu hatırlanan dosya konumunu kullanmayı bırak.',
    'lib.downloadHint': 'Görseli cihazınıza kaydedin.',
    'st.preparing': '{name} hazırlanıyor…',
    'st.missingMembers': 'Bu oyun şunları gerektirir: {names}',
    'st.pickFirst': 'Oynamak için cihazınızdan bir dosya seçin.',
    'lib.searchReset': 'Aramayı temizle',
    'lib.note1': 'Hiçbir şey yüklenmez. Kütüphane görselleri bu kaynaktan gelir; yerel dosyalar diskten okunur. Her iki durumda da baytlar doğrudan emülatöre gider.',
    'lib.note2': 'Kayıtlar bu tarayıcının IndexedDB\'sinde saklanır.',
    'lib.note3': 'PPSSPP GPL-2.0-or-later lisanslıdır. Gayri resmi derleme, PPSSPP projesiyle ilişkili veya onaylanmış değildir.',

    'st.backToPicker': 'Listeye dön',
    'st.ready': 'Hazır. Başlamak için bir oyun yükleyin.',
    'st.idle': 'Boşta',
    'st.starting': 'Emülatör başlatılıyor…',
    'st.fetching': '{name} alınıyor…',
    'st.startingName': '{name} başlatılıyor…',
    'st.reading': '{name} okunuyor ({size})…',
    'st.loaded': '{size} {secs} saniyede yüklendi — emülatöre yazılıyor…',
    'st.returning': 'Emülatör durdu. Listeye dönülüyor…',
    'st.alreadyRunning': 'Emülatör zaten çalışıyor. Başka bir oyun seçmek için sayfayı yenileyin.',
    'st.loadFailed': 'Oyun yüklenemedi: {msg}',
    'st.fetchFailed': '{name} yüklenemedi: {msg}',
    'st.envFailed': 'Başlatılamıyor: {msg}',
    'st.unavailable': 'kullanılamıyor',
  },
};

const LANGS = [
  { code: 'en', flag: '🇺🇸', label: 'English' },
  { code: 'tr', flag: '🇹🇷', label: 'Türkçe' },
];

const LANG_KEY = 'ppsspp-web:lang';

let lang = 'en';
try {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && DICT[saved]) lang = saved;
} catch (e) { /* default */ }

// Translate a key, with optional {placeholder} interpolation.
function t(key, vars) {
  const table = DICT[lang] || DICT.en;
  let s = table[key];
  if (s === undefined) s = DICT.en[key];
  if (s === undefined) return key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.split('{' + k + '}').join(vars[k]);
    }
  }
  return s;
}

function setLang(code) {
  if (!DICT[code]) return;
  lang = code;
  try { localStorage.setItem(LANG_KEY, code); } catch (e) {}
  document.documentElement.lang = code;
  applyTranslations();
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: code } }));
}

function applyTranslations(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });
}

// ---------------------------------------------------------------- search

let searchTerm = '';

function setSearch(term) {
  searchTerm = (term || '').trim().toLowerCase();
  filterLibrary();
}

function clearSearch() {
  setSearch('');
  const box = document.getElementById('searchBox');
  if (box) box.value = '';
}

// Case-insensitive match over title and subtitle. Game titles are never
// translated -- they are data, and only filtered on here.
function filterLibrary() {
  const grids = ['ownedGrid', 'grid'].map((id) => document.getElementById(id)).filter(Boolean);
  if (!grids.length) return;

  let totalShown = 0;
  for (const grid of grids) {
    const tiles = Array.from(grid.querySelectorAll('.tile'));
    let shown = 0;
    for (const tile of tiles) {
      const hit = !searchTerm || (tile.dataset.search || '').includes(searchTerm);
      tile.style.display = hit ? '' : 'none';
      if (hit) shown++;
    }
    totalShown += shown;

    const emptyId = grid.id === 'ownedGrid' ? 'ownedSearchEmpty' : 'publicSearchEmpty';
    let empty = document.getElementById(emptyId);
    if (searchTerm && tiles.length && shown === 0) {
      if (!empty) {
        empty = document.createElement('p');
        empty.id = emptyId;
        empty.className = 'status warn';
        empty.setAttribute('data-i18n', 'lib.searchEmpty');
        grid.parentNode.insertBefore(empty, grid.nextSibling);
      }
      empty.style.display = '';
      empty.textContent = t('lib.searchEmpty');
    } else if (empty) {
      empty.style.display = 'none';
    }
  }

  const box = document.getElementById('searchBox');
  if (box) box.placeholder = searchTerm ? `${searchTerm} — ${totalShown}` : t('bar.search');
}

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.lang = lang;
  applyTranslations();

  const box = document.getElementById('searchBox');
  if (box) {
    box.addEventListener('input', (e) => setSearch(e.target.value));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { clearSearch(); box.blur(); }
    });
  }

  // Language menu
  const chip = document.getElementById('langChip');
  const menu = document.getElementById('langMenu');
  if (chip && menu) {
    const paint = () => {
      chip.querySelector('.v').textContent = `${LANGS.find((l) => l.code === lang).flag} ${t('bar.lang')}`;
    };
    menu.innerHTML = LANGS.map((l) =>
      `<button class="langitem${l.code === lang ? ' sel' : ''}" data-lang="${l.code}">
         <span class="fl">${l.flag}</span><span>${l.label}</span>
       </button>`).join('');
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lang]');
      if (!b) return;
      setLang(b.dataset.lang);
      paint();
      menu.querySelectorAll('.langitem').forEach((x) =>
        x.classList.toggle('sel', x.dataset.lang === lang));
      menu.classList.remove('open');
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
      const r = chip.getBoundingClientRect();
      menu.style.right = (window.innerWidth - r.right) + 'px';
    });
    document.addEventListener('click', () => menu.classList.remove('open'));
    paint();
  }
});

// Re-render dynamic UI when the language changes.
document.addEventListener('langchange', () => {
  filterLibrary();

  // The language chip is only repainted from its own click handler, so it goes
  // stale when the language is changed by any other path.
  const chip = document.getElementById('langChip');
  if (chip && chip.querySelector('.v')) {
    const l = LANGS.find((x) => x.code === lang) || LANGS[0];
    chip.querySelector('.v').textContent = `${l.flag} ${t('bar.lang')}`;
  }
  const badge = document.getElementById('bootBadge');
  if (badge && bootState && bootState !== 'idle') {
    const map = { pending: 'st.idle', running: 'st.ready' };
    badge.textContent = t(map[bootState] || 'st.idle');
  }
});
