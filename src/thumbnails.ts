/**
 * 本地预览缩略图缓存。
 *
 * 高分辨率壁纸（例如 1 亿像素 / 60MB 的 JPEG）在 webview 里按原图渲染缩略图时，
 * 每次都要读取整个文件并解码成数百 MB 的位图，导致「本地」页等预览长时间卡顿。
 * 这里把 webview 用 Chromium 缩放解码生成的小图（WebP）缓存到扩展的 globalStorage，
 * 命中缓存后预览只加载几十 KB，且完全不再读取原图 —— 预览外观保持一致。
 *
 * 缓存键包含 尺寸档位 + 绝对路径 + 文件大小 + mtime，文件被替换/修改后自动失效。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fse from 'fs-extra';

export type ThumbKind = 'grid' | 'large';

/** 各预览档位的最大边长（与 webview 侧 useThumbnails.ts 的 MAX_SIDE 保持一致）。 */
export const THUMB_MAX_SIDE: Record<ThumbKind, number> = { grid: 320, large: 960 };

/** 单张缩略图大小上限（防御异常数据）。 */
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
/** 缓存文件数量上限，超出后按 mtime淘汰最旧的。 */
const MAX_THUMB_FILES = 3000;
/** 清理节流：最多每 10 分钟扫一次目录。 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/** 视频文件不做缩略图（canvas 无法解码视频帧），保持原图/缩略视频逻辑。 */
const VIDEO_EXTS = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v', '.mkv'];

export function isVideoFile(name: string): boolean {
    const lower = name.toLowerCase();
    return VIDEO_EXTS.some(ext => lower.endsWith(ext));
}

export interface ThumbDescriptor {
    /** 缓存键；无法生成（视频/不存在/非常规文件）时为 undefined。 */
    key?: string;
    /** 缓存是否已就绪（就绪时可直接把 display 指向缩略图）。 */
    ready: boolean;
}

export class ThumbnailStore {
    private lastPruneAt = 0;

    constructor(private readonly dir: string) {}

    static keyFor(fullPath: string, size: number, mtimeMs: number, kind: ThumbKind): string {
        return crypto.createHash('sha1')
            .update(`${kind}|${fullPath}|${size}|${Math.round(mtimeMs)}`)
            .digest('hex')
            .slice(0, 20);
    }

    /** 计算某个本地文件的缩略图键与缓存状态（不产生任何磁盘写入）。 */
    describe(fullPath: string, kind: ThumbKind): ThumbDescriptor {
        if (!fullPath || isVideoFile(fullPath)) { return { ready: false }; }
        try {
            const st = fs.statSync(fullPath);
            if (!st.isFile()) { return { ready: false }; }
            const key = ThumbnailStore.keyFor(fullPath, st.size, st.mtimeMs, kind);
            return { key, ready: this.has(key) };
        } catch {
            return { ready: false };
        }
    }

    pathFor(key: string): string {
        return path.join(this.dir, `${key}.webp`);
    }

    has(key: string): boolean {
        try {
            return fs.existsSync(this.pathFor(key));
        } catch {
            return false;
        }
    }

    /** 写入一张缩略图（webview 传来的 base64 WebP）。非法输入静默忽略。 */
    async save(key: string, base64: string): Promise<void> {
        if (!/^[0-9a-f]{20}$/.test(key) || typeof base64 !== 'string' || !base64) { return; }
        const buf = Buffer.from(base64, 'base64');
        if (buf.length === 0 || buf.length > MAX_THUMB_BYTES) { return; }

        if (!fs.existsSync(this.dir)) {
            await fse.mkdirp(this.dir);
        }
        const target = this.pathFor(key);
        const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fse.writeFile(tmp, buf);
            await fse.move(tmp, target, { overwrite: true });
        } catch (e) {
            try { await fse.remove(tmp); } catch { /* ignore cleanup failure */ }
            throw e;
        }
        void this.pruneIfDue();
    }

    /** 数量超限时按 mtime 淘汰最旧的缩略图；带节流，失败不影响主流程。 */
    private async pruneIfDue(): Promise<void> {
        const now = Date.now();
        if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) { return; }
        this.lastPruneAt = now;
        try {
            const names = (await fse.readdir(this.dir)).filter(n => n.endsWith('.webp'));
            if (names.length <= MAX_THUMB_FILES) { return; }
            const entries: { file: string; mtimeMs: number }[] = [];
            for (const name of names) {
                try {
                    const st = await fse.stat(path.join(this.dir, name));
                    entries.push({ file: name, mtimeMs: st.mtimeMs });
                } catch { /* skip unreadable */ }
            }
            entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
            for (const victim of entries.slice(MAX_THUMB_FILES)) {
                try { await fse.remove(path.join(this.dir, victim.file)); } catch { /* ignore */ }
            }
        } catch { /* ignore prune failures */ }
    }
}
