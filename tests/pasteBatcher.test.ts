import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePastedText } from '../src/bot/pasteBatcher';

describe('pasteBatcher', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('does not batch slash commands or shell commands', () => {
        const onComplete = vi.fn();
        const ctx: any = {
            chat: { id: 123 },
            message: { message_thread_id: 10 },
        };
        const services: any = {
            getChannelKey: () => '123:10',
        };

        expect(handlePastedText(ctx, '/status', services, onComplete)).toBe(false);
        expect(handlePastedText(ctx, '! ls -la', services, onComplete)).toBe(false);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('batches consecutive text chunks arriving rapidly into a single combined message', async () => {
        const onComplete = vi.fn();
        const ctx: any = {
            chat: { id: 123 },
            message: { message_thread_id: 10 },
            reply: vi.fn().mockResolvedValue({ message_id: 999 }),
            api: { editMessageText: vi.fn().mockResolvedValue({}) },
        };
        const services: any = {
            getChannelKey: () => '123:10',
            bot: { api: { editMessageText: vi.fn().mockResolvedValue({}) } },
        };

        // Chunk 1 arrives
        const b1 = handlePastedText(ctx, 'Line 1 of huge log', services, onComplete);
        expect(b1).toBe(true);

        // Advance 100ms
        vi.advanceTimersByTime(100);

        // Chunk 2 arrives
        const b2 = handlePastedText(ctx, 'Line 2 of huge log', services, onComplete);
        expect(b2).toBe(true);

        // Advance 100ms
        vi.advanceTimersByTime(100);

        // Chunk 3 arrives
        const b3 = handlePastedText(ctx, 'Line 3 of huge log', services, onComplete);
        expect(b3).toBe(true);

        // Timer has not expired yet (debounce resets on each chunk)
        expect(onComplete).not.toHaveBeenCalled();

        // Advance 650ms past the last chunk
        vi.advanceTimersByTime(650);

        // All 3 chunks combined into one single call!
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith('Line 1 of huge log\nLine 2 of huge log\nLine 3 of huge log', ctx);
    });

    it('preserves reply_to_message context from initial chunk when later chunks omit it', async () => {
        const onComplete = vi.fn();
        const repliedMsg = { text: 'Quoted context', from: { first_name: 'Alex' } };

        const ctx1: any = {
            chat: { id: 456 },
            message: { message_thread_id: 20, reply_to_message: repliedMsg },
        };
        const ctx2: any = {
            chat: { id: 456 },
            message: { message_thread_id: 20 },
            reply: vi.fn().mockResolvedValue({ message_id: 888 }),
        };
        const services: any = {
            getChannelKey: () => '456:20',
            bot: { api: { editMessageText: vi.fn().mockResolvedValue({}) } },
        };

        handlePastedText(ctx1, 'Chunk 1 with reply', services, onComplete);
        vi.advanceTimersByTime(100);
        handlePastedText(ctx2, 'Chunk 2 without reply', services, onComplete);

        vi.advanceTimersByTime(650);

        expect(onComplete).toHaveBeenCalledTimes(1);
        const [combinedText, passedCtx] = onComplete.mock.calls[0];
        expect(combinedText).toBe('Chunk 1 with reply\nChunk 2 without reply');
        expect(passedCtx.message.reply_to_message).toEqual(repliedMsg);
    });
});
