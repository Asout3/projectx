"use client";

import Link from "next/link";
import { motion } from "framer-motion";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-4 sm:px-6 lg:px-8">
      {/* Hero Title */}
      <motion.h1
        className="text-5xl sm:text-6xl font-extrabold tracking-tight leading-tight text-gray-900 dark:text-gray-100 max-w-4xl mx-auto"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        AI Book Generator
      </motion.h1>

      {/* Subtitle */}
      <motion.p
        className="mt-6 text-lg text-gray-700 dark:text-gray-300 max-w-2xl mx-auto leading-relaxed"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.6 }}
      >
        Transform your ideas into complete books in minutes with the power of AI.  
        Simple, fast, and professional.
      </motion.p>

      {/* Call to Action Button */}
      <motion.div
        className="mt-10"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.6 }}
      >
        <Link href="/dash">
          <button
            type="button"
            className="
              inline-flex items-center justify-center
              rounded-md
              bg-gray-900 dark:bg-gray-100
              px-8 py-3
              text-lg font-semibold
              text-white dark:text-gray-900
              shadow-md
              hover:bg-gray-700 dark:hover:bg-gray-300
              transition-colors duration-300
              focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500
            "
          >
            Start Generating
          </button>
        </Link>
      </motion.div>

      {/* Features Section */}
      <section className="mt-20 max-w-5xl w-full grid grid-cols-1 sm:grid-cols-3 gap-10">
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
      className="
        p-6
        rounded-lg
        bg-white dark:bg-gray-800
        shadow
        hover:shadow-lg
        transition-shadow duration-300
      "
      whileHover={{ scale: 1.03 }}
    >
      <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
        {title}
      </h3>
      <p className="text-gray-600 dark:text-gray-400">{desc}</p>
    </motion.div>
  );
}
