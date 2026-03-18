"use client";

import React, { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function VerifyEmailContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const token = searchParams.get('token');

    const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
    const [message, setMessage] = useState('Verifying your email...');

    useEffect(() => {
        if (!token) {
            setStatus('error');
            setMessage('Missing verification token.');
            return;
        }

        const verifyEmail = async () => {
            try {
                const response = await fetch('/api/users/verify-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Verification failed');
                }

                setStatus('success');
                setMessage('Email verified successfully! You can now log in.');
                setTimeout(() => {
                    router.push('/login');
                }, 3000);
            } catch (err: any) {
                setStatus('error');
                setMessage(err.message || 'Verification failed. The link may be invalid or expired.');
            }
        };

        verifyEmail();
    }, [token, router]);

    return (
        <div className="bg-white dark:bg-zinc-900 border-4 border-black dark:border-black p-8 md:p-12 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] text-center text-black dark:text-white">
            <h2 className="text-4xl font-permanent uppercase tracking-tighter mb-6 relative inline-block">
                <span className="relative z-10">Email Verification</span>
                <span className="absolute -bottom-2 left-0 w-full h-4 bg-teal-600/30 -z-10 -rotate-1"></span>
            </h2>

            {status === 'loading' && (
                <div className="mb-6 p-4 bg-blue-100 border-4 border-black text-black font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    <p>{message}</p>
                </div>
            )}

            {status === 'success' && (
                <div className="mb-6 p-4 bg-green-100 border-4 border-black text-black font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    <p>{message}</p>
                    <p className="mt-2 text-sm">Redirecting to login...</p>
                </div>
            )}

            {status === 'error' && (
                <div className="mb-6 p-4 bg-red-100 border-4 border-black text-black font-bold shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                    <p>{message}</p>
                    <button
                        onClick={() => router.push('/login')}
                        className="mt-4 px-6 py-2 bg-black text-white hover:text-orange-500 hover:-translate-y-1 transition-all border-2 border-transparent font-bold"
                    >
                        Go to Login
                    </button>
                </div>
            )}
        </div>
    );
}

export default function VerifyEmailPage() {
    return (
        <div className="min-h-screen flex items-center justify-center py-20 px-6">
            <div className="w-full max-w-lg">
                <Suspense fallback={<div className="text-center font-bold">Loading...</div>}>
                    <VerifyEmailContent />
                </Suspense>
            </div>
        </div>
    );
}
