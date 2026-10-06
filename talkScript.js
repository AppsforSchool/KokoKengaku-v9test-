import { initPush, logoutPush, setupPushButton, sendMessageNotification, sendPushToUsers, sendProfileChangeNotification } from "./notify.js";
import {
  auth, db, onAuthStateChanged, signOut,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, onSnapshot,
  query, where, orderBy, documentId, writeBatch, serverTimestamp, arrayUnion, increment, Timestamp
} from "./firebase.js";
import { getUserCache, setUserCache, isUserCacheFresh, clearUserCache } from "./userCache.js";


let myUserId = "";
let myUid = "";
let meIsAdmin = false;

let talkId;

// ★ ユーザーデータのキャッシュは userCache.js に移した（localStorageにも保存され、3時間で古い扱いになる）

// ★ Firestoreのタイムスタンプ(またはミリ秒数値)を、比較に使いやすいミリ秒数値へ揃える
function toMillisOrNull(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  return null;
}

// ★ 景品(名前が虹色に光る演出)の持続時間。3日間
const PRIZE_DURATION_MS = 3 * 24 * 60 * 60 * 1000;

// ★ 景品が、付与されてからまだ持続時間内（＝現在も有効）かどうか
function hasActivePrize(cached) {
  const grantedAt = cached && cached.prizeGrantedAt;
  return typeof grantedAt === "number" && grantedAt + PRIZE_DURATION_MS > Date.now();
}

// ★ 複数ユーザーの情報を「1件ずつ直列await」ではなく、まとめて（最大30件ずつの"in"クエリで）取得する共通ヘルパー。
//   個別に.get()するより大幅に高速。デフォルトでは「3時間以内にキャッシュ済み」のIDは除外するが、
//   forceRefresh:trueで強制的に最新化できる。lastCheckedTalkIdを渡すと、そのトークの
//   最終確認日時(userLastCheckedCache)も同時に更新する。
async function fetchAndCacheUsers(userIds, options = {}) {
  const { forceRefresh = false, lastCheckedTalkId = null } = options;

  const idsToFetch = Array.from(new Set(userIds)).filter(
    (id) => id && (forceRefresh || !isUserCacheFresh(id))
  );
  if (idsToFetch.length === 0) return;

  const CHUNK_SIZE = 30; // ★ Firestoreの"in"クエリは1回あたり最大30件まで
  const chunks = [];
  for (let i = 0; i < idsToFetch.length; i += CHUNK_SIZE) {
    chunks.push(idsToFetch.slice(i, i + CHUNK_SIZE));
  }

  // ★ チャンクごとのクエリは並列実行する（直列awaitのボトルネックを避けるため）
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const snapshot = await getDocs(query(collection(db, "users_random"), where(documentId(), "in", chunk)));

      const foundIds = new Set();
      snapshot.forEach((doc) => {
        foundIds.add(doc.id);
        const userData = doc.data();
        setUserCache(doc.id, {
          name: userData.name || "名前未設定",
          isAdmin: userData.isAdmin || false,
          imageUrl: userData.imageUrl || "",
          profileText: userData.profileText || "",
          prizeGrantedAt: userData.prizeGrantedAt
        });

        if (lastCheckedTalkId) {
          if (!userLastCheckedCache[doc.id]) userLastCheckedCache[doc.id] = {};
          if (userData.lastChecked && userData.lastChecked[lastCheckedTalkId]) {
            userLastCheckedCache[doc.id][lastCheckedTalkId] =
              formatDateTime(userData.lastChecked[lastCheckedTalkId].toDate());
          } else {
            userLastCheckedCache[doc.id][lastCheckedTalkId] = "";
          }
        }
      });

      // ★ 見つからなかった（存在しない）IDは「不明なユーザー」として確定させておく
      chunk.forEach((id) => {
        if (!foundIds.has(id)) {
          setUserCache(id, { name: "不明なユーザー", isAdmin: false, imageUrl: "", profileText: "" });
        }
      });
    } catch (error) {
      console.error("ユーザー情報の一括取得エラー:", error);
    }
  }));
}

let userLastCheckedCache = {}; // ★ 最終確認日時用のキャッシュを追加
// ★ このセッションを開いた時点での「自分の最終確認日時」。未読区切り線の基準として使うため、
//   その後 updateLastCheckedTime() で更新されても上書きしない（一度だけ取得して保持する）
let initialLastCheckedDate = null;
// ★ 未読区切り線を挿入する対象メッセージID。初回表示時に一度だけ決定して固定する
//   （これにより、その後に自分や他人が新しく送ったメッセージの前には出なくなる）
let unreadDividerBeforeMessageId = null;
let currentRoomIsGroup = false;   // ★ メンバー3人以上ならグループ（2人以下は個人トーク扱い）
let currentRoomImageUrl = "";     // ★ グループアイコンの画像URL
let currentRoomMembers = [];   // ★ 現在のルームのメンバーIDリストを保持する変数を追加

// ★ メッセージ一覧を差分更新（docChanges）で描画するための永続状態
//   （新着のたびに全メッセージを作り直すのをやめ、変化があった分だけDOMを更新するために使う）
let talkMessagesContainer = null;  // メッセージ一覧を入れるコンテナ（初回だけ作って使い回す）
let messagesById = {};             // 全メッセージの生データ（表示可否に関わらず、返信元参照用に保持）
let messageElementsById = {};      // 画面に表示中のメッセージDOM要素（docId → element）
let fullMessageOrder = [];         // Firestoreクエリ結果の並び順そのもの（非表示メッセージも含む）

// ★ 返信機能用の状態
let replyToId = null;               // 返信先メッセージのドキュメントID
let replyPreviewBar;
let replyPreviewText;
let replyPreviewCancel;
let backToOriginalButton;
let scrollBeforeJump = null;        // ジャンプ前のスクロール位置を一時保存

// onSnapshotのリスナー解除用
let memberSubscribers = [];

let loadingOverlay;
let loadingOverlayText;
let loadingProgressBarFill;
let loadingOverlaySkipButton;
let selectionContainer; // ★ トーク本体（タイトル・メッセージ一覧など）。読み込み完了までは非表示にしておく
let noActiveOverlay;
let isInitialTalkLoad = true;   // ★ 初回のトーク表示時のみ画像読み込みを待ってオーバーレイを消す
let initialLoadSkipped = false; // ★「あとで読み込む」が押されたかどうか（押されたら以降の進捗表示・待機は行わない）
let drawerOverlay;
let accountSettingsDrawer;
let drawerCloseButton;
let accountSettingsButton;
let drawerUserId;
let drawerLogoutButton;
let drawerUsername;
let drawerEditProfileButton; // ドロワーの「プロフィールを編集」ボタン

// ★ アバターの頭文字を安全に取り出すヘルパー
function getInitial(name) {
  if (!name) return "?";
  return Array.from(name.trim())[0] || "?";
}

// ★ 頭文字アバター、または画像アバターを生成するヘルパー（size: "small" | "large" | 省略で通常サイズ）
function createAvatar(name, size, imageUrl) {
  if (imageUrl) {
    const img = document.createElement("img");
    img.classList.add("avatar-circle");
    if (size === "small") img.classList.add("small");
    if (size === "large") img.classList.add("large");
    img.src = imageUrl;
    img.alt = name || "";
    return img;
  }
  const avatar = document.createElement("div");
  avatar.classList.add("avatar-circle");
  if (size === "small") avatar.classList.add("small");
  if (size === "large") avatar.classList.add("large");
  avatar.textContent = getInitial(name);
  return avatar;
}

// ★ スマホでヘッダー分の高さを避けて #head-area を固定表示するため、
//   ヘッダーの実測高さを CSS 変数 --header-height に反映する
function updateHeaderHeightVar() {
  const header = document.getElementById("app-header");
  if (header) {
    document.documentElement.style.setProperty("--header-height", header.offsetHeight + "px");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  replyPreviewBar = document.getElementById("reply-preview-bar");
  replyPreviewText = document.getElementById("reply-preview-text");
  replyPreviewCancel = document.getElementById("reply-preview-cancel");
  backToOriginalButton = document.getElementById("back-to-original-button");

  replyPreviewCancel.addEventListener("click", cancelReply);
  backToOriginalButton.addEventListener("click", () => {
    const talkArea = document.getElementById("talk-area");
    if (scrollBeforeJump !== null) {
      talkArea.scrollTop = scrollBeforeJump;
    }
    scrollBeforeJump = null;
    backToOriginalButton.classList.add("hidden");
  });
});

// ★ 返信対象をセットし、メッセージ入力欄の上に「〇〇に返信」を表示する
function startReply(docId, userName) {
  replyToId = docId;
  replyPreviewText.textContent = `${userName}に返信`;
  replyPreviewBar.classList.remove("hidden");
  if (messageInput) messageInput.focus();
}

// ★ 返信状態を解除する
function cancelReply() {
  replyToId = null;
  replyPreviewBar.classList.add("hidden");
}

// ★ 引用元メッセージのテキストからタグを除いたプレーンテキストを取り出す
function stripTagsToPlainText(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, "text/html");
  return (doc.body.textContent || "").trim();
}

// ★ メッセージの上に表示する「返信元プレビュー」ブロック（ラベル＋引用バブル）を組み立てる
function buildReplyContext(replyTargetId, messagesById) {
  const context = document.createElement("div");
  context.classList.add("reply-context");

  const target = messagesById[replyTargetId];

  const label = document.createElement("p");
  label.classList.add("reply-context-label");

  const quote = document.createElement("div");
  quote.classList.add("reply-context-quote");

  if (!target) {
    label.textContent = "返信";
    quote.classList.add("reply-context-quote-missing");
    quote.textContent = "元のメッセージは見つかりません";
    context.appendChild(label);
    context.appendChild(quote);
    return context;
  }

  const cached = getUserCache(target.userId) || {};
  const targetName = cached.name || "不明なユーザー";
  label.textContent = `${targetName}に返信`;

  // ★ 引用元メッセージが自分のものなら青、そうでなければ薄いグレーにする
  quote.classList.add(target.userId === myUserId ? "reply-context-quote-own" : "reply-context-quote-other");

  let snippetText = "";
  if (target.message && target.message.trim() !== "") {
    snippetText = stripTagsToPlainText(target.message);
  } else if (target.imageUrl) {
    snippetText = "[画像]";
  } else if (Array.isArray(target.choices) && target.choices.length > 0) {
    snippetText = `[アンケート] ${target.message || ""}`;
  }
  quote.textContent = snippetText;

  quote.addEventListener("click", () => {
    jumpToMessage(replyTargetId);
  });

  context.appendChild(label);
  context.appendChild(quote);
  return context;
}

// ★ 指定したメッセージまでスクロールしてジャンプし、「元のメッセージにもどる」ボタンを表示する
function jumpToMessage(targetId) {
  const targetEl = document.getElementById("msg-" + targetId);
  if (!targetEl) return;

  const talkArea = document.getElementById("talk-area");
  if (scrollBeforeJump === null && talkArea) {
    scrollBeforeJump = talkArea.scrollTop;
  }

  targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
  targetEl.classList.add("jump-highlight");
  setTimeout(() => targetEl.classList.remove("jump-highlight"), 1400);

  if (backToOriginalButton) backToOriginalButton.classList.remove("hidden");
}

