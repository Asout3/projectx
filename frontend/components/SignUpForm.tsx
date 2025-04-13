'use client'

import { signInWithGoogleRed, auth } from "@/auth/firebaseSDK";
import { useEffect } from 'react';
import { getRedirectResult, onAuthStateChanged } from 'firebase/auth';
//import {  } from "firebase/auth";

const SignIn = () => {
  useEffect(() => {
    console.log('starting...')
    const fetchRedirectResult = async () => {
      try {
        const response = await getRedirectResult(auth);
        if (!response) {
          console.log("No redirect response – session might be lost or login cancelled.");
        } else {
          console.log('SUCCESS:', response);
        }
      } catch (error) {
        console.log('Error retrieving redirect result:', error);
      }
    };
  
    fetchRedirectResult();
  }, []);
  
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        console.log("User signed in via redirect or already signed in:", user);
      } else {
        console.log("No user is signed in.");
      }
    });
  
    return () => unsubscribe();
  }, []);

  return (
    <div>
      <button type="button" onClick={signInWithGoogleRed}>
        Sign in with Google
      </button>
    </div>
  );
};

export default SignIn;
