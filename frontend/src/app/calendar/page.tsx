"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function CalendarPage() {
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
        <div className="min-h-[calc(100vh-76px)] p-8 md:p-16 overflow-hidden relative">
            <div className="max-w-6xl mx-auto relative z-10">

                <header className="mb-16 relative">
                    <h1 className="text-5xl md:text-7xl font-permanent text-black dark:text-black leading-none tracking-tight uppercase">
                        <span className="relative inline-block">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">YOUR</span>
                        </span>
                        <span className="text-yellow-400 ml-4">
                            <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">CALENDAR</span>
                        </span>
                    </h1>
                </header>

                <section className="grid grid-cols-1 md:grid-cols-2 gap-8 text-left">

                </section>

                <footer className="mt-16 text-center">
                    <div className="inline-block border-8 border-black dark:border-black px-12 py-8 bg-orange-500 shadow-[12px_12px_0px_0px_rgba(250,204,21,1)]">
                        <p className="text-3xl md:text-4xl font-permanent text-black uppercase leading-tight">
                            HAVE A GOOD DAY
                        </p>
                    </div>
                </footer>
            </div>
        </div>
    );
}