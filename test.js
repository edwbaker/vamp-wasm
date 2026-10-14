const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const VampHostModule = require('./dist/vamp-host.js');
const VampMultiHost = require('./src/vamp-multi-host.js');

const SAMPLE_RATE = 44100;
const EXAMPLE = 'vamp-example-plugins';
const ECO = 'vamp-ecoacoustics';

// [file in dist/, name in the virtual filesystem, required]; the plugin key prefix is the latter's
// basename. The ecoacoustic plugins are only required in CI, where they are downloaded.
const pluginFiles = [
    ['vamp-example-plugins.so', 'vamp-example-plugins.so', true],
    ['vamp-ecoacoustics.wasm', 'vamp-ecoacoustics.so', Boolean(process.env.CI)],
];

const libraries = [];
for (const [fileName, name, required] of pluginFiles) {
    const pluginPath = path.join(__dirname, 'dist', fileName);
    if (fs.existsSync(pluginPath)) {
        libraries.push({ name, data: new Uint8Array(fs.readFileSync(pluginPath)) });
    } else if (required) {
        throw new Error(`Required plugin binary dist/${fileName} not found (run make first)`);
    }
}
const hasLibrary = (prefix) => libraries.some((lib) => lib.name.startsWith(prefix));

function sine(length, cycles) {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = Math.sin(2 * Math.PI * cycles * i / length);
    return out;
}

function noise(length) {
    let seed = 12345;
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        out[i] = (seed / 0xffffffff) * 2 - 1;
    }
    return out;
}

// Features are keyed by output index; each feature's values are keyed by bin index
function binValues(feature) {
    return Object.keys(feature.values).map(Number).sort((a, b) => a - b).map((k) => feature.values[k]);
}

let multi;
test.before(async () => {
    multi = await VampMultiHost.create(VampHostModule, libraries);
});

test('loadPlugin works on a fresh multi-host without listing plugins first', async () => {
    const fresh = await VampMultiHost.create(VampHostModule, libraries);
    const host = fresh.createHost(SAMPLE_RATE);
    try {
        assert.ok(host.loadPlugin(`${EXAMPLE}:zerocrossing`));
    } finally {
        host.delete();
    }
});

// Run fn with a host that has loaded and initialised the plugin, then release it
function withPlugin(key, { channels = 1, step, block, params = {} } = {}, fn) {
    const host = multi.createHost(SAMPLE_RATE);
    try {
        assert.ok(host.loadPlugin(key), `loadPlugin ${key}`);
        // Plugins read their parameters in initialise, so these must be set first
        for (const [id, value] of Object.entries(params)) host.setParameter(id, value);
        const info = host.getPluginInfo();
        const blockSize = block || info.preferredBlockSize || 1024;
        const stepSize = step || info.preferredStepSize || blockSize;
        assert.ok(host.initialise(channels, stepSize, blockSize), `initialise ${key}`);
        return fn(host, info, { blockSize, stepSize });
    } finally {
        host.delete();
    }
}

test('lists plugins from every loaded library', () => {
    const keys = multi.listPlugins();
    assert.ok(keys.includes(`${EXAMPLE}:zerocrossing`));
    for (const lib of libraries) {
        const prefix = lib.name.replace(/\.so$/, '');
        assert.ok(keys.some((k) => k.startsWith(`${prefix}:`)), `no plugins from ${prefix}`);
    }
});

test('describePlugins reports metadata for every plugin', () => {
    const described = multi.describePlugins();
    assert.deepEqual(described.map((d) => d.key).sort(), multi.listPlugins().sort());
    for (const d of described) {
        assert.ok(d.name, d.key);
        assert.ok(d.key.startsWith(`${d.library}:`), d.key);
    }
});

test('loading an unknown plugin fails cleanly', () => {
    const host = multi.createHost(SAMPLE_RATE);
    try {
        assert.equal(host.loadPlugin('no-such-library:nothing'), false);
        assert.equal(host.initialise(1, 512, 512), false);
        assert.equal(host.getPluginInfo(), null);
    } finally {
        host.delete();
    }
});

