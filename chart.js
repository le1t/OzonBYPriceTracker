const getParam = (name) => new URLSearchParams(location.search).get(name);

const OUTLIER_COLOR = "#f0a800";
const MIN_COLOR = "#388e3c";
const MAX_COLOR = "#d32f2f";
const NEUTRAL_COLOR = "#005bff";
const UP_COLOR = MAX_COLOR;
const DOWN_COLOR = MIN_COLOR;
const DESIRED_COLOR = "#d4a017";
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const CHART = {
  history: [],
  outliers: [],
  avg: 0,
  product: null,
  tFullMin: 0,
  tFullMax: 0,
  tMin: 0,
  tMax: 0,
  layout: null,
  points: null,
  drag: null,
  clickStart: null,
  pinned: null,
  container: null,
  wrap: null,
  listenersAttached: false,
};

const getLineColor = () => {
  const hist = CHART.history;
  if (!hist?.length) return NEUTRAL_COLOR;
  const trend = hist.at(-1).price - hist[0].price;
  if (trend > 0) return UP_COLOR;
  if (trend < 0) return DOWN_COLOR;
  return NEUTRAL_COLOR;
};

const init = async () => {
  const idRaw = getParam("id");
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) {
    document.body.innerHTML = "<p style='padding:40px;text-align:center'>Не указан ID товара</p>";
    return;
  }

  const resp = await send({ action: "getProduct", id });
  if (resp?.transportError) {
    document.body.innerHTML = "<p style='padding:40px;text-align:center'>Фоновый процесс расширения не ответил.<br>Обновите страницу.</p>";
    return;
  }
  const p = resp.product;
  if (!p) {
    document.body.innerHTML = "<p style='padding:40px;text-align:center'>Товар не найден</p>";
    return;
  }

  document.getElementById("productName").textContent = p.name || "Без названия";
  const urlEl = document.getElementById("productUrl");
  urlEl.href = p.url;
  if (p.image) {
    document.getElementById("productImage").src = p.image;
  } else {
    document.getElementById("productImage").style.display = "none";
  }

  CHART.history = p.history || [];
  CHART.outliers = computeOutlierMask(CHART.history);
  CHART.avg = computeTimeWeightedAvg(CHART.history, Date.now(), CHART.outliers);
  CHART.product = p;

  renderStats(p);
  setupChart();
  renderHistory(p);

  document.getElementById("back").addEventListener("click", async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) await chrome.tabs.remove(tab.id);
      else window.close();
    } catch {
      window.close();
    }
  });

  document.getElementById("clearHistory").addEventListener("click", async () => {
    if (!confirm("Очистить всю историю цен для этого товара?")) return;
    const r = await send({ action: "clearHistory", id: p.id });
    if (r && r.ok === false) { alert("Не удалось очистить историю"); return; }
    location.reload();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; redrawChart(); }, 200);
  });
};

const computeOutlierMask = (history) => {
  const mask = history.map(() => false);
  if (!history || history.length < 5) return mask;

  const prices = history.map((h) => Number(h.price) || 0).filter((p) => p > 0);
  if (prices.length < 5) return mask;

  const sorted = prices.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const devs = prices.map((p) => Math.abs(p - median)).toSorted((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)];

  const threshold = Math.max(mad * 3, median * 0.5);
  if (!(threshold > 0)) return mask;

  history.forEach((h, i) => {
    const price = Number(h.price) || 0;
    if (price > 0 && Math.abs(price - median) > threshold) mask[i] = true;
  });
  return mask;
};

