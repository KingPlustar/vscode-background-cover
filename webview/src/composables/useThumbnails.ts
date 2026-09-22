/**
 * Local preview thumbnails (webview side).
 *
 * 大尺寸壁纸（例如 1 亿像素 / 60MB 的 JPEG）直接 `<img src=原图>` 会让渲染进程
 * 同时解码多张数百 MB 的位图，导致长时间卡顿甚至卡死窗口。这里的策略是：
 *
 * 1. 网格里**从不渲染原图**：未生成缩略图时显示占位图；
 * 2. 缩略图由队列**串行**生成（并发 1）：fetch 原图 → `createImageBitmap` 按
 *    目标宽度解码（Chromium 会据此走缩放解码，避免完整解码）→ canvas 转 WebP；
 * 3. 生成后立即以 object URL 显示，并回传宿主落盘缓存；
 * 4. 之后（含重开 VS Code）宿主直接下发小图，既不读原图也不解码大图。
 *
 * 串行 + 占位是「不卡死」的关键：任何时刻最多只有一张大图在解码。
 */
import { reactive } from 'vue';
import { useBridge } from './useBridge';

export type ThumbKind = 'grid' | 'large';

/** 与宿主 src/thumbnails.ts 的 THUMB_MAX_SIDE 保持一致。 */
const MAX_SIDE: Record<ThumbKind, number> = { grid: 320, large: 960 };

/** 同一时刻只解码一张原图，避免内存峰值叠加。 */
const MAX_CONCURRENT = 1;
/** 队列上限：快速翻页时不至于堆积无意义的解码任务。 */
const MAX_QUEUE = 200;

const bridge = useBridge();

/** thumbKey → 已生成的本地小图 object URL（响应式，模板可直接读）。 */
const thumbs = reactive(new Map<string, string>());
const started = new Set<string>();
const failed = new Set<string>();

interface Job { key: string; kind: ThumbKind; src: string }
const queue: Job[] = [];
let running = 0;

export interface ThumbRef {
    display: string;
    thumbKey?: string;
    thumbKind?: ThumbKind;
}

/**
 * 预览当前应显示的 URL：
 * - 没有 thumbKey（宿主已有缓存的缩略图 / 在线图 / 视频）：直接用宿主给的地址；
 * - 有 thumbKey 且已生成：用本地小图；
 * - 有 thumbKey 但还没生成：返回空串，由调用方显示占位图（绝不回退到原图）；
 * - 生成失败：回退到宿主地址（至少能看到内容）。
 */
export function thumbUrl(item: ThumbRef | undefined | null): string {
    if (!item) { return ''; }
    const key = item.thumbKey;
    if (!key || failed.has(key)) { return item.display || ''; }
    return thumbs.get(key) || '';
}

/** 排队生成某张预览的缩略图（重复调用安全）。 */
export function ensureThumb(item: ThumbRef | undefined | null): void {
    const key = item?.thumbKey;
    if (!key || !item?.display) { return; }
    if (started.has(key) || failed.has(key)) { return; }
    if (queue.length >= MAX_QUEUE) { return; }
    started.add(key);
    queue.push({ key, kind: item.thumbKind || 'grid', src: item.display });
    void pump();
}

// --- 视口内才排队（IntersectionObserver） -----------------------------------
//
// 打开包含上千张大图的目录时，若对所有瓦片排队就会连续解码很多张。用指令
// `v-thumb="item"` 挂在瓦片容器上：只有滚动到视口附近（rootMargin 预取）时才真正
// 排队，其余等用户滚到再生成。观察器是共享的，进入视口后立即取消观察。

const observed = new WeakMap<Element, ThumbRef | null>();
let observer: IntersectionObserver | undefined;
let observerUnavailable = false;

function getObserver(): IntersectionObserver | undefined {
    if (observerUnavailable) { return undefined; }
    if (!observer) {
        if (typeof IntersectionObserver === 'undefined') {
            observerUnavailable = true;
            return undefined;
        }
        observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) { continue; }
                const item = observed.get(entry.target) ?? null;
                ensureThumb(item);
                observed.delete(entry.target);
                observer?.unobserve(entry.target);
            }
        }, { rootMargin: '256px' });
    }
    return observer;
}

function watchElement(el: Element, item: ThumbRef | null | undefined): void {
    if (!item || !item.thumbKey) {
        unwatchElement(el);
        return;
    }
    const obs = getObserver();
    if (!obs) {
        // 环境不支持观察器时退化为立即排队，保证功能可用。
        ensureThumb(item);
        return;
    }
    observed.set(el, item);
    obs.observe(el);
}

function unwatchElement(el: Element): void {
    observed.delete(el);
    observer?.unobserve(el);
}

/**
 * 指令：`v-thumb="item"`。瓦片进入视口时才排队生成该预览的缩略图。
 */
export const vThumb = {
    mounted(el: Element, binding: { value: ThumbRef | null | undefined }): void {
        watchElement(el, binding.value);
    },
    updated(el: Element, binding: { value: ThumbRef | null | undefined }): void {
        watchElement(el, binding.value);
    },
    unmounted(el: Element): void {
        unwatchElement(el);
    }
};

function pump(): void {
    while (queue.length > 0 && running < MAX_CONCURRENT) {
        const job = queue.shift() as Job;
        running++;
        generate(job).catch(e => {
            console.warn('[background-cover] thumbnail generation failed:', e);
            failed.add(job.key);
        }).finally(() => {
            running--;
            pump();
        });
    }
}

async function generate(job: Job): Promise<void> {
    const max = MAX_SIDE[job.kind] || MAX_SIDE.grid;
    const bitmap = await decodeScaled(job.src, max);
    try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { return; }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
        if (!blob) { return; }
        thumbs.set(job.key, URL.createObjectURL(blob));
        bridge.post({ type: 'saveThumbnail', key: job.key, data: await blobToBase64(blob) });
    } finally {
        bitmap.close();
    }
}

/**
 * 按目标宽度解码原图。优先走 fetch + createImageBitmap（Chromium 可据此做缩放
 * 解码，只解出小图）；CSP/失败时退回 <img> 解码路径。
 */
async function decodeScaled(src: string, maxWidth: number): Promise<ImageBitmap> {
    if (typeof createImageBitmap === 'function') {
        try {
            const response = await fetch(src);
            if (response.ok) {
                const blob = await response.blob();
                return await createImageBitmap(blob, { resizeWidth: maxWidth, resizeQuality: 'medium' });
            }
        } catch {
            // fall through to the element path below
        }
        try {
            const img = new Image();
            img.decoding = 'async';
            img.src = src;
            await img.decode();
            return await createImageBitmap(img, { resizeWidth: maxWidth, resizeQuality: 'medium' });
        } catch {
            // fall through to the raw decode below
        }
    }
    const response = await fetch(src);
    return await createImageBitmap(await response.blob());
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : '');
        };
        reader.readAsDataURL(blob);
    });
}
