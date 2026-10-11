function on(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", fn);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setInputValue(el, val) {
  if (!el) return;
  if (document.activeElement === el) return;
  const strVal = String(val == null ? "" : val);
  if (el.value === strVal) return;
  el.value = strVal;
}

function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

const hasProblem = (p) => Number(p.failCount) > 0;
const openPicker = (id) => document.getElementById(id)?.classList.remove("hidden");
const closePicker = (id) => document.getElementById(id)?.classList.add("hidden");

function validateSetting(value, { min = 0, max = Infinity, def = 0 } = {}) {
  const num = parseLocalizedNumber(value);
  if (!Number.isFinite(num) || num < min) return def;
  return Math.min(num, max);
}

function formatTtl(msLeft) {
  if (!Number.isFinite(msLeft)) return "";
  if (msLeft <= 0) return "истёк";
  const total = Math.floor(msLeft / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}д`);
  if (days > 0 || hours > 0) parts.push(`${hours}ч`);
  if (days > 0 || hours > 0 || minutes > 0) parts.push(`${minutes}м`);
  parts.push(`${seconds}с`);
  return parts.join(" ");
}

let ttlTimerInterval = null;

function updateTtlTimers() {
  const now = Date.now();
  const els = document.querySelectorAll("[data-ttl-expires]");
  for (const el of els) {
    const exp = Number(el.getAttribute("data-ttl-expires"));
    if (!Number.isFinite(exp)) continue;
    const msLeft = exp - now;
    const textEl = el.querySelector(".ttl-text") || el;
    textEl.textContent = formatTtl(msLeft);
    if (msLeft <= 0) el.classList.add("expired");
    else el.classList.remove("expired");
  }
}

function startTtlTimer() {
  if (ttlTimerInterval) { updateTtlTimers(); return; }
  updateTtlTimers();
  ttlTimerInterval = setInterval(updateTtlTimers, 1000);
}

function stopTtlTimer() {
  if (ttlTimerInterval) {
    clearInterval(ttlTimerInterval);
    ttlTimerInterval = null;
  }
}

function checkOtherPickers() {
  const ap = document.getElementById("archivePicker");
  const rp = document.getElementById("recentPicker");
  const anyOpen =
    (ap && !ap.classList.contains("hidden")) ||
    (rp && !rp.classList.contains("hidden"));
  if (!anyOpen) stopTtlTimer();
}

const TTL_CLOCK_SVG =
  '<svg class="ttl-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

function makeTtlBadge(expiresAt, kind) {
  const ttlEl = document.createElement("span");
  ttlEl.className = `ttl-badge ttl-badge-${kind}`;
  ttlEl.setAttribute("data-ttl-expires", String(expiresAt));
  ttlEl.innerHTML = TTL_CLOCK_SVG;
  const textSpan = document.createElement("span");
  textSpan.className = "ttl-text";
  textSpan.textContent = formatTtl(expiresAt - Date.now());
  ttlEl.appendChild(textSpan);
  const full = formatDateTime(new Date(expiresAt).toISOString());
  ttlEl.title = kind === "archive"
    ? `Автоматически удалится из архива: ${full}`
    : `Пропадёт из этой вкладки: ${full}`;
  return ttlEl;
}

function getLastPriceChangeInfo(p) {
  const arr = p.lastPrices;
  if (!arr || arr.length < 2) return null;
  const last = arr.at(-1);
  const prev = arr.at(-2);
  if (!last || !prev) return null;
  const diff = last.price - prev.price;
  if (diff === 0) return null;
  const t = new Date(last.date).getTime();
  return { diff, at: Number.isFinite(t) ? t : 0 };
}

const hasPriceChange = (p) => getLastPriceChangeInfo(p) !== null;
const hasPriceUp = (p) => { const c = getLastPriceChangeInfo(p); return !!(c && c.diff > 0); };
const hasPriceDown = (p) => { const c = getLastPriceChangeInfo(p); return !!(c && c.diff < 0); };
const getPriceChangeAt = (p) => { const c = getLastPriceChangeInfo(p); return c ? c.at : 0; };

const getCurrentScroll = () =>
  document.body.scrollTop || document.documentElement?.scrollTop || 0;

function setCurrentScroll(y) {
  document.body.scrollTop = y;
  if (document.documentElement) document.documentElement.scrollTop = y;
}

function listOffsetTop() {
  const list = document.getElementById("list");
  if (!list) return 0;
  return list.getBoundingClientRect().top + getCurrentScroll();
}

let cardAnchor = null;
let scrollCorrectionTimers = [];
let scrollCorrectionActive = false;
let scrollFallbackTop = -1;
let scrollCorrecting = false;

function stopScrollCorrectionTimers() {
  for (const t of scrollCorrectionTimers) clearTimeout(t);
  scrollCorrectionTimers = [];
  scrollCorrectionActive = false;
}

function removeScrollCorrectionListeners() {
  window.removeEventListener("wheel", cancelScrollCorrection);
  window.removeEventListener("touchstart", cancelScrollCorrection);
  window.removeEventListener("keydown", cancelScrollCorrection);
}

function cancelScrollCorrection() {
  stopScrollCorrectionTimers();
  cardAnchor = null;
  scrollFallbackTop = -1;
  removeScrollCorrectionListeners();
}

function findAnchorCard() {
  if (!cardAnchor) return null;
  return document.querySelector(`#list .product[data-id="${cardAnchor.id}"]`);
}

function ensureListHeight(y) {
  const list = document.getElementById("list");
  if (!list || !lastSorted) return;
  let guard = 0;
  let prevRendered = -1;
  while (guard++ < 60 && renderedCount < lastSorted.length &&
         document.body.scrollHeight - window.innerHeight < y + 20) {
    if (renderedCount === prevRendered) break;
    prevRendered = renderedCount;
    renderNextBatch(list, lastSorted);
  }
}

function restoreScrollPosition() {
  if (!popupScrollRestored || !(popupScrollTop > 0)) return;
  ensureListHeight(popupScrollTop);
  let delta = 0;
  if (popupListTop > 0) {
    const topNow = listOffsetTop();
    if (topNow > 0) delta = topNow - popupListTop;
  }
  setCurrentScroll(Math.max(0, popupScrollTop + delta));
}

function restoreViewAnchor() {
  const card = findAnchorCard();
  if (!card) return false;
  const delta = card.getBoundingClientRect().top - cardAnchor.top;
  if (Math.abs(delta) >= 0.5) setCurrentScroll(Math.max(0, getCurrentScroll() + delta));
  return true;
}

function applyCurrentScrollCorrection() {
  if (scrollCorrecting) return;
  scrollCorrecting = true;
  try {
    if (cardAnchor && restoreViewAnchor()) return;
    if (scrollFallbackTop >= 0) { setCurrentScroll(scrollFallbackTop); return; }
    restoreScrollPosition();
  } finally {
    scrollCorrecting = false;
  }
}

function startScrollCorrection(delays) {
  stopScrollCorrectionTimers();
  removeScrollCorrectionListeners();
  scrollCorrectionActive = true;
  applyCurrentScrollCorrection();
  for (const d of delays) {
    scrollCorrectionTimers.push(setTimeout(() => {
      if (scrollCorrectionActive) applyCurrentScrollCorrection();
    }, d));
  }
  const total = delays.length ? delays.at(-1) : 0;
  scrollCorrectionTimers.push(setTimeout(() => {
    scrollCorrectionActive = false;
    cardAnchor = null;
    scrollFallbackTop = -1;
    removeScrollCorrectionListeners();
  }, total + 200));
  window.addEventListener("wheel", cancelScrollCorrection, { passive: true });
  window.addEventListener("touchstart", cancelScrollCorrection, { passive: true });
  window.addEventListener("keydown", cancelScrollCorrection);
}

function captureViewAnchor() {
  if (!popupScrollRestored) return null;
  const y = getCurrentScroll();
  if (y <= 0) return null;
  const cards = document.querySelectorAll("#list .product[data-id]");
  for (const card of cards) {
    const r = card.getBoundingClientRect();
    if (r.bottom > 1) return { id: card.getAttribute("data-id"), top: r.top, scroll: y };
  }
  return null;
}

function tryRestoreScroll() {
  if (popupScrollRestored || !popupScrollLoaded || !listRenderedOnce) return;
  popupScrollRestored = true;
  cardAnchor = null;
  scrollFallbackTop = -1;
  startScrollCorrection([60, 200, 600]);
}

function saveScrollPosition() {
  if (!popupScrollRestored) return;
  chrome.storage.local.set({
    popupScrollTop: getCurrentScroll(),
    popupListTop: listOffsetTop(),
    popupScrollTopAt: Date.now(),
  }).catch(() => {});
}

function scheduleSaveScroll() {
  if (!popupScrollRestored) return;
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null;
    saveScrollPosition();
  }, 150);
}

let statusTimeout;
function setStatus(text) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.classList.add("visible");
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => el.classList.remove("visible"), 3500);
}

const SCAN_RESULT_TTL_MS = 5 * 60 * 1000;
const SCAN_RESULT_SHOW_MS = 10000;
let scanResultTimer = null;
let showingScanResult = false;
let currentResultAt = 0;
let importElapsedTimer = null;

function updateImportElapsed() {
  const el = document.getElementById("importElapsed");
  if (!el) return;
  const startedAt = scanSaveStats?.startedAt || 0;
  if (!startedAt) { el.style.display = "none"; return; }
  el.style.display = "";
  const sec = (Date.now() - startedAt) / 1000;
  el.textContent = formatHMS(sec);
  el.title = `Затрачено времени: ${formatHMS(sec)}`;
}

function startImportTimer() {
  if (importElapsedTimer) return;
  updateImportElapsed();
  importElapsedTimer = setInterval(updateImportElapsed, 1000);
}

function stopImportTimer() {
  if (importElapsedTimer) {
    clearInterval(importElapsedTimer);
    importElapsedTimer = null;
  }
}

function hideImportElapsed() {
  const el = document.getElementById("importElapsed");
  if (el) {
    el.style.display = "none";
    el.textContent = "";
    el.removeAttribute("title");
  }
}

function renderElapsed(startedAt, finishedAt) {
  const el = document.getElementById("importElapsed");
  if (!el) return;
  if (startedAt && finishedAt && finishedAt > startedAt) {
    const sec = (finishedAt - startedAt) / 1000;
    el.style.display = "";
    el.textContent = formatHMS(sec);
    el.title = `Затрачено времени: ${formatHMS(sec)}`;
  } else {
    el.style.display = "none";
  }
}

function fillImportStats(found, added, updated, skipped) {
  setText("importFoundCount", String(found || 0));
  setText("importAddedCount", String(added || 0));
  setText("importUpdatedCount", String(updated || 0));
  setText("importSkippedCount", String(skipped || 0));
}

function renderImportBarDone(result) {
  const bar = document.getElementById("importBar");
  if (!bar) return;
  bar.classList.remove("hidden");
  bar.classList.add("done");
  stopImportTimer();
  setText("importTitleText", result.cancelled ? "⏹ Импорт остановлен" : "✅ Импорт завершён");
  const spinner = document.getElementById("importSpinner");
  if (spinner) spinner.style.display = "none";
  const stopBtn = document.getElementById("importStopBtn");
  if (stopBtn) stopBtn.style.display = "none";

  const startedAt = Number(result.startedAt) || scanSaveStats?.startedAt || 0;
  const finishedAt = Number(result.finishedAt) || scanSaveStats?.finishedAt || Date.now();
  renderElapsed(startedAt, finishedAt);

  fillImportStats(result.found, result.added, result.updated, result.skipped);
}

function hideImportBar() {
  const bar = document.getElementById("importBar");
  if (bar) { bar.classList.add("hidden"); bar.classList.remove("done"); }
  const spinner = document.getElementById("importSpinner");
  if (spinner) spinner.style.display = "";
  const stopBtn = document.getElementById("importStopBtn");
  if (stopBtn) stopBtn.style.display = "";
  hideImportElapsed();
}

