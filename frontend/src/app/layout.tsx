import type { Metadata } from "next";
import "./globals.css";
import Navigation from "@/components/Navigation";
import PageTransitionProvider from "@/components/PageTransitionProvider";
import PersistentBackground from "@/components/PersistentBackground";

export const metadata: Metadata = {
  title: "Geoff the Dev's Personal Web App",
  description: "This is Geoff's Personal Web App. Built with Next.js 13, TypeScript, and Tailwind CSS. The backend is built with Node.js and Express. The database is built with MongoDB. The deployment is built with Vercel. ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased min-h-screen bg-white dark:bg-black text-black dark:text-white overflow-x-hidden">
        <PersistentBackground />
        <Navigation />
        <PageTransitionProvider>
          {children}
        </PageTransitionProvider>
      </body>
    </html>
  );
}
