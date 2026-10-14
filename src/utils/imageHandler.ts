import fs from 'fs';
import path from 'path';
import os from 'os';
import { Api } from 'grammy';
import { logger } from './logger';

export async function downloadTelegramPhoto(api: Api, fileId: string): Promise<string> {
    try {
        const fileInfo = await api.getFile(fileId);
        if (!fileInfo.file_path) {
            throw new Error('Telegram did not return file_path');
        }

        const downloadUrl = `https://api.telegram.org/file/bot${api.token}/${fileInfo.file_path}`;
        const ext = path.extname(fileInfo.file_path) || '.jpg';
        const tmpDir = path.join(os.tmpdir(), 'mobile-friendly-agy');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        const destination = path.join(tmpDir, `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
        
        const response = await fetch(downloadUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch file from Telegram: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        fs.writeFileSync(destination, Buffer.from(buffer));
        logger.info(`[ImageHandler] Downloaded Telegram photo to: ${destination}`);
        return destination;
    } catch (err: any) {
        logger.error('[ImageHandler] Error downloading photo:', err?.message || err);
        throw err;
    }
}
