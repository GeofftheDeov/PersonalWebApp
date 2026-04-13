"use client";

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import SocialDock from './SocialDock';

export default function Navigation() {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [userType, setUserType] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    // Check if user is logged in
    const checkAuth = () => {
      const token = localStorage.getItem('token');
      const userStr = localStorage.getItem('user');
      
      setIsLoggedIn(!!token);
      setToken(token);

      if (userStr) {
        try {
          const user = JSON.parse(userStr);
          setUserType(user.type || null);
        } catch (e) {
          console.error("Error parsing user from localStorage:", e);
          setUserType(null);
        }
      } else {
        setUserType(null);
      }
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
    setIsMenuOpen(false);
    window.dispatchEvent(new Event('authChange'));
    router.push('/');
  };

  const navLinks = (mobile = false) => {
    const linkCls = mobile 
      ? "text-3xl font-black tracking-tight text-black dark:text-white uppercase font-permanent"
      : "group relative text-lg font-bold text-black dark:text-white";
    
    const decorationCls = mobile ? "hidden" : "absolute -bottom-1 left-0 h-2 w-0 bg-orange-500 group-hover:w-full transition-all duration-300";

    return (
      <>
        <Link 
          href="/about" 
          onClick={() => setIsMenuOpen(false)}
          className={linkCls}
        >
          <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">ABOUT</span>
          <div className={`${decorationCls} rotate-1`}></div>
        </Link>
        
        {isLoggedIn ? (
          <>
            {userType === 'User' && (
              <a 
                href={`/admin?token=${token}`} 
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setIsMenuOpen(false)}
                className={linkCls}
              >
                <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">ADMIN</span>
                <div className={`${decorationCls} -rotate-1`}></div>
              </a>
            )}
            <Link 
              href="/dashboard" 
              onClick={() => setIsMenuOpen(false)}
              className={linkCls}
            >
              <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">DASHBOARD</span>
              <div className={`${decorationCls} -rotate-1`}></div>
            </Link>
            <Link 
              href="/game-night" 
              onClick={() => setIsMenuOpen(false)}
              className={linkCls}
            >
              <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">GAME NIGHT</span>
              <div className={`${decorationCls} -rotate-1`}></div>
            </Link>
            <Link 
              href="/calendar" 
              onClick={() => setIsMenuOpen(false)}
              className={linkCls}
            >
              <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">CALENDAR</span>
              <div className={`${decorationCls} -rotate-1`}></div>
            </Link>
            {!mobile && <SocialDock />}
            <button
              onClick={handleLogout}
              className={linkCls}
            >
              <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">LOGOUT</span>
              <div className={`${decorationCls} rotate-2`}></div>
            </button>
          </>
        ) : (
          <Link 
            href="/login" 
            onClick={() => setIsMenuOpen(false)}
            className={linkCls}
          >
            <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">LOGIN</span>
            <div className={`${decorationCls} rotate-1`}></div>
          </Link>
        )}
      </>
    );
  };

  return (
    <nav className="sticky top-0 z-50 w-full border-b-4 border-black bg-white dark:bg-black dark:border-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link href="/" onClick={() => setIsMenuOpen(false)} className="text-2xl font-black tracking-tighter text-black dark:text-white hover:skew-x-2 transition-transform">
          GEOFF<span className="text-teal-600">THE</span>DEV
        </Link>
        
        {/* Desktop Menu */}
        <div className="hidden md:flex gap-8 items-center">
          {navLinks()}
        </div>

        {/* Hamburger Button */}
        <button 
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="md:hidden p-2 text-black dark:text-white transition-transform active:scale-95"
          aria-label="Toggle menu"
        >
          {isMenuOpen ? <X className="w-8 h-8" /> : <Menu className="w-8 h-8" />}
        </button>
      </div>

      {/* Mobile Menu Overlay */}
      {isMenuOpen && (
        <div className="fixed inset-0 top-[76px] z-40 bg-white dark:bg-black p-8 md:hidden flex flex-col items-center justify-center gap-8 overflow-y-auto border-t-4 border-black dark:border-white">
          {navLinks(true)}
          <div className="mt-8">
            <SocialDock />
          </div>
        </div>
      )}
    </nav>
  );
}