function maybeShowScanResult(result) {
  if (!result?.at) return;
  if (Date.now() - result.at > SCAN_RESULT_TTL_MS) {
    chrome.storage.local.remove("lastScanResult").catch(() => {});
    return;
  }
  if (currentResultAt === result.at && showingScanResult) return;
  currentResultAt = result.at;
  showingScanResult = true;
  renderImportBarDone(result);
  updateAddButtons();
  if (scanResultTimer) { clearTimeout(scanResultTimer); scanResultTimer = null; }
  scanResultTimer = setTimeout(() => {
    scanResultTimer = null;
    showingScanResult = false;
    currentResultAt = 0;
    hideImportBar();
    chrome.storage.local.remove("lastScanResult").catch(() => {});
    renderImportBar();
    updateAddButtons();
  }, SCAN_RESULT_SHOW_MS);
}

const productSubUrl = (url, sub) => {
  let u = String(url || "").split("?")[0].split("#")[0];
  if (!u.endsWith("/")) u += "/";
  return `${u}${sub}/`;
};

const REASON_INFO = {
  timeout: {
    short: "страница не загрузилась",
    full: "Страница товара не успела загрузиться за отведённое время.",
    label: "Страница не загрузилась",
    legend: "Ozon или интернет не ответили вовремя.",
  },
  "no-tab": {
    short: "не удалось открыть вкладку",
    full: "Не удалось открыть вкладку для проверки. Уменьшите параллельность в настройках.",
  },
  "no-price": {
    short: "цена не найдена",
    full: "На странице не нашлась цена — возможно, товар временно недоступен.",
    label: "Цена не найдена",
    legend: "На странице не оказалось цены.",
  },
  gone: {
    short: "товар снят с продажи",
    full: "Ozon вернул страницу «не найдена» или удалил карточку товара.",
    label: "Товар снят с продажи",
    legend: "Ozon вернул страницу «не найдена» или удалил карточку.",
  },
  captcha: {
    short: "требуется капча",
    full: "Ozon запросил проверку «я не робот». Нажмите «Сбросить капчу».",
    label: "Требуется капча",
    legend: "Ozon запросил проверку. Нажмите «Сбросить капчу».",
  },
  stopped: {
    short: "вы остановили проверку",
    full: "Вы остановили проверку до её завершения.",
  },
  "nav-failed": {
    short: "ссылка не открылась",
    full: "Браузер не смог открыть ссылку на товар.",
  },
  redirect: {
    short: "страница перенаправлена",
    full: "Ozon перенаправил на другую страницу (антибот, главная).",
    label: "Страница перенаправлена",
    legend: "Ozon редиректнул на главную или антибот-страницу.",
  },
  "net-error": {
    short: "сайт недоступен",
    full: "Браузер не смог соединиться с ozon.by (ERR_TIMED_OUT / ERR_CONNECTION).",
    label: "Сайт недоступен",
    legend: "Браузер не смог соединиться с ozon.by.",
  },
  "bad-url": {
    short: "битая ссылка на товар",
    full: "В сохранённой ссылке нет корректного адреса товара ozon.by. Удалите товар и добавьте заново со страницы Ozon.",
    label: "Битая ссылка",
    legend: "В сохранённой ссылке нет корректного адреса товара.",
  },
  out_of_stock: {
    short: "нет в наличии",
    full: "Товар временно закончился у продавца. Продолжает отслеживаться, счётчик ошибок сбросится при появлении цены.",
    label: "Нет в наличии",
    legend: "Товар временно закончился у продавца. Продолжает отслеживаться, счётчик сбросится при появлении цены.",
  },
  not_delivered: {
    short: "не доставляется в ваш регион",
    full: "Ozon не доставляет этот товар в ваш регион. Карточка существует, но оформить заказ по вашему адресу нельзя. Проверьте позже или смените адрес/регион доставки.",
    label: "Не доставляется в ваш регион",
    legend: "Ozon не доставляет этот товар по вашему адресу. Карточка существует, но заказ оформить нельзя.",
  },
  transport: {
    short: "фон не отвечает",
    full: "Фоновый процесс расширения не ответил. Обновите страницу расширения или перезапустите браузер.",
  },
  busy: {
    short: "идёт другая операция",
    full: "Уже выполняется другая операция (проверка или импорт).",
  },
  "not-tracked": {
    short: "товар не в списке",
    full: "Товар не найден в списке отслеживания.",
  },
  unknown: {
    short: "неизвестная ошибка",
    full: "Неизвестная ошибка при проверке.",
    label: "Неизвестная ошибка",
    legend: "Причина не распознана.",
  },
};

const reasonShort = (r) => REASON_INFO[r]?.short || r || "неизвестная ошибка";
const reasonFull = (r) => REASON_INFO[r]?.full || reasonShort(r);

const DEFAULT_SORT = "add-desc";
const SCROLL_TTL_MS = 30 * 60 * 1000;
const PROGRESS_DONE_SHOW_MS = 10000;
const PAGE_SIZE = 50;
let renderedCount = 0;
let lastRenderSignature = "";
let isLoadingMore = false;
let lastSorted = null;

let searchQuery = "";
let allProducts = [];
let currentProgress = null;
let progressHideTimeout = null;
let progressDoneShownThisSession = false;

let sortBy = DEFAULT_SORT;
let showOnlyProblems = false;
let onlyFavorites = false;
let changeFilter = null;

let scanInProgress = false;
let addInProgress = false;
let scanFoundCount = 0;
let scanSaveStats = null;
let importMode = null;
let stoppingImport = false;

let uiStateLoaded = false;
let popupScrollTop = 0;
let popupListTop = 0;
let popupScrollLoaded = false;
let popupScrollRestored = false;
let listRenderedOnce = false;
let scrollSaveTimer = null;
let uiSaveTimer = null;

let _problemStatsCache = null;

function saveUiState() {
  if (!uiStateLoaded) return;
  if (uiSaveTimer) clearTimeout(uiSaveTimer);
  uiSaveTimer = setTimeout(() => {
    uiSaveTimer = null;
    const settingsEl = document.getElementById("settings");
    chrome.storage.local.set({
      uiState: {
        searchQuery,
        showOnlyProblems,
        onlyFavorites,
        changeFilter,
        settingsOpen: settingsEl ? !settingsEl.classList.contains("hidden") : false,
      },
    }).catch(() => {});
  }, 200);
}

async function loadUiState() {
  try {
    const r = await chrome.storage.local.get({ uiState: null });
    return r.uiState || null;
  } catch { return null; }
}

function applyUiStateToDom() {
  const si = document.getElementById("searchInput");
  if (si) si.value = searchQuery;
  const pt = document.getElementById("problemToggle");
  if (pt) pt.classList.toggle("active", showOnlyProblems);
  const favBtn = document.getElementById("favoritesFilterBtn");
  if (favBtn) favBtn.classList.toggle("active", onlyFavorites);
  updateChangeButtons();
  updateFavPanelVisibility();
}

function resetAllFilters({ persist = true } = {}) {
  searchQuery = "";
  showOnlyProblems = false;
  onlyFavorites = false;
  changeFilter = null;
  sortBy = DEFAULT_SORT;
  const si = document.getElementById("searchInput"); if (si) si.value = "";
  const pt = document.getElementById("problemToggle"); if (pt) pt.classList.remove("active");
  const favBtn = document.getElementById("favoritesFilterBtn"); if (favBtn) favBtn.classList.remove("active");
  const ss = document.getElementById("sortSelect"); if (ss) ss.value = DEFAULT_SORT;
  updateChangeButtons();
  updateFavPanelVisibility();
  saveUiState();
  if (persist) send({ action: "setSettings", settings: { sortBy: DEFAULT_SORT } });
}

let pendingRenderList = null;
function scheduleRenderList() {
  if (pendingRenderList) return;
  pendingRenderList = setTimeout(() => {
    pendingRenderList = null;
    try { updateChangeBadges(); renderList(); } catch (e) { console.error("renderList:", e); }
  }, 400);
}

function humanMinutes(m) {
  if (!(m > 0)) return "сейчас";
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return `${h}ч${rest ? ` ${rest}м` : ""}`;
}

async function renderAlarmInfo() {
  const mini = document.getElementById("alarmMini");
  const timeEl = document.getElementById("alarmTime");
  if (!mini || !timeEl) return;
  try {
    const alarm = await chrome.alarms.get("checkPrices");
    mini.classList.remove("error");
    if (!alarm) {
      timeEl.textContent = "—";
      mini.title = "Автопроверка не настроена";
      mini.classList.add("error");
      return;
    }
    const mins = Math.round(alarm.periodInMinutes || 0);
    const diffMin = Math.max(0, Math.round((alarm.scheduledTime - Date.now()) / 60000));
    timeEl.textContent = humanMinutes(diffMin);
    mini.title = `Автопроверка каждые ${humanMinutes(mins)} · следующая через ${humanMinutes(diffMin)}`;
  } catch {
    timeEl.textContent = "—";
    mini.title = "Автопроверка не настроена";
    mini.classList.add("error");
  }
}

function renderProgress() {
  const bar = document.getElementById("progressBar");
  const fill = document.getElementById("progressFill");
  const failFill = document.getElementById("progressFail");
  const doneEl = document.getElementById("progressDone");
  const totalEl = document.getElementById("progressTotal");
  const pctEl = document.getElementById("progressPct");
  const etaLabelEl = document.getElementById("progressEtaLabel");
  const etaTimeEl = document.getElementById("progressEtaTime");
  const checkBtn = document.getElementById("checkNow");
  if (!bar) return;

  const isRunning = !!(currentProgress && currentProgress.running);
  if (checkBtn) {
    if (isRunning) { checkBtn.textContent = "⏹ Остановить"; checkBtn.classList.add("danger-btn"); }
    else { checkBtn.textContent = "🔄 Проверить"; checkBtn.classList.remove("danger-btn"); }
  }

  if (!currentProgress) {
    if (progressHideTimeout) { clearTimeout(progressHideTimeout); progressHideTimeout = null; }
    progressDoneShownThisSession = false;
    bar.classList.add("hidden");
    return;
  }

  const done = currentProgress.done || 0;
  const total = currentProgress.total || 0;
  const okN = Number(currentProgress.ok) || 0;
  const failN = Number(currentProgress.fail) || 0;
  const pct = total > 0 ? (done / total) * 100 : 0;
  const failShare = done > 0 && failN > 0 ? Math.min(100, (failN / done) * 100) : 0;
  let summary = `Проверено ${done} из ${total}\nУспешно: ${okN} · с ошибками: ${failN}`;

  if (isRunning) {
    progressDoneShownThisSession = false;
    if (progressHideTimeout) { clearTimeout(progressHideTimeout); progressHideTimeout = null; }
    bar.classList.remove("hidden", "done");
    fill.style.width = `${pct}%`;
    if (failFill) failFill.style.width = `${failShare}%`;
    if (doneEl) doneEl.textContent = String(done);
    if (totalEl) totalEl.textContent = String(total);
    if (pctEl) pctEl.textContent = `${Math.floor(pct)}%`;

    let etaLabel = "оценка";
    let etaTime = "";
    const startedAt = currentProgress.startedAt;
    if (startedAt && done > 0 && total > done) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      if (elapsedSec > 0) {
        const etaSec = (elapsedSec / done) * (total - done);
        if (etaSec > 0 && etaSec < 86400) {
          etaLabel = "осталось";
          etaTime = formatHMS(etaSec);
          summary += `\nСкорость: ${(done / elapsedSec).toFixed(2)} тов/сек · осталось примерно ${formatDuration(etaSec)}`;
        }
      }
    }
    if (etaLabelEl) etaLabelEl.textContent = etaLabel;
    if (etaTimeEl) etaTimeEl.textContent = etaTime;
    bar.title = summary;
    return;
  }

  if (progressDoneShownThisSession) return;
  if (currentProgress.shown) { bar.classList.add("hidden"); return; }

  progressDoneShownThisSession = true;
  bar.classList.remove("hidden");
  bar.classList.add("done");
  fill.style.width = "100%";
  if (failFill) failFill.style.width = `${failShare}%`;
  if (doneEl) doneEl.textContent = String(done);
  if (totalEl) totalEl.textContent = String(total);
  if (pctEl) pctEl.textContent = "100%";

  let etaLabel2 = "готово";
  let etaTime2 = "";
  if (typeof currentProgress.elapsedSec === "number" && currentProgress.elapsedSec > 0) {
    etaTime2 = formatHMS(currentProgress.elapsedSec);
  }
  if (currentProgress.stopped) {
    etaLabel2 = currentProgress.stoppedReason === "timeout_streak" ? "много таймаутов" : "остановлено";
    etaTime2 = "";
  }
  if (etaLabelEl) etaLabelEl.textContent = etaLabel2;
  if (etaTimeEl) etaTimeEl.textContent = etaTime2;
  bar.title = summary + (failN > 0 ? `\nОшибок: ${failN}` : "");

  progressHideTimeout = setTimeout(() => {
    progressHideTimeout = null;
    bar.classList.add("hidden");
    send({ action: "markProgressShown" });
  }, PROGRESS_DONE_SHOW_MS);
}

