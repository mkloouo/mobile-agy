import fs from 'fs';
import path from 'path';
import os from 'os';
import { Api } from 'grammy';
import { logger } from './logger';

export async function downloadTelegramFile(api: Api, fileId: string, customFileName?: string): Promise<string> {
    try {
        const fileInfo = await api.getFile(fileId);
        if (!fileInfo.file_path) {
            throw new Error('Telegram did not return file_path');
        }

        const downloadUrl = `https://api.telegram.org/file/bot${api.token}/${fileInfo.file_path}`;
        const ext = path.extname(customFileName || fileInfo.file_path) || '';
        const base = customFileName
            ? path.basename(customFileName, ext).replace(/[^a-zA-Z0-9_.-]/g, '_')
            : `file_${Date.now()}`;
        const tmpDir = path.join(os.tmpdir(), 'mobile-agy-uploads');
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }

        const destination = path.join(tmpDir, `${base}_${Date.now().toString().slice(-4)}${ext}`);
        const response = await fetch(downloadUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch file from Telegram: ${response.statusText}`);
        }

        const buffer = await response.arrayBuffer();
        fs.writeFileSync(destination, Buffer.from(buffer));
        logger.info(`[FileHandler] Downloaded Telegram file to: ${destination}`);
        return destination;
    } catch (err: any) {
        logger.error('[FileHandler] Error downloading file:', err?.message || err);
        throw err;
    }
}

export async function downloadTelegramPhoto(api: Api, fileId: string): Promise<string> {
    return downloadTelegramFile(api, fileId, `photo_${Date.now()}.jpg`);
}
