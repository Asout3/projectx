"use client";

import React, { useState } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
} from "firebase/auth";
import { auth } from "../auth/firebaseSDK";

export default function AuthForm() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    confirmPassword: "",
  });

  const toggleMode = () => {
    setIsSignUp((prev) => !prev);
    setFormData({ email: "", password: "", confirmPassword: "" });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData((prev) => ({
      ...prev,
      [e.target.name]: e.target.value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    try {
      if (isSignUp) {
        if (formData.password !== formData.confirmPassword) {
          alert("Passwords do not match");
          return;
        }

        const userCredential = await createUserWithEmailAndPassword(
          auth,
          formData.email,
          formData.password
        );
        console.log("User signed up:", userCredential.user);
        alert("Sign up successful!");
      } else {
        const userCredential = await signInWithEmailAndPassword(
          auth,
          formData.email,
          formData.password
        );

        console.log("User logged in:", userCredential.user);
        alert("Login successful!");
      }

      setFormData({ email: "", password: "", confirmPassword: "" });
    } catch (error: any) {
      console.error("Firebase auth error:", error.message);
      alert(error.message);
    }
  };

  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();

    try {
      const result = await signInWithPopup(auth, provider);

      console.log("Google Sign-in user:", result.user);
      alert("Google Sign-in successful!");

    } catch (error: any) {

      console.error("Google Sign-in error:", error.message);
      alert(error.message);

    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-sky-500/50 p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-sky-500/100 p-6 rounded-2xl shadow-md w-full max-w-sm space-y-4"
      >
        <h2 className="text-2xl font-bold text-center">
          {isSignUp ? "Create Account" : "Login"}
        </h2>

        <div className="space-y-2">
          <label className="block text-sm font-medium">Email</label>
          <input
            type="email"
            name="email"
            required
            className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
            value={formData.email}
            onChange={handleChange}
          />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium">Password</label>
          <input
            type="password"
            name="password"
            required
            className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
            value={formData.password}
            onChange={handleChange}
          />
        </div>

        {isSignUp && (
          <div className="space-y-2">
            <label className="block text-sm font-medium">Confirm Password</label>
            <input
              type="password"
              name="confirmPassword"
              required
              className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              value={formData.confirmPassword}
              onChange={handleChange}
            />
          </div>
        )}

        <button
          type="submit"
          className="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition"
        >
          {isSignUp ? "Sign Up" : "Login"}
        </button>

        <p className="text-center text-sm">
          {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={toggleMode}
            className="text-blue-600 hover:underline"
          >
            {isSignUp ? "Login" : "Sign up"}
          </button>
        </p>

        <div className="text-center">
          <p className="text-sm my-2 text-gray-600">OR</p>
          <button
            type="button"
            onClick={handleGoogleSignIn}
            className="w-full bg-red-500 text-white py-2 rounded-lg hover:bg-red-600 transition"
          >
            Sign in with Google
          </button>
        </div>
      </form>
    </div>
  );
}


//firebase popup closed by the user 