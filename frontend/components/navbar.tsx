"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  NavbarMenuToggle,
  NavbarMenu,
  NavbarMenuItem,
  Link,
  Button,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Avatar,
} from "@heroui/react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../auth/firebaseSDK";

export const Logo = () => (
  <svg fill="none" height="36" viewBox="0 0 32 32" width="36">
    <path
      clipRule="evenodd"
      d="M17.6482 10.1305L15.8785 7.02583L7.02979 22.5499H10.5278L17.6482 10.1305ZM19.8798 14.0457L18.11 17.1983L19.394 19.4511H16.8453L15.1056 22.5499H24.7272L19.8798 14.0457Z"
      fill="currentColor"
      fillRule="evenodd"
    />
  </svg>
);

export default function CustomNavbar() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [user, setUser] = useState<any>(null);
  const router = useRouter();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setIsLoggedIn(true);
        setUser(user);
      } else {
        setIsLoggedIn(false);
        setUser(null);
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    await auth.signOut();
    router.push("/");
  };

  return (
    <Navbar onMenuOpenChange={setIsMenuOpen} maxWidth="xl">
      <NavbarContent>
        <NavbarMenuToggle
          aria-label={isMenuOpen ? "Close menu" : "Open menu"}
          className="sm:hidden"
        />
        <NavbarBrand>
          <Link href="/" className="flex items-center gap-2">
            <Logo />
            <p className="font-bold text-inherit">Bookgen.ai</p>
          </Link>
        </NavbarBrand>
      </NavbarContent>

      <NavbarContent className="hidden sm:flex gap-4" justify="center">
        {isLoggedIn && (
          <>
            <NavbarItem>
              <Link color="foreground" href="/dash">
                Dashboard
              </Link>
            </NavbarItem>
            <NavbarItem>
              <Link color="foreground" href="/documents">
                My Documents
              </Link>
            </NavbarItem>
          </>
        )}
      </NavbarContent>

      <NavbarContent justify="end">
        {!isLoggedIn ? (
          <>
            <NavbarItem className="hidden lg:flex">
              <Link href="/login">Login</Link>
            </NavbarItem>
            <NavbarItem>
              <Button as={Link} color="primary" href="/login" variant="flat">
                Sign Up
              </Button>
            </NavbarItem>
          </>
        ) : (
          <Dropdown placement="bottom-end">
            <DropdownTrigger>
              <Avatar
                isBordered
                as="button"
                className="transition-transform"
                color="secondary"
                name={user?.displayName || user?.email?.charAt(0).toUpperCase() || "U"}
                size="sm"
                src={user?.photoURL || undefined}
              />
            </DropdownTrigger>
            <DropdownMenu aria-label="Profile Actions" variant="flat">
              <DropdownItem key="profile" className="h-14 gap-2" textValue="Profile">
                <p className="font-semibold">Signed in as</p>
                <p className="font-semibold text-sm">{user?.email}</p>
              </DropdownItem>
              <DropdownItem key="dashboard" href="/dash" textValue="Dashboard">
                Dashboard
              </DropdownItem>
              <DropdownItem key="documents" href="/documents" textValue="My Documents">
                My Documents
              </DropdownItem>
              <DropdownItem key="logout" color="danger" onClick={handleLogout} textValue="Logout">
                Log Out
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        )}
      </NavbarContent>

      <NavbarMenu>
        {isLoggedIn ? (
          <>
            <NavbarMenuItem>
              <Link className="w-full" color="foreground" href="/dash" size="lg">
                Dashboard
              </Link>
            </NavbarMenuItem>
            <NavbarMenuItem>
              <Link className="w-full" color="foreground" href="/documents" size="lg">
                My Documents
              </Link>
            </NavbarMenuItem>
            <NavbarMenuItem>
              <Link
                className="w-full"
                color="danger"
                href="#"
                size="lg"
                onClick={handleLogout}
              >
                Log Out
              </Link>
            </NavbarMenuItem>
          </>
        ) : (
          <NavbarMenuItem>
            <Link className="w-full" color="primary" href="/login" size="lg">
              Login / Sign Up
            </Link>
          </NavbarMenuItem>
        )}
      </NavbarMenu>
    </Navbar>
  );
}
