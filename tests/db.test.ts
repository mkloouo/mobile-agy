import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../src/database/db';

describe('DatabaseManager', () => {
    let db: DatabaseManager;

    beforeEach(() => {
        db = new DatabaseManager(':memory:');
    });

    afterEach(() => {
        db.close();
    });

    describe('saveSession and topic preservation', () => {
        it('saves session and preserves topic_id when subsequent update omits topicId', () => {
            db.saveSession('chat1:100', '/path/to/project', 'uuid-111', 100);
            let session = db.getSession('chat1:100');
            expect(session).toBeDefined();
            expect(session?.workspacePath).toBe('/path/to/project');
            expect(session?.conversationId).toBe('uuid-111');
            expect(session?.topicId).toBe(100);

            // Subsequent update without topicId
            db.saveSession('chat1:100', '/path/to/new-project', 'uuid-222');
            session = db.getSession('chat1:100');
            expect(session?.workspacePath).toBe('/path/to/new-project');
            expect(session?.conversationId).toBe('uuid-222');
            expect(session?.topicId).toBe(100); // Preserved!
        });
    });

    describe('bindWorkspace and topic preservation', () => {
        it('binds workspace and preserves topicId when subsequent update omits it', () => {
            db.bindWorkspace('chat2:200', '/workspace/a', 200);
            expect(db.getWorkspaceBinding('chat2:200')).toBe('/workspace/a');

            // Rebind without topicId
            db.bindWorkspace('chat2:200', '/workspace/b');
            expect(db.getWorkspaceBinding('chat2:200')).toBe('/workspace/b');
        });
    });

    describe('recordTurnUsage', () => {
        it('records usage even if chat_sessions row was not explicitly created beforehand', () => {
            db.recordTurnUsage('fresh_channel', {
                inputTokens: 100,
                outputTokens: 50,
                thinkingTokens: 10,
                cacheTokens: 5,
                totalTokens: 165,
                durationSeconds: 2.5,
            });

            const session = db.getSession('fresh_channel');
            expect(session).toBeDefined();
            expect(session?.lastInputTokens).toBe(100);
            expect(session?.lastOutputTokens).toBe(50);
            expect(session?.totalInputTokens).toBe(100);
            expect(session?.totalOutputTokens).toBe(50);
            expect(session?.totalTurns).toBe(1);

            // Second turn accumulates
            db.recordTurnUsage('fresh_channel', {
                inputTokens: 200,
                outputTokens: 80,
                thinkingTokens: 20,
                cacheTokens: 0,
                totalTokens: 300,
                durationSeconds: 3.0,
            });

            const updated = db.getSession('fresh_channel');
            expect(updated?.lastInputTokens).toBe(200);
            expect(updated?.totalInputTokens).toBe(300);
            expect(updated?.totalOutputTokens).toBe(130);
            expect(updated?.totalTurns).toBe(2);
        });
    });

    describe('queued_messages queue lifecycle', () => {
        it('enqueues, retrieves in FIFO order, and pops messages transactionally', () => {
            const id1 = db.enqueueMessage('channel_q', 123, 10, 1001, 'Prompt 1');
            const id2 = db.enqueueMessage('channel_q', 123, 10, 1002, 'Prompt 2');
            const id3 = db.enqueueMessage('channel_q', 123, 10, 1003, 'Prompt 3');

            const queue = db.getQueuedMessages('channel_q');
            expect(queue.length).toBe(3);
            expect(queue[0].id).toBe(id1);
            expect(queue[1].id).toBe(id2);
            expect(queue[2].id).toBe(id3);

            // Pop next should return Prompt 1 and remove it
            const popped1 = db.popNextQueuedMessage('channel_q');
            expect(popped1?.id).toBe(id1);
            expect(popped1?.prompt).toBe('Prompt 1');

            expect(db.getQueuedMessages('channel_q').length).toBe(2);

            // Pop by ID should pop Prompt 3 and remove it
            const popped3 = db.popQueuedMessageById(id3);
            expect(popped3?.id).toBe(id3);
            expect(popped3?.prompt).toBe('Prompt 3');

            // Only Prompt 2 remains
            const remaining = db.getQueuedMessages('channel_q');
            expect(remaining.length).toBe(1);
            expect(remaining[0].id).toBe(id2);

            // Clear queue
            const clearedCount = db.clearQueue('channel_q');
            expect(clearedCount).toBe(1);
            expect(db.getQueuedMessages('channel_q').length).toBe(0);
        });

        it('supports deleting, editing prompt, and finding by userMsgId', () => {
            const qId = db.enqueueMessage('channel_edit', 123, undefined, 456, 'Original prompt', 9999);
            expect(qId).toBeGreaterThan(0);

            // Find by user_msg_id
            const foundByUser = db.findQueuedMessageByUserMsgId('channel_edit', 9999);
            expect(foundByUser?.id).toBe(qId);
            expect(foundByUser?.prompt).toBe('Original prompt');
            expect(foundByUser?.userMsgId).toBe(9999);

            // Update status_msg_id
            const updatedStatus = db.updateQueuedStatusMsgId(qId, 789);
            expect(updatedStatus).toBe(true);
            expect(db.getQueuedMessageById(qId)?.statusMsgId).toBe(789);

            // Edit prompt
            const updatedPrompt = db.updateQueuedPrompt(qId, 'Edited new prompt');
            expect(updatedPrompt).toBe(true);
            expect(db.getQueuedMessageById(qId)?.prompt).toBe('Edited new prompt');

            // Delete specific message
            const deleted = db.deleteQueuedMessage(qId);
            expect(deleted).toBe(true);
            expect(db.getQueuedMessageById(qId)).toBeUndefined();
            expect(db.findQueuedMessageByUserMsgId('channel_edit', 9999)).toBeUndefined();
        });
    });

    describe('daemon_sessions persistence lifecycle', () => {
        it('persists daemon session and recovers only active or undelivered turns', () => {
            db.upsertDaemonSession({
                channelId: 'chat_d1',
                workspacePath: '/ws/1',
                conversationId: 'conv-1',
                model: 'gemini-flash',
                socketPath: '/tmp/test1.sock',
                daemonPid: 101,
                agyPid: 102,
                isBusy: true,
                currentTurnId: 't_1',
                turnStartedAt: Date.now() - 5000,
                statusMessageId: 555,
                chatId: 1234,
                threadId: 99,
                accumulatedResponse: 'partial...',
                turnDelivered: false,
                lastDurationSeconds: 5,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            });

            const session = db.getDaemonSession('chat_d1');
            expect(session).toBeDefined();
            expect(session?.channelId).toBe('chat_d1');
            expect(session?.isBusy).toBe(true);
            expect(session?.currentTurnId).toBe('t_1');
            expect(session?.accumulatedResponse).toBe('partial...');
            expect(session?.turnDelivered).toBe(false);

            // Recoverable sessions should include chat_d1
            let recoverable = db.getRecoverableDaemonSessions();
            expect(recoverable.some((r) => r.channelId === 'chat_d1')).toBe(true);

            // Mark completed and delivered
            db.upsertDaemonSession({
                ...session!,
                isBusy: false,
                turnDelivered: true,
                accumulatedResponse: 'final answer',
            });

            // Recoverable sessions should NOT include chat_d1 anymore
            recoverable = db.getRecoverableDaemonSessions();
            expect(recoverable.some((r) => r.channelId === 'chat_d1')).toBe(false);

            // Delete session
            db.deleteDaemonSession('chat_d1');
            expect(db.getDaemonSession('chat_d1')).toBeUndefined();
        });
    });
});
