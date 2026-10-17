import { describe, it, expect, vi } from 'vitest';
import { deliverTurnResponse, buildCompletedStatus, buildProgressStatus, isActualTurnError } from '../src/bot/turnDelivery';

describe('isActualTurnError', () => {
    it('returns false for SUCCESS status regardless of response content', () => {
        expect(isActualTurnError('SUCCESS', 'All tasks finished')).toBe(false);
        expect(isActualTurnError('SUCCESS', '')).toBe(false);
        expect(isActualTurnError(undefined, 'Done')).toBe(false);
    });

    it('returns true when status is ERROR and response is empty', () => {
        expect(isActualTurnError('ERROR', '')).toBe(true);
        expect(isActualTurnError('ERROR', undefined)).toBe(true);
        expect(isActualTurnError('ERROR', '   ')).toBe(true);
    });

    it('returns true when status is ERROR and response contains explicit crash prefix', () => {
        expect(isActualTurnError('ERROR', '❌ Antigravity error: process exited 1')).toBe(true);
        expect(isActualTurnError('ERROR', 'Fatal error: out of memory')).toBe(true);
        expect(isActualTurnError('ERROR', 'panic: runtime error')).toBe(true);
        expect(isActualTurnError('ERROR', 'agent executor error: failed')).toBe(true);
        expect(isActualTurnError('ERROR', 'Something AGY_ERROR: broken')).toBe(true);
    });

    it('returns false when status is ERROR but model returned a valid complete answer', () => {
        const successfulResponse = 'Added default "Your option" write-in support for single and multi-select questions.';
        expect(isActualTurnError('ERROR', successfulResponse)).toBe(false);
    });
});

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

    it('includes prompt quote header when userPrompt is provided', async () => {
        const status = await buildCompletedStatus({
            channelKey: 'test',
            workspacePath: '/tmp',
            durationSec: 10,
            userPrompt: 'Build the release artifact',
        });

        expect(status.text).toContain('<blockquote expandable>Build the release artifact</blockquote>');
        expect(status.text).toContain('✓ <b>Completed</b> (10s)');
    });
});

describe('buildProgressStatus', () => {
    it('includes prompt quote header when userPrompt is provided', async () => {
        const status = await buildProgressStatus({
            channelKey: 'test',
            workspacePath: '/tmp',
            startTime: Date.now() - 5000,
            userPrompt: 'Please update database schema',
        });

        expect(status.text).toContain('<blockquote expandable>Please update database schema</blockquote>');
        expect(status.text).toContain('🧠 <b>Antigravity is working...</b>');
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

    it('extracts files and calls sendPhoto/sendDocument during delivery', async () => {
        const tmpFile = '/tmp/agy_turn_delivery_test.png';
        const fs = await import('fs');
        fs.writeFileSync(tmpFile, 'test-data');

        const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
        const mockSendPhoto = vi.fn().mockResolvedValue({ message_id: 2 });
        const bot = { api: { sendMessage: mockSendMessage, sendPhoto: mockSendPhoto } };

        try {
            await deliverTurnResponse(
                bot,
                100,
                200,
                `Here is the screenshot: <send_file path="${tmpFile}" caption="Screenshot" />`
            );

            expect(mockSendMessage).toHaveBeenCalledTimes(1);
            expect(mockSendMessage).toHaveBeenCalledWith(100, expect.stringContaining('Here is the screenshot:'), expect.any(Object));
            expect(mockSendPhoto).toHaveBeenCalledTimes(1);
            expect(mockSendPhoto).toHaveBeenCalledWith(100, expect.any(Object), {
                caption: 'Screenshot',
                message_thread_id: 200,
            });
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });
});
