import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

// Strip obvious script/iframe/event-handler vectors. Content comes from the
// user's own Obsidian vault and from Claude responses (admin-gated), so the
// threat surface is small, but rendered HTML still warrants a basic guard.
function stripDangerous(html: string): string {
    return html
        .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
        .replace(/<\s*iframe\b[^>]*>[\s\S]*?<\s*\/\s*iframe\s*>/gi, '')
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
        .replace(/javascript\s*:/gi, '');
}

export function renderMarkdown(md: string): string {
    if (!md) return '';
    const html = marked.parse(md, { async: false }) as string;
    return stripDangerous(html);
}
