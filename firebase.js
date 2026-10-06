// ★ Firebase の初期化と、各ページが使う関数の窓口（モジュラーSDK / v9+ 形式）
//   これまで index/talk/app の各HTMLで読み込んでいた「compat（互換）」版のスクリプト3本と、
//   各JSに重複して書かれていた firebaseConfig を、このファイルにまとめた。
//   使う関数だけを import するので、互換レイヤー分のコードを読み込まずに済む。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore,
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
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
export const db = getFirestore(app);

export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, onSnapshot,
  query, where, orderBy, documentId, writeBatch, getCountFromServer,
  serverTimestamp, arrayUnion, Timestamp
};