function isImportSessionLive() {
  if (scanInProgress) return true;
  if (scanSaveStats && scanSaveStats.active) {
    const startedAt = Number(scanSaveStats.startedAt) || 0;
    if (startedAt > 0 && Date.now() - startedAt < 15 * 60 * 1000) return true;
  }
  return false;
}

function renderImportBar() {
  if (showingScanResult) return;
  const bar = document.getElementById("importBar");
  if (!bar) return;
  if (!isImportSessionLive()) {
    bar.classList.add("hidden");
    stopImportTimer();
    hideImportElapsed();
    return;
  }
  bar.classList.remove("hidden", "done");
  startImportTimer();
  const titleEl = document.getElementById("importTitleText");
  if (titleEl) {
    if (stoppingImport) titleEl.textContent = "Останавливаю импорт...";
    else if (importMode === "manual") titleEl.textContent = "Сканирую страницу для выбора...";
    else titleEl.textContent = "Сканирую страницу и добавляю товары...";
  }
  const spinner = document.getElementById("importSpinner");
  if (spinner) { spinner.style.display = ""; spinner.classList.toggle("stopping", stoppingImport); }
  const stopBtn = document.getElementById("importStopBtn");
  if (stopBtn) {
    stopBtn.disabled = !!stoppingImport;
    stopBtn.textContent = stoppingImport ? "⏹ Останавливаю..." : "⏹ Остановить";
    stopBtn.title = stoppingImport ? "Останавливаю..." : "Остановить импорт";
  }
  const stats = scanSaveStats || { added: 0, updated: 0, dropped: 0 };
  const found = Number(scanFoundCount) || 0;
  const added = Number(stats.added) || 0;
  const updated = Number(stats.updated) || 0;
  const dropped = Number(stats.dropped) || 0;
  const skippedLive = Math.max(0, found - added - updated - dropped);
  fillImportStats(found, added, updated, skippedLive);
  const manual = importMode === "manual";
  const addedStat = bar.querySelector(".import-stat.added");
  const updatedStat = bar.querySelector(".import-stat.updated");
  if (addedStat) addedStat.style.display = manual ? "none" : "";
  if (updatedStat) updatedStat.style.display = manual ? "none" : "";
}

function updateAddButtons() {
  const addActions = document.getElementById("addActions");
  const stopActions = document.getElementById("stopAddActions");
  if (!addActions || !stopActions) return;
  let busy = addInProgress || isImportSessionLive();
  if (showingScanResult) busy = addInProgress;
  if (busy) {
    addActions.classList.add("hidden");
    if (isImportSessionLive() && !showingScanResult) stopActions.classList.add("hidden");
    else stopActions.classList.remove("hidden");
  } else {
    addActions.classList.remove("hidden");
    stopActions.classList.add("hidden");
  }
}

function invalidateProblemStats() { _problemStatsCache = null; }

function getProblemStats() {
  if (_problemStatsCache) return _problemStatsCache;
  let total = 0;
  const byReason = {};
  for (const p of allProducts) {
    if (!hasProblem(p)) continue;
    total++;
    const r = p.lastCheckError || "unknown";
    byReason[r] = (byReason[r] || 0) + 1;
  }
  const gone = byReason.gone || 0;
  const outOfStock = byReason.out_of_stock || 0;
  const notDelivered = byReason.not_delivered || 0;
  const captcha = byReason.captcha || 0;
  const timeout = byReason.timeout || 0;
  const redirect = byReason.redirect || 0;
  const other = total - (gone + outOfStock + notDelivered + captcha + timeout + redirect);
  _problemStatsCache = {
    total, byReason, gone, outOfStock, notDelivered,
    captcha, timeout, redirect, other,
  };
  return _problemStatsCache;
}

const PROBLEM_ORDER = ["gone", "out_of_stock", "not_delivered", "captcha", "timeout", "net-error", "nav-failed", "redirect", "no-price", "bad-url", "transport"];

function problemHintRow(label, text) {
  const row = document.createElement("div");
  row.className = "hint-row";
  const b = document.createElement("b");
  b.textContent = label;
  row.appendChild(b);
  row.appendChild(document.createTextNode(` — ${text}`));
  return row;
}

function renderProblemLegend(stats) {
  const el = document.getElementById("problemHint");
  if (!el) return;
  el.innerHTML = "";
  if (!stats?.total) return;
  let known = 0;
  for (const key of PROBLEM_ORDER) {
    const n = stats.byReason[key] || 0;
    if (!n) continue;
    known += n;
    const info = REASON_INFO[key];
    el.appendChild(problemHintRow(`${info?.label || key} (${n})`, info?.legend || ""));
  }
  const unknown = stats.total - known;
  if (unknown > 0) {
    el.appendChild(problemHintRow(`Прочие ошибки (${unknown})`, REASON_INFO.unknown.legend));
  }
}

function updateProblemBadge() {
  const stats = getProblemStats();
  setText("problemCount", String(stats.total));
  const t = document.getElementById("problemToggle");
  if (t) t.classList.toggle("has-problems", stats.total > 0);
  if (stats.total === 0 && showOnlyProblems) {
    showOnlyProblems = false;
    if (t) t.classList.remove("active");
    saveUiState();
  }
}

function setProblemBtn(btn, enabled, text) {
  if (!btn) return;
  btn.disabled = !enabled;
  btn.textContent = text;
}

function renderProblemActions() {
  const actionsEl = document.getElementById("problemActions");
  const infoEl = document.getElementById("problemInfo");
  const checkFailedBtn = document.getElementById("checkFailed");
  const resetCaptchaBtn = document.getElementById("resetCaptcha");
  const clearGoneBtn = document.getElementById("clearGone");
  const clearAllBtn = document.getElementById("clearAllFailed");
  if (!actionsEl) return;
  if (!showOnlyProblems) { actionsEl.classList.add("hidden"); return; }
  actionsEl.classList.remove("hidden");

  const stats = getProblemStats();
  if (stats.total === 0) {
    if (infoEl) infoEl.textContent = "Проблемных товаров нет.";
    setProblemBtn(checkFailedBtn, false, "🔄 Перепроверить проблемные");
    setProblemBtn(resetCaptchaBtn, false, "🔓 Сбросить капчу");
    setProblemBtn(clearGoneBtn, false, "🗑 Удалить снятые с продажи");
    setProblemBtn(clearAllBtn, false, "🗑 Удалить все проблемные");
    renderProblemLegend(stats);
    return;
  }
  const parts = [];
  if (stats.gone) parts.push(`${stats.gone} снято с продажи`);
  if (stats.outOfStock) parts.push(`${stats.outOfStock} нет в наличии`);
  if (stats.notDelivered) parts.push(`${stats.notDelivered} не доставляется`);
  if (stats.redirect) parts.push(`${stats.redirect} перенаправлено`);
  if (stats.captcha) parts.push(`${stats.captcha} с капчей`);
  if (stats.timeout) parts.push(`${stats.timeout} с таймаутом загрузки`);
  if (stats.other) parts.push(`${stats.other} с прочими ошибками`);
  if (infoEl) infoEl.textContent = `Всего проблемных: ${stats.total} — ${parts.join(", ")}.`;

  setProblemBtn(checkFailedBtn, true, `🔄 Перепроверить проблемные (${stats.total})`);
  setProblemBtn(resetCaptchaBtn, stats.captcha > 0, stats.captcha === 0 ? "🔓 Сбросить капчу" : `🔓 Сбросить капчу (${stats.captcha})`);
  setProblemBtn(clearGoneBtn, stats.gone > 0, stats.gone === 0 ? "🗑 Удалить снятые с продажи" : `🗑 Удалить снятые с продажи (${stats.gone})`);
  setProblemBtn(clearAllBtn, true, `🗑 Удалить все проблемные (${stats.total})`);
  renderProblemLegend(stats);
}

function getChangesCounts() {
  let all = 0, up = 0, down = 0, fav = 0;
  for (const p of allProducts) {
    if (p.favorite) fav++;
    const c = getLastPriceChangeInfo(p);
    if (!c) continue;
    all++;
    if (c.diff > 0) up++;
    else if (c.diff < 0) down++;
  }
  return { all, up, down, fav };
}

function updateChangeButtons() {
  const bAll = document.getElementById("changeAllBtn");
  const bUp = document.getElementById("changeUpBtn");
  const bDown = document.getElementById("changeDownBtn");
  const favBtn = document.getElementById("favoritesFilterBtn");
  if (bAll) bAll.classList.toggle("active", changeFilter === "all");
  if (bUp) bUp.classList.toggle("active", changeFilter === "up");
  if (bDown) bDown.classList.toggle("active", changeFilter === "down");
  if (favBtn) favBtn.classList.toggle("active", onlyFavorites);
}

function updateRecentBadge() {
  const btn = document.getElementById("recentBtn");
  if (!btn) return;
  const cutoff = Date.now() - RECENT_TTL_MS;
  let n = 0;
  for (const p of allProducts) {
    const t = new Date(p.addedAt).getTime();
    if (Number.isFinite(t) && t >= cutoff) n++;
  }
  setText("recentChipCount", String(n));
  btn.classList.toggle("no-items", n === 0);
  btn.title = n > 0
    ? "Товары, добавленные за последние сутки"
    : "За последние сутки товары не добавлялись";
}

function getDesiredActiveCount() {
  let n = 0;
  for (const p of allProducts) {
    if (p.favorite && Number(p.desiredPrice) > 0) n++;
  }
  return n;
}

function updateResetDesiredBadge() {
  const btn = document.getElementById("resetDesiredAllBtn");
  const cntEl = document.getElementById("resetDesiredCount");
  if (!btn || !cntEl) return;
  const n = getDesiredActiveCount();
  cntEl.textContent = String(n);
  btn.disabled = n === 0;
  btn.title = n > 0
    ? `Сбросить желаемую цену у ${n} избранных`
    : "У избранных нет желаемой цены";
}

function updateFavPanelVisibility() {
  const panel = document.getElementById("favPanel");
  if (!panel) return;
  panel.classList.toggle("hidden", !onlyFavorites);
}

function syncDesiredInMemory(id, val) {
  const prod = allProducts.find((x) => x.id === id);
  if (prod) {
    if (val > 0) prod.desiredPrice = val;
    else delete prod.desiredPrice;
  }
  updateResetDesiredBadge();
}

function updateChangeBadges() {
  const counts = getChangesCounts();
  setText("changeAllCount", String(counts.all));
  setText("changeUpCount", String(counts.up));
  setText("changeDownCount", String(counts.down));
  setText("favFilterCount", String(counts.fav));

  const bAll = document.getElementById("changeAllBtn");
  const bUp = document.getElementById("changeUpBtn");
  const bDown = document.getElementById("changeDownBtn");
  if (bAll) bAll.classList.toggle("no-items", counts.all === 0);
  if (bUp) bUp.classList.toggle("no-items", counts.up === 0);
  if (bDown) bDown.classList.toggle("no-items", counts.down === 0);

  if (changeFilter === "all" && counts.all === 0) { changeFilter = null; saveUiState(); }
  if (changeFilter === "up" && counts.up === 0) { changeFilter = null; saveUiState(); }
  if (changeFilter === "down" && counts.down === 0) { changeFilter = null; saveUiState(); }
  if (onlyFavorites && counts.fav === 0) { onlyFavorites = false; saveUiState(); }

  updateChangeButtons();
  updateFavPanelVisibility();
  updateResetDesiredBadge();
}

