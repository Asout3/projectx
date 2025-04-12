import { initializeApp } from "firebase/app";

import { getAuth,
         signInWithRedirect,
         //signInWithPopup,
         GoogleAuthProvider,
} from "firebase/auth";

const firebaseConfig = {

  apiKey: "AIzaSyA0dv3j_HnRuGNEyedolUBbkgUye6sTu8U",

  authDomain: "projectx-7fa10.firebaseapp.com",

  projectId: "projectx-7fa10",

  storageBucket: "projectx-7fa10.firebasestorage.app",

  messagingSenderId: "422166295537",

  appId: "1:422166295537:web:d229a93b23f39cfbd3ca50",

  measurementId: "G-Q8GKNDHRTC"

};


// Initialize Firebase
const app = initializeApp(firebaseConfig);

const provider = new GoogleAuthProvider();

provider.setCustomParameters({
  prompt: "select_account", 
});

export const auth = getAuth(app);
export const signInWithGoogleRed = () => signInWithRedirect(auth, provider);
