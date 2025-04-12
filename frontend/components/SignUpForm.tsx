'use client'
    
    import { signInWithGoogleRed, auth } from "@/auth/firebaseSDK";
    import { useEffect } from 'react';
    import { getRedirectResult } from 'firebase/auth';

    const SignIn = () => {
      useEffect(() => {
        const fetchRedirectResult = async () => {
          await getRedirectResult(auth);
          try {
            const response = await getRedirectResult(auth);
            console.log(response);
          } catch(error) {
            console.log('here is the error: ',error);
          }
        };
        fetchRedirectResult();
      }, []);
      // const handleGoogleSignIn = async () => {
      //   const {user} = await signInWithGoogleRed();
      //   console.log({user}); 
      // };
    
      return (
        <div>
          <button type="button" onClick={signInWithGoogleRed}>
            Google Try
          </button>
        </div>
      );
    };
    
    export default SignIn;
    