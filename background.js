importScripts("utils.js");

const MAX_HISTORY = 500;
const CAPTCHA_REDUCE_RATIO = 0.15;
const CAPTCHA_REDUCE_MIN = 5;
const CONCURRENCY_RECOVERY_HOURS = 6;
const TIMEOUT_STREAK_STOP = 8;

const SAVE_QUEUE_DELAY_MS = 700;
const SAVE_QUEUE_MAX_BATCH = 120;
const SAVE_QUEUE_MAX_FAIL_STREAK = 3;
const SAVE_QUEUE_HARD_CAP = 5000;

const TAB_WAITER_TIMEOUT_MS = 60000;
const READ_BATCH = 500;
const REMOVE_BATCH = 500;

const PENDING_FLUSH_MS = 500;
const PENDING_FLUSH_MAX = 100;
const PENDING_SESSION_PERSIST_MS = 3000;
const PENDING_FLUSH_BACKOFF_MAX_MS = 30000;

const SUSPICIOUS_PRICE_RATIO = 0.7;
const SUSPICIOUS_SPIKE_RATIO = 3;
const SUSPICIOUS_CONFIRM_TOLERANCE = 0.02;
const SUSPICIOUS_TTL_MS = 25 * 60 * 60 * 1000;

const DELETED_HISTORY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STALE_SCAN_TTL_MS = 15 * 60 * 1000;

const EXTENSION_ORIGIN = chrome.runtime.getURL("");

const MUTATING_ACTIONS = new Set([
  "clearAll",
  "setSettings",
  "removeProduct",
  "removeManyProducts",
  "clearFailed",
  "clearFailedGone",
  "resetCaptchaFailed",
  "clearHistory",
  "toggleFavorite",
  "removeFromArchive",
  "setDesiredPrice",
  "resetAllDesiredPrices",
]);

async function setData(data) {
  try {
    await chrome.storage.local.set(data);
  } catch (e) {
    const msg = e?.message || "storage error";
    if (/QUOTA/i.test(msg)) console.warn("[storage] QUOTA EXCEEDED");
    throw new Error(msg);
  }
}

async function sessionGet(defaults) {
  try { return await chrome.storage.session.get(defaults); }
  catch { return defaults; }
}

async function sessionSet(data) {
  try { await chrome.storage.session.set(data); } catch {}
}

async function sessionRemove(keys) {
  try { await chrome.storage.session.remove(keys); } catch {}
}

async function getSettings() {
  const r = await chrome.storage.local.get({ settings: {} });
  return r.settings || {};
}

async function patchSettings(patch) {
  return withStorageLock(async () => {
    const r = await chrome.storage.local.get({ settings: {} });
    const merged = { ...(r.settings || {}), ...patch };
    await setData({ settings: merged });
    return merged;
  });
}

async function getBatched(keys) {
  const out = {};
  for (let i = 0; i < keys.length; i += READ_BATCH) {
    const slice = keys.slice(i, i + READ_BATCH);
    const chunk = await chrome.storage.local.get(slice);
    Object.assign(out, chunk);
  }
  return out;
}

function isFromExtensionUI(sender) {
  if (!sender) return false;
  if (sender.origin && `${sender.origin}/` === EXTENSION_ORIGIN) return true;
  if (sender.url && sender.url.startsWith(EXTENSION_ORIGIN)) return true;
  return false;
}

let isChecking = false;
let stopRequested = false;
let currentCheckEpoch = 0;
const activeTabIds = new Set();
let runtimeBusy = false;
let endScanInProgress = false;

const archiveKey = (url) => `dh_${normalizeUrl(url)}`;

async function getArchiveStorageKeys() {
  const allKeys = await chrome.storage.local.getKeys();
  return allKeys.filter((k) => k.startsWith("dh_"));
}

async function removeKeysBatched(keys) {
  if (!keys?.length) return 0;
  let removed = 0;
  for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
    const slice = keys.slice(i, i + REMOVE_BATCH);
    try { await chrome.storage.local.remove(slice); removed += slice.length; } catch {}
  }
  return removed;
}

const closeTab = (id) => chrome.tabs.remove(id).catch(() => {});
const closeTabs = (ids) => Promise.all(ids.map(closeTab));

function closeTabsSilently(ids) {
  for (const id of ids) {
    try { chrome.tabs.remove(id).catch(() => {}); } catch {}
  }
}

async function createBlankTab() {
  try {
    const t = await chrome.tabs.create({ url: "about:blank", active: false });
    return t?.id || null;
  } catch { return null; }
}

async function navigateTab(tabId, url) {
  try {
    const t = await chrome.tabs.update(tabId, { url });
    if (!t?.id) return { ok: false, reason: "nav-failed" };
    return { ok: true };
  } catch (e) {
    const err = e?.message || String(e);
    console.warn("[nav] failed:", err, "tabId:", tabId, "url:", url);
    return { ok: false, reason: "nav-failed" };
  }
}

async function getIdByUrl(url) {
  const cleanUrl = normalizeUrl(url);
  const r = await chrome.storage.local.get({ product_url_to_id: {} });
  return (r.product_url_to_id || {})[cleanUrl] || null;
}

async function haltCurrentCheck() {
  stopRequested = true;
  currentCheckEpoch++;
  const idsToKill = Array.from(activeTabIds);
  closeTabsSilently(idsToKill);
  activeTabIds.clear();
  try { await destroyTabPool(); } catch {}
}

function buildArchivedEntry(p, history, now) {
  return {
    url: p.url,
    name: p.name || "",
    image: p.image || "",
    currentPrice: p.currentPrice,
    history: (history || []).slice(),
    minPrice: p.minPrice, minPriceDate: p.minPriceDate,
    maxPrice: p.maxPrice, maxPriceDate: p.maxPriceDate,
    addedAt: p.addedAt,
    favorite: !!p.favorite,
    desiredPrice: Number(p.desiredPrice) > 0 ? Number(p.desiredPrice) : undefined,
    ratingDelta: p.ratingDelta, ratingDeltaAt: p.ratingDeltaAt,
    reviewsDelta: p.reviewsDelta, reviewsDeltaAt: p.reviewsDeltaAt,
    questionsDelta: p.questionsDelta, questionsDeltaAt: p.questionsDeltaAt,
    mediaDelta: p.mediaDelta, mediaDeltaAt: p.mediaDeltaAt,
    archivedAt: now,
  };
}

function applyArchivedEntry(product, archived) {
  if (!archived) return;
  if (archived.addedAt) product.addedAt = archived.addedAt;
  if (archived.minPrice !== undefined) { product.minPrice = archived.minPrice; product.minPriceDate = archived.minPriceDate; }
  if (archived.maxPrice !== undefined) { product.maxPrice = archived.maxPrice; product.maxPriceDate = archived.maxPriceDate; }
  if (archived.favorite !== undefined) product.favorite = archived.favorite;
  if (archived.desiredPrice !== undefined && Number(archived.desiredPrice) > 0) {
    product.desiredPrice = Number(archived.desiredPrice);
  }
  if (archived.ratingDelta !== undefined) { product.ratingDelta = archived.ratingDelta; product.ratingDeltaAt = archived.ratingDeltaAt; }
  if (archived.reviewsDelta !== undefined) { product.reviewsDelta = archived.reviewsDelta; product.reviewsDeltaAt = archived.reviewsDeltaAt; }
  if (archived.questionsDelta !== undefined) { product.questionsDelta = archived.questionsDelta; product.questionsDeltaAt = archived.questionsDeltaAt; }
  if (archived.mediaDelta !== undefined) { product.mediaDelta = archived.mediaDelta; product.mediaDeltaAt = archived.mediaDeltaAt; }
}

function clearFailState(p) {
  p.failCount = 0;
  p.lastCheckError = null;
  p.lastCheckFailedAt = null;
}

async function getAllArchive() {
  const dhKeys = await getArchiveStorageKeys();
  if (!dhKeys.length) return [];
  const items = [];
  for (let i = 0; i < dhKeys.length; i += READ_BATCH) {
    const slice = dhKeys.slice(i, i + READ_BATCH);
    const chunk = await chrome.storage.local.get(slice);
    for (const k of slice) {
      const e = chunk[k];
      if (!e) continue;
      const url = e.url || k.substring(3);
      let name = e.name;
      if (!name) {
        const art = extractArticleFromUrl(url);
        name = art ? `Артикул ${art}` : "Без названия";
      }
      items.push({
        key: k,
        url,
        name,
        image: e.image || "",
        currentPrice: e.currentPrice !== undefined && e.currentPrice !== null ? e.currentPrice : null,
        minPrice: e.minPrice,
        maxPrice: e.maxPrice,
        favorite: !!e.favorite,
        addedAt: e.addedAt,
        archivedAt: e.archivedAt,
      });
    }
  }
  items.sort((a, b) => {
    let ta = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
    let tb = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
    if (!Number.isFinite(ta)) ta = 0;
    if (!Number.isFinite(tb)) tb = 0;
    return tb - ta;
  });
  return items;
}

