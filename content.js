let __scanCancelCache = false;
let __scanCancelLoaded = false;

(async () => {
  try {
    const r = await chrome.storage.local.get({ scanCancelRequested: false });
    __scanCancelCache = !!r.scanCancelRequested;
    __scanCancelLoaded = true;
  } catch {}
})();

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.scanCancelRequested) {
      __scanCancelCache = !!changes.scanCancelRequested.newValue;
    }
  });
} catch {}

const isCancelRequested = async () => {
  if (__scanCancelLoaded) return __scanCancelCache;
  try {
    const r = await chrome.storage.local.get({ scanCancelRequested: false });
    __scanCancelCache = !!r.scanCancelRequested;
    __scanCancelLoaded = true;
  } catch {}
  return __scanCancelCache;
};

const SEL = {
  priceWidget: ['[data-widget="webPrice"]'],
  questionWidget: ['[data-widget="webQuestionCount"]'],
  outOfStockWidget: ['[data-widget="webOutOfStock"]'],
  errorWidget: ['[data-widget="error"]'],
  tileRoot: [
    ".tile-root",
    '[data-widget="tileGridDesktop"] .tile-root',
    '[data-widget="tileScrollDesktop"] .tile-root',
    '[data-widget="searchResultsV2"] .tile-root',
  ],
  tileLink: [
    'a[href*="/product/"]',
    'a.tile-clickable-element[href*="/product/"]',
    '[itemprop="url"]',
  ],
  tileName: [
    "span.tsBody500Medium",
    '[data-widget="webProductName"]',
    "a[title]",
    'span[class*="tsBody"]',
    '[itemprop="name"]',
  ],
  tileImage: [
    'img[src*="multimedia"]',
    'img[itemprop="image"]',
    "img.b95_4_3-a",
    "img",
  ],
  tileRating: [
    ".tsBodyControl300XSmall",
    '[data-widget="webReviewProductScore"]',
  ],
  mediaBadge: [
    '[data-widget="webListPhotos"]',
    '[data-widget="webGallery"] [class*="count"]',
    '[class*="rpProduct_"]',
    '[data-widget="webGalleryPreview"] [class*="count"]',
  ],
};

const queryAny = (root, selectors) => {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
};

const queryAllAny = (root, selectors) => {
  for (const sel of selectors) {
    const els = root.querySelectorAll(sel);
    if (els?.length) return els;
  }
  return [];
};

const PRICE_RE = /(\d[\d\u00a0\u2009\u202f ]*)(?:[.,](\d{1,2}))?\s*(?:₽|Br|BYN)(?![A-Za-z])/i;

const parsePriceText = (text) => {
  if (!text) return null;
  const m = String(text).match(PRICE_RE);
  if (!m) return null;
  const intPart = m[1].replaceAll(/[\s\u00a0\u2009\u202f]/g, "");
  let decPart = m[2] || "00";
  if (decPart.length === 1) decPart += "0";
  const val = parseFloat(`${intPart}.${decPart}`);
  return Number.isFinite(val) && val > 0 ? val : null;
};

const _strikeCache = new WeakMap();
const STRIKE_CACHE_TTL_MS = 5000;

const isStrikethrough = (el) => {
  if (!el) return false;
  const cached = _strikeCache.get(el);
  if (cached && Date.now() - cached.at < STRIKE_CACHE_TTL_MS) return cached.result;
  let node = el;
  let depth = 0;
  let result = false;
  while (node?.nodeType === 1 && depth < 6) {
    try {
      const style = window.getComputedStyle(node);
      if (style) {
        const dec = style.textDecoration || style.textDecorationLine || "";
        if (dec.includes("line-through")) { result = true; break; }
      }
    } catch {}
    node = node.parentElement;
    depth++;
    if (node?.tagName === "BODY") break;
  }
  _strikeCache.set(el, { at: Date.now(), result });
  return result;
};

const JUNK_PRICE_RE = /рассроч|озон.?карт|ozon.?карт|с\s+картой\s+ozon|промо|списани|списали|по\s+карте\s+ozon|\/\s*мес|в\s*месяц|подписк|оплата\s+частями|долями/i;

