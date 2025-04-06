// Import the functions you need from the SDKs you need
import { FirebaseApp, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyA0dv3j_HnRuGNEyedolUBbkgUye6sTu8U",
  authDomain: "projectx-7fa10.firebaseapp.com",
  projectId: "projectx-7fa10",
  storageBucket: "projectx-7fa10.firebasestorage.app",
  messagingSenderId: "422166295537",
  appId: "1:422166295537:web:d229a93b23f39cfbd3ca50",
  measurementId: "G-Q8GKNDHRTC",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

function customGetAuth(app: FirebaseApp) {
  throw new Error("Function not implemented.");
}

// import { initializeApp } from "firebase/app";
// import { getAuth } from "firebase/auth";

// const firebaseConfig = {
//   apiKey: "YOUR_API_KEY",
//   authDomain: "YOUR_AUTH_DOMAIN",
//   projectId: "YOUR_PROJECT_ID",
//   storageBucket: "YOUR_STORAGE_BUCKET",
//   messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
//   appId: "YOUR_APP_ID",
// };

// const app = initializeApp(firebaseConfig);
// export const auth = getAuth(app);