async function archiveAndRemove(products, mutateMeta) {
  const now = new Date().toISOString();
  const archPatch = {};
  const toRemoveKeys = [];
  for (const p of products) {
    archPatch[archiveKey(p.url)] = buildArchivedEntry(p, p.history || [], now);
    toRemoveKeys.push(`p_${p.id}`, `h_${p.id}`);
    pendingWrites.delete(p.id);
  }
  await removeKeysBatched(toRemoveKeys);
  const patch = { ...archPatch };
  if (mutateMeta) mutateMeta(patch);
  await setData(patch);
}

async function cleanupDeletedHistory() {
  try {
    const meta = await chrome.storage.local.get({ deletedHistoryCleanupAt: 0 });
    const last = Number(meta.deletedHistoryCleanupAt) || 0;
    if (last && Date.now() - last < DELETED_HISTORY_CLEANUP_INTERVAL_MS) return;

    const dhKeys = await getArchiveStorageKeys();
    if (!dhKeys.length) {
      await setData({ deletedHistoryCleanupAt: Date.now() });
      return;
    }

    const cutoff = Date.now() - ARCHIVE_TTL_MS;
    const toRemove = [];
    for (let i = 0; i < dhKeys.length; i += READ_BATCH) {
      const slice = dhKeys.slice(i, i + READ_BATCH);
      const chunk = await chrome.storage.local.get(slice);
      for (const k of slice) {
        const entry = chunk[k];
        const archivedAt = entry?.archivedAt ? new Date(entry.archivedAt).getTime() : 0;
        if (!archivedAt || archivedAt < cutoff) toRemove.push(k);
      }
    }
    await removeKeysBatched(toRemove);
    await setData({ deletedHistoryCleanupAt: Date.now() });
  } catch (e) { console.error("[Cleanup] error:", e); }
}

const pendingWrites = new Map();
let pendingFlushTimer = null;
let pendingSessionTimer = null;
let pendingFlushBackoffMs = 0;

function schedulePendingSessionPersist() {
  if (pendingSessionTimer) return;
  pendingSessionTimer = setTimeout(() => {
    pendingSessionTimer = null;
    try {
      const arr = [];
      pendingWrites.forEach((rec, id) => {
        arr.push({ id, product: rec.product, history: rec.history });
      });
      sessionSet({ pendingWritesSnapshot: arr });
    } catch {}
  }, PENDING_SESSION_PERSIST_MS);
}

function schedulePendingFlush() {
  if (pendingFlushTimer) return;
  const base = pendingWrites.size >= PENDING_FLUSH_MAX ? 50 : PENDING_FLUSH_MS;
  const delay = Math.max(base, pendingFlushBackoffMs);
  pendingFlushTimer = setTimeout(() => {
    pendingFlushTimer = null;
    flushPendingWrites().catch((e) => console.error("[pending]", e));
  }, delay);
  schedulePendingSessionPersist();
}

function flushPendingWrites() {
  return withStorageLock(async () => {
    if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
    if (!pendingWrites.size) { pendingFlushBackoffMs = 0; return; }
    const entries = Array.from(pendingWrites.entries());
    const patch = {};
    for (const [id, rec] of entries) {
      patch[`p_${id}`] = rec.product;
      patch[`h_${id}`] = rec.history;
    }
    try {
      await setData(patch);
      pendingFlushBackoffMs = 0;
    } catch (e) {
      console.error("[pending] setData error:", e);
      if (pendingFlushBackoffMs === 0) pendingFlushBackoffMs = PENDING_FLUSH_MS * 2;
      else pendingFlushBackoffMs = Math.min(pendingFlushBackoffMs * 2, PENDING_FLUSH_BACKOFF_MAX_MS);
      schedulePendingFlush();
      throw e;
    }
    for (const [id, rec] of entries) {
      if (pendingWrites.get(id) === rec) pendingWrites.delete(id);
    }
    try { await sessionRemove("pendingWritesSnapshot"); } catch {}
  });
}

async function flushPendingQuiet() {
  try { await flushPendingWrites(); } catch {}
}

async function recoverPendingWrites() {
  try {
    const r = await sessionGet({ pendingWritesSnapshot: null });
    const arr = r.pendingWritesSnapshot;
    if (!Array.isArray(arr) || !arr.length) return;
    for (const rec of arr) {
      if (rec?.id != null && rec.product) {
        pendingWrites.set(rec.id, { product: rec.product, history: rec.history || [] });
      }
    }
    await sessionRemove("pendingWritesSnapshot");
    schedulePendingFlush();
  } catch (e) { console.error("[pending] recover error:", e); }
}

function syncLastPrices(p, history) {
  if (!history?.length) { p.lastPrices = []; return; }
  p.lastPrices = history.slice(-2);
}

function cloneFromPending(id, withHistory) {
  const rec = pendingWrites.get(id);
  if (!rec) return null;
  const p = { ...rec.product };
  if (withHistory) p.history = rec.history.slice();
  return p;
}

async function readProductById(id, withHistory) {
  const pending = cloneFromPending(id, withHistory);
  if (pending) return pending;
  const keys = [`p_${id}`];
  if (withHistory) keys.push(`h_${id}`);
  const r = await chrome.storage.local.get(keys);
  const p = r[`p_${id}`];
  if (!p) return null;
  if (withHistory) p.history = r[`h_${id}`] || [];
  return p;
}

async function readProductsGeneric(ids, withHistory) {
  if (!ids?.length) return [];
  const result = [];
  for (let i = 0; i < ids.length; i += READ_BATCH) {
    const slice = ids.slice(i, i + READ_BATCH);
    const keys = [];
    for (const id of slice) {
      keys.push(`p_${id}`);
      if (withHistory) keys.push(`h_${id}`);
    }
    const chunk = await chrome.storage.local.get(keys);
    for (const id of slice) {
      const pending = cloneFromPending(id, withHistory);
      if (pending) { result.push(pending); continue; }
      const p = chunk[`p_${id}`];
      if (!p) continue;
      if (withHistory) p.history = chunk[`h_${id}`] || [];
      result.push(p);
    }
  }
  return result;
}

async function readProductsWithHistory(ids) {
  const products = {};
  const histories = {};
  if (!ids?.length) return { products, histories };
  const uniqueIds = Array.from(new Set(ids));
  for (let i = 0; i < uniqueIds.length; i += READ_BATCH) {
    const slice = uniqueIds.slice(i, i + READ_BATCH);
    const keys = [];
    for (const id of slice) keys.push(`p_${id}`, `h_${id}`);
    const chunk = await chrome.storage.local.get(keys);
    for (const id of slice) {
      const pend = cloneFromPending(id, true);
      if (pend) {
        const { history, ...prod } = pend;
        products[id] = prod;
        histories[id] = history;
      } else {
        products[id] = chunk[`p_${id}`];
        histories[id] = chunk[`h_${id}`] || [];
      }
    }
  }
  return { products, histories };
}

async function readAllProducts(opts = {}) {
  const r = await chrome.storage.local.get({ product_ids: [] });
  return readProductsGeneric(r.product_ids || [], !!opts.withHistory);
}

function pushHistoryFull(p, history, price, now) {
  const last = history.at(-1);
  if (!last || last.price !== price) {
    history.push({ price, date: now });
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    syncLastPrices(p, history);
  }
}

async function maybeRecoverConcurrency() {
  try {
    const r = await chrome.storage.local.get({ settings: {}, concurrencyAutoReducedAt: 0 });
    const settings = r.settings || {};
    const target = clampConc(Number(settings.concurrencyTarget) || Number(settings.concurrency) || DEFAULT_CONCURRENCY);
    const current = clampConc(Number(settings.concurrency) || DEFAULT_CONCURRENCY);
    if (current >= target) return;
    const reduceAt = Number(r.concurrencyAutoReducedAt) || 0;
    if (!reduceAt) return;
    const hoursSince = (Date.now() - reduceAt) / (60 * 60 * 1000);
    if (hoursSince < CONCURRENCY_RECOVERY_HOURS) return;
    const newConc = Math.min(target, current + 1);
    if (newConc > current) {
      await patchSettings({ concurrency: newConc });
      await setData({ concurrencyAutoReducedAt: Date.now() });
    }
  } catch (e) { console.error("[Concurrency recover]", e); }
}

let saveCancelCache = false;
let saveCancelLoaded = false;
const { promise: saveCancelReady, resolve: resolveSaveCancelReady } = Promise.withResolvers();
chrome.storage.local.get({ saveCancelRequested: false })
  .then((r) => {
    saveCancelCache = !!r.saveCancelRequested;
    saveCancelLoaded = true;
    resolveSaveCancelReady();
  })
  .catch(() => {
    resolveSaveCancelReady();
  });

