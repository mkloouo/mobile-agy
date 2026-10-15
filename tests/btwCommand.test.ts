import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeOneShotBtw } from '../src/bot/btwCommand';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

describe('btwCommand', () => {
    describe('executeOneShotBtw', () => {
        let mockProc: any;
        let mockStdout: PassThrough;
        let mockStdin: PassThrough;
        let mockSpawn: any;

        beforeEach(() => {
            mockStdout = new PassThrough();
            mockStdin = new PassThrough();
            mockProc = new EventEmitter();
            mockProc.stdout = mockStdout;
            mockProc.stdin = mockStdin;
            mockProc.killed = false;
            mockProc.kill = vi.fn();

            mockSpawn = vi.fn().mockReturnValue(mockProc as any);
        });

        it('spawns agy with --new-project and streams result response', async () => {
            const promise = executeOneShotBtw('/workspace/test', 'What is a closure?', 'gemini-3.8-flash-medium', 1000, mockSpawn);

            expect(mockSpawn).toHaveBeenCalledWith(
                'agy',
                expect.arrayContaining(['--input-format', 'stream-json', '--output-format', 'stream-json', '--new-project', '--model', 'gemini-3.8-flash-medium']),
                expect.objectContaining({ cwd: '/workspace/test' })
            );

            // Simulate events
            mockStdout.emit('data', Buffer.from(JSON.stringify({
                event: 'step_update',
                step_update: { step_type: 'agent_response', text_delta: 'A closure is ' },
            }) + '\n'));

            mockStdout.emit('data', Buffer.from(JSON.stringify({
                event: 'result',
                result: { status: 'SUCCESS', response: 'A closure is a function retaining lexical scope.' },
            }) + '\n'));

            mockProc.emit('close', 0);

            const result = await promise;
            expect(result).toBe('A closure is a function retaining lexical scope.');
        });

        it('accumulates deltas when result response is omitted', async () => {
            const promise = executeOneShotBtw('/workspace/test', 'Simple question', undefined, 1000, mockSpawn);

            mockStdout.emit('data', Buffer.from(JSON.stringify({
                event: 'step_update',
                step_update: { step_type: 'agent_response', text_delta: 'Part 1 ' },
            }) + '\n'));

            mockStdout.emit('data', Buffer.from(JSON.stringify({
                event: 'step_update',
                step_update: { step_type: 'agent_response', text_delta: 'Part 2' },
            }) + '\n'));

            mockProc.emit('close', 0);

            const result = await promise;
            expect(result).toBe('Part 1 Part 2');
        });

        it('handles process errors cleanly', async () => {
            const promise = executeOneShotBtw('/workspace/test', 'Error question', undefined, 1000, mockSpawn);
            const assertion = expect(promise).rejects.toThrow('Spawn failed');
            mockProc.emit('error', new Error('Spawn failed'));
            await assertion;
        });
    });
});
