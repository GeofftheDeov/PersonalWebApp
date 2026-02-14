"use client";

import { AnimatePresence } from "framer-motion";

export default function PageTransitionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence mode="popLayout">
      {children}
    </AnimatePresence>
  );
}
