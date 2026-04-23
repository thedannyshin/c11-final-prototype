import { initializeApp } from 'firebase/app';

// 1. Go to https://console.firebase.google.com
// 2. Create a project (or use an existing one)
// 3. Click "Add app" → Web → register the app
// 4. Copy the firebaseConfig values below
// 5. In the Firebase console, go to Build → Realtime Database → Create database
//    Choose a region, then start in TEST MODE (allows open read/write for 30 days)
const firebaseConfig = {
  apiKey: 'AIzaSyD3GH_cwot_LVvSVlw_Ddu2afufVdek3EY',
  authDomain: 'cca-final-prototype.firebaseapp.com',
  databaseURL: 'https://cca-final-prototype-default-rtdb.firebaseio.com',
  projectId: 'cca-final-prototype',
  storageBucket: 'cca-final-prototype.firebasestorage.app',
  messagingSenderId: '858690764923',
  appId: '1:858690764923:web:34b0c5476d2fef044562de',
};

export const firebaseApp = initializeApp(firebaseConfig);
