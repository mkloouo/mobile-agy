import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import { WorkspaceService } from '../src/services/workspaceService';

describe('WorkspaceService', () => {
    const baseDir = path.resolve(__dirname, '..');
    const ws = new WorkspaceService(baseDir);

    it('resolves relative workspace name within baseDir', () => {
        const resolved = ws.resolveWorkspace('src');
        expect(resolved).toBe(path.join(baseDir, 'src'));
    });

    it('resolves arbitrary absolute path anywhere on filesystem', () => {
        const tmpDir = os.tmpdir();
        const resolved = ws.resolveWorkspace(tmpDir);
        expect(resolved).toBe(path.resolve(tmpDir));
    });

    it('resolves tilde (~) path to home directory', () => {
        const homeDir = os.homedir();
        const resolved = ws.resolveWorkspace('~');
        expect(resolved).toBe(path.resolve(homeDir));
    });

    it('throws error for non-existent directory', () => {
        expect(() => ws.resolveWorkspace('/non/existent/path/xyz_123')).toThrow('Directory does not exist');
    });
});
