"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Footer from '@/components/Footer';

export default function ProfilePage() {
    const router = useRouter();
    const [user, setUser] = useState<any>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [profileData, setProfileData] = useState<any>({});
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [sessions, setSessions] = useState<any[]>([]);
    const [games, setGames] = useState<string[]>([]);
    const [gameInput, setGameInput] = useState('');
    const [savingGames, setSavingGames] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleAuthError = () => {
        localStorage.clear();
        window.dispatchEvent(new Event('authChange'));
        router.push('/login');
    };

    useEffect(() => {
        const token = localStorage.getItem('token');
        const userData = localStorage.getItem('user');

        if (!token || !userData) {
            router.push('/login');
            return;
        }

        const parsedUser = JSON.parse(userData);
        setUser(parsedUser);
        setProfileData(parsedUser);
        setGames(parsedUser.favoriteGames || []);

        fetch('/api/users/profile/sessions', {
            headers: { 'Authorization': `Bearer ${token}` },
        })
            .then(r => r.ok ? r.json() : [])
            .then(setSessions)
            .catch(() => setSessions([]));
    }, [router]);

    if (!user) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <span className="text-4xl font-permanent text-teal-600">LOADING...</span>
            </div>
        );
    }

    const handlePictureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setUploadError(null);
        setIsUploading(true);

        const formData = new FormData();
        formData.append('profilePicture', file);

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/users/profile/picture', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData,
            });

            if (response.status === 401) {
                handleAuthError();
                return;
            }

            if (response.ok) {
                const data = await response.json();
                const updatedUser = { ...user, profilePicture: data.profilePicture };
                setUser(updatedUser);
                localStorage.setItem('user', JSON.stringify(updatedUser));
            } else {
                const err = await response.json();
                setUploadError(err.error || 'Upload failed');
            }
        } catch {
            setUploadError('Upload failed. Please try again.');
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const updateProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        const token = localStorage.getItem('token');
        const response = await fetch('/api/users/profile', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(profileData),
        });

        if (response.status === 401) {
            handleAuthError();
            return;
        }

        if (response.ok) {
            const data = await response.json();
            const updatedUser = { ...user, ...data.user };
            setUser(updatedUser);
            localStorage.setItem('user', JSON.stringify(updatedUser));
            setIsEditing(false);
        }
    };

    const addGame = async () => {
        const name = gameInput.trim();
        if (!name || games.includes(name)) { setGameInput(''); return; }
        const next = [...games, name];
        setGames(next);
        setGameInput('');
        await persistGames(next);
    };

    const removeGame = async (game: string) => {
        const next = games.filter(g => g !== game);
        setGames(next);
        await persistGames(next);
    };

    const persistGames = async (list: string[]) => {
        setSavingGames(true);
        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/users/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ favoriteGames: list }),
            });
            if (response.status === 401) { handleAuthError(); return; }
            if (response.ok) {
                const data = await response.json();
                const updatedUser = { ...user, ...data.user };
                setUser(updatedUser);
                localStorage.setItem('user', JSON.stringify(updatedUser));
            }
        } finally {
            setSavingGames(false);
        }
    };

    const displayName = user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'USER';

    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col overflow-hidden relative w-full">
            <div className="flex-grow w-full max-w-4xl mx-auto p-8 md:p-16 relative z-10">

                <header className="mb-16 relative">
                    <h1 className="text-5xl md:text-7xl font-permanent text-black dark:text-black leading-none tracking-tight uppercase">
                        <span className="relative inline-block">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">YOUR</span>
                        </span>
                        <span className="text-yellow-400 ml-4">
                            <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">PROFILE</span>
                        </span>
                    </h1>
                </header>

                <div className="flex flex-col md:flex-row gap-10 items-start">

                    {/* Profile picture column */}
                    <div className="flex flex-col items-center gap-4 shrink-0">
                        <div
                            className="relative w-40 h-40 border-4 border-black dark:border-white shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] cursor-pointer group overflow-hidden bg-zinc-200 dark:bg-zinc-800"
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {user.profilePicture ? (
                                <img
                                    src={user.profilePicture}
                                    alt="Profile"
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <span className="text-6xl font-permanent text-teal-600 dark:text-yellow-400 select-none">
                                        {displayName.charAt(0).toUpperCase()}
                                    </span>
                                </div>
                            )}
                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <span className="text-white font-permanent text-sm uppercase text-center leading-tight px-2">
                                    {isUploading ? 'UPLOADING...' : 'CHANGE PHOTO'}
                                </span>
                            </div>
                        </div>

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handlePictureUpload}
                            disabled={isUploading}
                        />

                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploading}
                            className="px-4 py-2 bg-yellow-400 text-black dark:bg-teal-600 dark:text-white font-permanent text-sm uppercase hover:bg-yellow-500 dark:hover:bg-teal-700 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] border-2 border-black dark:border-white disabled:opacity-50"
                        >
                            {isUploading ? 'UPLOADING...' : 'UPLOAD PHOTO'}
                        </button>

                        {uploadError && (
                            <p className="text-red-500 font-permanent text-xs uppercase text-center">{uploadError}</p>
                        )}

                        <p className="text-zinc-400 font-permanent text-xs uppercase text-center">
                            JPG, PNG, GIF, WEBP<br />MAX 5MB
                        </p>
                    </div>

                    {/* Profile info column */}
                    <div className="flex-1 w-full">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-4xl md:text-5xl font-permanent text-yellow-400 uppercase relative w-fit">
                                <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Info</span>
                            </h2>
                            {!isEditing && (
                                <button
                                    onClick={() => {
                                        setProfileData(user);
                                        setIsEditing(true);
                                    }}
                                    className="px-6 py-2 bg-yellow-400 text-black dark:bg-teal-600 dark:text-white font-permanent text-xl uppercase hover:bg-yellow-500 dark:hover:bg-teal-700 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                                >
                                    EDIT
                                </button>
                            )}
                        </div>

                        {isEditing ? (
                            <form onSubmit={updateProfile} className="space-y-4 font-permanent text-xl text-yellow-400">
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">NAME:</label>
                                    <input
                                        type="text"
                                        value={profileData.name || ''}
                                        onChange={(e) => setProfileData({ ...profileData, name: e.target.value })}
                                        className="bg-black border-2 border-yellow-400 p-2 text-white outline-none focus:border-teal-500"
                                    />
                                </div>
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">HANDLE:</label>
                                    <div className="relative flex items-center">
                                        <span className="absolute left-3 text-yellow-400 font-permanent text-xl pointer-events-none">@</span>
                                        <input
                                            type="text"
                                            value={profileData.handle || ''}
                                            onChange={(e) => setProfileData({ ...profileData, handle: e.target.value.replace(/^@/, '') })}
                                            className="bg-black border-2 border-yellow-400 p-2 pl-8 text-white outline-none focus:border-teal-500 w-full"
                                            placeholder="yourhandle"
                                        />
                                    </div>
                                </div>
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">PHONE:</label>
                                    <input
                                        type="text"
                                        value={profileData.phone || ''}
                                        onChange={(e) => setProfileData({ ...profileData, phone: e.target.value })}
                                        className="bg-black border-2 border-yellow-400 p-2 text-white outline-none focus:border-teal-500"
                                    />
                                </div>
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">EMAIL:</label>
                                    <input
                                        type="text"
                                        value={profileData.email || ''}
                                        disabled
                                        className="bg-zinc-800 border-2 border-zinc-600 p-2 text-zinc-400 outline-none cursor-not-allowed"
                                    />
                                    <p className="text-[10px] text-zinc-500 mt-1 italic">Email cannot be changed here.</p>
                                </div>
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">DISCORD HANDLE:</label>
                                    <input
                                        type="text"
                                        value={profileData.discordHandle || ''}
                                        onChange={(e) => setProfileData({ ...profileData, discordHandle: e.target.value })}
                                        className="bg-black border-2 border-yellow-400 p-2 text-white outline-none focus:border-teal-500"
                                        placeholder="username#0000"
                                    />
                                </div>
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">DISCORD USER ID:</label>
                                    <input
                                        type="text"
                                        value={profileData.discordId || ''}
                                        onChange={(e) => setProfileData({ ...profileData, discordId: e.target.value })}
                                        className="bg-black border-2 border-yellow-400 p-2 text-white outline-none focus:border-teal-500"
                                        placeholder="123456789012345678"
                                    />
                                    <p className="text-[10px] text-zinc-500 mt-1 italic">
                                        Settings &gt; Advanced &gt; Developer Mode (ON) &gt; Right-click profile &gt; Copy User ID
                                    </p>
                                </div>
                                <div className="flex gap-4 pt-4">
                                    <button
                                        type="submit"
                                        className="flex-1 p-3 bg-yellow-400 text-black dark:bg-teal-600 dark:text-white font-permanent font-black uppercase hover:bg-yellow-500 dark:hover:bg-teal-700 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                                    >
                                        SAVE CHANGES
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setIsEditing(false)}
                                        className="flex-1 p-3 bg-zinc-600 text-white font-permanent font-black uppercase hover:bg-zinc-700 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                                    >
                                        CANCEL
                                    </button>
                                </div>
                            </form>
                        ) : (
                            <div className="text-xl md:text-2xl font-permanent leading-tight text-yellow-400 drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight space-y-3">
                                <p><span className="text-teal dark:text-orange-400">NAME:</span> {displayName.toUpperCase()}</p>
                                {user.type === 'User' && (
                                    <p><span className="text-teal dark:text-orange-400">INTERNAL ID:</span> {user.userDigit || 'N/A'}</p>
                                )}
                                <p><span className="text-teal dark:text-orange-400">HANDLE:</span> {user.handle ? `@${user.handle.toUpperCase()}` : 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">UNIQUE ID:</span> {user.handle && user.userNumber ? `@${user.handle.toUpperCase()}#${user.userNumber}` : 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">EMAIL:</span> {user.email?.toUpperCase() || 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">TYPE:</span> {user.type?.toUpperCase() || 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">PHONE:</span> {user.phone?.toUpperCase() || 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">DISCORD:</span> {user.discordHandle ? user.discordHandle.toUpperCase() : 'NOT LINKED'}</p>
                            </div>
                        )}
                    </div>
                </div>
                {/* Favorite games */}
                <div className="mt-16">
                    <h2 className="text-4xl md:text-5xl font-permanent text-yellow-400 uppercase relative w-fit mb-8">
                        <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Favorite Games</span>
                    </h2>

                    <div className="flex gap-3 mb-6">
                        <input
                            type="text"
                            value={gameInput}
                            onChange={(e) => setGameInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addGame())}
                            placeholder="ADD A GAME..."
                            className="flex-1 bg-black border-2 border-yellow-400 p-3 text-white font-permanent text-lg uppercase outline-none focus:border-teal-500 placeholder-zinc-600"
                        />
                        <button
                            onClick={addGame}
                            disabled={!gameInput.trim() || savingGames}
                            className="px-6 py-3 bg-yellow-400 text-black dark:bg-teal-600 dark:text-white font-permanent text-lg uppercase hover:bg-yellow-500 dark:hover:bg-teal-700 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] disabled:opacity-40"
                        >
                            ADD
                        </button>
                    </div>

                    {games.length === 0 ? (
                        <p className="font-permanent text-xl text-zinc-500 uppercase">No games added yet.</p>
                    ) : (
                        <div className="flex flex-wrap gap-3">
                            {games.map((game) => (
                                <div
                                    key={game}
                                    className="flex items-center gap-2 px-4 py-2 border-4 border-black dark:border-white bg-zinc-200 dark:bg-slate-800 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
                                >
                                    <span className="font-permanent text-lg text-teal-600 dark:text-yellow-400 uppercase tracking-tight">{game}</span>
                                    <button
                                        onClick={() => removeGame(game)}
                                        className="font-permanent text-xl text-zinc-400 hover:text-red-500 transition-colors leading-none"
                                        aria-label={`Remove ${game}`}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Sessions attended */}
                <div className="mt-16">
                    <h2 className="text-4xl md:text-5xl font-permanent text-teal-600 uppercase relative w-fit mb-8">
                        <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Sessions Attended</span>
                    </h2>

                    {sessions.length === 0 ? (
                        <p className="font-permanent text-xl text-zinc-500 uppercase">No sessions on record.</p>
                    ) : (
                        <div className="grid gap-4 sm:grid-cols-2">
                            {sessions.map((s) => (
                                <Link
                                    key={s.playerSessionId}
                                    href={`/game-night/sessions/${s.sessionId}`}
                                    className="block p-5 border-4 border-black dark:border-white bg-zinc-200 dark:bg-slate-800 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] transition-shadow"
                                >
                                    <p className="font-permanent text-xl text-teal-600 dark:text-yellow-400 uppercase tracking-tight leading-tight">
                                        {s.title}
                                    </p>
                                    {s.campaign && (
                                        <p className="font-permanent text-sm text-zinc-500 dark:text-zinc-400 uppercase mt-1">
                                            {s.campaign.title}
                                        </p>
                                    )}
                                    <p className="font-permanent text-sm text-zinc-500 dark:text-zinc-400 uppercase mt-1">
                                        {new Date(s.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                                    </p>
                                </Link>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <Footer>
                <div className="inline-block border-8 border-black dark:border-black px-12 py-8 mb-12 bg-teal-600 shadow-[12px_12px_0px_0px_rgba(249,115,22,1)]">
                    <p className="text-3xl md:text-4xl font-permanent text-white uppercase leading-tight">
                        Authenticated.<br />Secure.<br />Ready to Build.
                    </p>
                </div>
            </Footer>
        </div>
    );
}