test('every plugin initialises with one channel and reports outputs', () => {
    // Libraries sharing one module used to break each other (no channels or outputs reported)
    for (const key of multi.listPlugins()) {
        withPlugin(key, {}, (host, info) => {
            assert.ok(info.outputs.length > 0, `${key} has no outputs`);
            assert.ok(info.minChannelCount >= 1 && info.maxChannelCount >= info.minChannelCount, key);
        });
    }
});

test('plugin info has the expected structure', () => {
    withPlugin(`${EXAMPLE}:amplitudefollower`, {}, (host, info) => {
        assert.equal(info.identifier, 'amplitudefollower');
        assert.equal(info.maker, 'Vamp SDK Example Plugins');
        assert.deepEqual(info.parameters.map((p) => p.identifier), ['attack', 'release']);
        assert.equal(info.outputs.length, 1);
    });
});

test('zerocrossing counts and locates crossings exactly', () => {
    withPlugin(`${EXAMPLE}:zerocrossing`, { step: 512, block: 512 }, (host, info) => {
        // 0.1 everywhere with a single -0.1 sample every 50 samples (11 per block, from sample 0)
        const audio = new Float32Array(512).fill(0.1);
        for (let i = 0; i < 512; i += 50) audio[i] = -0.1;

        const blocks = [0, 1].map((n) => host.process([audio], n * 512 / SAMPLE_RATE));

        // The first sample has no predecessor, so it crosses once; later samples cross twice.
        // From the second block on, the leading -0.1 follows a positive sample and crosses twice.
        assert.deepEqual(binValues(blocks[0][0][0]), [21]);
        assert.deepEqual(binValues(blocks[1][0][0]), [22]);

        assert.equal(blocks[0][1].length, 21);
        assert.equal(blocks[1][1].length, 22);

        // Crossing locations are timestamps in seconds, increasing, and within their own block
        let previous = -Infinity;
        for (const [n, block] of blocks.entries()) {
            const start = n * 512 / SAMPLE_RATE;
            for (const f of block[1]) {
                assert.ok(f.hasTimestamp);
                assert.ok(f.timestamp > previous, 'timestamps must increase');
                assert.ok(f.timestamp >= start - 1e-6 && f.timestamp < start + 512 / SAMPLE_RATE);
                previous = f.timestamp;
            }
        }
        // The first crossing is the boundary between samples 0 and 1
        assert.ok(Math.abs(blocks[0][1][0].timestamp - 1 / SAMPLE_RATE) < 1e-6);
    });
});

test('zerocrossing crosses only once at the start of a constant signal', () => {
    withPlugin(`${EXAMPLE}:zerocrossing`, { step: 512, block: 512 }, (host) => {
        const out = host.process([new Float32Array(512).fill(0.25)], 0);
        // Only the first sample crosses, from the initial zero
        assert.deepEqual(binValues(out[0][0]), [1]);
        assert.equal(out[1].length, 1);
    });
});

test('powerspectrum peaks at the bin of a pure sine', () => {
    withPlugin(`${EXAMPLE}:powerspectrum`, { step: 1024, block: 1024 }, (host) => {
        const bin = 64;
        const out = host.process([sine(1024, bin)], 0);
        const spectrum = binValues(out[0][0]);
        assert.equal(spectrum.length, 513);
        const peak = spectrum.indexOf(Math.max(...spectrum));
        assert.equal(peak, bin);
        // Everything away from the peak is many orders of magnitude lower
        const away = spectrum.filter((_, i) => Math.abs(i - bin) > 2);
        assert.ok(Math.max(...away) < spectrum[bin] * 1e-10);
    });
});

