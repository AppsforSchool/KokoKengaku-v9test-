import { initPush, logoutPush, setupPushButton, sendProfileChangeNotification } from "./notify.js";
import {
  auth, db, onAuthStateChanged, signOut,
  collection, doc, getDoc, getDocs, setDoc, addDoc, onSnapshot,
  query, where, getCountFromServer, serverTimestamp
} from "./firebase.js";


let myUid = "";
let myUserId = "";
let meIsAdmin = false;

// ★ Firestoreのタイムスタンプ(またはミリ秒数値)を、比較に使いやすいミリ秒数値へ揃える
function toMillisOrNull(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  return null;
}

// ★ 景品(名前が虹色に光る演出)の持続時間。「問題投稿」アプリ側の仕様に合わせて10分間
const PRIZE_DURATION_MS = 10 * 60 * 1000;

// ★ 景品が、付与されてからまだ持続時間内（＝現在も有効）かどうか
function hasActivePrize(cached) {
  const grantedAt = cached && cached.prizeGrantedAt;
  return typeof grantedAt === "number" && grantedAt + PRIZE_DURATION_MS > Date.now();
}

let loadingOverlay;
let loadingOverlayText;
let loadingProgressBarFill;
let noActiveOverlay;
let selectionContainer; // ★ トーク一覧本体。読み込み完了までは非表示にしておく
let drawerOverlay;
let accountSettingsDrawer;
let drawerCloseButton;
let accountSettingsButton;
let drawerUserId;
let drawerLogoutButton;
let drawerUsername;
let drawerEditProfileButton; // ドロワーの「プロフィールを編集」ボタン

// キャッシュ用オブジェクト
// ★ ユーザーデータの統一キャッシュ（name / isAdmin / imageUrl / profileText / prizeGrantedAt をまとめて保持）
let userDataCache = {};
function getUserCache(userId) {
  return userDataCache[userId] || null;
}
function setUserCache(userId, data) {
  const normalized = Object.assign({}, data);
  if ("prizeGrantedAt" in normalized) {
    normalized.prizeGrantedAt = toMillisOrNull(normalized.prizeGrantedAt);
  }
  userDataCache[userId] = Object.assign({}, userDataCache[userId] || {}, normalized);
  return userDataCache[userId];
}

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

// ★ ImgBBへの画像アップロード共通処理（プロフィールアイコン用）
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

document.addEventListener("DOMContentLoaded", () => {
  loadingOverlay = document.getElementById("loading-overlay");
  loadingOverlayText = document.getElementById("loading-overlay-text");
  loadingProgressBarFill = document.getElementById("loading-progress-bar-fill");
  noActiveOverlay = document.getElementById("no-active-overlay");
  selectionContainer = document.getElementById("selection-container");
  
  drawerOverlay = document.getElementById("drawerOverlay");
  accountSettingsDrawer = document.getElementById("accountSettingsDrawer");
  drawerCloseButton = document.getElementById("drawerCloseButton");
  accountSettingsButton = document.getElementById("setting-button");
  
  drawerUserId = document.getElementById("drawerUserId");
  drawerLogoutButton = document.getElementById("logout-button");
  drawerUsername = document.getElementById("drawerUsername");
  drawerEditProfileButton = document.getElementById("drawer-edit-profile-button");
  
  accountSettingsButton.addEventListener('click', openDrawer);
  drawerCloseButton.addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  drawerLogoutButton.addEventListener('click', handleLogout);

  // ドロワー内の「プロフィールをみる」ボタン
  drawerEditProfileButton.addEventListener('click', () => {
    closeDrawer();
    openProfileModal(myUserId, false); // 自分のプロフィールを表示するだけ（編集モードにはしない）
  });
});


function openDrawer() {
    accountSettingsDrawer.classList.add('is-open');
    drawerOverlay.classList.add('is-open');
}
function closeDrawer() {
  accountSettingsDrawer.classList.remove('is-open');
  drawerOverlay.classList.remove('is-open');
}

document.addEventListener("DOMContentLoaded", () => {
  onAuthStateChanged(auth, async (user) => {
   try {
    if (user) {
      
      
      myUserId = user.email.split("@")[0];
      drawerUserId.textContent = myUserId;
      
      setLoadingStage("ユーザー情報を確認しています...", 10);
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

        // ★ ローディングオーバーレイは、トーク一覧の初回表示が完了するまで getAllTalkData 側で消す

        // ★「新しいトークを作成」ボタンは管理者にだけ見せる
        const openCreateTalkModalButton = document.getElementById("open-create-talk-modal-button");
        if (openCreateTalkModalButton) {
          openCreateTalkModalButton.classList.toggle("hidden", !meIsAdmin);
        }

        // ★ プッシュ通知の初期化（失敗してもトーク一覧の表示には影響させない）
        initPush(db, myUserId);
        setupPushButton("enable-push-button");

        getAllTalkData();
      } else {
        loadingOverlay.classList.add("hidden");
        noActiveOverlay.classList.remove("hidden");
        // window.location.href = "404.html";
      }

    } else {
      console.log("logout");
      window.location.href = "./index.html";
    }
   }
    catch (error) {
      console.log(error);
      await AppDialog.alert(error.message || String(error));
    }
  });
});

