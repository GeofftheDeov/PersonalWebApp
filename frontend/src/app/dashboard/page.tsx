"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DashboardPage() {
    const router = useRouter();
    const [user, setUser] = useState<any>(null);

    useEffect(() => {
        const token = localStorage.getItem('token');
        const userData = localStorage.getItem('user');

        if (!token || !userData) {
            router.push('/login');
            return;
        }

        setUser(JSON.parse(userData));
    }, [router]);

    if (!user) {
        return <div className="min-h-screen bg-bricks flex items-center justify-center"><span className="text-4xl font-permanent text-teal-600">LOADING...</span></div>;
    }

    return (
        <div className="min-h-[calc(100vh-76px)] bg-bricks p-8 md:p-16 overflow-hidden relative">
            {/* High-fidelity grain overlay for a gritty, professional cinematic texture */}
            <div className="absolute inset-0 bg-grain mix-blend-overlay z-40 pointer-events-none"></div>

            <div className="max-w-6xl mx-auto relative z-10">
                {/* Advanced atmospheric lighting gradients */}
                <div className="absolute -top-40 -left-40 w-[600px] h-[600px] bg-teal-600/20 blur-[120px] rounded-full -z-10 animate-pulse"></div>
                <div className="absolute top-1/2 -right-60 w-[800px] h-[800px] bg-yellow-400/10 blur-[150px] rounded-full -z-10"></div>
                <div className="absolute bottom-[-20%] left-1/4 w-[500px] h-[500px] bg-orange-500/15 blur-[100px] rounded-full -z-10 animate-duration-[10s] animate-pulse"></div>

                <header className="mb-16 relative">
                    <h1 className="text-5xl md:text-7xl font-permanent text-black dark:text-white leading-none tracking-tight uppercase">
                        <span className="relative inline-block">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">YOUR</span>
                        </span>
                        <span className="text-yellow-400 ml-4">
                            <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)] dark:drop-shadow-[6px_6px_0px_rgba(255,255,255,1)]">DASHBOARD</span>
                        </span>
                    </h1>
                </header>

                <section className="grid grid-cols-1 md:grid-cols-2 gap-8 text-left">
                    <div className="relative">
                        <h2 className="text-4xl md:text-5xl font-permanent mb-6 text-teal-600 uppercase relative w-fit">
                            <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)] dark:drop-shadow-[4px_4px_0px_rgba(255,255,255,1)]">Welcome</span>
                        </h2>
                        <p className="text-2xl md:text-3xl font-permanent leading-tight text-teal-600 drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] dark:drop-shadow-[3px_3px_0px_rgba(255,255,255,1)] tracking-tight">
                            HELLO, {user.name?.toUpperCase() || 'USER'}! YOU'RE LOGGED IN AS A {user.type?.toUpperCase() || 'MEMBER'}. 
                            THIS IS YOUR SECURE SPACE TO ACCESS EXCLUSIVE FEATURES AND CONTENT.
                        </p>
                    </div>

                    <div className="relative">
                        <h2 className="text-4xl md:text-5xl font-permanent mb-6 text-yellow-400 uppercase relative w-fit">
                            <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)] dark:drop-shadow-[4px_4px_0px_rgba(255,255,255,1)]">Profile</span>
                        </h2>
                        <div className="text-xl md:text-2xl font-permanent leading-tight text-yellow-400 drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] dark:drop-shadow-[3px_3px_0px_rgba(255,255,255,1)] tracking-tight space-y-3">
                            <p>EMAIL: {user.email?.toUpperCase()}</p>
                            <p>ID: {user.id}</p>
                        </div>
                    </div>
                </section>

                <footer className="mt-16 text-center">
                    <div className="inline-block border-8 border-black dark:border-white px-12 py-8 bg-orange-500 shadow-[12px_12px_0px_0px_rgba(250,204,21,1)]">
                        <p className="text-3xl md:text-4xl font-permanent text-black uppercase leading-tight">
                            Authenticated.<br/>Secure.<br/>Ready to Build.
                        </p>
                    </div>
                </footer>
            </div>

            {/* Additional Decorative Elements */}
            <div className="absolute top-1/2 left-10 w-10 h-10 bg-teal-500 rounded-full animate-bounce opacity-20"></div>
            <div className="absolute top-1/4 right-20 w-8 h-8 bg-yellow-400 rounded-full animate-ping opacity-15"></div>
        </div>
    );
}
