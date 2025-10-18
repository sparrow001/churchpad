// js/auth.js
import { auth } from './firebase.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

const signinBtn = document.getElementById('signinBtn');
const logoutBtn = document.getElementById('logoutBtn');

signinBtn.addEventListener('click', () => { window.location.href = 'login.html'; });

logoutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
    // optionally, you could also disable remote mode here via player
    if (window.playerCtrl) window.playerCtrl.disableRemoteMode();
  } catch (e) {
    console.warn('logout failed', e);
  }
});

// reflect auth state
onAuthStateChanged(auth, (user) => {
  if (user) {
    signinBtn.style.display = 'none';
    logoutBtn.style.display = 'inline-block';
  } else {
    signinBtn.style.display = 'inline-block';
    logoutBtn.style.display = 'none';
  }
  if (window.playerCtrl) window.playerCtrl.onAuthStateChanged(user);
});
