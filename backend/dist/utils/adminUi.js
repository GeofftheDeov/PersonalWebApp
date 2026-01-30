export const renderPage = ({ token, title, activePage, content, extraStyles = '' }) => {
    return `
        <html>
            <head>
                <title>${title}</title>
                <style>
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
                        <a href="/admin?token=${token}" class="nav-link ${activePage === 'admin' ? 'active' : ''}">DASHBOARD</a>
                        <a href="/db?token=${token}" class="nav-link ${activePage === 'db' ? 'active' : ''}">THE SHOP</a>
                        <a href="http://localhost:3000" class="nav-link ${activePage === 'frontend' ? 'active' : ''}">BACK TO FRONTEND</a>

                    </div>
                </nav>
                ${content}
            </body>
        </html>
    `;
};