async function waitSaveCancelLoaded() {
  if (saveCancelLoaded) return;
  try { await saveCancelReady; } catch {}
}

async function resetSaveCancel() {
  saveCancelCache = false;
  saveCancelLoaded = true;
  await setData({ saveCancelRequested: false });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.saveCancelRequested) {
    saveCancelCache = !!changes.saveCancelRequested.newValue;
    saveCancelLoaded = true;
  }
  if (changes.scanProgress) {
    const nv = changes.scanProgress.newValue;
    if (nv && nv.active && typeof nv.count === "number") {
      sessionSet({ lastScanFound: Number(nv.count) || 0 });
    }
    if (nv === null) {
      sessionGet({ scanSessionActive: false }).then((sr) => {
        if (!sr.scanSessionActive) return;
        chrome.storage.local.get({ scanSaveStats: null }, (cur0) => {
          const expectedSessionId = cur0.scanSaveStats && cur0.scanSaveStats.sessionId;
          setTimeout(() => {
            sessionGet({ scanSessionActive: false }).then((sr2) => {
              if (!sr2.scanSessionActive) return;
              chrome.storage.local.get({ scanSaveStats: null }, (cur) => {
                const ss = cur.scanSaveStats;
                if (ss && ss.active && ss.sessionId === expectedSessionId) {
                  endScanSession().catch((e) => console.error("[orphan-end]", e));
                }
              });
            });
          }, 2500);
        });
      });
    }
  }
});

let saveQueue = [];
let saveQueueTimer = null;
let saveQueueFailStreak = 0;
let saveQueueDropped = 0;
let currentSaveFlushPromise = null;
let currentSessionId = null;

function persistSaveQueueDebounced() {
  if (persistSaveQueueDebounced._t) return;
  persistSaveQueueDebounced._t = setTimeout(() => {
    persistSaveQueueDebounced._t = null;
    try { sessionSet({ saveQueue: saveQueue.slice(-SAVE_QUEUE_MAX_BATCH * 4) }); } catch {}
  }, 500);
}

function scheduleSaveQueueFlush() {
  if (saveQueueTimer) return;
  if (saveCancelCache === true) return;
  const delay = saveQueue.length >= SAVE_QUEUE_MAX_BATCH ? 50 : SAVE_QUEUE_DELAY_MS;
  saveQueueTimer = setTimeout(() => {
    saveQueueTimer = null;
    flushSaveQueue().catch((e) => console.error("[SaveQueue]", e));
  }, delay);
}

async function doFlushSaveQueue() {
  if (!saveQueue.length) return;
  const chunk = saveQueue.splice(0, saveQueue.length);
  const droppedInQueue = saveQueueDropped;
  saveQueueDropped = 0;

  async function bumpScanStats(sessionId, delta) {
    if (!sessionId) return;
    try {
      await withStorageLock(async () => {
        const r = await chrome.storage.local.get({ scanSaveStats: null });
        const ss = r.scanSaveStats;
        if (ss && ss.active && ss.sessionId === sessionId) {
          ss.added = (Number(ss.added) || 0) + (delta.added || 0);
          ss.updated = (Number(ss.updated) || 0) + (delta.updated || 0);
          if (delta.dropped) ss.dropped = (Number(ss.dropped) || 0) + delta.dropped;
          await setData({ scanSaveStats: ss });
        }
      });
    } catch (e2) { console.error("[SaveQueue] stats:", e2); }
  }

  try {
    const chunkSessionId = currentSessionId;
    let stats;
    try {
      stats = await saveManyFromPage(chunk);
      saveQueueFailStreak = 0;
    } catch (e) {
      console.error("[SaveQueue] error:", e);
      saveQueueFailStreak++;
      if (saveQueueFailStreak >= SAVE_QUEUE_MAX_FAIL_STREAK) {
        console.error(`[SaveQueue] дроп ${chunk.length}`);
        await bumpScanStats(chunkSessionId, { dropped: chunk.length + droppedInQueue });
        saveQueueFailStreak = 0;
      } else {
        saveQueue = chunk.concat(saveQueue);
        persistSaveQueueDebounced();
      }
      return;
    }
    await bumpScanStats(chunkSessionId, {
      added: stats.added,
      updated: stats.updated,
      dropped: stats.dropped + droppedInQueue,
    });
  } finally {
    if (saveQueue.length && saveCancelCache !== true) scheduleSaveQueueFlush();
  }
}

function flushSaveQueue() {
  if (currentSaveFlushPromise) return currentSaveFlushPromise;
  if (!saveQueue.length) return Promise.resolve();
  currentSaveFlushPromise = doFlushSaveQueue().finally(() => {
    currentSaveFlushPromise = null;
  });
  return currentSaveFlushPromise;
}

async function queueProductsForSave(products) {
  await waitSaveCancelLoaded();
  if (saveCancelCache) return;
  if (!products?.length) return;
  for (const p of products) saveQueue.push(p);
  if (saveQueue.length > SAVE_QUEUE_HARD_CAP) {
    const drop = saveQueue.length - SAVE_QUEUE_HARD_CAP;
    saveQueueDropped += drop;
    console.warn(`[SaveQueue] overflow, drop ${drop}`);
    saveQueue = saveQueue.slice(drop);
  }
  persistSaveQueueDebounced();
  scheduleSaveQueueFlush();
}

async function startScanSession() {
  const cur = await chrome.storage.local.get({ scanSaveStats: null });
  if (cur.scanSaveStats && cur.scanSaveStats.active) {
    const startedAt = Number(cur.scanSaveStats.startedAt) || 0;
    if (startedAt > 0 && Date.now() - startedAt < STALE_SCAN_TTL_MS) return { active: true };
  }
  try { await flushSaveQueue(); } catch (e) { console.error("[startScan] flush queue:", e); }
  await flushPendingQuiet();
  saveQueue = []; saveQueueFailStreak = 0; saveQueueDropped = 0;
  if (saveQueueTimer) { clearTimeout(saveQueueTimer); saveQueueTimer = null; }
  saveCancelCache = false;
  saveCancelLoaded = true;
  await sessionRemove("saveQueue");
  await sessionSet({ scanSessionActive: true });
  await sessionSet({ lastScanFound: 0 });
  const sessionId = crypto.randomUUID();
  currentSessionId = sessionId;
  await setData({
    saveCancelRequested: false,
    scanCancelRequested: false,
    scanSaveStats: { added: 0, updated: 0, dropped: 0, active: true, startedAt: Date.now(), sessionId },
  });
  return { sessionId };
}

async function endScanSession() {
  if (endScanInProgress) return { added: 0, updated: 0, dropped: 0 };
  endScanInProgress = true;
  try {
    if (saveQueueTimer) { clearTimeout(saveQueueTimer); saveQueueTimer = null; }
    if (currentSaveFlushPromise) { try { await currentSaveFlushPromise; } catch {} }
    for (let w = 0; w < 5 && saveQueue.length; w++) {
      try { await flushSaveQueue(); } catch (e) { console.error("[endScan] flush:", e); }
    }
    if (!saveQueue.length) await sessionRemove("saveQueue");
    await flushPendingQuiet();
    await sessionRemove("scanSessionActive");
    const r = await chrome.storage.local.get({ scanSaveStats: null, scanCancelRequested: false });
    const ss = r.scanSaveStats || { added: 0, updated: 0, dropped: 0, active: false, startedAt: 0 };
    ss.active = false;
    ss.finishedAt = Date.now();
    const wasCancelled = !!r.scanCancelRequested;

    const sess = await sessionGet({ lastScanFound: 0 });
    let found = Number(sess.lastScanFound) || 0;
    try {
      const spR = await chrome.storage.local.get({ scanProgress: null });
      if (spR.scanProgress && typeof spR.scanProgress.count === "number") {
        found = Math.max(found, Number(spR.scanProgress.count) || 0);
      }
    } catch {}
    const added = Number(ss.added) || 0;
    const updated = Number(ss.updated) || 0;
    const dropped = Number(ss.dropped) || 0;
    const skipped = Math.max(0, found - added - updated - dropped);

    const patch = { scanSaveStats: ss };
    if (found > 0 || added > 0 || updated > 0) {
      patch.lastScanResult = {
        at: Date.now(),
        startedAt: Number(ss.startedAt) || 0,
        finishedAt: Date.now(),
        found, added, updated, dropped, skipped,
        cancelled: wasCancelled,
      };
    }
    await setData(patch);
    await sessionRemove("lastScanFound");
    currentSessionId = null;

    return { added, updated, dropped };
  } finally {
    endScanInProgress = false;
  }
}

