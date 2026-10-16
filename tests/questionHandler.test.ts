import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    parseQuestions,
    buildQuestionUI,
    registerQuestionCallbacks,
    handleQuestionCustomInput,
    findSessionForCustomInput,
    getActiveQuestionSessions,
    ActiveQuestionSession,
} from '../src/bot/questionHandler';

describe('questionHandler', () => {
    beforeEach(() => {
        getActiveQuestionSessions().clear();
    });

    describe('parseQuestions', () => {
        it('parses standard ask_question parameters with questions array', () => {
            const params = {
                questions: [
                    {
                        question: 'Which task should I claim?',
                        options: ['MKL-34: Checklist', 'MKL-38: Gesture conflict'],
                        is_multi_select: false,
                    },
                ],
            };
            const result = parseQuestions(params);
            expect(result).toHaveLength(1);
            expect(result[0].question).toBe('Which task should I claim?');
            expect(result[0].options).toEqual(['MKL-34: Checklist', 'MKL-38: Gesture conflict']);
            expect(result[0].is_multi_select).toBe(false);
        });

        it('parses flat question object', () => {
            const params = {
                question: 'Choose color',
                options: ['Red', 'Green', 'Blue'],
                is_multi_select: true,
            };
            const result = parseQuestions(params);
            expect(result).toHaveLength(1);
            expect(result[0].question).toBe('Choose color');
            expect(result[0].options).toEqual(['Red', 'Green', 'Blue']);
            expect(result[0].is_multi_select).toBe(true);
        });

        it('parses JSON stringified questions array parameter', () => {
            const params = {
                questions: JSON.stringify([
                    {
                        question: 'Favorite database?',
                        options: ['PostgreSQL', 'SQLite'],
                        is_multi_select: false,
                    },
                ]),
            };
            const result = parseQuestions(params);
            expect(result).toHaveLength(1);
            expect(result[0].question).toBe('Favorite database?');
            expect(result[0].options).toEqual(['PostgreSQL', 'SQLite']);
        });

        it('returns empty array when options are empty or missing', () => {
            expect(parseQuestions({})).toEqual([]);
            expect(parseQuestions({ question: 'Empty options', options: [] })).toEqual([]);
            expect(parseQuestions(null)).toEqual([]);
        });
    });

    describe('buildQuestionUI', () => {
        it('builds single-select question UI with number badges, "Your option" button, and skip button', () => {
            const session: ActiveQuestionSession = {
                id: 'sess1234',
                channelKey: '123:456',
                chatId: 123,
                workspacePath: '/test',
                questions: [
                    {
                        question: 'Which model do you prefer?',
                        options: ['Gemini 3.8 Flash', 'Claude Sonnet 4.6'],
                        is_multi_select: false,
                    },
                ],
                currentQuestionIndex: 0,
                selectedIndices: new Set<number>(),
                answers: [],
                createdAt: Date.now(),
            };

            const { text, keyboard } = buildQuestionUI(session);
            expect(text).toContain('❓ <b>Which model do you prefer?</b>');
            expect(text).toContain('1️⃣ Gemini 3.8 Flash');
            expect(text).toContain('2️⃣ Claude Sonnet 4.6');

            // Keyboard buttons: 2 option rows + 1 your option row + 1 skip row
            const buttons = keyboard.inline_keyboard;
            expect(buttons).toHaveLength(4);
            expect(buttons[0][0].callback_data).toBe('q_select:sess1234:0');
            expect(buttons[1][0].callback_data).toBe('q_select:sess1234:1');
            expect(buttons[2][0].text).toBe('✍️ Your option');
            expect(buttons[2][0].callback_data).toBe('q_custom:sess1234');
            expect(buttons[3][0].callback_data).toBe('q_skip:sess1234');
        });

        it('builds multi-select question UI with checkbox marks, "Your option", and submit button', () => {
            const session: ActiveQuestionSession = {
                id: 'sess5678',
                channelKey: '123:456',
                chatId: 123,
                workspacePath: '/test',
                questions: [
                    {
                        question: 'Select components to test',
                        options: ['Auth', 'Database', 'Cache'],
                        is_multi_select: true,
                    },
                ],
                currentQuestionIndex: 0,
                selectedIndices: new Set<number>([1]), // Database is checked
                customOptions: ['Redis'],
                answers: [],
                createdAt: Date.now(),
            };

            const { text, keyboard } = buildQuestionUI(session);
            expect(text).toContain('❓ <b>Select components to test</b>');
            expect(text).toContain('Multi-select');
            expect(text).toContain('✍️ Redis');

            const buttons = keyboard.inline_keyboard;
            // 3 options + 1 custom option + 1 your option + 1 submit/skip row = 6 rows
            expect(buttons).toHaveLength(6);
            expect(buttons[0][0].text).toContain('◻️ Auth');
            expect(buttons[1][0].text).toContain('☑️ Database');
            expect(buttons[2][0].text).toContain('◻️ Cache');
            expect(buttons[3][0].text).toContain('☑️ ✍️ Redis');
            expect(buttons[4][0].text).toBe('✍️ Your option');

            // Action row: 1 predefined + 1 custom = 2 selected
            const actionRow = buttons[5];
            expect(actionRow[0].text).toBe('✅ Submit (2)');
            expect(actionRow[0].callback_data).toBe('q_submit:sess5678');
            expect(actionRow[1].text).toBe('⏭️ Skip');
            expect(actionRow[1].callback_data).toBe('q_skip:sess5678');
        });

        it('formats multi-question progress header', () => {
            const session: ActiveQuestionSession = {
                id: 'sess9999',
                channelKey: '123:456',
                chatId: 123,
                workspacePath: '/test',
                questions: [
                    { question: 'Q1', options: ['A', 'B'] },
                    { question: 'Q2', options: ['C', 'D'] },
                ],
                currentQuestionIndex: 1,
                selectedIndices: new Set<number>(),
                answers: ['A'],
                createdAt: Date.now(),
            };

            const { text } = buildQuestionUI(session);
            expect(text).toContain('<b>[Question 2/2]</b>');
            expect(text).toContain('❓ <b>Q2</b>');
        });
    });

    describe('registerQuestionCallbacks', () => {
        it('registers Grammy callback query patterns for q_select, q_toggle, q_toggle_c, q_custom, q_cancel_c, q_submit, q_skip', () => {
            const patterns: any[] = [];
            const mockBot = {
                callbackQuery: vi.fn((regex, _handler) => {
                    patterns.push(regex);
                }),
            };

            registerQuestionCallbacks({ bot: mockBot } as any);

            expect(mockBot.callbackQuery).toHaveBeenCalledTimes(7);
            const strPatterns = patterns.map((p) => p.toString());
            expect(strPatterns.some((p) => p.includes('q_select'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_toggle'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_toggle_c'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_custom'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_cancel_c'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_submit'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_skip'))).toBe(true);
        });
    });

    describe('handleQuestionCustomInput', () => {
        it('captures custom input for single-select question and finalizes answer', async () => {
            const session: ActiveQuestionSession = {
                id: 'custom1',
                channelKey: '100:200',
                chatId: 100,
                threadId: 200,
                workspacePath: '/ws',
                questions: [{ question: 'Preferred editor?', options: ['VSCode', 'Vim'] }],
                currentQuestionIndex: 0,
                selectedIndices: new Set<number>(),
                answers: [],
                messageId: 555,
                customPromptMsgId: 666,
                awaitingCustomInput: true,
                createdAt: Date.now(),
            };
            getActiveQuestionSessions().set(session.id, session);

            const mockServices: any = {
                getChannelKey: () => '100:200',
                bot: {
                    api: {
                        deleteMessage: vi.fn().mockResolvedValue(true),
                        editMessageText: vi.fn().mockResolvedValue(true),
                        sendMessage: vi.fn().mockResolvedValue({ message_id: 777 }),
                    },
                },
                executeTurnWithStatus: vi.fn().mockResolvedValue(undefined),
            };

            const ctx: any = {
                message: { text: 'Sublime Text' },
            };

            const handled = await handleQuestionCustomInput(ctx, mockServices);
            expect(handled).toBe(true);
            expect(session.answers).toEqual(['Sublime Text']);
            expect(mockServices.bot.api.deleteMessage).toHaveBeenCalledWith(100, 666);
            expect(mockServices.executeTurnWithStatus).toHaveBeenCalledWith(
                '100:200',
                '/ws',
                'A1: Sublime Text',
                100,
                200,
                777
            );
        });

        it('captures custom input for multi-select question, adds to customOptions, and updates UI', async () => {
            const session: ActiveQuestionSession = {
                id: 'custom2',
                channelKey: '100:200',
                chatId: 100,
                threadId: 200,
                workspacePath: '/ws',
                questions: [{ question: 'Select plugins', options: ['Linter', 'Prettier'], is_multi_select: true }],
                currentQuestionIndex: 0,
                selectedIndices: new Set<number>([0]),
                answers: [],
                messageId: 555,
                awaitingCustomInput: true,
                createdAt: Date.now(),
            };
            getActiveQuestionSessions().set(session.id, session);

            const mockServices: any = {
                getChannelKey: () => '100:200',
                bot: {
                    api: {
                        deleteMessage: vi.fn().mockResolvedValue(true),
                        editMessageText: vi.fn().mockResolvedValue(true),
                    },
                },
            };

            const ctx: any = {
                message: { text: 'Tailwind CSS' },
            };

            const handled = await handleQuestionCustomInput(ctx, mockServices);
            expect(handled).toBe(true);
            expect(session.customOptions).toEqual(['Tailwind CSS']);
            expect(mockServices.bot.api.editMessageText).toHaveBeenCalled();
            // Did not execute turn yet (waiting for user to click Submit)
            expect(session.answers).toEqual([]);
        });

        it('ignores messages when slash command or not awaiting custom input', async () => {
            const mockServices: any = {
                getChannelKey: () => '100:200',
            };

            const cmdCtx: any = { message: { text: '/status' } };
            expect(await handleQuestionCustomInput(cmdCtx, mockServices)).toBe(false);

            const normalCtx: any = { message: { text: 'hello there' } };
            expect(await handleQuestionCustomInput(normalCtx, mockServices)).toBe(false);
        });

        it('finds session when user replies directly to question message', () => {
            const session: ActiveQuestionSession = {
                id: 'custom3',
                channelKey: '100:200',
                chatId: 100,
                threadId: 200,
                workspacePath: '/ws',
                questions: [{ question: 'Test?', options: ['A', 'B'] }],
                currentQuestionIndex: 0,
                selectedIndices: new Set<number>(),
                answers: [],
                messageId: 888,
                createdAt: Date.now(),
            };
            getActiveQuestionSessions().set(session.id, session);

            const found = findSessionForCustomInput('100:200', 888);
            expect(found?.id).toBe('custom3');
        });
    });
});
