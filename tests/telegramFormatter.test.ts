import { describe, it, expect } from 'vitest';
import {
    escapeHtml,
    decodeHtmlEntities,
    stripAnsi,
    balanceHtmlTags,
    splitTelegramHtml,
    formatForTelegram,
    formatHumanDate,
    cleanModelResponse,
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

    describe('formatHumanDate', () => {
        it('formats UTC ISO timestamp into human-readable local time with ordinal suffixes', () => {
            const date = new Date(2026, 7, 13, 22, 40); // 13 Aug 2026 22:40 local
            const formatted = formatHumanDate(date);
            expect(formatted).toBe('Thu, 13th of Aug, 2026 22:40');
        });

        it('formats 1st, 2nd, 3rd, 21st, 22nd, 23rd, 31st correctly', () => {
            expect(formatHumanDate(new Date(2026, 0, 1, 10, 0))).toContain('1st of Jan, 2026');
            expect(formatHumanDate(new Date(2026, 0, 2, 10, 0))).toContain('2nd of Jan, 2026');
            expect(formatHumanDate(new Date(2026, 0, 3, 10, 0))).toContain('3rd of Jan, 2026');
            expect(formatHumanDate(new Date(2026, 0, 21, 10, 0))).toContain('21st of Jan, 2026');
            expect(formatHumanDate(new Date(2026, 0, 22, 10, 0))).toContain('22nd of Jan, 2026');
            expect(formatHumanDate(new Date(2026, 0, 23, 10, 0))).toContain('23rd of Jan, 2026');
            expect(formatHumanDate(new Date(2026, 0, 31, 10, 0))).toContain('31st of Jan, 2026');
        });

        it('parses SQLite UTC string and returns non-empty formatted string', () => {
            const result = formatHumanDate('2026-10-15 13:38:58');
            expect(result).toContain('of Oct, 2026');
            expect(result).toMatch(/[0-9]{1,2}:[0-9]{2}$/);
        });

        it('parses quota CEST string into human-readable local time', () => {
            const result = formatHumanDate('2026-10-21 23:43 CEST');
            expect(result).toContain('of Oct, 2026');
            expect(result).toContain('21st');
        });
    });

    describe('cleanModelResponse', () => {
        it('collapses consecutive duplicate lines and strips intermediate wait chatter', () => {
            const messy = [
                'I have started the build in tmyway-app.',
                'Waiting for Gradle build to complete.',
                'Waiting for Gradle build to complete.',
                'Running test suite in expo-release.',
                'Waiting for tests to finish.',
                'Waiting for tests to finish.',
                'Waiting for tests to finish.',
                'What happened in release-problem.txt',
                '1. The compiler warnings are standard Kotlin deprecations.',
            ].join('\n');

            const cleaned = cleanModelResponse(messy);
            expect(cleaned).not.toContain('Waiting for tests to finish.');
            expect(cleaned).not.toContain('Waiting for Gradle build to complete.');
            expect(cleaned).toContain('I have started the build in tmyway-app.');
            expect(cleaned).toContain('What happened in release-problem.txt');
            expect(cleaned).toContain('1. The compiler warnings are standard Kotlin deprecations.');
        });
    });
});
