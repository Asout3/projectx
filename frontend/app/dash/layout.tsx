"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { auth } from "../../auth/firebaseSDK";

//import { auth } from ""

//import { auth } from "@/lib/firebase"; // Adjust if needed to match your file structure
// NavBar from "@/components/navbar/NavBar"; // Adjust path as needed

export default function DashboardLayout({
  children, // will be a page or nested layout
}: {
  children: React.ReactNode;
}) {
  const [isUserValid, setIsUserValid] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const checkAuth = () => {
      auth.onAuthStateChanged((user) => {
        if (user) {
          setIsUserValid(true);
          console.log("This is the logged-in user", user);
        } else {
          console.log("No user found");
          router.push("/login"); // Redirect to home or sign-in page
        }
      });
    };

    checkAuth();
  }, [router]);

  if (!isUserValid) {
    return (
      <div>Loading...</div> // You can add a spinner or loading component here
    );
  }

  return (
    <div>
      {/* Include shared UI here e.g., a navbar */}

      <div className="mt-20">{children}</div>
    </div>
  );
}