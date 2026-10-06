// ★ Firebase の初期化と、各ページが使う関数の窓口（モジュラーSDK / v9+ 形式）
//   これまで index/talk/app の各HTMLで読み込んでいた「compat（互換）」版のスクリプト3本と、
//   各JSに重複して書かれていた firebaseConfig を、このファイルにまとめた。
//   使う関数だけを import するので、互換レイヤー分のコードを読み込まずに済む。
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
  terminate,
  clearIndexedDbPersistence,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  documentId,
  writeBatch,
  getCountFromServer,
  serverTimestamp,
  arrayUnion,
  increment,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAqIiNj0N4WruPSOkWbeo5gxzsNyeMkuLo",
  authDomain: "appsforschool-study.firebaseapp.com",
  projectId: "appsforschool-study",
  storageBucket: "appsforschool-study.firebasestorage.app",
  messagingSenderId: "740735293440",
  appId: "1:740735293440:web:982702b6d53aaa18ec60e5"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// ★ Firestoreの永続キャッシュ（IndexedDB）を有効にする。
//   前回までに読み込んだデータが端末に残るので、再訪問時はまずキャッシュから即表示され、
//   サーバーからは「変更があった分」だけが届く（読み取り回数・待ち時間の両方が減る）。
//   複数タブで開いても動くよう persistentMultipleTabManager を使う。
//   IndexedDB が使えない環境（プライベートブラウズ等）では、従来どおりのメモリキャッシュに戻す。
let firestore;
try {
  firestore = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  console.warn("永続キャッシュを有効にできませんでした。通常モードで続行します:", e);
  firestore = getFirestore(app);
}
export const db = firestore;

// ★ ログアウト時に、端末に残っている Firestore のキャッシュを消す
//   （共用端末で、次にログインした人に前の人のデータが見えないようにする）
export async function clearFirestoreLocalCache() {
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (e) {
    console.warn("Firestoreキャッシュの削除に失敗:", e);
  }
}

export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, onSnapshot,
  query, where, orderBy, documentId, writeBatch, getCountFromServer,
  serverTimestamp, arrayUnion, increment, Timestamp
};
