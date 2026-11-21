import { Alegreya_Sans, Alegreya_Sans_SC, IM_Fell_English, IM_Fell_English_SC, Inter, Permanent_Marker } from 'next/font/google';

/**
 * The fonts, self-hosted: next/font fetches the files when the app builds and
 * serves them from Hearthside itself, so a page asks no font host for them.
 * Each sets a CSS variable on the body; globals.css puts them first in the
 * design system's --font-* tokens and in the top bar.
 */

// The design system's faces (its tokens.css names them).
const fell = IM_Fell_English({ weight: '400', style: ['normal', 'italic'], subsets: ['latin'], display: 'swap', variable: '--hs-font-fell' });
const fellSc = IM_Fell_English_SC({ weight: '400', subsets: ['latin'], display: 'swap', variable: '--hs-font-fell-sc' });
const alegreya = Alegreya_Sans({ weight: ['400', '500', '700'], subsets: ['latin'], display: 'swap', variable: '--hs-font-alegreya' });
const alegreyaSc = Alegreya_Sans_SC({ weight: ['500', '700'], subsets: ['latin'], display: 'swap', variable: '--hs-font-alegreya-sc' });

// The top bar's, which keeps the portfolio's look.
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--hs-font-inter' });
const marker = Permanent_Marker({ weight: '400', subsets: ['latin'], display: 'swap', variable: '--hs-font-marker' });

/** The class names that define every font variable, for the body. */
export const fontVariables = [fell, fellSc, alegreya, alegreyaSc, inter, marker].map((f) => f.variable).join(' ');