const computeTimeWeightedAvg = (history, nowMs, outliers) => {
  if (!history.length) return 0;
  if (history.length === 1) return history[0].price;
  if (!outliers) outliers = history.map(() => false);

  let totalWeight = 0;
  let weightedSum = 0;

  for (let i = 0; i < history.length; i++) {
    if (outliers[i]) continue;
    const start = new Date(history[i].date).getTime();
    if (!Number.isFinite(start)) continue;

    let end = nowMs;
    for (let j = i + 1; j < history.length; j++) {
      if (outliers[j]) continue;
      end = new Date(history[j].date).getTime();
      break;
    }
    if (!Number.isFinite(end)) continue;

    const weight = Math.max(0, end - start);
    if (weight === 0) continue;
    weightedSum += history[i].price * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    const clean = history.filter((_, i) => !outliers[i]);
    if (!clean.length) return history.at(-1).price;
    const sorted = clean.map((h) => h.price).toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  return weightedSum / totalWeight;
};

const getHistoryStats = (history, outliers) => {
  if (!history.length) return null;
  if (!outliers) outliers = history.map(() => false);

  const clean = history.filter((_, i) => !outliers[i]);
  const pool = clean.length ? clean : history;

  let minPt = pool[0];
  let maxPt = pool[0];
  for (let j = 1; j < pool.length; j++) {
    if (pool[j].price < minPt.price) minPt = pool[j];
    if (pool[j].price > maxPt.price) maxPt = pool[j];
  }
  const firstPt = pool[0];
  return {
    minPrice: minPt.price,
    minPriceDate: minPt.date,
    maxPrice: maxPt.price,
    maxPriceDate: maxPt.date,
    currentPrice: history.at(-1).price,
    firstPrice: firstPt.price,
  };
};

const getTempBadge = (last, avg) => {
  if (!(avg > 0) || !(last > 0)) return null;
  const ratio = last / avg;
  const pct = (ratio - 1) * 100;
  const pctStr = pct >= 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
  if (ratio < 0.95) return { cls: "good", icon: "🟢", text: "ниже средней", pctStr };
  if (ratio > 1.05) return { cls: "bad", icon: "🔴", text: "выше средней", pctStr };
  return { cls: "ok", icon: "🟡", text: "типичная", pctStr };
};

const renderStats = (p) => {
  const history = p.history || [];
  const stats = document.getElementById("stats");
  if (!history.length) { stats.innerHTML = ""; return; }

  const outliers = CHART.outliers;
  const outlierCount = outliers.reduce((n, f) => n + (f ? 1 : 0), 0);
  const s = getHistoryStats(history, outliers);
  const first = s.firstPrice;
  const last = s.currentPrice;
  const diff = last - first;
  const diffPct = first ? ((diff / first) * 100).toFixed(1) : "0";
  const avg = CHART.avg;

  const c = describeChange(diff);
  const changeClass = diff > 0 ? "up" : diff < 0 ? "down" : "";
  const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
  const absDiff = Math.abs(diff).toFixed(2);
  const absPct = Math.abs(Number(diffPct)).toFixed(1);

  const temp = getTempBadge(last, avg);

  let html = "";
  html += `<div class="stat-card"><div class="stat-label">Текущая</div><div class="stat-value">${formatPrice(last)}</div>`;
  if (temp) {
    html += `<div class="stat-temp ${temp.cls}" title="Сравнение со средней (по времени)">${temp.icon} ${temp.text} · ${temp.pctStr}</div>`;
  }
  html += `</div>`;

  html += `<div class="stat-card"><div class="stat-label">Изменение с начала</div><div class="stat-value ${changeClass}">${c.arrow} ${sign}${absDiff} Br</div><div class="stat-sub">${sign}${absPct}%</div></div>`;
  html += `<div class="stat-card"><div class="stat-label">Минимум</div><div class="stat-value min">${formatPrice(s.minPrice)}</div><div class="stat-sub">${formatDateTime(s.minPriceDate)}</div></div>`;
  html += `<div class="stat-card"><div class="stat-label">Максимум</div><div class="stat-value max">${formatPrice(s.maxPrice)}</div><div class="stat-sub">${formatDateTime(s.maxPriceDate)}</div></div>`;
  html += `<div class="stat-card"><div class="stat-label">Средняя (по времени)</div><div class="stat-value">${formatPrice(avg)}</div><div class="stat-sub">взвешено по длительности${outlierCount ? " · без аномалий" : ""}</div></div>`;
  html += `<div class="stat-card"><div class="stat-label">Точек</div><div class="stat-value">${history.length}</div>`;
  if (outlierCount > 0) {
    html += `<div class="stat-sub outlier-sub">⚠ ${outlierCount} аномальн${outlierCount === 1 ? "ая" : "ых"}</div>`;
  }
  html += "</div>";
  stats.innerHTML = html;
};

const yDecimalsFor = (rangeP) => {
  if (rangeP < 1) return 2;
  if (rangeP < 10) return 1;
  return 0;
};

const setupChart = () => {
  CHART.container = document.getElementById("chart-container");
  CHART.wrap = CHART.container ? CHART.container.parentNode : null;

  if (CHART.history.length) {
    const t0 = new Date(CHART.history[0].date).getTime();
    let t1 = new Date(CHART.history.at(-1).date).getTime();
    const nowMs = Date.now();
    if (nowMs - t1 < RECENT_MS) t1 = Math.max(t1, nowMs);
    if (t1 <= t0) t1 = t0 + 1;
    CHART.tFullMin = t0;
    CHART.tFullMax = t1;
    CHART.tMin = t0;
    CHART.tMax = t1;
  } else {
    const t = Date.now();
    CHART.tFullMin = CHART.tFullMax = CHART.tMin = CHART.tMax = t;
  }

  ensureControls();
  ensureListeners();
  redrawChart();
};

const ensureControls = () => {
  if (!CHART.wrap) return;
  CHART.wrap.querySelector(".chart-controls")?.remove();

  const ctrls = document.createElement("div");
  ctrls.className = "chart-controls";
  ctrls.innerHTML =
    '<button type="button" class="chart-ctrl" data-act="zoom-in" title="Приблизить">＋</button>' +
    '<button type="button" class="chart-ctrl" data-act="zoom-out" title="Отдалить">−</button>' +
    '<button type="button" class="chart-ctrl" data-act="reset" title="Показать весь период">⟳</button>' +
    '<span class="chart-presets" role="group" aria-label="Быстрый выбор периода">' +
      '<button type="button" class="chart-preset" data-days="1" title="Последние сутки">1д</button>' +
      '<button type="button" class="chart-preset" data-days="7" title="Последние 7 дней">7д</button>' +
      '<button type="button" class="chart-preset" data-days="30" title="Последние 30 дней">30д</button>' +
      '<button type="button" class="chart-preset" data-days="90" title="Последние 90 дней">90д</button>' +
      '<button type="button" class="chart-preset" data-days="0" title="Весь период">Всё</button>' +
    '</span>' +
    '<span class="chart-zoom-info" title="Насколько приближён график"></span>';
  CHART.wrap.appendChild(ctrls);

  ctrls.addEventListener("click", (e) => {
    const preset = e.target.closest(".chart-preset");
    if (preset) {
      const days = Number(preset.dataset.days);
      if (days === 0) resetZoom();
      else zoomToRange(days);
      return;
    }
    const btn = e.target.closest(".chart-ctrl");
    if (!btn) return;
    const act = btn.getAttribute("data-act");
    if (act === "zoom-in") zoomByFactor(1 / 1.4, 0.5);
    else if (act === "zoom-out") zoomByFactor(1.4, 0.5);
    else if (act === "reset") resetZoom();
  });
};

const syncPresetButtons = () => {
  const btns = CHART.wrap?.querySelectorAll(".chart-preset");
  if (!btns?.length) return;
  const cur = CHART.tMax - CHART.tMin;
  const full = CHART.tFullMax - CHART.tFullMin;
  const dayMs = 24 * 60 * 60 * 1000;

  let matchedDays = null;
  if (CHART.tMin <= CHART.tFullMin && CHART.tMax >= CHART.tFullMax) {
    matchedDays = 0;
  } else if (CHART.tMax >= CHART.tFullMax - 60000) {
    const tolerance = 0.03;
    for (const d of [1, 7, 30, 90]) {
      const presetRange = d * dayMs;
      if (Math.abs(cur - presetRange) / presetRange < tolerance) {
        matchedDays = d;
        break;
      }
    }
  }
  btns.forEach((b) => {
    const d = Number(b.dataset.days);
    b.classList.toggle("active", d === matchedDays);
  });
};

const updateZoomInfo = () => {
  const info = CHART.wrap?.querySelector(".chart-zoom-info");
  if (!info) { syncPresetButtons(); return; }
  const full = CHART.tFullMax - CHART.tFullMin;
  const cur = CHART.tMax - CHART.tMin;
  const pct = full > 0 ? Math.round((cur / full) * 100) : 100;
  if (pct >= 99) {
    info.textContent = "весь период";
  } else {
    const mult = full / Math.max(cur, 1);
    info.textContent = `×${mult >= 10 ? mult.toFixed(0) : mult.toFixed(1)}`;
  }
  syncPresetButtons();
};

const zoomByFactor = (factor, anchorFrac) => {
  const full = CHART.tFullMax - CHART.tFullMin;
  if (full <= 0) return;
  const cur = CHART.tMax - CHART.tMin;
  let newRange = cur * factor;
  newRange = Math.max(full / 60, Math.min(full, newRange));
  const anchorT = CHART.tMin + anchorFrac * cur;
  let newTMin = anchorT - anchorFrac * newRange;
  let newTMax = newTMin + newRange;
  if (newRange >= full) {
    newTMin = CHART.tFullMin;
    newTMax = CHART.tFullMax;
  } else {
    if (newTMin < CHART.tFullMin) { newTMin = CHART.tFullMin; newTMax = newTMin + newRange; }
    if (newTMax > CHART.tFullMax) { newTMax = CHART.tFullMax; newTMin = newTMax - newRange; }
  }
  CHART.tMin = newTMin;
  CHART.tMax = newTMax;
  redrawChart();
};

const zoomToRange = (days) => {
  const rangeMs = days * 24 * 60 * 60 * 1000;
  const full = CHART.tFullMax - CHART.tFullMin;
  if (full <= 0) return;
  let newTMax = CHART.tFullMax;
  let newTMin = newTMax - rangeMs;
  if (newTMin <= CHART.tFullMin) {
    CHART.tMin = CHART.tFullMin;
    CHART.tMax = CHART.tFullMax;
  } else {
    CHART.tMin = newTMin;
    CHART.tMax = newTMax;
  }
  redrawChart();
};

const resetZoom = () => {
  CHART.tMin = CHART.tFullMin;
  CHART.tMax = CHART.tFullMax;
  redrawChart();
};

const redrawChart = () => {
  const history = CHART.history;
  const container = CHART.container;
  if (!container) return;
  const emptyEl = document.getElementById("chartEmpty");
  const wrap = CHART.wrap;

  wrap.querySelector(".chart-tooltip")?.remove();
  wrap.querySelector(".chart-hint")?.remove();
  wrap.querySelector(".chart-note")?.remove();

  if (CHART.pinned !== null) {
    CHART.pinned = null;
  }

  if (!history.length) {
    container.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    updateZoomInfo();
    return;
  }
  emptyEl?.classList.add("hidden");

  const W = Math.max(700, Math.min(window.innerWidth - 100, 1000));
  const H = 340;
  const pad = { top: 34, right: 70, bottom: 46, left: 70 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  let tMin = CHART.tMin;
  let tMax = CHART.tMax;
  if (tMax <= tMin) tMax = tMin + 1;
  const rangeT = tMax - tMin;
  const rangeDays = rangeT / (24 * 60 * 60 * 1000);

  const scaleIdx = [];
  for (let vi = 0; vi < history.length; vi++) {
    const vt = new Date(history[vi].date).getTime();
    if (vt >= tMin - rangeT * 0.03 && vt <= tMax + rangeT * 0.03) scaleIdx.push(vi);
  }
  if (scaleIdx.length < 2) {
    for (let ai = 0; ai < history.length; ai++) scaleIdx.push(ai);
  }

  const cleanPrices = [];
  for (const si of scaleIdx) {
    if (!CHART.outliers[si]) cleanPrices.push(history[si].price);
  }
  const scalePool = cleanPrices.length >= 2
    ? cleanPrices
    : scaleIdx.map((i) => history[i].price);

  let minP = Math.min(...scalePool);
  let maxP = Math.max(...scalePool);

  const desiredPrice = Number(CHART.product?.desiredPrice) || 0;
  if (desiredPrice > 0) {
    minP = Math.min(minP, desiredPrice);
    maxP = Math.max(maxP, desiredPrice);
  }

  if (!Number.isFinite(minP) || !Number.isFinite(maxP)) { minP = 0; maxP = 1; }
  if (maxP === minP) {
    const base = Math.abs(minP) || 1;
    maxP = minP + base * 0.1;
    minP = Math.max(0, minP - base * 0.1);
  }
  const rawRange = maxP - minP;
  minP = Math.max(0, minP - rawRange * 0.08);
  maxP = maxP + rawRange * 0.08;
  const rangeP = maxP - minP;

  const xFor = (t) => pad.left + ((t - tMin) / rangeT) * cw;
  const yForRaw = (price) => pad.top + ch - ((price - minP) / rangeP) * ch;
  const yFor = (price) => Math.max(pad.top, Math.min(pad.top + ch, yForRaw(price)));

  const points = [];
  for (let pi = 0; pi < history.length; pi++) {
    const h = history[pi];
    const tt = new Date(h.date).getTime();
    const yRaw = yForRaw(h.price);
    points.push({
      x: xFor(tt),
      y: yFor(h.price),
      yRaw,
      isClamped: yRaw < pad.top || yRaw > pad.top + ch,
      price: h.price,
      date: h.date,
      t: tt,
      outlier: !!CHART.outliers[pi],
      idx: pi,
    });
  }
  CHART.points = points;
  CHART.layout = { pad, cw };

  const pathSegments = [];
  points.forEach((pt, k) => {
    if (k === 0) {
      pathSegments.push(`M${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
    } else {
      const prev = points[k - 1];
      pathSegments.push(`L${pt.x.toFixed(1)},${prev.y.toFixed(1)}`);
      pathSegments.push(`L${pt.x.toFixed(1)},${pt.y.toFixed(1)}`);
    }
  });
  const lastPt = points.at(-1);
  const pathEndX = pad.left + cw;
  pathSegments.push(`L${pathEndX.toFixed(1)},${lastPt.y.toFixed(1)}`);
  const pathD = pathSegments.join(" ");

  const areaSegments = pathSegments.slice();
  areaSegments.push(`L${pathEndX.toFixed(1)},${pad.top + ch}`);
  areaSegments.push(`L${points[0].x.toFixed(1)},${pad.top + ch}`);
  areaSegments.push("Z");
  const areaD = areaSegments.join(" ");

  const trend = history.at(-1).price - history[0].price;
  const lineColor = trend > 0 ? UP_COLOR : trend < 0 ? DOWN_COLOR : NEUTRAL_COLOR;
  const areaColor = trend > 0
    ? "rgba(211,47,47,0.08)"
    : trend < 0
    ? "rgba(56,142,60,0.08)"
    : "rgba(0,91,255,0.08)";

  const yDecimals = yDecimalsFor(rangeP);
  const yTicks = [];
  for (let ti = 0; ti <= 5; ti++) {
    yTicks.push({
      y: pad.top + ch - (ch * ti / 5),
      value: minP + (rangeP * ti / 5),
    });
  }
  const xTicks = [];
  for (let j = 0; j <= 5; j++) {
    xTicks.push({
      x: pad.left + (cw * j / 5),
      date: new Date(tMin + (rangeT * j / 5)),
    });
  }
  const formatXLabel = (d) => {
    if (rangeDays > 180) return `${String(d.getFullYear()).slice(-2)}/${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (rangeDays > 2) return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const clipId = `plotClip_${Math.random().toString(36).slice(2, 9)}`;

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<defs><clipPath id="${clipId}"><rect x="${pad.left}" y="${pad.top}" width="${cw}" height="${ch}"/></clipPath></defs>`;

  yTicks.forEach((t) => {
    svg += `<line x1="${pad.left}" y1="${t.y}" x2="${pad.left + cw}" y2="${t.y}" stroke="#eee" stroke-width="1"/>`;
    svg += `<text x="${pad.left - 8}" y="${t.y + 4}" text-anchor="end" font-size="11" fill="#888">${t.value.toFixed(yDecimals)}</text>`;
  });
  xTicks.forEach((t) => {
    svg += `<line x1="${t.x}" y1="${pad.top}" x2="${t.x}" y2="${pad.top + ch}" stroke="#f5f5f5" stroke-width="1"/>`;
    svg += `<text x="${t.x}" y="${pad.top + ch + 18}" text-anchor="middle" font-size="10" fill="#888">${formatXLabel(t.date)}</text>`;
  });

  const avg = CHART.avg;

  svg += `<g clip-path="url(#${clipId})">`;

  if (avg > 0 && avg > minP && avg < maxP) {
    const yAvg = yFor(avg);
    svg += `<line class="chart-ref-avg" x1="${pad.left}" y1="${yAvg.toFixed(1)}" x2="${pad.left + cw}" y2="${yAvg.toFixed(1)}"/>`;
  }

  if (desiredPrice > 0 && desiredPrice > minP && desiredPrice < maxP) {
    const yDes = yFor(desiredPrice);
    svg += `<line class="chart-ref-desired" x1="${pad.left}" y1="${yDes.toFixed(1)}" x2="${pad.left + cw}" y2="${yDes.toFixed(1)}"/>`;
  }

  svg += `<path d="${areaD}" fill="${areaColor}"/>`;
  svg += `<path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  svg += "</g>";

  if (avg > 0 && avg > minP && avg < maxP) {
    const yAvg = yFor(avg);
    svg += `<text x="${(pad.left + cw + 4).toFixed(1)}" y="${(yAvg + 3).toFixed(1)}" font-size="10" fill="#8a9099" font-weight="600" text-anchor="start">ср. ${avg.toFixed(0)}</text>`;
  }
  if (desiredPrice > 0 && desiredPrice > minP && desiredPrice < maxP) {
    const yDes = yFor(desiredPrice);
    svg += `<text x="${(pad.left + cw + 4).toFixed(1)}" y="${(yDes + 3).toFixed(1)}" font-size="10" fill="${DESIRED_COLOR}" font-weight="700" text-anchor="start">🎯 ${desiredPrice.toFixed(0)}</text>`;
  }

  for (const pp of points) {
    if (pp.x < pad.left - 20 || pp.x > pad.left + cw + 20) continue;
    if (pp.outlier) {
      svg += `<circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="4" fill="white" stroke="${OUTLIER_COLOR}" stroke-width="2" stroke-dasharray="3,2"/>`;
      if (pp.x >= pad.left && pp.x <= pad.left + cw && !pp.isClamped) {
        svg += `<text class="chart-outlier-label" x="${pp.x.toFixed(1)}" y="${(pp.y - 9).toFixed(1)}" text-anchor="middle">${pp.price.toFixed(0)}</text>`;
      }
    } else {
      svg += `<circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="3" fill="white" stroke="${lineColor}" stroke-width="2"/>`;
    }
  }

  const visibleClean = points.filter((cp) => !cp.outlier && cp.x >= pad.left - 1 && cp.x <= pad.left + cw + 1);
  let minPt = null;
  let maxPt = null;
  if (visibleClean.length) {
    minPt = visibleClean.reduce((a, b) => (a.price <= b.price ? a : b));
    maxPt = visibleClean.reduce((a, b) => (a.price >= b.price ? a : b));
  }
  svg += drawMinMaxLabels(minPt, maxPt, pad, cw, ch);

  svg += `<line x1="${pad.left}" y1="${lastPt.y.toFixed(1)}" x2="${pad.left + cw}" y2="${lastPt.y.toFixed(1)}" stroke="#005bff" stroke-width="1" stroke-dasharray="4,4" opacity="0.4"/>`;

  for (const op of points) {
    if (!op.outlier || !op.isClamped) continue;
    if (op.x < pad.left - 6 || op.x > pad.left + cw + 6) continue;
    const inTop = op.yRaw < pad.top;
    const triY = inTop ? pad.top - 8 : pad.top + ch + 8;
    const triDir = inTop ? -1 : 1;
    svg += `<path d="M${(op.x - 4).toFixed(1)},${triY.toFixed(1)} L${(op.x + 4).toFixed(1)},${triY.toFixed(1)} L${op.x.toFixed(1)},${(triY + triDir * 6).toFixed(1)} Z" fill="${OUTLIER_COLOR}" opacity="0.9"/>`;
    const labelY = inTop ? pad.top - 18 : pad.top + ch + 22;
    svg += `<text class="chart-outlier-label" x="${op.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${op.price.toFixed(0)}</text>`;
  }

  svg += `<line class="chart-guide" x1="0" y1="${pad.top}" x2="0" y2="${pad.top + ch}" style="display:none"/>`;
  svg += '<circle class="chart-hover-dot" cx="0" cy="0" r="6" style="display:none"/>';
  svg += "</svg>";
  container.innerHTML = svg;

  const outlierCount = CHART.outliers.reduce((n, f) => n + (f ? 1 : 0), 0);
  if (outlierCount > 0) {
    const note = document.createElement("div");
    note.className = "chart-note";
    note.innerHTML = `⚠ Найдено <b>${outlierCount}</b> аномальных ${outlierCount === 1 ? "точка" : "точек"} — вероятно, ошибки парсинга цен. Они показаны оранжевыми маркерами с подписями и исключены из MIN/MAX и средней.`;
    wrap.appendChild(note);
  }

  const hint = document.createElement("div");
  hint.className = "chart-hint";
  hint.textContent = "Колесо мыши — приблизить/отдалить · зажмите и тяните — сдвинуть · клик по точке — закрепить подсказку · двойной клик — весь период";
  wrap.appendChild(hint);

  updateZoomInfo();
};

const drawMinMaxLabels = (minPt, maxPt, pad, cw, ch) => {
  if (!minPt && !maxPt) return "";
  if (!minPt) minPt = maxPt;
  if (!maxPt) maxPt = minPt;

  const plotRight = pad.left + cw;

  if (minPt.idx === maxPt.idx) {
    let out = "";
    out += renderMarker(minPt.x, minPt.y, NEUTRAL_COLOR);
    out += renderFloatingLabel(minPt.x, minPt.y, `MIN=MAX ${formatPrice(minPt.price)}`, NEUTRAL_COLOR, false, pad, plotRight, ch);
    return out;
  }

  let maxAbove = maxPt.y - 40 > pad.top;
  let minAbove = !(minPt.y + 40 < pad.top + ch);

  const dx = Math.abs(minPt.x - maxPt.x);
  const dy = Math.abs(minPt.y - maxPt.y);
  if (dx < 160 && dy < 60) {
    maxAbove = true;
    minAbove = false;
  }

  let out = "";
  out += renderMarker(maxPt.x, maxPt.y, MAX_COLOR);
  out += renderFloatingLabel(maxPt.x, maxPt.y, `MAX ${formatPrice(maxPt.price)}`, MAX_COLOR, !maxAbove, pad, plotRight, ch);
  out += renderMarker(minPt.x, minPt.y, MIN_COLOR);
  out += renderFloatingLabel(minPt.x, minPt.y, `MIN ${formatPrice(minPt.price)}`, MIN_COLOR, !minAbove, pad, plotRight, ch);
  return out;
};

const renderMarker = (x, y, color) =>
  `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="${color}" stroke="white" stroke-width="2"/>`;

const renderFloatingLabel = (x, y, text, color, below, pad, plotRight, ch) => {
  const above = !below;
  let textY;
  if (above) {
    textY = y - 14;
    if (textY < pad.top + 4) textY = y + 22;
  } else {
    textY = y + 22;
    if (textY > pad.top + ch - 4) textY = y - 14;
  }

  let anchor = "middle";
  let textX = x;
  if (x < pad.left + 60) { anchor = "start"; textX = Math.max(pad.left, x - 8); }
  else if (x > plotRight - 60) { anchor = "end"; textX = Math.min(plotRight, x + 8); }

  return `<text x="${textX.toFixed(1)}" y="${textY.toFixed(1)}" text-anchor="${anchor}" font-size="11" font-weight="700" fill="${color}" stroke="white" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke" style="pointer-events:none">${text}</text>`;
};

const ensureListeners = () => {
  if (CHART.listenersAttached || !CHART.container) return;
  CHART.listenersAttached = true;
  const container = CHART.container;

  container.addEventListener("mousemove", onMouseMove);
  container.addEventListener("mouseleave", () => hideTooltip());
  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("dblclick", onDblClick);
  container.addEventListener("wheel", onWheel, { passive: false });

  window.addEventListener("mousemove", onWindowMove);
  window.addEventListener("mouseup", onWindowUp);
};

const getSvg = () => CHART.container?.querySelector("svg") || null;

const screenToSvg = (svg, clientX, clientY) => {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const m = svg.getScreenCTM();
  if (!m) return null;
  return pt.matrixTransform(m.inverse());
};

const svgPointAt = (e) => {
  const svg = getSvg();
  if (!svg || !CHART.layout) return null;
  const pt = screenToSvg(svg, e.clientX, e.clientY);
  if (!pt) return null;
  const { pad, cw } = CHART.layout;
  if (pt.x < pad.left - 6 || pt.x > pad.left + cw + 6) return null;
  return { svg, pt };
};

const getTooltip = () => {
  if (!CHART.wrap) return null;
  let tip = CHART.wrap.querySelector(".chart-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "chart-tooltip hidden";
    CHART.wrap.appendChild(tip);
  }
  return tip;
};

const hideTooltip = (force = false) => {
  if (!force && CHART.pinned !== null) return;
  if (!CHART.wrap) return;
  CHART.wrap.querySelector(".chart-tooltip")?.classList.add("hidden");
  const svg = getSvg();
  if (!svg) return;
  const guide = svg.querySelector(".chart-guide");
  const dot = svg.querySelector(".chart-hover-dot");
  if (guide) guide.style.display = "none";
  if (dot) dot.style.display = "none";
};

const findNearestPoint = (svgX) => {
  const pts = CHART.points || [];
  const layout = CHART.layout;
  if (!layout) return -1;
  if (svgX < layout.pad.left - 6 || svgX > layout.pad.left + layout.cw + 6) return -1;
  let nearest = -1;
  let minDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(pts[i].x - svgX);
    if (d < minDist) { minDist = d; nearest = i; }
  }
  return nearest;
};

const showTooltipAt = (idx, clientX, clientY) => {
  const pt = (CHART.points || [])[idx];
  if (!pt) { hideTooltip(true); return; }
  const svg = getSvg();
  if (!svg) return;

  const prev = idx > 0 ? CHART.points[idx - 1] : null;
  const dateStr = formatDateTime(pt.date);
  const priceStr = formatPrice(pt.price);

  let changeHtml = "";
  if (prev && !pt.outlier && !prev.outlier) {
    const diff = pt.price - prev.price;
    if (Math.abs(diff) > 0.001) {
      const c = describeChange(diff);
      changeHtml = `<div class="tip-change ${c.cls}">${c.arrow} ${formatDiff(diff)} Br <span class="tip-change-sub">от ${formatDateTime(prev.date)}</span></div>`;
    } else {
      changeHtml = '<div class="tip-change change-same">без изменений</div>';
    }
  } else if (pt.outlier) {
    changeHtml = '<div class="tip-change change-same">аномальная точка</div>';
  } else {
    changeHtml = '<div class="tip-change change-same">первая запись</div>';
  }

  const outlierHtml = pt.outlier ? '<div class="tip-outlier">⚠ Аномальное значение — исключено из расчётов</div>' : "";

  const tip = getTooltip();
  if (!tip) return;
  tip.innerHTML = `<div class="tip-date">${dateStr}</div><div class="tip-price">${priceStr}</div>${changeHtml}${outlierHtml}`;
  tip.classList.remove("hidden");

  const wrapRect = CHART.wrap.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const localX = clientX - wrapRect.left;
  const localY = clientY - wrapRect.top;
  let tipX = localX + 14;
  let tipY = localY - tipRect.height - 12;
  if (tipX + tipRect.width > wrapRect.width - 4) tipX = localX - tipRect.width - 14;
  if (tipX < 4) tipX = 4;
  if (tipY < 4) tipY = localY + 16;
  if (tipY + tipRect.height > wrapRect.height - 4) {
    tipY = Math.max(4, localY - tipRect.height - 12);
  }
  tip.style.left = `${tipX}px`;
  tip.style.top = `${tipY}px`;

  const guide = svg.querySelector(".chart-guide");
  const dot = svg.querySelector(".chart-hover-dot");
  if (guide) {
    guide.setAttribute("x1", pt.x);
    guide.setAttribute("x2", pt.x);
    guide.style.display = "";
  }
  if (dot) {
    dot.setAttribute("cx", pt.x);
    dot.setAttribute("cy", pt.y);
    dot.setAttribute("fill", pt.outlier ? OUTLIER_COLOR : getLineColor());
    dot.style.display = "";
  }
};

const onMouseMove = (e) => {
  if (CHART.drag) return;
  if (CHART.pinned !== null) return;
  const svg = getSvg();
  if (!svg) return;
  const pt = screenToSvg(svg, e.clientX, e.clientY);
  if (!pt) return;
  const idx = findNearestPoint(pt.x);
  if (idx < 0) { hideTooltip(); return; }
  showTooltipAt(idx, e.clientX, e.clientY);
};

const onMouseDown = (e) => {
  if (e.button !== 0) return;
  const hit = svgPointAt(e);
  if (!hit) return;

  CHART.clickStart = { x: e.clientX, y: e.clientY };

  if (CHART.tMin <= CHART.tFullMin && CHART.tMax >= CHART.tFullMax) return;

  CHART.drag = { startX: e.clientX, startTMin: CHART.tMin, startTMax: CHART.tMax };
  if (CHART.pinned !== null) {
    CHART.pinned = null;
    hideTooltip(true);
  } else {
    hideTooltip();
  }
  hit.svg.style.cursor = "grabbing";
  e.preventDefault();
};

const onWindowMove = (e) => {
  if (!CHART.drag || !CHART.layout) return;
  const dx = e.clientX - CHART.drag.startX;
  const rangeT = CHART.drag.startTMax - CHART.drag.startTMin;
  const dt = (dx / CHART.layout.cw) * rangeT;
  let newTMin = CHART.drag.startTMin - dt;
  let newTMax = CHART.drag.startTMax - dt;
  if (newTMin < CHART.tFullMin) { newTMin = CHART.tFullMin; newTMax = newTMin + rangeT; }
  if (newTMax > CHART.tFullMax) { newTMax = CHART.tFullMax; newTMin = newTMax - rangeT; }
  CHART.tMin = newTMin;
  CHART.tMax = newTMax;
  redrawChart();
};

const onWindowUp = (e) => {
  if (CHART.drag) {
    CHART.drag = null;
    CHART.clickStart = null;
    const svg = getSvg();
    if (svg) svg.style.cursor = "";
    return;
  }
  if (!CHART.clickStart) return;
  const dx = Math.abs(e.clientX - CHART.clickStart.x);
  const dy = Math.abs(e.clientY - CHART.clickStart.y);
  CHART.clickStart = null;
  if (dx >= 5 || dy >= 5) return;

  const svg = getSvg();
  if (!svg) return;
  const pt = screenToSvg(svg, e.clientX, e.clientY);
  if (!pt) return;
  const idx = findNearestPoint(pt.x);
  if (idx < 0) {
    if (CHART.pinned !== null) {
      CHART.pinned = null;
      hideTooltip(true);
    }
    return;
  }
  if (CHART.pinned === idx) {
    CHART.pinned = null;
    hideTooltip(true);
  } else {
    CHART.pinned = idx;
    showTooltipAt(idx, e.clientX, e.clientY);
  }
};

const onDblClick = (e) => {
  if (!svgPointAt(e)) return;
  resetZoom();
};

const onWheel = (e) => {
  const hit = svgPointAt(e);
  if (!hit) return;
  const { pt } = hit;
  const layout = CHART.layout;

  e.preventDefault();
  let frac = (pt.x - layout.pad.left) / layout.cw;
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;
  const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
  zoomByFactor(factor, frac);
};

const renderHistory = (p) => {
  const history = (p.history || []).toReversed();
  const outliers = CHART.outliers.toReversed();
  document.getElementById("historyCount").textContent = history.length || "";

  const tbody = document.querySelector("#historyTable tbody");
  tbody.innerHTML = "";

  if (!history.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px">История пуста</td></tr>';
    return;
  }

  history.forEach((h, idx) => {
    const origIdx = history.length - idx;
    const prevItem = history[idx + 1];
    const prevOutlier = idx + 1 < history.length ? !!outliers[idx + 1] : false;
    const isOutlier = !!outliers[idx];

    let change = "—";
    let changeClass = "";
    let spike = "";

    if (isOutlier || prevOutlier) {
      change = "—";
      changeClass = "";
    } else if (prevItem) {
      const diff = h.price - prevItem.price;
      const abs = Math.abs(diff);
      if (diff > 0) {
        change = `↑ ${formatDiff(diff)} Br`;
        changeClass = "change-up";
      } else if (diff < 0) {
        change = `↓ ${formatDiff(diff)} Br`;
        changeClass = "change-down";
      } else {
        change = "без изменений";
        changeClass = "change-same";
      }
      if (abs >= 5) changeClass += " big-change";
      if (abs >= 10) spike = " ⚡";
    }

    const tr = document.createElement("tr");
    if (isOutlier) tr.className = "outlier-row";
    const priceCell = `${formatPrice(h.price)}${isOutlier ? ' <span class="outlier-badge" title="Аномальное значение — вероятно, ошибка парсинга">⚠</span>' : ""}`;
    tr.innerHTML =
      `<td style="color:#999">${origIdx}</td>` +
      `<td>${formatDateTime(h.date)}</td>` +
      `<td class="price-cell">${priceCell}</td>` +
      `<td class="${changeClass}">${change}${spike}</td>`;
    tbody.appendChild(tr);
  });
};

init();