function applyFilters(products) {
  const q = searchQuery.trim().toLowerCase();
  return products.filter((p) => {
    if (onlyFavorites && !p.favorite) return false;
    if (showOnlyProblems && !hasProblem(p)) return false;
    if (changeFilter === "all" && !hasPriceChange(p)) return false;
    if (changeFilter === "up" && !hasPriceUp(p)) return false;
    if (changeFilter === "down" && !hasPriceDown(p)) return false;
    const name = (p.name || "").toLowerCase();
    if (q && !name.includes(q)) return false;
    return true;
  });
}

function applySort(products) {
  if (changeFilter === "up" || changeFilter === "down") {
    return products.toSorted((a, b) => {
      const ca = getLastPriceChangeInfo(a);
      const cb = getLastPriceChangeInfo(b);
      const da = ca ? ca.diff : 0;
      const db = cb ? cb.diff : 0;
      if (changeFilter === "up") return db - da;
      return da - db;
    });
  }
  const cmpName = (a, b) => (a.name || "").localeCompare(b.name || "", "ru", { sensitivity: "base" });
  switch (sortBy) {
    case "name-asc":  return products.toSorted(cmpName);
    case "name-desc": return products.toSorted((a, b) => cmpName(b, a));
    case "price-asc": return products.toSorted((a, b) => (a.currentPrice || 0) - (b.currentPrice || 0));
    case "price-desc": return products.toSorted((a, b) => (b.currentPrice || 0) - (a.currentPrice || 0));
    case "rating-desc": return products.toSorted((a, b) => (b.rating || 0) - (a.rating || 0));
    case "reviews-desc": return products.toSorted((a, b) => (b.reviews || 0) - (a.reviews || 0));
    case "questions-desc": return products.toSorted((a, b) => (b.questions || 0) - (a.questions || 0));
    case "media-desc": return products.toSorted((a, b) => (b.mediaCount || 0) - (a.mediaCount || 0));
    case "add-desc":
    default:
      return products.toSorted((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  }
}

function highlightName(name, q) {
  const raw = String(name || "");
  if (!raw) return "";
  if (!q || !q.length) return escapeHtml(raw);
  const lowerRaw = raw.toLowerCase();
  const lowerQ = String(q).toLowerCase();
  if (!lowerQ.length) return escapeHtml(raw);
  const parts = [];
  let i = 0;
  let lastEnd = 0;
  while (true) {
    const idx = lowerRaw.indexOf(lowerQ, i);
    if (idx === -1) break;
    parts.push(escapeHtml(raw.substring(lastEnd, idx)));
    parts.push(`<mark>${escapeHtml(raw.substring(idx, idx + lowerQ.length))}</mark>`);
    lastEnd = idx + lowerQ.length;
    i = lastEnd;
  }
  parts.push(escapeHtml(raw.substring(lastEnd)));
  return parts.join("");
}

function renderMetric(el, icon, value, delta, deltaAt, isFloat, href) {
  if (!el) return;
  if (!value || value <= 0) {
    el.textContent = "";
    el.removeAttribute("href");
    el.removeAttribute("title");
    return;
  }
  let html = `${icon} ${isFloat ? value.toFixed(1) : formatNumber(value)}`;
  if (delta && Math.abs(delta) > 0.001) {
    const cls = delta > 0 ? "metric-delta" : "metric-delta down";
    const sign = delta > 0 ? "+" : "";
    const deltaStr = isFloat ? delta.toFixed(1) : formatNumber(delta);
    html += ` <span class="${cls}">${sign}${deltaStr}</span>`;
  }
  el.innerHTML = html;
  if (href) {
    el.href = href;
    el.title = `Открыть страницу на Ozon${deltaAt ? ` · изменение: ${formatDateTime(deltaAt)}` : ""}`;
  } else {
    el.removeAttribute("href");
  }
}

function relSuffix(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const ageSec = (Date.now() - t) / 1000;
  if (ageSec < 0 || ageSec >= 86400) return "";
  return ` (${formatRelative(iso)})`;
}

function metaChip(icon, label, value, title, cls) {
  const chip = document.createElement("span");
  chip.className = `meta-chip${cls ? ` ${cls}` : ""}`;
  chip.title = title;
  const ic = document.createElement("span"); ic.className = "meta-ic"; ic.textContent = icon;
  const lb = document.createElement("span"); lb.className = "meta-lb"; lb.textContent = label;
  const vl = document.createElement("span"); vl.className = "meta-vl"; vl.textContent = value;
  chip.appendChild(ic); chip.appendChild(lb); chip.appendChild(vl);
  return chip;
}

function renderProductMeta(metaEl, p) {
  if (!metaEl) return;
  metaEl.innerHTML = "";
  const failCount = Number(p.failCount) || 0;

  const suspPrice = Number(p.lastSuspiciousPrice);
  if (Number.isFinite(suspPrice) && suspPrice > 0) {
    const cur = Number(p.currentPrice) || 0;
    const drop = cur > 0 ? Math.round((1 - suspPrice / cur) * 100) : 0;
    metaEl.appendChild(metaChip(
      "⚠", "подозрительная цена",
      `${formatPrice(suspPrice)}${drop > 0 ? ` (−${drop}%)` : ""}`,
      `Ozon показал цену ${formatPrice(suspPrice)}${drop > 0 ? ` — это ниже текущей на ${drop}%.` : "."}\nТакое падение записывается только после повторного подтверждения: если цена придёт снова, она попадёт в историю.`,
      "warn"
    ));
  }

  let checkedCls = "";
  if (p.lastChecked) {
    const ageSec = (Date.now() - new Date(p.lastChecked).getTime()) / 1000;
    if (ageSec >= 0 && ageSec < 3600) checkedCls = "fresh";
    else if (ageSec > 3 * 86400) checkedCls = "stale";
  }
  metaEl.appendChild(metaChip(
    "🕐", "проверено",
    p.lastChecked ? formatDateTime(p.lastChecked) : "никогда",
    `Проверено: ${p.lastChecked ? formatDateTime(p.lastChecked) + relSuffix(p.lastChecked) : "ни разу"}\nКогда расширение последний раз смотрело цену товара.`,
    checkedCls
  ));

  if (p.lastSeenOnPdp && p.lastSeenOnPdp !== p.lastChecked) {
    metaEl.appendChild(metaChip(
      "👁", "на Ozon", formatDateTime(p.lastSeenOnPdp),
      `На странице Ozon: ${formatDateTime(p.lastSeenOnPdp)}${relSuffix(p.lastSeenOnPdp)}\nКогда карточка товара последний раз открывалась на ozon.by.`,
      ""
    ));
  }

  if (failCount > 0) {
    metaEl.appendChild(metaChip(
      "⚠", `не проверено ${failCount}×:`, reasonShort(p.lastCheckError),
      `Не удалось проверить (${failCount} раз): ${reasonShort(p.lastCheckError)}\n\n${reasonFull(p.lastCheckError)}`,
      "danger"
    ));
  }
}

function renderProductCard(p, q) {
  const tpl = document.getElementById("productTpl").content.cloneNode(true);
  const wrap = tpl.querySelector(".product");
  wrap.dataset.id = String(p.id);
  if (p.favorite) wrap.classList.add("favorite");
  if (hasProblem(p)) wrap.classList.add("has-problem");

  const img = tpl.querySelector(".product-image");
  if (p.image) {
    img.src = p.image;
    img.onerror = function () { this.style.visibility = "hidden"; };
  } else {
    img.style.visibility = "hidden";
  }

  const a = tpl.querySelector(".product-name");
  a.href = p.url;
  a.title = p.name || "";
  a.innerHTML = highlightName(p.name || "Без названия", q);

  const artRow = tpl.querySelector(".product-article-row");
  const artEl = tpl.querySelector(".product-article");
  if (artRow && artEl) {
    const art = extractArticleFromUrl(p.url);
    if (art) {
      artEl.textContent = art;
      artEl.title = `Артикул Ozon: ${art}`;
      artRow.classList.remove("hidden");
    } else {
      artEl.textContent = "";
      artEl.removeAttribute("title");
      artRow.classList.add("hidden");
    }
  }

  const favBtn = tpl.querySelector(".fav-btn");
  if (p.favorite) {
    favBtn.textContent = "★";
    favBtn.classList.add("active");
    favBtn.title = "Убрать из избранного";
  } else {
    favBtn.textContent = "☆";
    favBtn.title = "В избранное";
  }
  favBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await send({ action: "toggleFavorite", id: p.id });
    setStatus(p.favorite ? "Убрано из избранного" : "⭐ Добавлено в избранное");
    await reloadAndRender();
  });

  const reviewsUrl = productSubUrl(p.url, "reviews");
  const questionsUrl = productSubUrl(p.url, "questions");
  renderMetric(tpl.querySelector(".metric-rating"), "⭐", p.rating, p.ratingDelta, p.ratingDeltaAt, true, p.rating > 0 ? reviewsUrl : null);
  renderMetric(tpl.querySelector(".metric-reviews"), "💬", p.reviews, p.reviewsDelta, p.reviewsDeltaAt, false, p.reviews > 0 ? reviewsUrl : null);
  renderMetric(tpl.querySelector(".metric-questions"), "❓", p.questions, p.questionsDelta, p.questionsDeltaAt, false, p.questions > 0 ? questionsUrl : null);
  renderMetric(tpl.querySelector(".metric-media"), "📷", p.mediaCount, p.mediaDelta, p.mediaDeltaAt, false, p.mediaCount > 0 ? p.url : null);

  tpl.querySelector(".product-price").textContent = formatPrice(p.currentPrice);

  const change = tpl.querySelector(".product-change");
  if (p.lastPrices?.length >= 2) {
    const last = p.lastPrices.at(-1).price;
    const prev = p.lastPrices.at(-2).price;
    const diff = last - prev;
    if (diff > 0) {
      change.innerHTML = `<span class="arrow">↑</span>${formatDiff(diff)} Br (${formatPct((diff / prev) * 100)})`;
      change.classList.add("up");
    } else if (diff < 0) {
      change.innerHTML = `<span class="arrow">↓</span>${formatDiff(diff)} Br (${formatPct((diff / prev) * 100)})`;
      change.classList.add("down");
    } else {
      change.innerHTML = '<span class="arrow">—</span>';
      change.classList.add("same");
    }
  }

  if (changeFilter) {
    const lastPriceChangeAt = getPriceChangeAt(p);
    if (lastPriceChangeAt > 0) {
      const iso = new Date(lastPriceChangeAt).toISOString();
      const badgeCh = document.createElement("span");
      badgeCh.className = "change-when";
      badgeCh.textContent = `📈 ${formatRelative(iso)}`;
      badgeCh.title = `Последнее изменение цены: ${formatDateTime(iso)}`;
      tpl.querySelector(".product-price-row").appendChild(badgeCh);
    }
  }

  const desiredRow = tpl.querySelector(".product-desired");
  if (desiredRow) {
    if (p.favorite) {
      desiredRow.classList.remove("hidden");
      const desiredInput = desiredRow.querySelector(".desired-input");
      const desiredClear = desiredRow.querySelector(".desired-clear");
      const dp = Number(p.desiredPrice) || 0;
      desiredInput.value = dp > 0 ? dp.toFixed(2) : "";

      const applyAchieved = (val) => {
        const cur = Number(p.currentPrice) || 0;
        desiredRow.classList.toggle("achieved", val > 0 && cur > 0 && cur <= val);
      };
      applyAchieved(dp);

      const updateClearVisibility = () => {
        if (desiredClear) {
          desiredClear.classList.toggle("hidden", desiredInput.value.trim() === "");
        }
      };
      updateClearVisibility();

      const commitDesired = async () => {
        const raw = desiredInput.value.trim();
        let val = raw === "" ? 0 : parseLocalizedNumber(raw);
        if (!Number.isFinite(val) || val < 0) val = 0;
        val = Math.round(val * 100) / 100;

        desiredInput.value = val > 0 ? val.toFixed(2) : "";
        updateClearVisibility();

        const prevVal = Number(p.desiredPrice) || 0;
        if (val === prevVal) {
          applyAchieved(val);
          return;
        }

        p.desiredPrice = val > 0 ? val : undefined;
        applyAchieved(val);
        syncDesiredInMemory(p.id, val);
        await send({ action: "setDesiredPrice", id: p.id, desiredPrice: val });
        setStatus(val > 0 ? `🎯 Желаемая цена: ${formatPrice(val)}` : "🎯 Желаемая цена убрана");
      };

      desiredInput.addEventListener("input", updateClearVisibility);
      desiredInput.addEventListener("blur", commitDesired);
      desiredInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); desiredInput.blur(); }
      });

      if (desiredClear) {
        desiredClear.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });
        desiredClear.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (desiredInput.value.trim() === "") return;
          desiredInput.value = "";
          updateClearVisibility();
          await commitDesired();
        });
      }
    } else {
      desiredRow.classList.add("hidden");
    }
  }

  const minValEl = tpl.querySelector(".min-val");
  const minDateEl = tpl.querySelector(".min-date");
  if (p.minPrice !== undefined && p.minPrice !== null) {
    minValEl.textContent = formatPrice(p.minPrice);
    minDateEl.textContent = formatDateTime(p.minPriceDate);
  } else {
    minValEl.textContent = "—";
    minDateEl.textContent = "—";
  }

  const maxValEl = tpl.querySelector(".max-val");
  const maxDateEl = tpl.querySelector(".max-date");
  if (p.maxPrice !== undefined && p.maxPrice !== null) {
    maxValEl.textContent = formatPrice(p.maxPrice);
    maxDateEl.textContent = formatDateTime(p.maxPriceDate);
  } else {
    maxValEl.textContent = "—";
    maxDateEl.textContent = "—";
  }

  const rangeRow = tpl.querySelector(".minmax-range");
  const rangeValEl = tpl.querySelector(".range-val");
  const rangePctEl = tpl.querySelector(".range-pct");
  if (rangeRow && rangeValEl && rangePctEl) {
    if (p.minPrice !== undefined && p.maxPrice !== undefined && p.maxPrice > p.minPrice) {
      rangeRow.style.display = "";
      const rDiff = p.maxPrice - p.minPrice;
      const rPct = p.minPrice > 0 ? (rDiff / p.minPrice) * 100 : 0;
      rangeValEl.textContent = formatPrice(rDiff);
      rangePctEl.textContent = `${rPct.toFixed(1)}%`;
    } else {
      rangeRow.style.display = "none";
      rangeValEl.textContent = "";
      rangePctEl.textContent = "";
    }
  }

  renderProductMeta(tpl.querySelector(".last-checked"), p);

  tpl.querySelector(".btn-check").addEventListener("click", async () => {
    setStatus("⏳ Проверяю...");
    const r = await send({ action: "checkOne", url: p.url });
    const res = r && r.result;
    if (res?.ok) setStatus("✅ Проверено");
    else setStatus(`⚠ ${reasonShort(res?.reason)}`);
    await reloadAndRender();
  });

  tpl.querySelector(".btn-chart").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`chart.html?id=${p.id}`) }).catch(() => {});
  });

  tpl.querySelector(".btn-delete").addEventListener("click", async () => {
    await send({ action: "removeProduct", url: p.url });
    setStatus("🗑 Удалено");
    await reloadAndRender();
  });

  return tpl;
}

