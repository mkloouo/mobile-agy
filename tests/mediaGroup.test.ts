import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleMediaGroupMessage } from '../src/bot/mediaGroup';

vi.mock('../src/utils/imageHandler', () => ({
    downloadTelegramPhoto: vi.fn().mockImplementation((_api, fileId) => Promise.resolve(`/tmp/downloaded_${fileId}.jpg`)),
}));

describe('handleMediaGroupMessage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('batches consecutive media group photos into a single turn execution', async () => {
        const executeTurnWithStatus = vi.fn().mockResolvedValue(undefined);
        const services: any = {
            getChannelKey: () => '100:5',
            resolveWorkspace: () => '/workspace/test',
            agyService: {
                isBusy: vi.fn().mockReturnValue(false),
            },
            db: {
                getQueuedMessages: vi.fn().mockReturnValue([]),
                enqueueMessage: vi.fn(),
            },
            bot: {
                api: {
                    editMessageText: vi.fn().mockResolvedValue({}),
                    sendMessage: vi.fn().mockResolvedValue({ message_id: 888 }),
                },
            },
            executeTurnWithStatus,
        };

        const ctx1: any = {
            chat: { id: 100 },
            message: {
                message_thread_id: 5,
                caption: 'Check these screens',
                photo: [
                    { file_id: 'thumb1' },
                    { file_id: 'photo_large_1' },
                ],
            },
            reply: vi.fn().mockResolvedValue({ message_id: 501 }),
        };

        const ctx2: any = {
            chat: { id: 100 },
            message: {
                message_thread_id: 5,
                photo: [
                    { file_id: 'thumb2' },
                    { file_id: 'photo_large_2' },
                ],
            },
            reply: vi.fn().mockResolvedValue({ message_id: 502 }),
        };

        // 1. Send photo 1
        await handleMediaGroupMessage(ctx1, 'group_123', services);
        expect(ctx1.reply).toHaveBeenCalledWith(
            '📥 <i>Receiving album (1 image)...</i>',
            expect.objectContaining({ parse_mode: 'HTML' })
        );

        // Advance 200ms
        vi.advanceTimersByTime(200);

        // 2. Send photo 2 in same media group
        await handleMediaGroupMessage(ctx2, 'group_123', services);

        // Debounce timer (1200ms) has not elapsed yet
        expect(executeTurnWithStatus).not.toHaveBeenCalled();

        // Advance past debounce timer
        await vi.advanceTimersByTimeAsync(1300);

        // executeTurnWithStatus was called with combined prompt!
        expect(executeTurnWithStatus).toHaveBeenCalledTimes(1);
        const [channelKey, wsPath, prompt, chatId, threadId, statusMsgId] = executeTurnWithStatus.mock.calls[0];

        expect(channelKey).toBe('100:5');
        expect(wsPath).toBe('/workspace/test');
        expect(prompt).toContain('Check these screens');
        expect(prompt).toContain('[Attached user screenshot: /tmp/downloaded_photo_large_1.jpg]');
        expect(prompt).toContain('[Attached user screenshot: /tmp/downloaded_photo_large_2.jpg]');
        expect(chatId).toBe(100);
        expect(threadId).toBe(5);
        expect(statusMsgId).toBe(501);
    });

    it('enqueues album prompt when agyService is busy', async () => {
        const enqueueMessage = vi.fn();
        const executeTurnWithStatus = vi.fn();

        const services: any = {
            getChannelKey: () => '100:5',
            resolveWorkspace: () => '/workspace/test',
            agyService: {
                isBusy: vi.fn().mockReturnValue(true),
            },
            db: {
                getQueuedMessages: vi.fn().mockReturnValue([]),
                enqueueMessage,
            },
            bot: {
                api: {
                    editMessageText: vi.fn().mockResolvedValue({}),
                },
            },
            executeTurnWithStatus,
        };

        const ctx: any = {
            chat: { id: 100 },
            message: {
                message_thread_id: 5,
                caption: 'Queued album',
                photo: [{ file_id: 'single_photo' }],
            },
            reply: vi.fn().mockResolvedValue({ message_id: 601 }),
        };

        await handleMediaGroupMessage(ctx, 'group_queued', services);
        await vi.advanceTimersByTimeAsync(1300);

        expect(enqueueMessage).toHaveBeenCalledTimes(1);
        expect(executeTurnWithStatus).not.toHaveBeenCalled();
        expect(enqueueMessage).toHaveBeenCalledWith(
            '100:5',
            100,
            5,
            601,
            expect.stringContaining('[Attached user screenshot: /tmp/downloaded_single_photo.jpg]')
        );
    });
});