document.addEventListener("DOMContentLoaded", () => {
  updateHeaderHeightVar();
  window.addEventListener("resize", updateHeaderHeightVar);

  const header = document.getElementById("app-header");
  if (header && window.ResizeObserver) {
    const headerResizeObserver = new ResizeObserver(() => updateHeaderHeightVar());
    headerResizeObserver.observe(header);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  loadingOverlay = document.getElementById("loading-overlay");
  loadingOverlayText = document.getElementById("loading-overlay-text");
  loadingProgressBarFill = document.getElementById("loading-progress-bar-fill");
  loadingOverlaySkipButton = document.getElementById("loading-overlay-skip-button");
  selectionContainer = document.getElementById("selection-container");
  noActiveOverlay = document.getElementById("no-active-overlay");

  // ★「あとで読み込む」：いつ押しても即座にオーバーレイを閉じてトークを表示する
  loadingOverlaySkipButton.addEventListener("click", () => {
    initialLoadSkipped = true;
    hideLoadingOverlayNow();
  });
  
  drawerOverlay = document.getElementById("drawerOverlay");
  accountSettingsDrawer = document.getElementById("accountSettingsDrawer");
  drawerCloseButton = document.getElementById("drawerCloseButton");
  accountSettingsButton = document.getElementById("setting-button");

  drawerUserId = document.getElementById("drawerUserId");
  drawerLogoutButton = document.getElementById("logout-button");
  drawerUsername = document.getElementById("drawerUsername");
  drawerEditProfileButton = document.getElementById("drawer-edit-profile-button");

  accountSettingsButton.addEventListener("click", openDrawer);
  drawerCloseButton.addEventListener("click", closeDrawer);
  drawerOverlay.addEventListener("click", closeDrawer);
  drawerLogoutButton.addEventListener("click", handleLogout);

  // ドロワー内の「プロフィールをみる」ボタン
  drawerEditProfileButton.addEventListener("click", () => {
    closeDrawer();
    openProfileModal(myUserId, false); // 自分のプロフィールを表示するだけ（編集モードにはしない）
  });
});

function openDrawer() {
  accountSettingsDrawer.classList.add("is-open");
  drawerOverlay.classList.add("is-open");
}
function closeDrawer() {
  accountSettingsDrawer.classList.remove("is-open");
  drawerOverlay.classList.remove("is-open");
}

document.addEventListener("DOMContentLoaded", () => {
  onAuthStateChanged(auth, async (user) => {
    try {
      if (user) {
        myUserId = user.email.split("@")[0];
        drawerUserId.textContent = myUserId;

        const userSnapshot = await getDoc(doc(db, "users_random", myUserId));
        const userData = userSnapshot.data();

        if (userData.isActive) {
          drawerUsername.textContent = userData.name;
          meIsAdmin = userData.isAdmin;
          if (meIsAdmin) {
            drawerUsername.classList.add("admin");
          } else if (hasActivePrize({ prizeGrantedAt: toMillisOrNull(userData.prizeGrantedAt) })) {
            drawerUsername.classList.add("prize");
          }
          myUid = userData.uid;

          setUserCache(myUserId, {
            name: userData.name,
            isAdmin: userData.isAdmin,
            imageUrl: userData.imageUrl || "",
            profileText: userData.profileText || "",
            prizeGrantedAt: userData.prizeGrantedAt
          });

          talkId = getParmFromUrl("id");

          // ★ 問題投稿サイト（意見募集）のトークにだけ、サイトへのリンクバナーを表示する
          const problemPostingBanner = document.getElementById("problem-posting-banner");
          if (problemPostingBanner) {
            problemPostingBanner.classList.toggle("hidden", talkId !== "1problemposting");
          }

          // ★ 未読区切り線の基準日時を、この後 lastChecked が更新される前に一度だけ取得しておく
          if (userData.lastChecked && userData.lastChecked[talkId]) {
            initialLastCheckedDate = userData.lastChecked[talkId].toDate();
          }

          // ★ メンバーのリアルタイム監視・キャッシュ化を開始（ここでルーム情報も同時に取得し、
          //   同じドキュメントの二重取得を避けるため getAllTalkData にそのまま渡して使い回す）
          setLoadingStage("トークルーム・メンバー情報を読み込んでいます...", 10);
          const preloadedRoomSnapshot = await setupMemberSnapshots(talkId);

          // ★ プッシュ通知の初期化（失敗してもトーク表示には影響させない）
          initPush(db, myUserId);
          setupPushButton("enable-push-button");

          getAllTalkData(talkId, preloadedRoomSnapshot);

          // ★ ルームごとの入力中メッセージ下書きを復元
          restoreMessageDraft();

          // ★ ローディングオーバーレイは、最初のトーク表示＋画像読み込み完了まで getAllTalkData 側で消す
      } else {
        loadingOverlay.classList.add("hidden");
        noActiveOverlay.classList.remove("hidden");
        // window.location.href = "404.html";
      }
        
        
      } else {
        console.log("logout");
        // ログアウト時にリスナーをすべて解除
        memberSubscribers.forEach(unsub => unsub());
        memberSubscribers = [];
        window.location.href = "./index.html";
      }
    } catch (error) {
      console.log(error);
      await AppDialog.alert(error.message || String(error));
    }
  });
});

// ★ ルームメンバーの情報を裏側でリアルタイムに監視してキャッシュを更新する関数
//   取得したルームのスナップショットをそのまま返す（呼び出し元のgetAllTalkDataで同じドキュメントを
//   二重に取得しないよう再利用するため）
async function setupMemberSnapshots(talkId) {
  try {
    const roomSnapshot = await getDoc(doc(db, "KokoKengaku", talkId));
    if (!roomSnapshot.exists()) return null;

    const roomData = roomSnapshot.data();
    const memberUserIds = roomData.members || [];
    currentRoomMembers = memberUserIds; // ★ ルームに所属するメンバーID一覧を保持

    // ★ 以前はメンバー1人につき1本ずつリアルタイムリスナーを張っていたが、
    //   人数分の同時接続・初期データ待ちがロードを重くしていたため、
    //   ページ読み込み時に1回だけ、まとめて（"in"クエリで）取得する方式に変更した。
    //   代わりに、メンバー一覧モーダルは開くたびに再取得して最新化する（getMemberの呼び出し元を参照）。
    memberSubscribers.forEach(unsub => unsub());
    memberSubscribers = [];

    // ★ 3時間以内にキャッシュ済みのメンバーは読み直さない（最終確認日時は、メンバー一覧モーダルを開いたときに取得する）
    await fetchAndCacheUsers(memberUserIds);

    return roomSnapshot;
  } catch (error) {
    console.error("メンバーの監視設定に失敗しました:", error);
    return null;
  }
}

const handleLogout = async () => {
  const isConfirmed = await AppDialog.confirm("ログアウトしますか？");
  if (isConfirmed) {
    try {
      await logoutPush(); // ★ この端末への通知紐づけを解除
      clearUserCache(); // ★ 端末に残っているユーザー情報のキャッシュを消す
      await signOut(auth);
      console.log("ログアウトしました！");
      await AppDialog.alert("ログアウトしました。");
    } catch (error) {
      console.error("ログアウトエラー:", error);
      await AppDialog.alert("ログアウトに失敗しました。");
    }
  }
};

// ★ 未読区切り線（「ここから未読」）のDOMを作る
function buildUnreadDivider() {
  const divider = document.createElement("div");
  divider.id = "unread-divider";
  divider.classList.add("unread-divider");

  const lineLeft = document.createElement("span");
  lineLeft.classList.add("unread-divider-line");

  const label = document.createElement("span");
  label.classList.add("unread-divider-label");
  label.textContent = "ここから未読";

  const lineRight = document.createElement("span");
  lineRight.classList.add("unread-divider-line");

  divider.appendChild(lineLeft);
  divider.appendChild(label);
  divider.appendChild(lineRight);
  return divider;
}

// ★ talk-area のスクロール位置を合わせる。
//   未読区切り線があればそれが一番上に来るように、無ければ一番下（最新メッセージ）に来るようにする。
//   #selection-container が非表示（display:none）の間はスクロール量を正しく計算できないため、
//   表示された直後（hideLoadingOverlayNow）にも呼び直す必要がある。
function scrollTalkAreaToTarget() {
  const talkAreaEl = document.getElementById("talk-area");
  if (!talkAreaEl) return;

  const dividerEl = document.getElementById("unread-divider");
  if (dividerEl) {
    dividerEl.scrollIntoView({ block: "start", behavior: "auto" });
  } else if (initialLastCheckedDate === null) {
    // ★ 一度もこのトークに入ったことがない（最終確認日時が記録されていない）場合は、
    //   一番上＝最初のメッセージまでスクロールする
    talkAreaEl.scrollTop = 0;
  } else {
    talkAreaEl.scrollTop = talkAreaEl.scrollHeight;
  }
}

// ★ ローディングオーバーレイの段階テキストと、その下の進捗バーをまとめて更新する
//   （画像読み込み段階は対象外。0〜100の数値で進捗バーの幅を指定する）
function setLoadingStage(text, percent) {
  if (loadingOverlayText) {
    loadingOverlayText.textContent = text;
  }
  if (loadingProgressBarFill && typeof percent === "number") {
    const clamped = Math.max(0, Math.min(100, percent));
    loadingProgressBarFill.style.width = `${clamped}%`;
  }
}

// ★ ローディングオーバーレイを即座に閉じ、裏に隠していたトーク本体を表示する
function hideLoadingOverlayNow() {
  loadingOverlay.classList.add("hidden");
  loadingOverlaySkipButton.classList.add("hidden");
  if (selectionContainer) {
    selectionContainer.classList.remove("hidden");
  }
  // ★ 非表示（display:none）の間はスクロール位置の指定が効かないため、
  //   表示された直後に改めてスクロール位置を合わせ直す
  scrollTalkAreaToTarget();
}

// ★ 渡された画像要素すべての読み込み（成功／失敗どちらでも）を待ってからオーバーレイを閉じる。
//   読み込み中は「画像を読み込んでいます (n/m)」を表示する。
//   「あとで読み込む」が既に押されていれば何もしない（既にオーバーレイは閉じている）。
async function waitForImagesThenHideOverlay(images) {
  if (initialLoadSkipped) return;

  if (!images || images.length === 0) {
    hideLoadingOverlayNow();
    return;
  }

  const total = images.length;
  let loadedCount = 0;

  loadingOverlayText.textContent = `画像を読み込んでいます (0/${total})`;
  loadingOverlaySkipButton.classList.remove("hidden");

  await Promise.all(images.map((img) => {
    return new Promise((resolve) => {
      const onDone = () => {
        loadedCount++;
        if (!initialLoadSkipped) {
          loadingOverlayText.textContent = `画像を読み込んでいます (${loadedCount}/${total})`;
        }
        resolve();
      };
      // すでに読み込み済み（キャッシュ等）ならすぐ完了扱いにする
      if (img.complete) {
        onDone();
        return;
      }
      img.addEventListener("load", onDone, { once: true });
      img.addEventListener("error", onDone, { once: true });
    });
  }));

  if (!initialLoadSkipped) {
    hideLoadingOverlayNow();
  }
}

// ★ トーク画面上部のタイトル＋アイコンを決める。
//   個人トーク(メンバー2人以下)は「相手の名前とアイコン」、グループは「グループ名とグループアイコン」
function applyRoomHeader(roomData) {
  const talkTitle = document.getElementById("talk-title");
  const avatarHolder = document.getElementById("talk-title-avatar");
  const members = roomData.members || currentRoomMembers || [];
  currentRoomIsGroup = members.length >= 3;
  currentRoomImageUrl = roomData.imageUrl || "";

  let name;
  let imageUrl;
  if (currentRoomIsGroup) {
    name = roomData.title || "";
    imageUrl = currentRoomImageUrl;
  } else {
    const partnerId = members.find((id) => id !== myUserId) || myUserId;
    const cached = getUserCache(partnerId) || {};
    name = cached.name || partnerId;
    imageUrl = cached.imageUrl || "";
    if (partnerId === myUserId) name = `${name}（自分）`;
  }

  talkTitle.textContent = name;
  if (avatarHolder) {
    avatarHolder.innerHTML = "";
    avatarHolder.appendChild(createAvatar(name, undefined, imageUrl));
  }
}

// ★ 通知タイトルに使うルーム名。個人トークはルーム名なし（送信者名だけの通知にする）
function getNotifyRoomTitle() {
  if (!currentRoomIsGroup) return "";
  const titleEl = document.getElementById("talk-title");
  return titleEl ? titleEl.textContent : "";
}

async function getAllTalkData(talkId, preloadedRoomSnapshot) {
  const talkTitle = document.getElementById("talk-title");
  const talkArea = document.getElementById("talk-area");

  try {
    // ★ setupMemberSnapshotsで既に取得済みのスナップショットがあればそれを再利用し、
    //   同じドキュメントへの二重リクエストを避ける（無ければ念のため自分で取得する）
    let roomSnapshot = preloadedRoomSnapshot;
    if (!roomSnapshot) {
      if (isInitialTalkLoad && !initialLoadSkipped) {
        setLoadingStage("トークルーム情報を読み込んでいます...", 25);
      }
      roomSnapshot = await getDoc(doc(db, "KokoKengaku", talkId));
    }
    const roomData = roomSnapshot.data();
    applyRoomHeader(roomData);

    updateDoc(doc(db, "users_random", myUserId), {
      [`unreadCounts.${talkId}`]: 0
    }).catch(err => console.error("未読リセットエラー:", err));
    

    onSnapshot(
      query(collection(db, "KokoKengaku", talkId, "talk"), orderBy("time", "asc")),
      async (messageSnapshot) => {
        // ★ このスナップショットが「初回のトーク表示」かどうかを固定しておく
        //   （isInitialTalkLoad はこの後すぐ false にするため、判定結果をローカルに保持する）
        const isThisInitialLoad = isInitialTalkLoad;
        if (isThisInitialLoad) {
          isInitialTalkLoad = false;
        }

        // ★ メッセージ一覧のコンテナは初回だけ作って talkArea に設置し、以降は使い回す
        //   （毎回作り直すのをやめて、変化があった差分（docChanges）だけをDOMに反映する）
        if (!talkMessagesContainer) {
          talkArea.innerHTML = "";
          talkMessagesContainer = document.createElement("div");
          talkArea.appendChild(talkMessagesContainer);
        }

        const changes = messageSnapshot.docChanges();

        // ★ このバッチで新たに必要になる送信者情報を、1件ずつawaitするのではなく、
        //   まとめて（最大30件ずつの"in"クエリで並列に）取得しておく
        const candidateSenderIds = [];
        changes.forEach((change) => {
          if (change.type === "removed") return;
          const data = change.doc.data();
          if (data.isDisplay === false) return;
          if (data.userId) candidateSenderIds.push(data.userId);
        });
        await fetchAndCacheUsers(candidateSenderIds);

        // ★ このバッチで表示された画像要素を集めておく（初回表示時の読み込み待ちに使う）
        const imagesInThisRender = [];

        const totalChanges = changes.length;
        let processedChanges = 0;

        // ★ 1件分のメッセージDOMを組み立てる（送信者情報は上で取得済みの前提なのでawait不要）
        const buildMessageElement = (talkDoc, messageData) => {
          const message = document.createElement("div");
          message.id = "msg-" + talkDoc.id; // ★ 返信ジャンプ先として参照するためのID
          message.classList.add("message");

          const messageUserId = messageData.userId;
          const isOwnMessage = messageUserId === myUserId;
          message.classList.add(isOwnMessage ? "message-own" : "message-other");

          const messageUser = document.createElement("p");
          let senderName = "不明なユーザー";
          let isAdmin = false;
          let senderImageUrl = "";
          let senderHasPrize = false;

          if (messageUserId) {
            const cached = getUserCache(messageUserId) || { name: "不明なユーザー", isAdmin: false, imageUrl: "" };
            senderName = cached.name;
            isAdmin = cached.isAdmin;
            senderImageUrl = cached.imageUrl;
            senderHasPrize = hasActivePrize(cached);
          }

          let displayTime = "時間不明";
          if (messageData.time) {
            const dateObject = messageData.time.toDate();
            displayTime = formatDateTime(dateObject);
          }

          const readByList = messageData.readBy || [];
          if (messageData.userId !== myUserId && !readByList.includes(myUserId)) {
            updateDoc(doc(db, "KokoKengaku", talkId, "talk", talkDoc.id), {
                readBy: arrayUnion(myUserId)
              })
              .catch(err => console.error("既読更新エラー:", err));
          }
          
          let displayReadCount = readByList.length;
          const readSpan = document.createElement("span");
          readSpan.textContent = `既読:${displayReadCount}人`;
          readSpan.style.textDecoration = 'underline';
          readSpan.style.cursor = 'pointer';
          readSpan.addEventListener("click", () => {
            openReadByModal(readByList);
          });

          const senderNameSpan = document.createElement("span");
          senderNameSpan.textContent = `${senderName} `;
          senderNameSpan.classList.add("clickable-user");
          senderNameSpan.addEventListener("click", () => {
            openProfileModal(messageUserId);
          });
          
          const displayTimeSpan = document.createElement("span");
          displayTimeSpan.textContent = `${displayTime} `;
          messageUser.classList.add("message-user");
          if (isAdmin) {
            senderNameSpan.classList.add("admin");
          } else if (senderHasPrize) {
            senderNameSpan.classList.add("prize");
          }
          const editSpan = document.createElement("span");
          editSpan.textContent = `編集`;
          editSpan.style.textDecoration = 'underline';
          editSpan.style.cursor = 'pointer';
          editSpan.addEventListener("click", () => {
            openEditModal(talkDoc.id, messageData.userId, messageData.message, messageData.time);
          });

          // ★ 転送（管理者のみ）
          const forwardSpan = document.createElement("span");
          forwardSpan.textContent = `転送`;
          forwardSpan.style.textDecoration = 'underline';
          forwardSpan.style.cursor = 'pointer';
          forwardSpan.addEventListener("click", () => {
            openForwardModal([talkDoc]);
          });

          // ★ 自分の発言では吹き出しの上に自分の名前を出さない（相手の発言のみ表示）
          if (!isOwnMessage) {
            messageUser.appendChild(senderNameSpan);
          }
          messageUser.appendChild(displayTimeSpan);
          messageUser.appendChild(readSpan);
          if (meIsAdmin || messageData.userId === myUserId) {
            messageUser.appendChild(document.createTextNode(" "));
            messageUser.appendChild(editSpan);
          }
          if (meIsAdmin) {
            messageUser.appendChild(document.createTextNode(" "));
            messageUser.appendChild(forwardSpan);
          }

          // ★ 一括選択用チェックボックス（削除・転送をまとめて行う機能。選択できる範囲は編集と同じ権限）
          if (meIsAdmin || messageData.userId === myUserId) {
            const selectLabel = document.createElement("label");
            selectLabel.classList.add("message-select-label");

            const selectCheckbox = document.createElement("input");
            selectCheckbox.type = "checkbox";
            selectCheckbox.classList.add("message-select-checkbox");
            selectCheckbox.checked = selectedMessageIds.has(talkDoc.id);
            selectCheckbox.addEventListener("change", () => {
              if (selectCheckbox.checked) {
                selectedMessageIds.add(talkDoc.id);
              } else {
                selectedMessageIds.delete(talkDoc.id);
              }
              updateSelectionActionBar();
            });

            selectLabel.appendChild(selectCheckbox);
            selectLabel.appendChild(document.createTextNode("選択"));

            messageUser.appendChild(document.createTextNode(" "));
            messageUser.appendChild(selectLabel);
          }

          // ★ アバター + 本文をまとめた行を組み立て（自分は右寄せ、相手は左寄せ＋アバター表示）
          const bubbleCol = document.createElement("div");
          bubbleCol.classList.add("bubble-col");
          bubbleCol.appendChild(messageUser);

          // ★ 表示順：送信者・日付など → 返信元のメッセージ → 今回のメッセージ
          if (messageData.replyTo) {
            const replyContext = buildReplyContext(messageData.replyTo, messagesById);
            bubbleCol.appendChild(replyContext);
          }

          const hasText = messageData.message && messageData.message.trim() !== "";

          // ★ 画像は吹き出しの外に、その下にテキストがあれば吹き出しで表示する
          if (messageData.imageUrl) {
            const img = document.createElement("img");
            img.src = messageData.imageUrl;
            img.alt = "送信された画像";
            img.classList.add("message-image");

            img.addEventListener("load", () => {
              // 実際の画像の縦横比に書き換える（アスペクト比が変わるので、必要に応じて箱は縮む）
              img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
              img.classList.add("loaded");
            });

            imagesInThisRender.push(img);
            bubbleCol.appendChild(img);
          }

          // ★ 返信矢印を作る共通ヘルパー
          const makeReplyIcon = () => {
            const replyIcon = document.createElement("span");
            replyIcon.textContent = "↩︎";
            replyIcon.classList.add("reply-action");
            replyIcon.title = "返信";
            replyIcon.addEventListener("click", () => {
              startReply(talkDoc.id, senderName);
            });
            return replyIcon;
          };

          // ★ テキスト本文＋返信矢印を横並びに配置する
          if (hasText) {
            const messageText = document.createElement("p");
            messageText.classList.add("message-text");
            const safeContent = sanitizeHtmlToOnlyLinks(messageData.message);
            messageText.appendChild(safeContent);

            const bubbleContentRow = document.createElement("div");
            bubbleContentRow.classList.add("bubble-content-row");
            bubbleContentRow.appendChild(messageText);
            bubbleContentRow.appendChild(makeReplyIcon());

            bubbleCol.appendChild(bubbleContentRow);
          }

          // ★ アンケートがあれば、テキストの下にアンケートウィジェットを表示する
          if (Array.isArray(messageData.choices) && messageData.choices.length > 0) {
            const pollWidget = buildPollWidget(talkDoc.id, messageData.choices, messageData.answer || {});
            bubbleCol.appendChild(pollWidget);
          }

          // ★ テキストが無いメッセージ（画像単独・アンケート単独）にも返信矢印を出す
          if (!hasText) {
            const standaloneRow = document.createElement("div");
            standaloneRow.classList.add("bubble-content-row", "standalone-reply-row");
            standaloneRow.appendChild(makeReplyIcon());
            bubbleCol.appendChild(standaloneRow);
          }

          const messageRow = document.createElement("div");
          messageRow.classList.add("message-row");
          if (!isOwnMessage) {
            const rowAvatar = createAvatar(senderName, undefined, senderImageUrl);
            rowAvatar.classList.add("clickable-user");
            rowAvatar.addEventListener("click", () => {
              openProfileModal(messageUserId);
            });
            messageRow.appendChild(rowAvatar);
          }
          messageRow.appendChild(bubbleCol);

          message.appendChild(messageRow);
          return message;
        };

        // ★ 表示中のメッセージのDOM要素の中から、fullMessageOrder上でindexより後ろにある
        //   最初の要素を探す（次のメッセージの直前に挿入するための基準点として使う）
        const findNextRenderedElementAfter = (index) => {
          for (let i = index + 1; i < fullMessageOrder.length; i++) {
            const el = messageElementsById[fullMessageOrder[i]];
            if (el) return el;
          }
          return null;
        };

        changes.forEach((change) => {
          processedChanges++;
          if (isThisInitialLoad && !initialLoadSkipped && totalChanges > 0) {
            const percent = Math.round((processedChanges / totalChanges) * 100);
            // ★ このステージは進捗バー全体の30%〜100%の区間にマッピングする
            setLoadingStage(`トークを読み込んでいます (${percent}%)`, 30 + (percent / 100) * 70);
          }

          const talkDoc = change.doc;
          const docId = talkDoc.id;
          const previousData = messagesById[docId];
          const messageData = change.type === "removed" ? previousData : talkDoc.data();
          if (!messageData) return; // 存在しないデータのremovedは無視

          // ★ Firestoreの並び順そのもの（非表示メッセージも含む）を、公式手順通りに更新する
          if (change.oldIndex !== -1 && change.oldIndex < fullMessageOrder.length) {
            fullMessageOrder.splice(change.oldIndex, 1);
          }
          if (change.type !== "removed" && change.newIndex !== -1) {
            fullMessageOrder.splice(change.newIndex, 0, docId);
          }

          // ★ 返信元参照用のマップは、表示可否に関わらず全メッセージ分を保持する
          if (change.type === "removed") {
            delete messagesById[docId];
          } else {
            messagesById[docId] = messageData;
          }

          // ★ 未読区切り線を出す位置は、初回表示時にのみ判定して固定する
          //   （このブロックは isThisInitialLoad が true の初回スナップショットでしか実行されないため、
          //    　その後に自分や他人が新しく送ったメッセージが対象になることはない）
          if (isThisInitialLoad && unreadDividerBeforeMessageId === null && initialLastCheckedDate && messageData.time && messageData.isDisplay !== false) {
            const messageDate = messageData.time.toDate();
            if (messageDate > initialLastCheckedDate) {
              unreadDividerBeforeMessageId = docId;
            }
          }

          const shouldDisplay = change.type !== "removed" && messageData.isDisplay !== false;
          const existingElement = messageElementsById[docId];

          if (!shouldDisplay) {
            // ★ 削除・非表示化された場合は、表示されていれば取り除くだけ
            if (existingElement) {
              existingElement.remove();
              delete messageElementsById[docId];
            }
            return;
          }

          const messageElement = buildMessageElement(talkDoc, messageData);
          const isDividerTarget = docId === unreadDividerBeforeMessageId;
          const existingDividerEl = document.getElementById("unread-divider");

          // ★ 管理者が送信時刻を編集した場合など、並び順が変わることがあるため、
          //   既存要素（と、対象なら区切り線）を一旦外してから、正しい位置へ入れ直す
          if (existingElement) {
            existingElement.remove();
          }
          if (isDividerTarget && existingDividerEl) {
            existingDividerEl.remove();
          }

          const idxInFullOrder = fullMessageOrder.indexOf(docId);
          const referenceElement = findNextRenderedElementAfter(idxInFullOrder);
          talkMessagesContainer.insertBefore(messageElement, referenceElement || null);

          // ★ 固定された対象メッセージの直前にだけ、区切り線を挿入する
          if (isDividerTarget) {
            talkMessagesContainer.insertBefore(buildUnreadDivider(), messageElement);
          }
          messageElementsById[docId] = messageElement;
        });

        // ★ 初回表示時は「未読区切り線」があればそれを一番上に、無ければ一番下にスクロール。
        //   2回目以降（新着メッセージ受信時など）は、これまで通り一番下にスクロールする。
        if (isThisInitialLoad) {
          scrollTalkAreaToTarget();
        } else {
          talkArea.scrollTop = talkArea.scrollHeight;
        }

        updateLastCheckedTime(talkId, myUserId);

        // ★ 初回のトーク表示時のみ、画像の読み込みが終わる（またはスキップされる）までオーバーレイを出したままにする
        if (isThisInitialLoad) {
          // ★ 画像を除く読み込みはここまでで完了なので、進捗バーを満タンにしておく
          //   （以降の画像読み込み待ちは進捗バーの対象外）
          if (loadingProgressBarFill) loadingProgressBarFill.style.width = "100%";
          await waitForImagesThenHideOverlay(imagesInThisRender);
        }
      });
    
  } catch (error) {
    console.error("データ取得エラー:", error);
    await AppDialog.alert(error.message || String(error));
  }
}

function sanitizeHtmlToOnlyLinks(htmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');
  const box = document.createDocumentFragment();

  // 再帰的にノードを処理するヘルパー関数
  function processNode(node) {
    // 1. テキストノードの場合：そのままテキストノードを返す
    if (node.nodeType === Node.TEXT_NODE) {
      return document.createTextNode(node.textContent);
    }

    // 要素ノード（ELEMENT_NODE）の処理
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toUpperCase();
      let resultElement = null;

      // 各タグに応じた要素の生成
      if (tagName === 'A') {
        resultElement = document.createElement('a');
        const rawHref = node.getAttribute('href') || '#';
        resultElement.setAttribute('href', rawHref);
        resultElement.setAttribute('target', '_blank');
        resultElement.setAttribute('rel', 'noopener noreferrer');
        resultElement.classList.add('chat-link');
      } 
      else if (tagName === 'UNDERLINE') {
        resultElement = document.createElement('span');
        resultElement.classList.add('underline');
      } 
      else if (tagName === 'LARGE') {
        resultElement = document.createElement('span');
        resultElement.classList.add('large');
      } 
      else if (tagName === 'MAINCOLOR') {
        resultElement = document.createElement('span');
        resultElement.classList.add('main-color');
      }
      else if (tagName === 'SMALL') {
        resultElement = document.createElement('span');
        resultElement.classList.add('small');
      }
      else if (tagName === 'EMOJI') {
        resultElement = document.createElement('span');
        resultElement.classList.add('emoji');
      }

      if (resultElement) {
        // 許可されたタグの場合：子ノードを再帰的に処理して自身に追加する
        node.childNodes.forEach(child => {
          const processedChild = processNode(child);
          if (processedChild) {
            resultElement.appendChild(processedChild);
          }
        });
        return resultElement;
      } else {
        // 許可されていない未知のタグ（例: <div>, <p> など）の場合：
        // タグ自体は無視し、中身の子ノード（テキストや許可タグ）だけを平坦化して返す
        const fragment = document.createDocumentFragment();
        node.childNodes.forEach(child => {
          const processedChild = processNode(child);
          if (processedChild) {
            fragment.appendChild(processedChild);
          }
        });
        return fragment;
      }
    }

    return null;
  }

  // ルート直下の子ノードを順次処理して documentFragment に追加
  Array.from(doc.body.childNodes).forEach(node => {
    const processed = processNode(node);
    if (processed) {
      box.appendChild(processed);
    }
  });

  return box;
}


