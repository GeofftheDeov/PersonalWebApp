"use client";

import React from 'react';

export default function LoginPage() {
    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 relative overflow-hidden">
            {/* Background gradients */}
            <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-indigo-950 via-slate-950 to-black z-0"></div>
            <div className="absolute -top-20 -left-20 w-96 h-96 bg-purple-900/30 rounded-full blur-3xl"></div>
            <div className="absolute -bottom-20 -right-20 w-96 h-96 bg-indigo-900/30 rounded-full blur-3xl"></div>

            <div className="relative z-10 w-full max-w-md p-8">
                <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-8 transform transition-all hover:scale-[1.01]">
                    <div className="text-center mb-8">
                        <h2 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">
                            Welcome Back
                        </h2>
                        <p className="text-slate-400 mt-2 text-sm">Sign in to access your dashboard</p>
                    </div>

                    <form className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-slate-300 text-sm font-medium ml-1">Email</label>
                            <input
                                type="email"
                                className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="name@example.com"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-slate-300 text-sm font-medium ml-1">Password</label>
                            <input
                                type="password"
                                className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="••••••••"
                            />
                        </div>

                        <div className="flex items-center justify-between text-sm">
                            <label className="flex items-center text-slate-400 cursor-pointer hover:text-slate-300">
                                <input type="checkbox" className="mr-2 rounded border-white/10 bg-white/5 text-indigo-500 focus:ring-indigo-500/50" />
                                Remember me
                            </label>
                            <a href="#" className="text-indigo-400 hover:text-indigo-300 transition-colors">Forgot Password?</a>
                        </div>

                        <button
                            type="button"
                            className="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/20 transition-all transform active:scale-[0.98]"
                        >
                            Sign In
                        </button>
                    </form>

                    <div className="mt-8 text-center">
                        <p className="text-slate-500 text-sm">
                            Don't have an account?{' '}
                            <a href="#" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">Sign up</a>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
