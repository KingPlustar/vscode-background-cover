//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { naturalCompare, nextSequenceIndex, computeDwellSeconds, pickWeightedIndex, pickWeightedFile, isPathInside } from '../rotation';
import { ImageOverridesStore } from '../imageOverrides';

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
        assert.deepStrictEqual(await store.load(), []);
        await store.save({ file: 'a.png', weight: 3, dwellBonusSeconds: 5, minDisplaySeconds: 2 });
        await store.save({ file: 'b.png', weight: 0, dwellBonusSeconds: -2, minDisplaySeconds: 0 });
        const all = await store.load();
        assert.strictEqual(all.length, 2);
        assert.deepStrictEqual(all.find(o => o.file === 'a.png'), { file: 'a.png', weight: 3, dwellBonusSeconds: 5, minDisplaySeconds: 2 });
        const b = await store.getByFile(path.join(dir, 'b.png'));
        assert.strictEqual(b && b.weight, 0);
        await store.remove('a.png');
        assert.deepStrictEqual((await store.load()).map(o => o.file), ['b.png']);
    });

    test("sanitizes invalid values", async function () {
        await store.save({ file: 'x.png', weight: 999, dwellBonusSeconds: -100000, minDisplaySeconds: -5 });
        const [o] = await store.load();
        assert.strictEqual(o.weight, 999);
        assert.strictEqual(o.dwellBonusSeconds, -86400);
        assert.strictEqual(o.minDisplaySeconds, 0);
        // loose safety cap
        await store.save({ file: 'y.png', weight: 99999, dwellBonusSeconds: 0, minDisplaySeconds: 0 });
        const [x, y] = await store.load();
        assert.strictEqual(x.weight, 999);
        assert.strictEqual(y.weight, 10000);
    });

    test("ignores malformed entries in an existing file", async function () {
        fs.writeFileSync(path.join(dir, '.background-cover.json'), '{ "version": 1, "images": [ 42, { "file": "ok.png" }, { "weight": 2 } ] }', 'utf8');
        const all = await store.load();
        assert.strictEqual(all.length, 1);
        assert.strictEqual(all[0].file, 'ok.png');
        assert.strictEqual(all[0].weight, 10);
    });
});
