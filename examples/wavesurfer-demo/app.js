const statusEl = document.getElementById('status');
const pluginSelect = document.getElementById('plugin-select');
const paramsEl = document.getElementById('params');
const runButton = document.getElementById('run');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const playerEl = document.getElementById('player');
const resultsEl = document.getElementById('results');

// Plugin libraries in dist/ as [file, name in the virtual filesystem]. The plugin key prefix
// comes from the name, so vamp-ecoacoustics.wasm becomes vamp-ecoacoustics:<plugin>.
const pluginLibraries = [
    ['vamp-example-plugins.so', 'vamp-example-plugins.so'],
    ['vamp-ecoacoustics.wasm', 'vamp-ecoacoustics.so'],
];

let multiHost = null;
let wavesurfer = null;
let regions = null;
let paramValues = {};

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status ' + cls;
}

async function fetchPluginLibraries() {
    const libraries = [];
    for (const [fileName, name] of pluginLibraries) {
        const response = await fetch(`../../dist/${fileName}`);
        if (!response.ok) {
            console.warn(`Failed to fetch plugin ${fileName}: ${response.statusText}`);
            continue;
        }
        libraries.push({ name, data: new Uint8Array(await response.arrayBuffer()) });
    }
    return libraries;
}

(async () => {
    try {
        // Each library gets its own module instance, so libraries cannot interfere with each other
        multiHost = await VampMultiHost.create(VampHostModule, await fetchPluginLibraries());
        const keys = multiHost.listPlugins();
        for (const key of keys) pluginSelect.add(new Option(key, key));
        pluginSelect.disabled = keys.length === 0;
        buildParameterControls();
        setStatus(keys.length ? 'Ready' : 'No plugins found (check console)', keys.length ? 'ready' : 'error');
    } catch (err) {
        console.error(err);
        setStatus('Error: ' + err.message, 'error');
    }
})();

// --- Plugin parameters ---

function buildParameterControls() {
    paramsEl.innerHTML = '';
    paramValues = {};
    if (!pluginSelect.value) return;

    const host = multiHost.createHost(44100);
    try {
        if (!host.loadPlugin(pluginSelect.value)) return;
        for (const p of host.getPluginInfo().parameters) {
            paramValues[p.identifier] = p.defaultValue;

            const row = document.createElement('div');
            row.className = 'param-row';
            row.title = p.description || '';
            const label = document.createElement('label');
            label.textContent = p.unit ? `${p.name} (${p.unit})` : p.name;
            const input = document.createElement('input');
            input.type = 'number';
            input.min = p.minValue;
            input.max = p.maxValue;
            input.step = p.isQuantized && p.quantizeStep ? p.quantizeStep : (p.maxValue - p.minValue) / 200 || 1;
            input.value = p.defaultValue;
            input.addEventListener('change', () => {
                const v = parseFloat(input.value);
                if (!isNaN(v)) paramValues[p.identifier] = Math.min(p.maxValue, Math.max(p.minValue, v));
            });
            row.append(label, input);
            paramsEl.appendChild(row);
        }
    } finally {
        host.delete();
    }
}

pluginSelect.addEventListener('change', buildParameterControls);
runButton.addEventListener('click', runPlugin);

// --- Audio and wavesurfer ---

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
});
document.getElementById('play-pause').addEventListener('click', () => wavesurfer && wavesurfer.playPause());

function loadFile(file) {
    if (!file) return;
    if (wavesurfer) wavesurfer.destroy();
    document.getElementById('waveform').innerHTML = '';
    resultsEl.innerHTML = '';
    runButton.disabled = true;
    setStatus(`Decoding ${file.name}...`, 'loading');

    regions = WaveSurfer.Regions.create();
    wavesurfer = WaveSurfer.create({
        container: '#waveform',
        height: 128,
        waveColor: '#4caf50',
        progressColor: '#2e7d32',
        plugins: [
            regions,
            WaveSurfer.Timeline.create(),
            WaveSurfer.Spectrogram.create({ labels: true, height: 200, splitChannels: false }),
        ],
    });
    wavesurfer.on('error', (err) => setStatus('Error: ' + err, 'error'));
    wavesurfer.on('decode', () => {
        playerEl.style.display = 'block';
        runButton.disabled = !multiHost || pluginSelect.disabled;
        setStatus(`Loaded ${file.name}`, 'ready');
        runPlugin();
    });
    wavesurfer.loadBlob(file);
}

// --- Running a plugin ---

function runPlugin() {
    const audioBuffer = wavesurfer && wavesurfer.getDecodedData();
    if (!audioBuffer || !pluginSelect.value) return;

    const pluginKey = pluginSelect.value;
    setStatus(`Running ${pluginKey}...`, 'loading');
    resultsEl.innerHTML = '';
    regions.clearRegions();

    const host = multiHost.createHost(audioBuffer.sampleRate);
    try {
        if (!host.loadPlugin(pluginKey)) throw new Error(`Failed to load plugin ${pluginKey}`);
        const info = host.getPluginInfo();

        // Parameters must be applied before initialise()
        for (const [id, value] of Object.entries(paramValues)) host.setParameter(id, value);

        const blockSize = info.preferredBlockSize || 1024;
        const stepSize = info.preferredStepSize || blockSize;
        // Only the first channel is analysed
        if (!host.initialise(1, stepSize, blockSize)) {
            throw new Error(`Failed to initialise plugin with 1 channels, step ${stepSize}, block ${blockSize}`);
        }

        const data = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const results = {};
        const start = performance.now();

        // The host zero-pads a short final block
        for (let pos = 0; pos < data.length; pos += stepSize) {
            collect(results, host.process([data.subarray(pos, pos + blockSize)], pos / sampleRate));
        }
        collect(results, host.getRemainingFeatures());

        setStatus(`Done in ${(performance.now() - start).toFixed(0)}ms`, 'ready');
        showResults(info, results);
    } catch (err) {
        console.error(err);
        setStatus('Error: ' + err.message, 'error');
    } finally {
        host.delete();
    }
}

function collect(results, features) {
    if (!features) return;
    for (const [output, list] of Object.entries(features)) {
        (results[output] = results[output] || []).push(...list);
    }
}

// Timestamped features become regions on the waveform; every output is also listed in a table.
function showResults(info, results) {
    for (const [index, features] of Object.entries(results)) {
        const output = info.outputs[index] || { name: `Output ${index}` };

        const heading = document.createElement('h2');
        heading.textContent = `${output.name} (${features.length} features)`;
        resultsEl.appendChild(heading);

        const rows = features.slice(0, 500).map((f) => {
            const values = Object.values(f.values || {}).map((v) => Number(v.toPrecision(6))).join(', ');
            return `<tr><td>${f.hasTimestamp ? f.timestamp.toFixed(3) : ''}</td><td>${values}</td><td>${f.label || ''}</td></tr>`;
        });
        const wrap = document.createElement('div');
        wrap.className = 'scroll';
        wrap.innerHTML = `<table><tr><th>Time (s)</th><th>Values</th><th>Label</th></tr>${rows.join('')}</table>`;
        resultsEl.appendChild(wrap);

        for (const f of features) {
            if (!f.hasTimestamp) continue;
            regions.addRegion({
                start: f.timestamp,
                end: f.timestamp + (f.hasDuration ? f.duration : 0),
                content: f.label || undefined,
                color: 'rgba(255, 87, 34, 0.3)',
                drag: false,
                resize: false,
            });
        }
    }
}
