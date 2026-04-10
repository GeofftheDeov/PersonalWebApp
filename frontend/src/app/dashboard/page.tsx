"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import CalendarModal from '@/components/CalendarModal';
import Footer from "@/components/Footer";
import GameNightSummary from "@/components/GameNightSummary";


export default function DashboardPage() {
    const router = useRouter();
    const [user, setUser] = useState<any>(null);
    const [tasks, setTasks] = useState<any>([]);
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
    const [isCalendarOpen, setIsCalendarOpen] = useState(false);
    const [calendarTarget, setCalendarTarget] = useState<{ type: 'new' | 'edit', taskId?: string } | null>(null);
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [profileData, setProfileData] = useState<any>({});

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
        console.info("User loaded:", parsedUser.userNumber);

        const fetchTasks = async () => {
            const response = await fetch(`/api/tasks`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
            });

            if (response.status === 401) {
                handleAuthError();
                return;
            }

            const data = await response.json();            
            setTasks(data);
        };
        fetchTasks();
    }, [router]);

    if (!user) {
        return <div className="min-h-screen flex items-center justify-center"><span className="text-4xl font-permanent text-teal-600">LOADING...</span></div>;
    }

    const deleteTask = async (taskId: string) => {
        const response = await fetch(`/api/tasks/${taskId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
        });

        if (response.status === 401) {
            handleAuthError();
            return;
        }

        if (response.ok) {
            const updatedTasks = tasks.filter((task: any) => task._id !== taskId);
            setTasks(updatedTasks);
        }
    };

    const updateTask = async (taskId: string, taskData: any) => {
        const response = await fetch(`/api/tasks/${taskId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(taskData)
        });

        if (response.status === 401) {
            handleAuthError();
            return;
        }

        if (response.ok) {
            const updatedTasks = tasks.map((task: any) => task._id === taskId ? taskData : task);
            setTasks(updatedTasks);
        }
    };
    
    const updateProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        const token = localStorage.getItem('token');
        const response = await fetch(`/api/users/profile`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(profileData)
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
            setIsEditingProfile(false);
        }
    };
    return (
        <div className="min-h-[calc(100vh-76px)] flex flex-col overflow-hidden relative w-full">
            <div className="flex-grow w-full max-w-6xl mx-auto p-8 md:p-16 relative z-10">

                <header className="mb-16 relative">
                    <h1 className="text-5xl md:text-7xl font-permanent text-black dark:text-black leading-none tracking-tight uppercase">
                        <span className="relative inline-block">
                            <span className="drop-shadow-[6px_6px_0px_rgba(250,204,21,1)]">YOUR</span>
                        </span>
                        <span className="text-yellow-400 ml-4">
                            <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">DASHBOARD</span>
                        </span>
                    </h1>
                </header>

                <section className="grid grid-cols-1 md:grid-cols-2 gap-8 text-left">
                    <div className="relative">
                        <h2 className="text-4xl md:text-5xl font-permanent mb-6 text-teal-600 uppercase relative w-fit">
                            <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Your Tasks</span>
                        </h2>
                        <form 
                            onSubmit={async (e) => {
                                e.preventDefault();
                                const formData = new FormData(e.currentTarget);
                                const title = formData.get('title');
                                const description = formData.get('description');
                                const dueDate = formData.get('dueDate');
                                const status = formData.get('status');
                                const ownerId = user.id;
                                const ownerName = user.name;
                                const token = localStorage.getItem('token');

                                const response = await fetch(`/api/tasks`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${token}`
                                    },
                                    body: JSON.stringify({ title, description, dueDate, status, ownerId, ownerName })
                                });
                                
                                if (response.status === 401) {
                                    handleAuthError();
                                    return;
                                }

                                if (response.ok) {
                                    const data = await response.json();
                                    const newTask = data.task;
                                    setTasks((prev: any) => [...prev, newTask]);
                                    (e.target as HTMLFormElement).reset();
                                }
                            }}
                            className="mb-10 p-4 border-4 border-black bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:border-white"
                        >
                            <input 
                                name="title"
                                type="text" 
                                placeholder="NEW TASK TITLE" 
                                required
                                className="w-full p-2 mb-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase placeholder-gray-500 focus:outline-none focus:ring-0 dark:border-white dark:bg-black dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] placeholder-zinc-400 dark:text-white"

                            />
                            <div 
                                className="relative mb-3 cursor-pointer"
                                onClick={() => {
                                    console.log("[DASHBOARD] Opening calendar for NEW task");
                                    setCalendarTarget({ type: 'new' });
                                    setIsCalendarOpen(true);
                                }}
                            >
                                <input
                                    name="dueDate"
                                    type="date"
                                    placeholder="DUE DATE"
                                    required
                                    readOnly
                                    className="w-full p-2 border-4 border-black bg-white text-black font-permanent text-xl uppercase placeholder-gray-500 focus:outline-none focus:ring-0 dark:border-white dark:bg-black dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] placeholder-zinc-400 dark:text-white pointer-events-none"
                                />
                            </div>
                            <textarea 
                                name="description"
                                placeholder="TASK DESCRIPTION" 
                                required
                                className="w-full p-2 mb-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase placeholder-gray-500 focus:outline-none focus:ring-0 dark:border-white dark:bg-black dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] placeholder-zinc-400 dark:text-white"
                                rows={3}
                            />
                            <select
                                name="status"
                                required
                                className="w-full p-2 pr-10 mb-3 border-4 border-black dark:bg-black bg-white text-black font-permanent text-xl uppercase placeholder-gray-500 focus:outline-none focus:ring-0 dark:border-white  dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] placeholder-zinc-400 dark:text-white appearance-none"
                            >
                                <option value="Not Started">Not Started</option>
                                <option value="In Progress">In Progress</option>
                                <option value="Completed">Completed</option>
                            </select>

                            <button 
                                type="submit" 
                                className="w-full p-3 border-4 border-black bg-yellow-400 text-black font-permanent text-xl uppercase hover:bg-yellow-500 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                            >
                                ADD TASK
                            </button>
                        </form>

                        <div className="">
                            {tasks.map((task: any) => (
                                <div key={task._id} className="relative mb-10 p-4 border-4 border-black bg-zinc-200 dark:bg-slate-800 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] dark:border-white">
                                    <form 
                                        onSubmit={async (e) => {
                                            e.preventDefault();
                                            const formData = new FormData(e.currentTarget);
                                            const title = formData.get('title');
                                            const description = formData.get('description');
                                            const dueDate = formData.get('dueDate');
                                            const status = formData.get('status');
                                            const ownerId = user.id;
                                            const ownerName = user.name;
                                            const token = localStorage.getItem('token');

                                            const response = await fetch(`/api/tasks/${task._id}`, {
                                                method: 'PUT',
                                                headers: {
                                                    'Content-Type': 'application/json',
                                                    'Authorization': `Bearer ${token}`
                                                },
                                                body: JSON.stringify({ title, description, dueDate, status, ownerId, ownerName })
                                            });
                                            
                                            if (response.ok) {
                                                const newTask = await response.json();
                                                setTasks(tasks.map((t: any) => t._id === task._id ? newTask : t));
                                                (e.target as HTMLFormElement).reset();
                                                setEditingTaskId(null);
                                            }
                                        }}
                                    >
                                    <div className="">
                                    {editingTaskId !== task._id && (
                                        <>
                                            <h3 className="w-full p-2 mb-3 text-2xl font-permanent text-teal-600 dark:text-yellow-400 tracking-tight">
                                                <span className="text-purple-700 dark:text-orange-400">TITLE:</span> {task.title}
                                            </h3>
                                            <p className="w-full p-2 mb-3 text-xl font-permanent text-teal-600 dark:text-yellow-400 tracking-tight">
                                                <span className="text-purple-700 dark:text-orange-400">DUE DATE:</span> {new Date(task.dueDate).toLocaleDateString()}
                                            </p>
                                            <p className="w-full p-2 mb-3 text-xl font-permanent text-teal-600 dark:text-yellow-400 tracking-tight">
                                                <span className="text-purple-700 dark:text-orange-400">DESCRIPTION:</span> {task.description}
                                            </p>
                                            <p className="w-full p-2 mb-3 text-xl font-permanent text-teal-600 dark:text-yellow-400 tracking-tight">
                                                <span className="text-purple-700 dark:text-orange-400">STATUS:</span>                                             
                                                <select
                                                value={task.status}
                                                name="status"
                                                onChange={(e) => {
                                                    updateTask(task._id, { ...task, status: e.target.value });
                                                }}
                                                className="w-full p-4 pr-10 border-2 border-black dark:border-white mb-3 text-xl font-permanent bg-transparent text-teal-600 dark:text-yellow-400 tracking-tight appearance-none"
                                                >
                                                <option value="Not Started" className ="text-xl font-permanent text-teal-600 dark:text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight">Not Started</option>
                                                <option value="In Progress" className ="text-xl font-permanent text-teal-600 dark:text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight">In Progress</option>
                                                <option value="Completed" className ="text-xl font-permanent text-teal-600 dark:text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight">Completed</option>
                                                </select>
                                            </p>
                                        </>
                                    )}

                                    {editingTaskId === task._id && (
                                        <>
                                            <p>
                                            <span className="text-purple-700 dark:text-orange-400 font-permanent">TITLE:</span>
                                            <input
                                                type="text"
                                                value={task.title}
                                                name="title"
                                                
                                                className="w-full p-4 mb-3 border-2 border-black dark:border-white text-xl font-permanent bg-transparent text-teal-600 dark:text-yellow-400 tracking-tight"
                                            />
                                            </p>
                                            <p>
                                            <span className="text-purple-700 dark:text-orange-400 font-permanent">DESCRIPTION:</span>
                                            <textarea
                                                value={task.description}
                                                name="description"
                                                className="w-full p-4 mb-3 border-2 border-black dark:border-white text-xl fit-content font-permanent bg-transparent text-teal-600 dark:text-yellow-400 tracking-tight"
                                            />
                                            </p>
                                            <p 
                                                className="relative cursor-pointer"
                                                onClick={() => {
                                                    console.log(`[DASHBOARD] Opening calendar for EDIT task: ${task._id}`);
                                                    setCalendarTarget({ type: 'edit', taskId: task._id });
                                                    setIsCalendarOpen(true);
                                                }}
                                            >
                                                <span className="text-purple-700 dark:text-orange-400 font-permanent">DUE DATE:</span>
                                                <input
                                                    type="date" 
                                                    value={new Date(task.dueDate).toISOString().split('T')[0]}
                                                    name="dueDate"
                                                    readOnly
                                                    className="w-full p-4 mb-3 border-2 border-black dark:border-white icon-white text-xl font-permanent bg-transparent text-teal-600 dark:text-yellow-400 tracking-tight pointer-events-none"
                                                />
                                            </p>
                                            <p>
                                            <span className="text-purple-700 dark:text-orange-400 font-permanent">STATUS:</span>
                                            <select
                                                value={task.status}
                                                name="status"
                                                className="w-full p-2 pr-10 mb-3 border-2 border-black dark:border-white text-xl font-permanent bg-transparent text-teal-600 dark:text-yellow-400 tracking-tight appearance-none"
                                            >
                                                <option value="Not Started" className ="text-xl font-permanent text-teal-600 dark:text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight">Not Started</option>
                                                <option value="In Progress" className ="text-xl font-permanent text-teal-600 dark:text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight">In Progress</option>
                                                <option value="Completed" className ="text-xl font-permanent text-teal-600 dark:text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight">Completed</option>
                                            </select>
                                            </p>
                                        </>
                                    )}

                                    </div>
                                    <div className="flex justify-between">
                                        {editingTaskId !== task._id && (
                                            <>
                                            <button
                                                type="button"
                                                onClick={() => setEditingTaskId(task._id)}
                                                className="text-xl font-permanent text-teal-600 dark:text-yellow-400 tracking-tight"
                                            >
                                                Edit
                                            </button>
                                            &nbsp;
                                            </>
                                        )}

                                    {editingTaskId === task._id && (
                                        <>
                                        <button
                                            type="button"
                                            onClick={() => setEditingTaskId(null)}
                                            className="text-xl font-permanent text-teal-600 dark:text-yellow-400 tracking-tight"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            className="w-full ml-2 mr-2 p-3 border-4 border-black bg-teal-500 dark:bg-yellow-400 text-white dark:text-black font-permanent text-xl uppercase hover:bg-teal-600 dark:hover:bg-yellow-500 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                                        >
                                            Save
                                        </button>
                                        &nbsp;
                                        </>
                                    )}
                                    <button
                                        onClick={() => deleteTask(task._id)}
                                        className="text-xl font-permanent text-teal-600 dark:text-yellow-400 tracking-tight "
                                    >
                                        Delete
                                    </button>
                                    </div>
                                    </form>

                                </div>
                            ))}
                        </div>

                    </div>

                    <div className="relative">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-4xl md:text-5xl font-permanent text-yellow-400 uppercase relative w-fit">
                                <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Profile</span>
                            </h2>
                            {!isEditingProfile && (
                                <button 
                                    onClick={() => {
                                        setProfileData(user);
                                        setIsEditingProfile(true);
                                    }}
                                    className="text-xl font-permanent text-yellow-400 uppercase hover:text-white transition-colors drop-shadow-[2px_2px_0px_rgba(0,0,0,1)]"
                                >
                                    [ EDIT ]
                                </button>
                            )}
                        </div>

                        {isEditingProfile ? (
                            <form onSubmit={updateProfile} className="space-y-4 font-permanent text-xl text-yellow-400">
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">NAME:</label>
                                    <input 
                                        type="text" 
                                        value={profileData.name || ''} 
                                        onChange={(e) => setProfileData({...profileData, name: e.target.value})}
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
                                            onChange={(e) => setProfileData({...profileData, handle: e.target.value.replace(/^@/, '')})}
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
                                        onChange={(e) => setProfileData({...profileData, phone: e.target.value})}
                                        className="bg-black border-2 border-yellow-400 p-2 text-white outline-none focus:border-teal-500"
                                    />
                                </div>
                                <div className="flex flex-col">
                                    <label className="text-teal dark:text-orange-400 uppercase text-sm mb-1">EMAIL:</label>
                                    <input 
                                        type="text" 
                                        value={profileData.email || ''} 
                                        onChange={(e) => setProfileData({...profileData, email: e.target.value})}
                                        className="bg-black border-2 border-yellow-400 p-2 text-white outline-none focus:border-teal-500"
                                    />
                                </div>
                                <div className="flex gap-4 pt-4">
                                    <button 
                                        type="submit"
                                        className="flex-1 p-3 bg-yellow-400 text-black font-black uppercase hover:bg-white transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                                    >
                                        SAVE CHANGES
                                    </button>
                                    <button 
                                        type="button"
                                        onClick={() => setIsEditingProfile(false)}
                                        className="flex-1 p-3 bg-zinc-600 text-white font-black uppercase hover:bg-zinc-700 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                                    >
                                        CANCEL
                                    </button>
                                </div>
                            </form>
                        ) : (
                            <div className="text-xl md:text-2xl font-permanent leading-tight text-yellow-400 drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight space-y-3">
                                <p><span className="text-teal dark:text-orange-400">NAME:</span> {user.name?.toUpperCase() || 'N/A'}</p>
                                {user.type === 'User' && (
                                    <p><span className="text-teal dark:text-orange-400">INTERNAL ID:</span> {user.userDigit || 'N/A'}</p>
                                )}
                                <p><span className="text-teal dark:text-orange-400">HANDLE:</span> {user.handle ? `@${user.handle.toUpperCase()}` : 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">UNIQUE ID:</span> {user.handle && user.userNumber ? `@${user.handle.toUpperCase()}#${user.userNumber}` : 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">EMAIL:</span> {user.email?.toUpperCase() || 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">TYPE:</span> {user.type?.toUpperCase() || 'N/A'}</p>
                                <p><span className="text-teal dark:text-orange-400">PHONE:</span> {user.phone?.toUpperCase() || 'N/A'}</p>
                            </div>
                        )}
                    </div>
                </section>

                <GameNightSummary />
            </div>

            <Footer>
                <div className="inline-block border-8 border-black dark:border-black px-12 py-8 mb-12 bg-orange-500 shadow-[12px_12px_0px_0px_rgba(250,204,21,1)]">
                    <p className="text-3xl md:text-4xl font-permanent text-black uppercase leading-tight">
                        Authenticated.<br/>Secure.<br/>Ready to Build.
                    </p>
                </div>
            </Footer>
            <CalendarModal 
                isOpen={isCalendarOpen}
                onClose={() => setIsCalendarOpen(false)}
                onSelectDate={(date) => {
                    if (calendarTarget?.type === 'new') {
                        const form = document.querySelector('form') as HTMLFormElement;
                        if (form) {
                            const input = form.querySelector('input[name="dueDate"]') as HTMLInputElement;
                            if (input) input.value = date;
                        }
                    } else if (calendarTarget?.type === 'edit' && calendarTarget.taskId) {
                        const taskToUpdate = tasks.find((t: any) => t._id === calendarTarget.taskId);
                        if (taskToUpdate) {
                            updateTask(calendarTarget.taskId, { ...taskToUpdate, dueDate: date });
                        }
                    }
                }}
            />
        </div>
    );
}
