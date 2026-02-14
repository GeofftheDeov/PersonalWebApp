"use client";

import React, { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function ResetPasswordContent() {
    const [password, setPassword] = React.useState('');
    const [confirmPassword, setConfirmPassword] = React.useState(''); // Added confirm password for better UX
    const [message, setMessage] = React.useState('');
    const [error, setError] = React.useState('');
    const [loading, setLoading] = React.useState(false);
    const router = useRouter();
    const searchParams = useSearchParams();
    const token = searchParams.get('token');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        setMessage('');

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            setLoading(false);
            return;
        }

        if (!token) {
             setError("Invalid or missing token.");
             setLoading(false);
             return;
        }

        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'}/api/users/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, newPassword: password }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to reset password');
            }

            setMessage('Password reset successfully! Redirecting to login...');
            setTimeout(() => {
                router.push('/login');
            }, 2000);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    if (!token) {
        return (
             <div className="flex flex-col items-center justify-center p-8 text-center bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl">
                 <h2 className="text-2xl font-bold text-red-400 mb-4">Invalid Link</h2>
                 <p className="text-slate-300 mb-6">The password reset link is invalid or missing.</p>
                 <a href="/login" className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors">Back to Login</a>
             </div>
        )
    }

    return (
        <div className="w-full max-w-md p-8">
            <div className="bg-white dark:bg-slate-900 border-4 border-black p-8 relative transform rotate-1 hover:rotate-0 transition-transform duration-300 shadow-[12px_12px_0px_rgba(0,0,0,1)] dark:shadow-[12px_12px_0px_rgba(255,255,255,1)]">
                <div className="text-center mb-8">
                    <h2 className="text-4xl font-permanent uppercase text-black dark:text-white transform -rotate-1">
                        Reset Password
                    </h2>
                    <p className="text-zinc-600 dark:text-zinc-400 mt-2 font-permanent uppercase">Enter your new password</p>
                </div>

                {error && (
                    <div className="mb-6 p-4 bg-red-500 border-4 border-black -rotate-1 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                        <p className="text-black font-permanent text-sm text-center uppercase">{error}</p>
                    </div>
                )}

                {message && (
                    <div className="mb-6 p-4 bg-teal-500 border-4 border-black rotate-1 shadow-[4px_4px_0px_rgba(0,0,0,1)]">
                        <p className="text-black font-permanent text-sm text-center uppercase">{message}</p>
                    </div>
                )}

                <form className="space-y-6" onSubmit={handleSubmit}>
                    <div className="space-y-2">
                        <label className="text-black dark:text-white text-sm font-permanent uppercase ml-1">New Password</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="w-full bg-transparent border-4 border-black p-3 text-black dark:text-white font-medium placeholder-slate-500 focus:outline-none focus:shadow-[4px_4px_0px_rgba(13,148,136,1)] transition-all"
                            placeholder="••••••••"
                        />
                    </div>
                       <div className="space-y-2">
                            <label className="text-black dark:text-white text-sm font-permanent uppercase ml-1">Confirm Password</label>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                className="w-full bg-transparent border-4 border-black p-3 text-black dark:text-white font-medium placeholder-slate-500 focus:outline-none focus:shadow-[4px_4px_0px_rgba(13,148,136,1)] transition-all"
                                placeholder="••••••••"
                            />
                        </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-4 mt-4 bg-orange-500 border-4 border-black text-black font-permanent text-xl hover:-translate-y-1 hover:shadow-[6px_6px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? 'RESETTING...' : 'RESET PASSWORD'}
                    </button>
                </form>
            </div>
        </div>
    );
}

export default function ResetPasswordPage() {
    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden">
            <div className="relative z-10 w-full flex justify-center">
                <Suspense fallback={<div className="text-4xl font-permanent text-teal-600">LOADING...</div>}>
                    <ResetPasswordContent />
                </Suspense>
             </div>
        </div>
    )
}
