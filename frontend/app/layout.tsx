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
    { media: "(prefers-color-scheme: light)", color: "#f9fafb" }, // light bg
    { media: "(prefers-color-scheme: dark)", color: "#111827" }, // dark bg
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html suppressHydrationWarning lang="en" className="scroll-smooth">
      <head />
      <body
        className={clsx(
          "min-h-screen font-inter antialiased bg-gray-50 text-gray-900 transition-colors duration-500 dark:bg-gray-900 dark:text-gray-100"
        )}
      >
        <Providers themeProps={{ attribute: "class", defaultTheme: "dark" }}>
          <div className="relative flex flex-col min-h-screen">
            {/* Navbar with glass blur background that changes color based on theme */}
            <header
              className="
                fixed top-0 left-0 w-full z-50
                bg-white/60 dark:bg-gray-900/60
                backdrop-blur-md
                transition-colors duration-500
                shadow-sm
              "
            >
              <CustomNavbar />
            </header>

            {/* Main content area with top padding so content doesn't go under fixed navbar */}
            <main className="flex-grow pt-20 px-6 max-w-7xl mx-auto">
              {children}
            </main>

            {/* Footer with same glass blur background */}
            <footer
              className="
                w-full py-6
                bg-white/60 dark:bg-gray-900/60
                backdrop-blur-md
                shadow-inner
                text-center text-sm text-gray-600 dark:text-gray-400
                transition-colors duration-500
              "
            >
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

