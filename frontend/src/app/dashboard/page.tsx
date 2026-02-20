"use client";

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DashboardPage() {
    const router = useRouter();
    const [user, setUser] = useState<any>(null);
    const [tasks, setTasks] = useState<any>([]);
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null);

    useEffect(() => {
        const token = localStorage.getItem('token');
        const userData = localStorage.getItem('user');

        if (!token || !userData) {
            router.push('/login');
            return;
        }

        const parsedUser = JSON.parse(userData);
        setUser(parsedUser);
        console.info("User loaded:", parsedUser.userNumber);

        const fetchTasks = async () => {
            const response = await fetch(`/api/tasks`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
            });
            const data = await response.json();            
            console.log(data);
            setTasks(data);
            console.info(tasks);
            
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
        if (response.ok) {
            const updatedTasks = tasks.map((task: any) => task._id === taskId ? taskData : task);
            setTasks(updatedTasks);
        }
    };
    
    return (
        <div className="min-h-[calc(100vh-76px)] p-8 md:p-16 overflow-hidden relative">
            <div className="max-w-6xl mx-auto relative z-10">

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
                                
                                if (response.ok) {
                                    const newTask = await response.json();
                                    setTasks((prev: any) => [...prev, newTask]);
                                    (e.target as HTMLFormElement).reset();
                                }
                            }}
                            className="mb-10 p-4 border-4 border-black bg-white dark:bg-zinc-900 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]"
                        >
                            <input 
                                name="title"
                                type="text" 
                                placeholder="NEW TASK TITLE" 
                                required
                                className="w-full p-2 mb-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase placeholder-gray-500 focus:outline-none focus:ring-0 dark:border-white dark:bg-black dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] placeholder-zinc-400 dark:text-white"

                            />
                            <input
                                name="dueDate"
                                type="date"
                                placeholder="DUE DATE"
                                required
                                className="w-full p-2 mb-3 border-4 border-black bg-white text-black font-permanent text-xl uppercase placeholder-gray-500 focus:outline-none focus:ring-0 dark:border-white dark:bg-black dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] placeholder-zinc-400 dark:text-white"
                            />
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
                                className="w-full p-2 mb-3 border-4 border-black dark:bg-black bg-white text-black font-permanent text-xl uppercase placeholder-gray-500 focus:outline-none focus:ring-0 dark:border-white  dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)] placeholder-zinc-400 dark:text-white"
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
                                <div key={task._id} className="relative mb-10 p-4 border-4 border-black bg-white dark:bg-zinc-900 shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]">
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
                                            <h3 className="w-full p-2 mb-3 text-2xl font-permanent text-yellow-400 tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">
                                                <span className="text-teal dark:text-orange-400">TITLE:</span> {task.title}
                                            </h3>
                                            <p className="w-full p-2 mb-3 text-xl font-permanent text-yellow-400 tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">
                                                <span className="text-teal dark:text-orange-400">DUE DATE:</span> {new Date(task.dueDate).toLocaleDateString()}
                                            </p>
                                            <p className="w-full p-2 mb-3 text-xl font-permanent text-yellow-400 tracking-tight dark:bg-zinc-900 dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">
                                                <span className="text-teal dark:text-orange-400">DESCRIPTION:</span> {task.description}
                                            </p>
                                            <p className="w-full p-2 mb-3 text-xl font-permanent text-yellow-400 tracking-tight dark:bg-zinc-900 dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">
                                                <span className="text-teal dark:text-orange-400">STATUS:</span>                                             
                                                <select
                                                value={task.status}
                                                name="status"
                                                onChange={(e) => {
                                                    updateTask(task._id, { ...task, status: e.target.value });
                                                }}
                                                className="w-full p-4 border-2 border-black dark:border-white mb-3 text-xl font-permanent bg-transparent text-yellow-400 tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]"
                                                >
                                                <option value="Not Started" className ="text-xl font-permanent text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">Not Started</option>
                                                <option value="In Progress" className ="text-xl font-permanent text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">In Progress</option>
                                                <option value="Completed" className ="text-xl font-permanent text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">Completed</option>
                                                </select>
                                            </p>
                                        </>
                                    )}

                                    {editingTaskId === task._id && (
                                        <>
                                        <p>
                                            <span className="text-teal dark:text-orange-400 font-permanent">TITLE:</span>
                                            <input
                                                type="text"
                                                value={task.title}
                                                name="title"
                                                
                                                className="w-full p-4 mb-3 border-2 border-black dark:border-white text-xl font-permanent bg-transparent text-yellow-400 tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]"
                                            />
                                            </p>
                                            <p>
                                            <span className="text-teal dark:text-orange-400 font-permanent">DESCRIPTION:</span>
                                            <textarea
                                                value={task.description}
                                                name="description"
                                                className="w-full p-4 mb-3 border-2 border-black dark:border-white text-xl fit-content font-permanent bg-transparent text-yellow-400 tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]"
                                            />
                                            </p>
                                            <p>
                                            <span className="text-teal dark:text-orange-400 font-permanent">DUE DATE:</span>
                                            <input
                                                type="date" 
                                                value={new Date(task.dueDate).toISOString().split('T')[0]}
                                                name="dueDate"
                                                className="w-full p-4 mb-3 border-2 border-black icon-white dark:border-white text-xl font-permanent bg-transparent text-yellow-400 tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]"
                                            />
                                            </p>
                                            <p>
                                            <span className="text-teal dark:text-orange-400 font-permanent">STATUS:</span>
                                            <select
                                                value={task.status}
                                                name="status"
                                                className="w-full p-2 mb-3 border-2 border-black dark:border-white text-xl font-permanent bg-transparent text-yellow-400 tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]"
                                            >
                                                <option value="Not Started" className ="text-xl font-permanent text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">Not Started</option>
                                                <option value="In Progress" className ="text-xl font-permanent text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">In Progress</option>
                                                <option value="Completed" className ="text-xl font-permanent text-yellow-400 dark:bg-black drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight dark:focus:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">Completed</option>
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
                                                className="text-xl font-permanent text-yellow-400 tracking-tight"
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
                                            className="text-xl font-permanent text-yellow-400 tracking-tight"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            className="w-full ml-2 mr-2 p-3 border-4 border-black bg-yellow-400 text-black font-permanent text-xl uppercase hover:bg-yellow-500 transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
                                        >
                                            Save
                                        </button>
                                        &nbsp;
                                        </>
                                    )}
                                    <button
                                        onClick={() => deleteTask(task._id)}
                                        className="text-xl font-permanent text-yellow-400 tracking-tight "
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
                        <h2 className="text-4xl md:text-5xl font-permanent mb-6 text-yellow-400 uppercase relative w-fit">
                            <span className="drop-shadow-[4px_4px_0px_rgba(0,0,0,1)]">Profile</span>
                        </h2>
                        <div className="text-xl md:text-2xl font-permanent leading-tight text-yellow-400 drop-shadow-[3px_3px_0px_rgba(0,0,0,1)] tracking-tight space-y-3">
                            <p><span className="text-teal dark:text-orange-400">USER NUMBER:</span> {user.userNumber || 'N/A'}</p>
                            <p><span className="text-teal dark:text-orange-400">EMAIL:</span> {user.email?.toUpperCase() || 'N/A'}</p>
                            <p><span className="text-teal dark:text-orange-400">TYPE:</span> {user.type?.toUpperCase() || 'N/A'}</p>
                            <p><span className="text-teal dark:text-orange-400">PHONE:</span> {user.phone?.toUpperCase() || 'N/A'}</p>
                            <p><span className="text-teal dark:text-orange-400">ROLE:</span> {user.role?.toUpperCase() || 'N/A'}</p>
                            <p><span className="text-teal dark:text-orange-400">COMPANY:</span> {user.company?.toUpperCase() || 'N/A'}</p>
                            <p><span className="text-teal dark:text-orange-400">INDUSTRY:</span> {user.industry?.toUpperCase() || 'N/A'}</p>
                            <p><span className="text-teal dark:text-orange-400">WEBSITE:</span> {user.website?.toUpperCase() || 'N/A'}</p>
                        </div>
                    </div>
                </section>

                <footer className="mt-16 text-center">
                    <div className="inline-block border-8 border-black dark:border-black px-12 py-8 bg-orange-500 shadow-[12px_12px_0px_0px_rgba(250,204,21,1)]">
                        <p className="text-3xl md:text-4xl font-permanent text-black uppercase leading-tight">
                            Authenticated.<br/>Secure.<br/>Ready to Build.
                        </p>
                    </div>
                </footer>
            </div>

        </div>
    );
}
