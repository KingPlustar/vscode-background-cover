//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { naturalCompare, nextSequenceIndex, computeDwellSeconds, pickWeightedIndex, pickWeightedFile, isPathInside } from '../rotation';
import { ImageOverridesStore, effectiveOverride } from '../imageOverrides';

suite("Rotation Helpers", function () {

    test("naturalCompare orders filenames naturally", function () {
        const files = ['img10.png', 'img2.png', 'img1.png'];
        files.sort(naturalCompare);
        assert.deepStrictEqual(files, ['img1.png', 'img2.png', 'img10.png']);
    });

    test("nextSequenceIndex advances and wraps around", function () {
        assert.strictEqual(nextSequenceIndex(undefined, 3), 0);
        assert.strictEqual(nextSequenceIndex(0, 3), 1);
        assert.strictEqual(nextSequenceIndex(2, 3), 0);
        assert.strictEqual(nextSequenceIndex(9, 3), 1);
        assert.strictEqual(nextSequenceIndex(0, 0), -1);
    });

    test("computeDwellSeconds combines base, bonus and min display", function () {
        assert.strictEqual(computeDwellSeconds(10, 0, 0), 10);
        assert.strictEqual(computeDwellSeconds(10, 5, 0), 15);
        assert.strictEqual(computeDwellSeconds(10, -8, 0), 2);
        assert.strictEqual(computeDwellSeconds(10, -30, 0), 1);
        assert.strictEqual(computeDwellSeconds(10, -8, 20), 20);
        assert.strictEqual(computeDwellSeconds(10, 5, 12), 15);
    });

    test("pickWeightedIndex respects weights", function () {
        const original = Math.random;
        try {
            Math.random = () => 0.0;
            assert.strictEqual(pickWeightedIndex([1, 1000]), 0);
            Math.random = () => 0.999;
            assert.strictEqual(pickWeightedIndex([1, 1]), 1);
            Math.random = () => 0.5;
            assert.strictEqual(pickWeightedIndex([2, 2]), 1);
            Math.random = () => 0.0;
            assert.strictEqual(pickWeightedIndex([0, 5, 0]), 1);
            assert.strictEqual(pickWeightedIndex([0, 0]), -1);
        } finally {
            Math.random = original;
        }
    });

    test("isPathInside detects containment", function () {
        assert.strictEqual(isPathInside('C:\\Images', 'C:\\Images\\a.jpg'), true);
        assert.strictEqual(isPathInside('C:\\Images', 'C:\\Images2\\a.jpg'), false);
        assert.strictEqual(isPathInside('C:\\Images', 'C:\\images\\a.jpg'), process.platform === 'win32');
    });

    test("pickWeightedFile picks proportionally to weights", function () {
        const original = Math.random;
        try {
            Math.random = () => 0.0;
            assert.strictEqual(pickWeightedFile(['a', 'b'], f => f === 'a' ? 1 : 1000), 'a');
            Math.random = () => 0.999;
            assert.strictEqual(pickWeightedFile(['a', 'b'], () => 1), 'b');
        } finally {
            Math.random = original;
        }
    });

    test("pickWeightedFile excludes current when possible", function () {
        const original = Math.random;
        try {
            Math.random = () => 0.0;
            // 'a' would win by weight but is excluded -> 'b'
            assert.strictEqual(pickWeightedFile(['a', 'b', 'c'], f => f === 'a' ? 100 : 1, 'a'), 'b');
            // only one candidate -> the excluded one is allowed
            assert.strictEqual(pickWeightedFile(['a'], () => 1, 'a'), 'a');
            // exclude that is not among the candidates is ignored
            assert.strictEqual(pickWeightedFile(['a', 'b'], () => 1, 'zzz'), 'a');
        } finally {
            Math.random = original;
        }
    });

    test("pickWeightedFile falls back to equal weights when all weights are 0", function () {
        const original = Math.random;
        try {
            Math.random = () => 0.0;
            assert.strictEqual(pickWeightedFile(['a', 'b'], () => 0), 'a');
        } finally {
            Math.random = original;
        }
    });

    test("pickWeightedFile returns undefined for empty input", function () {
        assert.strictEqual(pickWeightedFile([], () => 1), undefined);
    });
});

