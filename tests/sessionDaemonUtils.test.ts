import { describe, it, expect } from 'vitest';
import { parseDaemonArgs, buildAgyArgs } from '../src/services/sessionDaemonUtils';

describe('sessionDaemonUtils', () => {
    describe('parseDaemonArgs', () => {
        it('parses valid CLI arguments correctly', () => {
            const argv = [
                '--socket', '/tmp/test.sock',
                '--state', '/tmp/test.json',
                '--session', 'chat1:thread2',
                '--workspace', '/home/user/project',
                '--conv', 'uuid-1234',
                '--autoApprove', 'true',
                '--model', 'gemini-3.8-flash-high',
                '--idle', '600',
            ];

            const parsed = parseDaemonArgs(argv);
            expect(parsed).toEqual({
                socketPath: '/tmp/test.sock',
                statePath: '/tmp/test.json',
                sessionId: 'chat1:thread2',
                workspacePath: '/home/user/project',
                conversationId: 'uuid-1234',
                autoApprove: true,
                model: 'gemini-3.8-flash-high',
                idleTimeoutSeconds: 600,
            });
        });

        it('defaults autoApprove to true if not set to false', () => {
            const argv = [
                '--socket', '/tmp/test.sock',
                '--state', '/tmp/test.json',
                '--session', 'session-1',
                '--workspace', '/workspace',
            ];

            const parsed = parseDaemonArgs(argv);
            expect(parsed.autoApprove).toBe(true);
            expect(parsed.idleTimeoutSeconds).toBe(300);
            expect(parsed.conversationId).toBe('');
            expect(parsed.model).toBeUndefined();
        });

        it('throws an error if required arguments are missing', () => {
            expect(() => parseDaemonArgs(['--socket', '/tmp/test.sock'])).toThrow(/Usage: sessionDaemon/);
        });
    });

    describe('buildAgyArgs', () => {
        it('includes --new-project for fresh sessions without conversationId', () => {
            const args = buildAgyArgs({
                conversationId: '',
                autoApprove: true,
                model: 'gemini-3.8-flash-medium',
            });

            expect(args).toContain('--new-project');
            expect(args).not.toContain('--conversation');
            expect(args).toContain('--dangerously-skip-permissions');
            expect(args).toEqual([
                '--input-format', 'stream-json',
                '--output-format', 'stream-json',
                '--new-project',
                '--dangerously-skip-permissions',
                '--model', 'gemini-3.8-flash-medium',
            ]);
        });

        it('includes --new-project when conversationId is undefined', () => {
            const args = buildAgyArgs({
                autoApprove: false,
            });

            expect(args).toContain('--new-project');
            expect(args).not.toContain('--dangerously-skip-permissions');
            expect(args).toEqual([
                '--input-format', 'stream-json',
                '--output-format', 'stream-json',
                '--new-project',
            ]);
        });

        it('includes --conversation <id> and omits --new-project when resuming', () => {
            const args = buildAgyArgs({
                conversationId: 'conv-abc-123',
                autoApprove: true,
                model: 'gemini-3.8-pro',
            });

            expect(args).not.toContain('--new-project');
            expect(args).toContain('--conversation');
            expect(args).toContain('conv-abc-123');
            expect(args).toEqual([
                '--input-format', 'stream-json',
                '--output-format', 'stream-json',
                '--conversation', 'conv-abc-123',
                '--dangerously-skip-permissions',
                '--model', 'gemini-3.8-pro',
            ]);
        });
    });
});
