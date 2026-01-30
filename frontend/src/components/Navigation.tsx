"use client";

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function Navigation() {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // Check if user is logged in
    const checkAuth = () => {
      const token = localStorage.getItem('token');
      setIsLoggedIn(!!token);
      setToken(token);
    };

    checkAuth();

    // Listen for storage changes (e.g., when user logs in/out in another tab)
    window.addEventListener('storage', checkAuth);
    
    // Custom event for same-tab login/logout
    window.addEventListener('authChange', checkAuth);

    return () => {
      window.removeEventListener('storage', checkAuth);
      window.removeEventListener('authChange', checkAuth);
    };
  }, []);

  const handleLogout = () => {
    localStorage.clear();
    setIsLoggedIn(false);
    window.dispatchEvent(new Event('authChange'));
    router.push('/');
  };

  return (
    <nav className="sticky top-0 z-50 w-full border-b-4 border-black bg-white dark:bg-black dark:border-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-2xl font-black tracking-tighter text-black dark:text-white hover:skew-x-2 transition-transform">
          GEOFF<span className="text-teal-600">THE</span>DEV
        </Link>
        <div className="flex gap-8 items-center">
         
          <Link 
            href="/about" 
            className="group relative text-lg font-bold text-black dark:text-white"
          >
            <span className="relative z-10 group-hover:text-teal-600 transition-colors">ABOUT</span>
            <div className="absolute -bottom-1 left-0 h-2 w-0 bg-orange-500 group-hover:w-full transition-all duration-300 rotate-1"></div>
          </Link>


          
          {/* Authentication buttons */}
          {isLoggedIn ? (
            <>
              <a 
                href={`http://localhost:5000/admin?token=${token}`} 
                target="_blank"
                rel="noopener noreferrer"
                className="group relative text-lg font-bold text-black dark:text-white"
              >
                <span className="relative z-10 group-hover:text-teal-600 transition-colors">ADMIN</span>
                <div className="absolute -bottom-1 left-0 h-2 w-0 bg-orange-500 group-hover:w-full transition-all duration-300 -rotate-1"></div>
              </a>
              <Link 
                href="/dashboard" 
                className="group relative text-lg font-bold text-black dark:text-white"
              >
                <span className="relative z-10 group-hover:text-teal-600 transition-colors">DASHBOARD</span>
                <div className="absolute -bottom-1 left-0 h-2 w-0 bg-orange-500 group-hover:w-full transition-all duration-300 -rotate-1"></div>
              </Link>
              <button
                onClick={handleLogout}
                className="group relative text-lg font-bold text-black dark:text-white"
              >
                <span className="relative z-10 group-hover:text-teal-600 transition-colors">LOGOUT</span>
                <div className="absolute -bottom-1 left-0 h-2 w-0 bg-orange-500 group-hover:w-full transition-all duration-300 rotate-2"></div>
              </button>
            </>
          ) : (
            <Link 
              href="/login" 
              className="group relative text-lg font-bold text-black dark:text-white"
            >
              <span className="relative z-10 group-hover:text-teal-600 transition-colors">LOGIN</span>
              <div className="absolute -bottom-1 left-0 h-2 w-0 bg-orange-500 group-hover:w-full transition-all duration-300 rotate-1"></div>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
