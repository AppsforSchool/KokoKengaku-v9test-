// ★ ユーザー情報（名前・アイコン・自己紹介など）の共通キャッシュ。talkScript.js / appScript.js / notify.js から使う。
//   - メモリだけでなく localStorage にも保存するので、ページを開き直したり app.html ⇔ talk.html を
//     行き来しても、前回の内容をそのまま使える（毎回 users_random を読みに行かない）。
//   - 各ユーザーの情報は「最後にサーバーから取得（または更新）してから3時間」を過ぎたら古いとみなし、
//     次に必要になったときに読み直す。古い情報でも、読み直しが終わるまでの仮表示には使える。
const STORAGE_KEY = "kokoUserCache_v1";
export const USER_CACHE_TTL_MS = 3 * 60 * 60 * 1000;   // ★ 3時間

// Firestoreのタイムスタンプ(またはミリ秒数値)を、保存しやすいミリ秒数値へ揃える
function toMillisOrNull(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  return null;
}

// store: { users: { [userId]: { data, fetchedAt } }, list: { items: [...], fetchedAt } | null }
let store = { users: {}, list: null };
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      store = { users: parsed.users || {}, list: parsed.list || null };
    }
  }
} catch (e) {
  console.warn("ユーザーキャッシュの読み込みに失敗:", e);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) { /* 容量不足などで保存できなくても、メモリ上のキャッシュだけで動く */ }
  }, 300);
}
// ページを離れる直前にも書き出しておく（タイマー待ちで失われないように）
window.addEventListener("pagehide", () => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* 無視 */ }
});

export function getUserCache(userId) {
  const entry = store.users[userId];
  return entry ? entry.data : null;
}

// ★ data の内容を既存のキャッシュにマージして保存する。取得日時は「今」に更新される
export function setUserCache(userId, data) {
  const normalized = Object.assign({}, data);
  if ("prizeGrantedAt" in normalized) {
    normalized.prizeGrantedAt = toMillisOrNull(normalized.prizeGrantedAt);
  }
  const previous = store.users[userId] ? store.users[userId].data : {};
  const merged = Object.assign({}, previous, normalized);
  store.users[userId] = { data: merged, fetchedAt: Date.now() };

  // 個人タブ用の一覧に載っている名前も、同じ内容に揃えておく
  if (store.list && normalized.name) {
    const item = store.list.items.find((u) => u.userId === userId);
    if (item) item.name = normalized.name;
  }
  scheduleSave();
  return merged;
}

// ★ 3時間以内に取得・更新したキャッシュか
export function isUserCacheFresh(userId) {
  const entry = store.users[userId];
  return !!entry && Date.now() - entry.fetchedAt < USER_CACHE_TTL_MS;
}

// ★ 個人タブに並べる「全ユーザー一覧」（isActive な人のみ）のキャッシュ
export function getCachedUserList() {
  if (!store.list) return null;
  if (Date.now() - store.list.fetchedAt >= USER_CACHE_TTL_MS) return null;   // 古ければ無いものとして扱う
  // JSONでは Infinity が null になって保存されるので、並び替え用の no を元に戻す
  return store.list.items.map((u) => Object.assign({}, u, { no: typeof u.no === "number" ? u.no : Infinity }));
}
export function setCachedUserList(items) {
  store.list = { items: items.map((u) => Object.assign({}, u, { no: Number.isFinite(u.no) ? u.no : null })), fetchedAt: Date.now() };
  scheduleSave();
}

// ★ ログアウト時などに全部消す
export function clearUserCache() {
  store = { users: {}, list: null };
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* 無視 */ }
}
