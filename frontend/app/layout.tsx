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
"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@heroui/button";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6">
      {/* Hero Section */}
      <motion.h1
        className="text-5xl sm:text-6xl font-extrabold mb-6 bg-gradient-to-r from-green-400 via-blue-400 to-green-300 text-transparent bg-clip-text"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        AI Book Generator
      </motion.h1>

      <motion.p
        className="text-lg text-gray-300 max-w-2xl mb-8"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.6 }}
      >
        Turn your ideas into complete books in minutes using cutting-edge AI technology.  
        From brainstorming to publishing — all in one platform.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.6 }}
      >
        <Link href="/dash">
          <Button
            size="lg"
            className="bg-green-500 hover:bg-green-400 text-black font-bold rounded-xl shadow-lg"
          >
            Start Generating
          </Button>
        </Link>
      </motion.div>

      {/* Features */}
      <section className="mt-24 grid grid-cols-1 sm:grid-cols-3 gap-10 max-w-6xl">
        <FeatureCard
          title="Instant Creation"
          desc="Generate entire books from a single prompt in seconds."
        />
        <FeatureCard
          title="Custom Styles"
          desc="Pick your genre, tone, and structure for unique results."
        />
        <FeatureCard
          title="Export Anywhere"
          desc="Download as PDF, ePub, or share instantly."
        />
      </section>
    </div>
  );
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <motion.div
      className="p-6 rounded-xl bg-gradient-to-br from-blue-950 to-black border border-green-400/20 hover:border-green-400 transition"
      whileHover={{ scale: 1.05 }}
    >
      <h3 className="text-xl font-bold text-green-400 mb-3">{title}</h3>
      <p className="text-gray-300">{desc}</p>
    </motion.div>
  );
}

