const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 20;
const DEFAULT_CONCURRENCY = 3;

const MIN_CHECK_INTERVAL_MIN = 15;
const DEFAULT_CHECK_INTERVAL_MIN = 60;

const ARCHIVE_TTL_DAYS = 90;
const ARCHIVE_TTL_MS = ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000;
const RECENT_TTL_MS = 24 * 60 * 60 * 1000;

const clampConc = (v) => {
  const n = Number(v);
  return Number.isFinite(n)
    ? Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(n)))
    : DEFAULT_CONCURRENCY;
};

const clampInterval = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= MIN_CHECK_INTERVAL_MIN
    ? Math.floor(n)
    : DEFAULT_CHECK_INTERVAL_MIN;
};

const normalizeUrl = (url) => {
  try {
    const u = new URL(url);
    const path = (u.pathname || "").replace(/\/+$/, "");
    let host = (u.hostname || "").toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host ? `https://${host}${path}` : url;
  } catch {
    return url;
  }
};

const isOzonUrl = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    let host = (u.hostname || "").toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host === "ozon.by" || host.endsWith(".ozon.by");
  } catch {
    return false;
  }
};

const sanitizeUrl = (url) => (url && isOzonUrl(url) ? normalizeUrl(url) : null);

const extractArticleFromUrl = (url) => {
  if (!url) return "";
  try {
    const { pathname } = new URL(url);
    const m = pathname.match(/-(\d{5,})\/?$/) || pathname.match(/\/product\/(\d{5,})/);
    if (m) return m[1];
    const nums = pathname.match(/\d{5,}/g) || url.match(/\d{5,}/g);
    return nums?.length ? nums.at(-1) : "";
  } catch {
    return "";
  }
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const parseLocalizedNumber = (v) => {
  if (v == null) return NaN;
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  let s = String(v).trim().replaceAll(/[\u00a0\u2009\u202f]/g, "").replaceAll(/\s+/g, "");
  if (!s) return NaN;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    s = lastComma > lastDot
      ? s.replaceAll(/\./g, "").replace(",", ".")
      : s.replaceAll(/,/g, "");
  } else if (lastComma !== -1) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

const formatDateTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

const formatRelative = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "только что";
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
  return formatDateTime(iso);
};

const formatHMS = (sec) => {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
};

const formatDuration = (totalSec) => {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${s % 60} сек`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин ${s % 60} сек`;
};

const formatNumber = (n) => {
  if (n == null || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  if (num === 0) return "0";
  const neg = num < 0;
  const abs = Math.abs(num);
  let str;
  if (Number.isInteger(abs)) {
    str = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  } else {
    const parts = String(abs).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    str = parts.join(".");
  }
  return (neg ? "-" : "") + str;
};

const formatPrice = (n) => {
  const num = Number(n);
  return Number.isFinite(num) ? `${num.toFixed(2)} Br` : "? Br";
};

const formatDiff = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num) || num === 0) return "0.00";
  const rounded = Math.round(Math.abs(num) * 100) / 100;
  if (rounded === 0) return "0.00";
  return `${num > 0 ? "+" : "-"}${rounded.toFixed(2)}`;
};

const formatPct = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num) || num === 0) return "0.00%";
  return `${num > 0 ? "+" : "-"}${Math.abs(num).toFixed(2)}%`;
};

const describeChange = (diff) => {
  const num = Number(diff) || 0;
  if (num > 0) return { arrow: "↑", sign: "+", cls: "change-up", color: "#d32f2f" };
  if (num < 0) return { arrow: "↓", sign: "", cls: "change-down", color: "#388e3c" };
  return { arrow: "—", sign: "", cls: "change-same", color: "#8a9099" };
};

const send = async (msg) => {
  try {
    return (await chrome.runtime.sendMessage(msg)) ?? {};
  } catch (e) {
    const err = e?.message || String(e);
    console.warn("[send] error:", err, "msg:", msg?.action);
    return { ok: false, transportError: true, reason: "transport", error: err };
  }
};