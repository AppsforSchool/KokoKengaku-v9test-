import { auth, onAuthStateChanged, signInWithEmailAndPassword } from "./firebase.js";

let loadingOverlay;
document.addEventListener("DOMContentLoaded", () => {
  loadingOverlay = document.getElementById("loading-overlay");
  
});

let qrLoginButton;
let qrLoginModal;
let qrLoginModalClose;
let qrLoginModalFailure;
let qrLoginRetryButton;
document.addEventListener("DOMContentLoaded", () => {
  qrLoginButton = document.getElementById("qr-login-button");
  qrLoginModal = document.getElementById("qr-login-modal");
  qrLoginModalClose = document.getElementById("qr-login-modal-close");
  qrLoginModalFailure = document.getElementById("qr-login-failure");
  qrLoginRetryButton = document.getElementById("qr-login-retry");
  
  qrLoginButton.addEventListener("click", () => {
    qrLoginModal.classList.remove("hidden");
    startScan("login-qr-reader");
  });
  qrLoginModalClose.addEventListener("click", () => {
    qrLoginModal.classList.add("hidden");
    stopScan();
  });
  qrLoginRetryButton.addEventListener("click", () => {
    qrLoginModalFailure.classList.add("hidden");
    startScan("login-qr-reader");
  });
});

let html5QrCode;
async function startScan(qrReaderId)  {
  html5QrCode = new Html5Qrcode(qrReaderId);

  const config = {
    fps: 10, // 1秒間に何回スキャンするか
    qrbox: { width: 250, height: 250 } // スキャンする範囲（ガイド枠）
  };

  try {
    // カメラの起動（背面カメラを指定）
    await html5QrCode.start(
      { facingMode: "environment" },
      config,
      (decodedText) => {
        // 【成功】QRコードからテキストが読み取れた時
        console.log("読み取り成功:", decodedText);

        // 音を鳴らすなどの演出を入れるならここ

        // 読み取りを停止
        stopScan();

        // 前の工程で作った解析関数を呼び出す
        inputQrData(decodedText);
      },
      (errorMessage) => {
        // 【スキャン中】QRが見つからない間はここが呼ばれ続ける（無視してOK）
      }
    );
  } catch (err) {
    console.error("カメラ起動エラー:", err);
    alert("カメラの起動に失敗しました。ブラウザの権限を確認してください。");
    stopScan();
    qrLoginModal.classList.add("hidden");
  }
}
async function stopScan() {
  if (html5QrCode) {
    await html5QrCode.stop();
    html5QrCode = null;
  }
}

function inputQrData(decodedData) {
  const splitBySpace = decodedData.split(" ");
  if (splitBySpace.length === 2) {
    idInput.value = splitBySpace[0];
    passwordInput.value = splitBySpace[1];
    
    qrLoginModal.classList.add("hidden");
    updateLoginButtonState();
  } else {
    qrLoginModalFailure.classList.remove("hidden");
  }
}

let loginContainer;
let idInput;
let passwordInput;
let loginButton;
let errorMessage;
document.addEventListener("DOMContentLoaded", () => {
  loginContainer = document.getElementById("login-container");
  idInput = document.getElementById("id");
  passwordInput = document.getElementById("password");
  loginButton = document.getElementById("login-button");
  errorMessage = document.getElementById("error-message");
  
  idInput.addEventListener("input", () => {
    updateLoginButtonState();
  });
  passwordInput.addEventListener("input", () => {
    updateLoginButtonState();
  });
  loginButton.addEventListener("click", () => {
    handleLogin();
  });
  
 updateLoginButtonState(); 
});

function updateLoginButtonState() {
  if (loginButton) {
    const hasId = idInput && idInput.value.trim() !== '';
    const hasPassword = passwordInput && passwordInput.value.trim() !== '';
    // 両方入力されていればボタンを有効、そうでなければ無効
    loginButton.disabled = !(hasId && hasPassword);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      window.location.href = './app.html';
      loginContainer.classList.add("hidden");
    } else {
      loadingOverlay.classList.add("hidden");
      loginContainer.classList.remove("hidden");
    }
  });
});

const handleLogin = async () => {
  errorMessage.textContent = ''; // エラーメッセージをクリア

  // ログイン処理開始時の視覚的フィードバック
  loginButton.disabled = true; // ボタンを無効化して多重クリックを防ぐ
  loginButton.textContent = 'ログイン中...'; // テキストで処理中であることを表示

  try {
    const loginEmail = `${idInput.value}@appsforschool.com`;
    await signInWithEmailAndPassword(auth, loginEmail, passwordInput.value);
  } catch (error) {
    errorMessage.textContent = 'ログインに失敗しました。IDとパスワードを確認してください。';
    console.error("ログインエラー:", error);
    loginButton.disabled = false;
    loginButton.textContent = 'ログイン';
  }
};


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
