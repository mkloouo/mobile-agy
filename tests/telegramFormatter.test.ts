import { describe, it, expect } from 'vitest';
import {
    escapeHtml,
    decodeHtmlEntities,
    stripAnsi,
    balanceHtmlTags,
    splitTelegramHtml,
    formatForTelegram,
} from '../src/utils/telegramFormatter';

describe('telegramFormatter', () => {
    describe('escapeHtml and decodeHtmlEntities', () => {
        it('escapes &, <, and >', () => {
            expect(escapeHtml('Hello & <world>')).toBe('Hello &amp; &lt;world&gt;');
        });

        it('decodes &amp;, &lt;, &gt;, &quot;, &#39;', () => {
            expect(decodeHtmlEntities('Hello &amp; &lt;world&gt; &quot;test&#39;')).toBe('Hello & <world> "test\'');
        });
    });

    describe('stripAnsi', () => {
        it('removes ANSI color codes', () => {
            const colored = '\u001b[31mRed Text\u001b[0m \u001b[1mBold\u001b[22m';
            expect(stripAnsi(colored)).toBe('Red Text Bold');
        });
    });

    describe('balanceHtmlTags', () => {
        it('closes unclosed tags', () => {
            const html = '<b>Bold text <i>italic';
            const { closedHtml, openTags } = balanceHtmlTags(html);
            expect(closedHtml).toBe('<b>Bold text <i>italic</i></b>');
            expect(openTags).toEqual(['<b>', '<i>']);
        });

        it('does not touch balanced tags', () => {
            const html = '<b>Bold text</b> <i>italic</i>';
            const { closedHtml, openTags } = balanceHtmlTags(html);
            expect(closedHtml).toBe(html);
            expect(openTags).toEqual([]);
        });
    });

    describe('splitTelegramHtml', () => {
        it('returns short messages as a single chunk', () => {
            const text = 'Hello world';
            const chunks = splitTelegramHtml(text, 100);
            expect(chunks).toEqual(['Hello world']);
        });

        it('splits long messages without breaking HTML tag balancing', () => {
            const text = '<b>' + 'a'.repeat(200) + '</b>';
            const chunks = splitTelegramHtml(text, 120);
            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                // Each chunk should be balanced
                const { openTags } = balanceHtmlTags(chunk);
                expect(openTags.length).toBe(0);
            }
        });
    });

    describe('formatForTelegram', () => {
        it('converts markdown code blocks to HTML pre/code tags', () => {
            const md = '```ts\nconst x = 1;\n```';
            const formatted = formatForTelegram(md);
            expect(formatted).toContain('<pre><code class="language-ts">');
            expect(formatted).toContain('const x = 1;');
            expect(formatted).toContain('</code></pre>');
        });

        it('converts inline backticks to code tags', () => {
            const md = 'Use `console.log` here';
            const formatted = formatForTelegram(md);
            expect(formatted).toBe('Use <code>console.log</code> here');
        });

        it('converts bold and italic markdown', () => {
            const md = '**bold** and *italic*';
            const formatted = formatForTelegram(md);
            expect(formatted).toContain('<b>bold</b>');
            expect(formatted).toContain('<i>italic</i>');
        });

        it('converts blockquotes and GitHub-style callouts with code blocks', () => {
            const md = '> [!NOTE]\n> Changes compiled.\n> ```bash\n> pm2 restart\n> ```';
            const formatted = formatForTelegram(md);
            expect(formatted).toContain('<blockquote>');
            expect(formatted).toContain('💡 <b>Note:</b>');
            expect(formatted).toContain('Changes compiled.');
            expect(formatted).toContain('<pre><code class="language-bash">');
            expect(formatted).toContain('pm2 restart');
            expect(formatted).toContain('</blockquote>');
        });
    });
});
