// import "@/styles/globals.css";
// import { Metadata, Viewport } from "next";
// import clsx from "clsx";

// import { Providers } from "./providers";

// import { siteConfig } from "@/config/site";
// import { fontSans } from "@/config/fonts";
// import { ThemeSwitch } from "@/components/theme-switch";
// import CustomNavbar from "@/components/navbar";

// export const metadata: Metadata = {
//   title: {
//     default: siteConfig.name,
//     template: `%s - ${siteConfig.name}`,
//   },
//   description: siteConfig.description,
//   icons: {
//     icon: "/favicon.ico",
//   },
// };

// export const viewport: Viewport = {
//   themeColor: [
//     { media: "(prefers-color-scheme: light)", color: "white" },
//     { media: "(prefers-color-scheme: dark)", color: "black" },
//   ],
// };

// export default function RootLayout({
//   children,
// }: {
//   children: React.ReactNode;
// }) {
//   return (
//     <html suppressHydrationWarning lang="en">
//       <head />
//       <body
//         className={clsx(
//           "min-h-screen bg-background font-sans antialiased",
//           fontSans.variable,
//         )}
//       >
//         <Providers themeProps={{ attribute: "class", defaultTheme: "dark" }}>
//           <div className="relative flex flex-col h-screen">
//             <CustomNavbar />
//             <main className="container mx-auto max-w-7xl pt-16 px-6 flex-grow">
//               {children}
//             </main>
//             <footer className="w-full flex items-center justify-center py-3">
//               @Asout3 April 2025 <ThemeSwitch />
//             </footer>
//           </div>
//         </Providers>
//       </body>
//     </html>
//   );
// }

import "@/styles/globals.css";
import { Metadata, Viewport } from "next";
import clsx from "clsx";

import { Providers } from "./providers";
import { siteConfig } from "@/config/site";
import { fontSans } from "@/config/fonts";
import { ThemeSwitch } from "@/components/theme-switch";
import CustomNavbar from "@/components/navbar";

export const metadata: Metadata = {
  title: {
    default: siteConfig.name,
    template: `%s - ${siteConfig.name}`,
  },
  description: siteConfig.description,
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "white" },
    { media: "(prefers-color-scheme: dark)", color: "black" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html suppressHydrationWarning lang="en">
      <head />
      <body
        className={clsx(
          "min-h-screen font-sans antialiased",
          fontSans.variable,
          "bg-gradient-to-b from-black via-blue-950 to-black text-white transition-colors duration-300"
        )}
      >
        <Providers themeProps={{ attribute: "class", defaultTheme: "dark" }}>
          <div className="relative flex flex-col min-h-screen">
            {/* Navbar */}
            <header className="fixed top-0 left-0 w-full z-50 bg-black/70 backdrop-blur-lg border-b border-green-400/20">
              <CustomNavbar />
            </header>

            {/* Page Content */}
            <main className="flex-grow pt-20">{children}</main>

            {/* Footer */}
            <footer className="w-full py-6 border-t border-green-400/20 bg-black/80 backdrop-blur-lg text-center text-sm text-gray-400">
              © {new Date().getFullYear()} Asout3 — All rights reserved  
              <div className="mt-2 flex justify-center">
                <ThemeSwitch />
              </div>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}

