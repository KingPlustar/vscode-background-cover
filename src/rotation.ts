/**
 * Pure helpers for rotation order / dwell time.
 * Kept free of `vscode` imports so they can be unit-tested directly.
 */
import * as path from 'path';

export type PlayMode = 'random' | 'sequence';

/** Natural, case-aware filename comparison (img2 < img10). */
export function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Weighted random index into `weights`. Weights <= 0 are ignored.
 * Returns -1 when there is no positive weight.
 */
export function pickWeightedIndex(weights: number[]): number {
    let total = 0;
    for (const w of weights) {
        total += Number.isFinite(w) && w > 0 ? w : 0;
    }
    if (total <= 0) { return -1; }
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
        const w = Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0;
        r -= w;
        if (r < 0) { return i; }
    }
    return weights.length - 1;
}

/**
 * Weighted pick with replacement among `files`, excluding `exclude` when at
 * least one other candidate remains. Files with weight <= 0 are skipped;
 * when no file has a positive weight, all files get equal weight 1.
 * Returns undefined only when there are no candidates.
 */
export function pickWeightedFile(
    files: string[],
    weightOf: (file: string) => number,
    exclude?: string
): string | undefined {
    const weighted = files.filter(f => weightOf(f) > 0);
    const candidates = weighted.length > 0 ? weighted : files.slice();
    if (candidates.length === 0) { return undefined; }
    let pool = candidates;
    if (exclude && candidates.length > 1) {
        const next = candidates.filter(f => f !== exclude);
        if (next.length > 0) { pool = next; }
    }
    const weights = pool.map(f => (weighted.length > 0 ? weightOf(f) : 1));
    const idx = pickWeightedIndex(weights);
    if (idx < 0) { return undefined; }
    return pool[idx];
}

/** Advance a zero-based sequence index with wraparound. Returns -1 for empty lists. */
export function nextSequenceIndex(previous: number | undefined, length: number): number {
    if (length <= 0) { return -1; }
    const prev = typeof previous === 'number' && Number.isInteger(previous) ? previous : -1;
    return (prev + 1) % length;
}

/**
 * Display time for one image (seconds): base + bonus, floored by minDisplay,
 * always at least 1 second.
 */
export function computeDwellSeconds(
    baseSeconds: number,
    bonusSeconds: number,
    minDisplaySeconds: number
): number {
    const base = Number.isFinite(baseSeconds) ? baseSeconds : 0;
    const bonus = Number.isFinite(bonusSeconds) ? bonusSeconds : 0;
    const minDisplay = Number.isFinite(minDisplaySeconds) ? Math.max(0, minDisplaySeconds) : 0;
    return Math.max(base + bonus, minDisplay, 1);
}

/** True when `target` equals `root` or is inside it (case-insensitive on win32). */
export function isPathInside(root: string, target: string): boolean {
    const normRoot = path.normalize(root);
    const normTarget = path.normalize(target);
    const rootCmp = process.platform === 'win32' ? normRoot.toLowerCase() : normRoot;
    const targetCmp = process.platform === 'win32' ? normTarget.toLowerCase() : normTarget;
    return targetCmp === rootCmp || targetCmp.startsWith(rootCmp + path.sep);
}
