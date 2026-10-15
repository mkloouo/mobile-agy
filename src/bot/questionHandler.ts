import { Context, InlineKeyboard } from 'grammy';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BotServices } from './types';
import { escapeHtml } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export interface AskQuestionItem {
    question: string;
    options: string[];
    is_multi_select?: boolean;
}

export interface ActiveQuestionSession {
    id: string;
    channelKey: string;
    chatId: number;
    threadId?: number;
    workspacePath: string;
    questions: AskQuestionItem[];
    currentQuestionIndex: number;
    selectedIndices: Set<number>;
    answers: string[];
    messageId?: number;
    createdAt: number;
}

// In-memory store for active question sessions with 1-hour TTL
const activeSessions = new Map<string, ActiveQuestionSession>();

function cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, s] of activeSessions.entries()) {
        if (now - s.createdAt > 3600 * 1000) {
            activeSessions.delete(id);
        }
    }
}

export function parseQuestions(params: any): AskQuestionItem[] {
    if (!params) return [];

    let qData = params.questions;
    if (typeof qData === 'string') {
        try {
            qData = JSON.parse(qData);
        } catch {}
    }

    if (Array.isArray(qData)) {
        return qData
            .filter((q: any) => q && typeof q === 'object')
            .map((q: any) => ({
                question: String(q.question || 'Please select an option:'),
                options: Array.isArray(q.options) ? q.options.map(String) : [],
                is_multi_select: !!q.is_multi_select,
            }))
            .filter((q: AskQuestionItem) => q.options.length > 0);
    }

    let singleOpts = params.options;
    if (typeof singleOpts === 'string') {
        try {
            singleOpts = JSON.parse(singleOpts);
        } catch {}
    }

    if (params?.question) {
        const opts = Array.isArray(singleOpts) ? singleOpts.map(String) : [];
        if (opts.length > 0) {
            return [{
                question: String(params.question),
                options: opts,
                is_multi_select: !!params.is_multi_select,
            }];
        }
    }

    return [];
}

/**
 * Scan the latest turn in conversation transcript to find any ask_question call
 */
export function findRecentAskQuestion(conversationId: string): any | null {
    if (!conversationId) return null;
    const transcriptPath = path.join(
        os.homedir(),
        '.gemini',
        'antigravity-cli',
        'brain',
        conversationId,
        '.system_generated',
        'logs',
        'transcript.jsonl'
    );
    if (!fs.existsSync(transcriptPath)) return null;

    try {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const lines = content.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;
            try {
                const step = JSON.parse(line);
                if (step.type === 'USER_INPUT') {
                    break;
                }
                if (Array.isArray(step.tool_calls)) {
                    const qCall = step.tool_calls.find((tc: any) => tc.name === 'ask_question');
                    if (qCall?.args) {
                        return qCall.args;
                    }
                }
            } catch {}
        }
    } catch {}

    return null;
}

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export function buildQuestionUI(session: ActiveQuestionSession): { text: string; keyboard: InlineKeyboard } {
    const qIndex = session.currentQuestionIndex;
    const currentQ = session.questions[qIndex];
    const totalQ = session.questions.length;

    const prefix = totalQ > 1 ? `<b>[Question ${qIndex + 1}/${totalQ}]</b>\n\n` : '';
    let text = `${prefix}❓ <b>${escapeHtml(currentQ.question)}</b>\n\n`;

    currentQ.options.forEach((opt, idx) => {
        const numBadge = NUMBER_EMOJIS[idx] || `${idx + 1}.`;
        text += `${numBadge} ${escapeHtml(opt)}\n`;
    });

    if (currentQ.is_multi_select) {
        text += '\n<i>(Multi-select: toggle options then click Submit)</i>';
    }

    const keyboard = new InlineKeyboard();

    if (currentQ.is_multi_select) {
        currentQ.options.forEach((opt, idx) => {
            const isChecked = session.selectedIndices.has(idx);
            const checkMark = isChecked ? '☑️' : '◻️';
            let label = opt.trim();
            if (label.length > 32) label = label.slice(0, 29) + '...';
            keyboard.text(`${checkMark} ${label}`, `q_toggle:${session.id}:${idx}`).row();
        });

        const selectedCount = session.selectedIndices.size;
        keyboard
            .text(`✅ Submit (${selectedCount})`, `q_submit:${session.id}`)
            .text('⏭️ Skip', `q_skip:${session.id}`);
    } else {
        currentQ.options.forEach((opt, idx) => {
            const numBadge = NUMBER_EMOJIS[idx] || `${idx + 1}.`;
            let label = opt.trim();
            if (label.length > 34) label = label.slice(0, 31) + '...';
            keyboard.text(`${numBadge} ${label}`, `q_select:${session.id}:${idx}`).row();
        });

        keyboard.text('⏭️ Skip question', `q_skip:${session.id}`);
    }

    return { text: text.trim(), keyboard };
}

