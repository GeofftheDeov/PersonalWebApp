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
            const res = await fetch('http://localhost:5000/api/users/reset-password', {
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
            <div className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl p-8 transform transition-all hover:scale-[1.01]">
                <div className="text-center mb-8">
                    <h2 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-indigo-400">
                        Reset Password
                    </h2>
                    <p className="text-slate-400 mt-2 text-sm">Enter your new password</p>
                </div>

                {error && (
                    <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
                        <p className="text-red-400 text-sm text-center">{error}</p>
                    </div>
                )}

                {message && (
                    <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-xl">
                        <p className="text-green-400 text-sm text-center">{message}</p>
                    </div>
                )}

                <form className="space-y-6" onSubmit={handleSubmit}>
                    <div className="space-y-2">
                        <label className="text-slate-300 text-sm font-medium ml-1">New Password</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                            placeholder="••••••••"
                        />
                    </div>
                       <div className="space-y-2">
                            <label className="text-slate-300 text-sm font-medium ml-1">Confirm Password</label>
                            <input
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                required
                                className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                                placeholder="••••••••"
                            />
                        </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/20 transition-all transform active:scale-[0.98] disabled:opacity-50"
                    >
                        {loading ? 'Resetting...' : 'Reset Password'}
                    </button>
                </form>
            </div>
        </div>
    );
}

export default function ResetPasswordPage() {
    return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 relative overflow-hidden">
            {/* Background gradients */}
             <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-br from-indigo-950 via-slate-950 to-black z-0"></div>
            <div className="absolute -top-20 -left-20 w-96 h-96 bg-purple-900/30 rounded-full blur-3xl"></div>
            <div className="absolute -bottom-20 -right-20 w-96 h-96 bg-indigo-900/30 rounded-full blur-3xl"></div>
            
            <div className="relative z-10 w-full flex justify-center">
                <Suspense fallback={<div className="text-white">Loading...</div>}>
                    <ResetPasswordContent />
                </Suspense>
             </div>
        </div>
    )
}
