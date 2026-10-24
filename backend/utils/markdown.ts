import { Marked, marked, type TokenizerAndRendererExtension } from 'marked';

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

const escAttr = (v: string) => v
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Maps an Obsidian wikilink target to an href, or null when the note doesn't exist. */
export type WikiLinkHref = (target: string) => string | null;

/**
 * Obsidian `[[target]]`, `[[target|label]]` and `[[target#heading]]` links
 * (and `![[embeds]]`, rendered as plain links). An inline extension rather
 * than a regex over the source, so wikilinks inside code stay literal.
 */
function wikiLinkExtension(href: WikiLinkHref): TokenizerAndRendererExtension {
    return {
        name: 'wikilink',
        level: 'inline',
        start: (src) => src.match(/!?\[\[/)?.index,
        tokenizer(src) {
            const m = src.match(/^!?\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/);
            if (!m) return undefined;
            return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[2] ?? m[1]).trim() };
        },
        renderer(token) {
            const url = href(token.target);
            const label = escAttr(token.label);
            return url
                ? `<a class="wikilink" href="${escAttr(url)}">${label}</a>`
                : `<span class="wikilink wikilink-missing" title="Not in the vault">${label}</span>`;
        },
    };
}

export function renderMarkdown(md: string, opts: { wikiLinkHref?: WikiLinkHref } = {}): string {
    if (!md) return '';
    const parser = opts.wikiLinkHref
        ? new Marked({ gfm: true, breaks: true }, { extensions: [wikiLinkExtension(opts.wikiLinkHref)] })
        : marked;
    const html = parser.parse(md, { async: false }) as string;
    return stripDangerous(html);
}
