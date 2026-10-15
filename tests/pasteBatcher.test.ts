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
});