suite("ImageOverridesStore", function () {
    let dir: string;
    let store: ImageOverridesStore;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgc-overrides-'));
        store = new ImageOverridesStore(dir);
    });

    teardown(() => {
        fs.rmdirSync(dir, { recursive: true });
    });

    test("round-trips save / load / remove", async function () {
        assert.deepStrictEqual((await store.load()).images, []);
        await store.save({ file: 'a.png', weight: 3, dwellBonusSeconds: 5, minDisplaySeconds: 2 });
        await store.save({ file: 'b.png', weight: 0, dwellBonusSeconds: -2, minDisplaySeconds: 0 });
        const all = (await store.load()).images;
        assert.strictEqual(all.length, 2);
        assert.deepStrictEqual(all.find(o => o.file === 'a.png'), { file: 'a.png', weight: 3, dwellBonusSeconds: 5, minDisplaySeconds: 2 });
        const b = await store.getByFile(path.join(dir, 'b.png'));
        assert.strictEqual(b && b.weight, 0);
        await store.remove('a.png');
        assert.deepStrictEqual((await store.load()).images.map(o => o.file), ['b.png']);
    });

    test("sanitizes invalid values", async function () {
        await store.save({ file: 'x.png', weight: 999, dwellBonusSeconds: -100000, minDisplaySeconds: -5 });
        const [o] = (await store.load()).images;
        assert.strictEqual(o.weight, 999);
        assert.strictEqual(o.dwellBonusSeconds, -86400);
        assert.strictEqual(o.minDisplaySeconds, 0);
        // loose safety cap
        await store.save({ file: 'y.png', weight: 99999, dwellBonusSeconds: 0, minDisplaySeconds: 0 });
        const [x, y] = (await store.load()).images;
        assert.strictEqual(x.weight, 999);
        assert.strictEqual(y.weight, 10000);
    });

    test("ignores malformed entries in an existing file", async function () {
        fs.writeFileSync(path.join(dir, '.background-cover.json'), '{ "version": 1, "images": [ 42, { "file": "ok.png" }, { "weight": 2 } ] }', 'utf8');
        const all = (await store.load()).images;
        assert.strictEqual(all.length, 1);
        assert.strictEqual(all[0].file, 'ok.png');
        assert.strictEqual(all[0].weight, 10);
    });

    test("save records size and hash for existing files", async function () {
        fs.writeFileSync(path.join(dir, 'a.png'), 'hello world', 'utf8');
        await store.save({ file: 'a.png', weight: 10, dwellBonusSeconds: 0, minDisplaySeconds: 0 });
        const [o] = (await store.load()).images;
        assert.strictEqual(o.size, Buffer.byteLength('hello world'));
        assert.strictEqual(o.hash, crypto.createHash('sha256').update('hello world').digest('hex'));
    });

    test("adopts config when the image is renamed", async function () {
        const file = path.join(dir, 'a.png');
        fs.writeFileSync(file, 'rename-me-content', 'utf8');
        await store.save({ file: 'a.png', weight: 33, dwellBonusSeconds: 5, minDisplaySeconds: 0 });
        fs.renameSync(file, path.join(dir, 'b.png'));
        const list = (await store.load()).images;
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].file, 'b.png');
        assert.strictEqual(list[0].weight, 33);
        assert.strictEqual(list[0].dwellBonusSeconds, 5);
        const again = (await store.load()).images;
        assert.strictEqual(again[0].file, 'b.png');
    });

    test("does not adopt when two files share the fingerprint", async function () {
        fs.writeFileSync(path.join(dir, 'x.png'), 'same-content', 'utf8');
        await store.save({ file: 'x.png', weight: 20, dwellBonusSeconds: 0, minDisplaySeconds: 0 });
        fs.rmSync(path.join(dir, 'x.png'));
        fs.writeFileSync(path.join(dir, 'y1.png'), 'same-content', 'utf8');
        fs.writeFileSync(path.join(dir, 'y2.png'), 'same-content', 'utf8');
        const list = (await store.load()).images;
        assert.strictEqual(list[0].file, 'x.png');
    });

    test("does not adopt when content changed after rename", async function () {
        fs.writeFileSync(path.join(dir, 'x.png'), 'original-content', 'utf8');
        await store.save({ file: 'x.png', weight: 20, dwellBonusSeconds: 0, minDisplaySeconds: 0 });
        fs.renameSync(path.join(dir, 'x.png'), path.join(dir, 'y.png'));
        fs.writeFileSync(path.join(dir, 'y.png'), 'edited-content-zz', 'utf8');
        const list = (await store.load()).images;
        assert.strictEqual(list[0].file, 'x.png');
    });

    test("does not adopt entries without a fingerprint", async function () {
        fs.writeFileSync(path.join(dir, '.background-cover.json'),
            JSON.stringify({ version: 1, images: [{ file: 'gone.png', weight: 12, dwellBonusSeconds: 0, minDisplaySeconds: 0 }] }), 'utf8');
        const list = (await store.load()).images;
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].file, 'gone.png');
    });

    test("backfills fingerprints for existing entries without them", async function () {
        fs.writeFileSync(path.join(dir, 'c.png'), 'backfill-me', 'utf8');
        fs.writeFileSync(path.join(dir, '.background-cover.json'),
            JSON.stringify({ version: 1, images: [{ file: 'c.png', weight: 7, dwellBonusSeconds: 0, minDisplaySeconds: 0 }] }), 'utf8');
        const list = (await store.load()).images;
        assert.strictEqual(list[0].file, 'c.png');
        assert.strictEqual(list[0].size, Buffer.byteLength('backfill-me'));
        assert.strictEqual(list[0].hash, crypto.createHash('sha256').update('backfill-me').digest('hex'));
        const again = (await store.load()).images;
        assert.strictEqual(again[0].hash, list[0].hash);
    });

    test("saves and removes regex patterns", async function () {
        await store.savePattern({ pattern: '^miku-\\d+\\.jpg$', weight: 20, dwellBonusSeconds: 5, minDisplaySeconds: 0 });
        const data = await store.load();
        assert.strictEqual(data.patterns.length, 1);
        assert.strictEqual(data.patterns[0].pattern, '^miku-\\d+\\.jpg$');
        assert.strictEqual(data.patterns[0].weight, 20);
        assert.strictEqual(data.patterns[0].dwellBonusSeconds, 5);
        await store.removePattern('^miku-\\d+\\.jpg$');
        assert.deepStrictEqual((await store.load()).patterns, []);
    });

    test("rejects invalid regex patterns", async function () {
        await assert.rejects(store.savePattern({ pattern: '(', weight: 10, dwellBonusSeconds: 0, minDisplaySeconds: 0 }));
        assert.deepStrictEqual((await store.load()).patterns, []);
    });

    test("load returns empty patterns for legacy files", async function () {
        fs.writeFileSync(path.join(dir, '.background-cover.json'),
            JSON.stringify({ version: 1, images: [{ file: 'ok.png', weight: 10, dwellBonusSeconds: 0, minDisplaySeconds: 0 }] }), 'utf8');
        const data = await store.load();
        assert.deepStrictEqual(data.patterns, []);
        assert.strictEqual(data.images.length, 1);
    });
});

suite("effectiveOverride", function () {
    const images = [
        { file: 'a.png', weight: 30, dwellBonusSeconds: 1, minDisplaySeconds: 2 },
        { file: 'b.png', weight: 0, dwellBonusSeconds: 0, minDisplaySeconds: 0 }
    ];
    const patterns = [
        { pattern: '^miku-', weight: 20, dwellBonusSeconds: 5, minDisplaySeconds: 0 },
        { pattern: 'jpg$', weight: 15, dwellBonusSeconds: 0, minDisplaySeconds: 3 }
    ];

    test("explicit entry wins over patterns", function () {
        const eff = effectiveOverride(images, patterns, 'a.png');
        assert.strictEqual(eff && eff.weight, 30);
    });

    test("first matching pattern wins", function () {
        const eff = effectiveOverride([], patterns, 'miku-01.jpg');
        assert.strictEqual(eff && eff.weight, 20);
    });

    test("pattern weight 0 excludes like an explicit entry", function () {
        const eff = effectiveOverride(images, patterns, 'b.png');
        assert.strictEqual(eff && eff.weight, 0);
    });

    test("no match returns undefined", function () {
        assert.strictEqual(effectiveOverride(images, patterns, 'other.png'), undefined);
    });
});
