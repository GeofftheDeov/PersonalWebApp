"use client";
import React from 'react';
import { SiGithub, SiFacebook, SiX } from '@icons-pack/react-simple-icons';
import { Linkedin, Cloud } from 'lucide-react';

interface FooterProps {
  children?: React.ReactNode;
  className?: string;
}

export default function Footer({ 
  children, 
  className = "" 
}: FooterProps) {
  return (
    <footer className={`relative z-10 mt-auto w-full flex flex-col items-center justify-center text-center ${className}`}>
      {children}
      <div className="w-full flex flex-col items-center justify-center py-8 border-t-4 border-black bg-white dark:border-white dark:bg-black">
        <FooterContent />
      </div>
    </footer>
  );
}

function FooterContent() {
  return (
    <>
      <div className="flex flex-wrap justify-center gap-8 text-xl font-permanent uppercase tracking-wider mb-6">
        <a href="https://github.com/GeoffTheDeov" target="_blank" rel="noopener noreferrer" aria-label="GitHub" className="group relative inline-flex items-center justify-center border-2 border-transparent hover:border-black dark:hover:border-white p-3 hover:bg-teal-600 hover:text-white dark:hover:text-black transition-all">
          <SiGithub className="w-8 h-8" />
        </a>
        <a href="https://facebook.com/GeoffreyMurray01" target="_blank" rel="noopener noreferrer" aria-label="Facebook" className="group relative inline-flex items-center justify-center border-2 border-transparent hover:border-black dark:hover:border-white p-3 hover:bg-orange-500 hover:text-black transition-all">
          <SiFacebook className="w-8 h-8" />
        </a>
        <a href="https://x.com/GeoffTheDeov" target="_blank" rel="noopener noreferrer" aria-label="Twitter" className="group relative inline-flex items-center justify-center border-2 border-transparent hover:border-black dark:hover:border-white p-3 hover:bg-purple-600 hover:text-white dark:hover:text-black transition-all">
          <SiX className="w-8 h-8" />
        </a>
        <a href="https://www.linkedin.com/in/geoffrey-murray-771316107/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn" className="group relative inline-flex items-center justify-center border-2 border-transparent hover:border-black dark:hover:border-white p-3 hover:bg-[#0077b5] hover:text-white transition-all">
          <Linkedin className="w-8 h-8" />
        </a>
        <a href="https://www.salesforce.com/trailblazer/geoffreym" target="_blank" rel="noopener noreferrer" aria-label="Salesforce" className="group relative inline-flex items-center justify-center border-2 border-transparent hover:border-black dark:hover:border-white p-3 hover:bg-[#00a1e0] hover:text-white transition-all">
          <Cloud className="w-8 h-8" />
        </a>
      </div>
      <p className="text-xl font-permanent uppercase tracking-wider text-zinc-500">
        © 2026 Geoff The Dev. All Rights Reserved.
      </p>
    </>
  );
}
