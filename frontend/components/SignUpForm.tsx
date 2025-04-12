'use client'

import { signInWithGoogleRed, auth } from "@/auth/firebaseSDK";
import { useEffect } from 'react';
import { getRedirectResult } from 'firebase/auth';

const SignIn = () => {
  useEffect(() => {
    const fetchRedirectResult = async () => {
      // Adding a small delay to make sure the redirect result is processed
      setTimeout(async () => {
        try {
          const response = await getRedirectResult(auth);
          console.log(response);
        } catch (error) {
          console.log('Error retrieving redirect result: ', error);
        }
      }, 200);  // Adjust delay if needed (100ms to 300ms)
    };

    fetchRedirectResult();
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
