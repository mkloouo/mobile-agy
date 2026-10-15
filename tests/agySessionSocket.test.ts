import { describe, it, expect, vi } from 'vitest';
import { routeDaemonEvent, ActiveSocketSession } from '../src/services/agySessionSocket';
import { getSessionPaths } from '../src/services/agyDaemonLauncher';

describe('agyDaemonLauncher', () => {
    describe('getSessionPaths', () => {
        it('generates deterministic socket and state file paths from sessionId', () => {
            const paths1 = getSessionPaths('chat-100:thread-5');
            const paths2 = getSessionPaths('chat-100:thread-5');
            const pathsOther = getSessionPaths('chat-100:thread-6');

            expect(paths1.socketPath).toBe(paths2.socketPath);
            expect(paths1.statePath).toBe(paths2.statePath);
            expect(paths1.socketPath).toMatch(/^\/tmp\/magy_[a-f0-9]{16}\.sock$/);
            expect(paths1.statePath).toMatch(/^\/tmp\/magy_[a-f0-9]{16}\.json$/);
            expect(paths1.socketPath).not.toBe(pathsOther.socketPath);
        });
    });
});

describe('agySessionSocket', () => {
    describe('routeDaemonEvent', () => {
        function createMockSession(): ActiveSocketSession {
            return {
                socket: {} as any,
                socketPath: '/tmp/test.sock',
                statePath: '/tmp/test.json',
                sessionId: 'test-session',
                workspacePath: '/workspace',
                currentConvId: '',
                isBusy: false,
                accumulatedText: '',
            };
        }

        it('handles daemon_hello and sets accumulatedResponse when in-flight (isBusy=true)', () => {
            const session = createMockSession();
            const onTimeout = vi.fn();

            routeDaemonEvent(session, {
                event: 'daemon_hello',
                state: { conversationId: 'conv-123', isBusy: true },
                accumulatedResponse: 'Previous answer',
            }, onTimeout);

            expect(session.currentConvId).toBe('conv-123');
            expect(session.accumulatedText).toBe('Previous answer');
        });

        it('clears accumulatedText on daemon_hello when daemon is idle (isBusy=false)', () => {
            const session = createMockSession();
            session.accumulatedText = 'Old stale text';
            const onTimeout = vi.fn();

            routeDaemonEvent(session, {
                event: 'daemon_hello',
                state: { conversationId: 'conv-123', isBusy: false },
                accumulatedResponse: 'Previous finished answer',
            }, onTimeout);

            expect(session.currentConvId).toBe('conv-123');
            expect(session.accumulatedText).toBe('');
        });

        it('reconstructs accumulatedText from history if accumulatedResponse is omitted', () => {
            const session = createMockSession();
            const onTimeout = vi.fn();

            routeDaemonEvent(session, {
                event: 'daemon_hello',
                state: { conversationId: 'conv-456', isBusy: true },
                history: [
                    { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Hello ' } },
                    { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'read_file' } },
                    { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'world!' } },
                ],
            }, onTimeout);

            expect(session.currentConvId).toBe('conv-456');
            expect(session.isBusy).toBe(true);
            expect(session.accumulatedText).toBe('Hello world!');
        });

        it('handles init event and calls onInit callback', () => {
            const session = createMockSession();
            const onInit = vi.fn();
            session.activeOptions = { onInit };

            routeDaemonEvent(session, {
                event: 'init',
                conversation_id: 'conv-init-789',
            }, vi.fn());

            expect(session.currentConvId).toBe('conv-init-789');
            expect(onInit).toHaveBeenCalledWith('conv-init-789');
        });

        it('handles step_update agent_response and dispatches onDelta', () => {
            const session = createMockSession();
            const onDelta = vi.fn();
            session.activeOptions = { onDelta };

            routeDaemonEvent(session, {
                event: 'step_update',
                step_update: {
                    conversation_id: 'conv-live',
                    step_type: 'agent_response',
                    text_delta: 'Thinking...',
                },
            }, vi.fn());

            expect(session.currentConvId).toBe('conv-live');
            expect(session.accumulatedText).toBe('Thinking...');
            expect(onDelta).toHaveBeenCalledWith('Thinking...', 'Thinking...');
        });

        it('handles step_update tool call ACTIVE and DONE events', () => {
            const session = createMockSession();
            const onToolCall = vi.fn();
            const onToolDone = vi.fn();
            session.activeOptions = { onToolCall, onToolDone };

            routeDaemonEvent(session, {
                event: 'step_update',
                step_update: {
                    step_type: 'tool',
                    tool_name: 'run_command',
                    state: 'ACTIVE',
                    tool_info: { parameters: { cmd: 'ls' } },
                },
            }, vi.fn());

            expect(onToolCall).toHaveBeenCalledWith('run_command', { cmd: 'ls' });

            routeDaemonEvent(session, {
                event: 'step_update',
                step_update: {
                    step_type: 'tool',
                    tool_name: 'run_command',
                    state: 'DONE',
                    tool_info: { output: 'file1.txt\nfile2.txt' },
                },
            }, vi.fn());

            expect(onToolDone).toHaveBeenCalledWith('run_command', 'file1.txt\nfile2.txt');
        });

        it('handles result event and resolves promise with complete TurnResult', () => {
            const session = createMockSession();
            session.isBusy = true;
            session.accumulatedText = 'Accumulated partial text';
            session.currentConvId = 'conv-resolved';

            const currentResolve = vi.fn();
            const currentReject = vi.fn();
            session.currentResolve = currentResolve;
            session.currentReject = currentReject;

            routeDaemonEvent(session, {
                event: 'result',
                result: {
                    status: 'SUCCESS',
                    duration_seconds: 4.2,
                    usage: { prompt_tokens: 100, completion_tokens: 50 },
                },
            }, vi.fn());

            expect(session.isBusy).toBe(false);
            expect(currentResolve).toHaveBeenCalledWith({
                status: 'SUCCESS',
                response: 'Accumulated partial text',
                error: undefined,
                durationSeconds: 4.2,
                usage: { prompt_tokens: 100, completion_tokens: 50 },
                conversationId: 'conv-resolved',
            });
            expect(session.currentResolve).toBeUndefined();
        });

        it('ignores unknown events gracefully', () => {
            const session = createMockSession();
            expect(() => {
                routeDaemonEvent(session, { event: 'some_unknown_event', data: 123 }, vi.fn());
            }).not.toThrow();
        });

        it('ignores step_update and result from mismatched turnId', () => {
            const session = createMockSession();
            session.activeTurnId = 'turn-current';
            session.isBusy = true;
            session.accumulatedText = 'Active turn text';

            const onDelta = vi.fn();
            const currentResolve = vi.fn();
            session.activeOptions = { onDelta };
            session.currentResolve = currentResolve;

            // Mismatched step_update
            routeDaemonEvent(session, {
                event: 'step_update',
                turnId: 'turn-old-stale',
                step_update: {
                    step_type: 'agent_response',
                    text_delta: 'Stale chunk',
                },
            }, vi.fn());

            expect(onDelta).not.toHaveBeenCalled();
            expect(session.accumulatedText).toBe('Active turn text');

            // Mismatched result
            routeDaemonEvent(session, {
                event: 'result',
                turnId: 'turn-old-stale',
                result: {
                    status: 'SUCCESS',
                    response: 'Old result',
                    duration_seconds: 5,
                },
            }, vi.fn());

            expect(currentResolve).not.toHaveBeenCalled();
            expect(session.isBusy).toBe(true);
            expect(session.activeTurnId).toBe('turn-current');
        });

        it('accepts step_update and result when turnId matches', () => {
            const session = createMockSession();
            session.activeTurnId = 'turn-123';
            session.isBusy = true;
            session.accumulatedText = '';

            const onDelta = vi.fn();
            const currentResolve = vi.fn();
            session.activeOptions = { onDelta };
            session.currentResolve = currentResolve;

            // Matching step_update
            routeDaemonEvent(session, {
                event: 'step_update',
                turnId: 'turn-123',
                step_update: {
                    step_type: 'agent_response',
                    text_delta: 'Hello matching',
                },
            }, vi.fn());

            expect(onDelta).toHaveBeenCalledWith('Hello matching', 'Hello matching');
            expect(session.accumulatedText).toBe('Hello matching');

            // Matching result
            routeDaemonEvent(session, {
                event: 'result',
                turnId: 'turn-123',
                result: {
                    status: 'SUCCESS',
                    response: 'Hello matching',
                    duration_seconds: 2,
                },
            }, vi.fn());

            expect(currentResolve).toHaveBeenCalledWith(expect.objectContaining({
                status: 'SUCCESS',
                response: 'Hello matching',
                durationSeconds: 2,
            }));
            expect(session.isBusy).toBe(false);
            expect(session.activeTurnId).toBeUndefined();
        });
    });
});
