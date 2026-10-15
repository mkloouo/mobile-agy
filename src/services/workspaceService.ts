import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export class WorkspaceService {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = path.resolve(baseDir);
        this.ensureBaseDir();
    }

    public ensureBaseDir(): void {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    public getBaseDir(): string {
        return this.baseDir;
    }

    public scanWorkspaces(): string[] {
        this.ensureBaseDir();
        try {
            const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
            return entries
                .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
                .map((e) => e.name)
                .sort();
        } catch (err: any) {
            logger.error('[WorkspaceService] Failed to scan workspaces:', err?.message || err);
            return [];
        }
    }

    public resolveWorkspace(nameOrRelative: string): string {
        if (!nameOrRelative) return this.baseDir;

        let target = nameOrRelative.trim();
        if (target.startsWith('~/') || target === '~') {
            target = path.join(process.env.HOME || '', target.slice(1));
        }

        if (path.isAbsolute(target)) {
            const resolved = path.resolve(target);
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
                throw new Error(`Directory does not exist: "${resolved}"`);
            }
            return resolved;
        }

        const resolved = path.resolve(this.baseDir, target);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error(`Directory does not exist: "${resolved}"`);
        }
        return resolved;
    }

    public getWorkspacePath(nameOrRelative: string): string {
        return this.resolveWorkspace(nameOrRelative);
    }

    public exists(nameOrRelative: string): boolean {
        try {
            const fullPath = this.resolveWorkspace(nameOrRelative);
            return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
        } catch {
            return false;
        }
    }
}
