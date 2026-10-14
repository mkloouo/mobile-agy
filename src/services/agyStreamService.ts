import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import { logger } from '../utils/logger';

export interface TurnOptions {
    workspacePath: string;
    conversationId?: string;
    prompt: string;
    autoApprove?: boolean;
    model?: string;
    onInit?: (convId: string) => void;
    onDelta?: (delta: string, fullText: string) => void;
    onToolCall?: (toolName: string, params: any) => void;
    onToolDone?: (toolName: string, output: string) => void;
}

export interface TurnResult {
    status: 'SUCCESS' | 'ERROR' | 'STOPPED';
    response: string;
    durationSeconds: number;
    usage?: any;
    conversationId: string;
}

export class AgyStreamService {
    private activeProcesses: Map<string, ChildProcess> = new Map();

    /**
     * Stop any active execution for a session
     */
    public stopSession(sessionId: string): boolean {
        const proc = this.activeProcesses.get(sessionId);
        if (proc && !proc.killed) {
            logger.info(`[AgyStream] Terminating active process for session ${sessionId}`);
            proc.kill('SIGINT');
            this.activeProcesses.delete(sessionId);
            return true;
        }
        return false;
    }

    /**
     * Check if a session has a running task
     */
    public isBusy(sessionId: string): boolean {
        return this.activeProcesses.has(sessionId);
    }

    /**
     * Execute a prompt turn using `agy --input-format stream-json --output-format stream-json`
     */
    public executeTurn(sessionId: string, options: TurnOptions): Promise<TurnResult> {
        return new Promise((resolve, reject) => {
            if (this.isBusy(sessionId)) {
                return reject(new Error('A task is already running in this session. Send /stop to interrupt it first.'));
            }

            const args = [
                '--input-format', 'stream-json',
                '--output-format', 'stream-json',
            ];

            if (options.conversationId) {
                args.push('--conversation', options.conversationId);
            }

            if (options.autoApprove) {
                args.push('--dangerously-skip-permissions');
            }

            if (options.model) {
                args.push('--model', options.model);
            }

            logger.info(`[AgyStream] Spawning agy in "${options.workspacePath}" with args:`, args.join(' '));

            const proc = spawn('agy', args, {
                cwd: options.workspacePath,
                env: {
                    ...process.env,
                    PAGER: 'cat',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            this.activeProcesses.set(sessionId, proc);

            let currentConvId = options.conversationId || '';
            let accumulatedText = '';
            let isResolved = false;

            const rlOut = readline.createInterface({
                input: proc.stdout,
                crlfDelay: Infinity,
            });

            const rlErr = readline.createInterface({
                input: proc.stderr,
                crlfDelay: Infinity,
            });

            rlErr.on('line', (line) => {
                if (line.trim()) {
                    logger.warn(`[AgyStream STDERR] ${line}`);
                }
            });

            rlOut.on('line', (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;

                try {
                    const event = JSON.parse(trimmed);
                    this.handleEvent(event, {
                        setConvId: (id) => {
                            currentConvId = id;
                            if (options.onInit) options.onInit(id);
                        },
                        onDelta: (delta) => {
                            accumulatedText += delta;
                            if (options.onDelta) options.onDelta(delta, accumulatedText);
                        },
                        onToolCall: options.onToolCall,
                        onToolDone: options.onToolDone,
                        onResult: (result) => {
                            isResolved = true;
                            this.activeProcesses.delete(sessionId);
                            resolve({
                                status: result.status,
                                response: result.response || accumulatedText,
                                durationSeconds: result.duration_seconds || 0,
                                usage: result.usage,
                                conversationId: currentConvId || result.conversation_id,
                            });
                        },
                    });
                } catch (err: any) {
                    logger.debug(`[AgyStream] Non-JSON line from stdout: ${trimmed}`);
                }
            });

            proc.on('error', (err) => {
                logger.error(`[AgyStream] Process error:`, err);
                this.activeProcesses.delete(sessionId);
                if (!isResolved) {
                    isResolved = true;
                    reject(err);
                }
            });

            proc.on('close', (code, signal) => {
                this.activeProcesses.delete(sessionId);
                if (!isResolved) {
                    isResolved = true;
                    if (signal === 'SIGINT' || signal === 'SIGTERM') {
                        resolve({
                            status: 'STOPPED',
                            response: accumulatedText || '<i>Task was stopped.</i>',
                            durationSeconds: 0,
                            conversationId: currentConvId,
                        });
                    } else if (code !== 0) {
                        reject(new Error(`agy process exited with code ${code}`));
                    } else {
                        resolve({
                            status: 'SUCCESS',
                            response: accumulatedText,
                            durationSeconds: 0,
                            conversationId: currentConvId,
                        });
                    }
                }
            });

            // Write user prompt JSON line to stdin
            const inputMessage = JSON.stringify({
                event: 'user',
                message: {
                    content: options.prompt,
                },
            }) + '\n';

            proc.stdin.write(inputMessage, 'utf-8');
        });
    }

    private handleEvent(
        event: any,
        callbacks: {
            setConvId: (id: string) => void;
            onDelta: (delta: string) => void;
            onToolCall?: (toolName: string, params: any) => void;
            onToolDone?: (toolName: string, output: string) => void;
            onResult: (result: any) => void;
        }
    ): void {
        switch (event.event) {
            case 'init':
                if (event.conversation_id) {
                    callbacks.setConvId(event.conversation_id);
                }
                break;

            case 'step_update': {
                const step = event.step_update;
                if (!step) break;

                if (step.conversation_id) {
                    callbacks.setConvId(step.conversation_id);
                }

                if (step.step_type === 'agent_response' && step.text_delta) {
                    callbacks.onDelta(step.text_delta);
                } else if (step.step_type === 'tool') {
                    if (step.state === 'ACTIVE' && callbacks.onToolCall) {
                        callbacks.onToolCall(step.tool_name, step.tool_info?.parameters);
                    } else if (step.state === 'DONE' && callbacks.onToolDone) {
                        callbacks.onToolDone(step.tool_name, step.tool_info?.output);
                    }
                }
                break;
            }

            case 'result':
                callbacks.onResult(event.result);
                break;

            default:
                break;
        }
    }
}