const pickPrice = (root) => {
  if (!root) return null;

  const bigSelectors = [".tsHeadline600Large", ".tsHeadline500Medium", '[class*="tsHeadline"]'];
  for (const sel of bigSelectors) {
    const bigEls = root.querySelectorAll(sel);
    for (const el of bigEls) {
      const bigTxt = (el.textContent || "").trim();
      if (!bigTxt || bigTxt.includes("×")) continue;
      if (JUNK_PRICE_RE.test(bigTxt)) continue;
      if (isStrikethrough(el)) continue;
      const vBig = parsePriceText(bigTxt);
      if (vBig) return vBig;
    }
  }

  const spans = root.querySelectorAll("span");
  const candidates = [];
  for (const span of spans) {
    const txt = (span.textContent || "").trim();
    if (txt.includes("×")) continue;
    if (JUNK_PRICE_RE.test(txt)) continue;
    const v = parsePriceText(txt);
    if (!v) continue;
    if (isStrikethrough(span)) continue;
    let ctx = txt;
    if (span.parentElement) ctx += ` ${span.parentElement.textContent}`;
    if (JUNK_PRICE_RE.test(ctx)) continue;
    candidates.push(v);
  }
  return candidates.length ? candidates[0] : null;
};

const extractPriceFromWidget = (widget) => pickPrice(widget);

let _ldJsonCache = { at: 0, items: null, href: "" };
const LDJSON_CACHE_TTL_MS = 500;

const ldJsonItems = () => {
  const now = Date.now();
  const href = location.href;
  if (_ldJsonCache.items && _ldJsonCache.href === href && now - _ldJsonCache.at < LDJSON_CACHE_TTL_MS) {
    return _ldJsonCache.items;
  }
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  const items = [];
  for (const s of scripts) {
    try {
      const data = JSON.parse(s.textContent);
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) items.push(item);
    } catch {}
  }
  _ldJsonCache = { at: now, items, href };
  return items;
};

const extractPrice = () => {
  const expectedArticle = extractArticleFromUrl(location.href);
  for (const item of ldJsonItems()) {
    if (!item?.offers) continue;
    if (item.sku && expectedArticle && String(item.sku) !== expectedArticle) continue;
    const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
    for (const off of offers) {
      if (!off) continue;
      if (off.price != null) {
        const p = parseLocalizedNumber(off.price);
        if (p > 0) return p;
      }
      if (off.lowPrice != null) {
        const lp = parseLocalizedNumber(off.lowPrice);
        if (lp > 0) return lp;
      }
      if (off.priceSpecification?.price != null) {
        const sp = parseLocalizedNumber(off.priceSpecification.price);
        if (sp > 0) return sp;
      }
    }
  }

  for (const sel of SEL.priceWidget) {
    const widgets = document.querySelectorAll(sel);
    for (const widget of widgets) {
      if (widget.closest(".tile-root")) continue;
      const wp = extractPriceFromWidget(widget);
      if (wp) return wp;
    }
  }

  const fbSelectors = ['[itemprop="price"]', 'meta[property="product:price:amount"]'];
  for (const sel of fbSelectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.closest(".tile-root")) continue;
      const raw = el.getAttribute?.("content") || el.textContent;
      const vv = parseLocalizedNumber(raw);
      if (Number.isFinite(vv) && vv > 0) return vv;
    }
  }

  return null;
};

const extractName = () => {
  const meta = document.querySelector('meta[property="og:title"]');
  if (meta?.content) return meta.content.trim();
  const h1 = document.querySelector("h1");
  if (h1) return h1.textContent.trim();
  return document.title;
};

const extractImage = () => {
  const meta = document.querySelector('meta[property="og:image"]');
  return meta?.content || "";
};

const extractRating = () => {
  for (const item of ldJsonItems()) {
    if (item?.aggregateRating) {
      const rv = parseLocalizedNumber(item.aggregateRating.ratingValue);
      const rc = parseLocalizedNumber(item.aggregateRating.reviewCount);
      return {
        rating: Number.isFinite(rv) ? rv : null,
        reviews: Number.isFinite(rc) ? rc : null,
      };
    }
  }
  return { rating: null, reviews: null };
};

const extractQuestions = () => {
  const els = queryAllAny(document, SEL.questionWidget);
  for (const el of els) {
    const t = (el.textContent || "").trim();
    let m = t.match(/(\d[\d\s\u00a0]*)\s+вопрос/i);
    if (m) return parseInt(m[1].replace(/[^\d]/g, ""), 10) || 0;
    m = t.match(/вопрос\w*\s*[:\-–(]?\s*(\d[\d\s\u00a0]*)/i);
    if (m) return parseInt(m[1].replace(/[^\d]/g, ""), 10) || 0;
  }
  return null;
};

const extractMediaCount = () => {
  for (const sel of SEL.mediaBadge) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const t = (el.textContent || "").trim();
      if (!t || t.length > 24) continue;
      const m = t.match(/\+?\s*(\d{1,5})/);
      if (m) return parseInt(m[1], 10) || 0;
    }
  }
  return null;
};

