'use client'
    
    import { signInWithGoogleRed } from "@/auth/firebaseSDK";

    const SignIn = () => {
      const handleGoogleSignIn = () => {
        signInWithGoogleRed(); 
      };
    
      return (
        <div>
          <button type="button" onClick={handleGoogleSignIn}>
            Google Try
          </button>
        </div>
      );
    };
    
    export default SignIn;
    