function getParmFromUrl(parm) {
  const params = new URLSearchParams(window.location.search);
  return params.get(parm);
}

function formatDateTime(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

// ★ ImgBBへの画像アップロード共通処理（チャット画像・プロフィールアイコン共通で使用）
let imgbbApiKeyCache = null;
async function uploadImageToImgbb(file) {
  if (!imgbbApiKeyCache) {
    const keyDoc = await getDoc(doc(db, "system_keys", "imgbb"));
    if (!keyDoc.exists()) {
      throw new Error("APIキーの設定が見つかりません。セキュリティルールかドキュメントを確認してください。");
    }
    imgbbApiKeyCache = keyDoc.data().apiKey;
  }

  const formData = new FormData();
  formData.append("image", file);

  const response = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbApiKeyCache}`, {
    method: "POST",
    body: formData
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error("ImgBBのアップロード処理に失敗しました。");
  }
  return result.data.url;
}

let messageInput;
let messageAddButton;
document.addEventListener("DOMContentLoaded", () => {
  messageInput = document.getElementById("message-input");
  messageAddButton = document.getElementById("message-add-button");
  
  messageInput.addEventListener("input", () => {
    updateMessageAddButtonState();
    saveMessageDraft();
  });
  
  messageAddButton.addEventListener("click", async () => {
    const talkId = getParmFromUrl("id");
    await addMessage(talkId);
  });
});

function updateMessageAddButtonState() {
  const hasMessage = messageInput && messageInput.value.trim() !== "";
  messageAddButton.disabled = !hasMessage;
}

// ★ 入力中メッセージの下書き保存機能
function getMessageDraftKey(id) {
  const targetId = id || talkId;
  return targetId ? `messageDraft_${targetId}` : null;
}

function saveMessageDraft() {
  if (!messageInput) return;
  const key = getMessageDraftKey();
  if (!key) return;
  try {
    const value = messageInput.value;
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch (error) {
    console.log(error);
  }
}

function restoreMessageDraft() {
  if (!messageInput) return;
  const key = getMessageDraftKey();
  if (!key) return;
  try {
    const savedDraft = localStorage.getItem(key);
    if (savedDraft) {
      messageInput.value = savedDraft;
      updateMessageAddButtonState();
    }
  } catch (error) {
    console.log(error);
  }
}

function clearMessageDraft(id) {
  const key = getMessageDraftKey(id);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.log(error);
  }
}

// ★ 現在のトークルームのメンバー（自分以外）へ新着通知を送る。失敗しても送信処理には影響しない
function notifyRoom(text, replyTargetId = replyToId) {

  // ★ 返信メッセージなら、返信先の投稿者（ユーザーID・表示名）を調べて通知文に使う
  let replyToUserId = null;
  let replyToName = "";
  if (replyTargetId && messagesById[replyTargetId]) {
    const target = messagesById[replyTargetId];
    replyToUserId = target.userId;
    replyToName = (getUserCache(target.userId) || {}).name || target.userId;
  }

  return sendMessageNotification(db, {
    roomId: talkId,
    roomTitle: getNotifyRoomTitle(),
    memberIds: currentRoomMembers,
    senderId: myUserId,
    senderName: drawerUsername.textContent,
    text,
    replyToUserId,
    replyToName
  });
}

// ★ アンケートに回答（または回答を変更）したことを、トークルームの全メンバー（本人を除く）に通知する
function notifyPollAnswer(isChange) {
  const roomTitle = getNotifyRoomTitle();
  const name = drawerUsername.textContent;
  return sendPushToUsers(db, {
    targetIds: (currentRoomMembers || []).filter((id) => id && id !== myUserId),
    title: roomTitle ? `${roomTitle}|${name}` : name,
    body: isChange ? `${name}がアンケートの回答を変更しました` : `${name}がアンケートに回答しました`,
    url: `talk.html?id=${encodeURIComponent(talkId)}`
  });
}

// ★ 未読カウンター：メッセージを送るとき、ルームの他メンバー全員の users_random/{id}.unreadCounts.{roomId} を +1 する。
//   受信側（app.html）はこの値を読むだけで未読数が分かるので、ルームごとに件数を数えるクエリが要らなくなる。
//   ・メッセージの書き込みより「前」に加算する（受信者が部屋を開いていて即「見た」扱いになっても、
//     加算が後から追いついて未読が残る、という順序の逆転を避けるため）
//   ・1人分が失敗しても他の人や送信自体には影響させない
async function bumpUnreadCounts(roomId, memberIds, senderId, delta = 1) {
  const targets = (memberIds || []).filter((id) => id && id !== senderId);
  if (targets.length === 0) return;
  const results = await Promise.allSettled(targets.map((id) =>
    setDoc(doc(db, "users_random", id), { unreadCounts: { [roomId]: increment(delta) } }, { merge: true })
  ));
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.warn(`未読カウンターの加算に失敗（${failed.length}/${targets.length}件）:`, failed[0].reason);
  }
}

async function addMessage(talkId) {
  const message = messageInput.value.trim();
  messageAddButton.disabled = true;
  messageAddButton.textContent = "送信中...";
  const user = auth.currentUser;
  const myUserId = user.email.split("@")[0];
  const replyToSnapshot = replyToId; // ★ 送信前に返信先IDを確定させておく
  try {
    await bumpUnreadCounts(talkId, currentRoomMembers, myUserId);
    await addDoc(collection(db, "KokoKengaku", talkId, "talk"), {
        userId: myUserId,
        message: message,     
        readBy: [],
        replyTo: replyToSnapshot || null,
        time: serverTimestamp()
      });
    await updateDoc(doc(db, "KokoKengaku", talkId), {
      lastUpdatedAt: serverTimestamp() // これを追加！
    });
    notifyRoom(message, replyToSnapshot); // ★ 新着通知（待たない）
    cancelReply(); // ★ 送信成功後は返信状態を解除
    clearMessageDraft(talkId); // ★ 送信成功後は下書きをリセット
  }
  catch (error) {
    console.log(error);
  }
  finally {
    messageAddButton.disabled = true;
    messageAddButton.textContent = "送信";
    messageInput.value = "";
  }
}

// ================================
// ★ グループアイコンの変更（管理者のみ・グループのみ）
// ================================
function renderGroupIconEditor() {
  const area = document.getElementById("group-icon-area");
  if (!area) return;
  const canEdit = meIsAdmin && currentRoomIsGroup;
  area.classList.toggle("hidden", !canEdit);
  if (!canEdit) return;

  const holder = document.getElementById("group-icon-holder");
  const removeButton = document.getElementById("group-icon-remove-button");
  const titleEl = document.getElementById("talk-title");
  holder.innerHTML = "";
  holder.appendChild(createAvatar(titleEl ? titleEl.textContent : "", "large", currentRoomImageUrl));
  removeButton.classList.toggle("hidden", !currentRoomImageUrl);
}

// file が null のときは画像を削除して頭文字アイコンに戻す
async function saveGroupIcon(file) {
  const changeButton = document.getElementById("group-icon-change-button");
  const removeButton = document.getElementById("group-icon-remove-button");
  const originalText = changeButton.textContent;
  changeButton.disabled = true;
  removeButton.disabled = true;
  changeButton.textContent = file ? "アップロード中..." : "削除中...";
  try {
    const newUrl = file ? await uploadImageToImgbb(file) : "";
    await updateDoc(doc(db, "KokoKengaku", talkId), { imageUrl: newUrl });
    currentRoomImageUrl = newUrl;

    // 画面上部のアイコンとモーダル内のアイコンを更新
    const titleEl = document.getElementById("talk-title");
    const headerHolder = document.getElementById("talk-title-avatar");
    if (headerHolder) {
      headerHolder.innerHTML = "";
      headerHolder.appendChild(createAvatar(titleEl ? titleEl.textContent : "", undefined, newUrl));
    }
    renderGroupIconEditor();
  } catch (error) {
    console.error("グループアイコンの保存エラー:", error);
    await AppDialog.alert("グループアイコンの変更に失敗しました。\n" + (error.message || String(error)));
  } finally {
    changeButton.disabled = false;
    removeButton.disabled = false;
    changeButton.textContent = originalText;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("group-icon-input");
  const changeButton = document.getElementById("group-icon-change-button");
  const removeButton = document.getElementById("group-icon-remove-button");
  if (!input || !changeButton || !removeButton) return;

  changeButton.addEventListener("click", () => input.click());
  input.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    input.value = "";
    if (!file) return;
    await saveGroupIcon(file);
  });
  removeButton.addEventListener("click", async () => {
    const ok = await AppDialog.confirm("グループアイコンの画像を削除しますか？", { okText: "削除する", danger: true });
    if (ok) await saveGroupIcon(null);
  });
});

// ★ ルームの members リストに入っている人のみを表示するように修正
function getMember(talkId) {
  const memberArea = document.getElementById("member-area");
  memberArea.innerHTML = "";
  renderGroupIconEditor();

  // 自分が管理者かどうかを判定
  const isMeAdmin = (getUserCache(myUserId) || {}).isAdmin || false;

  // ★ 全キャッシュのキーではなく、ルームに属するメンバーIDリストでループを回す
  for (const userId of currentRoomMembers) {
    const cached = getUserCache(userId) || {};
    const memberName = cached.name || "不明なユーザー";
    const isAdmin = cached.isAdmin || false;
    const memberImageUrl = cached.imageUrl || "";
    let lastCheckedTimeStr = "";

    // キャッシュから対象トークルームの最終確認日時を取得
    if (userLastCheckedCache[userId] && userLastCheckedCache[userId][talkId]) {
      lastCheckedTimeStr = userLastCheckedCache[userId][talkId];
    }

    const memberElement = document.createElement("div");
    memberElement.classList.add("member-item");
    if (isAdmin) {
      memberElement.classList.add("admin");
    } else if (hasActivePrize(cached)) {
      memberElement.classList.add("prize");
    }

    // アバター + 名前
    const memberLeft = document.createElement("div");
    memberLeft.classList.add("member-left", "clickable-user");
    memberLeft.style.cursor = 'pointer';

    const avatar = createAvatar(memberName, "small", memberImageUrl);
    memberLeft.appendChild(avatar);

    const nameSpan = document.createElement("span");
    nameSpan.classList.add("member-name");
    nameSpan.textContent = memberName;
    memberLeft.appendChild(nameSpan);

    // タップ（クリック）されたらプロフィールモーダルを開く
    memberLeft.addEventListener("click", () => {
      openProfileModal(userId);
    });

    memberElement.appendChild(memberLeft);

    // 自分が管理者かつデータがある場合のみ、右側に最終確認時間を追加
    if (isMeAdmin) {
      const timeSpan = document.createElement("span");
      timeSpan.classList.add("member-last-checked");
      timeSpan.textContent = lastCheckedTimeStr ? lastCheckedTimeStr : "未確認";
      memberElement.appendChild(timeSpan);
    }

    memberArea.appendChild(memberElement);
  }
}

async function updateLastCheckedTime(talkId, myUserId) {
  try {
    await setDoc(doc(db, "users_random", myUserId), {
      lastChecked: {
        [talkId]: serverTimestamp()
      },
      // ★ 見たので、このルームの未読カウンターも0に戻す（部屋を開いている間に届いた分が残らないように）
      unreadCounts: {
        [talkId]: 0
      }
    }, { merge: true });
    console.log(`${talkId} の最終確認時刻を更新しました`);
  } catch (error) {
    console.error("最終確認時刻の更新に失敗:", error);
  }
}

let shareModalBtn;
let shareModal;
let shareModalClose;
document.addEventListener("DOMContentLoaded", () => {
  shareModalBtn = document.getElementById("share-modal-btn");
  shareModal = document.getElementById("share-modal");
  shareModalClose = document.getElementById("share-modal-close");
  
  shareModalBtn.addEventListener("click", () => {
    shareModal.classList.remove("hidden");
  });
  shareModalClose.addEventListener("click", () => {
    shareModal.classList.add("hidden");
  });
});

let toHomeButton;
document.addEventListener("DOMContentLoaded", () => {
  toHomeButton = document.getElementById("to-home-button");
  
  toHomeButton.addEventListener("click", () => {
    window.location.href = "./app.html";
  });
});

let memberButton;
let memberModal;
let memberModalClose;
document.addEventListener("DOMContentLoaded", () => {
  memberButton = document.getElementById("member-button");
  memberModal = document.getElementById("member-modal");
  memberModalClose = document.getElementById("member-modal-close");
  
  memberButton.addEventListener("click", async () => {
    memberModal.classList.remove("hidden");
    const talkId = getParmFromUrl("id");
    getMember(talkId); // ★ まずキャッシュから瞬時にUI描画を行う（ノンブロッキングで一瞬で開く）

    // ★ 常時リスナーを張らなくなった代わりに、開くたびに最新情報へ更新する
    await fetchAndCacheUsers(currentRoomMembers, { forceRefresh: true, lastCheckedTalkId: talkId });
    if (!memberModal.classList.contains("hidden")) {
      getMember(talkId); // 最新データで再描画
    }
  });
  memberModalClose.addEventListener("click", () => {
    memberModal.classList.add("hidden");
  });
});

let readModal;
let readModalClose;
let readArea;
document.addEventListener("DOMContentLoaded", () => {
  readModal = document.getElementById("read-modal");
  readModalClose = document.getElementById("read-modal-close");
  readArea = document.getElementById("read-area");
  
  readModalClose.addEventListener("click", () => {
    readModal.classList.add("hidden");
  });
});

// ★ 既読モーダルも基本的には既存のユーザーデータキャッシュを最優先に利用するように最適化
async function openReadByModal(readByList) {
  readArea.innerHTML = "読み込み中...";
  readModal.classList.remove("hidden");

  const fragment = document.createDocumentFragment();

  for (const userId of readByList) {
    let cached = getUserCache(userId);
    
    // 万が一キャッシュに載っていないイレギュラーなユーザーIDが含まれていた場合のみ個別get
    if (!cached) {
      try {
        const userSnapshot = await getDoc(doc(db, "users_random", userId));
      
        if (userSnapshot.exists()) {
          const userData = userSnapshot.data();
          cached = setUserCache(userId, {
            name: userData.name || "名前未設定",
            isAdmin: userData.isAdmin || false,
            imageUrl: userData.imageUrl || "",
            profileText: userData.profileText || "",
            prizeGrantedAt: userData.prizeGrantedAt
          });
        } else {
          cached = setUserCache(userId, { name: "不明なユーザー", isAdmin: false, imageUrl: "", profileText: "" });
        }
      } catch (e) {
        console.error(e);
        cached = { name: "不明なユーザー", isAdmin: false, imageUrl: "" };
      }
    }
    const name = cached.name;
    const isAdmin = cached.isAdmin;

    const p = document.createElement("p");
    p.classList.add("clickable-user");
    p.style.cursor = 'pointer';
    p.appendChild(createAvatar(name, "small", cached.imageUrl));
    const nameSpan = document.createElement("span");
    nameSpan.textContent = name;
    if (isAdmin) {
      nameSpan.classList.add("admin");
    } else if (hasActivePrize(cached)) {
      nameSpan.classList.add("prize");
    }
    p.appendChild(nameSpan);

    p.addEventListener("click", () => {
      openProfileModal(userId);
    });

    fragment.appendChild(p);
  }

  readArea.innerHTML = "";
  readArea.appendChild(fragment);
}


let messageId;
let editModal;
let editModalClose;
let newUserIdInput, newMessageInput, newMessageTimeLabel, newMessageTimeInput, newMessageChangeButton, messageDeleteButton;
document.addEventListener("DOMContentLoaded", () => {
  editModal = document.getElementById("edit-modal");
  editModalClose = document.getElementById("edit-modal-close");
  newUserIdInput = document.getElementById("new-userId-input");
  newMessageInput = document.getElementById("new-message-input");
  newMessageTimeLabel = document.getElementById("new-message-time-label");
  newMessageTimeInput = document.getElementById("new-message-time-input");
  newMessageChangeButton = document.getElementById("new-message-change-button");
  messageDeleteButton = document.getElementById("message-delete-button");
  
  editModalClose.addEventListener("click", () => {
    editModal.classList.add("hidden");
  });

  // ★ メッセージ内容が空のときは保存ボタンを無効化する
  newMessageInput.addEventListener("input", () => {
    updateMessageChangeButtonState();
  });

  newMessageChangeButton.addEventListener("click", async () => {
    // ★ 送信時刻の変更は管理者のみ反映する
    const newTimeValue = meIsAdmin ? newMessageTimeInput.value : null;
    await newMessageChange(messageId, newUserIdInput.value, newMessageInput.value, newTimeValue);
  });

  messageDeleteButton.addEventListener("click", async () => {
    if (await AppDialog.confirm('本当に削除しますか？')) {
      await messageDelete(messageId);
    }
  });
});

function updateMessageChangeButtonState() {
  const hasMessage = newMessageInput && newMessageInput.value.trim() !== "";
  newMessageChangeButton.disabled = !hasMessage;
}

// ★ Firestoreのタイムスタンプを、<input type="datetime-local"> 用のローカル日時文字列(YYYY-MM-DDTHH:mm)に変換する
function timestampToDatetimeLocalValue(timestamp) {
  const date = timestamp && typeof timestamp.toDate === "function" ? timestamp.toDate() : new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function openEditModal(thisMessageId, messageUserId, messageText, messageTime) {
  messageId = thisMessageId;
  newUserIdInput.value = messageUserId;
  newMessageInput.value = messageText;

  // ★ 送信者IDの変更は引き続き管理者限定。削除は誰でも（自分の発言・管理者は他人の発言も）可能にする
  newUserIdInput.disabled = !meIsAdmin;
  messageDeleteButton.disabled = false;

  // ★ 送信時刻の編集は管理者のみ（一般ユーザーには欄自体を見せない）
  newMessageTimeLabel.classList.toggle("hidden", !meIsAdmin);
  newMessageTimeInput.classList.toggle("hidden", !meIsAdmin);
  newMessageTimeInput.value = timestampToDatetimeLocalValue(messageTime);

  updateMessageChangeButtonState();

  editModal.classList.remove("hidden");
  
}

async function newMessageChange(messageId, newUserId, newMessage, newTimeValue) {
  try {
    const docRef = doc(db, "KokoKengaku", talkId, "talk", messageId);

    // ★ 変更前のメッセージ内容をchangeLogに記録する
    const docSnapshot = await getDoc(docRef);
    const currentData = docSnapshot.data() || {};
    const previousMessage = currentData.message || "";
    const existingChangeLog = Array.isArray(currentData.changeLog) ? currentData.changeLog : [];
    const updatedChangeLog = previousMessage !== newMessage
      ? [...existingChangeLog, previousMessage]
      : existingChangeLog;

    const updateData = {
      userId: newUserId,
      message: newMessage,
      changeLog: updatedChangeLog
    };

    // ★ 管理者が送信日時を入力していれば、それを新しい time として反映する
    if (meIsAdmin && newTimeValue) {
      const parsedDate = new Date(newTimeValue);
      if (!isNaN(parsedDate.getTime())) {
        updateData.time = Timestamp.fromDate(parsedDate);
      }
    }

    await updateDoc(docRef, updateData);
    await AppDialog.alert("変更しました。");
  }
  catch (error) {
    await AppDialog.alert(error.message || String(error));
    console.error(error);
  }
}

async function messageDelete(messageId) {
  try {
    // ★ 実際にdeleteするのではなく、isDisplayをfalseにして非表示化する
    await updateDoc(doc(db, "KokoKengaku", talkId, "talk", messageId), { isDisplay: false });
    editModal.classList.add("hidden");
    await AppDialog.alert("削除しました。");
  } catch (error) {
    await AppDialog.alert(error.message || String(error));
    console.error(error);
  }
}

// ================================
// ★ メッセージ転送機能（管理者のみ）
// ================================

let forwardModal;
let forwardModalClose;
let forwardModalLoading;
let forwardRoomList;
let pendingForwardItems = null; // ★ 転送先が選ばれるまで、転送するメッセージの内容（複数可）を一時保持する

document.addEventListener("DOMContentLoaded", () => {
  forwardModal = document.getElementById("forward-modal");
  forwardModalClose = document.getElementById("forward-modal-close");
  forwardModalLoading = document.getElementById("forward-modal-loading");
  forwardRoomList = document.getElementById("forward-room-list");

  forwardModalClose.addEventListener("click", () => {
    forwardModal.classList.add("hidden");
  });
});

// ★ 転送ボタンから呼ばれる：転送するメッセージ（1件でも複数でも可）のデータをまるごとコピーして保持しつつ、転送先ルームの一覧を表示する
async function openForwardModal(messageDocs) {
  const docsArray = Array.isArray(messageDocs) ? messageDocs : [messageDocs];

  // ★ 既読状態・返信先・表示フラグ以外は、送信者や日時も含めてそのままコピーする
  pendingForwardItems = docsArray.map((doc) => {
    const copied = Object.assign({}, doc.data());
    delete copied.readBy;
    delete copied.replyTo;
    delete copied.isDisplay;
    return copied;
  });

  forwardModal.classList.remove("hidden");
  forwardRoomList.innerHTML = "";
  forwardModalLoading.classList.remove("hidden");

  try {
    const roomsSnapshot = await getDocs(collection(db, "KokoKengaku"));

    forwardModalLoading.classList.add("hidden");
    forwardRoomList.innerHTML = "";

    const otherRooms = roomsSnapshot.docs.filter((doc) => doc.id !== talkId);

    if (otherRooms.length === 0) {
      const emptyText = document.createElement("p");
      emptyText.textContent = "転送できるトークルームがありません。";
      forwardRoomList.appendChild(emptyText);
      return;
    }

    otherRooms.forEach((roomDoc) => {
      const roomData = roomDoc.data();

      const roomItem = document.createElement("div");
      roomItem.classList.add("forward-room-item");
      roomItem.textContent = roomData.title || "（無題のルーム）";
      roomItem.addEventListener("click", () => {
        forwardMessageToRoom(roomDoc.id, roomItem);
      });

      forwardRoomList.appendChild(roomItem);
    });
  } catch (error) {
    forwardModalLoading.classList.add("hidden");
    console.error("転送先ルーム一覧の取得エラー:", error);
    await AppDialog.alert("転送先ルームの取得に失敗しました。\n" + error.message);
  }
}

// ★ 選ばれたルームへ、保持しておいた内容（複数可）をまとめて新しいメッセージとして書き込む
async function forwardMessageToRoom(targetRoomId, roomItemEl) {
  if (!pendingForwardItems || pendingForwardItems.length === 0) return;

  // ★ 二重送信防止（クリック直後にリスト全体を操作不能にする）
  const allItems = forwardRoomList.querySelectorAll(".forward-room-item");
  allItems.forEach((el) => (el.style.pointerEvents = "none"));
  if (roomItemEl) roomItemEl.textContent += "（転送中...）";

  const forwardCount = pendingForwardItems.length;

  try {
    // ★ 転送先ルームのメンバーの未読カウンターを、転送する件数ぶん加算する
    const targetRoomSnapshot = await getDoc(doc(db, "KokoKengaku", targetRoomId));
    const targetMembers = (targetRoomSnapshot.data() || {}).members || [];
    await bumpUnreadCounts(targetRoomId, targetMembers, myUserId, forwardCount);

    const batch = writeBatch(db);
    const targetTalkCollection = collection(db, "KokoKengaku", targetRoomId, "talk");

    pendingForwardItems.forEach((item) => {
      // ★ コピーしたデータをそのまま書き込む（既読・返信先だけリセット。送信者・日時・本文・画像・アンケート等はそのまま）
      const newMessageDoc = Object.assign({}, item, {
        readBy: [],
        replyTo: null
      });

      batch.set(doc(targetTalkCollection), newMessageDoc);
    });

    batch.update(doc(db, "KokoKengaku", targetRoomId), {
      lastUpdatedAt: serverTimestamp()
    });

    await batch.commit();

    pendingForwardItems = null;
    forwardModal.classList.add("hidden");
    exitSelectionMode(); // ★ 一括選択から転送した場合は、選択モードも終了しておく
    await AppDialog.alert(forwardCount > 1 ? `${forwardCount}件のメッセージを転送しました。` : "転送しました。");
  } catch (error) {
    console.error("メッセージ転送エラー:", error);
    await AppDialog.alert("転送に失敗しました。\n" + error.message);
    allItems.forEach((el) => (el.style.pointerEvents = ""));
    if (roomItemEl) roomItemEl.textContent = roomItemEl.textContent.replace("（転送中...）", "");
  }
}

// ================================
// ★ メッセージの一括選択・一括削除・一括転送
// ================================

let selectModeButton;
let talkAreaElForSelection;
let selectionActionBar;
let selectionCountText;
let selectionForwardButton;
let selectionDeleteButton;
let selectionCancelButton;

let selectionModeActive = false;
let selectedMessageIds = new Set(); // ★ 選択中のメッセージID（画面が再描画されても保持する）

document.addEventListener("DOMContentLoaded", () => {
  selectModeButton = document.getElementById("select-mode-button");
  talkAreaElForSelection = document.getElementById("talk-area");
  selectionActionBar = document.getElementById("selection-action-bar");
  selectionCountText = document.getElementById("selection-count-text");
  selectionForwardButton = document.getElementById("selection-forward-button");
  selectionDeleteButton = document.getElementById("selection-delete-button");
  selectionCancelButton = document.getElementById("selection-cancel-button");

  selectModeButton.addEventListener("click", () => {
    if (selectionModeActive) {
      exitSelectionMode();
    } else {
      enterSelectionMode();
    }
  });

  selectionCancelButton.addEventListener("click", exitSelectionMode);
  selectionDeleteButton.addEventListener("click", handleBulkDelete);
  selectionForwardButton.addEventListener("click", handleBulkForward);
});

function enterSelectionMode() {
  selectionModeActive = true;
  talkAreaElForSelection.classList.add("selecting");
  selectionActionBar.classList.remove("hidden");
  selectModeButton.textContent = "選択解除";
  // ★「まとめて転送」は管理者のみ（転送機能自体が管理者限定のため）
  selectionForwardButton.classList.toggle("hidden", !meIsAdmin);
  updateSelectionActionBar();
}

function exitSelectionMode() {
  selectionModeActive = false;
  selectedMessageIds.clear();
  if (talkAreaElForSelection) talkAreaElForSelection.classList.remove("selecting");
  if (selectionActionBar) selectionActionBar.classList.add("hidden");
  if (selectModeButton) selectModeButton.textContent = "選択";
  // ★ チェックボックスの見た目もリセットしておく
  document.querySelectorAll(".message-select-checkbox").forEach((cb) => {
    cb.checked = false;
  });
}

function updateSelectionActionBar() {
  const count = selectedMessageIds.size;
  selectionCountText.textContent = `${count}件選択中`;
  selectionDeleteButton.disabled = count === 0;
  selectionForwardButton.disabled = count === 0;
}

// ★「まとめて削除」：実際にdeleteするのではなく、isDisplayをfalseにして一括非表示化する
async function handleBulkDelete() {
  const count = selectedMessageIds.size;
  if (count === 0) return;

  if (!(await AppDialog.confirm(`選択した${count}件のメッセージを削除します。よろしいですか？`))) return;

  selectionDeleteButton.disabled = true;
  selectionForwardButton.disabled = true;

  try {
    const batch = writeBatch(db);
    selectedMessageIds.forEach((messageId) => {
      const ref = doc(db, "KokoKengaku", talkId, "talk", messageId);
      batch.update(ref, { isDisplay: false });
    });
    await batch.commit();

    await AppDialog.alert(`${count}件のメッセージを削除しました。`);
    exitSelectionMode();
  } catch (error) {
    console.error("一括削除エラー:", error);
    await AppDialog.alert("削除に失敗しました。\n" + error.message);
    updateSelectionActionBar();
  }
}

// ★「まとめて転送」：選択中のメッセージをまとめて取得し、既存の転送モーダルを開く
async function handleBulkForward() {
  if (selectedMessageIds.size === 0) return;

  const targetIds = Array.from(selectedMessageIds);

  try {
    const docs = await Promise.all(
      targetIds.map((id) => getDoc(doc(db, "KokoKengaku", talkId, "talk", id)))
    );
    const validDocs = docs.filter((d) => d.exists());

    if (validDocs.length === 0) {
      await AppDialog.alert("転送できるメッセージがありませんでした。");
      return;
    }

    openForwardModal(validDocs);
  } catch (error) {
    console.error("転送準備エラー:", error);
    await AppDialog.alert("転送するメッセージの取得に失敗しました。\n" + error.message);
  }
}

let profileModal;
let profileModalClose;
let profileAvatarWrap;
let profileAvatarHolder;
let profileAvatarInput;
let profileAvatarRemoveButton;
let profileName;
let profileNameInput; // 追加：編集用の名前入力欄
let profileText;
let profileTextEdit;  // 追加：編集用の自己紹介テキストエリア
// --- 追加：プロフィールの編集用変数 ---
let profileEditButton;
let profileCancelButton;
let isProfileEditing = false; // 編集モード中かどうかのフラグ
let currentProfileUserId = ""; // 現在開いているプロフィールのユーザーID
let canEditCurrentProfile = false; // 現在開いているプロフィールが自分（or管理者権限で）編集可能か
let profileAvatarCurrentUrl = ""; // Firestoreに保存されている現在の画像URL
let profileAvatarFile = null; // 新しく選択された未アップロードの画像ファイル
let profileAvatarRemoved = false; // 「画像を削除」が押されたかどうか

document.addEventListener("DOMContentLoaded", () => {
  // 追加要素の取得
  profileModal = document.getElementById("profile-modal");
  profileModalClose = document.getElementById("profile-modal-close");
  profileAvatarWrap = document.querySelector(".profile-avatar-wrap");
  profileAvatarHolder = document.getElementById("profile-avatar-holder");
  profileAvatarInput = document.getElementById("profile-avatar-input");
  profileAvatarRemoveButton = document.getElementById("profile-avatar-remove-button");
  profileName = document.getElementById("profile-name");
  profileNameInput = document.getElementById("profile-name-input"); // 既存DOMからあらかじめ取得
  profileText = document.getElementById("profile-text");
  profileTextEdit = document.getElementById('profile-text-edit');
  profileEditButton = document.getElementById("profile-edit-button");
  profileCancelButton = document.getElementById("profile-cancel-button");

  // 閉じるボタンのイベント
  profileModalClose.addEventListener("click", () => {
    profileModal.classList.add("hidden");
    resetProfileEditMode(); // モーダルを閉じるときに編集状態をリセット
  });

  // 編集・保存ボタンのクリックイベント
  profileEditButton.addEventListener("click", handleProfileEditOrSave);

  // 「キャンセル」ボタン：保存せず編集モードを終了する
  profileCancelButton.addEventListener("click", () => {
    resetProfileEditMode();
  });

  // アイコンをタップ（編集モード中のみ有効）→ ファイル選択を開く
  profileAvatarHolder.addEventListener("click", () => {
    if (!isProfileEditing || !canEditCurrentProfile) return;
    profileAvatarInput.click();
  });

  // ファイルが選択されたらプレビューに反映（アップロードは保存時にまとめて行う）
  profileAvatarInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    profileAvatarFile = file;
    profileAvatarRemoved = false;

    const reader = new FileReader();
    reader.onload = (event) => {
      profileAvatarHolder.innerHTML = "";
      const img = document.createElement("img");
      img.classList.add("avatar-circle", "large");
      img.src = event.target.result;
      profileAvatarHolder.appendChild(img);
      profileAvatarRemoveButton.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });

  // 「画像を削除」→ プレビューを頭文字アバターに戻し、保存時に画像を消去
  profileAvatarRemoveButton.addEventListener("click", () => {
    profileAvatarFile = null;
    profileAvatarRemoved = true;
    profileAvatarInput.value = "";

    profileAvatarHolder.innerHTML = "";
    const nameForInitial = isProfileEditing ? profileNameInput.value : profileName.textContent;
    profileAvatarHolder.appendChild(createAvatar(nameForInitial, "large"));
    profileAvatarRemoveButton.classList.add("hidden");
  });
});

// 編集モードをリセットする関数
function resetProfileEditMode() {
  isProfileEditing = false;
  if (profileEditButton) {
    profileEditButton.textContent = "プロフィールを編集";
    profileEditButton.disabled = false;
  }
  if (profileCancelButton) profileCancelButton.classList.add("hidden");
  // 表示状態をノーマルに戻し、編集用を隠す
  if (profileName) profileName.classList.remove("hidden");
  if (profileNameInput) profileNameInput.classList.add("hidden");
  if (profileText) profileText.classList.remove("hidden");
  if (profileTextEdit) profileTextEdit.classList.add("hidden");

  // アバターの編集用UIも隠し、未保存の変更があれば元の状態に戻す
  if (profileAvatarWrap) profileAvatarWrap.classList.remove("editable");
  if (profileAvatarRemoveButton) profileAvatarRemoveButton.classList.add("hidden");
  profileAvatarFile = null;
  profileAvatarRemoved = false;
  if (profileAvatarHolder && profileName) {
    profileAvatarHolder.innerHTML = "";
    profileAvatarHolder.appendChild(createAvatar(profileName.textContent, "large", profileAvatarCurrentUrl));
  }
}

// 編集ボタン・保存ボタンが押された時の処理
async function handleProfileEditOrSave() {
  if (!isProfileEditing) {
    // 【編集モードに入る処理】
    isProfileEditing = true;
    profileEditButton.textContent = "プロフィールを保存";
    if (profileCancelButton) profileCancelButton.classList.toggle("hidden", !canEditCurrentProfile);

    // 現在のキャッシュからテキストを取得する
    const cached = getUserCache(currentProfileUserId) || {};
    const currentName = cached.name || "";
    const currentText = cached.profileText || "";

    profileName.classList.add("hidden");
    profileNameInput.classList.remove("hidden");
    profileNameInput.value = currentName;

    profileText.classList.add("hidden");
    profileTextEdit.classList.remove("hidden");
    profileTextEdit.value = currentText;

    // アイコンをタップして変更できるようにする（自分／管理者のみ）
    if (canEditCurrentProfile) {
      profileAvatarWrap.classList.add("editable");
      if (profileAvatarCurrentUrl) {
        profileAvatarRemoveButton.classList.remove("hidden");
      }
    }

  } else {
    // 【保存処理】
    const newName = profileNameInput.value.trim();
    const newProfileText = profileTextEdit.value.trim();

    if (!newName) {
      await AppDialog.alert("ユーザーネームを入力してください。");
      return;
    }

    profileEditButton.disabled = true;
    profileEditButton.textContent = "保存中...";

    try {
      // アイコン画像の変更があれば、先にアップロード（または削除）を確定させる
      let finalImageUrl = profileAvatarCurrentUrl;
      if (profileAvatarFile) {
        profileEditButton.textContent = "画像をアップロード中...";
        finalImageUrl = await uploadImageToImgbb(profileAvatarFile);
      } else if (profileAvatarRemoved) {
        finalImageUrl = "";
      }

      profileEditButton.textContent = "保存中...";

      // Firestoreの users_random コレクションを更新
      await setDoc(doc(db, "users_random", currentProfileUserId), 
        {
          name: newName,
          profileText: newProfileText,
          imageUrl: finalImageUrl
        },
        { merge: true }
      );

      // キャッシュ情報の更新（name / isAdmin / imageUrl / profileText / prizeGrantedAt を一括で最新化）
      const previousCache = getUserCache(currentProfileUserId) || {};
      const updated = setUserCache(currentProfileUserId, {
        name: newName,
        isAdmin: previousCache.isAdmin || false,
        imageUrl: finalImageUrl,
        profileText: newProfileText,
        prizeGrantedAt: previousCache.prizeGrantedAt
      });

      // ★ 自分自身のプロフィールを編集した場合のみ、ドロワーの表示名も更新する
      if (currentProfileUserId === myUserId) {
        drawerUsername.textContent = newName;
      }

      // 通常時のテキスト要素へ反映させて復元
      profileName.textContent = newName;
      profileText.textContent = newProfileText || "ステータスメッセージはありません。";

      profileAvatarCurrentUrl = finalImageUrl;
      profileAvatarFile = null;
      profileAvatarRemoved = false;
      profileAvatarHolder.innerHTML = "";
      profileAvatarHolder.appendChild(createAvatar(newName, "large", updated.imageUrl));

      profileName.classList.toggle("admin", !!updated.isAdmin);
      profileName.classList.toggle("prize", !updated.isAdmin && hasActivePrize(updated));

      sendProfileChangeNotification(db, { senderId: myUserId, userName: newName }); // ★ 全員へ通知（待たない）
      resetProfileEditMode();
      await AppDialog.alert("プロフィールを保存しました。");
    } catch (error) {
      console.error("プロフィール保存エラー:", error);
      await AppDialog.alert("プロフィールの保存に失敗しました: " + error.message);
      profileEditButton.disabled = false;
      profileEditButton.textContent = "プロフィールを保存";
    }
  }
}

// プロフィールモーダルを開いてFirebaseから最新のステメ等を取得する関数
// startEditModeがtrueの場合、ダイレクトに編集可能なテキストエリア等を開く
async function openProfileModal(userId, startEditMode = false) {
  currentProfileUserId = userId; // 現在開いているユーザーIDを保持
  canEditCurrentProfile = meIsAdmin || userId === myUserId;
  resetProfileEditMode();       // 編集状態を初期化

  // ★ キャッシュがあれば先にそれを表示し（体感速度優先）、裏で最新データに更新する
  const cached = getUserCache(userId);
  const hasCachedProfileText = !!cached && cached.profileText !== undefined;
  const isProfileCacheFresh = hasCachedProfileText && isUserCacheFresh(userId);
  profileName.textContent = (cached && cached.name) || "取得中...";
  profileName.classList.toggle("admin", !!(cached && cached.isAdmin));
  profileName.classList.toggle("prize", !!cached && !cached.isAdmin && hasActivePrize(cached));
  profileText.textContent = hasCachedProfileText
    ? (cached.profileText || "ステータスメッセージはありません。")
    : "取得中...";
  profileAvatarCurrentUrl = (cached && cached.imageUrl) || "";

  profileAvatarHolder.innerHTML = "";
  profileAvatarHolder.appendChild(createAvatar(profileName.textContent, "large", profileAvatarCurrentUrl));

  profileEditButton.classList.toggle("hidden", !canEditCurrentProfile);
  profileModal.classList.remove("hidden");

  // ★ ステータスメッセージまで3時間以内にキャッシュ済みなら、Firestoreへは再取得しに行かない
  if (isProfileCacheFresh) {
    if (canEditCurrentProfile && startEditMode) {
      handleProfileEditOrSave();
    }
    return;
  }

  try {
    const userSnapshot = await getDoc(doc(db, "users_random", userId));
    if (userSnapshot.exists()) {
      const userData = userSnapshot.data();

      // ★ ユーザーデータをまとめてキャッシュに反映
      const updated = setUserCache(userId, {
        name: userData.name || "名前未設定",
        isAdmin: userData.isAdmin || false,
        imageUrl: userData.imageUrl || "",
        profileText: userData.profileText || "",
        prizeGrantedAt: userData.prizeGrantedAt
      });

      profileName.textContent = updated.name;
      profileName.classList.toggle("admin", !!updated.isAdmin);
      profileName.classList.toggle("prize", !updated.isAdmin && hasActivePrize(updated));
      profileText.textContent = updated.profileText || "ステータスメッセージはありません。";
      profileAvatarCurrentUrl = updated.imageUrl || "";

      profileAvatarHolder.innerHTML = "";
      profileAvatarHolder.appendChild(createAvatar(profileName.textContent, "large", profileAvatarCurrentUrl));

      // ドロワーから来たなどの場合は即座に編集モードに移行する
      if (canEditCurrentProfile && startEditMode) {
        handleProfileEditOrSave();
      }
    } else {
      profileName.textContent = "不明なユーザー";
      profileText.textContent = "";
    }
  } catch (error) {
    console.error("プロフィール取得エラー:", error);
    profileName.textContent = "エラー";
    profileText.textContent = "プロフィールの取得に失敗しました。";
  }
}

// ★ 画像送信モーダル一式（キャプション付き）
let imageUploadModal;
let openImageModalBtn;
let imageModalClose;
let modalImageInput;
let selectImageBtn;
let imagePreviewContainer;
let imagePreview;
let imageMessageInput;
let submitImageBtn;
let selectedImageFile = null;

document.addEventListener("DOMContentLoaded", () => {
  imageUploadModal = document.getElementById("image-upload-modal");
  openImageModalBtn = document.getElementById("open-image-modal-button");
  imageModalClose = document.getElementById("image-modal-close");
  modalImageInput = document.getElementById("modal-image-input");
  selectImageBtn = document.getElementById("select-image-button");
  imagePreviewContainer = document.getElementById("image-preview-container");
  imagePreview = document.getElementById("image-preview");
  imageMessageInput = document.getElementById("image-message-input");
  submitImageBtn = document.getElementById("submit-image-button");

  // 1. モーダルを開く
  openImageModalBtn.addEventListener("click", () => {
    // 状態を初期化
    selectedImageFile = null;
    modalImageInput.value = "";
    imagePreview.src = "";
    imagePreviewContainer.classList.add("hidden");
    submitImageBtn.disabled = true;
    submitImageBtn.textContent = "画像を送信";
    imageModalClose.classList.remove("hidden");
    selectImageBtn.disabled = false;
    imageMessageInput.disabled = false;
    imageUploadModal.classList.remove("hidden");
  });

  // 2. モーダルを閉じる（キャンセル）
  imageModalClose.addEventListener("click", () => {
    imageUploadModal.classList.add("hidden");
  });

  // 3. 「画像を選択する」ボタンが押されたら隠しinputを発火
  selectImageBtn.addEventListener("click", () => {
    modalImageInput.click();
  });

  // 4. ファイルが選択されたらプレビューを表示
  modalImageInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    selectedImageFile = file;

    // FileReaderで読み込んでプレビュー表示
    const reader = new FileReader();
    reader.onload = (event) => {
      imagePreview.src = event.target.result;
      imagePreviewContainer.classList.remove("hidden");
      submitImageBtn.disabled = false; // 送信ボタンを活性化
    };
    reader.readAsDataURL(file);
  });

  // 5. 画像を送信する（アップロード & Firestore書き込み）
  submitImageBtn.addEventListener("click", async () => {
    if (!selectedImageFile) return;

    // UIを「アップロード中」に変更して入力をロック
    submitImageBtn.disabled = true;
    imageModalClose.classList.add("hidden"); // 閉じるボタンを無効化
    selectImageBtn.disabled = true;
    submitImageBtn.textContent = "画像をアップロード中...";
    imageMessageInput.disabled = true;

    try {
      const imageUrl = await uploadImageToImgbb(selectedImageFile);

      // 現在のトークルーム（talkId）のtalkに画像メッセージを追加（任意のキャプション付き）
      await bumpUnreadCounts(talkId, currentRoomMembers, myUserId);
      await addDoc(collection(db, "KokoKengaku", talkId, "talk"), {
        userId: myUserId,
        message: imageMessageInput.value,
        imageUrl: imageUrl,
        readBy: [],
        replyTo: replyToId || null,
        time: serverTimestamp()
      });

      // ルーム一覧側の未読カウント・並び順のためにlastUpdatedAtも更新
      await updateDoc(doc(db, "KokoKengaku", talkId), {
        lastUpdatedAt: serverTimestamp()
      });

      notifyRoom(imageMessageInput.value || "📷 画像を送信しました"); // ★ 新着通知（待たない）
      console.log("画像送信が完了しました！");

      // d. 成功したら自動的にモーダルを閉じる
      imageUploadModal.classList.add("hidden");
      imageMessageInput.value = "";
      cancelReply(); // ★ 送信成功後は返信状態を解除
    } catch (error) {
      console.error("画像送信中にエラーが発生しました:", error);
      await AppDialog.alert("画像の送信に失敗しました。\n" + error.message);
      
      // エラー時はユーザーがやり直せるようにボタンのロックを解除
      submitImageBtn.disabled = false;
      submitImageBtn.textContent = "画像を送信";
      imageModalClose.classList.remove("hidden");
      selectImageBtn.disabled = false;
      imageMessageInput.disabled = false;
    }
  });
});

// ================================
// ★ アンケート機能
// ================================

const POLL_MIN_CHOICES = 2;
const POLL_MAX_CHOICES = 10;

let pollCreateModal;
let pollCreateModalClose;
let openPollModalBtn;
let pollQuestionInput;
let pollChoicesList;
let pollAddChoiceButton;
let pollSubmitButton;

document.addEventListener("DOMContentLoaded", () => {
  pollCreateModal = document.getElementById("poll-create-modal");
  pollCreateModalClose = document.getElementById("poll-create-modal-close");
  openPollModalBtn = document.getElementById("open-poll-modal-button");
  pollQuestionInput = document.getElementById("poll-question-input");
  pollChoicesList = document.getElementById("poll-choices-list");
  pollAddChoiceButton = document.getElementById("poll-add-choice-button");
  pollSubmitButton = document.getElementById("poll-submit-button");

  openPollModalBtn.addEventListener("click", () => {
    resetPollCreateForm();
    pollCreateModal.classList.remove("hidden");
  });

  pollCreateModalClose.addEventListener("click", () => {
    pollCreateModal.classList.add("hidden");
  });

  pollQuestionInput.addEventListener("input", updatePollSubmitState);

  pollAddChoiceButton.addEventListener("click", () => {
    addPollChoiceRow();
  });

  pollSubmitButton.addEventListener("click", submitPoll);
});

// ★ 選択肢の入力欄を1行追加する
function addPollChoiceRow(prefillValue) {
  if (pollChoicesList.children.length >= POLL_MAX_CHOICES) return;

  const row = document.createElement("div");
  row.classList.add("poll-choice-row");

  const input = document.createElement("input");
  input.type = "text";
  input.classList.add("poll-choice-input");
  input.maxLength = 100;
  input.value = prefillValue || "";
  input.addEventListener("input", updatePollSubmitState);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.classList.add("poll-choice-remove");
  removeBtn.textContent = "×";
  removeBtn.setAttribute("aria-label", "選択肢を削除");
  removeBtn.addEventListener("click", () => {
    if (pollChoicesList.children.length <= POLL_MIN_CHOICES) return;
    row.remove();
    renumberPollChoicePlaceholders();
    updatePollAddButtonState();
    updatePollRemoveButtonsVisibility();
    updatePollSubmitState();
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  pollChoicesList.appendChild(row);

  renumberPollChoicePlaceholders();
  updatePollAddButtonState();
  updatePollRemoveButtonsVisibility();
}

// ★ 選択肢のプレースホルダー（「選択肢 1」など）を振り直す
function renumberPollChoicePlaceholders() {
  const inputs = pollChoicesList.querySelectorAll(".poll-choice-input");
  inputs.forEach((input, index) => {
    input.placeholder = `選択肢 ${index + 1}`;
  });
}

// ★ 最小選択肢数までは削除ボタンを隠す
function updatePollRemoveButtonsVisibility() {
  const canRemove = pollChoicesList.children.length > POLL_MIN_CHOICES;
  pollChoicesList.querySelectorAll(".poll-choice-remove").forEach((btn) => {
    btn.classList.toggle("hidden", !canRemove);
  });
}

// ★ 最大数に達したら追加ボタンを無効化
function updatePollAddButtonState() {
  pollAddChoiceButton.disabled = pollChoicesList.children.length >= POLL_MAX_CHOICES;
}

// ★ 質問文が入力され、選択肢が2つ以上埋まっていれば送信ボタンを活性化
function updatePollSubmitState() {
  const hasQuestion = pollQuestionInput.value.trim() !== "";
  const filledChoices = Array.from(pollChoicesList.querySelectorAll(".poll-choice-input"))
    .filter((input) => input.value.trim() !== "").length;
  pollSubmitButton.disabled = !(hasQuestion && filledChoices >= POLL_MIN_CHOICES);
}

// ★ フォームを初期状態（質問欄クリア・選択肢2行）にリセットする
function resetPollCreateForm() {
  pollQuestionInput.value = "";
  pollChoicesList.innerHTML = "";
  for (let i = 0; i < POLL_MIN_CHOICES; i++) {
    addPollChoiceRow();
  }
  updatePollSubmitState();
}

// ★ アンケートを送信する
async function submitPoll() {
  const question = pollQuestionInput.value.trim();
  const choices = Array.from(pollChoicesList.querySelectorAll(".poll-choice-input"))
    .map((input) => input.value.trim())
    .filter((value) => value !== "")
    .slice(0, POLL_MAX_CHOICES);

  if (!question || choices.length < POLL_MIN_CHOICES) return;

  pollSubmitButton.disabled = true;
  pollSubmitButton.textContent = "送信中...";

  try {
    await bumpUnreadCounts(talkId, currentRoomMembers, myUserId);
    await addDoc(collection(db, "KokoKengaku", talkId, "talk"), {
      userId: myUserId,
      message: question,
      choices: choices,
      answer: {},
      readBy: [],
      replyTo: replyToId || null,
      time: serverTimestamp()
    });

    await updateDoc(doc(db, "KokoKengaku", talkId), {
      lastUpdatedAt: serverTimestamp()
    });

    notifyRoom("📊 " + question); // ★ 新着通知（待たない）
    pollCreateModal.classList.add("hidden");
    resetPollCreateForm();
    cancelReply(); // ★ 送信成功後は返信状態を解除
  } catch (error) {
    console.error("アンケート送信中にエラーが発生しました:", error);
    await AppDialog.alert("アンケートの送信に失敗しました。\n" + error.message);
  } finally {
    pollSubmitButton.textContent = "アンケートを送信";
    updatePollSubmitState();
  }
}

// ★ メッセージ内に表示するアンケートウィジェットを組み立てる
function buildPollWidget(messageDocId, choices, answerMap) {
  const widget = document.createElement("div");
  widget.classList.add("poll-widget");

  const scroll = document.createElement("div");
  scroll.classList.add("poll-choices-scroll");

  const hasMyAnswer = Object.prototype.hasOwnProperty.call(answerMap, myUserId);
  const myAnswerIndex = hasMyAnswer ? answerMap[myUserId] : null;
  const radioGroupName = `poll-${messageDocId}`;

  const answerButton = document.createElement("button");
  answerButton.type = "button";
  answerButton.classList.add("poll-answer-button");
  answerButton.textContent = hasMyAnswer ? "再回答する" : "答える";
   answerButton.disabled = true;

  choices.forEach((choiceLabel, index) => {
    const count = Object.values(answerMap).filter((v) => v === index).length;

    const optionLabel = document.createElement("label");
    optionLabel.classList.add("poll-choice-option");

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = radioGroupName;
    radio.value = String(index);
    if (myAnswerIndex === index) radio.checked = true;
    radio.addEventListener("change", () => {
      answerButton.disabled = (index === myAnswerIndex);
    });

    const labelSpan = document.createElement("span");
    labelSpan.classList.add("poll-choice-label");
    labelSpan.textContent = choiceLabel;

    const countSpan = document.createElement("span");
    countSpan.classList.add("poll-choice-count");
    countSpan.textContent = `${count}人`;
    countSpan.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPollVotersModal(answerMap, index, choiceLabel);
    });

    optionLabel.appendChild(radio);
    optionLabel.appendChild(labelSpan);
    optionLabel.appendChild(countSpan);
    scroll.appendChild(optionLabel);
  });

  widget.appendChild(scroll);

  answerButton.addEventListener("click", async () => {
    const checked = scroll.querySelector(`input[name="${radioGroupName}"]:checked`);
    if (!checked) return;

    const selectedIndex = Number(checked.value);
    const originalText = answerButton.textContent;
    answerButton.disabled = true;
    answerButton.textContent = "送信中...";

    try {
      await updateDoc(doc(db, "KokoKengaku", talkId, "talk", messageDocId), {
        [`answer.${myUserId}`]: selectedIndex
      });
      notifyPollAnswer(hasMyAnswer); // ★ 全メンバーへ通知（待たない）。再回答なら「変更しました」
    } catch (error) {
      console.error("回答の送信に失敗しました:", error);
      await AppDialog.alert("回答の送信に失敗しました。\n" + error.message);
      answerButton.disabled = false;
      answerButton.textContent = originalText;
    }
    // 成功時はメッセージ一覧のリアルタイム再描画で新しい状態に置き換わる
  });

  widget.appendChild(answerButton);

  return widget;
}

// ★ ある選択肢を選んだ人の一覧を表示する
let pollVotersModal;
let pollVotersModalClose;
let pollVotersTitle;
let pollVotersArea;

document.addEventListener("DOMContentLoaded", () => {
  pollVotersModal = document.getElementById("poll-voters-modal");
  pollVotersModalClose = document.getElementById("poll-voters-modal-close");
  pollVotersTitle = document.getElementById("poll-voters-title");
  pollVotersArea = document.getElementById("poll-voters-area");

  pollVotersModalClose.addEventListener("click", () => {
    pollVotersModal.classList.add("hidden");
  });
});

async function openPollVotersModal(answerMap, choiceIndex, choiceLabel) {
  pollVotersTitle.textContent = choiceLabel ? `「${choiceLabel}」を選んだ人` : "回答した人";
  pollVotersArea.innerHTML = "読み込み中...";
  pollVotersModal.classList.remove("hidden");

  const voterIds = Object.keys(answerMap || {}).filter((uid) => answerMap[uid] === choiceIndex);
  const fragment = document.createDocumentFragment();

  if (voterIds.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.textContent = "まだ誰も選んでいません";
    emptyMessage.style.color = "var(--text-muted)";
    fragment.appendChild(emptyMessage);
  }

  for (const userId of voterIds) {
    let cached = getUserCache(userId);

    // 万が一キャッシュに載っていないイレギュラーなユーザーIDが含まれていた場合のみ個別get
    if (!cached) {
      try {
        const userSnapshot = await getDoc(doc(db, "users_random", userId));
        if (userSnapshot.exists()) {
          const userData = userSnapshot.data();
          cached = setUserCache(userId, {
            name: userData.name || "名前未設定",
            isAdmin: userData.isAdmin || false,
            imageUrl: userData.imageUrl || "",
            profileText: userData.profileText || "",
            prizeGrantedAt: userData.prizeGrantedAt
          });
        } else {
          cached = setUserCache(userId, { name: "不明なユーザー", isAdmin: false, imageUrl: "", profileText: "" });
        }
      } catch (e) {
        console.error(e);
        cached = { name: "不明なユーザー", isAdmin: false, imageUrl: "" };
      }
    }

    const p = document.createElement("p");
    p.classList.add("clickable-user");
    p.style.cursor = "pointer";
    p.appendChild(createAvatar(cached.name, "small", cached.imageUrl));
    const nameSpan = document.createElement("span");
    nameSpan.textContent = cached.name;
    if (cached.isAdmin) {
      nameSpan.classList.add("admin");
    } else if (hasActivePrize(cached)) {
      nameSpan.classList.add("prize");
    }
    p.appendChild(nameSpan);

    p.addEventListener("click", () => {
      openProfileModal(userId);
    });

    fragment.appendChild(p);
  }

  pollVotersArea.innerHTML = "";
  pollVotersArea.appendChild(fragment);
}