test('amplitudefollower rises towards a constant input, more quickly with a shorter attack', () => {
    const run = (attack) => withPlugin(`${EXAMPLE}:amplitudefollower`, { step: 512, block: 512, params: { attack } }, (host) => {
        const level = new Float32Array(512).fill(0.5);
        return [0, 1, 2].map((n) => binValues(host.process([level], n * 512 / SAMPLE_RATE)[0][0])[0]);
    });
    const slow = run(0.5);
    const fast = run(0.05);
    for (const series of [slow, fast]) {
        assert.ok(series[0] > 0);
        assert.ok(series[0] < series[1] && series[1] < series[2], `not rising: ${series}`);
        assert.ok(series[2] <= 0.5 + 1e-6);
    }
    assert.ok(fast[0] > slow[0]);
});

test('parameters round-trip through the host', () => {
    // (amplitudefollower stores its parameters as filter coefficients, so it does not round-trip)
    const host = multi.createHost(SAMPLE_RATE);
    try {
        assert.ok(host.loadPlugin(`${EXAMPLE}:percussiononsets`));
        const info = host.getPluginInfo();
        const threshold = info.parameters.find((p) => p.identifier === 'threshold');
        assert.equal(host.getParameter('threshold'), threshold.defaultValue);
        host.setParameter('threshold', 5);
        assert.equal(host.getParameter('threshold'), 5);
        assert.equal(host.getParameter('no-such-parameter'), 0);
    } finally {
        host.delete();
    }
});

test('reset restores initial behaviour', () => {
    withPlugin(`${EXAMPLE}:amplitudefollower`, { step: 512, block: 512, params: { attack: 0.5 } }, (host) => {
        const level = new Float32Array(512).fill(0.5);
        const first = binValues(host.process([level], 0)[0][0])[0];
        const second = binValues(host.process([level], 512 / SAMPLE_RATE)[0][0])[0];
        assert.ok(second > first);
        host.reset();
        assert.equal(binValues(host.process([level], 0)[0][0])[0], first);
    });
});

test('hosts are independent of one another', () => {
    const a = multi.createHost(SAMPLE_RATE);
    const b = multi.createHost(SAMPLE_RATE);
    try {
        assert.ok(a.loadPlugin(`${EXAMPLE}:amplitudefollower`));
        assert.ok(b.loadPlugin(`${EXAMPLE}:amplitudefollower`));
        a.setParameter('attack', 0.7);
        assert.ok(Math.abs(b.getParameter('attack') - 0.01) < 1e-6);
    } finally {
        a.delete();
        b.delete();
    }
});

test('getRemainingFeatures returns nothing for a plugin that emits per block', () => {
    withPlugin(`${EXAMPLE}:zerocrossing`, { step: 512, block: 512 }, (host) => {
        host.process([new Float32Array(512)], 0);
        const remaining = host.getRemainingFeatures();
        assert.equal(Object.values(remaining || {}).flat().length, 0);
    });
});

// Third-party plugins: their numbers are not ours to pin down, so check only the host's contract
test('every plugin returns well-formed features for a block of noise', () => {
    for (const key of multi.listPlugins()) {
        withPlugin(key, {}, (host, info, { blockSize }) => {
            const out = host.process([noise(blockSize)], 0);
            assert.ok(out && typeof out === 'object', `${key} returned ${out}`);
            for (const [index, features] of Object.entries(out)) {
                assert.ok(Number(index) < info.outputs.length, `${key} output ${index}`);
                let previous = -Infinity;
                for (const f of features) {
                    for (const v of binValues(f)) assert.ok(Number.isFinite(v), `${key}[${index}] value ${v}`);
                    if (f.hasTimestamp) {
                        assert.ok(Number.isFinite(f.timestamp) && f.timestamp >= previous, `${key}[${index}] timestamp`);
                        previous = f.timestamp;
                    }
                }
            }
        });
    }
});

test('ecoacoustic plugins load', { skip: !hasLibrary(ECO) && 'vamp-ecoacoustics not present' }, () => {
    const keys = multi.listPlugins().filter((k) => k.startsWith(`${ECO}:`));
    assert.ok(keys.includes(`${ECO}:aci`));
    withPlugin(`${ECO}:aci`, {}, (host, info) => assert.ok(info.outputs.length > 0));
});
