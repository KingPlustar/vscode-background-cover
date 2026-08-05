/**
 * Per-image rotation settings stored in a small JSON file inside the
 * rotation folder (`.background-cover.json`).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as fse from 'fs-extra';
import { Mutex } from 'async-mutex';

export interface ImageOverride {
    /** Basename of the image file inside the rotation folder. */
    file: string;
    /** 0..100, 0 = excluded from random rotation. */
    weight: number;
    /** Seconds added to the base interval (may be negative). */
    dwellBonusSeconds: number;
    /** Floor for the display time in seconds (>= 0). */
    minDisplaySeconds: number;
}

export const IMAGE_OVERRIDE_FILE = '.background-cover.json';
export const DEFAULT_WEIGHT = 1;

interface PersistedFile {
    version?: number;
    images?: unknown[];
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
}

function toOverride(raw: unknown): ImageOverride | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o.file !== 'string' || !o.file.trim()) { return null; }
    const file = path.basename(o.file);
    const weight = Math.round(sanitizeNumber(o.weight, DEFAULT_WEIGHT, 0, 100));
    const dwellBonusSeconds = sanitizeNumber(o.dwellBonusSeconds, 0, -86400, 86400);
    const minDisplaySeconds = sanitizeNumber(o.minDisplaySeconds, 0, 0, 86400);
    return { file, weight, dwellBonusSeconds, minDisplaySeconds };
}

export class ImageOverridesStore {
    private static readonly mutex = new Mutex();
    private readonly configPath: string;

    constructor(folderPath: string) {
        this.configPath = path.join(folderPath, IMAGE_OVERRIDE_FILE);
    }

    public static fileFor(folderPath: string): string {
        return path.join(folderPath, IMAGE_OVERRIDE_FILE);
    }

    public load(): Promise<ImageOverride[]> {
        return ImageOverridesStore.mutex.runExclusive(() => this.read());
    }

    public getByFile(file: string): Promise<ImageOverride | undefined> {
        return this.load().then(list => list.find(o => o.file === path.basename(file)));
    }

    public save(override: ImageOverride): Promise<ImageOverride> {
        const entry: ImageOverride = {
            file: path.basename(override.file),
            weight: Math.round(sanitizeNumber(override.weight, DEFAULT_WEIGHT, 0, 100)),
            dwellBonusSeconds: sanitizeNumber(override.dwellBonusSeconds, 0, -86400, 86400),
            minDisplaySeconds: sanitizeNumber(override.minDisplaySeconds, 0, 0, 86400)
        };
        return ImageOverridesStore.mutex.runExclusive(async () => {
            const list = this.read();
            const idx = list.findIndex(o => o.file === entry.file);
            if (idx >= 0) { list[idx] = entry; } else { list.push(entry); }
            list.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true, sensitivity: 'base' }));
            await this.write(list);
            return entry;
        });
    }

    public remove(file: string): Promise<void> {
        const target = path.basename(file);
        return ImageOverridesStore.mutex.runExclusive(async () => {
            const list = this.read();
            const next = list.filter(o => o.file !== target);
            if (next.length !== list.length) {
                await this.write(next);
            }
        });
    }

    private read(): ImageOverride[] {
        try {
            if (!fs.existsSync(this.configPath)) { return []; }
            const raw = fse.readJsonSync(this.configPath);
            const payload = (raw && typeof raw === 'object' ? raw : {}) as Partial<PersistedFile>;
            if (!Array.isArray(payload.images)) { return []; }
            const out: ImageOverride[] = [];
            for (const item of payload.images) {
                const o = toOverride(item);
                if (o) { out.push(o); }
            }
            return out;
        } catch {
            return [];
        }
    }

    private async write(images: ImageOverride[]): Promise<void> {
        const payload: PersistedFile = { version: 1, images };
        const tmp = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fse.writeJson(tmp, payload, { spaces: 2 });
            await fse.move(tmp, this.configPath, { overwrite: true });
        } catch (e) {
            try { await fse.remove(tmp); } catch { /* ignore cleanup failure */ }
            throw e;
        }
    }
}
