"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function CreateAccountPage() {
    const router = useRouter();
    const [formData, setFormData] = useState({
        firstName: '',
        lastName: '',
        email: '',
        password: '',
        company: '',
        phone: ''
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setFormData({
            ...formData,
            [e.target.name]: e.target.value
        });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');
        setSuccess(false);

        try {
            const response = await fetch('http://localhost:5000/api/leads', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to create account');
            }

            setSuccess(true);
            setFormData({
                firstName: '',
                lastName: '',
                email: '',
                password: '',
                company: '',
                phone: ''
            });

            // Redirect to login after 2 seconds
            setTimeout(() => {
                router.push('/login');
            }, 2000);
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-bricks relative overflow-hidden text-black dark:text-white pb-20 pt-32">
             {/* Grain Overlay */}
            <div className="absolute inset-0 bg-grain mix-blend-overlay z-40 pointer-events-none"></div>

            {/* Atmosphere/Lighting */}
            <div className="absolute -top-40 -left-40 w-[600px] h-[600px] bg-teal-600/20 blur-[120px] rounded-full z-0 animate-pulse pointer-events-none"></div>
            <div className="absolute top-1/2 -right-60 w-[800px] h-[800px] bg-yellow-400/10 blur-[150px] rounded-full z-0 pointer-events-none"></div>
            <div className="absolute bottom-[-20%] left-1/4 w-[500px] h-[500px] bg-orange-500/15 blur-[100px] rounded-full z-0 animate-pulse pointer-events-none"></div>

            <div className="relative z-10 w-full max-w-2xl px-6">
                <div className="bg-white dark:bg-zinc-900 border-4 border-black dark:border-white p-8 md:p-12 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] dark:shadow-[12px_12px_0px_0px_rgba(255,255,255,1)] transform rotate-1">
                    <div className="text-center mb-8">
                        <h2 className="text-5xl font-permanent uppercase tracking-tighter mb-4 transform -rotate-1 relative inline-block">
                             <span className="relative z-10">Create Account</span>
                             <span className="absolute -bottom-2 left-0 w-full h-4 bg-teal-600/30 -z-10 -rotate-1"></span>
                        </h2>
                        <p className="text-xl font-bold font-sans uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Join the chaos. Build something real.</p>
                    </div>

                    {success && (
                        <div className="mb-6 p-4 bg-green-100 border-4 border-black text-black font-bold text-center shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                            <p>Account created successfully! Redirecting to login...</p>
                        </div>
                    )}

                    {error && (
                        <div className="mb-6 p-4 bg-red-100 border-4 border-black text-black font-bold text-center shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                            <p>{error}</p>
                        </div>
                    )}

                    <form className="space-y-6" onSubmit={handleSubmit}>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-lg font-black uppercase tracking-tight ml-1">First Name</label>
                                <input
                                    type="text"
                                    name="firstName"
                                    value={formData.firstName}
                                    onChange={handleChange}
                                    required
                                    className="w-full bg-white dark:bg-black border-4 border-black dark:border-white px-4 py-3 font-bold focus:outline-none focus:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-shadow placeholder-zinc-400"
                                    placeholder="JOHNNY"
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-lg font-black uppercase tracking-tight ml-1">Last Name</label>
                                <input
                                    type="text"
                                    name="lastName"
                                    value={formData.lastName}
                                    onChange={handleChange}
                                    required
                                    className="w-full bg-white dark:bg-black border-4 border-black dark:border-white px-4 py-3 font-bold focus:outline-none focus:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-shadow placeholder-zinc-400"
                                    placeholder="SILVERHAND"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-lg font-black uppercase tracking-tight ml-1">Email</label>
                            <input
                                type="email"
                                name="email"
                                value={formData.email}
                                onChange={handleChange}
                                required
                                className="w-full bg-white dark:bg-black border-4 border-black dark:border-white px-4 py-3 font-bold focus:outline-none focus:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-shadow placeholder-zinc-400"
                                placeholder="name@example.com"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-lg font-black uppercase tracking-tight ml-1">Password</label>
                            <input
                                type="password"
                                name="password"
                                value={formData.password}
                                onChange={handleChange}
                                required
                                className="w-full bg-white dark:bg-black border-4 border-black dark:border-white px-4 py-3 font-bold focus:outline-none focus:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-shadow placeholder-zinc-400"
                                placeholder="••••••••"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-lg font-black uppercase tracking-tight ml-1">Company</label>
                            <input
                                type="text"
                                name="company"
                                value={formData.company}
                                onChange={handleChange}
                                required
                                className="w-full bg-white dark:bg-black border-4 border-black dark:border-white px-4 py-3 font-bold focus:outline-none focus:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-shadow placeholder-zinc-400"
                                placeholder="ARASAKA"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-lg font-black uppercase tracking-tight ml-1">Phone</label>
                            <input
                                type="tel"
                                name="phone"
                                value={formData.phone}
                                onChange={handleChange}
                                className="w-full bg-white dark:bg-black border-4 border-black dark:border-white px-4 py-3 font-bold focus:outline-none focus:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] transition-shadow placeholder-zinc-400"
                                placeholder="+1 (555) 123-4567"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full mt-4 py-4 bg-black dark:bg-white text-white dark:text-black border-4 border-black dark:border-white font-black uppercase text-xl tracking-widest hover:text-orange-500 hover:border-orange-500 transition-colors shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? 'Creating...' : 'Create Account'}
                        </button>
                    </form>

                    <div className="mt-8 text-center text-lg font-bold uppercase">
                        <p className="text-zinc-500">
                            Already have an account?{' '}
                            <a href="/login" className="text-teal-600 hover:text-teal-500 underline decoration-4 decoration-teal-600 underline-offset-4 hover:no-underline">Sign in</a>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
