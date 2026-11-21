"use client";

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/**
 * Links open in a new tab, without handing the opened page a hold on this one.
 * Images aren't drawn (a message could otherwise load any URL in every
 * reader's browser): they show as a link to the picture instead.
 * Headings are just bold lines, so a message can't add to the page's outline.
 */
const COMPONENTS: Components = {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
    img: ({ src, alt }) => typeof src === 'string' && src
        ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a>
        : <>{alt}</>,
    h1: ({ children }) => <p><strong>{children}</strong></p>,
    h2: ({ children }) => <p><strong>{children}</strong></p>,
    h3: ({ children }) => <p><strong>{children}</strong></p>,
    h4: ({ children }) => <p><strong>{children}</strong></p>,
    h5: ({ children }) => <p><strong>{children}</strong></p>,
    h6: ({ children }) => <p><strong>{children}</strong></p>,
};

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/**
 * A Letters message body (#265), its Markdown drawn as rich text: bold,
 * italics, code, lists, quotes, links, GFM's strikethrough and tables. A single
 * newline stays a line break, as when bodies were drawn pre-wrapped. Raw HTML
 * in a body shows as text (react-markdown's default; never add rehype-raw),
 * and unsafe link URLs (javascript: and the like) are dropped.
 *
 * It draws plain elements in a `div` with `className`: each site styles them
 * from there, the portfolio's Tailwind with `MESSAGE_BODY_TW`, Hearthside
 * under `.hs-msg-body`.
 */
export default function MessageBody({ body, className }: { body: string; className?: string }) {
    return (
        <div className={className}>
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{body}</ReactMarkdown>
        </div>
    );
}

/**
 * The portfolio's look for a message body's Markdown, as Tailwind classes for
 * MessageBody's `className`. Colours come from the bubble's text colour
 * (`currentColor`), so it reads on any bubble, light or dark.
 */
export const MESSAGE_BODY_TW = [
    'text-sm break-words [overflow-wrap:anywhere]',
    '[&>*+*]:mt-1',
    '[&_strong]:font-bold [&_em]:italic [&_del]:line-through',
    '[&_a]:underline [&_a]:underline-offset-2',
    '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_ul]:my-1 [&_ol]:my-1',
    '[&_li]:my-0.5',
    '[&_blockquote]:border-l-2 [&_blockquote]:border-current [&_blockquote]:pl-2 [&_blockquote]:my-1 [&_blockquote]:italic [&_blockquote]:opacity-80',
    '[&_code]:font-mono [&_code]:text-xs [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-black/15 dark:[&_code]:bg-white/15',
    '[&_pre]:my-1 [&_pre]:p-2 [&_pre]:rounded [&_pre]:bg-black/15 dark:[&_pre]:bg-white/15 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap',
    '[&_pre_code]:p-0 [&_pre_code]:bg-transparent dark:[&_pre_code]:bg-transparent',
    '[&_table]:my-1 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse',
    '[&_th]:border [&_td]:border [&_th]:border-current [&_td]:border-current [&_th]:px-1.5 [&_td]:px-1.5 [&_th]:font-bold',
    '[&_hr]:my-2 [&_hr]:border-current [&_hr]:opacity-40',
].join(' ');
