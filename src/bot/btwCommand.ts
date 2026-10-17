import { spawn } from 'child_process';
import readline from 'readline';
import { Context } from 'grammy';
import { BotServices } from './types';
import { escapeHtml } from '../utils/telegramFormatter';
import { deliverTurnResponse } from './turnDelivery';
import { logger } from '../utils/logger';

export function executeOneShotBtw(
    workspacePath: string,
    question: string,
    model?: string,
    timeoutMs: number = 90000,
    spawnFn: typeof spawn = spawn
): Promise<string> {
    return new Promise((resolve, reject) => {
        const agyArgs = [
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--new-project',
        ];
        if (model) {
            agyArgs.push('--model', model);
        }

        const proc = spawnFn('agy', agyArgs, {
            cwd: workspacePath,
            env: {
                ...process.env,
                PAGER: 'cat',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let accumulated = '';
        let lastResultResponse = '';
        let timer: NodeJS.Timeout | null = setTimeout(() => {
            if (!proc.killed) {
                proc.kill('SIGTERM');
                reject(new Error('Side question timed out after 90s'));
            }
        }, timeoutMs);

        const rl = readline.createInterface({
            input: proc.stdout!,
            crlfDelay: Infinity,
        });

        rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                const event = JSON.parse(trimmed);
                if (event.event === 'step_update') {
                    const step = event.step_update;
                    if (step?.step_type === 'agent_response' && step.text_delta) {
                        accumulated += step.text_delta;
                    }
                } else if (event.event === 'result') {
                    if (event.result?.response) {
                        lastResultResponse = event.result.response;
                    }
                }
            } catch {}
        });

        proc.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });

        proc.on('close', (code) => {
            if (timer) clearTimeout(timer);
            const final = lastResultResponse || accumulated;
            if (final) {
                resolve(final.trim());
            } else if (code !== 0) {
                reject(new Error(`Antigravity exited with code ${code}`));
            } else {
                resolve('No response generated.');
            }
        });

        const payload = JSON.stringify({
            event: 'user',
            message: {
                content: question,
            },
        }) + '\n';

        proc.stdin?.write(payload, 'utf-8');
        proc.stdin?.end();
    });
}

export function registerBtwCommand(services: BotServices): void {
    const { bot, db, config } = services;

    bot.command(['agy_btw', 'btw'], async (ctx: Context) => {
        const threadId = ctx.message?.message_thread_id;
        const channelKey = services.getChannelKey(ctx);
        const workspacePath = services.resolveWorkspace(channelKey);

        const match = ctx.message?.text?.match(/^\/(?:agy_)?btw(?:\s+([\s\S]+))?$/i);
        let question = match?.[1]?.trim();

        // Check if replying to another message
        const replyTo = ctx.message?.reply_to_message;
        if (replyTo) {
            const replyText = replyTo.text || replyTo.caption || '';
            if (replyText.trim()) {
                question = question
                    ? `[Context]: """\n${replyText.trim()}\n"""\n\n[Question]: ${question}`
                    : `Please answer or explain this concisely:\n"""\n${replyText.trim()}\n"""`;
            }
        }

        if (!question) {
            await ctx.reply(
                '💡 <b>Ask a side question with /btw:</b>\n\n' +
                'Usage: <code>/btw &lt;question&gt;</code>\n' +
                'Or reply to any message with <code>/btw [question]</code>.\n\n' +
                '<i>Runs in parallel without interrupting active tasks or polluting conversation history.</i>',
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
            return;
        }

        const preview = question.length > 60 ? `${question.slice(0, 57)}...` : question;
        const statusMsg = await ctx.reply('💡 <i>Thinking (BTW side question)...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        const model = db.getModel(channelKey) || config.defaultModel;

        try {
            const answer = await executeOneShotBtw(workspacePath, question, model);

            try {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    `💡 <b>BTW:</b> <code>${escapeHtml(preview)}</code>`,
                    { parse_mode: 'HTML' }
                );
            } catch {}

            await deliverTurnResponse(bot, ctx.chat!.id, threadId, answer, false, '', workspacePath);
        } catch (err: any) {
            logger.error('[BTW] Error answering side question:', err);
            try {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    `⚠️ <b>BTW Error:</b> ${escapeHtml(err.message || 'Failed to answer side question.')}`,
                    { parse_mode: 'HTML' }
                );
            } catch {}
        }
    });
}