function hashString(h, s) {
  if (!s) return h;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

function computeSignature(sorted) {
  let hash = 0;
  for (const p of sorted) {
    hash = (hash * 31 + ((Number(p.currentPrice) * 100) | 0)) | 0;
    hash = (hash * 31 + ((Number(p.minPrice) * 100) | 0)) | 0;
    hash = (hash * 31 + ((Number(p.maxPrice) * 100) | 0)) | 0;
    hash = (hash * 31 + (p.favorite ? 1 : 0)) | 0;
    hash = (hash * 31 + (Number(p.failCount) || 0)) | 0;
    hash = (hash * 31 + ((Number(p.rating) * 10) | 0)) | 0;
    hash = (hash * 31 + (Number(p.reviews) | 0)) | 0;
    hash = (hash * 31 + (Number(p.questions) | 0)) | 0;
    hash = (hash * 31 + (Number(p.mediaCount) | 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.lastChecked) || 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.lastSeenOnPdp) || 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.minPriceDate) || 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.maxPriceDate) || 0)) | 0;
    hash = (hash * 31 + ((Number(p.ratingDelta) * 10) | 0)) | 0;
    hash = (hash * 31 + (Number(p.reviewsDelta) | 0)) | 0;
    hash = (hash * 31 + (Number(p.questionsDelta) | 0)) | 0;
    hash = (hash * 31 + (Number(p.mediaDelta) | 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.ratingDeltaAt) || 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.reviewsDeltaAt) || 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.questionsDeltaAt) || 0)) | 0;
    hash = (hash * 31 + (Date.parse(p.mediaDeltaAt) || 0)) | 0;
    hash = (hash * 31 + ((Number(p.desiredPrice) * 100) | 0)) | 0;
    hash = hashString(hash, String(p.url || ""));
    hash = hashString(hash, String(p.image || ""));
    hash = hashString(hash, String(p.lastCheckError || ""));
    hash = hashString(hash, String(p.name || ""));
  }
  return [searchQuery, showOnlyProblems ? "1" : "0", onlyFavorites ? "1" : "0", changeFilter || "-", sortBy, sorted.length, hash].join("|");
}

function renderNextBatch(list, sorted) {
  if (isLoadingMore) return;
  if (renderedCount >= sorted.length) return;
  isLoadingMore = true;
  const end = Math.min(renderedCount + PAGE_SIZE, sorted.length);
  const fragment = document.createDocumentFragment();
  const q = searchQuery.trim();
  try {
    for (let i = renderedCount; i < end; i++) fragment.appendChild(renderProductCard(sorted[i], q));
    list.querySelector(".load-more")?.remove();
    list.querySelector(".load-more-info")?.remove();
    list.appendChild(fragment);
    renderedCount = end;
    if (renderedCount < sorted.length) {
      addLoadMoreButton(list, sorted);
    } else if (sorted.length > PAGE_SIZE) {
      const info = document.createElement("div");
      info.className = "load-more-info";
      info.textContent = `Показано все ${sorted.length} товаров`;
      list.appendChild(info);
    }
  } finally {
    isLoadingMore = false;
    listRenderedOnce = true;
    if (scrollCorrectionActive) applyCurrentScrollCorrection();
    else tryRestoreScroll();
  }
}

function addLoadMoreButton(list, sorted) {
  const remaining = sorted.length - renderedCount;
  const btn = document.createElement("button");
  btn.className = "load-more";
  btn.textContent = `⏳ Показать ещё ${Math.min(PAGE_SIZE, remaining)} (осталось ${remaining})`;
  btn.addEventListener("click", () => { renderNextBatch(list, sorted); });
  list.appendChild(btn);
}

function renderList() {
  const list = document.getElementById("list");
  if (!list) return;
  invalidateProblemStats();

  if (!allProducts.length) {
    list.innerHTML = '<div class="empty">Нет отслеживаемых товаров.<br>Открой страницу ozon.by и нажми «Добавить товар».</div>';
    updateCounter(0, 0);
    renderedCount = 0; lastRenderSignature = ""; lastSorted = [];
    listRenderedOnce = true;
    tryRestoreScroll();
    return;
  }

  const filtered = applyFilters(allProducts);
  updateCounter(filtered.length, allProducts.length);

  if (!filtered.length) {
    let emptyHtml;
    if (onlyFavorites) emptyHtml = '<div class="empty">Нет избранных товаров.</div>';
    else if (showOnlyProblems) emptyHtml = '<div class="empty">Проблемных товаров нет.</div>';
    else if (changeFilter === "up") emptyHtml = '<div class="empty">Нет товаров с повышением цены.</div>';
    else if (changeFilter === "down") emptyHtml = '<div class="empty">Нет товаров с понижением цены.</div>';
    else if (changeFilter === "all") emptyHtml = '<div class="empty">Ни у одного товара цена не менялась.</div>';
    else emptyHtml = '<div class="empty">Ничего не найдено по фильтрам.</div>';
    list.innerHTML = emptyHtml;
    renderedCount = 0; lastRenderSignature = ""; lastSorted = [];
    listRenderedOnce = true;
    tryRestoreScroll();
    return;
  }

  const sorted = applySort(filtered);
  lastSorted = sorted;
  const sig = computeSignature(sorted);
  let reservedHeight = 0;
  if (sig !== lastRenderSignature) {
    const anchor = captureViewAnchor();
    reservedHeight = list.offsetHeight;
    if (reservedHeight) list.style.minHeight = `${reservedHeight}px`;
    list.innerHTML = "";
    renderedCount = 0;
    lastRenderSignature = sig;
    if (anchor) {
      cardAnchor = anchor;
      scrollFallbackTop = anchor.scroll;
    }
  }
  if (renderedCount === 0) renderNextBatch(list, sorted);
  if (cardAnchor) {
    let guard = 0;
    let prevRendered = -1;
    while (guard++ < 20 && !findAnchorCard() && renderedCount < sorted.length &&
           document.body.scrollHeight - window.innerHeight < cardAnchor.scroll + 60) {
      if (renderedCount === prevRendered) break;
      prevRendered = renderedCount;
      renderNextBatch(list, sorted);
    }
  }
  if (reservedHeight) list.style.minHeight = "";
  if (cardAnchor) startScrollCorrection([80, 250]);
}

function onVirtualScroll() {
  if (!listRenderedOnce || isLoadingMore) return;
  const sorted = lastSorted;
  if (!sorted || renderedCount >= sorted.length) return;
  const scrollTop = getCurrentScroll();
  const viewport = window.innerHeight;
  const totalHeight = document.body.scrollHeight;
  if (scrollTop + viewport > totalHeight - 600) {
    const list = document.getElementById("list");
    if (list) renderNextBatch(list, sorted);
  }
}

let scrollHubTimer = null;
window.addEventListener("scroll", () => {
  if (scrollHubTimer) return;
  scrollHubTimer = setTimeout(() => {
    scrollHubTimer = null;
    onVirtualScroll();
    scheduleSaveScroll();
  }, 120);
}, { passive: true });

let stickyBarsHeight = 0;
function observeStickyBarsHeight() {
  const bars = document.getElementById("stickyBars");
  if (!bars) return;
  stickyBarsHeight = bars.offsetHeight;
  const ro = new ResizeObserver(() => {
    const h = bars.offsetHeight;
    const delta = h - stickyBarsHeight;
    stickyBarsHeight = h;
    if (!delta) return;
    if (scrollCorrectionActive) return;
    const y = getCurrentScroll();
    if (y <= 0) return;
    setCurrentScroll(Math.max(0, y + delta));
  });
  ro.observe(bars);
}
observeStickyBarsHeight();

function updateCounter(shown, total) {
  const el = document.getElementById("counter");
  const box = document.getElementById("counterBox");
  const lbl = document.getElementById("counterLabel");
  if (!el) return;
  if (shown === total) {
    el.textContent = String(total || 0);
    if (lbl) lbl.textContent = "Товаров";
    if (box) {
      box.classList.remove("filtered");
      box.title = `Всего товаров в отслеживании: ${total || 0}`;
    }
  } else {
    el.textContent = `${shown} / ${total}`;
    if (lbl) lbl.textContent = "Показано";
    if (box) {
      box.classList.add("filtered");
      box.title = `Показано ${shown} из ${total} — включены фильтры или поиск`;
    }
  }
}

