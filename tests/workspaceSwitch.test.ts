import { describe, it, expect, vi } from 'vitest';
import { registerWorkspaceCommands } from '../src/bot/workspaceCommands';
import { registerBotCommands } from '../src/bot/commands';

describe('Workspace Switch and Clear Lifecycle', () => {
    it('/bind restarts session daemon immediately to terminate old daemon', async () => {
        const commands: Record<string, (ctx: any) => Promise<any>> = {};
        const mockBot = {
            command: vi.fn((cmds: string | string[], handler: any) => {
                const arr = Array.isArray(cmds) ? cmds : [cmds];
                for (const c of arr) {
                    commands[c] = handler;
                }
            }),
        };

        const mockAgyService = {
            restartSession: vi.fn().mockResolvedValue(true),
            stopSession: vi.fn(),
        };

        const mockDb = {
            bindWorkspace: vi.fn(),
            getWorkspaceBinding: vi.fn(),
            deleteSession: vi.fn(),
        };

        const mockWorkspaceService = {
            resolveWorkspace: vi.fn().mockReturnValue('/Users/mkloouo/Projects/pi-example-usages'),
            scanWorkspaces: vi.fn().mockReturnValue([]),
            getBaseDir: vi.fn().mockReturnValue('/Users/mkloouo/Projects'),
        };

        const services: any = {
            bot: mockBot,
            db: mockDb,
            agyService: mockAgyService,
            workspaceService: mockWorkspaceService,
            getChannelKey: vi.fn().mockReturnValue('123:456'),
            resolveWorkspace: vi.fn().mockReturnValue('/Users/mkloouo/Projects'),
        };

        registerWorkspaceCommands(services);

        expect(commands['bind']).toBeDefined();

        const ctx = {
            match: 'pi-example-usages',
            message: { message_thread_id: 456 },
            reply: vi.fn().mockResolvedValue({}),
        };

        await commands['bind'](ctx);

        expect(mockWorkspaceService.resolveWorkspace).toHaveBeenCalledWith('pi-example-usages');
        expect(mockDb.bindWorkspace).toHaveBeenCalledWith('123:456', '/Users/mkloouo/Projects/pi-example-usages', 456);
        expect(mockAgyService.restartSession).toHaveBeenCalledWith('123:456');
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining('Bound this topic to workspace'),
            expect.objectContaining({ parse_mode: 'HTML' })
        );
    });

    it('/clear restarts session daemon and deletes session', async () => {
        const commands: Record<string, (ctx: any) => Promise<any>> = {};
        const mockBot = {
            api: { setMyCommands: vi.fn().mockResolvedValue(true) },
            command: vi.fn((cmds: string | string[], handler: any) => {
                const arr = Array.isArray(cmds) ? cmds : [cmds];
                for (const c of arr) {
                    commands[c] = handler;
                }
            }),
        };

        const mockAgyService = {
            restartSession: vi.fn().mockResolvedValue(true),
            stopSession: vi.fn(),
        };

        const mockDb = {
            deleteSession: vi.fn(),
            getQueuedMessages: vi.fn().mockReturnValue([]),
            clearQueue: vi.fn().mockReturnValue(0),
        };

        const services: any = {
            bot: mockBot,
            db: mockDb,
            agyService: mockAgyService,
            config: { defaultModel: 'gemini-3.8-flash-medium' },
            getChannelKey: vi.fn().mockReturnValue('123:456'),
        };

        registerBotCommands(services);

        expect(commands['clear']).toBeDefined();

        const ctx = {
            reply: vi.fn().mockResolvedValue({}),
        };

        await commands['clear'](ctx);

        expect(mockAgyService.restartSession).toHaveBeenCalledWith('123:456');
        expect(mockDb.deleteSession).toHaveBeenCalledWith('123:456');
        expect(ctx.reply).toHaveBeenCalledWith(
            expect.stringContaining('Conversation Reset'),
            expect.objectContaining({ parse_mode: 'HTML' })
        );
    });
});
