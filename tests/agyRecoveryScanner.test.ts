import fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanAndRecoverSessions } from '../src/services/agyRecoveryScanner';
import { setDatabase } from '../src/database/db';
import * as launcherModule from '../src/services/agyDaemonLauncher';

describe('agyRecoveryScanner', () => {
    let mockDb: any;

    beforeEach(() => {
        mockDb = {
            getRecoverableDaemonSessions: vi.fn().mockReturnValue([]),
            markDaemonTurnDelivered: vi.fn(),
        };
        setDatabase(mockDb as any);
        vi.spyOn(fs, 'readdirSync').mockReturnValue([] as any);
    });

    afterEach(() => {
        setDatabase(null);
        vi.restoreAllMocks();
    });

    it('recovers finished undelivered turns from SQLite', async () => {
        mockDb.getRecoverableDaemonSessions.mockReturnValue([
            {
                channelId: 'chat1:thread1',
                workspacePath: '/workspace',
                conversationId: 'conv-100',
                model: 'gemini-3.8-flash-medium',
                socketPath: '/tmp/test.sock',
                daemonPid: 1234,
                agyPid: 1235,
                isBusy: false,
                currentTurnId: 'turn-999',
                turnStartTime: Date.now() - 5000,
                statusMessageId: 44,
                chatId: 100,
                threadId: 1,
                accumulatedResponse: 'Task completed cleanly',
                turnDelivered: false,
                lastStatus: 'SUCCESS',
                lastDurationSeconds: 5,
                createdAt: Date.now() - 10000,
                updatedAt: Date.now() - 1000,
            },
        ]);

        const onTurnUpdate = vi.fn();
        const onTurnComplete = vi.fn();
        const setupSocketSession = vi.fn();

        await scanAndRecoverSessions(onTurnUpdate, onTurnComplete, setupSocketSession);

        expect(onTurnComplete).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'chat1:thread1',
                chatId: 100,
                statusMessageId: 44,
            }),
            expect.objectContaining({
                status: 'SUCCESS',
                response: 'Task completed cleanly',
                conversationId: 'conv-100',
            })
        );
        expect(mockDb.markDaemonTurnDelivered).toHaveBeenCalledWith('chat1:thread1', 'turn-999');
    });

    it('recovers dead in-flight turn if socket is unreachable and daemon PID is dead', async () => {
        vi.spyOn(launcherModule, 'tryConnectSocket').mockResolvedValue(null);

        mockDb.getRecoverableDaemonSessions.mockReturnValue([
            {
                channelId: 'chat2:thread2',
                workspacePath: '/workspace',
                conversationId: 'conv-200',
                socketPath: '/tmp/nonexistent.sock',
                daemonPid: 99999999, // Unlikely to exist
                agyPid: 99999998,
                isBusy: true,
                currentTurnId: 'turn-888',
                turnStartTime: Date.now() - 3000,
                statusMessageId: 55,
                chatId: 200,
                threadId: 2,
                accumulatedResponse: 'Halfway text before crash',
                turnDelivered: false,
                createdAt: Date.now() - 5000,
                updatedAt: Date.now() - 3000,
            },
        ]);

        const onTurnUpdate = vi.fn();
        const onTurnComplete = vi.fn();
        const setupSocketSession = vi.fn();

        await scanAndRecoverSessions(onTurnUpdate, onTurnComplete, setupSocketSession);

        expect(onTurnComplete).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'chat2:thread2',
                chatId: 200,
                statusMessageId: 55,
            }),
            expect.objectContaining({
                status: 'STOPPED',
                response: 'Halfway text before crash',
                conversationId: 'conv-200',
            })
        );
        expect(mockDb.markDaemonTurnDelivered).toHaveBeenCalledWith('chat2:thread2', 'turn-888');
    });

    it('re-attaches to in-flight turn if socket is connected', async () => {
        const mockSocket = { destroyed: false } as any;
        vi.spyOn(launcherModule, 'tryConnectSocket').mockResolvedValue(mockSocket);

        const mockSession: any = {
            isBusy: false,
            accumulatedText: '',
        };
        const setupSocketSession = vi.fn().mockReturnValue(mockSession);

        mockDb.getRecoverableDaemonSessions.mockReturnValue([
            {
                channelId: 'chat3:thread3',
                workspacePath: '/workspace',
                conversationId: 'conv-300',
                model: 'gemini-3.8-flash-medium',
                socketPath: '/tmp/live.sock',
                daemonPid: process.pid, // Current process is alive
                agyPid: process.pid,
                isBusy: true,
                currentTurnId: 'turn-777',
                turnStartTime: Date.now() - 2000,
                statusMessageId: 66,
                chatId: 300,
                threadId: 3,
                accumulatedResponse: 'Streaming in progress...',
                turnDelivered: false,
                createdAt: Date.now() - 4000,
                updatedAt: Date.now() - 2000,
            },
        ]);

        const onTurnUpdate = vi.fn();
        const onTurnComplete = vi.fn();

        await scanAndRecoverSessions(onTurnUpdate, onTurnComplete, setupSocketSession);

        expect(setupSocketSession).toHaveBeenCalledWith(
            'chat3:thread3',
            expect.anything(),
            mockSocket,
            '/workspace',
            'conv-300',
            'gemini-3.8-flash-medium'
        );
        expect(mockSession.isBusy).toBe(true);
        expect(mockSession.activeTurnId).toBe('turn-777');
        expect(mockSession.accumulatedText).toBe('Streaming in progress...');
        expect(onTurnUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 'chat3:thread3' }),
            'Streaming in progress...'
        );
    });
});