async function reloadAndRender() {
  try {
    const data = await send({ action: "getData" });
    if (!data?.products) { setStatus("❌ Ошибка чтения storage"); return; }
    allProducts = data.products || [];
    invalidateProblemStats();
    const settings = data.settings || {};
    currentProgress = data.checkProgress || null;

    setInputValue(document.getElementById("defaultInterval"), settings.defaultIntervalMin || 60);
    setInputValue(document.getElementById("concurrency"), clampConc(Number(settings.concurrency)));
    setInputValue(document.getElementById("autoMinRating"), Number(settings.autoMinRating) || 0);
    setInputValue(document.getElementById("autoMinReviews"), Number(settings.autoMinReviews) || 0);
    setInputValue(document.getElementById("autoMaxPrice"), Number(settings.autoMaxPrice) || 0);

    sortBy = settings.sortBy || DEFAULT_SORT;
    const elSort = document.getElementById("sortSelect");
    if (elSort) elSort.value = sortBy;

    if (data.scanProgress?.active) scanFoundCount = Number(data.scanProgress.count) || 0;
    if (data.scanSaveStats) scanSaveStats = data.scanSaveStats;

    if (!uiStateLoaded) {
      const st = await loadUiState();
      if (st) {
        searchQuery = st.searchQuery || "";
        showOnlyProblems = !!st.showOnlyProblems;
        onlyFavorites = !!st.onlyFavorites;
        if (st.changeFilter === "all" || st.changeFilter === "up" || st.changeFilter === "down") {
          changeFilter = st.changeFilter;
        } else {
          changeFilter = null;
        }
        applyUiStateToDom();
        if (st.settingsOpen) {
          document.getElementById("settings")?.classList.remove("hidden");
        }
      }
      uiStateLoaded = true;
    }

    renderAlarmInfo();
    updateProblemBadge();
    updateChangeBadges();
    updateRecentBadge();
    updateFavPanelVisibility();
    updateResetDesiredBadge();
    renderProgress();
    renderImportBar();
    renderProblemActions();
    updateAddButtons();
    renderList();
  } catch (e) {
    console.error("reloadAndRender error:", e);
    setStatus("❌ Ошибка загрузки данных");
  }
}

async function checkPendingManualScan() {
  try {
    const r = await chrome.storage.local.get({ manualScanResult: null, manualScanAt: 0 });
    const result = r.manualScanResult;
    const at = Number(r.manualScanAt) || 0;
    if (!result?.length || Date.now() - at > 10 * 60 * 1000) {
      if (result) chrome.storage.local.remove(["manualScanResult", "manualScanAt"]).catch(() => {});
      return null;
    }
    return result;
  } catch { return null; }
}

function buildPickerItem(opts) {
  const { idx, image, name, price, metaText, metaBadge, checked } = opts;
  const label = document.createElement("label");
  label.className = "manual-item";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  if (checked) cb.checked = true;
  cb.dataset.idx = String(idx);
  label.appendChild(cb);

  const img = document.createElement("img");
  img.className = "manual-thumb";
  if (image) {
    img.src = image;
    img.onerror = function () { this.style.visibility = "hidden"; };
  } else {
    img.style.visibility = "hidden";
  }
  label.appendChild(img);

  const body = document.createElement("div");
  body.className = "manual-body";

  const nm = document.createElement("div");
  nm.className = "manual-name";
  nm.textContent = name || "Без названия";
  body.appendChild(nm);

  if (price) {
    const pr = document.createElement("div");
    pr.className = "manual-price";
    pr.textContent = price;
    body.appendChild(pr);
  }

  if (metaText || metaBadge) {
    const metaRow = document.createElement("div");
    metaRow.className = "manual-item-meta";
    if (metaText) {
      const txt = document.createElement("span");
      txt.className = "manual-item-meta-text";
      txt.textContent = metaText;
      metaRow.appendChild(txt);
    }
    if (metaBadge) metaRow.appendChild(metaBadge);
    body.appendChild(metaRow);
  }

  label.appendChild(body);
  return label;
}

function listCheckboxes(listId) {
  return document.querySelectorAll(`#${listId} input[type=checkbox]`);
}

function setAllChecked(listId, checked) {
  listCheckboxes(listId).forEach((cb) => { cb.checked = checked; });
}

function collectCheckedIndexes(listId) {
  const indexes = [];
  listCheckboxes(listId).forEach((cb) => {
    if (cb.checked) indexes.push(Number(cb.dataset.idx));
  });
  return indexes;
}

function bindSelectAll(listId, prefix) {
  on(`${prefix}SelectAll`, () => { setAllChecked(listId, true); });
  on(`${prefix}DeselectAll`, () => { setAllChecked(listId, false); });
}

async function getActiveOzonTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return null;
    const tab = tabs[0];
    if (!isOzonUrl(tab.url)) return null;
    return tab;
  } catch { return null; }
}

function renderPickerItems(list, items, mapFn) {
  list.innerHTML = "";
  items.forEach((it, idx) => {
    list.appendChild(buildPickerItem(mapFn(it, idx)));
  });
}

function makePicker(config) {
  const state = { items: [] };

  async function pick(items) {
    if (!items?.length) {
      if (config.emptyMessage) setStatus(config.emptyMessage);
      return;
    }
    state.items = items.slice();
    setText(config.countId, String(state.items.length));
    const list = document.getElementById(config.listId);
    if (!list) return;
    renderPickerItems(list, state.items, config.render);
    openPicker(config.pickerId);
    if (config.withTtl) startTtlTimer();
  }

  async function open() {
    if (!config.load) return;
    let items = [];
    try {
      items = await config.load();
    } catch (e) {
      console.error(`[picker ${config.pickerId}]`, e);
    }
    await pick(items || []);
  }

  function close() {
    closePicker(config.pickerId);
    state.items = [];
    if (config.onClose) {
      try { config.onClose(); } catch (e) { console.error(`[picker ${config.pickerId} close]`, e); }
    }
    checkOtherPickers();
  }

  function getSelected() {
    const indexes = collectCheckedIndexes(config.listId);
    return indexes.map((i) => state.items[i]).filter(Boolean);
  }

  return { pick, open, close, getSelected };
}

const manualPicker = makePicker({
  pickerId: "manualPicker",
  listId: "manualList",
  countId: "manualCount",
  withTtl: false,
  render: (p, idx) => ({
    idx,
    image: p.image,
    name: p.name,
    price: formatPrice(p.price),
    checked: true,
  }),
  onClose: () => {
    chrome.storage.local.remove(["manualScanResult", "manualScanAt"]).catch(() => {});
  },
});

const recentPicker = makePicker({
  pickerId: "recentPicker",
  listId: "recentList",
  countId: "recentCount",
  withTtl: true,
  emptyMessage: "За последние сутки новых товаров нет",
  load: async () => {
    if (!allProducts.length) {
      try {
        const data = await send({ action: "getData" });
        if (data?.products) allProducts = data.products;
      } catch {}
    }
    const cutoff = Date.now() - RECENT_TTL_MS;
    return allProducts
      .filter((p) => {
        const t = new Date(p.addedAt).getTime();
        return Number.isFinite(t) && t >= cutoff;
      })
      .toSorted((a, b) => (b.id || 0) - (a.id || 0));
  },
  render: (p, idx) => {
    const parts = [];
    if (p.favorite) parts.push("⭐");
    if (p.addedAt) parts.push(`добавлен ${formatDateTime(p.addedAt)}`);
    let metaBadge = null;
    if (p.addedAt) {
      const addedMs = new Date(p.addedAt).getTime();
      if (Number.isFinite(addedMs)) metaBadge = makeTtlBadge(addedMs + RECENT_TTL_MS, "recent");
    }
    return {
      idx,
      image: p.image,
      name: p.name,
      price: formatPrice(p.currentPrice),
      metaText: parts.length ? parts.join(" · ") : null,
      metaBadge,
    };
  },
});

const archivePicker = makePicker({
  pickerId: "archivePicker",
  listId: "archiveList",
  countId: "archiveCount",
  withTtl: true,
  emptyMessage: "Архив пуст",
  load: async () => {
    const r = await send({ action: "getArchive" });
    if (!r?.ok) { setStatus("Не удалось загрузить архив"); return []; }
    return r.items || [];
  },
  render: (it, idx) => {
    const parts = [];
    if (it.favorite) parts.push("⭐");
    if (it.archivedAt) parts.push(`удалён ${formatDateTime(it.archivedAt)}`);
    let metaBadge = null;
    if (it.archivedAt) {
      const archMs = new Date(it.archivedAt).getTime();
      if (Number.isFinite(archMs)) metaBadge = makeTtlBadge(archMs + ARCHIVE_TTL_MS, "archive");
    }
    const hasValidPrice = it.currentPrice != null && Number.isFinite(Number(it.currentPrice));
    return {
      idx,
      image: it.image,
      name: it.name,
      price: hasValidPrice ? formatPrice(it.currentPrice) : null,
      metaText: parts.length ? parts.join(" · ") : null,
      metaBadge,
    };
  },
});

function setAddInProgress(v) { addInProgress = v; updateAddButtons(); }

async function getAutoFilterSettings() {
  const data = await send({ action: "getSettings" });
  const s = data?.settings || {};
  return {
    minRating: Number(s.autoMinRating) || 0,
    minReviews: Number(s.autoMinReviews) || 0,
    maxPrice: Number(s.autoMaxPrice) || 0,
  };
}

function resetImportState() {
  scanInProgress = false;
  stoppingImport = false;
  importMode = null;
  scanSaveStats = null;
  scanFoundCount = 0;
  stopImportTimer();
  setAddInProgress(false);
  if (!showingScanResult) renderImportBar();
}

async function collectFromPage(mode) {
  const tab = await getActiveOzonTab();
  if (!tab) { setStatus("Это не страница Ozon.by"); return; }
  if (scanInProgress || addInProgress || isImportSessionLive()) { setStatus("⏳ Уже идёт добавление"); return; }
  if (showingScanResult) {
    showingScanResult = false;
    currentResultAt = 0;
    if (scanResultTimer) { clearTimeout(scanResultTimer); scanResultTimer = null; }
    hideImportBar();
  }
  chrome.storage.local.remove("lastScanResult").catch(() => {});
  scanInProgress = true;
  importMode = mode;
  stoppingImport = false;
  scanFoundCount = 0;
  scanSaveStats = mode === "auto" ? { added: 0, updated: 0, dropped: 0, active: true, startedAt: Date.now() } : null;
  setAddInProgress(true);
  startImportTimer();
  renderImportBar();

  const startRes = await send({ action: "startScanSession" });
  if (startRes?.started === false) {
    setStatus("⏳ Импорт уже идёт в другой вкладке");
    resetImportState();
    return;
  }
  await chrome.storage.local.set({ scanCancelRequested: false }).catch(() => {});
  let filter = null;
  if (mode === "auto") filter = await getAutoFilterSettings();
  const payload = { action: "scanAllProducts", streaming: mode === "auto", filter };
  const endSessionQuiet = async () => {
    try { await send({ action: "endScanSession" }); } catch {}
  };

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, payload);
  } catch {
    await endSessionQuiet();
    setStatus("Обнови страницу Ozon (F5)");
    resetImportState();
    return;
  }

  try {
    if (!resp?.products?.length) {
      await endSessionQuiet();
      setStatus("Не найдено товаров");
      return;
    }
    if (mode === "manual") {
      await endSessionQuiet();
      if (resp.cancelled) {
        setStatus(`⏹ Остановлено на ${resp.products.length} товарах`);
        await reloadAndRender();
        return;
      }
      manualPicker.pick(resp.products);
      setStatus(`Найдено ${resp.products.length} — выберите нужные`);
      return;
    }
    try { await send({ action: "endScanSession" }); } catch {}
    await waitForPaint();
    await reloadAndRender();
  } finally {
    resetImportState();
  }
}

(() => {
  const listEl = document.getElementById("list");
  if (!listEl) return;
  listEl.addEventListener("click", (e) => {
    const link = e.target?.closest?.("a[target='_blank']");
    if (!link) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    const url = link.href;
    if (!isOzonUrl(url)) return;
    e.preventDefault();
    chrome.tabs.create({ url, active: false }).catch(() => {});
  });
})();

const searchInputEl = document.getElementById("searchInput");
if (searchInputEl) {
  searchInputEl.addEventListener("input", function () {
    searchQuery = this.value;
    saveUiState();
    scheduleRenderList();
  });
}

function setChangeFilter(filter) {
  changeFilter = changeFilter === filter ? null : filter;
  updateChangeButtons();
  saveUiState();
  scheduleRenderList();
}

