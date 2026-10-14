import { Bot, Context, InlineKeyboard } from 'grammy';
import { AppConfig } from '../utils/config';
import { DatabaseManager } from '../database/db';
import { WorkspaceService } from '../services/workspaceService';
import { TelegramTopicManager } from '../services/telegramTopicManager';
import { ConversationService, ConversationSummary, SearchResult } from '../services/conversationService';
import { AgyStreamService } from '../services/agyStreamService';
import { escapeHtml, formatForTelegram, splitTelegramHtml } from '../utils/telegramFormatter';
import { downloadTelegramPhoto } from '../utils/imageHandler';
import { logger } from '../utils/logger';

export function createBot(config: AppConfig) {
    const bot = new Bot(config.telegramBotToken);
    const db = new DatabaseManager(config.dbPath);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);
    const topicManager = new TelegramTopicManager(bot.api);
    const convService = new ConversationService();
    const agyService = new AgyStreamService(config.idleTimeoutSeconds);

    // Register /agy_* commands with Telegram so they appear in autocomplete menu
    bot.api.setMyCommands([
        { command: 'agy_new', description: 'Create a new topic & conversation' },
        { command: 'agy_chats', description: 'Browse and assign existing chats' },
        { command: 'agy_projects', description: 'Select a project workspace' },
        { command: 'agy_stop', description: 'Stop current running task' },
        { command: 'agy_status', description: 'Show session and execution status' },
        { command: 'agy_resume', description: 'Attach a conversation UUID' },
        { command: 'agy_bind', description: 'Bind topic to a workspace folder' },
        { command: 'agy_topic', description: 'Rename current topic' },
        { command: 'agy_help', description: 'Show guide and commands' },
    ]).catch((err) => logger.warn('[Bot] Failed to set bot commands menu:', err.message));

    // In-memory cache for recent conversations to support callback buttons
    const convCache = new Map<string, ConversationSummary>();

    // Whitelist Authorization Middleware
    bot.use(async (ctx, next) => {
        // Ignore messages from bots (including self) to prevent loops
        if (ctx.from?.is_bot) {
            return;
        }

        if (config.allowedUserIds.length > 0) {
            const userId = ctx.from?.id;
            if (!userId || !config.allowedUserIds.includes(userId)) {
                logger.warn(`[Auth] Blocked unauthorized message from user ${userId} (${ctx.from?.username})`);
                if (ctx.chat?.type === 'private') {
                    await ctx.reply('⛔ You are not authorized to use this bot.');
                }
                return;
            }
        }
        await next();
    });

    /**
     * Resolve the channel key (combines chatId + topicId)
     */
    function getChannelKey(ctx: Context, overrideThreadId?: number): string {
        const chatId = ctx.chat?.id;
        const threadId = overrideThreadId ?? (ctx.message?.message_thread_id || (ctx.callbackQuery?.message as any)?.message_thread_id);
        return threadId ? `${chatId}:${threadId}` : `${chatId}`;
    }

    /**
     * Resolve workspace path for current context
     */
    function resolveWorkspace(channelKey: string): string {
        const boundPath = db.getWorkspaceBinding(channelKey);
        if (boundPath && workspaceService.exists(boundPath)) {
            return workspaceService.getWorkspacePath(boundPath);
        }
        return workspaceService.getBaseDir();
    }

    /**
     * Try to create a topic in supergroup if topics are enabled
     */
    async function createConversationTopic(ctx: Context, title: string): Promise<number | undefined> {
        if (!config.useTopics || !ctx.chat || ctx.chat.type !== 'supergroup') {
            return undefined;
        }
        try {
            return await topicManager.createConversationTopic(ctx.chat.id, title);
        } catch (err: any) {
            logger.warn(`[Bot] Could not create topic (check bot admin 'can_manage_topics' permission):`, err?.message || err);
            return undefined;
        }
    }

    /**
     * Helper to render /agy_chats keyboard with pagination
     */
    function buildChatsUI(result: SearchResult, query: string): { text: string; keyboard: InlineKeyboard } {
        const keyboard = new InlineKeyboard();

        if (result.items.length === 0) {
            return {
                text: query
                    ? `No conversations found matching "<b>${escapeHtml(query)}</b>".`
                    : 'No conversations found in history.',
                keyboard,
            };
        }

        for (const item of result.items) {
            convCache.set(item.conversationId, item);
            const shortId = item.conversationId.slice(0, 8);
            const label = item.title.length > 28 ? `${item.title.slice(0, 25)}...` : item.title;
            keyboard.text(`💬 ${label}`, `assign_chat:${shortId}`).row();
        }

        // Pagination buttons if more than one page
        if (result.totalPages > 1) {
            const prevPage = Math.max(0, result.page - 1);
            const nextPage = Math.min(result.totalPages - 1, result.page + 1);
            const encQuery = encodeURIComponent(query);

            if (result.page > 0) {
                keyboard.text('◀ Prev', `chats_p:${prevPage}:${encQuery}`);
            } else {
                keyboard.text('·', 'noop');
            }

            keyboard.text(`${result.page + 1} / ${result.totalPages}`, 'noop');

            if (result.page < result.totalPages - 1) {
                keyboard.text('Next ▶', `chats_p:${nextPage}:${encQuery}`);
            } else {
                keyboard.text('·', 'noop');
            }
            keyboard.row();
        }

        const titleHeader = query
            ? `<b>Conversations matching "${escapeHtml(query)}" (${result.totalCount}):</b>`
            : `<b>Select an existing conversation to assign to a topic (${result.totalCount} total):</b>`;

        return { text: titleHeader, keyboard };
    }

    // Command: /agy_help, /help, /start, /agy_start
    bot.command(['agy_help', 'help', 'start', 'agy_start'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);

        const helpText = `
<b>🤖 Antigravity CLI Mobile Remote</b>

<b>Current Workspace:</b> <code>${ws}</code>
<b>Active Conversation:</b> <code>${session?.conversationId || 'None (New)'}</code>

<b>Commands:</b>
• <code>/agy_new &lt;title&gt;</code> - Create a new topic & conversation
• <code>/agy_chats [query]</code> - Browse past Antigravity chats with pagination/search
• <code>/agy_projects</code> - View and select project workspace (creates a topic)
• <code>/agy_resume &lt;id&gt;</code> - Attach a specific conversation ID to this topic
• <code>/agy_bind &lt;workspace&gt;</code> - Bind this topic to a workspace folder
• <code>/agy_topic &lt;name&gt;</code> - Rename current topic
• <code>/agy_stop</code> - Stop current running task
• <code>/agy_status</code> - Show execution and session info
• <code>/agy_help</code> - Show this guide

<i>Note: Chatting in General is disabled. Every conversation must be in its own topic.</i>
        `.trim();

        await ctx.reply(helpText, { parse_mode: 'HTML' });
    });

    // Command: /agy_status, /status
    bot.command(['agy_status', 'status'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);
        const isRunning = agyService.isBusy(channelKey);

        const statusMsg = `
<b>📊 Session Status</b>
• <b>Workspace:</b> <code>${ws}</code>
• <b>Conversation:</b> <code>${session?.conversationId || 'Fresh'}</code>
• <b>Status:</b> ${isRunning ? '⚙️ Running task' : '💤 Idle (warm process)'}
        `.trim();

        await ctx.reply(statusMsg, { parse_mode: 'HTML' });
    });

    // Command: /agy_stop, /stop
    bot.command(['agy_stop', 'stop'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const stopped = agyService.stopSession(channelKey);
        if (stopped) {
            await ctx.reply('🛑 Stopped active task / closed warm process.');
        } else {
            await ctx.reply('No task is currently running in this topic.');
        }
    });

    // Command: /agy_new, /new [title] - Create a new topic & conversation
    bot.command(['agy_new', 'new'], async (ctx) => {
        const rawTitle = ctx.match?.trim();
        const title = rawTitle || `Chat ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        const currentChannelKey = getChannelKey(ctx);
        const currentWorkspace = resolveWorkspace(currentChannelKey);

        agyService.stopSession(currentChannelKey);

        const newTopicId = await createConversationTopic(ctx, title);

        if (newTopicId && ctx.chat) {
            const newChannelKey = `${ctx.chat.id}:${newTopicId}`;

            const boundWs = db.getWorkspaceBinding(currentChannelKey);
            if (boundWs) {
                db.bindWorkspace(newChannelKey, boundWs, newTopicId);
            }

            await ctx.reply(`👉 Created conversation topic: <b>${escapeHtml(title)}</b>`, {
                parse_mode: 'HTML',
            });

            await ctx.api.sendMessage(
                ctx.chat.id,
                `✨ <b>New Conversation</b>\n📁 <b>Workspace:</b> <code>${currentWorkspace}</code>\n\nSend a message here to start chatting!`,
                { parse_mode: 'HTML', message_thread_id: newTopicId }
            );
        } else {
            db.deleteSession(currentChannelKey);
            await ctx.reply('✨ Started a fresh conversation. Next message will create a new session.');
        }
    });

    // Command: /agy_projects, /agy_project, /projects, /project
    bot.command(['agy_projects', 'agy_project', 'projects', 'project'], async (ctx) => {
        const workspaces = workspaceService.scanWorkspaces();
        if (workspaces.length === 0) {
            return ctx.reply(`No subdirectories found in <code>${workspaceService.getBaseDir()}</code>`, {
                parse_mode: 'HTML',
            });
        }

        const keyboard = new InlineKeyboard();
        for (let i = 0; i < workspaces.length; i++) {
            const ws = workspaces[i];
            keyboard.text(`📁 ${ws}`, `select_ws:${ws}`);
            if (i % 2 === 1) keyboard.row();
        }

        await ctx.reply('<b>Select a workspace to start a topic:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_chats, /chats [query] - List recent Antigravity conversations with pagination
    bot.command(['agy_chats', 'chats'], async (ctx) => {
        const query = ctx.match?.trim() || '';
        const searchResult = convService.search(query, 0, 5);
        const { text, keyboard } = buildChatsUI(searchResult, query);

        await ctx.reply(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Handle pagination callback for /chats
    bot.callbackQuery(/^chats_p:(\d+):(.*)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        const query = decodeURIComponent(ctx.match[2] || '');
        const searchResult = convService.search(query, page, 5);
        const { text, keyboard } = buildChatsUI(searchResult, query);

        await ctx.answerCallbackQuery();
        await ctx.editMessageText(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_resume, /resume <conversation_id>
    bot.command(['agy_resume', 'resume'], async (ctx) => {
        const convId = ctx.match?.trim();
        if (!convId) {
            return ctx.reply('Usage: <code>/agy_resume &lt;conversation-uuid&gt;</code>', { parse_mode: 'HTML' });
        }

        const threadId = ctx.message?.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        if (ctx.chat?.type === 'supergroup' && isGeneral) {
            const summary = convService.getSummary(convId);
            const title = summary?.title || `Resume ${convId.slice(0, 8)}`;
            const wsPath = summary?.workspacePath || workspaceService.getBaseDir();

            const newTopicId = await createConversationTopic(ctx, title);
            if (newTopicId && ctx.chat) {
                const newKey = `${ctx.chat.id}:${newTopicId}`;
                db.saveSession(newKey, wsPath, convId, newTopicId);

                await ctx.reply(`👉 Assigned chat to new topic: <b>${escapeHtml(title)}</b>`, { parse_mode: 'HTML' });
                await ctx.api.sendMessage(
                    ctx.chat.id,
                    `🔄 <b>Assigned Conversation:</b> <i>${escapeHtml(title)}</i>\n<code>${convId}</code>\n<b>Workspace:</b> <code>${wsPath}</code>\n\nSend a message here to resume!`,
                    { parse_mode: 'HTML', message_thread_id: newTopicId }
                );
                return;
            }
        }

        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        db.saveSession(channelKey, ws, convId, threadId);
        await ctx.reply(`✅ Linked this topic to conversation <code>${convId}</code>. Send a prompt to continue.`, {
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_bind, /bind <workspace>
    bot.command(['agy_bind', 'bind'], async (ctx) => {
        const wsName = ctx.match?.trim();
        if (!wsName) {
            return ctx.reply('Usage: <code>/agy_bind &lt;workspace_folder&gt;</code>', { parse_mode: 'HTML' });
        }

        try {
            const fullPath = workspaceService.resolveWorkspace(wsName);
            const channelKey = getChannelKey(ctx);
            const threadId = ctx.message?.message_thread_id;

            db.bindWorkspace(channelKey, wsName, threadId);
            await ctx.reply(`✅ Bound this topic to workspace: <b>${escapeHtml(wsName)}</b>\n<code>${fullPath}</code>`, {
                parse_mode: 'HTML',
            });
        } catch (err: any) {
            await ctx.reply(`❌ Error binding workspace: ${err.message}`);
        }
    });

    // Command: /agy_topic, /topic <new title>
    bot.command(['agy_topic', 'topic'], async (ctx) => {
        const newTitle = ctx.match?.trim();
        const threadId = ctx.message?.message_thread_id;
        if (!newTitle || !threadId || threadId === 1 || !ctx.chat) {
            return ctx.reply('Usage: <code>/agy_topic &lt;new title&gt;</code> inside a topic.', { parse_mode: 'HTML' });
        }

        await topicManager.renameTopic(ctx.chat.id, threadId, newTitle);
        await ctx.reply(`✅ Renamed topic to: <b>${escapeHtml(newTitle)}</b>`, { parse_mode: 'HTML' });
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
                const channelKey = getChannelKey(ctx);
                db.bindWorkspace(channelKey, wsName);
                db.deleteSession(channelKey);

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
            const channelKey = getChannelKey(ctx);
            const wsPath = match.workspacePath || resolveWorkspace(channelKey);
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
        const keyboard = new InlineKeyboard();
        for (let i = 0; i < workspaces.length; i++) {
            const ws = workspaces[i];
            keyboard.text(`📁 ${ws}`, `select_ws:${ws}`);
            if (i % 2 === 1) keyboard.row();
        }
        await ctx.reply('<b>Select a workspace to start a topic:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    bot.callbackQuery('cmd_chats', async (ctx) => {
        await ctx.answerCallbackQuery();
        const searchResult = convService.search('', 0, 5);
        const { text, keyboard } = buildChatsUI(searchResult, '');
        await ctx.reply(text, {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Handle incoming messages (Text and Photos)
    bot.on(['message:text', 'message:photo'], async (ctx) => {
        const threadId = ctx.message.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        // RULE 1: No chatting directly in General chat
        if (ctx.chat.type === 'supergroup' && isGeneral) {
            const keyboard = new InlineKeyboard()
                .text('📁 Browse Projects', 'cmd_projects')
                .text('📜 Existing Chats', 'cmd_chats');

            await ctx.reply(
                '⚠️ <b>Chatting in General is disabled.</b>\n\n' +
                'Every conversation must have its own topic:\n' +
                '• <code>/agy_new &lt;title&gt;</code> - Create a new topic & chat\n' +
                '• <code>/agy_projects</code> - Pick a project workspace\n' +
                '• <code>/agy_chats</code> - Assign an existing chat to a topic',
                { parse_mode: 'HTML', reply_markup: keyboard }
            );
            return;
        }

        let userPrompt = ctx.message.text || ctx.message.caption || '';

        // If photo attached, download it and append path to prompt
        if (ctx.message.photo && ctx.message.photo.length > 0) {
            const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
            try {
                const localPath = await downloadTelegramPhoto(ctx.api, largestPhoto.file_id);
                userPrompt = `${userPrompt}\n[Attached user screenshot: ${localPath}]`.trim();
            } catch (err: any) {
                logger.error('[Bot] Failed to download photo:', err);
                await ctx.reply('⚠️ Warning: Failed to download attached image.');
            }
        }

        if (!userPrompt) {
            return;
        }

        // RULE 2: Catch unrecognized slash commands so they don't get sent to Antigravity CLI as heavy prompts!
        if (userPrompt.startsWith('/')) {
            const cmd = userPrompt.split(/[\s@]/)[0];
            await ctx.reply(
                `❓ Unknown command: <code>${escapeHtml(cmd)}</code>\n\nUse /agy_help to see all available commands.`,
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
            return;
        }

        const channelKey = getChannelKey(ctx);

        if (agyService.isBusy(channelKey)) {
            await ctx.reply('⏳ Antigravity is busy running another task in this conversation. Use /agy_stop to cancel it.', {
                message_thread_id: threadId,
            });
            return;
        }

        const workspacePath = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);

        const initialStatus = await ctx.reply('🧠 <i>Antigravity is thinking...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        let lastEditTime = Date.now();
        let lastRenderedText = '';
        let activeToolName: string | null = null;

        const updateTelegramStatus = async (force: boolean = false) => {
            const now = Date.now();
            if (!force && now - lastEditTime < 1500) {
                return;
            }
            lastEditTime = now;

            let displayText = lastRenderedText.trim();
            if (activeToolName) {
                displayText += `\n\n⚙️ <i>Executing: ${activeToolName}...</i>`;
            }

            if (!displayText) {
                displayText = '🧠 <i>Antigravity is working...</i>';
            }

            try {
                const formatted = formatForTelegram(displayText);
                const truncated = formatted.length > 4000 ? formatted.slice(-4000) : formatted;
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    initialStatus.message_id,
                    truncated,
                    { parse_mode: 'HTML' }
                );
            } catch (err: any) {
                if (!err.message?.includes('message is not modified')) {
                    logger.debug('[Bot] editMessageText error:', err.message);
                }
            }
        };

        try {
            const result = await agyService.executeTurn(channelKey, {
                workspacePath,
                conversationId: session?.conversationId,
                prompt: userPrompt,
                autoApprove: config.autoApprove,
                model: config.defaultModel,
                onInit: (convId) => {
                    db.saveSession(channelKey, workspacePath, convId, threadId);
                },
                onDelta: (_delta, fullText) => {
                    lastRenderedText = fullText;
                    updateTelegramStatus(false);
                },
                onToolCall: (toolName, _params) => {
                    activeToolName = toolName;
                    updateTelegramStatus(false);
                },
                onToolDone: (_toolName, _output) => {
                    activeToolName = null;
                    updateTelegramStatus(false);
                },
            });

            // Save conversation ID
            if (result.conversationId) {
                db.saveSession(channelKey, workspacePath, result.conversationId, threadId);
            }

            // Final delivery
            const finalResponse = result.response || lastRenderedText || '<i>Done.</i>';
            const formatted = formatForTelegram(finalResponse);
            const chunks = splitTelegramHtml(formatted);

            // Edit the initial message with the first chunk
            await ctx.api.editMessageText(
                ctx.chat.id,
                initialStatus.message_id,
                chunks[0],
                { parse_mode: 'HTML' }
            );

            // Send remaining chunks as subsequent messages if response is long
            for (let i = 1; i < chunks.length; i++) {
                await ctx.reply(chunks[i], {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                });
            }

        } catch (err: any) {
            logger.error('[Bot] Execution error:', err);
            await ctx.api.editMessageText(
                ctx.chat.id,
                initialStatus.message_id,
                `❌ <b>Error:</b> ${err?.message || err}`,
                { parse_mode: 'HTML' }
            );
        }
    });

    return { bot, db };
}
