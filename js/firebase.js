// js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// Replace with your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyD7Kl1at4SaQlxiLMraTl2N-wA3jwfZslg",
  authDomain: "churchpad-5dc33.firebaseapp.com",
  databaseURL: "https://churchpad-5dc33-default-rtdb.firebaseio.com",
  projectId: "churchpad-5dc33",
  storageBucket: "churchpad-5dc33.firebasestorage.app",
  messagingSenderId: "671406528727",
  appId: "1:671406528727:web:0e1d4171ae7519b7b1b892",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// persistence ensures auth persists until logout
setPersistence(auth, browserLocalPersistence).catch((e) =>
  console.warn("setPersistence failed", e)
);
const db = getDatabase(app);

export { app, auth, db };