on("favoritesFilterBtn", function () {
  onlyFavorites = !onlyFavorites;
  this.classList.toggle("active", onlyFavorites);
  updateFavPanelVisibility();
  updateResetDesiredBadge();
  saveUiState();
  scheduleRenderList();
});

on("resetDesiredAllBtn", async () => {
  const n = getDesiredActiveCount();
  if (n === 0) { setStatus("У избранных нет желаемой цены"); return; }
  const ok = await openConfirmDelete({
    headerText: "🎯 Сбросить желаемые цены",
    headerClass: "neutral",
    question: `Сбросить желаемую цену у ${n} ${pluralItems(n)}?`,
    detailsHtml: "<div class='detail-row'>У всех избранных товаров будет убрана желаемая цена.</div><div class='detail-note'>Сами товары и история сохранятся.</div>",
    requireCheck: false,
    okText: "🎯 Сбросить",
    okClass: "primary",
  });
  if (!ok) return;
  const r = await send({ action: "resetAllDesiredPrices", onlyFavorites: true });
  setStatus(`🎯 Сброшено: ${r?.reset ?? n}`);
  await reloadAndRender();
});

on("changeAllBtn", () => { setChangeFilter("all"); });
on("changeUpBtn", () => { setChangeFilter("up"); });
on("changeDownBtn", () => { setChangeFilter("down"); });

on("problemToggle", function () {
  showOnlyProblems = !showOnlyProblems;
  this.classList.toggle("active", showOnlyProblems);
  saveUiState();
  scheduleRenderList();
  renderProblemActions();
});

on("resetBtn", async () => {
  resetAllFilters({ persist: true });
  renderProblemActions();
  scheduleRenderList();
  setStatus("↺ Фильтры сброшены");
});

let confirmDeleteResolver = null;
function openConfirmDelete(opts) {
  const { promise, resolve } = Promise.withResolvers();
  if (confirmDeleteResolver) {
    const old = confirmDeleteResolver;
    confirmDeleteResolver = null;
    old(false);
  }
  confirmDeleteResolver = resolve;
  const overlay = document.getElementById("confirmDelete");
  const headerEl = document.getElementById("confirmDeleteHeader");
  const headerTextEl = document.getElementById("confirmDeleteHeaderText");
  const questionEl = document.getElementById("confirmDeleteQuestion");
  const detailsEl = document.getElementById("confirmDeleteDetails");
  const checkWrapEl = document.getElementById("confirmDeleteCheckWrap");
  const checkEl = document.getElementById("confirmDeleteCheck");
  const checkLabelEl = document.getElementById("confirmDeleteCheckLabel");
  const okBtn = document.getElementById("confirmDeleteOk");
  if (!overlay) { resolve(false); return promise; }
  const headerText = opts.headerText || "⚠ Подтверждение";
  const headerClass = opts.headerClass || "danger";
  const requireCheck = opts.requireCheck !== false;
  const okText = opts.okText || "Подтвердить";
  const okClass = opts.okClass || "primary danger-primary";
  if (headerTextEl) headerTextEl.textContent = headerText;
  if (headerEl) headerEl.classList.toggle("neutral", headerClass === "neutral");
  if (questionEl) questionEl.textContent = opts.question || "Подтвердите действие";
  if (detailsEl) {
    if (opts.detailsHtml) { detailsEl.innerHTML = opts.detailsHtml; detailsEl.style.display = ""; }
    else { detailsEl.innerHTML = ""; detailsEl.style.display = "none"; }
  }
  if (checkWrapEl) {
    if (requireCheck) {
      checkWrapEl.style.display = "";
      if (checkEl) checkEl.checked = false;
      if (checkLabelEl) checkLabelEl.textContent = opts.checkLabel || "Я понимаю, что делаю";
      if (okBtn) okBtn.disabled = true;
    } else {
      checkWrapEl.style.display = "none";
      if (okBtn) okBtn.disabled = false;
    }
  }
  if (okBtn) { okBtn.textContent = okText; okBtn.className = okClass; }
  overlay.classList.remove("hidden");
  setTimeout(() => {
    try {
      if (requireCheck && checkEl) checkEl.focus();
      else if (okBtn) okBtn.focus();
    } catch {}
  }, 30);
  return promise;
}

function confirmDelete(question, opts = {}) {
  return openConfirmDelete({
    headerText: "⚠ Подтверждение удаления",
    headerClass: "danger",
    okClass: "primary danger-primary",
    question,
    ...opts,
  });
}

function closeConfirmDelete(result) {
  document.getElementById("confirmDelete")?.classList.add("hidden");
  if (confirmDeleteResolver) {
    const r = confirmDeleteResolver;
    confirmDeleteResolver = null;
    r(!!result);
  }
}

const confirmDeleteCheckEl = document.getElementById("confirmDeleteCheck");
if (confirmDeleteCheckEl) {
  confirmDeleteCheckEl.addEventListener("change", function () {
    const okBtn = document.getElementById("confirmDeleteOk");
    if (okBtn) okBtn.disabled = !this.checked;
  });
}
on("confirmDeleteOk", () => { closeConfirmDelete(true); });
on("confirmDeleteCancel", () => { closeConfirmDelete(false); });
on("confirmDeleteClose", () => { closeConfirmDelete(false); });

const confirmDeleteOverlay = document.getElementById("confirmDelete");
if (confirmDeleteOverlay) {
  confirmDeleteOverlay.addEventListener("click", function (e) {
    if (e.target === this) closeConfirmDelete(false);
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const ov = document.getElementById("confirmDelete");
  if (ov && !ov.classList.contains("hidden")) { closeConfirmDelete(false); return; }
  const mp = document.getElementById("manualPicker");
  if (mp && !mp.classList.contains("hidden")) { manualPicker.close(); return; }
  const rp = document.getElementById("recentPicker");
  if (rp && !rp.classList.contains("hidden")) { recentPicker.close(); return; }
  const ap = document.getElementById("archivePicker");
  if (ap && !ap.classList.contains("hidden")) { archivePicker.close(); return; }
});

function pluralItems(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "товар";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "товара";
  return "товаров";
}

on("deleteShownBtn", async () => {
  if (!allProducts.length) { setStatus("Список пуст"); return; }
  const filtered = applyFilters(allProducts);
  if (!filtered.length) { setStatus("Нет товаров для удаления"); return; }
  const filterDesc = [];
  if (searchQuery.trim()) filterDesc.push(`поиск «${escapeHtml(searchQuery.trim())}»`);
  if (showOnlyProblems) filterDesc.push("только проблемные");
  if (onlyFavorites) filterDesc.push("только избранные");
  if (changeFilter === "all") filterDesc.push("с изменениями цены");
  if (changeFilter === "up") filterDesc.push("с повышением цены");
  if (changeFilter === "down") filterDesc.push("с понижением цены");

  const total = allProducts.length;
  const willDeleteAll = filtered.length === total;
  let detailsHtml = "";
  detailsHtml += `<div class="detail-row">Будет удалено: <b>${filtered.length}</b> из ${total} товаров.</div>`;
  if (filterDesc.length) detailsHtml += `<div class="detail-row detail-filter">Активные фильтры: ${filterDesc.join(", ")}.</div>`;
  if (willDeleteAll) detailsHtml += `<div class="detail-row detail-warn">⚠ ВНИМАНИЕ: это ВСЕ ${total} товаров в списке!</div>`;
  detailsHtml += '<div class="detail-note">Товары попадут в архив удалённых (хранится 90 дней).</div>';

  const ok = await confirmDelete(`Удалить ${filtered.length} показанных товаров?`, {
    detailsHtml,
    requireCheck: true,
    checkLabel: `Я понимаю, что удаляю ${filtered.length} ${pluralItems(filtered.length)}`,
    okText: `🗑 Удалить ${filtered.length}`,
  });
  if (!ok) { setStatus("Удаление отменено"); return; }
  const urls = filtered.map((p) => p.url);
  setStatus(`⏳ Удаляю ${urls.length} товаров...`);
  await waitForPaint();
  await send({ action: "removeManyProducts", urls });
  setStatus(`🗑 Удалено: ${urls.length}`);
  await waitForPaint();
  await reloadAndRender();
});

const sortSelectEl = document.getElementById("sortSelect");
if (sortSelectEl) {
  sortSelectEl.addEventListener("change", async function () {
    sortBy = this.value;
    await send({ action: "setSettings", settings: { sortBy } });
    scheduleRenderList();
  });
}

on("clearGone", async () => {
  const stats = getProblemStats();
  if (stats.gone === 0) { setStatus("Нет удалённых товаров"); return; }
  const ok = await confirmDelete(`Удалить ${stats.gone} ${pluralItems(stats.gone)}, снятых с продажи?`, {
    headerText: "🗑 Удалить удалённые товары",
    detailsHtml: "<div class='detail-row'>У Ozon страница товара возвращает «не найдена».</div><div class='detail-note'>Товары попадут в архив удалённых (хранится 90 дней).</div>",
    requireCheck: false,
    okText: `🗑 Удалить ${stats.gone}`,
  });
  if (!ok) return;
  await send({ action: "clearFailedGone" });
  setStatus("🗑 Удалено");
  await reloadAndRender();
});

on("resetCaptcha", async () => {
  const stats = getProblemStats();
  if (stats.captcha === 0) { setStatus("Нет товаров с капчей"); return; }
  const ok = await openConfirmDelete({
    headerText: "🔓 Сбросить ошибку капчи",
    headerClass: "neutral",
    question: `Сбросить ошибку капчи у ${stats.captcha} ${pluralItems(stats.captcha)}?`,
    detailsHtml: "<div class='detail-row'>Товары вернутся в общий список и будут перепроверены при следующей плановой проверке.</div><div class='detail-note'>Ничего не удаляется.</div>",
    requireCheck: false,
    okText: "🔓 Сбросить",
    okClass: "primary",
  });
  if (!ok) return;
  await send({ action: "resetCaptchaFailed" });
  setStatus("🔓 Ошибка капчи сброшена");
  await reloadAndRender();
});

on("clearAllFailed", async () => {
  const stats = getProblemStats();
  if (stats.total === 0) { setStatus("Нет проблемных товаров"); return; }
  const ok = await confirmDelete(`Удалить ${stats.total} ${pluralItems(stats.total)} с ошибками?`, {
    headerText: "🗑 Удалить все проблемные",
    detailsHtml: "<div class='detail-row'>Включая нет в наличии, таймауты, капчу, редиректы и удалённые товары.</div><div class='detail-note'>Товары попадут в архив удалённых (хранится 90 дней).</div>",
    requireCheck: true,
    checkLabel: `Я понимаю, что удаляю ${stats.total} ${pluralItems(stats.total)}`,
    okText: `🗑 Удалить ${stats.total}`,
  });
  if (!ok) return;
  await send({ action: "clearFailed" });
  setStatus("🗑 Удалено");
  await reloadAndRender();
});

on("checkFailed", async function () {
  if (currentProgress?.running) { setStatus("⏳ Уже идёт проверка"); return; }
  const btn = this;
  btn.disabled = true;
  setStatus("⏳ Запускаю перепроверку проблемных...");
  const resp = await send({ action: "checkFailedOnly" });
  if (resp?.started === false) setStatus(`⏳ ${reasonShort(resp.reason || "busy")}`);
  else setStatus("✅ Перепроверка пошла");
  setTimeout(() => { btn.disabled = false; reloadAndRender(); }, 800);
});

on("addCurrent", async () => {
  const tab = await getActiveOzonTab();
  if (!tab) { setStatus("Это не страница Ozon.by"); return; }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, { action: "getPrice" });
  } catch {
    setStatus("Обнови страницу Ozon (F5)");
    return;
  }

  if (resp?.captcha) { setStatus("⚠ Требуется капча на Ozon"); return; }
  if (resp?.gone) { setStatus("⚠ Товар снят с продажи"); return; }
  if (resp?.notDelivered) { setStatus("⚠ Товар не доставляется в ваш регион"); return; }
  if (!resp?.price) { setStatus("Не удалось найти цену. Открой карточку товара."); return; }
  if (resp.redirect || !/\/product\//.test(resp.url || "")) { setStatus("⚠ Это не страница товара"); return; }

  const r = await send({
    action: "saveFromPage",
    url: resp.url,
    price: resp.price,
    name: resp.name,
    image: resp.image,
    rating: resp.rating,
    reviews: resp.reviews,
    questions: resp.questions,
    mediaCount: resp.mediaCount,
  });
  if (r?.ok === false) { setStatus("❌ Ошибка storage. Товар НЕ добавлен."); return; }
  setStatus(`✅ Добавлено: ${formatPrice(resp.price)}`);
  await waitForPaint();
  await reloadAndRender();
});

