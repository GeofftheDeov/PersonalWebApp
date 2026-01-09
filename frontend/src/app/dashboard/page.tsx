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
        return <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">Loading...</div>;
    }

    return (
        <div className="min-h-screen bg-slate-950 text-white relative overflow-hidden">
             {/* Background gradients */}
             <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-indigo-950 via-slate-950 to-black z-0"></div>
             
             <div className="relative z-10 container mx-auto px-6 py-12">
                 <header className="flex justify-between items-center mb-12">
                     <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">
                         Dashboard
                     </h1>
                     <div className="flex items-center space-x-4">
                         <span className="text-slate-400">
                             Welcome, <span className="text-white font-medium">{user.name}</span> ({user.type})
                         </span>
                         <button 
                             onClick={() => {
                                 localStorage.clear();
                                 router.push('/login');
                             }}
                             className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                         >
                             Sign Out
                         </button>
                     </div>
                 </header>

                 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                     <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6">
                         <h3 className="text-xl font-semibold mb-4 text-indigo-300">Overview</h3>
                         <p className="text-slate-400">Welcome to your secure dashboard. This page is only accessible after logging in.</p>
                     </div>
                     
                     <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl p-6">
                         <h3 className="text-xl font-semibold mb-4 text-indigo-300">Your Profile</h3>
                         <div className="space-y-2 text-sm">
                             <p><span className="text-slate-500">Email:</span> {user.email}</p>
                             <p><span className="text-slate-500">ID:</span> {user.id}</p>
                             <p><span className="text-slate-500">Account Type:</span> <span className="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 text-xs uppercase font-bold">{user.type}</span></p>
                         </div>
                     </div>
                 </div>
             </div>
        </div>
    );
}