const handleLogout = async () => {
  const isConfirmed = await AppDialog.confirm("ログアウトしますか？");
  if (isConfirmed) {
    try {
    await logoutPush(); // ★ この端末への通知紐づけを解除
    await signOut(auth);
    console.log("ログアウトしました！");
    await AppDialog.alert("ログアウトしました。");
  } catch (error) {
    console.error("ログアウトエラー:", error);
    await AppDialog.alert("ログアウトに失敗しました。");
  }
  }
};

let profileModal;
let profileModalClose;
let profileAvatarWrap;
let profileAvatarHolder;
let profileAvatarInput;
let profileAvatarRemoveButton;
let profileName;
let profileNameInput;
let profileText;
let profileTextEdit;
let profileEditButton;
let profileCancelButton;
let isProfileEditing = false;
let currentProfileUserId = "";
let canEditCurrentProfile = false; // 現在開いているプロフィールが自分（or管理者権限で）編集可能か
let profileAvatarCurrentUrl = ""; // Firestoreに保存されている現在の画像URL
let profileAvatarFile = null; // 新しく選択された未アップロードの画像ファイル
let profileAvatarRemoved = false; // 「画像を削除」が押されたかどうか

document.addEventListener("DOMContentLoaded", () => {
  profileModal = document.getElementById("profile-modal");
  profileModalClose = document.getElementById("profile-modal-close");
  profileAvatarWrap = document.querySelector(".profile-avatar-wrap");
  profileAvatarHolder = document.getElementById("profile-avatar-holder");
  profileAvatarInput = document.getElementById("profile-avatar-input");
  profileAvatarRemoveButton = document.getElementById("profile-avatar-remove-button");
  profileName = document.getElementById("profile-name");
  profileNameInput = document.getElementById("profile-name-input");
  profileText = document.getElementById("profile-text");
  profileTextEdit = document.getElementById("profile-text-edit");
  profileEditButton = document.getElementById("profile-edit-button");
  profileCancelButton = document.getElementById("profile-cancel-button");

  profileModalClose.addEventListener("click", () => {
    profileModal.classList.add("hidden");
    resetProfileEditMode();
  });

  profileEditButton.addEventListener("click", handleProfileEditOrSave);
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
  currentProfileUserId = userId;
  canEditCurrentProfile = meIsAdmin || userId === myUserId;
  resetProfileEditMode();

  // ★ キャッシュがあれば先にそれを表示し（体感速度優先）、裏で最新データに更新する
  const cached = getUserCache(userId);
  const hasCachedProfileText = !!cached && cached.profileText !== undefined;
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

  // ★ すでにステータスメッセージまでキャッシュ済みなら、Firestoreへは再取得しに行かない
  if (hasCachedProfileText) {
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




// リアルタイム更新の監視を解除するための関数を保持する変数
let talkListenerUnsubscribe = null;

// ★ 更新日時を比較しやすいミリ秒数値に変換する（未設定のルームは一番古い扱いにする）
function getTalkButtonUpdatedAtMillis(talkButton) {
  const ts = talkButton.dataUpdatedAt;
  return ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0;
}

// ★ 更新日時（ミリ秒）から「今日」「昨日」などのグループ名を決める
const TALK_GROUP_ORDER = ["今日", "昨日", "1週間前", "1ヶ月前", "それ以前"];
function getDateGroupLabel(millis) {
  if (!millis) return "それ以前";

  const now = new Date();
  const target = new Date(millis);

  // ★ 時刻を無視して「日」単位の差で判定する
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const daysAgo = Math.round((startOfToday - startOfTarget) / (1000 * 60 * 60 * 24));

  if (daysAgo <= 0) return "今日";
  if (daysAgo === 1) return "昨日";
  if (daysAgo <= 6) return "1週間前";
  if (daysAgo <= 29) return "1ヶ月前";
  return "それ以前";
}

// ★ トーク一覧を「最終更新日時が新しいもの→古いもの」の順に並べ替えつつ、
//   「今日」「昨日」「1週間前」...のグループ見出しを挿入し直す
//   （既存のボタン要素を再アペンドするだけなので、イベントや未読表示はそのまま引き継がれる）
function regroupTalkButtons(talkButtonArea) {
  const buttons = Array.from(talkButtonArea.querySelectorAll(".talk-button"));

  // ★ グループの並び順を優先し、グループ内は更新日時が新しい順にする
  buttons.sort((a, b) => {
    const groupIndexA = TALK_GROUP_ORDER.indexOf(getDateGroupLabel(getTalkButtonUpdatedAtMillis(a)));
    const groupIndexB = TALK_GROUP_ORDER.indexOf(getDateGroupLabel(getTalkButtonUpdatedAtMillis(b)));
    if (groupIndexA !== groupIndexB) return groupIndexA - groupIndexB;
    return getTalkButtonUpdatedAtMillis(b) - getTalkButtonUpdatedAtMillis(a);
  });

  // ★ 見出しはいったん全部外して、必要な分だけ作り直す（見出し自体には状態を持たせていないので安全）
  talkButtonArea.querySelectorAll(".talk-group-header").forEach((header) => header.remove());

  let currentGroupLabel = null;
  buttons.forEach((button) => {
    const groupLabel = getDateGroupLabel(getTalkButtonUpdatedAtMillis(button));
    if (groupLabel !== currentGroupLabel) {
      const header = document.createElement("p");
      header.classList.add("talk-group-header");
      header.textContent = groupLabel;
      talkButtonArea.appendChild(header);
      currentGroupLabel = groupLabel;
    }
    talkButtonArea.appendChild(button);
  });
}

// ★ 自分の lastChecked（各ルームの既読状態）を、常に最新の状態で保持しておく。
//   以前は毎回 .get() で取り直していたが、ページ読み込み直後に他の書き込みとタイミングが
//   重なることがあり、ごく稀に lastChecked が空のスナップショットを掴んで
//   「全ルーム未読」になる不具合があったため、専用のリアルタイムリスナーで受け取る方式に変更した
//   （※この不具合の原因だった「ユーザー一覧」機能自体は、その後削除している）。
let currentUserLastCheckedMap = {};
let userDocUnsubscribeForUnread = null;
let renderedRoomIds = new Set(); // 画面に表示中のルームID（lastCheckedが更新された時に再計算する対象）
let isInitialTalkListLoad = true; // ★ 初回のトーク一覧表示かどうか（進捗表示・オーバーレイの制御に使う）

// ★ ローディングオーバーレイの段階テキストと、その下の進捗バーをまとめて更新する
//   （画像は関係ないこの画面では、全ステージがそのまま進捗バーの対象になる）
function setLoadingStage(text, percent) {
  if (loadingOverlayText) {
    loadingOverlayText.textContent = text;
  }
  if (loadingProgressBarFill && typeof percent === "number") {
    const clamped = Math.max(0, Math.min(100, percent));
    loadingProgressBarFill.style.width = `${clamped}%`;
  }
}

// ★ ローディングオーバーレイを閉じ、裏に隠していたトーク一覧本体を表示する
function hideLoadingOverlayNowForAppList() {
  loadingOverlay.classList.add("hidden");
  if (selectionContainer) {
    selectionContainer.classList.remove("hidden");
  }
}

// ================================
// ★ 個人 / グループ の分類
//    メンバー1人 = 自分のみのトーク / 2人 = 個人トーク / 3人以上 = グループ
//    （内部的にはどれも KokoKengaku のルーム。人数だけで分類する）
// ================================
const TALK_TAB_STORAGE_KEY = "kokoKengakuTalkTab";
let currentTalkTab = "personal";
let allUsersList = [];      // 個人タブに並べる全ユーザー（isActive が false の人は除く）
let roomMetaMap = {};       // roomId -> { category, partnerId, title, imageUrl, lastUpdatedAtMs }
let unreadCountCache = {};  // roomId -> 未読件数（タブの赤丸・一覧の再描画に使う）
let personalButtonArea;
let groupArea;
let talkTabControl;
let isCreatingPersonalTalk = false;

function getRoomCategory(members) {
  const count = (members || []).length;
  if (count <= 1) return "self";
  if (count === 2) return "personal";
  return "group";
}

// ★ この端末のユーザーに見せてよいルームか。
//   自分が入っていれば表示。管理者は、自分が入っていなくてもグループ(3人以上)だけ閲覧できる
//   （他人同士の個人トークは管理者でも表示しない）
function isRoomVisibleForMe(roomData) {
  const members = roomData.members || [];
  if (members.includes(myUserId)) return true;
  return meIsAdmin && members.length >= 3;
}

function getUserDisplayName(userId) {
  const cached = getUserCache(userId);
  return (cached && cached.name) || userId;
}

// ★ 個人タブ用に全ユーザーを読み込む（名前・アイコンはユーザーキャッシュにも反映する）
async function loadAllUsers() {
  try {
    const snapshot = await getDocs(collection(db, "users_random"));
    allUsersList = snapshot.docs.map((doc) => {
      const d = doc.data() || {};
      setUserCache(doc.id, {
        name: d.name || doc.id,
        isAdmin: !!d.isAdmin,
        imageUrl: d.imageUrl || "",
        prizeGrantedAt: d.prizeGrantedAt
      });
      return {
        userId: doc.id,
        name: d.name || doc.id,
        isActive: d.isActive !== false,
        no: typeof d.no === "number" ? d.no : Infinity
      };
    }).filter((u) => u.isActive).sort((a, b) => a.no - b.no);

    // グループ作成モーダルのメンバー選択にも使い回す（自分は自動追加なので除く）
    allUsersCache = allUsersList.filter((u) => u.userId !== myUserId);
  } catch (error) {
    console.error("ユーザー一覧の取得エラー:", error);
  }
}

// ---- 切替UI ----
function setTalkTab(tab) {
  currentTalkTab = tab === "group" ? "group" : "personal";
  if (talkTabControl) {
    talkTabControl.dataset.active = currentTalkTab;
    talkTabControl.querySelectorAll(".segmented-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === currentTalkTab);
    });
  }
  if (personalButtonArea) personalButtonArea.classList.toggle("hidden", currentTalkTab !== "personal");
  if (groupArea) groupArea.classList.toggle("hidden", currentTalkTab !== "group");
  try { localStorage.setItem(TALK_TAB_STORAGE_KEY, currentTalkTab); } catch (e) { /* 保存できなくても問題なし */ }
}

document.addEventListener("DOMContentLoaded", () => {
  talkTabControl = document.getElementById("talk-tab-control");
  personalButtonArea = document.getElementById("personal-button-area");
  groupArea = document.getElementById("group-area");

  talkTabControl.querySelectorAll(".segmented-item").forEach((btn) => {
    btn.addEventListener("click", () => setTalkTab(btn.dataset.tab));
  });

  let saved = "personal";
  try { saved = localStorage.getItem(TALK_TAB_STORAGE_KEY) || "personal"; } catch (e) { /* 無視 */ }
  setTalkTab(saved);
});

// ★ 各タブに、未読があれば赤丸を出す
function updateTabBadges() {
  let hasPersonalUnread = false;
  let hasGroupUnread = false;
  Object.keys(unreadCountCache).forEach((roomId) => {
    const meta = roomMetaMap[roomId];
    if (!meta || !(unreadCountCache[roomId] > 0)) return;
    if (meta.category === "group") hasGroupUnread = true;
    else hasPersonalUnread = true;
  });
  if (!talkTabControl) return;
  const personalBadge = talkTabControl.querySelector('[data-tab="personal"] .tab-badge');
  const groupBadge = talkTabControl.querySelector('[data-tab="group"] .tab-badge');
  if (personalBadge) personalBadge.classList.toggle("hidden", !hasPersonalUnread);
  if (groupBadge) groupBadge.classList.toggle("hidden", !hasGroupUnread);
}

// ★ 未読件数の表示を、要素に反映する
function applyUnreadToElement(element, count) {
  element.textContent = `新着: ${count}件`;
  element.classList.toggle("no-message", count === 0);
}

// ---- 個人タブ ----
// ★ 個人タブ全体を作り直す。自分(メモ) → トークしたことのある相手(新しい順) → まだの相手、の順
function renderPersonalList() {
  if (!personalButtonArea) return;
  personalButtonArea.innerHTML = "";

  // 相手ごとに、いちばん新しいルームを1つ選ぶ
  const roomByPartner = {};
  Object.keys(roomMetaMap).forEach((roomId) => {
    const meta = roomMetaMap[roomId];
    if (meta.category === "group") return;
    const current = roomByPartner[meta.partnerId];
    if (!current || meta.lastUpdatedAtMs > current.lastUpdatedAtMs) {
      roomByPartner[meta.partnerId] = Object.assign({ roomId }, meta);
    }
  });

  const knownIds = new Set(allUsersList.map((u) => u.userId));
  const people = allUsersList.map((u) => ({ userId: u.userId, name: u.name }));
  // 一覧に居ない相手（停止中など）でもルームがあれば表示できるようにする
  Object.keys(roomByPartner).forEach((partnerId) => {
    if (!knownIds.has(partnerId)) people.push({ userId: partnerId, name: getUserDisplayName(partnerId) });
  });
  if (!knownIds.has(myUserId) && !people.some((u) => u.userId === myUserId)) {
    people.unshift({ userId: myUserId, name: getUserDisplayName(myUserId) });
  }

  // 1) 自分だけのトーク
  const me = people.find((u) => u.userId === myUserId);
  personalButtonArea.appendChild(createPersonalButton(me, roomByPartner[myUserId] || null, true));

  // 2) トークしたことのある相手（更新が新しい順、「今日」「昨日」の見出し付き）
  const withRoom = people
    .filter((u) => u.userId !== myUserId && roomByPartner[u.userId])
    .sort((a, b) => roomByPartner[b.userId].lastUpdatedAtMs - roomByPartner[a.userId].lastUpdatedAtMs);
  let currentLabel = null;
  withRoom.forEach((u) => {
    const room = roomByPartner[u.userId];
    const label = getDateGroupLabel(room.lastUpdatedAtMs);
    if (label !== currentLabel) {
      const header = document.createElement("p");
      header.classList.add("talk-group-header");
      header.textContent = label;
      personalButtonArea.appendChild(header);
      currentLabel = label;
    }
    personalButtonArea.appendChild(createPersonalButton(u, room, false));
  });

  // 3) まだトークしていない相手
  const withoutRoom = people.filter((u) => u.userId !== myUserId && !roomByPartner[u.userId]);
  if (withoutRoom.length > 0) {
    const header = document.createElement("p");
    header.classList.add("talk-group-header");
    header.textContent = "まだトークしていない人";
    personalButtonArea.appendChild(header);
    withoutRoom.forEach((u) => {
      personalButtonArea.appendChild(createPersonalButton(u, null, false));
    });
  }
}

function createPersonalButton(user, room, isSelf) {
  const cached = getUserCache(user.userId) || {};
  const displayName = cached.name || user.name || user.userId;

  const talkButton = document.createElement("div");
  talkButton.classList.add("talk-button");
  if (!room) talkButton.classList.add("no-room");

  talkButton.appendChild(createAvatar(displayName, undefined, cached.imageUrl || ""));

  const titleArea = document.createElement("p");
  titleArea.classList.add("title");
  titleArea.textContent = isSelf ? `${displayName}（自分）` : displayName;
  talkButton.appendChild(titleArea);

  const rightArea = document.createElement("p");
  rightArea.classList.add("new-message");
  if (room) {
    rightArea.id = `unread-${room.roomId}`;
    if (typeof unreadCountCache[room.roomId] === "number") {
      applyUnreadToElement(rightArea, unreadCountCache[room.roomId]);
    } else {
      rightArea.textContent = "取得中...";
    }
    talkButton.id = `room-${room.roomId}`;
    talkButton.addEventListener("click", () => {
      window.location.href = `./talk.html?id=${room.roomId}`;
    });
  } else {
    rightArea.textContent = "トークを始める";
    talkButton.addEventListener("click", () => startPersonalTalk(user, isSelf));
  }
  talkButton.appendChild(rightArea);
  return talkButton;
}

// ★ まだトークしていない相手を押したとき：確認してから新しい個人トークを作る
async function startPersonalTalk(user, isSelf) {
  if (isCreatingPersonalTalk) return;
  const displayName = getUserDisplayName(user.userId);
  const message = isSelf
    ? "自分だけのトークを開始しますか？"
    : `"${displayName}"とのトークを開始しますか？`;
  const ok = await AppDialog.confirm(message, { okText: "開始する" });
  if (!ok) return;

  isCreatingPersonalTalk = true;
  try {
    // ルームIDは2人のIDから一意に決める（同時に押されても同じルームになり、二重作成を防げる）
    const roomId = isSelf
      ? `dm_${myUserId}`
      : `dm_${[myUserId, user.userId].sort().join("__")}`;
    const members = isSelf ? [myUserId] : [myUserId, user.userId];
    await setDoc(doc(db, "KokoKengaku", roomId), {
      // 個人トークの表示名は相手の名前から動的に決めるので、title は管理者画面などでの予備
      title: isSelf ? `${getUserDisplayName(myUserId)}（自分）` : `${getUserDisplayName(myUserId)}と${displayName}`,
      members: members,
      lastUpdatedAt: serverTimestamp()
    });
    window.location.href = `./talk.html?id=${roomId}`;
  } catch (error) {
    console.error("個人トークの作成エラー:", error);
    isCreatingPersonalTalk = false;
    await AppDialog.alert("トークを開始できませんでした。\n" + (error.message || String(error)));
  }
}

// ---- グループタブ ----
function createGroupButton(roomId, roomData) {
  const talkButton = document.createElement("div");
  talkButton.classList.add("talk-button");
  talkButton.id = `room-${roomId}`;
  talkButton.dataUpdatedAt = roomData.lastUpdatedAt;
  talkButton.addEventListener("click", () => {
    window.location.href = `./talk.html?id=${roomId}`;
  });

  talkButton.appendChild(createAvatar(roomData.title, undefined, roomData.imageUrl || ""));
  talkButton.dataset.avatarKey = `${roomData.title}|${roomData.imageUrl || ""}`;

  const titleArea = document.createElement("p");
  titleArea.classList.add("title");
  titleArea.textContent = roomData.title;

  const newMessageArea = document.createElement("p");
  newMessageArea.classList.add("new-message");
  newMessageArea.id = `unread-${roomId}`;
  if (typeof unreadCountCache[roomId] === "number") {
    applyUnreadToElement(newMessageArea, unreadCountCache[roomId]);
  } else {
    newMessageArea.textContent = "取得中...";
  }

  talkButton.appendChild(titleArea);
  talkButton.appendChild(newMessageArea);
  return talkButton;
}

function updateGroupButton(talkButton, roomData) {
  const titleArea = talkButton.querySelector(".title");
  if (titleArea) titleArea.textContent = roomData.title;
  talkButton.dataUpdatedAt = roomData.lastUpdatedAt;

  // グループ名・アイコンが変わったときだけアイコンを作り直す
  const avatarKey = `${roomData.title}|${roomData.imageUrl || ""}`;
  if (talkButton.dataset.avatarKey !== avatarKey) {
    const oldAvatar = talkButton.querySelector(".avatar-circle");
    const newAvatar = createAvatar(roomData.title, undefined, roomData.imageUrl || "");
    if (oldAvatar) oldAvatar.replaceWith(newAvatar);
    else talkButton.prepend(newAvatar);
    talkButton.dataset.avatarKey = avatarKey;
  }
}

function updateGroupEmptyText(talkButtonArea) {
  const hasButton = !!talkButtonArea.querySelector(".talk-button");
  let emptyText = document.getElementById("group-empty-text");
  if (hasButton) {
    if (emptyText) emptyText.remove();
  } else if (!emptyText) {
    emptyText = document.createElement("p");
    emptyText.id = "group-empty-text";
    emptyText.classList.add("talk-list-empty");
    emptyText.textContent = "グループトークはまだありません。";
    talkButtonArea.appendChild(emptyText);
  }
}

async function getAllTalkData() {
  const talkButtonArea = document.getElementById("talk-button-area");
  const talkButtonLoading = document.getElementById("talk-button-loading");
  
  if (talkListenerUnsubscribe) {
    talkListenerUnsubscribe();
  }
  if (userDocUnsubscribeForUnread) {
    userDocUnsubscribeForUnread();
  }

  try {
    // ★ まず自分の最終確認情報（lastChecked）を先に取得しておく。
    //   これを待たずにルーム一覧の表示を始めると、一瞬「全部未読」→実際の数値、という
    //   表示のチラつきが起きてしまうため、最初の描画より前に確定させる。
    if (isInitialTalkListLoad) {
      setLoadingStage("最終確認情報を読み込んでいます...", 15);
    }
    const initialUserSnapshot = await getDoc(doc(db, "users_random", myUserId));
    currentUserLastCheckedMap = (initialUserSnapshot.data() || {}).lastChecked || {};
  } catch (error) {
    console.error("最終確認情報の初期取得エラー:", error);
  }

  // ★ 個人タブに並べる全ユーザーを読み込む
  if (isInitialTalkListLoad) {
    setLoadingStage("ユーザー情報を読み込んでいます...", 25);
  }
  await loadAllUsers();

  // ★ 以降のlastChecked変更は、トーク一覧の更新とは独立してリアルタイム監視する
  userDocUnsubscribeForUnread = onSnapshot(doc(db, "users_random", myUserId),
    (userDoc) => {
      const userData = userDoc.data() || {};
      currentUserLastCheckedMap = userData.lastChecked || {};

      // 自分の既読状態が更新されたら、すでに表示中の全ルームの未読数を再計算する
      renderedRoomIds.forEach((roomId) => {
        updateSingleRoomUnread(roomId, currentUserLastCheckedMap[roomId]);
      });
    }, (error) => {
      console.error("最終確認情報の監視エラー:", error);
    });

  if (isInitialTalkListLoad) {
    setLoadingStage("トークルーム情報を読み込んでいます...", 35);
  }

  try {
    let talkQuery = collection(db, "KokoKengaku");
    
    if (!meIsAdmin) {
      // 一般ユーザーの場合は、自分がメンバーに含まれるルームのみに絞り込む
      talkQuery = query(talkQuery, where("members", "array-contains", myUserId));
    }
    
    talkListenerUnsubscribe = onSnapshot(talkQuery, async (talkSnapshot) => {
        // ★ このスナップショットが「初回のトーク一覧表示」かどうかを固定しておく
        const isThisInitialLoad = isInitialTalkListLoad;
        if (isThisInitialLoad) {
          isInitialTalkListLoad = false;
        }

        const changes = talkSnapshot.docChanges();
        const totalChanges = changes.length;
        let processedChanges = 0;
        let personalDirty = false;          // 個人タブを作り直す必要があるか
        const roomsToRefreshUnread = [];    // 未読数を数え直すルーム
        // ★ 初回表示時のみ、各ルームの未読数計算が完了するのを待ってからオーバーレイを閉じる
        const unreadCountPromises = [];

        // ルームを一覧から外す共通処理
        const removeRoomFromLists = (roomId) => {
          const prevMeta = roomMetaMap[roomId];
          if (prevMeta && prevMeta.category !== "group") personalDirty = true;
          delete roomMetaMap[roomId];
          delete unreadCountCache[roomId];
          renderedRoomIds.delete(roomId);
          const groupButton = talkButtonArea.querySelector(`#room-${CSS.escape(roomId)}`);
          if (groupButton) groupButton.remove();
        };

        // 変化（追加・修正・削除）があった差分だけをループ処理する
        changes.forEach((change) => {
          processedChanges++;
          if (isThisInitialLoad && totalChanges > 0) {
            const percent = Math.round((processedChanges / totalChanges) * 100);
            // ★ このステージは進捗バー全体の35%〜75%の区間にマッピングする
            setLoadingStage(`トーク一覧を読み込んでいます (${percent}%)`, 35 + (percent / 100) * 40);
          }

          const talkDoc = change.doc;
          const roomId = talkDoc.id;
          const roomData = talkDoc.data();

          // 削除された、または(メンバー変更などで)自分に見せないルームになった場合
          if (change.type === "removed" || !isRoomVisibleForMe(roomData)) {
            removeRoomFromLists(roomId);
            return;
          }

          const members = roomData.members || [];
          const category = getRoomCategory(members);
          const prevMeta = roomMetaMap[roomId];

          const lastUpdatedMs = toMillisOrNull(roomData.lastUpdatedAt)
            || (talkDoc.metadata.hasPendingWrites ? Date.now() : 0);
          roomMetaMap[roomId] = {
            category: category,
            partnerId: category === "group" ? "" : (members.find((id) => id !== myUserId) || myUserId),
            title: roomData.title || "",
            imageUrl: roomData.imageUrl || "",
            lastUpdatedAtMs: lastUpdatedMs
          };
          renderedRoomIds.add(roomId);

          if (category === "group") {
            // 個人 → グループに変わった場合は、個人タブ側から外す
            if (prevMeta && prevMeta.category !== "group") personalDirty = true;

            const existingButton = document.getElementById(`room-${roomId}`);
            if (existingButton && talkButtonArea.contains(existingButton)) {
              updateGroupButton(existingButton, roomData);
            } else {
              talkButtonArea.appendChild(createGroupButton(roomId, roomData));
            }
            regroupTalkButtons(talkButtonArea);
          } else {
            // グループ → 個人に変わった場合は、グループ側から外す
            if (prevMeta && prevMeta.category === "group") {
              const oldButton = talkButtonArea.querySelector(`#room-${CSS.escape(roomId)}`);
              if (oldButton) oldButton.remove();
            }
            personalDirty = true;
          }

          roomsToRefreshUnread.push(roomId);
        });

        // 個人タブは、変化があったときに作り直す（未読数はキャッシュから復元される）
        if (personalDirty || isThisInitialLoad) {
          renderPersonalList();
        }
        regroupTalkButtons(talkButtonArea);
        updateGroupEmptyText(talkButtonArea);

        // ★ 未読数をピンポイントで数え直して更新する
        roomsToRefreshUnread.forEach((roomId) => {
          const unreadPromise = updateSingleRoomUnread(roomId, currentUserLastCheckedMap[roomId]);
          if (isThisInitialLoad) unreadCountPromises.push(unreadPromise);
        });
        updateTabBadges();

        // 初回のローディング非表示処理
        talkButtonLoading.classList.add("hidden");
        talkButtonArea.classList.remove("hidden");

        // ★ 初回表示時のみ、各ルームの未読数計算が終わるまでオーバーレイを出したままにする
        if (isThisInitialLoad) {
          if (unreadCountPromises.length > 0) {
            // ★「止まっているのか進んでいるのか分からない」を防ぐため、1件終わるごとに
            //   件数と進捗バーを更新する（Promise.allでまとめて待つだけにしない）
            const totalUnreadChecks = unreadCountPromises.length;
            let completedUnreadChecks = 0;
            setLoadingStage(`未読件数を計算しています (0/${totalUnreadChecks})`, 75);

            await Promise.all(unreadCountPromises.map((promise) =>
              promise
                .catch((error) => {
                  console.error("未読数計算の待機中にエラー:", error);
                })
                .then(() => {
                  completedUnreadChecks++;
                  const percent = 75 + (completedUnreadChecks / totalUnreadChecks) * 25;
                  setLoadingStage(
                    `未読件数を計算しています (${completedUnreadChecks}/${totalUnreadChecks})`,
                    percent
                  );
                })
            ));
          }
          hideLoadingOverlayNowForAppList();
        }
        
      }, (error) => {
        console.error("リアルタイムリスナーエラー:", error);
      });
      
  } catch (error) {
    console.error("データ取得エラー:", error);
    AppDialog.alert(error.message || String(error));
    // ★ エラー時にオーバーレイが出っぱなしにならないよう、念のため閉じておく
    hideLoadingOverlayNowForAppList();
  }
}

// ★ 特定の1部屋だけ未読数を数え直して画面を書き換える関数
async function updateSingleRoomUnread(roomId, lastCheckedTimestamp) {
  if (!document.getElementById(`unread-${roomId}`)) return;

  const lastCheckedTime = lastCheckedTimestamp ? lastCheckedTimestamp.toDate() : new Date(0);
  const baseQuery = query(
    collection(db, "KokoKengaku", roomId, "talk"),
    where("time", ">", lastCheckedTime)
  );

  let unreadCount = null;

  try {
    // ★ 該当メッセージを全部ダウンロードしてから件数を数えるのではなく、
    //   Firestoreの集計クエリ(count())で「件数だけ」をサーバー側で数えてもらう。
    const unreadSnapshot = await getCountFromServer(baseQuery);
    unreadCount = unreadSnapshot.data().count;
  } catch (countError) {
    // ★ 集計クエリが使えない／失敗する場合でも未読数が出せるように、
    //   以前の「全件取得して件数を数える」方式にフォールバックする
    console.error(`未読数の集計クエリに失敗 [Room: ${roomId}]。通常のクエリにフォールバックします:`, countError);
    try {
      const fallbackSnapshot = await getDocs(baseQuery);
      unreadCount = fallbackSnapshot.size;
    } catch (fallbackError) {
      console.error(`未読数の取得に失敗 [Room: ${roomId}]:`, fallbackError);
      // 待っている間に画面が作り直されている場合があるので、要素は取り直す
      const failedArea = document.getElementById(`unread-${roomId}`);
      if (failedArea) failedArea.textContent = "取得失敗";
      return;
    }
  }

  unreadCountCache[roomId] = unreadCount;
  // ★ 待っている間に個人タブが作り直されていることがあるので、ここで要素を取り直す
  const newMessageArea = document.getElementById(`unread-${roomId}`);
  if (newMessageArea) applyUnreadToElement(newMessageArea, unreadCount);
  updateTabBadges();
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

// ================================
// ★ 新しいトークの作成（管理者のみ）
// ================================

let openCreateTalkModalButton;
let createTalkModal;
let createTalkModalClose;
let createTalkTitleInput;
let createTalkMemberSearch;
let createTalkMemberLoading;
let createTalkMemberList;
let createTalkSubmitButton;

let allUsersCache = null; // ★ メンバー選択用の全ユーザー一覧（一度取得したら使い回す）

document.addEventListener("DOMContentLoaded", () => {
  openCreateTalkModalButton = document.getElementById("open-create-talk-modal-button");
  createTalkModal = document.getElementById("create-talk-modal");
  createTalkModalClose = document.getElementById("create-talk-modal-close");
  createTalkTitleInput = document.getElementById("create-talk-title-input");
  createTalkMemberSearch = document.getElementById("create-talk-member-search");
  createTalkMemberLoading = document.getElementById("create-talk-member-loading");
  createTalkMemberList = document.getElementById("create-talk-member-list");
  createTalkSubmitButton = document.getElementById("create-talk-submit-button");

  openCreateTalkModalButton.addEventListener("click", openCreateTalkModal);

  createTalkModalClose.addEventListener("click", () => {
    createTalkModal.classList.add("hidden");
  });

  createTalkTitleInput.addEventListener("input", updateCreateTalkSubmitState);

  createTalkMemberSearch.addEventListener("input", () => {
    renderCreateTalkMemberList(createTalkMemberSearch.value.trim());
    updateCreateTalkSubmitState();
  });

  createTalkSubmitButton.addEventListener("click", handleCreateTalk);

  // ★ チェックの増減でも作成ボタンの有効/無効を更新する
  createTalkMemberList.addEventListener("change", updateCreateTalkSubmitState);
});

// ★「＋ 新しいトークを作成」ボタンから呼ばれる：モーダルを開いてユーザー一覧を読み込む
async function openCreateTalkModal() {
  createTalkTitleInput.value = "";
  createTalkMemberSearch.value = "";
  createTalkModal.classList.remove("hidden");
  updateCreateTalkSubmitState();

  if (allUsersCache) {
    createTalkMemberLoading.classList.add("hidden");
    renderCreateTalkMemberList("");
    updateCreateTalkSubmitState();
    return;
  }

  createTalkMemberLoading.classList.remove("hidden");
  createTalkMemberList.innerHTML = "";

  try {
    const usersSnapshot = await getDocs(collection(db, "users_random"));
    allUsersCache = usersSnapshot.docs
      .map((doc) => ({
        userId: doc.id,
        name: (doc.data() || {}).name || doc.id,
        no: typeof (doc.data() || {}).no === "number" ? doc.data().no : Infinity
      }))
      .filter((u) => u.userId !== myUserId) // ★ 自分は自動的にメンバーへ入るので選択肢からは除く
      // ★ no順（無ければ最後）に並べる
      .sort((a, b) => a.no - b.no);

    createTalkMemberLoading.classList.add("hidden");
    renderCreateTalkMemberList("");
  } catch (error) {
    createTalkMemberLoading.classList.add("hidden");
    console.error("ユーザー一覧の取得エラー:", error);
    await AppDialog.alert("ユーザー一覧の取得に失敗しました。\n" + error.message);
  }
}

// ★ 検索テキストで絞り込みつつ、チェックボックス付きのユーザー一覧を描画する
function renderCreateTalkMemberList(filterText) {
  if (!allUsersCache) return;

  // ★ 再描画前に、これまでのチェック状態を保持しておく（検索しても選択が消えないように）
  const previouslyChecked = new Set(
    Array.from(createTalkMemberList.querySelectorAll("input[type=checkbox]:checked")).map((cb) => cb.value)
  );

  createTalkMemberList.innerHTML = "";

  const lowerFilter = filterText.toLowerCase();
  const filteredUsers = allUsersCache.filter((u) => u.name.toLowerCase().includes(lowerFilter));

  if (filteredUsers.length === 0) {
    const emptyText = document.createElement("p");
    emptyText.textContent = "該当するユーザーがいません。";
    createTalkMemberList.appendChild(emptyText);
    return;
  }

  filteredUsers.forEach((u) => {
    const label = document.createElement("label");
    label.classList.add("create-talk-member-item");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = u.userId;
    checkbox.checked = previouslyChecked.has(u.userId);

    label.appendChild(checkbox);
    label.appendChild(createAvatar(u.name, "small"));

    const nameSpan = document.createElement("span");
    nameSpan.textContent = u.name;
    label.appendChild(nameSpan);

    createTalkMemberList.appendChild(label);
  });
}

// ★ タイトルが空でなければ作成ボタンを有効化する
function updateCreateTalkSubmitState() {
  const hasTitle = createTalkTitleInput && createTalkTitleInput.value.trim() !== "";
  // ★ グループは3人以上なので、自分以外を2人以上選ぶ必要がある
  const selectedCount = createTalkMemberList
    ? createTalkMemberList.querySelectorAll("input[type=checkbox]:checked").length
    : 0;
  createTalkSubmitButton.disabled = !(hasTitle && selectedCount >= 2);
}

// ★ 実際にKokoKengakuへ新しいルームを作成する
async function handleCreateTalk() {
  const title = createTalkTitleInput.value.trim();
  if (!title) return;

  const selectedMemberIds = Array.from(
    createTalkMemberList.querySelectorAll("input[type=checkbox]:checked")
  ).map((cb) => cb.value);
  if (selectedMemberIds.length < 2) return; // グループは3人以上（自分＋2人以上）

  // ★ 自分（作成者）は必ずメンバーに含める
  const members = Array.from(new Set([...selectedMemberIds, myUserId]));

  createTalkSubmitButton.disabled = true;
  createTalkSubmitButton.textContent = "作成中...";

  try {
    await addDoc(collection(db, "KokoKengaku"), {
      title: title,
      members: members,
      lastUpdatedAt: serverTimestamp()
    });

    createTalkModal.classList.add("hidden");
    createTalkTitleInput.value = "";
    createTalkMemberSearch.value = "";
  } catch (error) {
    console.error("トーク作成エラー:", error);
    await AppDialog.alert("トークの作成に失敗しました。\n" + error.message);
  } finally {
    createTalkSubmitButton.textContent = "作成する";
    updateCreateTalkSubmitState();
  }
}