let keepAliveRefs = 0;
let keepAliveInterval = null;

function acquireKeepAlive() {
  keepAliveRefs++;
  if (keepAliveRefs === 1 && !keepAliveInterval) {
    keepAliveInterval = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  }
}
function releaseKeepAlive() {
  keepAliveRefs = Math.max(0, keepAliveRefs - 1);
  if (keepAliveRefs === 0 && keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

let storageChain = Promise.resolve();
function withStorageLock(fn) {
  const result = storageChain.then(fn, fn);
  storageChain = result.catch(() => {});
  return result;
}

async function resetStaleProgress() {
  const r = await chrome.storage.local.get({ checkProgress: null });
  if (!r.checkProgress || !r.checkProgress.running) return;
  const cp = r.checkProgress;
  await setData({
    checkProgress: {
      running: false, done: cp.done || 0, total: cp.total || 0,
      ok: cp.ok || 0, fail: cp.fail || 0, stopped: true, shown: true,
      startedAt: cp.startedAt || Date.now(), finishedAt: Date.now(), elapsedSec: 0,
    },
  });
}

async function resetStaleScanState() {
  try {
    const r = await chrome.storage.local.get({ scanSaveStats: null, scanProgress: null });
    let ss = r.scanSaveStats;
    let sp = r.scanProgress;
    let changed = false;
    if (ss && ss.active) {
      const startedAt = Number(ss.startedAt) || 0;
      if (!startedAt || Date.now() - startedAt > STALE_SCAN_TTL_MS) {
        ss.active = false;
        ss.finishedAt = Date.now();
        changed = true;
      }
    }
    if (sp && sp.active) {
      const spStartedAt = Number(sp.startedAt) || 0;
      if (!spStartedAt || Date.now() - spStartedAt > STALE_SCAN_TTL_MS) {
        sp = null;
        changed = true;
      }
    }
    if (changed) {
      await setData({ scanSaveStats: ss, scanProgress: sp });
      await sessionRemove("scanSessionActive");
    }
  } catch (e) { console.error("[resetStaleScanState]", e); }
}

async function recoverStaleTabPool() {
  try {
    const r = await sessionGet({ tabPoolIds: [] });
    const ids = r.tabPoolIds || [];
    if (!Array.isArray(ids) || !ids.length) return;
    await closeTabs(ids);
    await sessionRemove("tabPoolIds");
  } catch (e) { console.error("[TabPool] recover:", e); }
}

async function recoverSaveQueue() {
  try {
    const r = await sessionGet({ saveQueue: [] });
    const q = r.saveQueue || [];
    if (Array.isArray(q) && q.length) {
      saveQueue = q.concat(saveQueue);
      await sessionRemove("saveQueue");
      scheduleSaveQueueFlush();
    }
  } catch (e) { console.error("[SaveQueue] recover:", e); }
}

const bootCleanupPromise = (async () => {
  await resetStaleProgress();
  await resetStaleScanState();
  await cleanupDeletedHistory();
  await recoverStaleTabPool();
  await recoverSaveQueue();
  await recoverPendingWrites();
  await maybeRecoverConcurrency();
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "checkPrices") return;
  bootCleanupPromise.then(() => checkAllPrices(null, { isManual: false })).catch((e) => console.error(e));
});

async function ensureAlarm(force) {
  const settings = await getSettings();
  const mins = clampInterval(settings.defaultIntervalMin);
  if (!force) {
    const existing = await chrome.alarms.get("checkPrices");
    if (existing && Math.abs((existing.periodInMinutes || 0) - mins) < 0.001) return;
  }
  await chrome.alarms.clear("checkPrices");
  chrome.alarms.create("checkPrices", { periodInMinutes: mins, delayInMinutes: mins });
}

chrome.runtime.onInstalled.addListener(() => {
  resetStaleProgress().catch(() => {}).then(() => ensureAlarm(false)).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm(false).catch(() => {});
});

async function getDataForPopup() {
  const meta = await chrome.storage.local.get({
    settings: {}, checkProgress: null,
    scanSaveStats: null, scanProgress: null, lastScanResult: null,
  });
  meta.products = await readAllProducts();
  return meta;
}

const notifTargets = new Map();

function notifyDesiredPriceReached(product, newPrice, desiredPrice) {
  try {
    const name = product.name || "Товар";
    const title = "🎯 Цена достигла желаемой!";
    const message = `${name}\nСейчас: ${newPrice.toFixed(2)} Br\nЦель: ${desiredPrice.toFixed(2)} Br`;
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    }).then((notifId) => {
      if (notifId && product.url) notifTargets.set(notifId, product.url);
    }).catch(() => {});
  } catch (e) {
    console.error("[Notify]", e);
  }
}

chrome.notifications.onClicked.addListener((notifId) => {
  const url = notifTargets.get(notifId);
  if (url) {
    try { chrome.tabs.create({ url }).catch(() => {}); } catch {}
    notifTargets.delete(notifId);
    try { chrome.notifications.clear(notifId).catch(() => {}); } catch {}
  }
});

