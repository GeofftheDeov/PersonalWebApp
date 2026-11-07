import type { Metadata } from 'next';
// The design system's stylesheets come in through this one, in order.
import './globals.css';
import { fontVariables } from './fonts';
import Floor from '@/components/design-system/Floor';
import TopBarMount from '@/components/TopBarMount';

export const metadata: Metadata = {
  title: 'Hearthside',
  description: 'Where the party gathers: your campaigns, their sessions and the Notice Board.',
};

/**
 * Every Hearthside page: the floor behind it and the GeofftheDeov top bar
 * across the top. Most pages then sit in the shell (the `(shell)` route
 * group); the signing-in and invite pages sit straight on the floor.
 *
 * The design system's stylesheets come in here (through globals.css) and nowhere else, and
 * apply under the `hs-app` body class: only Hearthside loads them.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`hs-app ${fontVariables}`}>
        <Floor />
        <TopBarMount />
        {children}
      </body>
    </html>
  );
}
