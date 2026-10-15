import { exec } from 'child_process';
import { InlineKeyboard } from 'grammy';
import { BotServices } from './types';
import { buildChatsUI, buildModelKeyboard, buildProjectsUI, buildStopKeyboard } from './keyboards';
import { taskManager } from '../services/taskManager';
import { escapeHtml, formatAccountQuota } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export function registerBotCommands(services: BotServices): void {
    const { bot, config, db, workspaceService, topicManager, convService, agyService } = services;

    // Register commands with Telegram so they appear in autocomplete menu
    bot.api.setMyCommands([
        { command: 'help', description: 'Show guide and all available commands' },
        { command: 'new', description: 'Create a new topic & conversation' },
        { command: 'bind', description: 'Bind topic to any folder path (/cd, /workspace)' },
        { command: 'model', description: 'Switch active AI model' },
        { command: 'status', description: 'Show session, workspace, and process status' },
        { command: 'queue', description: 'View queued messages & force execute now' },
        { command: 'stop', description: 'Stop currently executing task' },
        { command: 'kill', description: 'Kill background dev server or process' },
        { command: 'restart', description: 'Restart session daemon & reload MCP tools' },
        { command: 'compact', description: 'Compact conversation context' },
        { command: 'quota', description: 'Show account quota and limits (/usage)' },
        { command: 'projects', description: 'Browse workspace projects' },
        { command: 'chats', description: 'Browse and assign existing chats' },
        { command: 'resume', description: 'Attach a conversation UUID' },
        { command: 'clear', description: 'Reset conversation in this topic' },
        { command: 'topic', description: 'Rename current topic' },
    ]).catch((err) => logger.warn('[Bot] Failed to set bot commands menu:', err.message));

    // Command: /agy_help, /help, /start, /agy_start
    bot.command(['agy_help', 'help', 'start', 'agy_start'], async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const ws = services.resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);
        const currentModel = db.getModel(channelKey) || session?.selectedModel || config.defaultModel || 'Default';

        const helpText = `
<b>🤖 Antigravity CLI Mobile Remote — Commands</b>

<b>Current Workspace:</b> <code>${ws}</code>
<b>Active Conversation:</b> <code>${session?.conversationId || 'None (New)'}</code>
<b>Model:</b> <code>${escapeHtml(currentModel)}</code>

<b>Topic & Workspace:</b>
• <code>/new &lt;title&gt;</code> (or <code>/agy_new</code>) - Create new topic & conversation
• <code>/bind &lt;path&gt;</code> (or <code>/cd</code>, <code>/workspace</code>) - Bind to any folder path (~, /Users/..., etc.)
• <code>/projects</code> - Browse projects and auto-create topic
• <code>/topic &lt;name&gt;</code> - Rename current topic
• <code>/clear</code> (or <code>/reset</code>) - Reset conversation in this topic

<b>Control & Execution:</b>
• <code>/model [name]</code> - View or switch active model (Flash, Sonnet, Opus)
• <code>/status</code> - View session, active workspaces, and background servers
• <code>/queue</code> - View queued messages, force run now, or clear queue
• <code>/stop</code> - Cancel current running task
• <code>/kill [pid]</code> - Terminate background server or task
• <code>/restart</code> - Restart warm session daemon & reload tools
• <code>! &lt;cmd&gt;</code> - Direct shell execution (e.g. <code>! git status</code>, <code>! npm test</code>)

<b>History & Context:</b>
• <code>/chats [query]</code> - Browse past Antigravity chats with search
• <code>/resume &lt;id&gt;</code> - Attach an existing conversation ID
• <code>/compact [focus]</code> - Compact transcript & context window
• <code>/quota</code> (or <code>/usage</code>) - Show remaining 5-hour and weekly quota

<b>Input & Large Logs:</b>
• Paste massive logs (automatically assembled from split messages)
• Send <code>.log</code>, <code>.txt</code>, <code>.json</code> document files or screenshots

<b>Antigravity Slash Commands:</b>
• <code>/plan</code>, <code>/goal</code>, <code>/learn</code>, <code>/grill-me</code>, <code>/boost</code>, <code>/browser</code>, <code>/schedule</code>, <code>/caveman</code>, <code>/ponytail</code>, <code>/review</code>, <code>/audit</code>
        `.trim();

        await ctx.reply(helpText, { parse_mode: 'HTML' });
    });

    // Command: /agy_usage - Show overall Antigravity account quota and limits
    bot.command('agy_usage', async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const statusMsg = await ctx.reply('⏳ <i>Fetching account quota & usage...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        exec('agy --print "/usage"', {
            timeout: 15000,
            env: { ...process.env, PAGER: 'cat' },
        }, async (error, stdout, stderr) => {
            if (error && !stdout) {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    `❌ <b>Failed to fetch account quota:</b> ${escapeHtml(error.message)}`,
                    { parse_mode: 'HTML' }
                );
                return;
            }

            const raw = (stdout || stderr || '').trim();
            const message = formatAccountQuota(raw);

            try {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    message,
                    { parse_mode: 'HTML' }
                );
            } catch (err: any) {
                if (!err.message?.includes('message is not modified')) {
                    logger.error('[Bot] Error editing account usage message:', err);
                }
            }
        });
    });

    // Command: /usage - Show current conversation session token statistics
    bot.command('usage', async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const session = db.getSession(channelKey);

        if (!session || !session.conversationId) {
            return ctx.reply('No active conversation tracked in this topic yet. Send a prompt to begin.');
        }

        const formatNum = (n: number) => n.toLocaleString();

        const usageText = `
<b>📊 Session Token Usage</b>
• <b>Conversation:</b> <code>${session.conversationId}</code>
• <b>Total Turns:</b> ${formatNum(session.totalTurns || 1)}

<b>Latest Turn:</b>
• <b>Input:</b> ${formatNum(session.lastInputTokens)} tokens
• <b>Output:</b> ${formatNum(session.lastOutputTokens)} tokens
• <b>Thinking:</b> ${formatNum(session.lastThinkingTokens)} tokens
• <b>Cached Context:</b> ${formatNum(session.lastCacheTokens)} tokens
• <b>Turn Total:</b> ${formatNum(session.lastTotalTokens)} tokens
• <b>Execution Time:</b> ${session.lastDurationSeconds.toFixed(1)}s

<b>Session Cumulative:</b>
• <b>Total Input:</b> ${formatNum(session.totalInputTokens)} tokens
• <b>Total Output:</b> ${formatNum(session.totalOutputTokens)} tokens
        `.trim();

        await ctx.reply(usageText, { parse_mode: 'HTML' });
    });

    // Command: /agy_model, /model [name]
    bot.command(['agy_model', 'model'], async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const targetModel = ctx.match?.trim();

        if (targetModel) {
            db.setModel(channelKey, targetModel);
            return ctx.reply(
                `✅ <b>Model set to:</b> <code>${escapeHtml(targetModel)}</code>\n\nSubsequent prompts in this topic will run on this model.`,
                { parse_mode: 'HTML' }
            );
        }

        const currentModel = db.getModel(channelKey) || config.defaultModel || 'gemini-3.8-flash-high';
        const keyboard = buildModelKeyboard(currentModel);

        await ctx.reply(
            `🤖 <b>Model Selection</b>\n\n` +
            `Current model for this topic:\n<code>${escapeHtml(currentModel)}</code>\n\n` +
            `Choose a model below or type <code>/model &lt;name&gt;</code>:`,
            {
                parse_mode: 'HTML',
                reply_markup: keyboard,
                message_thread_id: ctx.message?.message_thread_id,
            }
        );
    });

    // Command: /agy_compact, /compact [focus]
    bot.command(['agy_compact', 'compact'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const isGeneral = !threadId || threadId === 1;

        if (ctx.chat?.type === 'supergroup' && isGeneral) {
            return ctx.reply('⚠️ Please run /compact inside a specific conversation topic.');
        }

        const channelKey = services.getChannelKey(ctx);
        const session = db.getSession(channelKey);
        if (!session || !session.conversationId) {
            return ctx.reply('⚠️ No active conversation in this topic to compact. Send a prompt to start one.');
        }

        if (agyService.isBusy(channelKey)) {
            return ctx.reply('⏳ Antigravity is busy running another task. Wait for it to finish or send /agy_stop.');
        }

        const focus = ctx.match?.trim();
        const compactPrompt = focus ? `/compact ${focus}` : '/compact';
        const workspacePath = services.resolveWorkspace(channelKey);

        const statusMsg = await ctx.reply('🗜️ <i>Compacting conversation transcript & context...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        services.executeTurnWithStatus(
            channelKey,
            workspacePath,
            compactPrompt,
            ctx.chat!.id,
            threadId,
            statusMsg.message_id
        ).catch((err) => {
            logger.error('[Bot] Compact error:', err);
        });
    });

    // Command: /agy_clear, /agy_reset, /clear, /reset
    bot.command(['agy_clear', 'agy_reset', 'clear', 'reset'], async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        agyService.stopSession(channelKey);
        db.deleteSession(channelKey);

        await ctx.reply(
            '🧹 <b>Conversation Reset</b>\n\n' +
            'Cleared active conversation in this topic. Your workspace binding is kept.\n' +
            'Next message will start a fresh session.',
            { parse_mode: 'HTML' }
        );
    });

    // Command: /agy_queue, /queue
    bot.command(['agy_queue', 'queue'], async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const queue = db.getQueuedMessages(channelKey);
        const isRunning = agyService.isBusy(channelKey);

        if (queue.length === 0) {
            return ctx.reply(
                `📭 <b>Message Queue is Empty</b>\nActive task: ${isRunning ? '⚙️ Running' : '💤 Idle'}`,
                { parse_mode: 'HTML' }
            );
        }

        let queueList = `📬 <b>Queued Messages (${queue.length}):</b>\n\n`;
        queue.forEach((item, idx) => {
            const preview = item.prompt.length > 50 ? `${item.prompt.slice(0, 47)}...` : item.prompt;
            queueList += `${idx + 1}. <code>${escapeHtml(preview)}</code>\n`;
        });

        const keyboard = new InlineKeyboard();
        queue.slice(0, 5).forEach((item, idx) => {
            const preview = item.prompt.length > 25 ? `${item.prompt.slice(0, 22)}...` : item.prompt;
            keyboard.text(`⚡ Force #${idx + 1}: ${preview}`, `q_force:${item.id}`).row();
        });
        keyboard.text('🗑️ Clear Queue', 'clear_queue');

        await ctx.reply(queueList, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
        });
    });

    // Command: /agy_status, /status
    bot.command(['agy_status', 'status'], async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const ws = services.resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);
        const currentModel = db.getModel(channelKey) || session?.selectedModel || config.defaultModel || 'Default';
        const isRunning = agyService.isBusy(channelKey);
        const queue = db.getQueuedMessages(channelKey);
        const queueLine = queue.length > 0 ? `\n• <b>Queue:</b> ${queue.length} message(s) waiting` : '';

        const runningTasks = await taskManager.getRunningTasks(channelKey, ws);
        let taskSection = '';
        if (runningTasks.length > 0) {
            taskSection = '\n\n<b>Active Background Servers / Tasks:</b>\n' +
                runningTasks.map((t) => `• ⚙️ <b>${escapeHtml(t.name)}</b> (PID ${t.pid}${t.port ? ` · port ${t.port}` : ''})`).join('\n');
        }

        let wsSection = `• <b>Workspace:</b> <code>${ws}</code>`;
        if (session?.conversationId) {
            const summary = convService.getSummary(session.conversationId);
            const convWorkspaces = summary?.workspacePaths || [];
            if (convWorkspaces.length > 1) {
                wsSection = `• <b>Bound Workspace:</b> <code>${ws}</code>\n• <b>Active Workspaces (${convWorkspaces.length}):</b>\n` +
                    convWorkspaces.map((w) => `  ▫️ <code>${w}</code>`).join('\n');
            } else if (convWorkspaces.length === 1 && convWorkspaces[0] && convWorkspaces[0] !== ws) {
                wsSection = `• <b>Bound Workspace:</b> <code>${ws}</code>\n• <b>Active Workspace:</b> <code>${convWorkspaces[0]}</code>`;
            }
        }

        const statusMsg = `
<b>📊 Session Status</b>
${wsSection}
• <b>Model:</b> <code>${escapeHtml(currentModel)}</code>
• <b>Conversation:</b> <code>${session?.conversationId || 'Fresh'}</code>
• <b>Status:</b> ${isRunning ? '⚙️ Running task' : '💤 Idle (warm process)'}${queueLine}${taskSection}
        `.trim();

        const keyboard = buildStopKeyboard(runningTasks);

        await ctx.reply(statusMsg, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
        });
    });

    // Command: /agy_kill, /kill [pid] - Cancel/kill last running command or background server
    bot.command(['agy_kill', 'kill'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const channelKey = services.getChannelKey(ctx);
        const ws = services.resolveWorkspace(channelKey);
        const targetArg = ctx.match?.trim();

        if (targetArg && /^\d+$/.test(targetArg)) {
            const pid = parseInt(targetArg, 10);
            const killed = taskManager.killProcess(pid);
            return ctx.reply(
                killed ? `🛑 Sent kill signal to PID <code>${pid}</code>.` : `PID <code>${pid}</code> not found or already exited.`,
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
        }

        const runningTasks = await taskManager.getRunningTasks(channelKey, ws);
        const wasAgyBusy = agyService.isBusy(channelKey);
        if (wasAgyBusy) {
            agyService.stopSession(channelKey);
        }

        if (runningTasks.length === 0 && !wasAgyBusy) {
            return ctx.reply('No active commands or background servers running in this topic.', {
                message_thread_id: threadId,
            });
        }

        const killedNames: string[] = [];
        for (const task of runningTasks) {
            taskManager.killProcess(task.pid);
            killedNames.push(`${task.name} (PID ${task.pid})`);
        }

        const agyNote = wasAgyBusy ? '• Stopped active Antigravity task\n' : '';
        const taskNote = killedNames.length > 0 ? killedNames.map((k) => `• Stopped ${k}`).join('\n') : '';

        await ctx.reply(`🛑 <b>Cancelled:</b>\n${agyNote}${taskNote}`, {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });
    });

    // Command: /agy_stop, /stop - Stop running agy turn, clear queue, and stop background processes
    bot.command(['agy_stop', 'stop'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const channelKey = services.getChannelKey(ctx);
        const ws = services.resolveWorkspace(channelKey);
        const stoppedAgy = agyService.stopSession(channelKey);
        const queueCount = db.clearQueue(channelKey);

        const runningTasks = await taskManager.getRunningTasks(channelKey, ws);
        for (const task of runningTasks) {
            taskManager.killProcess(task.pid);
        }

        const parts: string[] = [];
        if (stoppedAgy) parts.push('active Antigravity task');
        if (runningTasks.length > 0) parts.push(`${runningTasks.length} background process(es) [${runningTasks.map(t => t.name).join(', ')}]`);
        if (queueCount > 0) parts.push(`${queueCount} queued message(s)`);

        if (parts.length > 0) {
            await ctx.reply(`🛑 <b>Stopped:</b> ${escapeHtml(parts.join(', '))}.`, {
                parse_mode: 'HTML',
                message_thread_id: threadId,
            });
        } else {
            await ctx.reply('No active task or background server running in this topic.', {
                message_thread_id: threadId,
            });
        }
    });

    // Command: /agy_restart, /restart - Restart warm session daemon and reload MCP tools/environment
    bot.command(['agy_restart', 'restart'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const channelKey = services.getChannelKey(ctx);
        const session = db.getSession(channelKey);

        const statusMsg = await ctx.reply('🔄 <i>Restarting session daemon...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        await agyService.restartSession(channelKey);

        const convText = session?.conversationId
            ? `\n• <b>Conversation:</b> <code>${session.conversationId}</code> (preserved)`
            : '';

        const replyText = `✅ <b>Session Restarted</b>${convText}\n\nBackground daemon was stopped. Your next message will launch a fresh Antigravity session with updated MCP tools and environment.`;

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, replyText, {
            parse_mode: 'HTML',
        }).catch(async () => {
            await ctx.reply(replyText, { parse_mode: 'HTML', message_thread_id: threadId });
        });
    });

    // Command: /agy_new, /new [title] - Create a new topic & conversation
    bot.command(['agy_new', 'new'], async (ctx) => {
        const rawTitle = ctx.match?.trim();
        const title = rawTitle || `Chat ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        const currentChannelKey = services.getChannelKey(ctx);
        const currentWorkspace = services.resolveWorkspace(currentChannelKey);

        agyService.stopSession(currentChannelKey);

        const newTopicId = await services.createConversationTopic(ctx, title);

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

        const keyboard = buildProjectsUI(workspaces);

        await ctx.reply('<b>Select a workspace to start a topic:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_chats, /chats [query] - List recent Antigravity conversations with pagination
    bot.command(['agy_chats', 'chats'], async (ctx) => {
        const query = ctx.match?.trim() || '';
        const searchResult = convService.search(query, 0, 5);
        const { text, keyboard } = buildChatsUI(services.convCache, searchResult, query);

        await ctx.reply(text, {
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

            const newTopicId = await services.createConversationTopic(ctx, title);
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

        const channelKey = services.getChannelKey(ctx);
        const ws = services.resolveWorkspace(channelKey);
        db.saveSession(channelKey, ws, convId, threadId);
        await ctx.reply(`✅ Linked this topic to conversation <code>${convId}</code>. Send a prompt to continue.`, {
            parse_mode: 'HTML',
        });
    });

    // Command: /agy_bind, /bind, /cd, /workspace <folder>
    bot.command(['agy_bind', 'bind', 'cd', 'workspace'], async (ctx) => {
        const wsName = ctx.match?.trim();
        if (!wsName) {
            return ctx.reply('Usage: <code>/bind &lt;workspace_folder_or_path&gt;</code>', { parse_mode: 'HTML' });
        }

        try {
            const fullPath = workspaceService.resolveWorkspace(wsName);
            const channelKey = services.getChannelKey(ctx);
            const threadId = ctx.message?.message_thread_id;

            db.bindWorkspace(channelKey, fullPath, threadId);
            await ctx.reply(`✅ Bound this topic to workspace:\n<code>${escapeHtml(fullPath)}</code>`, {
                parse_mode: 'HTML',
            });
        } catch (err: any) {
            await ctx.reply(`❌ Error binding workspace: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
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
}
