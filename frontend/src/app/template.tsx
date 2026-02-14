"use client";

import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { useEffect, useMemo } from "react";

const routes = ["/", "/about", "/admin", "/dashboard", "/calendar", "/login", "/create-account", "/forgot-password", "/reset-password"];

export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  const direction = useMemo(() => {
    if (typeof window === "undefined") return 0;
    const currentIndex = routes.indexOf(pathname);
    const prevIndexStr = sessionStorage.getItem("prevRouteIndex");
    const prevIndex = prevIndexStr ? parseInt(prevIndexStr, 10) : 0;

    if (currentIndex > prevIndex) return 1;
    if (currentIndex < prevIndex) return -1;
    return 0;
  }, [pathname]);

  useEffect(() => {
    const currentIndex = routes.indexOf(pathname);
    sessionStorage.setItem("prevRouteIndex", currentIndex.toString());
    console.log(`[TRANSITION] Navigated to ${pathname}, direction: ${direction}`);
  }, [pathname, direction]);

  const variants = {
    initial: (dir: number) => ({
      x: dir === 1 ? "100%" : dir === -1 ? "-100%" : 0,
      opacity: 0,
    }),
    animate: {
      x: 0,
      opacity: 1,
    },
    exit: (dir: number) => ({
      x: dir === 1 ? "-100%" : dir === -1 ? "100%" : 0,
      opacity: 0,
    }),
  };

  return (
    <motion.div
      key={pathname}
      custom={direction}
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ 
        x: { type: "spring", stiffness: 200, damping: 25 },
        opacity: { duration: 0.3 }
      }}
      className="w-full flex-grow"
    >
      {children}
    </motion.div>
  );
}
