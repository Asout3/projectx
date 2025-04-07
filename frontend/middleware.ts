import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const token = req.cookies.get("token")?.value;

  if (!token) {
    // If no token, redirect to login
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Token exists (not verified here), let user proceed
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/hidde/:path*"], // Protect specific routes
};
