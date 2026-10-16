import { InlineKeyboard } from 'grammy';
import { BotServices } from './types';
import {
    getActiveQuestionSessions,
    clearCustomPrompt,
    buildQuestionUI,
    finalizeAnswer,
} from './questionHandler';

export function registerQuestionCallbacks(services: BotServices): void {
    const { bot } = services;
    const activeSessions = getActiveQuestionSessions();

    // Single-select option callback
    bot.callbackQuery(/^q_select:([a-f0-9]+):(\d+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const optIdx = parseInt(ctx.match[2], 10);
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        await clearCustomPrompt(session, services);
        const currentQ = session.questions[session.currentQuestionIndex];
        const selectedText = currentQ.options[optIdx] || `Option ${optIdx + 1}`;
        session.answers.push(selectedText);

        await ctx.answerCallbackQuery({ text: `Selected: ${selectedText.slice(0, 30)}` });

        if (session.currentQuestionIndex + 1 < session.questions.length) {
            session.currentQuestionIndex++;
            session.selectedIndices.clear();
            session.customOptions = [];
            session.deselectedCustomIndices?.clear();
            const { text, keyboard } = buildQuestionUI(session);
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await finalizeAnswer(session, services);
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

    // Multi-select toggle custom option callback
    bot.callbackQuery(/^q_toggle_c:([a-f0-9]+):(\d+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const cIdx = parseInt(ctx.match[2], 10);
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        if (!session.deselectedCustomIndices) {
            session.deselectedCustomIndices = new Set<number>();
        }

        if (session.deselectedCustomIndices.has(cIdx)) {
            session.deselectedCustomIndices.delete(cIdx);
        } else {
            session.deselectedCustomIndices.add(cIdx);
        }

        await ctx.answerCallbackQuery();
        const { text, keyboard } = buildQuestionUI(session);
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } catch {}
    });

    // Custom option ("Your option") prompt callback
    bot.callbackQuery(/^q_custom:([a-f0-9]+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        await clearCustomPrompt(session, services);
        session.awaitingCustomInput = true;

        const cancelKb = new InlineKeyboard().text('❌ Cancel', `q_cancel_c:${session.id}`);
        const promptMsg = await services.bot.api.sendMessage(
            session.chatId,
            '✍️ <b>Type your custom answer:</b>\n<i>Send your response as a message in this topic.</i>',
            {
                parse_mode: 'HTML',
                message_thread_id: session.threadId,
                reply_markup: cancelKb,
            }
        );
        session.customPromptMsgId = promptMsg.message_id;

        await ctx.answerCallbackQuery({ text: 'Please send your answer' });
    });

    // Cancel custom option callback
    bot.callbackQuery(/^q_cancel_c:([a-f0-9]+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const session = activeSessions.get(qid);
        if (session) {
            await clearCustomPrompt(session, services);
        } else {
            try {
                await ctx.deleteMessage();
            } catch {}
        }
        await ctx.answerCallbackQuery({ text: 'Custom input cancelled' });
    });

    // Multi-select submit callback
    bot.callbackQuery(/^q_submit:([a-f0-9]+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        await clearCustomPrompt(session, services);
        const currentQ = session.questions[session.currentQuestionIndex];
        const selected = Array.from(session.selectedIndices)
            .sort((a, b) => a - b)
            .map((idx) => currentQ.options[idx])
            .filter(Boolean);

        const customSelected = (session.customOptions || [])
            .filter((_, idx) => !session.deselectedCustomIndices?.has(idx));

        const allSelected = [...selected, ...customSelected];
        const answerText = allSelected.length > 0 ? allSelected.join(', ') : 'None selected';
        session.answers.push(answerText);

        await ctx.answerCallbackQuery({ text: 'Answer submitted' });

        if (session.currentQuestionIndex + 1 < session.questions.length) {
            session.currentQuestionIndex++;
            session.selectedIndices.clear();
            session.customOptions = [];
            session.deselectedCustomIndices?.clear();
            const { text, keyboard } = buildQuestionUI(session);
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await finalizeAnswer(session, services);
        }
    });

    // Skip callback
    bot.callbackQuery(/^q_skip:([a-f0-9]+)$/, async (ctx) => {
        const qid = ctx.match[1];
        const session = activeSessions.get(qid);

        if (!session) {
            return ctx.answerCallbackQuery({ text: 'Question expired or already answered.' });
        }

        await clearCustomPrompt(session, services);
        session.answers.push('User Skipped');
        await ctx.answerCallbackQuery({ text: 'Skipped' });

        if (session.currentQuestionIndex + 1 < session.questions.length) {
            session.currentQuestionIndex++;
            session.selectedIndices.clear();
            session.customOptions = [];
            session.deselectedCustomIndices?.clear();
            const { text, keyboard } = buildQuestionUI(session);
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        } else {
            await finalizeAnswer(session, services);
        }
    });
}