on("addFromPageAuto", () => { collectFromPage("auto"); });
on("addFromPageManual", () => { collectFromPage("manual"); });

function requestStopImport() {
  if (!stoppingImport) stoppingImport = true;
  renderImportBar();
  chrome.storage.local.set({ scanCancelRequested: true, saveCancelRequested: true }).catch(() => {});
  setStatus("⏹ Останавливаю импорт...");
}
on("stopAddBtn", requestStopImport);
on("importStopBtn", requestStopImport);

on("recentBtn", () => { recentPicker.open(); });
on("recentClose", () => { recentPicker.close(); });
on("recentCancel", () => { recentPicker.close(); });
on("recentDelete", async () => {
  const selected = recentPicker.getSelected();
  if (!selected.length) { setStatus("Ничего не выбрано"); return; }
  const urls = selected.map((p) => p.url);
  const ok = await confirmDelete(`Удалить ${urls.length} ${pluralItems(urls.length)}?`, {
    headerText: "🗑 Удалить выбранные товары",
    detailsHtml: "<div class='detail-row'>Товары попадут в архив удалённых (хранится 90 дней).</div>",
    requireCheck: false,
    okText: `🗑 Удалить ${urls.length}`,
  });
  if (!ok) return;
  await send({ action: "removeManyProducts", urls });
  setStatus(`🗑 Удалено: ${urls.length}`);
  recentPicker.close();
  await reloadAndRender();
});

on("manualClose", () => { manualPicker.close(); });
on("manualCancel", () => { manualPicker.close(); });
on("manualAdd", async () => {
  const selected = manualPicker.getSelected();
  if (!selected.length) { setStatus("Ничего не выбрано"); return; }
  setAddInProgress(true);
  setStatus(`⏳ Сохраняю ${selected.length} товаров...`);
  const r = await send({ action: "saveManyFromPage", products: selected });
  setAddInProgress(false);
  if (r?.ok === false) { setStatus("❌ Ошибка storage. Товары НЕ изменены."); return; }
  let msg = "✅ ";
  if (r?.count) msg += `Добавлено: ${r.count.added}, обновлено: ${r.count.updated}`;
  else msg += `Обработано: ${selected.length}`;
  manualPicker.close();
  setStatus(msg);
  await waitForPaint();
  await reloadAndRender();
});

on("archiveBtn", () => { archivePicker.open(); });
on("archiveClose", () => { archivePicker.close(); });
on("archiveCancel", () => { archivePicker.close(); });
on("archiveDelete", async () => {
  const selected = archivePicker.getSelected();
  if (!selected.length) { setStatus("Ничего не выбрано"); return; }
  const keys = selected.map((it) => it.key).filter(Boolean);
  if (!keys.length) { setStatus("Ничего не выбрано"); return; }
  const ok = await confirmDelete(`Удалить ${keys.length} ${pluralItems(keys.length)} из архива насовсем?`, {
    headerText: "🗑 Удалить насовсем",
    detailsHtml: "<div class='detail-row detail-warn'>⚠ Это действие необратимо: история и статистика будут потеряны.</div><div class='detail-note'>Если снова добавите товар — история не восстановится.</div>",
    requireCheck: true,
    checkLabel: `Я понимаю, что удаляю насовсем ${keys.length} ${pluralItems(keys.length)}`,
    okText: "🗑 Удалить насовсем",
  });
  if (!ok) return;
  const r = await send({ action: "removeFromArchive", keys });
  if (r?.ok) setStatus(`🗑 Удалено из архива: ${r.removed || keys.length}`);
  else setStatus("❌ Не удалось удалить из архива");
  archivePicker.close();
});

bindSelectAll("manualList", "manual");
bindSelectAll("recentList", "recent");
bindSelectAll("archiveList", "archive");

on("checkNow", async function () {
  if (currentProgress?.running) {
    setStatus("⏹ Останавливаю...");
    await send({ action: "stopCheck" });
    await reloadAndRender();
    return;
  }
  const btn = this;
  btn.disabled = true;
  setStatus("⏳ Запускаю проверку...");
  const resp = await send({ action: "checkNow" });
  if (resp?.started === false) setStatus(`⏳ ${reasonShort(resp.reason || "busy")}`);
  else setStatus("✅ Проверка пошла");
  setTimeout(() => { btn.disabled = false; reloadAndRender(); }, 800);
});

on("settingsBtn", () => {
  document.getElementById("settings")?.classList.toggle("hidden");
  saveUiState();
});

let settingsSaveTimer = null;
const dirtySettingsFields = new Set();

function getSettingsUnitEl(fieldId) {
  const input = document.getElementById(fieldId);
  if (!input) return null;
  const wrap = input.closest(".settings-row-control");
  if (!wrap) return null;
  return wrap.querySelector(".settings-row-unit");
}

function clearFieldSavedMark(fieldId) {
  const unit = getSettingsUnitEl(fieldId);
  if (!unit) return;
  if (unit._savedTimer) { clearTimeout(unit._savedTimer); unit._savedTimer = null; }
  if (unit.dataset.origUnit !== undefined) unit.textContent = unit.dataset.origUnit;
  unit.classList.remove("saved-flash");
}

function showFieldSavedMark(fieldId) {
  const unit = getSettingsUnitEl(fieldId);
  if (!unit) return;
  if (unit.dataset.origUnit === undefined) unit.dataset.origUnit = unit.textContent;
  if (unit._savedTimer) { clearTimeout(unit._savedTimer); unit._savedTimer = null; }
  unit.textContent = "✓";
  unit.classList.remove("saved-flash");
  void unit.offsetWidth;
  unit.classList.add("saved-flash");
  unit._savedTimer = setTimeout(() => {
    unit._savedTimer = null;
    unit.textContent = unit.dataset.origUnit;
    unit.classList.remove("saved-flash");
  }, 1300);
}

async function saveSettingsNow() {
  const concurrencyEl = document.getElementById("concurrency");
  const ratingEl = document.getElementById("autoMinRating");
  const reviewsEl = document.getElementById("autoMinReviews");
  const maxPriceEl = document.getElementById("autoMaxPrice");
  const intervalEl = document.getElementById("defaultInterval");
  if (!concurrencyEl || !intervalEl) { dirtySettingsFields.clear(); return; }

  const fieldsToMark = Array.from(dirtySettingsFields);
  dirtySettingsFields.clear();
  if (!fieldsToMark.length) return;

  const concurrency = clampConc(parseLocalizedNumber(concurrencyEl.value));
  const autoMinRating = validateSetting(ratingEl.value, { min: 0, max: 5, def: 0 });
  const autoMinReviews = validateSetting(reviewsEl.value, { min: 0, max: Infinity, def: 0 });
  const autoMaxPrice = validateSetting(maxPriceEl.value, { min: 0, max: Infinity, def: 0 });
  const interval = validateSetting(intervalEl.value, { min: MIN_CHECK_INTERVAL_MIN, max: Infinity, def: DEFAULT_CHECK_INTERVAL_MIN });

  const settings = {
    defaultIntervalMin: interval,
    concurrency,
    autoMinRating,
    autoMinReviews,
    autoMaxPrice,
  };
  await send({ action: "setSettings", settings });

  setInputValue(intervalEl, interval);
  setInputValue(concurrencyEl, concurrency);
  setInputValue(ratingEl, autoMinRating);
  setInputValue(reviewsEl, autoMinReviews);
  setInputValue(maxPriceEl, autoMaxPrice);

  renderAlarmInfo();

  for (const id of fieldsToMark) showFieldSavedMark(id);
}

function scheduleSettingsSave(fieldId) {
  dirtySettingsFields.add(fieldId);
  clearFieldSavedMark(fieldId);
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveSettingsNow();
  }, 700);
}

["defaultInterval", "concurrency", "autoMinRating", "autoMinReviews", "autoMaxPrice"].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("input", () => { scheduleSettingsSave(id); });
  el.addEventListener("change", () => {
    dirtySettingsFields.add(id);
    if (settingsSaveTimer) { clearTimeout(settingsSaveTimer); settingsSaveTimer = null; }
    saveSettingsNow();
  });
});

on("clearAll", async () => {
  if (!allProducts.length) { setStatus("Список пуст"); return; }
  const ok = await confirmDelete(`Удалить ВСЕ ${allProducts.length} ${pluralItems(allProducts.length)}?`, {
    headerText: "🗑 Удалить все товары",
    detailsHtml: "<div class='detail-row detail-warn'>⚠ Это затронет все товары в списке.</div><div class='detail-note'>Товары будут перенесены в архив удалённых (хранится 90 дней). Если добавите их снова — история восстановится.</div>",
    requireCheck: true,
    checkLabel: `Я понимаю, что удаляю все ${allProducts.length} ${pluralItems(allProducts.length)}`,
    okText: "🗑 Удалить все",
  });
  if (!ok) return;
  await send({ action: "clearAll" });
  resetAllFilters({ persist: false });
  setStatus("🗑 Все товары перенесены в архив");
  setTimeout(() => { reloadAndRender(); }, 1200);
});

let reloadDebounceTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.lastScanResult) {
    const nv = changes.lastScanResult.newValue;
    if (nv) maybeShowScanResult(nv);
  }
  if (changes.checkProgress) {
    currentProgress = changes.checkProgress.newValue;
    renderProgress();
    if (currentProgress && !currentProgress.running) {
      setTimeout(() => { reloadAndRender(); }, 500);
    }
  }
  if (changes.product_ids) {
    if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = setTimeout(() => {
      reloadDebounceTimer = null;
      reloadAndRender();
    }, 500);
  }
  if (changes.scanProgress) {
    const sp = changes.scanProgress.newValue;
    if (sp?.active) scanFoundCount = Number(sp.count) || 0;
    renderImportBar();
  }
  if (changes.scanSaveStats) {
    scanSaveStats = changes.scanSaveStats.newValue;
    renderImportBar();
  }
});

window.addEventListener("error", (e) => {
  console.error("[popup] uncaught:", e.message || e.error);
});

chrome.storage.local.get({ popupScrollTop: 0, popupListTop: 0, popupScrollTopAt: 0 }, (r) => {
  const savedTop = Number(r.popupScrollTop) || 0;
  const savedListTop = Number(r.popupListTop) || 0;
  const savedAt = Number(r.popupScrollTopAt) || 0;
  const age = savedAt > 0 ? Date.now() - savedAt : Infinity;
  if (age > SCROLL_TTL_MS) {
    popupScrollTop = 0;
    popupListTop = 0;
    chrome.storage.local.set({ popupScrollTop: 0, popupListTop: 0, popupScrollTopAt: 0 }).catch(() => {});
  } else {
    popupScrollTop = savedTop;
    popupListTop = savedListTop;
  }
  popupScrollLoaded = true;
  tryRestoreScroll();
});

const listElForScroll = document.getElementById("list");
if (listElForScroll) listElForScroll.addEventListener("mousedown", saveScrollPosition, true);
window.addEventListener("pagehide", () => {
  if (!popupScrollRestored) return;
  saveScrollPosition();
});

(async () => {
  const saved = await checkPendingManualScan();
  if (saved?.length) manualPicker.pick(saved);
})();

(() => {
  const el = document.getElementById("versionBadge");
  if (!el) return;
  try {
    const v = chrome.runtime.getManifest().version;
    el.textContent = `v${v}`;
    el.title = `OzonBYPriceTracker v${v}`;
  } catch {
    el.style.display = "none";
  }
})();

reloadAndRender();
setInterval(renderAlarmInfo, 60000);

chrome.storage.local.get({ lastScanResult: null }, (r) => {
  if (r.lastScanResult) maybeShowScanResult(r.lastScanResult);
});