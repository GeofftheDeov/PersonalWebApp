"use client";

import Link from 'next/link';
import { ScrollText, Sparkles, Wrench, Bug } from 'lucide-react';
import Footer from '@/components/Footer';
import { PATCH_NOTES, ChangeKind } from '@/data/patchNotes';

const KIND_STYLE: Record<ChangeKind, string> = {
    NEW: 'bg-teal-500 text-white',
    IMPROVED: 'bg-yellow-400 text-black',
    FIXED: 'bg-orange-500 text-black',
};

const KIND_ICON: Record<ChangeKind, React.ReactNode> = {
    NEW: <Sparkles className="w-3 h-3" />,
    IMPROVED: <Wrench className="w-3 h-3" />,
    FIXED: <Bug className="w-3 h-3" />,
};

const fmtDate = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase();

export default function PatchNotesPage() {
    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col">
            <div className="flex-grow w-full max-w-4xl mx-auto p-4 sm:p-6 md:p-12">

                {/* Header */}
                <header className="mb-10 border-b-8 border-black pb-6">
                    <p className="text-teal-600 font-permanent uppercase text-sm tracking-widest mb-1">
                        <Link href="/" className="hover:text-yellow-400 transition-colors">← HOME</Link>
                    </p>
                    <h1 className="text-4xl sm:text-5xl md:text-7xl font-permanent text-black dark:text-white uppercase leading-none flex items-end gap-4 flex-wrap">
                        <span className="drop-shadow-[4px_4px_0px_rgba(13,148,136,1)]">PATCH</span>
                        <span className="text-teal-600 drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">NOTES</span>
                    </h1>
                    <p className="font-permanent text-zinc-500 dark:text-zinc-400 uppercase text-sm mt-2">
                        Everything that changed, newest first.
                    </p>
                </header>

                {/* Releases */}
                <div className="space-y-10">
                    {PATCH_NOTES.map(note => (
                        <article key={note.version} className="border-4 border-black bg-white dark:bg-slate-800 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
                            <div className="p-5 sm:p-6 border-b-4 border-black bg-slate-900 flex flex-wrap items-baseline justify-between gap-3">
                                <div className="min-w-0">
                                    <h2 className="font-permanent text-xl sm:text-2xl text-white uppercase flex items-center gap-3">
                                        <ScrollText className="w-6 h-6 text-teal-400 shrink-0" />
                                        {note.title}
                                    </h2>
                                    {note.summary && (
                                        <p className="font-permanent text-xs text-zinc-400 uppercase mt-2 leading-relaxed">{note.summary}</p>
                                    )}
                                </div>
                                <div className="text-right shrink-0">
                                    <span className="px-3 py-1 font-permanent text-sm uppercase border-2 border-black bg-yellow-400 text-black">
                                        v{note.version}
                                    </span>
                                    <p className="font-permanent text-[10px] text-zinc-500 uppercase mt-2">{fmtDate(note.date)}</p>
                                </div>
                            </div>
                            <ul className="p-5 sm:p-6 space-y-3">
                                {note.changes.map((change, i) => (
                                    <li key={i} className="flex items-start gap-3">
                                        <span className={`flex items-center gap-1 px-2 py-0.5 border-2 border-black font-permanent text-[10px] uppercase shrink-0 mt-0.5 ${KIND_STYLE[change.kind]}`}>
                                            {KIND_ICON[change.kind]} {change.kind}
                                        </span>
                                        <p className="font-permanent text-sm text-black dark:text-white uppercase leading-relaxed">{change.text}</p>
                                    </li>
                                ))}
                            </ul>
                        </article>
                    ))}
                </div>
            </div>

            <Footer>
                <div className="inline-block border-4 sm:border-8 border-black px-6 sm:px-12 py-6 sm:py-8 mb-12 mx-3 bg-teal-600 shadow-[6px_6px_0px_0px_rgba(249,115,22,1)] sm:shadow-[12px_12px_0px_0px_rgba(249,115,22,1)]">
                    <p className="text-2xl sm:text-3xl md:text-4xl font-permanent text-white uppercase leading-tight">
                        Always<br />Shipping.
                    </p>
                </div>
            </Footer>
        </div>
    );
}
