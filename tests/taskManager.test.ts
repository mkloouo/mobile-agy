import { describe, it, expect, vi } from 'vitest';
import { taskManager } from '../src/services/taskManager';
import { EventEmitter } from 'events';

describe('TaskManager', () => {
    it('registers, tracks, appends output, and unregisters child process', () => {
        const fakeChild = new EventEmitter() as any;
        fakeChild.pid = 99991;

        taskManager.registerProcess(
            99991,
            fakeChild,
            'npm run dev',
            'chat_1:thread_1',
            '/workspace/project',
            100,
            200,
            1
        );

        const tracked = taskManager.getTrackedProcess(99991);
        expect(tracked).toBeDefined();
        expect(tracked?.cmd).toBe('npm run dev');
        expect(tracked?.workspacePath).toBe('/workspace/project');

        // Append output
        taskManager.appendOutput(99991, 'Server started on port 3000\n');
        expect(taskManager.getTrackedProcess(99991)?.outputBuffer).toBe('Server started on port 3000\n');

        // Child close automatically unregisters
        fakeChild.emit('close');
        expect(taskManager.getTrackedProcess(99991)).toBeUndefined();
    });

    it('returns running tasks for workspace or channel key', async () => {
        const fakeChild = new EventEmitter() as any;
        fakeChild.pid = 99992;

        taskManager.registerProcess(
            99992,
            fakeChild,
            'expo start',
            'chat_2:thread_2',
            '/workspace/mobile-app',
            100,
            201,
            2
        );

        const tasksForChannel = await taskManager.getRunningTasks('chat_2:thread_2', '/some/other/path');
        expect(tasksForChannel.some((t) => t.pid === 99992)).toBe(true);
        expect(tasksForChannel.find((t) => t.pid === 99992)?.name).toBe('Metro Bundler');

        const tasksForWs = await taskManager.getRunningTasks('unrelated_channel', '/workspace/mobile-app');
        expect(tasksForWs.some((t) => t.pid === 99992)).toBe(true);

        taskManager.unregisterProcess(99992);
        expect(taskManager.getTrackedProcess(99992)).toBeUndefined();
    });

    it('formats process names sensibly for common dev commands', async () => {
        const fake1 = new EventEmitter() as any;
        const fake2 = new EventEmitter() as any;

        taskManager.registerProcess(99993, fake1, 'next dev', 'ch', '/ws', 1, 1);
        taskManager.registerProcess(99994, fake2, 'vite', 'ch', '/ws', 1, 1);

        const tasks = await taskManager.getRunningTasks('ch', '/ws');
        expect(tasks.find((t) => t.pid === 99993)?.name).toBe('Next.js Dev Server');
        expect(tasks.find((t) => t.pid === 99994)?.name).toBe('Vite Dev Server');

        taskManager.unregisterProcess(99993);
        taskManager.unregisterProcess(99994);
    });
});
