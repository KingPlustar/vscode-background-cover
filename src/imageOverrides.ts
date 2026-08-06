/**
 * Per-image rotation settings stored in a small JSON file inside the
 * rotation folder (`.background-cover.json`).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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
    /** Optional fingerprint (byte size) used to detect renames. */
    size?: number;
    /** Optional fingerprint (SHA-256 hex) used to detect renames. */
    hash?: string;
    /** Optional opacity (0-0.8); undefined follows the global opacity. */
    opacity?: number;
}

export interface ImagePattern {
    /** JavaScript regular expression matched against file basenames. */
    pattern: string;
    /** 0..100, 0 = excluded from random rotation. */
    weight: number;
    /** Seconds added to the base interval (may be negative). */
    dwellBonusSeconds: number;
    /** Floor for the display time in seconds (>= 0). */
    minDisplaySeconds: number;
    /** Optional opacity (0-0.8); undefined follows the global opacity. */
    opacity?: number;
}

export interface OverrideStoreData {
    images: ImageOverride[];
    patterns: ImagePattern[];
}

export const IMAGE_OVERRIDE_FILE = '.background-cover.json';
export const DEFAULT_WEIGHT = 10;

/** File extensions the rotation feature considers as images/videos. */
const ROTATION_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.jfif', '.mp4', '.webm', '.ogg', '.mov'];

function isRotationFile(name: string): boolean {
    const lower = name.toLowerCase();
    return ROTATION_EXTS.some(ext => lower.endsWith(ext));
}

function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk: Buffer) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

interface PersistedFile {
    version?: number;
    images?: unknown[];
    patterns?: unknown[];
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(max, Math.max(min, n));
}

function sanitizeOpacity(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) { return undefined; }
    return Math.min(0.8, Math.max(0, value));
}

function toOverride(raw: unknown): ImageOverride | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o.file !== 'string' || !o.file.trim()) { return null; }
    const file = path.basename(o.file);
    const weight = Math.round(sanitizeNumber(o.weight, DEFAULT_WEIGHT, 0, 10000));
    const dwellBonusSeconds = sanitizeNumber(o.dwellBonusSeconds, 0, -86400, 86400);
    const minDisplaySeconds = sanitizeNumber(o.minDisplaySeconds, 0, 0, 86400);
    const size = typeof o.size === 'number' && Number.isFinite(o.size) && o.size >= 0 ? o.size : undefined;
    const hash = typeof o.hash === 'string' && /^[0-9a-f]{64}$/i.test(o.hash) ? o.hash.toLowerCase() : undefined;
    const opacity = sanitizeOpacity(o.opacity);
    return { file, weight, dwellBonusSeconds, minDisplaySeconds, size, hash, opacity };
}

function toPattern(raw: unknown): ImagePattern | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const o = raw as Record<string, unknown>;
    if (typeof o.pattern !== 'string' || !o.pattern.trim()) { return null; }
    const pattern = o.pattern;
    try { new RegExp(pattern); } catch { return null; }
    const weight = Math.round(sanitizeNumber(o.weight, DEFAULT_WEIGHT, 0, 10000));
    const dwellBonusSeconds = sanitizeNumber(o.dwellBonusSeconds, 0, -86400, 86400);
    const minDisplaySeconds = sanitizeNumber(o.minDisplaySeconds, 0, 0, 86400);
    const opacity = sanitizeOpacity(o.opacity);
    return { pattern, weight, dwellBonusSeconds, minDisplaySeconds, opacity };
}

/**
 * Effective settings for a file: explicit per-image entry first, otherwise the
 * first matching regex pattern, otherwise undefined (callers use defaults).
 */
export function effectiveOverride(
    images: ImageOverride[],
    patterns: ImagePattern[],
    fileName: string
): ImageOverride | undefined {
    const base = path.basename(fileName);
    const explicit = images.find(o => o.file === base);
    if (explicit) { return explicit; }
    for (const p of patterns) {
        try {
            if (new RegExp(p.pattern).test(base)) {
                return {
                    file: base,
                    weight: p.weight,
                    dwellBonusSeconds: p.dwellBonusSeconds,
                    minDisplaySeconds: p.minDisplaySeconds,
                    opacity: p.opacity
                };
            }
        } catch { /* invalid pattern skipped at load */ }
    }
    return undefined;
}

export class ImageOverridesStore {
    private static readonly mutex = new Mutex();
    private readonly folderPath: string;
    private readonly configPath: string;

    constructor(folderPath: string) {
        this.folderPath = folderPath;
        this.configPath = path.join(folderPath, IMAGE_OVERRIDE_FILE);
    }

    public static fileFor(folderPath: string): string {
        return path.join(folderPath, IMAGE_OVERRIDE_FILE);
    }

    public load(): Promise<OverrideStoreData> {
        return ImageOverridesStore.mutex.runExclusive(async () => {
            const data = this.read();
            let changed = await this.adoptOrphans(data.images);
            changed = (await this.backfillFingerprints(data.images)) || changed;
            if (changed) {
                await this.write(data.images, data.patterns);
            }
            return data;
        });
    }

    public getByFile(file: string): Promise<ImageOverride | undefined> {
        return this.load().then(data => effectiveOverride(data.images, data.patterns, path.basename(file)));
    }

