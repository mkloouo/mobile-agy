import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { formatShellMessage } from '../src/bot/shell';

describe('shell execution & formatting', () => {
    describe('formatShellMessage', () => {
        it('formats output in pre/code block with escaped command', () => {
            const formatted = formatShellMessage('echo "hi"', 'hi', '');
            expect(formatted).toBe('⚡ <b>$ echo "hi"</b>\n<pre><code>hi</code></pre>');
        });

        it('defaults empty output to (no output)', () => {
            const formatted = formatShellMessage('touch file.txt', '', '');
            expect(formatted).toContain('(no output)');
        });

        it('includes status tag when exit code is non-zero', () => {
            const formatted = formatShellMessage('bad_cmd', 'command not found', ' [exit 127]');
            expect(formatted).toContain('bad_cmd</b> [exit 127]');
        });

        it('truncates very large outputs to prevent Telegram limit errors', () => {
            const largeOutput = 'x'.repeat(15000);
            const formatted = formatShellMessage('cat big.log', largeOutput, '');
            expect(formatted).toContain('... [output truncated, 15000 chars total] ...');
            expect(formatted.length).toBeLessThan(12000);
        });
    });

    describe('child_process spawn execution', () => {
        it('executes fast command (echo) and captures stdout without hanging', async () => {
            let output = '';
            let exitCode: number | null = null;

            await new Promise<void>((resolve, reject) => {
                const child = spawn('/bin/zsh', ['-c', 'echo "hello vitest"'], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                child.stdout.on('data', (d) => {
                    output += d.toString('utf-8');
                });

                child.on('close', (code) => {
                    exitCode = code;
                    resolve();
                });

                child.on('error', reject);
            });

            expect(output.trim()).toBe('hello vitest');
            expect(exitCode).toBe(0);
        });

        it('captures non-zero exit code on failure', async () => {
            let exitCode: number | null = null;

            await new Promise<void>((resolve, reject) => {
                const child = spawn('/bin/zsh', ['-c', 'exit 7'], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                child.on('close', (code) => {
                    exitCode = code;
                    resolve();
                });

                child.on('error', reject);
            });

            expect(exitCode).toBe(7);
        });
    });
});
