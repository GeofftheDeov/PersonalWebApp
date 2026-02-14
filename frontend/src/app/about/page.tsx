"use strict";

export default function AboutPage() {
  return (
    <div className="min-h-[calc(100vh-76px)] p-8 md:p-16 overflow-hidden relative">
      <div className="max-w-6xl mx-auto relative z-10">
        <header className="mb-48 relative group">
          <h1 className="text-7xl md:text-9xl font-permanent text-black dark:text-black leading-none tracking-tight uppercase transform -rotate-3 relative">
            <span className="relative inline-block">
              <span className="drop-shadow-[8px_8px_0px_rgba(250,204,21,1)]">ABOUT</span>
            </span>
            <span className="text-yellow-400 block ml-4 md:ml-12 translate-y-[-20px] relative w-fit">
              <span className="drop-shadow-[8px_8px_0px_rgba(0,0,0,1)]">THE SITE</span>
            </span>
          </h1>
          
          <div className="relative mt-8 h-20 w-full">
            <svg className="absolute inset-0 w-full h-full text-orange-500 fill-current drop-shadow-[15px_15px_0px_rgba(13,148,136,1)] overflow-visible" preserveAspectRatio="none" viewBox="0 0 1000 60">
              <path 
                d="M0,30 Q0,20 20,18 C83,10 167,10 250,20 C333,30 417,30 500,20 C583,10 667,10 750,20 C833,30 917,30 980,18 Q1000,20 1000,30 L1000,30 Q1000,40 980,42 C917,50 833,50 750,40 C667,30 583,30 500,40 C417,50 333,50 250,40 C167,30 83,30 20,42 Q0,40 0,30 Z" 
                stroke="black"
                strokeWidth="5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </header>

        <section className="flex flex-col gap-56 text-left">
          <div className="transform rotate-2 hover:rotate-0 transition-transform duration-500 max-w-5xl relative">
            <h2 className="text-7xl md:text-9xl font-permanent mb-12 text-teal-600 uppercase relative w-fit">
              <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">Purpose</span>
            </h2>
            <p className="text-4xl md:text-6xl font-permanent leading-tight text-teal-600 drop-shadow-[4px_4px_0px_rgba(0,0,0,1)] tracking-tight">
              THIS PLATFORM IS THE CENTRAL HUB FOR ALL MY EXPERIMENTS, BUILDS, AND DIGITAL ADVENTURES. 
              IT'S WHERE CODE MEETS CREATIVITY, SERVING AS A LIVING PORTFOLIO OF WHAT I'M CAPABLE OF.
            </p>
          </div>

          <div className="transform -rotate-2 hover:rotate-0 transition-transform duration-500 max-w-5xl self-end text-right relative">
            <h2 className="text-7xl md:text-9xl font-permanent mb-12 text-yellow-400 uppercase relative w-fit ml-auto">
              <span className="drop-shadow-[6px_6px_0px_rgba(0,0,0,1)]">Goal</span>
            </h2>
            <p className="text-4xl md:text-6xl font-permanent leading-tight text-yellow-400 drop-shadow-[4px_4px_0px_rgba(0,0,0,1)] tracking-tight">
              TO PROVIDE SEAMLESS ACCESS TO MY PERSONAL PROJECTS, SHOWCASING TECHNOLOGY STACKS 
              FROM FRONTEND TO BACKEND, AND EVERYTHING IN BETWEEN.
            </p>
          </div>
        </section>

        <footer className="mt-72 mb-20 text-center">
          <div className="inline-block border-[12px] border-black dark:border-black px-20 py-12 bg-orange-500 transform skew-x-12 hover:skew-x-0 transition-transform shadow-[20px_20px_0px_0px_rgba(250,204,21,1)] rounded-3xl">
            <p className="text-5xl md:text-7xl font-permanent text-black uppercase leading-tight">
              Bold Innovations.<br/>Creative Solutions.<br/>Common Sense Implementations.
            </p>
          </div>
        </footer>
      </div>
      
      {/* Additional Decorative Elements */}
    </div>
  );
}