const PHRASE_GROUPS = [
  {
    key: "gone",
    phrases: [
      /^страница\s+не\s+найдена[\s.!]*$/i,
      /^страница\s+не\s+существует[\s.!]*$/i,
      /^такой\s+страницы\s+не\s+существует[\s.!]*$/i,
      /^такой\s+страницы\s+нет[\s.!]*$/i,
      /^товар\s+не\s+найден[\s.!]*$/i,
      /^товар\s+удал[её]н[\s.!]*$/i,
      /^снят[оы]?\s+с\s+продажи[\s.!]*$/i,
      /^404[\s.!]*$/i,
    ],
  },
  {
    key: "outOfStock",
    phrases: [
      /^товар\s+закончился[\s.!]*$/i,
      /^товара?\s+нет\s+в\s+наличии[\s.!]*$/i,
      /^нет\s+в\s+наличии[\s.!]*$/i,
    ],
  },
  {
    key: "notDelivered",
    phrases: [
      /^не\s+доставляется\s+в\s+ваш\s+регион[\s.!]*$/i,
      /^не\s+доставляется[\s.!]*$/i,
      /^товар\s+не\s+доставляется[\s.!]*$/i,
      /^доставка\s+в\s+ваш\s+регион\s+недоступна[\s.!]*$/i,
      /^нет\s+доставки\s+в\s+ваш\s+регион[\s.!]*$/i,
    ],
  },
];

const matchPhraseGroup = (group, text) => {
  if (!text) return false;
  let t = String(text).trim();
  t = t.replace(/\s*[-–—|·•]\s*Ozon.*$/i, "").trim();
  return group.phrases.some((re) => re.test(t));
};

const CAPTCHA_MARKERS = ["Подтвердите, что вы не робот", "Подтвердите что вы не робот"];
const _captchaCache = { at: 0, result: false };
const CAPTCHA_CACHE_TTL_MS = 2000;

const detectCaptchaUncached = () => {
  const title = document.title || "";
  for (const marker of CAPTCHA_MARKERS) {
    if (title.includes(marker)) return true;
  }
  const sels = ['h1', '[class*="captcha" i]', '[id*="captcha" i]', '[data-widget*="captcha" i]', 'iframe[src*="captcha" i]'];
  for (const sel of sels) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const t = (el.textContent || "").trim();
      for (const marker of CAPTCHA_MARKERS) {
        if (t.includes(marker)) return true;
      }
    }
  }
  try {
    let bodyText = document.body?.innerText || "";
    if (bodyText.length > 40000) bodyText = bodyText.substring(0, 40000);
    for (const marker of CAPTCHA_MARKERS) {
      if (bodyText.includes(marker)) return true;
    }
  } catch {}
  return false;
};

const detectCaptcha = () => {
  const now = Date.now();
  if (now - _captchaCache.at < CAPTCHA_CACHE_TTL_MS) return _captchaCache.result;
  const r = detectCaptchaUncached();
  _captchaCache.at = now;
  _captchaCache.result = r;
  return r;
};

const findPhraseInHeadings = (group) => {
  const heads = document.querySelectorAll("h1, h2, .tsHeadline500Medium, .pdp_db1, .pdp_d1b");
  for (const h of heads) {
    const t = (h.textContent || "").trim();
    if (matchPhraseGroup(group, t)) return true;
  }
  return false;
};

const detectPageState = () => {
  const href = location.href;
  const title = document.title || "";
  if (detectCaptcha()) return { captcha: true };

  if (findPhraseInHeadings(PHRASE_GROUPS[2])) return { notDelivered: true };
  if (matchPhraseGroup(PHRASE_GROUPS[2], title)) return { notDelivered: true };

  const oos = queryAny(document, SEL.outOfStockWidget);
  if (oos && !oos.closest('.tile-root, [data-widget="tileGridDesktop"], [data-widget="tileScrollDesktop"], [data-widget="skuGrid"], [data-widget="skuLine"]')) {
    return { outOfStock: true };
  }
  if (findPhraseInHeadings(PHRASE_GROUPS[1])) return { outOfStock: true };
  if (matchPhraseGroup(PHRASE_GROUPS[1], title)) return { outOfStock: true };

  const price = extractPrice();
  if (price && Number.isFinite(price) && price > 0) {
    if (!href.includes("/product/")) return { redirect: true };
    return {};
  }

  if (queryAny(document, SEL.errorWidget)) return { gone: true };
  if (findPhraseInHeadings(PHRASE_GROUPS[0])) return { gone: true };
  if (matchPhraseGroup(PHRASE_GROUPS[0], title)) return { gone: true };
  if (!href.includes("/product/")) return { redirect: true };
  return {};
};

