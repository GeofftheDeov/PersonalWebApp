export interface AdminPageOptions {
    token: string;
    title: string;
    activePage: 'admin' | 'os' | 'db' | 'frontend' | 'cloud-claw' | 'obsidian' | 'briefs' | 'alpaca' | 'paperclip' | 'profile' | 'person-sync';
    content: string;
    extraStyles?: string;
    /**
     * Lay the page out at the device's width (a viewport meta), so its phone
     * breakpoints apply on a phone, and below 800px let the nav links scroll
     * sideways inside the one 60px row (spec #135 W5's rule). Off by default:
     * without it a phone renders the page at ~980px and zooms out, which is
     * what the other admin pages are still built for until W5 opts them in.
     */
    deviceWidth?: boolean;
}

const DEVICE_WIDTH_STYLES = `
    @media (max-width: 800px) {
        .top-nav { padding: 0 1rem; gap: 1rem; }
        .nav-brand { flex-shrink: 0; font-size: 1.1rem; }
        .nav-brand .suffix { display: none; }
        .nav-links { overflow-x: auto; gap: 1.25rem; min-width: 0; scrollbar-width: none; }
        .nav-link { white-space: nowrap; font-size: 0.8rem; }
    }`;

export const renderPage = ({ token, title, activePage, content, extraStyles = '', deviceWidth = false }: AdminPageOptions): string => {
    return `
        <html>
            <head>
                <title>${title}</title>
                ${deviceWidth ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ''}
                <style>
                    * {
                        user-select: none !important;
                        -webkit-user-select: none !important;
                        -moz-user-select: none !important;
                        -ms-user-select: none !important;
                        caret-color: transparent !important;
                        cursor: default;
                    }

                    input, textarea, [contenteditable="true"] {
                        user-select: text !important;
                        -webkit-user-select: text !important;
                        -moz-user-select: text !important;
                        -ms-user-select: text !important;
                        caret-color: auto !important;
                        cursor: text !important;
                    }

                    a, button, .btn, .nav-link, th, .sidebar li a {
                        cursor: pointer !important;
                    }

                    body { 
                        font-family: 'Courier New', monospace; 
                        background-color: #1a1a1a; 
                        color: #e0e0e0; 
                        margin: 0;
                        padding: 0;
                        height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        /* Caution tape style background foundation */
                        background-image: repeating-linear-gradient(45deg, #1f1f1f 0, #1f1f1f 10px, #1a1a1a 10px, #1a1a1a 20px);
                        background-size: 28px 28px;
                        padding-top: 60px; /* Space for top nav */
                        box-sizing: border-box;
                    }
                    /* Vignette overlay */
                    body::before {
                        content: "";
                        position: fixed;
                        top: 0; left: 0; width: 100%; height: 100%;
                        background: radial-gradient(circle, transparent 40%, rgba(0,0,0,0.8) 100%);
                        pointer-events: none;
                        z-index: 90;
                    }
                    
                    /* Top Navigation */
                    .top-nav {
                        position: fixed;
                        top: 0; left: 0; right: 0;
                        height: 60px;
                        background: #000;
                        border-bottom: 2px solid #333;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        padding: 0 2rem;
                        z-index: 1000;
                        box-shadow: 0 5px 20px rgba(0,0,0,0.8);
                    }
                    
                    .nav-brand {
                        font-size: 1.5rem;
                        font-weight: 900;
                        letter-spacing: -1px;
                        color: #fff;
                    }
                    .nav-brand .teal { color: #0d9488; }
                    .nav-brand .suffix { color: #666; font-weight: normal; font-size: 1rem; margin-left: 0.5rem;}
                    
                    .nav-links {
                        display: flex;
                        gap: 2rem;
                    }
                    
                    .nav-link {
                        color: #888;
                        text-decoration: none;
                        font-weight: bold;
                        text-transform: uppercase;
                        letter-spacing: 1px;
                        transition: color 0.2s;
                        font-size: 0.9rem;
                        position: relative;
                        padding: 0.5rem 0;
                    }
                    
                    .nav-link:hover {
                        color: #fff;
                    }
                    
                    .nav-link.active {
                        color: #f97316; /* Orange */
                    }
                    .nav-link.active::after {
                        content: '';
                        position: absolute;
                        bottom: 0; left: 0; width: 100%;
                        height: 2px;
                        background: #f97316;
                    }

                    .session-banner {
                        position: fixed;
                        top: 60px; left: 0; right: 0;
                        z-index: 999;
                        background: #2a1a05;
                        border-bottom: 2px solid #f97316;
                        color: #fbbf24;
                        font-size: 0.8rem;
                        padding: 0.6rem 2rem;
                        display: flex;
                        gap: 1rem;
                        align-items: center;
                        flex-wrap: wrap;
                    }
                    .session-banner[hidden] { display: none; }
                    .session-banner a, .session-banner button {
                        color: #000;
                        background: #f97316;
                        border: none;
                        font-family: inherit;
                        font-weight: bold;
                        font-size: 0.75rem;
                        padding: 0.3rem 0.7rem;
                        text-decoration: none;
                    }
                    ${deviceWidth ? DEVICE_WIDTH_STYLES : ''}

                    /* Insert Extra Styles */
                    ${extraStyles}
                </style>
            </head>
            <body>
                <nav class="top-nav">
                    <div class="nav-brand">
                        GEOFF<span class="teal">THE</span>DEV <span class="suffix">// ADMIN</span>
                    </div>
                    <div class="nav-links">
                        <a href="/admin/os?token=${token}" class="nav-link ${activePage === 'os' ? 'active' : ''}">OS</a>
                        <a href="/admin?token=${token}" class="nav-link ${activePage === 'admin' ? 'active' : ''}">DASHBOARD</a>
                        <a href="/db?token=${token}" class="nav-link ${activePage === 'db' ? 'active' : ''}">THE SHOP</a>
                        <a href="/admin/cloud-claw?token=${token}" class="nav-link ${activePage === 'cloud-claw' ? 'active' : ''}">CLOUD-CLAW</a>
                        <a href="/admin/obsidian?token=${token}" class="nav-link ${activePage === 'obsidian' ? 'active' : ''}">OBSIDIAN</a>
                        <a href="/admin/briefs?token=${token}" class="nav-link ${activePage === 'briefs' ? 'active' : ''}">BRIEFS</a>
                        <a href="/admin/alpaca?token=${token}" class="nav-link ${activePage === 'alpaca' ? 'active' : ''}">ALPACA</a>
                        <a href="/admin/paperclip?token=${token}" class="nav-link ${activePage === 'paperclip' ? 'active' : ''}">PAPERCLIP</a>
                        <a href="/admin/person-sync?token=${token}" class="nav-link ${activePage === 'person-sync' ? 'active' : ''}">PERSON SYNC</a>
                        <a href="/admin/profile?token=${token}" class="nav-link ${activePage === 'profile' ? 'active' : ''}">PROFILE</a>
                        <a href="/" class="nav-link ${activePage === 'frontend' ? 'active' : ''}">BACK TO FRONTEND</a>

                    </div>
                </nav>
                <div id="session-banner" class="session-banner" hidden></div>
                <script>
                // These pages carry the login token in their URL, and a login
                // lasts an hour with no refresh. Without this, a page left open
                // keeps working until its next API call fails with a bare
                // "Unauthorized: Invalid token" (e.g. saving keys on PROFILE).
                (function () {
                    var PAGE_TOKEN = ${JSON.stringify(token)};
                    var WARN_MS = 5 * 60 * 1000;
                    function expiresAt(t) {
                        try {
                            var p = JSON.parse(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
                            return typeof p.exp === 'number' ? p.exp * 1000 : null;
                        } catch (e) { return null; }
                    }
                    // The frontend shares this origin, so a login in another tab lands here.
                    function newerLogin() {
                        var t = null;
                        try { t = localStorage.getItem('token'); } catch (e) { /* storage blocked */ }
                        var exp = t && t !== PAGE_TOKEN ? expiresAt(t) : null;
                        return exp && exp - Date.now() > WARN_MS ? t : null;
                    }
                    function continueWithNewLogin() {
                        var t = newerLogin();
                        if (!t) { render(true); return; }
                        var url = new URL(location.href);
                        url.searchParams.set('token', t);
                        location.replace(url.toString());
                    }
                    var exp = expiresAt(PAGE_TOKEN);
                    var banner = document.getElementById('session-banner');
                    function render(noNewer) {
                        if (!exp) return;
                        var left = exp - Date.now();
                        if (left > WARN_MS) { banner.hidden = true; return; }
                        var when = new Date(exp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                        banner.innerHTML = (left > 0
                                ? '<span>Your login expires at ' + when + '. Anything this page saves after that is refused.</span>'
                                : '<span>Your login expired at ' + when + '. This page can no longer save or load data.</span>')
                            + '<a href="/login" target="_blank" rel="noopener">LOG IN AGAIN &#8599;</a>'
                            + '<button type="button" id="session-continue">CONTINUE WITH NEW LOGIN</button>'
                            + (noNewer ? '<span>No newer login in this browser yet — log in first (the new tab keeps this page as it is).</span>' : '');
                        document.getElementById('session-continue').onclick = continueWithNewLogin;
                        banner.hidden = false;
                    }
                    render(false);
                    setInterval(function () { if (banner.hidden) render(false); }, 30 * 1000);
                    if (exp) setTimeout(function () { render(false); }, Math.max(0, exp - Date.now()) + 1000);
                })();
                </script>
                ${content}
            </body>
        </html>
    `;
};
