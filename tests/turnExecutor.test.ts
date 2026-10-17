import { describe, it, expect, vi } from 'vitest';
import { executeTurnWithStatus } from '../src/bot/turnExecutor';

describe('executeTurnWithStatus pinning and queue progression', () => {
    it('pins status message on turn start and unpins on completion', async () => {
        const mockPin = vi.fn().mockResolvedValue(true);
        const mockUnpin = vi.fn().mockResolvedValue(true);
        const mockEditMessageText = vi.fn().mockResolvedValue({});
        const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
        const mockProcessNextQueuedTurn = vi.fn().mockResolvedValue(undefined);

        const mockAgyService = {
            setTelegramStatus: vi.fn(),
            executeTurn: vi.fn().mockImplementation((_key, opts) => {
                opts.onInit?.('conv-123');
                return Promise.resolve({
                    status: 'SUCCESS',
                    response: 'All done!',
                    conversationId: 'conv-123',
                });
            }),
            markTurnDelivered: vi.fn(),
        };

        const services: any = {
            bot: {
                api: {
                    pinChatMessage: mockPin,
                    unpinChatMessage: mockUnpin,
                    editMessageText: mockEditMessageText,
                    sendMessage: mockSendMessage,
                },
            },
            db: {
                recordTurnUsage: vi.fn(),
                saveSession: vi.fn(),
                getModel: vi.fn().mockReturnValue(null),
                getSession: vi.fn().mockReturnValue(null),
            },
            config: {
                defaultModel: 'gemini-3.8-flash-medium',
            },
            agyService: mockAgyService,
            processNextQueuedTurn: mockProcessNextQueuedTurn,
        };

        await executeTurnWithStatus(
            services,
            'chat1:thread1',
            '/tmp/test',
            'Hello test prompt',
            1001,
            2002,
            555
        );

        // Verify pinning on start
        expect(mockPin).toHaveBeenCalledWith(1001, 555, { disable_notification: true });

        // Verify unpinning on finish
        expect(mockUnpin).toHaveBeenCalledWith(1001, 555);

        // Verify next queued turn triggered
        expect(mockProcessNextQueuedTurn).toHaveBeenCalledWith('chat1:thread1');
    });

    it('tolerates pin and unpin failures silently', async () => {
        const mockPin = vi.fn().mockRejectedValue(new Error('CHAT_ADMIN_REQUIRED'));
        const mockUnpin = vi.fn().mockRejectedValue(new Error('NOT_PINNED'));
        const mockProcessNextQueuedTurn = vi.fn().mockResolvedValue(undefined);

        const mockAgyService = {
            setTelegramStatus: vi.fn(),
            executeTurn: vi.fn().mockResolvedValue({
                status: 'SUCCESS',
                response: 'Success despite pin failure',
            }),
            markTurnDelivered: vi.fn(),
        };

        const services: any = {
            bot: {
                api: {
                    pinChatMessage: mockPin,
                    unpinChatMessage: mockUnpin,
                    editMessageText: vi.fn().mockResolvedValue({}),
                    sendMessage: vi.fn().mockResolvedValue({ message_id: 1000 }),
                },
            },
            db: {
                recordTurnUsage: vi.fn(),
                saveSession: vi.fn(),
                getModel: vi.fn().mockReturnValue(null),
                getSession: vi.fn().mockReturnValue(null),
            },
            config: {
                defaultModel: 'gemini-3.8-flash-medium',
            },
            agyService: mockAgyService,
            processNextQueuedTurn: mockProcessNextQueuedTurn,
        };

        await expect(
            executeTurnWithStatus(
                services,
                'chat2:thread2',
                '/tmp/test2',
                'Another prompt',
                1002,
                undefined,
                666
            )
        ).resolves.not.toThrow();

        expect(mockPin).toHaveBeenCalledWith(1002, 666, { disable_notification: true });
        expect(mockUnpin).toHaveBeenCalledWith(1002, 666);
        expect(mockProcessNextQueuedTurn).toHaveBeenCalledWith('chat2:thread2');
    });

    it('injects initial system prompt on fresh session and keeps user prompt clean in status quote', async () => {
        let sentPrompt = '';
        const mockAgyService = {
            setTelegramStatus: vi.fn(),
            executeTurn: vi.fn().mockImplementation((_key, opts) => {
                sentPrompt = opts.prompt;
                return Promise.resolve({
                    status: 'SUCCESS',
                    response: 'Done fresh',
                });
            }),
            markTurnDelivered: vi.fn(),
        };

        const mockEditMessageText = vi.fn().mockResolvedValue({});
        const services: any = {
            bot: {
                api: {
                    pinChatMessage: vi.fn().mockResolvedValue(true),
                    unpinChatMessage: vi.fn().mockResolvedValue(true),
                    editMessageText: mockEditMessageText,
                    sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
                },
            },
            db: {
                recordTurnUsage: vi.fn(),
                saveSession: vi.fn(),
                getModel: vi.fn().mockReturnValue(null),
                getSession: vi.fn().mockReturnValue(null), // fresh session!
            },
            config: {
                defaultModel: 'gemini-3.8-flash-medium',
            },
            agyService: mockAgyService,
            processNextQueuedTurn: vi.fn().mockResolvedValue(undefined),
        };

        await executeTurnWithStatus(
            services,
            'chat3:thread3',
            '/tmp/test3',
            'Fresh turn prompt',
            1003,
            undefined,
            777
        );

        // agy received prompt with system context
        expect(sentPrompt).toContain('[System Context — Mobile Telegram Client]');
        expect(sentPrompt).toContain('No Markdown Tables');
        expect(sentPrompt).toContain('[User Request]:\nFresh turn prompt');

        // Status message quote in Telegram only contains the clean user prompt
        expect(mockEditMessageText).toHaveBeenCalledWith(
            1003,
            777,
            expect.stringContaining('Fresh turn prompt'),
            expect.any(Object)
        );
        expect(mockEditMessageText).not.toHaveBeenCalledWith(
            1003,
            777,
            expect.stringContaining('[System Context — Mobile Telegram Client]'),
            expect.any(Object)
        );
    });

    it('does not inject initial system prompt on existing ongoing session', async () => {
        let sentPrompt = '';
        const mockAgyService = {
            setTelegramStatus: vi.fn(),
            executeTurn: vi.fn().mockImplementation((_key, opts) => {
                sentPrompt = opts.prompt;
                return Promise.resolve({
                    status: 'SUCCESS',
                    response: 'Done ongoing',
                });
            }),
            markTurnDelivered: vi.fn(),
        };

        const services: any = {
            bot: {
                api: {
                    pinChatMessage: vi.fn().mockResolvedValue(true),
                    unpinChatMessage: vi.fn().mockResolvedValue(true),
                    editMessageText: vi.fn().mockResolvedValue({}),
                    sendMessage: vi.fn().mockResolvedValue({ message_id: 11 }),
                },
            },
            db: {
                recordTurnUsage: vi.fn(),
                saveSession: vi.fn(),
                getModel: vi.fn().mockReturnValue(null),
                getSession: vi.fn().mockReturnValue({ conversationId: 'existing-conv-id' }), // ongoing!
            },
            config: {
                defaultModel: 'gemini-3.8-flash-medium',
            },
            agyService: mockAgyService,
            processNextQueuedTurn: vi.fn().mockResolvedValue(undefined),
        };

        await executeTurnWithStatus(
            services,
            'chat4:thread4',
            '/tmp/test4',
            'Follow up question',
            1004,
            undefined,
            888
        );

        expect(sentPrompt).toBe('Follow up question');
        expect(sentPrompt).not.toContain('[System Context');
    });
});