    public save(override: ImageOverride): Promise<ImageOverride> {
        const entry: ImageOverride = {
            file: path.basename(override.file),
            weight: Math.round(sanitizeNumber(override.weight, DEFAULT_WEIGHT, 0, 10000)),
            dwellBonusSeconds: sanitizeNumber(override.dwellBonusSeconds, 0, -86400, 86400),
            minDisplaySeconds: sanitizeNumber(override.minDisplaySeconds, 0, 0, 86400),
            opacity: sanitizeOpacity(override.opacity)
        };
        return ImageOverridesStore.mutex.runExclusive(async () => {
            const fp = await this.computeFingerprint(entry.file);
            if (fp) {
                entry.size = fp.size;
                entry.hash = fp.hash;
            }
            const data = this.read();
            const list = data.images;
            const idx = list.findIndex(o => o.file === entry.file);
            if (idx >= 0) { list[idx] = entry; } else { list.push(entry); }
            list.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true, sensitivity: 'base' }));
            await this.write(list, data.patterns);
            return entry;
        });
    }

    public remove(file: string): Promise<void> {
        const target = path.basename(file);
        return ImageOverridesStore.mutex.runExclusive(async () => {
            const data = this.read();
            const next = data.images.filter(o => o.file !== target);
            if (next.length !== data.images.length) {
                await this.write(next, data.patterns);
            }
        });
    }

    public savePattern(pattern: ImagePattern): Promise<ImagePattern> {
        const entry: ImagePattern = {
            pattern: pattern.pattern,
            weight: Math.round(sanitizeNumber(pattern.weight, DEFAULT_WEIGHT, 0, 10000)),
            dwellBonusSeconds: sanitizeNumber(pattern.dwellBonusSeconds, 0, -86400, 86400),
            minDisplaySeconds: sanitizeNumber(pattern.minDisplaySeconds, 0, 0, 86400),
            opacity: sanitizeOpacity(pattern.opacity)
        };
        try { new RegExp(entry.pattern); } catch { throw new Error(`invalid regex: ${entry.pattern}`); }
        return ImageOverridesStore.mutex.runExclusive(async () => {
            const data = this.read();
            const idx = data.patterns.findIndex(p => p.pattern === entry.pattern);
            if (idx >= 0) { data.patterns[idx] = entry; } else { data.patterns.push(entry); }
            await this.write(data.images, data.patterns);
            return entry;
        });
    }

    public removePattern(pattern: string): Promise<void> {
        return ImageOverridesStore.mutex.runExclusive(async () => {
            const data = this.read();
            const next = data.patterns.filter(p => p.pattern !== pattern);
            if (next.length !== data.patterns.length) {
                await this.write(data.images, next);
            }
        });
    }

    /** Size + SHA-256 of the given file, or undefined when unreadable. */
    private async computeFingerprint(file: string): Promise<{ size: number; hash: string } | undefined> {
        const full = path.join(this.folderPath, file);
        try {
            const st = fs.statSync(full);
            if (!st.isFile()) { return undefined; }
            const hash = await sha256File(full);
            return { size: st.size, hash };
        } catch {
            return undefined;
        }
    }

    /**
     * Stamp size/hash onto entries that lack them but whose file still exists,
     * so entries saved before the fingerprint feature become migratable too.
     */
    private async backfillFingerprints(list: ImageOverride[]): Promise<boolean> {
        let changed = false;
        for (const o of list) {
            if (o.hash !== undefined && o.size !== undefined) { continue; }
            if (!fs.existsSync(path.join(this.folderPath, o.file))) { continue; }
            const fp = await this.computeFingerprint(o.file);
            if (fp) {
                o.size = fp.size;
                o.hash = fp.hash;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Migrate config entries whose file no longer exists to a renamed file:
     * unique match on stored size + SHA-256. Returns true when any entry was
     * migrated (caller persists the change).
     */
    private async adoptOrphans(list: ImageOverride[]): Promise<boolean> {
        const orphans = list.filter(o => o.hash !== undefined && o.size !== undefined
            && !fs.existsSync(path.join(this.folderPath, o.file)));
        if (orphans.length === 0) { return false; }

        let current: string[] = [];
        try {
            current = fs.readdirSync(this.folderPath).filter(isRotationFile);
        } catch {
            return false;
        }

        let changed = false;
        for (const orphan of orphans) {
            const sameSize: string[] = [];
            for (const name of current) {
                try {
                    if (fs.statSync(path.join(this.folderPath, name)).size === orphan.size) {
                        sameSize.push(name);
                    }
                } catch { /* skip unreadable files */ }
            }
            const matches: string[] = [];
            for (const name of sameSize) {
                try {
                    if (await sha256File(path.join(this.folderPath, name)) === orphan.hash) {
                        matches.push(name);
                    }
                } catch { /* skip unreadable files */ }
            }
            if (matches.length === 1) {
                orphan.file = matches[0];
                changed = true;
            }
        }
        return changed;
    }

    private read(): OverrideStoreData {
        const empty: OverrideStoreData = { images: [], patterns: [] };
        try {
            if (!fs.existsSync(this.configPath)) { return empty; }
            const raw = fse.readJsonSync(this.configPath);
            const payload = (raw && typeof raw === 'object' ? raw : {}) as Partial<PersistedFile>;
            const out: ImageOverride[] = [];
            if (Array.isArray(payload.images)) {
                for (const item of payload.images) {
                    const o = toOverride(item);
                    if (o) { out.push(o); }
                }
            }
            const pats: ImagePattern[] = [];
            if (Array.isArray(payload.patterns)) {
                for (const item of payload.patterns) {
                    const p = toPattern(item);
                    if (p) { pats.push(p); }
                }
            }
            return { images: out, patterns: pats };
        } catch {
            return empty;
        }
    }

    private async write(images: ImageOverride[], patterns: ImagePattern[]): Promise<void> {
        const payload: PersistedFile = { version: 1, images, ...(patterns.length ? { patterns } : {}) };
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
