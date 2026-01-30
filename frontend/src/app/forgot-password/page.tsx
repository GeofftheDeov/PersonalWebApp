"use client";

import React from 'react';
import { useRouter } from 'next/navigation';

export default function ForgotPasswordPage() {
    const [email, setEmail] = React.useState('');
    const [message, setMessage] = React.useState('');
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const router = useRouter();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        setMessage('');

        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/api/users/forgot-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to send reset email');
            }

            setMessage('If an account exists with that email, we have sent a password reset link.');
            // Optional: Redirect after a few seconds?
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
                    <h1 className="text-5xl md:text-7xl font-permanent text-black leading-none tracking-tight uppercase transform -rotate-2">
                        <span className="relative inline-block">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">FORGOT</span>
                        </span>
                        <br className="hidden md:block"/>
                        <span className="relative inline-block md:mt-4 ml-4 md:ml-0">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">PASSWORD</span>
                        </span>
                    </h1>
                </div>

                <div className="bg-white dark:bg-slate-900 border-4 border-black p-8 relative transform rotate-1 hover:rotate-0 transition-transform duration-300 shadow-[12px_12px_0px_rgba(0,0,0,1)] dark:shadow-[12px_12px_0px_rgba(255,255,255,1)]">
                    {error && (
                        <div className="mb-6 p-4 bg-red-500 border-4 border-black -rotate-1 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                            <p className="text-black font-permanent text-lg text-center uppercase">{error}</p>
                        </div>
                    )}

                    {message && (
                        <div className="mb-6 p-4 bg-teal-500 border-4 border-black rotate-1 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                            <p className="text-black font-permanent text-lg text-center uppercase">{message}</p>
                        </div>
                    )}

                    <form className="space-y-6" onSubmit={handleSubmit}>
                        <div className="space-y-2">
                            <label className="text-black text-xl font-permanent uppercase ml-1">Email</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className="w-full bg-transparent border-4 border-black p-3 text-black font-medium placeholder-slate-500 focus:outline-none focus:shadow-[4px_4px_0px_rgba(13,148,136,1)] transition-all"
                                placeholder="name@example.com"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-4 mt-4 bg-orange-500 border-4 border-black text-black font-permanent text-2xl hover:-translate-y-1 hover:shadow-[6px_6px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? 'SENDING...' : 'SEND RESET LINK'}
                        </button>
                    </form>

                     <div className="mt-8 text-center">
                        <a href="/login" className="text-teal-600 hover:text-teal-500 font-permanent uppercase underline decoration-2 underline-offset-2">
                            Back to Login
                        </a>
                    </div>
                </div>
            </div>

        </div>
    );
}