const extractTilePrice = (tile) => pickPrice(tile);

const extractTileRating = (tile) => {
  const result = { rating: 0, reviews: 0 };
  const els = queryAllAny(tile, SEL.tileRating);
  for (const el of els) {
    const t = el.textContent.trim();
    const rm = t.match(/^(\d[.,]\d)$/);
    if (rm && !result.rating) result.rating = parseFloat(rm[1].replace(",", "."));
    const revm = t.match(/(\d[\d\s\u00a0]*)\s*отзыв/i);
    if (revm) result.reviews = parseInt(revm[1].replace(/[^\d]/g, ""), 10) || 0;
  }
  return result;
};

const collectTilesInto = (all, opts = {}) => {
  const { streamingBuf = null, filter = null } = opts;
  const tiles = queryAllAny(document, SEL.tileRoot);
  let added = 0;
  for (const tile of tiles) {
    const linkEl = queryAny(tile, SEL.tileLink);
    if (!linkEl) continue;
    const url = normalizeUrl(linkEl.href || "");
    if (!url || !url.includes("/product/")) continue;
    if (all[url]) continue;
    const price = extractTilePrice(tile);
    if (!price) continue;
    const nameEl = queryAny(tile, SEL.tileName);
    const imgEl = queryAny(tile, SEL.tileImage);
    const rr = extractTileRating(tile);
    const item = {
      url,
      name: nameEl ? (nameEl.textContent.trim() || nameEl.getAttribute("title") || "") : "",
      image: imgEl ? (imgEl.src || "") : "",
      price,
      rating: rr.rating,
      reviews: rr.reviews,
    };
    all[url] = item;
    added++;
    if (streamingBuf && passesFilter(item, filter)) streamingBuf.push(item);
  }
  return added;
};

const passesFilter = (item, filter) => {
  if (!filter) return true;
  if (filter.minRating > 0 && (Number(item.rating) || 0) < filter.minRating) return false;
  if (filter.minReviews > 0 && (Number(item.reviews) || 0) < filter.minReviews) return false;
  if (filter.maxPrice > 0 && (Number(item.price) || 0) > filter.maxPrice) return false;
  return true;
};

