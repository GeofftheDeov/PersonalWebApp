"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Footer from "@/components/Footer";

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
    <div className="min-h-[calc(100vh-76px)] flex flex-col overflow-hidden relative w-full">
      {/* Hero Section with STL skyline banner */}
      <section className="relative w-full overflow-hidden border-b-8 border-black">
        <div className="relative w-full h-[420px] sm:h-[520px] md:h-[640px]">
          <Image
            src="/images/stl-skyline.jpg"
            alt="Saint Louis skyline at twilight"
            fill
            priority
            sizes="100vw"
            className="object-cover object-top"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-black/20" />
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <h1 className="mb-6 text-5xl font-permanent uppercase tracking-tighter text-white sm:text-7xl md:text-8xl transform -rotate-2 drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">
              Geoff's <br />
              <span className="inline-block skew-x-[-12deg] text-teal-400">
                <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">Mark</span>
              </span>
            </h1>
            <p className="mx-auto mb-10 max-w-2xl text-lg font-permanent uppercase tracking-wide text-zinc-100 sm:text-2xl drop-shadow-[3px_3px_0px_rgba(0,0,0,1)]">
              Built in Saint Louis · A canvas for the things I build, run, and play.
            </p>
            <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link
                href="/login"
                className="group relative inline-flex h-14 items-center justify-center overflow-hidden border-4 border-black bg-white px-8 font-black uppercase tracking-widest text-black transition-transform active:scale-95 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1"
              >
                <span className="absolute inset-0 translate-x-[-100%] bg-teal-600 transition-transform duration-300 group-hover:translate-x-0"></span>
                <span className="relative z-10 group-hover:text-white font-permanent text-lg">Login</span>
              </Link>
              <Link
                href="/create-account"
                className="group relative inline-flex h-14 items-center justify-center overflow-hidden border-4 border-black bg-black px-8 font-black uppercase tracking-widest text-white transition-transform active:scale-95 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:shadow-[10px_10px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1"
              >
                <span className="absolute inset-0 translate-x-[-100%] bg-orange-500 transition-transform duration-300 group-hover:translate-x-0"></span>
                <span className="relative z-10 group-hover:text-black font-permanent text-lg">Get Started</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      <div className="flex-grow w-full max-w-6xl mx-auto p-8 md:p-16 relative z-10">

      {/* Features Section */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 py-20">
        <div className="mb-16 border-b-4 border-black pb-4 dark:border-white w-fit mx-auto transform rotate-1">
          <h2 className="text-5xl font-permanent uppercase tracking-tighter sm:text-6xl drop-shadow-[4px_4px_0px_rgba(0,0,0,1)] dark:drop-shadow-[4px_4px_0px_rgba(255,255,255,1)] text-black">
            What's Inside
          </h2>
        </div>

        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-2">
          {/* Feature 1: Game Night Planner */}
          <div className="group relative border-4 border-black bg-zinc-100 p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-1 hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:rotate-1 dark:border-white dark:bg-zinc-900 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center border-4 border-black bg-teal-600 text-3xl font-permanent text-white dark:border-white dark:text-black">
              01
            </div>
            <h3 className="mb-4 text-3xl font-permanent uppercase">Game Night Planner</h3>
            <p className="border-t-4 border-black pt-4 text-lg font-permanent text-zinc-600 dark:border-white dark:text-zinc-400">
              A tabletop hub for running long-form RPGs. Spin up Campaigns, log Sessions with summaries and dates, and track Characters across their classes, levels, and party assignments.
            </p>
          </div>

          {/* Feature 2: Dashboard & Tasks */}
          <div className="group relative border-4 border-black bg-zinc-100 p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-1 hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:-rotate-1 dark:border-white dark:bg-zinc-900 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center border-4 border-black bg-yellow-400 text-3xl font-permanent text-black dark:border-white">
              02
            </div>
            <h3 className="mb-4 text-3xl font-permanent uppercase">Dashboard &amp; Tasks</h3>
            <p className="border-t-4 border-black pt-4 text-lg font-permanent text-zinc-600 dark:border-white dark:text-zinc-400">
              Personal command center. Create, edit, and triage tasks with due dates picked through a custom calendar modal, alongside an at-a-glance Game Night summary.
            </p>
          </div>

          {/* Feature 3: Accounts & Profiles */}
          <div className="group relative border-4 border-black bg-zinc-100 p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-1 hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:rotate-1 dark:border-white dark:bg-zinc-900 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center border-4 border-black bg-orange-500 text-3xl font-permanent text-black dark:border-white">
              03
            </div>
            <h3 className="mb-4 text-3xl font-permanent uppercase">Accounts &amp; Profiles</h3>
            <p className="border-t-4 border-black pt-4 text-lg font-permanent text-zinc-600 dark:border-white dark:text-zinc-400">
              Email-verified accounts with password reset flows, profile picture uploads, handle/Discord linking, and per-user views of campaigns, characters, and attended sessions.
            </p>
          </div>

          {/* Feature 4: Friends & Salesforce */}
          <div className="group relative border-4 border-black bg-zinc-100 p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-y-1 hover:shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] hover:-rotate-1 dark:border-white dark:bg-zinc-900 dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] dark:hover:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)]">
            <div className="mb-6 inline-flex h-16 w-16 items-center justify-center border-4 border-black bg-purple-600 text-3xl font-permanent text-white dark:border-white dark:text-black">
              04
            </div>
            <h3 className="mb-4 text-3xl font-permanent uppercase">Friends &amp; Salesforce Sync</h3>
            <p className="border-t-4 border-black pt-4 text-lg font-permanent text-zinc-600 dark:border-white dark:text-zinc-400">
              Send and manage friend requests across users, and on the backend, a bi-directional Salesforce sync layer keeps Leads, Contacts, and Campaign Members in step with the Mongo data model.
            </p>
          </div>
        </div>
      </section>

      </div>
       {/* Footer */}
       <Footer />
    </div>
  );
}
