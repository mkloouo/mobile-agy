import { describe, it, expect, vi } from 'vitest';
import { deliverTurnResponse, buildCompletedStatus } from '../src/bot/turnDelivery';

describe('buildCompletedStatus', () => {
    it('formats duration cleanly without decimal artifacts', async () => {
        const status = await buildCompletedStatus({
            channelKey: 'test',
            workspacePath: '/tmp',
            durationSec: 4315.151737,
            recentCompletedActions: ['Action 1'],
        });

        expect(status.text).toContain('1h 11m 55s');
        expect(status.text).not.toContain('55.151737');
    });

    it('formats reconnected tag properly', async () => {
        const status = await buildCompletedStatus({
            channelKey: 'test',
            workspacePath: '/tmp',
            durationSec: 35,
            reconnected: true,
        });

        expect(status.text).toContain('(reconnected)</b> (35s)');
    });
});

describe('deliverTurnResponse', () => {
    it('successfully sends message chunk without error', async () => {
        const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 123 });
        const bot = { api: { sendMessage: mockSendMessage } };

        await deliverTurnResponse(bot, 100, 200, 'Hello world');

        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        expect(mockSendMessage).toHaveBeenCalledWith(100, expect.stringContaining('Hello world'), {
            parse_mode: 'HTML',
            message_thread_id: 200,
        });
    });

    it('retries on Telegram 429 rate limit and succeeds', async () => {
        const mockSendMessage = vi.fn()
            .mockRejectedValueOnce({
                message: '429: Too Many Requests',
                parameters: { retry_after: 0.01 },
            })
            .mockResolvedValueOnce({ message_id: 124 });

        const bot = { api: { sendMessage: mockSendMessage } };

        await deliverTurnResponse(bot, 100, 200, 'Test 429 retry');

        expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('falls back to plain text if HTML parsing fails', async () => {
        const mockSendMessage = vi.fn()
            .mockRejectedValueOnce(new Error('Bad Request: can\'t parse entities'))
            .mockResolvedValueOnce({ message_id: 125 });

        const bot = { api: { sendMessage: mockSendMessage } };

        await deliverTurnResponse(bot, 100, 200, '<b>Unclosed tag');

        expect(mockSendMessage).toHaveBeenCalledTimes(2);
        // Second call should have no parse_mode (plain text)
        expect(mockSendMessage).toHaveBeenLastCalledWith(100, expect.any(String), {
            message_thread_id: 200,
        });
    });

    it('does nothing when response is empty and no error message', async () => {
        const mockSendMessage = vi.fn();
        const bot = { api: { sendMessage: mockSendMessage } };

        await deliverTurnResponse(bot, 100, 200, '');

        expect(mockSendMessage).not.toHaveBeenCalled();
    });
});
