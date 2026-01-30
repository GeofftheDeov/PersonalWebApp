"use client";

import React from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
    const [email, setEmail] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const router = useRouter();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/api/users/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Login failed');
            }

            // Save token and user info
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            
            // Notify navigation of auth state change
            window.dispatchEvent(new Event('authChange'));

            router.push('/dashboard');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-bricks p-8 md:p-16 overflow-hidden relative flex items-center justify-center">
            {/* High-fidelity grain overlay */}
            <div className="absolute inset-0 bg-grain mix-blend-overlay z-40 pointer-events-none"></div>

            {/* Advanced atmospheric lighting gradients */}
            <div className="absolute -top-40 -left-40 w-[600px] h-[600px] bg-teal-600/20 blur-[120px] rounded-full -z-10 animate-pulse"></div>
            <div className="absolute top-1/2 -right-60 w-[800px] h-[800px] bg-yellow-400/10 blur-[150px] rounded-full -z-10"></div>
            <div className="absolute bottom-[-20%] left-1/4 w-[500px] h-[500px] bg-orange-500/15 blur-[100px] rounded-full -z-10 animate-duration-[10s] animate-pulse"></div>

            <div className="relative z-10 w-full max-w-md">
                <div className="text-center mb-12">
                     <h1 className="text-6xl md:text-8xl font-permanent text-black leading-none tracking-tight uppercase transform -rotate-2">
                        <span className="relative inline-block">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">LOGIN</span>
                        </span>
                    </h1>
                </div>

                <div className="bg-white dark:bg-slate-900 border-4 border-black dark:border-white p-8 relative transform rotate-1 hover:rotate-0 transition-transform duration-300 shadow-[12px_12px_0px_rgba(0,0,0,1)]">
                    {error && (
                        <div className="mb-6 p-4 bg-red-500 border-4 border-black -rotate-1 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                            <p className="text-black font-permanent text-lg text-center uppercase">{error}</p>
                        </div>
                    )}

                    <form className="space-y-6" onSubmit={handleSubmit}>
                        <div className="space-y-2">
                            <label className="text-black dark:text-white text-xl font-permanent uppercase ml-1">Email</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className="w-full bg-transparent border-4 border-black dark:border-white p-3 text-black dark:text-white font-medium placeholder-slate-500 focus:outline-none focus:shadow-[4px_4px_0px_rgba(13,148,136,1)] transition-all"
                                placeholder="name@example.com"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-black dark:text-white text-xl font-permanent uppercase ml-1">Password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className="w-full bg-transparent border-4 border-black dark:border-white p-3 text-black dark:text-white font-medium placeholder-slate-500 focus:outline-none focus:shadow-[4px_4px_0px_rgba(13,148,136,1)] transition-all"
                                placeholder="••••••••"
                            />
                        </div>

                        <div className="flex items-center justify-between text-sm pt-2">
                            <label className="flex items-center text-black dark:text-white font-permanent cursor-pointer hover:text-teal-600 transition-colors">
                                <input type="checkbox" className="mr-2 w-4 h-4 border-2 border-black rounded-none text-teal-600 focus:ring-0" />
                                REMEMBER ME
                            </label>
                            <a href="/forgot-password" className="text-teal-600 hover:text-teal-500 font-permanent uppercase underline decoration-2 underline-offset-2">Forgot Password?</a>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-4 mt-4 bg-orange-500 border-4 border-black text-black font-permanent text-2xl hover:-translate-y-1 hover:shadow-[6px_6px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? 'SIGNING IN...' : 'SIGN IN'}
                        </button>
                    </form>

                    <div className="mt-8 text-center">
                        <p className="text-black dark:text-white font-permanent">
                            NEED AN ACCOUNT?{' '}
                            <a href="/create-account" className="text-teal-600 hover:text-teal-500 uppercase underline decoration-2 underline-offset-2">Sign up</a>
                        </p>
                    </div>
                </div>
            </div>
            
        </div>
    );
}