const scanAllProducts = async (options = {}) => {
  const streaming = !!options.streaming;
  const filter = options.filter || null;
  const all = {};
  const originalY = window.scrollY;
  const scanStartedAt = Date.now();
  const maxScrolls = 800;
  const scrollStepFactor = 0.75;
  const baseStepDelayMs = 650;
  const settleDelayMs = 400;
  const growWaitMs = 1200;
  const growWaitTickMs = 120;
  const heightGrowPx = 10;
  const noProgressStopMs = 5000;
  let cancelled = false;
  let lastProgressAt = Date.now();
  let lastReportedCount = -1;
  let lastReportedAt = 0;
  let streamingBuf = [];
  let lastStreamFlushAt = 0;
  let streamFlushTimer = null;
  const STREAM_FLUSH_INTERVAL_MS = 800;
  const STREAM_FLUSH_BATCH_SIZE = 40;

  const flushStreamBuf = async () => {
    if (streamFlushTimer) { clearTimeout(streamFlushTimer); streamFlushTimer = null; }
    if (!streamingBuf.length) return;
    const chunk = streamingBuf.splice(0, streamingBuf.length);
    try {
      await chrome.runtime.sendMessage({ action: "queueProductsForSave", products: chunk });
    } catch {
      streamingBuf = chunk.concat(streamingBuf);
    }
    lastStreamFlushAt = Date.now();
  };

  const scheduleStreamFlush = () => {
    if (!streaming) return;
    if (streamingBuf.length >= STREAM_FLUSH_BATCH_SIZE) { flushStreamBuf(); return; }
    if (streamFlushTimer) return;
    const since = Date.now() - lastStreamFlushAt;
    const delay = Math.max(0, STREAM_FLUSH_INTERVAL_MS - since);
    streamFlushTimer = setTimeout(() => { streamFlushTimer = null; flushStreamBuf(); }, delay);
  };

  const docHeight = () => Math.max(
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0
  );

  const reportProgress = (force) => {
    const now = Date.now();
    const count = Object.keys(all).length;
    if (!force) {
      if (count === lastReportedCount) return;
      if (now - lastReportedAt < 1000) return;
    }
    lastReportedCount = count;
    lastReportedAt = now;
    chrome.storage.local.set({ scanProgress: { active: true, count, startedAt: scanStartedAt } }).catch(() => {});
  };

  const collect = () => {
    collectTilesInto(all, { streamingBuf: streaming ? streamingBuf : null, filter });
    if (streaming) scheduleStreamFlush();
  };

  const prevScrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = "auto";
  try {
    window.scrollTo(0, 0);
    await sleep(500);
    collect();
    reportProgress(true);
    for (let s = 0; s < maxScrolls; s++) {
      if (await isCancelRequested()) { cancelled = true; break; }
      const before = Object.keys(all).length;
      const hBefore = docHeight();
      const yBefore = window.scrollY;
      const targetY = yBefore + Math.floor(window.innerHeight * scrollStepFactor);
      window.scrollTo(0, targetY);
      let waited = 0;
      let grew = false;
      while (waited < growWaitMs) {
        await sleep(growWaitTickMs);
        waited += growWaitTickMs;
        if (docHeight() > hBefore + heightGrowPx) { grew = true; break; }
      }
      await sleep(grew ? settleDelayMs : baseStepDelayMs);
      collect();
      const after = Object.keys(all).length;
      const hAfter = docHeight();
      const yAfter = window.scrollY;
      const newTiles = after - before;
      const heightGrew = hAfter > hBefore + heightGrowPx;
      const scrolled = yAfter > yBefore + 10;
      if (newTiles > 0 || heightGrew) lastProgressAt = Date.now();
      reportProgress(false);
      const stuckHere = !scrolled && !heightGrew && newTiles === 0;
      if (stuckHere && Date.now() - lastProgressAt > noProgressStopMs) {
        await sleep(800);
        collect();
        if (Object.keys(all).length === after) break;
        lastProgressAt = Date.now();
      }
    }
  } finally {
    document.documentElement.style.scrollBehavior = prevScrollBehavior || "";
    window.scrollTo(0, originalY);
    if (streaming) await flushStreamBuf();
    chrome.storage.local.set({ scanProgress: null }).catch(() => {});
  }
  const products = Object.keys(all).map((k) => all[k]);
  return { products, cancelled };
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getPrice") {
    const r = extractRating();
    const state = detectPageState();
    sendResponse({
      price: extractPrice(),
      name: extractName(),
      image: extractImage(),
      rating: r.rating,
      reviews: r.reviews,
      questions: extractQuestions(),
      mediaCount: extractMediaCount(),
      url: location.href,
      gone: !!state.gone,
      outOfStock: !!state.outOfStock,
      notDelivered: !!state.notDelivered,
      captcha: !!state.captcha,
      redirect: !!state.redirect,
    });
    return true;
  }
  if (msg.action === "scanAllProducts") {
    scanAllProducts({ streaming: !!msg.streaming, filter: msg.filter || null })
      .then((res) => {
        if (!msg.streaming && !res.cancelled && res.products?.length) {
          chrome.storage.local.set({ manualScanResult: res.products, manualScanAt: Date.now() }).catch(() => {});
        }
        sendResponse({ products: res.products, cancelled: res.cancelled });
      })
      .catch((err) => sendResponse({ products: [], error: String(err) }));
    return true;
  }
});

const sendAutoReportWithRetry = (msg, retriesLeft = 3) => {
  chrome.runtime.sendMessage(msg).catch(() => {
    if (retriesLeft > 0) setTimeout(() => sendAutoReportWithRetry(msg, retriesLeft - 1), 1500);
  });
};

const runAutoReport = () => {
  if (!location.href.includes("/product/")) return;
  const state = detectPageState();
  if (state.captcha || state.gone || state.redirect || state.notDelivered) return;
  let tries = 0;
  const maxTries = 5;
  const attempt = () => {
    const price = extractPrice();
    if (price) {
      const r = extractRating();
      sendAutoReportWithRetry({
        action: "priceFound",
        url: location.href,
        price,
        name: extractName(),
        image: extractImage(),
        rating: r.rating,
        reviews: r.reviews,
        questions: extractQuestions(),
        mediaCount: extractMediaCount(),
      });
      return;
    }
    tries++;
    if (tries < maxTries) setTimeout(attempt, 1000);
  };
  setTimeout(attempt, 1500);
};

runAutoReport();

(() => {
  let lastHref = location.href;
  const checkHref = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (lastHref.includes("/product/")) runAutoReport();
    }
  };
  try {
    window.navigation?.addEventListener("navigatesuccess", checkHref);
  } catch {}
})();