import { InlineKeyboard } from 'grammy';
import { BotServices } from './types';
import { buildChatsUI, buildProjectsUI } from './keyboards';
import { registerQuestionCallbacks } from './questionHandler';
import { ConversationSummary } from '../services/conversationService';
import { taskManager } from '../services/taskManager';
import { escapeHtml, formatHumanDate } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export function registerBotCallbacks(services: BotServices): void {
    const { bot, config, db, workspaceService, topicManager, convService, convCache } = services;

    // Register interactive question callbacks
    registerQuestionCallbacks(services);

    // Handle model picker callback
    bot.callbackQuery(/^set_model:(.+)$/, async (ctx) => {
        const selectedModel = ctx.match[1];
        const channelKey = services.getChannelKey(ctx);
        db.setModel(channelKey, selectedModel);

        await ctx.answerCallbackQuery({ text: `Model set to ${selectedModel}` });
        await ctx.editMessageText(
            `✅ <b>Active model updated!</b>\n\nTopic model: <code>${escapeHtml(selectedModel)}</code>\nSubsequent prompts will use this model.`,
            { parse_mode: 'HTML' }
        );
    });

    // Clear queue callback
    bot.callbackQuery('clear_queue', async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const count = db.clearQueue(channelKey);

        await ctx.answerCallbackQuery({ text: `Cleared ${count} queued message(s)` });
        await ctx.editMessageText(`🗑️ <b>Cleared ${count} queued message(s).</b>`, { parse_mode: 'HTML' });
    });

    // Show queue callback
    bot.callbackQuery('show_queue', async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const threadId = (ctx.callbackQuery.message as any)?.message_thread_id;
        const queue = db.getQueuedMessages(channelKey);
        const isRunning = services.agyService.isBusy(channelKey);

        await ctx.answerCallbackQuery();

        if (queue.length === 0) {
            await ctx.reply(
                `📭 <b>Message Queue is Empty</b>\nActive task: ${isRunning ? '⚙️ Running' : '💤 Idle'}`,
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
            return;
        }

        let queueList = `📬 <b>Queued Messages (${queue.length}):</b>\n\n`;
        queue.forEach((item, idx) => {
            const preview = item.prompt.length > 45 ? `${item.prompt.slice(0, 42)}...` : item.prompt;
            const timeTag = item.createdAt ? ` <i>(${formatHumanDate(item.createdAt)})</i>` : '';
            queueList += `${idx + 1}. <code>${escapeHtml(preview)}</code>${timeTag}\n`;
        });

        const keyboard = new InlineKeyboard();
        queue.slice(0, 8).forEach((item, idx) => {
            const preview = item.prompt.length > 20 ? `${item.prompt.slice(0, 18)}...` : item.prompt;
            keyboard
                .text(`⚡ #${idx + 1} ${preview}`, `q_force:${item.id}`)
                .text(`🗑️ Del #${idx + 1}`, `q_del:${item.id}`)
                .row();
        });
        keyboard.text('🗑️ Clear Entire Queue', 'clear_queue');

        await ctx.reply(queueList, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            message_thread_id: threadId,
        });
    });

    // Delete a specific message from queue
    bot.callbackQuery(/^q_del:(\d+)$/, async (ctx) => {
        const queueId = parseInt(ctx.match[1], 10);
        const channelKey = services.getChannelKey(ctx);
        const item = db.getQueuedMessageById(queueId);

        if (!item) {
            return ctx.answerCallbackQuery({ text: 'Message is no longer in queue.' });
        }

        db.deleteQueuedMessage(queueId);
        await ctx.answerCallbackQuery({ text: `Removed message #${queueId} from queue.` });

        const isQueueListView = ctx.callbackQuery.message?.text?.includes('Queued Messages');
        if (isQueueListView) {
            const remaining = db.getQueuedMessages(channelKey);
            if (remaining.length === 0) {
                try {
                    await ctx.editMessageText('📭 <b>Message Queue is now Empty</b>', { parse_mode: 'HTML' });
                } catch {}
                return;
            }

            let queueList = `📬 <b>Queued Messages (${remaining.length}):</b>\n\n`;
            remaining.forEach((q, idx) => {
                const preview = q.prompt.length > 45 ? `${q.prompt.slice(0, 42)}...` : q.prompt;
                const timeTag = q.createdAt ? ` <i>(${formatHumanDate(q.createdAt)})</i>` : '';
                queueList += `${idx + 1}. <code>${escapeHtml(preview)}</code>${timeTag}\n`;
            });

            const keyboard = new InlineKeyboard();
            remaining.slice(0, 8).forEach((q, idx) => {
                const preview = q.prompt.length > 20 ? `${q.prompt.slice(0, 18)}...` : q.prompt;
                keyboard
                    .text(`⚡ #${idx + 1} ${preview}`, `q_force:${q.id}`)
                    .text(`🗑️ Del #${idx + 1}`, `q_del:${q.id}`)
                    .row();
            });
            keyboard.text('🗑️ Clear Entire Queue', 'clear_queue');

            try {
                await ctx.editMessageText(queueList, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                });
            } catch {}
        } else {
            try {
                await ctx.editMessageText(
                    `🗑️ <b>Queued message cancelled:</b>\n<code>${escapeHtml(item.prompt.slice(0, 200))}</code>`,
                    { parse_mode: 'HTML' }
                );
            } catch {}
        }
    });

    // Force a specific message from queue now
    bot.callbackQuery(/^q_force:(\d+)$/, async (ctx) => {
        const queueId = parseInt(ctx.match[1], 10);
        const channelKey = services.getChannelKey(ctx);
        const item = db.popQueuedMessageById(queueId);

        if (!item) {
            return ctx.answerCallbackQuery({ text: 'Message no longer in queue.' });
        }

        // If a task is running, stop it to prioritize forced message
        if (services.agyService.isBusy(channelKey)) {
            services.agyService.stopSession(channelKey);
            await new Promise((r) => setTimeout(r, 250));
        }

        await ctx.answerCallbackQuery({ text: `Forcing execution of #${queueId}...` });
        try {
            await ctx.editMessageText(
                `⚡ <b>Forcing execution of queued message:</b>\n<code>${escapeHtml(item.prompt.slice(0, 300))}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch {}

        const workspacePath = services.resolveWorkspace(channelKey);
        const initialStatus = await ctx.reply('🧠 <i>Antigravity is thinking (forced from queue)...</i>', {
            parse_mode: 'HTML',
            message_thread_id: item.threadId,
        });

        services.executeTurnWithStatus(
            channelKey,
            workspacePath,
            item.prompt,
            item.chatId,
            item.threadId,
            initialStatus.message_id
        ).catch((err) => {
            logger.error('[QueueForce] Execution error:', err);
        });
    });

    // Handle pagination callback for /chats
    bot.callbackQuery(/^chats_p:(\d+):(.*)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        const query = decodeURIComponent(ctx.match[2] || '');
        const searchResult = convService.search(query, page, 5);
        const { text, keyboard } = buildChatsUI(convCache, searchResult, query);

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Handle project selection callback
    bot.callbackQuery(/^select_ws:(.+)$/, async (ctx) => {
        const wsName = ctx.match[1];
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        try {
            const fullPath = workspaceService.resolveWorkspace(wsName);
            let newTopicId: number | undefined;

            if (config.useTopics && ctx.chat?.type === 'supergroup') {
                try {
                    newTopicId = await topicManager.createProjectTopic(chatId, wsName);
                } catch (err: any) {
                    logger.warn(`[ProjectSelect] Could not create topic for ${wsName}:`, err?.message || err);
                }
            }

            if (newTopicId) {
                const newChannelKey = `${chatId}:${newTopicId}`;
                db.bindWorkspace(newChannelKey, wsName, newTopicId);

                await ctx.answerCallbackQuery({ text: `Created topic 📁 ${wsName}` });
                await ctx.editMessageText(
                    `✅ Created topic: <b>📁 ${escapeHtml(wsName)}</b>\nPath: <code>${fullPath}</code>`,
                    { parse_mode: 'HTML' }
                );

                await ctx.api.sendMessage(
                    chatId,
                    `📁 <b>Workspace: ${escapeHtml(wsName)}</b>\n<code>${fullPath}</code>\n\nSend messages here to interact with this project.`,
                    { parse_mode: 'HTML', message_thread_id: newTopicId }
                );
            } else {
                const channelKey = services.getChannelKey(ctx);
                db.bindWorkspace(channelKey, wsName);
                db.deleteSession(channelKey);
                await services.agyService.restartSession(channelKey);

                await ctx.answerCallbackQuery({ text: `Switched to ${wsName}` });
                await ctx.editMessageText(
                    `✅ Switched to workspace: <b>${wsName}</b>\nPath: <code>${fullPath}</code>\n\nStarted a fresh conversation. Send a message to begin.`,
                    { parse_mode: 'HTML' }
                );
            }
        } catch (err: any) {
            await ctx.answerCallbackQuery({ text: 'Error switching workspace' });
            await ctx.reply(`Failed to switch: ${err.message}`);
        }
    });

    // Handle assign existing chat callback
    bot.callbackQuery(/^assign_chat:(.+)$/, async (ctx) => {
        const shortId = ctx.match[1];
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        let match: ConversationSummary | undefined;
        for (const [id, summary] of convCache.entries()) {
            if (id.startsWith(shortId)) {
                match = summary;
                break;
            }
        }

        if (!match) {
            const searchRes = convService.search('', 0, 20);
            match = searchRes.items.find((r) => r.conversationId.startsWith(shortId));
        }

        if (!match) {
            await ctx.answerCallbackQuery({ text: 'Conversation not found' });
            return;
        }

        const threadId = (ctx.callbackQuery.message as any)?.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        if (config.useTopics && ctx.chat?.type === 'supergroup' && isGeneral) {
            try {
                const topicTitle = match.title || `Chat ${shortId}`;
                const newTopicId = await topicManager.createConversationTopic(chatId, topicTitle);
                const newKey = `${chatId}:${newTopicId}`;

                const wsPath = match.workspacePath || workspaceService.getBaseDir();
                db.saveSession(newKey, wsPath, match.conversationId, newTopicId);

                await ctx.answerCallbackQuery({ text: `Created topic for ${match.title}` });
                await ctx.editMessageText(
                    `✅ Assigned conversation <b>${escapeHtml(match.title)}</b> to new topic: <b>💬 ${escapeHtml(topicTitle)}</b>`,
                    { parse_mode: 'HTML' }
                );

                await ctx.api.sendMessage(
                    chatId,
                    `🔄 <b>Assigned Conversation:</b> <i>${escapeHtml(match.title)}</i>\n<code>${match.conversationId}</code>\n📁 <b>Workspace:</b> <code>${wsPath}</code>\n\nSend a prompt here to continue where you left off!`,
                    { parse_mode: 'HTML', message_thread_id: newTopicId }
                );
            } catch (err: any) {
                await ctx.answerCallbackQuery({ text: 'Error creating topic' });
                await ctx.reply(`Failed to create topic: ${err.message}`);
            }
        } else {
            const channelKey = services.getChannelKey(ctx);
            const wsPath = match.workspacePath || services.resolveWorkspace(channelKey);
            db.saveSession(channelKey, wsPath, match.conversationId, threadId);

            await ctx.answerCallbackQuery({ text: `Attached ${match.title}` });
            await ctx.editMessageText(
                `🔄 <b>Assigned Conversation:</b> <i>${escapeHtml(match.title)}</i>\n<code>${match.conversationId}</code>\n📁 <b>Workspace:</b> <code>${wsPath}</code>\n\nReady to chat!`,
                { parse_mode: 'HTML' }
            );
        }
    });

    // Handle noop callbacks
    bot.callbackQuery('noop', async (ctx) => {
        await ctx.answerCallbackQuery();
    });

    // General button callbacks
    bot.callbackQuery('cmd_projects', async (ctx) => {
        await ctx.answerCallbackQuery();
        const workspaces = workspaceService.scanWorkspaces();
        const keyboard = buildProjectsUI(workspaces);
        await ctx.reply('<b>Select a workspace to start a topic:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    bot.callbackQuery('cmd_chats', async (ctx) => {
        await ctx.answerCallbackQuery();
        const searchResult = convService.search('', 0, 5);
        const { text, keyboard } = buildChatsUI(convCache, searchResult, '');
        await ctx.reply(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Callback to stop a running background shell process or daemon
    bot.callbackQuery(/^kill_proc:(\d+)$/, async (ctx) => {
        const pid = parseInt(ctx.match[1], 10);
        taskManager.killProcess(pid);

        await ctx.answerCallbackQuery({ text: `Process PID ${pid} stopped` });
        try {
            await ctx.editMessageText(
                `🛑 <b>Stopped process:</b> PID <code>${pid}</code>`,
                { parse_mode: 'HTML' }
            );
        } catch {}
    });
}
