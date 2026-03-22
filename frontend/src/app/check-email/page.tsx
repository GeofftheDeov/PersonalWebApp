"use client";

import React from 'react';
import { useRouter } from 'next/navigation';

export default function CheckEmailPage() {
    const router = useRouter();

    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden text-black dark:text-white pb-20 pt-32">
            <div className="relative z-10 w-full max-w-2xl px-6">
                <div className="bg-white dark:bg-zinc-900 border-4 border-black dark:border-black p-8 md:p-12 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] transform -rotate-1">
                    <div className="text-center mb-8">
                        <h2 className="text-5xl font-permanent uppercase tracking-tighter mb-6 transform rotate-1 relative inline-block">
                             <span className="relative z-10">Check Your Email</span>
                             <span className="absolute -bottom-2 left-0 w-full h-4 bg-orange-500/30 -z-10 rotate-1"></span>
                        </h2>
                        
                        <div className="space-y-6 text-xl font-bold font-sans uppercase tracking-tight text-zinc-800 dark:text-zinc-200">
                            <p className="bg-yellow-200 dark:bg-yellow-900/40 p-2 transform -rotate-1 inline-block border-2 border-black">
                                Almost there!
                            </p>
                            <p>
                                We sent a verification link to your inbox. 
                                Click it to activate your account and join the system.
                            </p>
                            <p className="text-sm text-zinc-500 dark:text-zinc-400 normal-case italic font-medium">
                                (Don't forget to check your spam folder just in case.)
                            </p>
                        </div>
                    </div>

                    <div className="mt-12 flex flex-col space-y-4">
                        <button
                            onClick={() => router.push('/login')}
                            className="w-full py-4 bg-teal-600 text-white border-4 border-black font-black uppercase text-xl tracking-widest hover:bg-teal-500 transition-all shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none active:scale-95"
                        >
                            Back to Login
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
