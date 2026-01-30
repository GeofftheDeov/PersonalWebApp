"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    const token = localStorage.getItem("token");
    if (token) {
      router.push("/dashboard");
    } else {
      setLoading(false);
    }
  }, [router]);

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-zinc-900">
        <div className="h-16 w-16 animate-spin border-8 border-black border-t-teal-600 dark:border-white dark:border-t-teal-400"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bricks text-black dark:text-white pb-20 relative overflow-hidden">
        {/* Grain Overlay */}
        <div className="absolute inset-0 bg-grain mix-blend-overlay z-40 pointer-events-none"></div>

        {/* Atmosphere/Lighting */}
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] bg-teal-600/20 blur-[120px] rounded-full z-0 animate-pulse pointer-events-none"></div>
        <div className="absolute top-1/2 -right-60 w-[800px] h-[800px] bg-yellow-400/10 blur-[150px] rounded-full z-0 pointer-events-none"></div>
        <div className="absolute bottom-[-20%] left-1/4 w-[500px] h-[500px] bg-orange-500/15 blur-[100px] rounded-full z-0 animate-pulse pointer-events-none"></div>

      {/* Hero Section */}
      <section className="relative z-10 flex flex-col items-center justify-center px-4 pt-32 pb-20 text-center">
        
        <div className="max-w-5xl">
          <h1 className="mb-8 text-6xl font-permanent uppercase tracking-tighter text-black sm:text-8xl md:text-9xl transform -rotate-2">
            Geoff's <br />
            <span className="relative inline-block skew-x-[-12deg] text-teal-600">
              <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)] dark:drop-shadow-[6px_6px_0px_rgba(255,255,255,1)]">Mark</span>
            </span>
          </h1>
          <p className="mx-auto mb-12 max-w-2xl text-2xl font-permanent uppercase tracking-wide text-zinc-800 dark:text-zinc-200 sm:text-3xl drop-shadow-md">
            A solid canvas for my digital expression.
          </p>
          <div className="flex flex-col items-center justify-center gap-6 sm:flex-row">
            <Link
              href="/login"
              className="group relative inline-flex h-16 w-full items-center justify-center overflow-hidden border-4 border-black bg-white px-8 font-black uppercase tracking-widest text-black transition-transform active:scale-95 dark:border-white dark:bg-black dark:text-white sm:w-auto shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]"
            >
              <span className="absolute inset-0 translate-x-[-100%] bg-teal-600 transition-transform duration-300 group-hover:translate-x-0"></span>
              <span className="relative z-10 group-hover:text-white dark:group-hover:text-black font-permanent text-xl">
                Login
              </span>
            </Link>
            <Link
              href="/create-account"
              className="group relative inline-flex h-16 w-full items-center justify-center overflow-hidden border-4 border-black bg-black px-8 font-black uppercase tracking-widest text-white transition-transform active:scale-95 dark:border-black dark:border-white dark:bg-black dark:text-white sm:w-auto shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]"
            >
              <span className="absolute inset-0 translate-x-[-100%] bg-orange-500 transition-transform duration-300 group-hover:translate-x-0"></span>
              <span className="relative z-10 group-hover:text-black font-permanent text-xl">
                Get Started
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 py-20">
        <div className="mb-16 border-b-4 border-black pb-4 dark:border-white w-fit mx-auto transform rotate-1">
          <h2 className="text-5xl font-permanent uppercase tracking-tighter sm:text-6xl drop-shadow-[4px_4px_0px_rgba(0,0,0,1)] dark:drop-shadow-[4px_4px_0px_rgba(255,255,255,1)] text-black dark:text-white">
            Core Systems
          </h2>
        </div>

        <div className="grid gap-8 md:grid-cols-3">
          {/* Feature 1 */}
          <div className="group relative border-4 border-black bg-zinc-100 p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-1 hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:rotate-1 dark:border-white dark:bg-zinc-900 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center border-4 border-black bg-orange-500 text-3xl font-permanent text-black dark:border-white">
              01
            </div>
            <h3 className="mb-4 text-3xl font-permanent uppercase">Salesforce Sync</h3>
            <p className="border-t-4 border-black pt-4 text-xl font-permanent text-zinc-600 dark:border-white dark:text-zinc-400">
              Bi-directional data pipeline. seamless integration with your CRM infrastructure.
            </p>
          </div>

          {/* Feature 2 */}
          <div className="group relative border-4 border-black bg-zinc-100 p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-1 hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:-rotate-1 dark:border-white dark:bg-zinc-900 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center border-4 border-black bg-teal-600 text-3xl font-permanent text-white dark:border-white dark:text-black">
              02
            </div>
            <h3 className="mb-4 text-3xl font-permanent uppercase">Lead Flow</h3>
            <p className="border-t-4 border-black pt-4 text-xl font-permanent text-zinc-600 dark:border-white dark:text-zinc-400">
              Automated lead capture and processing. Never miss a potential opportunity again.
            </p>
          </div>

          {/* Feature 3 */}
          <div className="group relative border-4 border-black bg-zinc-100 p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-1 hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:rotate-1 dark:border-white dark:bg-zinc-900 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center border-4 border-black bg-purple-600 text-3xl font-permanent text-white dark:border-white dark:text-black">
              03
            </div>
            <h3 className="mb-4 text-3xl font-permanent uppercase">Secure Auth</h3>
            <p className="border-t-4 border-black pt-4 text-xl font-permanent text-zinc-600 dark:border-white dark:text-zinc-400">
              Fortified access control. Protecting your data with industry-standard security.
            </p>
          </div>
        </div>
      </section>

       {/* Footer */}
       <footer className="relative z-10 mt-20 border-t-4 border-black bg-zinc-100/90 py-12 text-center dark:border-white dark:bg-zinc-900/90 backdrop-blur-sm">
        <p className="text-2xl font-permanent uppercase tracking-wider text-zinc-500">
          © 2026 Geoff The Dev. All Rights Reserved.
        </p>
      </footer>
    </div>
  );
}
