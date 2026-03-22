"use client";

import React from 'react';
import Link from 'next/link';
import { Mail } from 'lucide-react';

export default function CheckEmailPage() {
    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-white dark:bg-black">
            <div className="relative z-10 w-full max-w-2xl px-6">
                <div className="bg-white dark:bg-slate-900 border-4 border-black p-12 relative transform rotate-1 transition-transform duration-300 shadow-[16px_16px_0px_rgba(0,0,0,1)] dark:shadow-[16px_16px_0px_rgba(255,255,255,1)]">
                    <div className="text-center">
                        <div className="mb-8 flex justify-center">
                            <div className="p-6 bg-teal-500 border-4 border-black -rotate-3 shadow-[8px_8px_0px_rgba(0,0,0,1)]">
                                <Mail className="w-16 h-16 text-black" />
                            </div>
                        </div>

                        <h1 className="text-6xl font-permanent uppercase text-black dark:text-white mb-6 -rotate-1">
                            Check Your Email!
                        </h1>

                        <p className="text-2xl font-permanent uppercase text-zinc-600 dark:text-zinc-400 mb-10 leading-relaxed">
                            We've sent a verification link to your inbox. <br />
                            Please click the link to confirm your account and get started.
                        </p>

                        <div className="flex flex-col sm:flex-row gap-4 justify-center">
                            <Link 
                                href="/login"
                                className="px-10 py-4 bg-orange-500 border-4 border-black text-black font-permanent text-2xl hover:-translate-y-1 hover:shadow-[6px_6px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-none transition-all"
                            >
                                GO TO LOGIN
                            </Link>
                            <Link 
                                href="/"
                                className="px-10 py-4 bg-white border-4 border-black text-black font-permanent text-2xl hover:-translate-y-1 hover:shadow-[6px_6px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-none transition-all dark:bg-slate-800 dark:text-white"
                            >
                                BACK HOME
                            </Link>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
