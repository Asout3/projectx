'use client';

import { auth } from '@/auth/firebaseSDK';
import { useEffect, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';


export default function greet() {

  const [user, setUser] = useState<null | User>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        console.log("User:", currentUser.displayName);
      } else {
        setUser(null);
      }
    });

    return () => unsubscribe();
  }, []);

    return (
      <div>
        <div className="mt-20">
          {user ? (
            <div className="my-4">
              <h1>Hello {user.displayName ? user.displayName.split(' ')[0] : 'there'}!!! What can i help you with?</h1>
              
            
              {/* Add your dashboard content here */}
            </div>
          ) : (
            <div>
              <h1>Please log in to access the dashboard.</h1>
            </div>
          )}
        </div>
      </div>
    );
  }
  
