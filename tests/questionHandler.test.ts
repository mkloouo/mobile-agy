import { describe, it, expect, vi } from 'vitest';
import {
    parseQuestions,
    buildQuestionUI,
    registerQuestionCallbacks,
    ActiveQuestionSession,
} from '../src/bot/questionHandler';

describe('questionHandler', () => {
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
        it('builds single-select question UI with number badges and skip button', () => {
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

            // Keyboard buttons
            const buttons = keyboard.inline_keyboard;
            expect(buttons).toHaveLength(3); // 2 option rows + 1 skip row
            expect(buttons[0][0].callback_data).toBe('q_select:sess1234:0');
            expect(buttons[1][0].callback_data).toBe('q_select:sess1234:1');
            expect(buttons[2][0].callback_data).toBe('q_skip:sess1234');
        });

        it('builds multi-select question UI with checkbox marks and submit button', () => {
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
                answers: [],
                createdAt: Date.now(),
            };

            const { text, keyboard } = buildQuestionUI(session);
            expect(text).toContain('❓ <b>Select components to test</b>');
            expect(text).toContain('Multi-select');

            const buttons = keyboard.inline_keyboard;
            expect(buttons).toHaveLength(4); // 3 options + 1 submit/skip row
            expect(buttons[0][0].text).toContain('◻️ Auth');
            expect(buttons[1][0].text).toContain('☑️ Database');
            expect(buttons[2][0].text).toContain('◻️ Cache');

            // Action row
            const actionRow = buttons[3];
            expect(actionRow[0].text).toBe('✅ Submit (1)');
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
        it('registers Grammy callback query patterns for q_select, q_toggle, q_submit, q_skip', () => {
            const patterns: any[] = [];
            const mockBot = {
                callbackQuery: vi.fn((regex, _handler) => {
                    patterns.push(regex);
                }),
            };

            registerQuestionCallbacks({ bot: mockBot } as any);

            expect(mockBot.callbackQuery).toHaveBeenCalledTimes(4);
            const strPatterns = patterns.map((p) => p.toString());
            expect(strPatterns.some((p) => p.includes('q_select'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_toggle'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_submit'))).toBe(true);
            expect(strPatterns.some((p) => p.includes('q_skip'))).toBe(true);
        });
    });
});
