import { ChildProcess, exec } from 'child_process';
import { logger } from '../utils/logger';

export interface RunningTask {
    pid: number;
    name: string;
    cmd: string;
    port?: number;
    channelKey?: string;
    workspacePath: string;
    startTime: number;
    source: 'shell' | 'workspace_daemon';
}

export class TaskManager {
    // In-memory registry for processes spawned by mobile-friendly-agy (e.g. ! nr start)
    private trackedProcesses = new Map<number, {
        pid: number;
        child: ChildProcess;
        cmd: string;
        channelKey: string;
        workspacePath: string;
        chatId: number;
        messageId: number;
        threadId?: number;
        outputBuffer: string;
        startTime: number;
    }>();

    public registerProcess(
        pid: number,
        child: ChildProcess,
        cmd: string,
        channelKey: string,
        workspacePath: string,
        chatId: number,
        messageId: number,
        threadId?: number
    ): void {
        this.trackedProcesses.set(pid, {
            pid,
            child,
            cmd,
            channelKey,
            workspacePath,
            chatId,
            messageId,
            threadId,
            outputBuffer: '',
            startTime: Date.now(),
        });

        child.on('close', () => {
            this.trackedProcesses.delete(pid);
        });
        child.on('error', () => {
            this.trackedProcesses.delete(pid);
        });
    }

    public appendOutput(pid: number, chunk: string): void {
        const item = this.trackedProcesses.get(pid);
        if (item) {
            item.outputBuffer += chunk;
            if (item.outputBuffer.length > 500000) {
                item.outputBuffer = item.outputBuffer.slice(-250000);
            }
        }
    }

    public getTrackedProcess(pid: number) {
        return this.trackedProcesses.get(pid);
    }

    public unregisterProcess(pid: number): void {
        this.trackedProcesses.delete(pid);
    }

    /**
     * Kill a process and its process tree
     */
    public killProcess(pid: number): boolean {
        const tracked = this.trackedProcesses.get(pid);
        let killed = false;

        try {
            // Kill entire process group if detached
            process.kill(-pid, 'SIGTERM');
            killed = true;
        } catch {
            try {
                process.kill(pid, 'SIGTERM');
                killed = true;
            } catch {}
        }

        if (tracked) {
            try {
                tracked.child.kill('SIGTERM');
            } catch {}
            this.trackedProcesses.delete(pid);
        }

        // Force kill via shell kill -9 as guaranteed fallback for rogue daemons
        try {
            exec(`kill -9 ${pid} 2>/dev/null`, () => {});
            exec(`pkill -P ${pid} 2>/dev/null`, () => {});
            killed = true;
        } catch {}

        return killed;
    }

    /**
     * Get all active tasks for a given workspace and topic
     * Includes:
     * 1. Tracked processes spawned via `!` in this topic
     * 2. Background dev servers (like Metro on port 8081, Expo, Vite, Next.js) running in workspacePath
     */
    public async getRunningTasks(channelKey: string, workspacePath: string): Promise<RunningTask[]> {
        const tasks: RunningTask[] = [];
        const seenPids = new Set<number>();

        // 1. Check tracked shell processes for this topic
        for (const [pid, item] of this.trackedProcesses.entries()) {
            if (item.channelKey === channelKey || item.workspacePath === workspacePath) {
                tasks.push({
                    pid,
                    name: formatProcessName(item.cmd),
                    cmd: item.cmd,
                    channelKey: item.channelKey,
                    workspacePath: item.workspacePath,
                    startTime: item.startTime,
                    source: 'shell',
                });
                seenPids.add(pid);
            }
        }

        // 2. Check workspace-specific daemons (like Metro bundler / Expo / Next.js)
        try {
            const externalTasks = await this.detectWorkspaceServers(workspacePath);
            for (const ext of externalTasks) {
                if (!seenPids.has(ext.pid)) {
                    tasks.push(ext);
                    seenPids.add(ext.pid);
                }
            }
        } catch (err: any) {
            logger.debug('[TaskManager] Error scanning workspace servers:', err.message);
        }

        return tasks;
    }

    /**
     * Detect servers running on dev ports or matching workspacePath
     */
    private detectWorkspaceServers(workspacePath: string): Promise<RunningTask[]> {
        return new Promise((resolve) => {
            // Check Metro port 8081 specifically first (most relevant for React Native / Expo projects)
            exec('lsof -i :8081 -F p -sTCP:LISTEN', (err, stdout) => {
                const results: RunningTask[] = [];
                if (!err && stdout) {
                    const match = stdout.match(/p(\d+)/);
                    if (match) {
                        const pid = parseInt(match[1], 10);
                        if (pid && pid !== process.pid) {
                            try {
                                exec(`ps -ww -p ${pid} -o command=`, (psErr, psOut) => {
                                    const fullCmd = psOut ? psOut.trim() : '';
                                    if (!psErr && fullCmd) {
                                        const isWorkspaceOrExpo = fullCmd.includes(workspacePath) ||
                                            fullCmd.includes('expo') ||
                                            fullCmd.includes('metro') ||
                                            fullCmd.includes('react-native');
                                        if (isWorkspaceOrExpo) {
                                            results.push({
                                                pid,
                                                name: 'Metro Bundler (port 8081)',
                                                cmd: fullCmd,
                                                port: 8081,
                                                workspacePath,
                                                startTime: Date.now(),
                                                source: 'workspace_daemon',
                                            });
                                        }
                                    }
                                    resolve(results);
                                });
                                return;
                            } catch {}
                        }
                    }
                }
                resolve(results);
            });
        });
    }
}

function formatProcessName(cmd: string): string {
    const trimmed = cmd.trim();
    if (trimmed.includes('expo start') || trimmed.includes('metro') || trimmed.includes('nr start')) {
        return 'Metro Bundler';
    }
    if (trimmed.includes('next dev')) return 'Next.js Dev Server';
    if (trimmed.includes('vite')) return 'Vite Dev Server';
    const firstWord = trimmed.split(/\s+/)[0];
    return firstWord.length > 20 ? `${firstWord.slice(0, 18)}...` : trimmed.slice(0, 25);
}

export const taskManager = new TaskManager();