export async function presentQuestion(
    services: BotServices,
    channelKey: string,
    workspacePath: string,
    chatId: number,
    threadId: number | undefined,
    params: any
): Promise<number | undefined> {
    cleanupExpiredSessions();
    const questions = parseQuestions(params);
    if (questions.length === 0) return undefined;

    const id = crypto.randomBytes(4).toString('hex');
    const session: ActiveQuestionSession = {
        id,
        channelKey,
        chatId,
        threadId,
        workspacePath,
        questions,
        currentQuestionIndex: 0,
        selectedIndices: new Set<number>(),
        answers: [],
        createdAt: Date.now(),
    };

    activeSessions.set(id, session);
    const { text, keyboard } = buildQuestionUI(session);

    try {
        const msg = await services.bot.api.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            message_thread_id: threadId,
            reply_markup: keyboard,
        });
        session.messageId = msg.message_id;
        return msg.message_id;
    } catch (err: any) {
        logger.error('[QuestionHandler] Failed to send question message:', err);
        activeSessions.delete(id);
        return undefined;
    }
}

async function finalizeAnswer(session: ActiveQuestionSession, services: BotServices, ctx: Context): Promise<void> {
    activeSessions.delete(session.id);

    const formattedAnswers = session.answers
        .map((ans, idx) => session.questions.length > 1 ? `A${idx + 1}: ${ans}` : `A1: ${ans}`)
        .join('\n');

    const summaryText = session.answers
        .map((ans, idx) => {
            const q = session.questions[idx];
            return `❓ <b>${escapeHtml(q.question)}</b>\n👉 <i>${escapeHtml(ans)}</i>`;
        })
        .join('\n\n');

    try {
        await ctx.editMessageText(`✅ <b>Question answered:</b>\n\n${summaryText}`, {
            parse_mode: 'HTML',
        });
    } catch {}

    const statusMsg = await services.bot.api.sendMessage(
        session.chatId,
        '🧠 <i>Continuing with your selection...</i>',
        {
            parse_mode: 'HTML',
            message_thread_id: session.threadId,
        }
    );

    services.executeTurnWithStatus(
        session.channelKey,
        session.workspacePath,
        formattedAnswers,
        session.chatId,
        session.threadId,
        statusMsg.message_id
    ).catch((err) => {
        logger.error('[QuestionHandler] Error executing turn with answer:', err);
    });
}

export function registerQuestionCallbacks(services: BotServices): void {
    const { bot } = services;

    // Single-select option callback
    bot.callbackQuery(/^q_select:([a-f0-9]+):(\d+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const optIdx = parseInt(ctx.match[2], 10);
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        const currentQ = session.questions[session.currentQuestionIndex];
        const selectedText = currentQ.options[optIdx] || `Option ${optIdx + 1}`;
        session.answers.push(selectedText);

        await ctx.answerCallbackQuery({ text: `Selected: ${selectedText.slice(0, 30)}` });

        if (session.currentQuestionIndex + 1 < session.questions.length) {
            session.currentQuestionIndex++;
            session.selectedIndices.clear();
            const { text, keyboard } = buildQuestionUI(session);
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await finalizeAnswer(session, services, ctx);
        }
    });

    // Multi-select toggle option callback
    bot.callbackQuery(/^q_toggle:([a-f0-9]+):(\d+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const optIdx = parseInt(ctx.match[2], 10);
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        if (session.selectedIndices.has(optIdx)) {
            session.selectedIndices.delete(optIdx);
        } else {
            session.selectedIndices.add(optIdx);
        }

        await ctx.answerCallbackQuery();
        const { text, keyboard } = buildQuestionUI(session);
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch {}
    });

    // Multi-select submit callback
    bot.callbackQuery(/^q_submit:([a-f0-9]+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        const currentQ = session.questions[session.currentQuestionIndex];
        const selected = Array.from(session.selectedIndices)
            .sort((a, b) => a - b)
            .map((idx) => currentQ.options[idx])
            .filter(Boolean);

        const answerText = selected.length > 0 ? selected.join(', ') : 'None selected';
        session.answers.push(answerText);

        await ctx.answerCallbackQuery({ text: 'Answer submitted' });

        if (session.currentQuestionIndex + 1 < session.questions.length) {
            session.currentQuestionIndex++;
            session.selectedIndices.clear();
            const { text, keyboard } = buildQuestionUI(session);
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await finalizeAnswer(session, services, ctx);
        }
    });

    // Skip callback
    bot.callbackQuery(/^q_skip:([a-f0-9]+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        session.answers.push('User Skipped');
        await ctx.answerCallbackQuery({ text: 'Skipped' });

        if (session.currentQuestionIndex + 1 < session.questions.length) {
            session.currentQuestionIndex++;
            session.selectedIndices.clear();
            const { text, keyboard } = buildQuestionUI(session);
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await finalizeAnswer(session, services, ctx);
        }
    });
}
