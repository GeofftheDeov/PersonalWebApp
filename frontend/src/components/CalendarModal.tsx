"use client";

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface CalendarModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectDate: (date: string) => void;
    currentDate?: string;
}

export default function CalendarModal({ isOpen, onClose, onSelectDate, currentDate }: CalendarModalProps) {
    console.log("[CALENDAR_MODAL] Render, isOpen:", isOpen);
    const [viewDate, setViewDate] = useState(currentDate ? new Date(currentDate) : new Date());
    
    const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
    const firstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();
    
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const monthName = viewDate.toLocaleString('default', { month: 'long' }).toUpperCase();
    
    const days = [];
    const totalDays = daysInMonth(year, month);
    const startOffset = firstDayOfMonth(year, month);
    
    for (let i = 0; i < startOffset; i++) {
        days.push(null);
    }
    for (let i = 1; i <= totalDays; i++) {
        days.push(i);
    }

    const changeMonth = (offset: number) => {
        setViewDate(new Date(year, month + offset, 1));
    };

    const handleDateSelect = (day: number) => {
        const selected = new Date(year, month, day);
        onSelectDate(selected.toISOString().split('T')[0]);
        onClose();
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                    />
                    
                    <motion.div 
                        initial={{ scale: 0.9, y: 20, opacity: 0 }}
                        animate={{ scale: 1, y: 0, opacity: 1 }}
                        exit={{ scale: 0.9, y: 20, opacity: 0 }}
                        className="relative w-full max-w-md border-8 border-black bg-orange-500 dark:bg-purple-600 p-6 shadow-[12px_12px_0px_0px_rgba(0,0,0,1)] dark:border-white"
                    >
                        <header className="flex items-center justify-between mb-6">
                            <button 
                                onClick={() => changeMonth(-1)}
                                className="border-4 border-black bg-teal-500 dark:bg-yellow-400 text-white dark:text-black p-2 font-permanent hover:bg-teal-600 dark:hover:bg-yellow-500 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none transition-all"
                            >
                                PREV
                            </button>
                            <h2 className="text-3xl font-permanent text-purple-800 dark:text-orange-400 uppercase tracking-tight drop-shadow-[2px_2px_0px_rgba(255,255,255,1)] dark:drop-shadow-[2px_2px_0px_rgba(0,0,0,1)]">
                                {monthName} {year}
                            </h2>
                            <button 
                                onClick={() => changeMonth(1)}
                                className="border-4 border-black bg-teal-500 dark:bg-yellow-400 text-white dark:text-black p-2 font-permanent hover:bg-teal-600 dark:hover:bg-yellow-500 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none transition-all"
                            >
                                NEXT
                            </button>
                        </header>

                        <div className="grid grid-cols-7 gap-2">
                            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(day => (
                                <div key={day} className="text-center font-permanent text-purple-800 dark:text-orange-400 text-xl mb-2">{day}</div>
                            ))}
                            {days.map((day, idx) => (
                                <div key={idx} className="aspect-square flex items-center justify-center">
                                    {day && (
                                        <button
                                            onClick={() => handleDateSelect(day)}
                                            className={`w-full h-full border-4 border-black font-permanent text-xl transition-all shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-teal-400 dark:hover:bg-yellow-500 hover:-translate-y-1 active:translate-y-0 active:shadow-none
                                                ${currentDate && new Date(currentDate).getDate() === day && new Date(currentDate).getMonth() === month && new Date(currentDate).getFullYear() === year 
                                                    ? 'bg-teal-500 dark:bg-yellow-400 text-white dark:text-black' 
                                                    : 'bg-zinc-100 dark:bg-slate-900 text-teal-600 dark:text-yellow-400'}`}
                                        >
                                            {day}
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>

                        <button 
                            onClick={onClose}
                            className="mt-8 w-full border-4 border-black bg-teal-500 dark:bg-yellow-400 text-white dark:text-black p-3 font-permanent text-xl uppercase hover:bg-teal-600 dark:hover:bg-yellow-500 transition-colors shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]"
                        >
                            CLOSE
                        </button>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
