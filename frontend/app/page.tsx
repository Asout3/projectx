"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Button } from "@heroui/button";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6">
      {/* Hero Section */}
      <motion.h1
        className="text-5xl sm:text-6xl font-bold mb-6 tracking-tight text-neutral-900 dark:text-white"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        AI Book Generator
      </motion.h1>

      <motion.p
        className="text-lg text-neutral-600 dark:text-neutral-300 max-w-2xl mb-8 leading-relaxed"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.6 }}
      >
        Turn your ideas into complete books in minutes using cutting-edge AI technology.  
        From brainstorming to publishing — all in one place.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4, duration: 0.6 }}
      >
        <Link href="/dash">
          <Button
            size="lg"
            className="bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg px-8 py-3 shadow-lg"
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
      className="p-6 rounded-lg bg-white dark:bg-neutral-800 shadow-md hover:shadow-lg transition"
      whileHover={{ scale: 1.03 }}
    >
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-white mb-2">
        {title}
      </h3>
      <p className="text-neutral-600 dark:text-neutral-300">{desc}</p>
    </motion.div>
  );
}
