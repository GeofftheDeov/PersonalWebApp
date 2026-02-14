"use client";

import React, { useMemo } from "react";
import { motion } from "framer-motion";
import { usePathname } from "next/navigation";

const routes = ["/", "/about", "/admin", "/dashboard", "/calendar", "/login", "/create-account", "/forgot-password", "/reset-password"];

export default function PersistentBackground() {
  const pathname = usePathname();
  
  // Calculate the background offset based on the route index
  // We move it 200px per page for a nice parallax effect.
  const backgroundX = useMemo(() => {
    const index = routes.indexOf(pathname);
    return (index === -1 ? 0 : index) * -200;
  }, [pathname]);

  return (
    <div className="fixed inset-0 -z-50 overflow-hidden pointer-events-none">
      {/* Sliding Bricks Layer */}
      <motion.div 
        animate={{ backgroundPositionX: `${backgroundX}px` }}
        transition={{ type: "spring", stiffness: 200, damping: 25 }}
        className="absolute inset-0 bg-bricks"
        style={{ backgroundRepeat: 'repeat' }}
      />

      {/* Persistent Static Overlays */}
      <div className="absolute inset-0 bg-grain mix-blend-overlay opacity-20"></div>

      {/* Fixed Atmospheric Lighting - Gives the 3D feel as content slides past fixed lamps */}
      <div className="absolute -top-40 -left-40 w-[600px] h-[600px] bg-teal-600/20 blur-[120px] rounded-full animate-pulse"></div>
      <div className="absolute top-1/2 -right-60 w-[800px] h-[800px] bg-yellow-400/10 blur-[150px] rounded-full"></div>
      <div className="absolute bottom-[-20%] left-1/4 w-[500px] h-[500px] bg-orange-500/15 blur-[100px] rounded-full animate-pulse" style={{ animationDuration: '10s' }}></div>
    </div>
  );
}
