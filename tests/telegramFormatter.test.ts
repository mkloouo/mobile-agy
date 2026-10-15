import { describe, it, expect } from 'vitest';
import {
    escapeHtml,
    decodeHtmlEntities,
    stripAnsi,
    balanceHtmlTags,
    splitTelegramHtml,
    formatForTelegram,
    formatHumanDate,
    formatElapsedTime,
    cleanModelResponse,
    sanitizeTelegramHtml,
} from '../src/utils/telegramFormatter';
import { formatDuration } from '../src/utils/dateFormatter';

describe('telegramFormatter', () => {
    describe('escapeHtml and decodeHtmlEntities', () => {
        it('escapes &, <, >, ", and \'', () => {
            expect(escapeHtml('Hello & <world> "test" \'it\'')).toBe('Hello &amp; &lt;world&gt; &quot;test&quot; &#39;it&#39;');
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

        it('preserves indentation in subsequent chunks without aggressive trimming', () => {
            const longIndented = '<pre><code>\n    function test() {\n        return 42;\n    }\n</code></pre>';
            const chunks = splitTelegramHtml(longIndented, 40);
            expect(chunks.length).toBeGreaterThan(1);
            // Verify that indentation in second chunk wasn't stripped away
            const fullRecombined = chunks.join('');
            expect(fullRecombined).toContain('        return 42;');
        });

        it('does not split across an HTML entity boundary', () => {
            // Pad so that chunk boundary lands near &quot;
            const prefix = 'a'.repeat(95);
            const text = `${prefix}&quot;rest of string`;
            const chunks = splitTelegramHtml(text, 100);
            for (const chunk of chunks) {
                expect(chunk).not.toMatch(/&[a-z0-9#]*$/i); // chunk should not end with broken entity
                expect(chunk).not.toMatch(/^[a-z0-9#]*;/i); // chunk should not start with broken entity
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

    describe('formatElapsedTime', () => {
        it('formats elapsed seconds as Xh XXm XXs', () => {
            expect(formatElapsedTime(0)).toBe('0h 00m 00s');
            expect(formatElapsedTime(10)).toBe('0h 00m 10s');
            expect(formatElapsedTime(80)).toBe('0h 01m 20s');
            expect(formatElapsedTime(3665)).toBe('1h 01m 05s');
        });
    });

    describe('sanitizeTelegramHtml', () => {
        it('strips nested tags from inside code and pre blocks', () => {
            const invalid = '<code><b>bold</b> inside code</i></code>';
            const sanitized = sanitizeTelegramHtml(invalid);
            expect(sanitized).toBe('<code>bold inside code</code>');
        });

        it('preserves code tags with language class inside pre', () => {
            const pre = '<pre><code class="language-typescript">const x = 1;</code></pre>';
            expect(sanitizeTelegramHtml(pre)).toBe(pre);
        });

        it('protects code blocks in markdown from internal bold/italic conversion', () => {
            const md = 'Call `__init__` and `*ptr` to set values.';
            const formatted = formatForTelegram(md);
            expect(formatted).toContain('<code>__init__</code>');
            expect(formatted).toContain('<code>*ptr</code>');
            expect(formatted).not.toContain('<code><b>init</b></code>');
        });

        it('prevents double bold wrapping when markdown header has bold syntax', () => {
            const md = '# **Important Notice**';
            const formatted = formatForTelegram(md);
            expect(formatted).toBe('<b>Important Notice</b>');
            expect(formatted).not.toContain('<b><b>');
        });

        it('strips code tags inside anchor links', () => {
            const html = '<a href="https://example.com"><code>click here</code></a>';
            const sanitized = sanitizeTelegramHtml(html);
            expect(sanitized).toBe('<a href="https://example.com">click here</a>');
        });

        it('unrolls improperly nested tags for strict LIFO compliance', () => {
            const html = '<b><i>text</b>';
            const { closedHtml } = balanceHtmlTags(html);
            expect(closedHtml).toBe('<b><i>text</i></b>');
        });

        it('preserves self-closing void tags without appending closing tag', () => {
            const html = 'Line 1<br/>Line 2';
            const { closedHtml } = balanceHtmlTags(html);
            expect(closedHtml).toBe('Line 1<br/>Line 2');
        });

        it('preserves duplicate lines inside code blocks in cleanModelResponse', () => {
            const md = [
                '```ts',
                'const x = 1;',
                'const x = 1;',
                '```',
            ].join('\n');
            const cleaned = cleanModelResponse(md);
            expect(cleaned).toBe(md);
        });
    });

    describe('formatDuration', () => {
        it('formats seconds without decimals', () => {
            expect(formatDuration(45)).toBe('45s');
            expect(formatDuration(45.151737)).toBe('45s');
        });

        it('formats minutes and seconds cleanly without floating point leftovers', () => {
            expect(formatDuration(75)).toBe('1m 15s');
            expect(formatDuration(4315.151737)).toBe('1h 11m 55s');
        });

        it('formats hours, minutes and seconds cleanly', () => {
            expect(formatDuration(3665)).toBe('1h 01m 05s');
            expect(formatDuration(5716.14406)).toBe('1h 35m 16s');
        });
    });
});