chrome.notifications.onClosed.addListener((notifId) => {
  notifTargets.delete(notifId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      await bootCleanupPromise;

      if (MUTATING_ACTIONS.has(msg.action) && !isFromExtensionUI(sender)) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }

      switch (msg.action) {
        case "priceFound": {
          const senderTabId = sender?.tab?.id;
          if (senderTabId && activeTabIds.has(senderTabId)) { sendResponse({ ok: true, skipped: true }); return; }
          if (isChecking) { sendResponse({ ok: true, skipped: true }); return; }
          await handlePriceFound(msg);
          sendResponse({ ok: true });
          break;
        }
        case "saveFromPage":
          await saveProductFromPage(msg);
          sendResponse({ ok: true });
          break;
        case "saveManyFromPage": {
          await resetSaveCancel();
          const res = await saveManyFromPage(msg.products || []);
          sendResponse({ ok: true, count: res });
          break;
        }
        case "startScanSession": {
          const sid = await startScanSession();
          if (sid?.active) sendResponse({ ok: true, started: false, reason: "already running" });
          else sendResponse({ ok: true, sessionId: sid?.sessionId });
          break;
        }
        case "queueProductsForSave":
          await queueProductsForSave(msg.products || []);
          sendResponse({ ok: true, queued: (msg.products || []).length });
          break;
        case "endScanSession": {
          const sres = await endScanSession();
          sendResponse({ ok: true, added: sres.added, updated: sres.updated, dropped: sres.dropped });
          break;
        }
        case "checkNow": {
          if (isChecking || runtimeBusy) { sendResponse({ ok: true, started: false, reason: "busy" }); return; }
          checkAllPrices(null, { isManual: true }).catch((e) => console.error(e));
          sendResponse({ ok: true, started: true });
          break;
        }
        case "checkFailedOnly": {
          if (isChecking || runtimeBusy) { sendResponse({ ok: true, started: false, reason: "busy" }); return; }
          checkAllPrices((p) => Number(p.failCount) > 0, { isManual: true }).catch((e) => console.error(e));
          sendResponse({ ok: true, started: true });
          break;
        }
        case "stopCheck": {
          if (isChecking || runtimeBusy) {
            await haltCurrentCheck();
            const cur = await chrome.storage.local.get({ checkProgress: {} });
            const cp = cur.checkProgress || {};
            const startedAt = cp.startedAt || Date.now();
            const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
            await setData({
              checkProgress: { ...cp,
                running: false, stopped: true, stoppedReason: "user", shown: false,
                finishedAt: Date.now(), elapsedSec,
              },
            });
            await flushPendingQuiet();
          } else {
            await resetStaleProgress();
          }
          sendResponse({ ok: true });
          break;
        }
        case "checkOne": {
          if (isChecking || runtimeBusy) { sendResponse({ ok: true, result: { ok: false, reason: "busy" } }); return; }
          const targetUrl = msg.url;
          if (!targetUrl || !sanitizeUrl(targetUrl)) {
            sendResponse({ ok: true, result: { ok: false, reason: "bad-url" } });
            return;
          }
          runtimeBusy = true;
          try {
            const targetId = await getIdByUrl(targetUrl);
            if (!targetId) { sendResponse({ ok: true, result: { ok: false, reason: "not-tracked" } }); return; }
            const productArg = { id: targetId, url: targetUrl };
            const cr = await checkOneProductFast(productArg);
            if (cr && !cr.ok && cr.reason && cr.reason !== "stopped") {
              try { await markProductFailed(targetUrl, cr.reason); } catch {}
            }
            await flushPendingQuiet();
            sendResponse({ ok: true, result: cr });
          } finally {
            runtimeBusy = false;
          }
          break;
        }
        case "toggleFavorite":
          await toggleFavorite(msg.id);
          await flushPendingQuiet();
          sendResponse({ ok: true });
          break;
        case "setDesiredPrice":
          await setDesiredPrice(msg.id, msg.desiredPrice);
          await flushPendingQuiet();
          sendResponse({ ok: true });
          break;
        case "resetAllDesiredPrices": {
          const n = await resetAllDesiredPrices(msg.onlyFavorites !== false);
          await flushPendingQuiet();
          sendResponse({ ok: true, reset: n });
          break;
        }
        case "removeProduct":
          await removeManyProducts([msg.url]);
          sendResponse({ ok: true });
          break;
        case "removeManyProducts": {
          const removed = await removeManyProducts(msg.urls || []);
          sendResponse({ ok: true, removed });
          break;
        }
        case "clearAll":
          clearAllProducts().catch((e) => console.error("[clearAll]", e));
          sendResponse({ ok: true, started: true });
          break;
        case "clearFailed":
          await clearFailed();
          sendResponse({ ok: true });
          break;
        case "clearHistory":
          await clearHistory(msg.id);
          sendResponse({ ok: true });
          break;
        case "clearFailedGone":
          await clearFailedGone();
          sendResponse({ ok: true });
          break;
        case "resetCaptchaFailed": {
          const n = await resetCaptchaFailed();
          sendResponse({ ok: true, reset: n });
          break;
        }
        case "getArchive": {
          const arch = await getAllArchive();
          sendResponse({ ok: true, items: arch });
          break;
        }
        case "removeFromArchive": {
          const cnt = await removeKeysBatched(msg.keys || []);
          sendResponse({ ok: true, removed: cnt });
          break;
        }
        case "getData": {
          const d = await getDataForPopup();
          sendResponse(d);
          break;
        }
        case "getProduct": {
          const p = await readProductById(msg.id, true);
          sendResponse({ product: p || null });
          break;
        }
        case "getSettings": {
          const sdata0 = await getSettings();
          sendResponse({ ok: true, settings: sdata0 });
          break;
        }
        case "setSettings": {
          const incoming = msg.settings || {};
          if (incoming.concurrency !== undefined) {
            incoming.concurrency = clampConc(Number(incoming.concurrency));
            incoming.concurrencyTarget = incoming.concurrency;
          }
          if (incoming.defaultIntervalMin !== undefined) {
            incoming.defaultIntervalMin = clampInterval(incoming.defaultIntervalMin);
          }
          await patchSettings(incoming);
          await ensureAlarm(false);
          sendResponse({ ok: true });
          break;
        }
        case "markProgressShown": {
          const pr = await chrome.storage.local.get({ checkProgress: null });
          if (pr.checkProgress) {
            pr.checkProgress.shown = true;
            await setData({ checkProgress: pr.checkProgress });
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown action" });
      }
    } catch (e) {
      console.error("Message handler error:", e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

async function clearAllProducts() {
  if (isChecking || runtimeBusy) {
    await haltCurrentCheck();
    let w = 0;
    while ((isChecking || runtimeBusy) && w < 100) { await sleep(100); w++; }
    isChecking = false;
    runtimeBusy = false;
    stopRequested = false;
  }
  await flushPendingQuiet();

  pendingWrites.clear();
  saveQueue = []; saveQueueFailStreak = 0; saveQueueDropped = 0;
  if (saveQueueTimer) { clearTimeout(saveQueueTimer); saveQueueTimer = null; }

  try { await sessionRemove(["saveQueue", "tabPoolIds", "pendingWritesSnapshot", "scanSessionActive"]); } catch {}

  await withStorageLock(async () => {
    const products = await readAllProducts(true);
    await archiveAndRemove(products, (patch) => {
      Object.assign(patch, {
        product_ids: [],
        product_url_to_id: {},
        checkProgress: null,
        next_id: 1,
      });
    });
  });
}

async function clearFailed() {
  return clearFailedByPredicate((p) => Number(p.failCount) > 0);
}
async function clearFailedGone() {
  return clearFailedByPredicate((p) => Number(p.failCount) > 0 && p.lastCheckError === "gone");
}

async function clearFailedByPredicate(predicate) {
  await flushPendingQuiet();
  await withStorageLock(async () => {
    const products = await readAllProducts(true);
    const toArchive = [];
    const keptIds = [];
    const urlToId = {};
    for (const p of products) {
      if (predicate(p)) {
        toArchive.push(p);
      } else {
        keptIds.push(p.id);
        urlToId[normalizeUrl(p.url)] = p.id;
      }
    }
    await archiveAndRemove(toArchive, (patch) => {
      Object.assign(patch, { product_ids: keptIds, product_url_to_id: urlToId });
    });
  });
}

async function resetCaptchaFailed() {
  await flushPendingQuiet();
  let count = 0;
  await withStorageLock(async () => {
    const products = await readAllProducts(false);
    const toWrite = {};
    for (const p of products) {
      if (Number(p.failCount) > 0 && p.lastCheckError === "captcha") {
        clearFailState(p);
        count++;
        toWrite[`p_${p.id}`] = p;
      }
    }
    if (count > 0) await setData(toWrite);
  });
  return count;
}

async function clearHistory(id) {
  await flushPendingQuiet();
  await withStorageLock(async () => {
    const pKey = `p_${id}`;
    const hKey = `h_${id}`;
    const p = await readProductById(id, false);
    if (!p) return;
    const cur = p.currentPrice;
    const now = new Date().toISOString();
    let history;
    if (cur === undefined || cur === null || !Number.isFinite(cur) || cur <= 0) {
      history = [];
      delete p.minPrice; delete p.minPriceDate;
      delete p.maxPrice; delete p.maxPriceDate;
    } else {
      history = [{ price: cur, date: now }];
      p.minPrice = cur; p.minPriceDate = now;
      p.maxPrice = cur; p.maxPriceDate = now;
    }
    delete p.ratingDelta; delete p.ratingDeltaAt;
    delete p.reviewsDelta; delete p.reviewsDeltaAt;
    delete p.questionsDelta; delete p.questionsDeltaAt;
    delete p.mediaDelta; delete p.mediaDeltaAt;
    syncLastPrices(p, history);
    const patch = {};
    patch[pKey] = p;
    patch[hKey] = history;
    await setData(patch);
    pendingWrites.delete(id);
  });
}

async function removeManyProducts(urls) {
  if (!urls?.length) return 0;
  await flushPendingQuiet();
  let removed = 0;
  await withStorageLock(async () => {
    const meta = await chrome.storage.local.get({ product_url_to_id: {}, product_ids: [] });
    const urlToId = { ...meta.product_url_to_id };
    const productIds = meta.product_ids.slice();
    const ids = [];
    const cleanUrls = [];
    const seenIds = new Set();
    for (const u of urls) {
      const cleanUrl = normalizeUrl(u);
      const id = urlToId[cleanUrl];
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push(id); cleanUrls.push(cleanUrl);
    }
    const products = await readProductsGeneric(ids, true);
    const byId = {};
    for (const pr of products) byId[pr.id] = pr;
    const toArchive = [];
    for (let j = 0; j < ids.length; j++) {
      const pid = ids[j];
      const curl = cleanUrls[j];
      const p = byId[pid];
      delete urlToId[curl];
      if (!p) continue;
      toArchive.push(p);
      removed++;
    }
    const removedIds = new Set(ids);
    const newIds = productIds.filter((id) => !removedIds.has(id));
    await archiveAndRemove(toArchive, (patch) => {
      Object.assign(patch, { product_ids: newIds, product_url_to_id: urlToId });
    });
  });
  return removed;
}

function computeSuspicious(p, newPrice) {
  const oldPrice = Number(p.currentPrice) || 0;
  if (!(oldPrice > 0 && newPrice > 0)) return { suspicious: false, confirmed: false };

  const isDrop = newPrice < oldPrice * SUSPICIOUS_PRICE_RATIO;
  const isSpike = newPrice > oldPrice * SUSPICIOUS_SPIKE_RATIO;
  if (!isDrop && !isSpike) return { suspicious: false, confirmed: false };

  const lastSusp = Number(p.lastSuspiciousPrice);
  const lastSuspAt = p.lastSuspiciousAt ? new Date(p.lastSuspiciousAt).getTime() : 0;
  const freshSusp = Number.isFinite(lastSuspAt) && lastSuspAt > 0 && Date.now() - lastSuspAt < SUSPICIOUS_TTL_MS;
  if (freshSusp && Number.isFinite(lastSusp) && lastSusp > 0) {
    if (Math.abs(newPrice - lastSusp) / lastSusp < SUSPICIOUS_CONFIRM_TOLERANCE) {
      return { suspicious: false, confirmed: true };
    }
  }
  return { suspicious: true, confirmed: false };
}

async function handlePriceFound(msg) {
  const id = await getIdByUrl(msg.url);
  if (!id) return;
  await updateProductPrice(id, msg, { viaAutoReport: true });
}

async function saveProductFromPage(msg) {
  const r = await chrome.storage.local.get({ scanSaveStats: null });
  const ss = r.scanSaveStats;
  if (!(ss && ss.active)) await resetSaveCancel();
  return saveManyFromPage([msg], { fromPdp: true });
}

async function saveManyFromPage(list, opts = {}) {
  const fromPdp = !!opts.fromPdp;
  await flushPendingQuiet();
  const stats = { added: 0, updated: 0, dropped: 0 };
  const touchedIds = [];

  await withStorageLock(async () => {
    const meta = await chrome.storage.local.get({
      product_ids: [],
      product_url_to_id: {},
      next_id: 0,
    });
    let productIds = meta.product_ids.slice();
    const urlToId = { ...meta.product_url_to_id };
    let nextId = Number(meta.next_id) || 0;
    if (!nextId) {
      for (const id of productIds) if (id > nextId) nextId = id;
      nextId += 1;
    }
    const now = new Date().toISOString();
    const seenInBatch = new Set();
    const existingIds = [];
    const existingMap = {};
    const potentialNewUrls = [];

    for (let k = 0; k < list.length; k++) {
      const item = list[k];
      if (!item?.url || !item.price) continue;
      const cleanUrl = normalizeUrl(item.url);
      const id = urlToId[cleanUrl];
      if (id) { existingMap[k] = id; existingIds.push(id); }
      else if (!seenInBatch.has(cleanUrl)) potentialNewUrls.push(cleanUrl);
      seenInBatch.add(cleanUrl);
    }

    const archiveData = {};
    if (potentialNewUrls.length) {
      const archKeys = potentialNewUrls.map(archiveKey);
      const archChunk = await getBatched(archKeys);
      for (const ak of archKeys) {
        if (archChunk[ak]) archiveData[ak.substring(3)] = archChunk[ak];
      }
    }

    const { products: existingProducts, histories: existingHistory } =
      await readProductsWithHistory(existingIds);

    const desyncedIds = [];
    for (const exId of existingIds) {
      if (!existingProducts[exId]) desyncedIds.push(exId);
    }
    if (desyncedIds.length) {
      const desyncSet = new Set(desyncedIds);
      productIds = productIds.filter((pid) => !desyncSet.has(pid));
      Object.keys(urlToId).forEach((k3) => {
        if (desyncSet.has(urlToId[k3])) delete urlToId[k3];
      });
      for (const badId of desyncedIds) {
        for (let mi = 0; mi < list.length; mi++) {
          if (existingMap[mi] === badId) delete existingMap[mi];
        }
      }
      for (const it2 of list) {
        if (!it2?.url || !it2.price) continue;
        const cu = normalizeUrl(it2.url);
        if (urlToId[cu]) continue;
        if (potentialNewUrls.includes(cu)) continue;
        potentialNewUrls.push(cu);
        if (!archiveData[cu]) {
          try {
            const akey = archiveKey(cu);
            const achunk = await chrome.storage.local.get([akey]);
            if (achunk[akey]) archiveData[cu] = achunk[akey];
          } catch {}
        }
      }
    }

    const toWrite = {};
    const newIds = [];
    const dhKeysToDelete = [];
    const seenInBatch2 = new Set();

    for (let m = 0; m < list.length; m++) {
      if (saveCancelCache) {
        for (let mm = m; mm < list.length; mm++) {
          const it = list[mm];
          if (it?.url && it.price) stats.dropped++;
        }
        break;
      }
      const item2 = list[m];
      if (!item2?.url || !item2.price) { stats.dropped++; continue; }
      const cleanUrl2 = normalizeUrl(item2.url);
      if (seenInBatch2.has(cleanUrl2)) continue;
      seenInBatch2.add(cleanUrl2);
      const existingId = existingMap[m];

      if (existingId && existingProducts[existingId]) {
        const p = existingProducts[existingId];
        const history = existingHistory[existingId];
        const applied = applyPageDataToProduct(p, item2, now, history);
        p.lastChecked = now;
        if (fromPdp || list.length === 1) p.lastSeenOnPdp = now;
        if (!applied.suspicious) clearFailState(p);
        stats.updated++;
        touchedIds.push(p.id);
        toWrite[`p_${p.id}`] = p;
        toWrite[`h_${p.id}`] = history;
      } else {
        const newId = nextId++;
        const product = {
          id: newId,
          url: cleanUrl2,
          name: item2.name || "Без названия",
          image: item2.image || "",
          currentPrice: item2.price,
          rating: item2.rating || 0,
          reviews: item2.reviews || 0,
          questions: (typeof item2.questions === "number" ? item2.questions : 0) || 0,
          mediaCount: (typeof item2.mediaCount === "number" ? item2.mediaCount : 0) || 0,
          favorite: false,
          lastChecked: now,
          addedAt: now,
          failCount: 0,
        };
        if (fromPdp || list.length === 1) product.lastSeenOnPdp = now;
        let newHistory = [];
        const archived = archiveData[cleanUrl2];
        if (archived) {
          applyArchivedEntry(product, archived);
          if (Array.isArray(archived.history) && archived.history.length) newHistory = archived.history.slice();
          dhKeysToDelete.push(archiveKey(cleanUrl2));
        }
        pushHistoryFull(product, newHistory, item2.price, now);
        if (product.minPrice === undefined || item2.price < product.minPrice) {
          product.minPrice = item2.price;
          product.minPriceDate = now;
        }
        if (product.maxPrice === undefined || item2.price > product.maxPrice) {
          product.maxPrice = item2.price;
          product.maxPriceDate = now;
        }
        syncLastPrices(product, newHistory);
        productIds.push(newId);
        urlToId[cleanUrl2] = newId;
        newIds.push(newId);
        stats.added++;
        touchedIds.push(newId);
        toWrite[`p_${newId}`] = product;
        toWrite[`h_${newId}`] = newHistory;
      }
    }

    if (newIds.length > 0) {
      toWrite.product_ids = productIds;
      toWrite.product_url_to_id = urlToId;
    }
    toWrite.next_id = nextId;

    await setData(toWrite);

    if (dhKeysToDelete.length) await removeKeysBatched(dhKeysToDelete);

    for (const t of touchedIds) pendingWrites.delete(t);
  });

  return stats;
}

function applyPageDataToProduct(p, msg, now, history) {
  let changed = false;
  const newPrice = Number(msg.price);
  const susp = computeSuspicious(p, newPrice);

  if (!susp.suspicious && Number.isFinite(newPrice) && newPrice > 0) {
    const desired = Number(p.desiredPrice) || 0;
    if (p.favorite && desired > 0) {
      if (newPrice > desired) {
        if (p.desiredNotifiedAt) p.desiredNotifiedAt = null;
      } else if (newPrice <= desired && !p.desiredNotifiedAt) {
        notifyDesiredPriceReached(p, newPrice, desired);
        p.desiredNotifiedAt = now;
      }
    }

    if (p.currentPrice !== newPrice) changed = true;
    p.currentPrice = newPrice;
    pushHistoryFull(p, history, newPrice, now);
    if (p.minPrice === undefined || newPrice < p.minPrice) {
      p.minPrice = newPrice; p.minPriceDate = now; changed = true;
    }
    if (p.maxPrice === undefined || newPrice > p.maxPrice) {
      p.maxPrice = newPrice; p.maxPriceDate = now; changed = true;
    }
    if (susp.confirmed || p.lastSuspiciousPrice != null) {
      p.lastSuspiciousPrice = null;
      p.lastSuspiciousAt = null;
    }
  } else if (susp.suspicious) {
    p.lastSuspiciousPrice = newPrice;
    p.lastSuspiciousAt = now;
  }

  if (msg.name && msg.name !== p.name) { p.name = msg.name; changed = true; }
  if (msg.image && msg.image !== p.image) { p.image = msg.image; changed = true; }

  if (typeof msg.rating === "number" && Number.isFinite(msg.rating)) {
    const oldRating = Number(p.rating) || 0;
    if (Math.abs(msg.rating - oldRating) > 0.01) {
      if (oldRating > 0) { p.ratingDelta = Number((msg.rating - oldRating).toFixed(2)); p.ratingDeltaAt = now; }
      p.rating = msg.rating; changed = true;
    }
  }
  if (typeof msg.reviews === "number" && Number.isFinite(msg.reviews)) {
    const oldRev = Number(p.reviews) || 0;
    if (msg.reviews !== oldRev) {
      if (oldRev > 0) { p.reviewsDelta = msg.reviews - oldRev; p.reviewsDeltaAt = now; }
      p.reviews = msg.reviews; changed = true;
    }
  }
  if (typeof msg.questions === "number" && Number.isFinite(msg.questions)) {
    const oldQ = Number(p.questions) || 0;
    if (msg.questions !== oldQ) {
      if (oldQ > 0) { p.questionsDelta = msg.questions - oldQ; p.questionsDeltaAt = now; }
      p.questions = msg.questions; changed = true;
    }
  }
  if (typeof msg.mediaCount === "number" && Number.isFinite(msg.mediaCount)) {
    const oldM = Number(p.mediaCount) || 0;
    if (msg.mediaCount !== oldM) {
      if (oldM > 0) { p.mediaDelta = msg.mediaCount - oldM; p.mediaDeltaAt = now; }
      p.mediaCount = msg.mediaCount; changed = true;
    }
  }
  return { changed, suspicious: susp.suspicious };
}

async function mutateProduct(id, fn) {
  return withStorageLock(async () => {
    let p, history;
    const pend = cloneFromPending(id, true);
    if (pend) {
      const { history: h, ...prod } = pend;
      p = prod;
      history = h;
    } else {
      const pKey = `p_${id}`;
      const hKey = `h_${id}`;
      const r = await chrome.storage.local.get([pKey, hKey]);
      p = r[pKey];
      if (!p) return null;
      history = r[hKey] || [];
    }
    const result = await fn(p, history);
    pendingWrites.set(id, { product: p, history });
    schedulePendingFlush();
    return result;
  });
}

async function updateProductPrice(id, msg, options = {}) {
  const viaAutoReport = !!options.viaAutoReport;
  return mutateProduct(id, async (p, history) => {
    const now = new Date().toISOString();
    const res = applyPageDataToProduct(p, msg, now, history);

    if (viaAutoReport) {
      p.lastSeenOnPdp = now;
      if (!res.suspicious) clearFailState(p);
    } else {
      p.lastChecked = now;
      if (!res.suspicious) clearFailState(p);
    }
    return p;
  });
}

async function markProductFailed(url, reason) {
  if (reason === "stopped") return;
  await flushPendingQuiet();
  const id = await getIdByUrl(url);
  if (!id) return;
  await mutateProduct(id, async (p) => {
    const now = new Date().toISOString();
    p.failCount = (Number(p.failCount) || 0) + 1;
    p.lastCheckError = String(reason || "unknown");
    p.lastCheckFailedAt = now;
    p.lastChecked = now;
  });
}

async function toggleFavorite(id) {
  await flushPendingQuiet();
  await mutateProduct(id, async (p) => {
    p.favorite = !p.favorite;
  });
}

async function setDesiredPrice(id, desiredPrice) {
  await withStorageLock(async () => {
    const raw = Number(desiredPrice) || 0;
    const val = Math.max(0, Math.round(raw * 100) / 100);
    if (pendingWrites.has(id)) {
      const rec = pendingWrites.get(id);
      if (val > 0) rec.product.desiredPrice = val;
      else delete rec.product.desiredPrice;
      delete rec.product.desiredNotifiedAt;
      schedulePendingFlush();
      return;
    }
    const p = await readProductById(id, false);
    if (!p) return;
    if (val > 0) p.desiredPrice = val;
    else delete p.desiredPrice;
    delete p.desiredNotifiedAt;
    await setData({ [`p_${id}`]: p });
  });
}

async function resetAllDesiredPrices(onlyFavorites) {
  await flushPendingQuiet();
  let count = 0;
  await withStorageLock(async () => {
    const r = await chrome.storage.local.get({ product_ids: [] });
    const ids = r.product_ids || [];
    const patch = {};
    for (let i = 0; i < ids.length; i += READ_BATCH) {
      const slice = ids.slice(i, i + READ_BATCH);
      const keys = slice.map((id) => `p_${id}`);
      const chunk = await chrome.storage.local.get(keys);
      for (const id of slice) {
        const p = chunk[`p_${id}`];
        if (!p) continue;
        if (onlyFavorites && !p.favorite) continue;
        if (!(Number(p.desiredPrice) > 0)) continue;
        delete p.desiredPrice;
        delete p.desiredNotifiedAt;
        patch[`p_${id}`] = p;
        count++;
      }
    }
    if (count > 0) await setData(patch);
  });
  return count;
}

async function checkAllPrices(filterFn, options = {}) {
  const isManual = !!options.isManual;
  if (isChecking || runtimeBusy) return;
  isChecking = true;
  runtimeBusy = true;
  stopRequested = false;
  const myEpoch = ++currentCheckEpoch;
  acquireKeepAlive();
  const startTime = Date.now();
  let stopReason = null;
  const timeoutState = { streak: 0 };

  try {
    if (!isManual) { try { await ensureAlarm(true); } catch {} }
    try { await maybeRecoverConcurrency(); } catch {}
    let products = await readAllProducts();
    if (typeof filterFn === "function") products = products.filter(filterFn);

    if (!products.length) {
      await setData({
        checkProgress: {
          running: false, done: 0, total: 0, ok: 0, fail: 0,
          startedAt: startTime, finishedAt: Date.now(), elapsedSec: 0, stopped: false, shown: false,
        },
      });
      return;
    }
    const sdata = await getSettings();
    const concurrency = clampConc(Number(sdata.concurrency));
    await setData({
      checkProgress: {
        running: true, done: 0, total: products.length, ok: 0, fail: 0,
        startedAt: startTime, shown: false,
      },
    });

    let results = { ok: 0, fail: 0, done: 0, captcha: 0 };
    try {
      await initTabPool(concurrency, products.length);
      results = await runInBatches(products, concurrency, myEpoch, startTime, timeoutState);
    } catch (e) { console.error("[Check]", e); }
    try { await destroyTabPool(); } catch {}

    if (timeoutState.streak >= TIMEOUT_STREAK_STOP) stopReason = "timeout_streak";
    if (stopRequested && !stopReason) stopReason = "user";

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (results.captcha >= CAPTCHA_REDUCE_MIN && results.done > 0 &&
        results.captcha / results.done > CAPTCHA_REDUCE_RATIO) {
      const newConc = clampConc(Math.max(MIN_CONCURRENCY, Math.floor(concurrency * 0.7)));
      if (newConc < concurrency) {
        try {
          const cur = await getSettings();
          await patchSettings({
            concurrency: newConc,
            concurrencyTarget: Number(cur.concurrencyTarget) || concurrency,
          });
          await setData({ concurrencyAutoReducedAt: Date.now() });
        } catch {}
      }
    }

    if (myEpoch === currentCheckEpoch) {
      try {
        await setData({
          checkProgress: {
            running: false, done: results.done, total: products.length,
            ok: results.ok, fail: results.fail,
            stopped: !!stopRequested, stoppedReason: stopReason,
            startedAt: startTime, finishedAt: Date.now(),
            elapsedSec: Number(elapsed), shown: false,
          },
        });
      } catch {}
    }
  } finally {
    isChecking = false;
    runtimeBusy = false;
    stopRequested = false;
    if (myEpoch === currentCheckEpoch) currentCheckEpoch++;
    await flushPendingQuiet();
    releaseKeepAlive();
  }
}

async function runInBatches(products, concurrency, myEpoch, startedAt, timeoutState) {
  const queue = products.slice();
  const results = { ok: 0, fail: 0, done: 0, captcha: 0 };
  let activeCount = 0;
  const total = products.length;
  let resolved = false;
  let lastProgressFlush = 0;
  let progressFlushPending = false;
  let progressFlushTimer = null;

  const { promise, resolve } = Promise.withResolvers();

  function flushProgress() {
    progressFlushPending = false;
    lastProgressFlush = Date.now();
    if (myEpoch !== currentCheckEpoch) return;
    chrome.storage.local.set({
      checkProgress: {
        running: true, done: results.done, total,
        ok: results.ok, fail: results.fail, shown: false, startedAt,
      },
    }).catch(() => {});
  }
  function scheduleProgress() {
    if (progressFlushPending) return;
    const now = Date.now();
    const sinceLast = now - lastProgressFlush;
    if (sinceLast >= 200) { flushProgress(); return; }
    progressFlushPending = true;
    if (progressFlushTimer) clearTimeout(progressFlushTimer);
    progressFlushTimer = setTimeout(() => {
      progressFlushTimer = null;
      if (progressFlushPending) flushProgress();
    }, 200 - sinceLast);
  }
  function finalize() {
    if (resolved) return;
    resolved = true;
    if (progressFlushTimer) { clearTimeout(progressFlushTimer); progressFlushTimer = null; }
    resolve(results);
  }
  function launchOne() {
    if (queue.length === 0) return;
    if (stopRequested) return;
    const product = queue.shift();
    activeCount++;
    checkWithRetry(product, 2)
      .then((res) => {
        if (res?.ok) { results.ok++; timeoutState.streak = 0; }
        else {
          const r = res?.reason || "unknown";
          if (r !== "stopped") {
            results.fail++;
            if (r === "captcha") results.captcha++;
            if (r === "timeout") {
              timeoutState.streak++;
              if (timeoutState.streak >= TIMEOUT_STREAK_STOP) stopRequested = true;
            } else {
              timeoutState.streak = 0;
            }
          }
        }
      })
      .catch((e) => { console.error("[Check] item:", e); results.fail++; })
      .finally(() => { activeCount--; results.done++; scheduleProgress(); });
  }
  async function scheduler() {
    try {
      const initialFill = Math.min(concurrency, queue.length);
      for (let i = 0; i < initialFill; i++) {
        if (stopRequested) break;
        launchOne();
        await sleep(50);
      }
      while (true) {
        if (stopRequested && activeCount === 0) break;
        if (!stopRequested && queue.length === 0 && activeCount === 0) break;
        if (!stopRequested && queue.length > 0 && activeCount < concurrency) { launchOne(); await sleep(50); continue; }
        await sleep(50);
      }
    } catch {}
    finalize();
  }

  if (!products.length) finalize();
  else scheduler();
  return promise;
}

async function checkWithRetry(product, attempts) {
  let lastReason = "unknown";
  const TRANSIENT = new Set(["timeout", "nav-failed", "net-error", "unknown"]);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (stopRequested) return { ok: false, reason: "stopped" };
    const res = await checkOneProductFast(product, attempt > 1 ? { totalTimeout: 25000, pricePollTimeout: 12000 } : undefined);
    if (res?.ok) return res;
    lastReason = res?.reason || "unknown";
    if (!TRANSIENT.has(lastReason)) break;
    if (attempt < attempts) {
      const waitMs = 1000 + Math.random() * 1000;
      let waited = 0;
      while (waited < waitMs) {
        if (stopRequested) return { ok: false, reason: "stopped" };
        await sleep(200); waited += 200;
      }
    }
  }
  if (stopRequested) return { ok: false, reason: "stopped" };
  if (lastReason === "stopped") return { ok: false, reason: "stopped" };
  await markProductFailed(product.url, lastReason);
  return { ok: false, reason: lastReason };
}

let tabPool = [];
let tabWaiters = [];
let poolActive = false;

function wakeWaiter(tabId) {
  if (tabWaiters.length === 0) return false;
  const w = tabWaiters.shift();
  if (w.timer) clearTimeout(w.timer);
  w.resolve(tabId);
  return true;
}

async function initTabPool(size, productsCount) {
  await destroyTabPool();
  poolActive = true;
  if (productsCount && productsCount > 0) size = Math.min(size, productsCount);
  const batchSize = 3;
  for (let start = 0; start < size; start += batchSize) {
    const end = Math.min(start + batchSize, size);
    const batch = [];
    for (let i = start; i < end; i++) batch.push(createBlankTab());
    const ids = await Promise.all(batch);
    for (const id of ids) if (id) tabPool.push(id);
    if (end < size) await sleep(300);
  }
  try { await sessionSet({ tabPoolIds: tabPool.slice() }); } catch {}
}

async function destroyTabPool() {
  poolActive = false;
  const ids = tabPool.slice();
  tabPool = [];
  const waiters = tabWaiters.slice();
  tabWaiters = [];
  waiters.forEach((w) => { if (w.timer) clearTimeout(w.timer); w.resolve(null); });
  try { await sessionRemove("tabPoolIds"); } catch {}
  if (!ids.length) return;
  await closeTabs(ids);
}

function acquirePooledTab() {
  if (!poolActive) return Promise.resolve(null);
  if (tabPool.length > 0) return Promise.resolve(tabPool.shift());
  if (stopRequested) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers();
  const waiter = { resolve, timer: null };
  waiter.timer = setTimeout(() => {
    const idx = tabWaiters.indexOf(waiter);
    if (idx !== -1) tabWaiters.splice(idx, 1);
    resolve(null);
  }, TAB_WAITER_TIMEOUT_MS);
  tabWaiters.push(waiter);
  return promise;
}

function releasePooledTab(id) {
  if (!id) return;
  if (!poolActive || stopRequested) {
    closeTabsSilently([id]);
    wakeWaiter(null);
    return;
  }
  chrome.tabs.update(id, { url: "about:blank" }).then(() => {
    if (wakeWaiter(id)) return;
    tabPool.push(id);
  }).catch(() => {
    closeTabsSilently([id]);
    wakeWaiter(null);
  });
}

async function checkOneProductFast(product, opts = {}) {
  if (stopRequested) return { ok: false, reason: "stopped" };
  let url = typeof product === "string" ? product : product?.url;
  if (!url) return { ok: false, reason: "bad-url" };
  const productId = typeof product === "string" ? null : product.id;

  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return { ok: false, reason: "bad-url" };
  url = safeUrl;
  const expectedArticle = extractArticleFromUrl(url);
  const expectedNorm = normalizeUrl(url);

  let tabId = await acquirePooledTab();
  let ownedTab = false;
  if (!tabId) {
    if (stopRequested) return { ok: false, reason: "stopped" };
    tabId = await createBlankTab();
    if (!tabId) return { ok: false, reason: "no-tab" };
    ownedTab = true;
  }
  activeTabIds.add(tabId);

  const { promise, resolve } = Promise.withResolvers();
  let done = false;
  const totalTimeout = Number(opts.totalTimeout) || 45000;
  const initialDelay = 100;
  const pollInterval = 300;
  const pricePollTimeout = Number(opts.pricePollTimeout) || 25000;
  let firstPollAt = 0;
  let redirectCheckStart = 0;

  function cleanup() {
    activeTabIds.delete(tabId);
    if (ownedTab) closeTabsSilently([tabId]);
    else releasePooledTab(tabId);
  }
  function finish(res) {
    if (done) return;
    done = true;
    clearTimeout(totalWatchdog);
    clearInterval(stopWatchInterval);
    cleanup();
    resolve(res);
  }
  const totalWatchdog = setTimeout(() => { if (!done) finish({ ok: false, reason: "timeout" }); }, totalTimeout);
  const stopWatchInterval = setInterval(() => { if (stopRequested && !done) finish({ ok: false, reason: "stopped" }); }, 100);

  function responseMatchesUrl(response) {
    if (!response?.url) return true;
    const actualNorm = normalizeUrl(response.url);
    if (actualNorm === expectedNorm) return true;
    const actualArticle = extractArticleFromUrl(response.url);
    if (expectedArticle && actualArticle && expectedArticle === actualArticle) return true;
    return false;
  }

  async function poll() {
    if (done) return;
    if (stopRequested) { finish({ ok: false, reason: "stopped" }); return; }
    if (firstPollAt === 0) firstPollAt = Date.now();
    if (Date.now() - firstPollAt > pricePollTimeout) { finish({ ok: false, reason: "no-price" }); return; }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, { action: "getPrice" });
    } catch {
      if (done) return;
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        if (done) return;
        if (stopRequested) { finish({ ok: false, reason: "stopped" }); return; }
        setTimeout(poll, pollInterval);
        return;
      }
      if (done) return;
      if (tab?.url && tab.url.startsWith("chrome-error://")) { finish({ ok: false, reason: "net-error" }); return; }
      if (stopRequested) { finish({ ok: false, reason: "stopped" }); return; }
      setTimeout(poll, pollInterval);
      return;
    }

    if (done) return;
    if (!response) { setTimeout(poll, pollInterval); return; }

    if (response.captcha) { finish({ ok: false, reason: "captcha" }); return; }

    if (!responseMatchesUrl(response)) {
      if (redirectCheckStart === 0) redirectCheckStart = Date.now();
      if (Date.now() - redirectCheckStart < 3000) { setTimeout(poll, pollInterval); return; }
      finish({ ok: false, reason: "redirect" });
      return;
    }

    if (response.notDelivered) { finish({ ok: false, reason: "not_delivered" }); return; }
    if (response.gone) { finish({ ok: false, reason: "gone" }); return; }
    if (response.outOfStock) { finish({ ok: false, reason: "out_of_stock" }); return; }
    if (response.redirect) { finish({ ok: false, reason: "redirect" }); return; }

    if (response.price) {
      (async () => {
        try {
          if (productId) {
            await updateProductPrice(productId, response);
          } else {
            const cid = await getIdByUrl(url);
            if (cid) await updateProductPrice(cid, response);
          }
          finish({ ok: true });
        } catch (e) {
          finish({ ok: false, reason: String(e) });
        }
      })();
      return;
    }
    setTimeout(poll, pollInterval);
  }

  navigateTab(tabId, url).then((navRes) => {
    if (done) return;
    if (!navRes.ok) { finish({ ok: false, reason: navRes.reason }); return; }
    setTimeout(poll, initialDelay);
  });

  return promise;
}

ensureAlarm(false).catch(() => {});