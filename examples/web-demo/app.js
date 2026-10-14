
let multiHost = null;
let vampHost = null;
let audioContext = null;
let currentAudioBuffer = null;

const statusEl = document.getElementById('status');
const pluginSelect = document.getElementById('plugin-select');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const outputEl = document.getElementById('output');
const canvas = document.getElementById('waveform');
const ctx = canvas.getContext('2d');

// Plugin libraries in dist/ as [file, name in the virtual filesystem]. The plugin key prefix
// comes from the name, so vamp-ecoacoustics.wasm becomes vamp-ecoacoustics:<plugin>.
const pluginLibraries = [
    ['vamp-example-plugins.so', 'vamp-example-plugins.so'],
    ['vamp-ecoacoustics.wasm', 'vamp-ecoacoustics.so'],
];

if (typeof VampHostModule === 'undefined' || typeof VampMultiHost === 'undefined') {
    statusEl.textContent = "Error: could not load vamp-host.js or vamp-multi-host.js (check that they are served)";
    statusEl.className = "status error";
    throw new Error("VampHostModule or VampMultiHost is not defined");
}

(async () => {
    try {
        statusEl.textContent = "Loading plugins...";
        const libraries = await fetchPluginLibraries();
        // Each library gets its own module instance, so libraries cannot interfere with each other
        multiHost = await VampMultiHost.create(VampHostModule, libraries);
        console.log("WASM modules initialised");
        initialiseHost();
        statusEl.textContent = "Ready";
        statusEl.className = "status ready";
    } catch (err) {
        console.error(err);
        statusEl.textContent = "Error: " + err.message;
        statusEl.className = "status error";
    }
})();

const paramsEl = document.getElementById('params');

// Current parameter values, keyed by identifier, for the selected plugin
let paramValues = {};
let rerunTimer = null;

// Re-run processing when plugin changes
pluginSelect.addEventListener('change', () => {
    buildParameterControls(pluginSelect.value);
    if (currentAudioBuffer && pluginSelect.value) {
        processAudio(currentAudioBuffer, pluginSelect.value);
    }
});

function scheduleRerun() {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => {
        if (currentAudioBuffer && pluginSelect.value) {
            processAudio(currentAudioBuffer, pluginSelect.value);
        }
    }, 250);
}

// Query the plugin's parameter descriptors and build an editor row for each
function buildParameterControls(pluginKey) {
    paramsEl.innerHTML = '';
    paramValues = {};
    if (!multiHost || !pluginKey) return;

    const host = multiHost.createHost(currentAudioBuffer ? currentAudioBuffer.sampleRate : 44100);
    try {
        if (!host.loadPlugin(pluginKey)) return;
        const info = host.getPluginInfo();
        for (const p of info.parameters) {
            paramValues[p.identifier] = p.defaultValue;
            paramsEl.appendChild(createParameterRow(p));
        }
    } finally {
        host.delete();
    }
}

function createParameterRow(p) {
    const row = document.createElement('div');
    row.className = 'param-row';
    row.title = p.description || '';

    const label = document.createElement('label');
    label.textContent = p.unit ? `${p.name} (${p.unit})` : p.name;
    row.appendChild(label);

    const setValue = (v) => {
        paramValues[p.identifier] = v;
        scheduleRerun();
    };

    let reset;
    if (p.isQuantized && p.valueNames && p.valueNames.length) {
        // Enumerated parameter: dropdown of named values
        const sel = document.createElement('select');
        sel.style.margin = '0';
        p.valueNames.forEach((name, i) => {
            const o = document.createElement('option');
            o.value = p.minValue + i * (p.quantizeStep || 1);
            o.textContent = name;
            sel.appendChild(o);
        });
        sel.value = p.defaultValue;
        sel.addEventListener('change', () => setValue(parseFloat(sel.value)));
        row.appendChild(sel);
        reset = () => { sel.value = p.defaultValue; };
    } else {
        const step = p.isQuantized && p.quantizeStep ? p.quantizeStep : (p.maxValue - p.minValue) / 200 || 1;
        const range = document.createElement('input');
        range.type = 'range';
        const num = document.createElement('input');
        num.type = 'number';
        for (const el of [range, num]) {
            el.min = p.minValue;
            el.max = p.maxValue;
            el.step = step;
            el.value = p.defaultValue;
        }
        range.addEventListener('input', () => { num.value = range.value; setValue(parseFloat(range.value)); });
        num.addEventListener('change', () => {
            const v = Math.min(p.maxValue, Math.max(p.minValue, parseFloat(num.value)));
            if (isNaN(v)) return;
            num.value = v;
            range.value = v;
            setValue(v);
        });
        row.appendChild(range);
        row.appendChild(num);
        reset = () => { range.value = num.value = p.defaultValue; };
    }

    // Select-type rows only have two grid cells filled, so add the reset button last
    const btn = document.createElement('button');
    btn.textContent = 'Reset';
    btn.addEventListener('click', () => { reset(); setValue(p.defaultValue); });
    row.appendChild(btn);
    return row;
}

async function fetchPluginLibraries() {
    const libraries = [];
    for (const [fileName, name] of pluginLibraries) {
        try {
            const response = await fetch(`../../dist/${fileName}`);
            if (!response.ok) {
                console.warn(`Failed to fetch plugin ${fileName}: ${response.statusText}`);
                continue;
            }
            libraries.push({ name, data: new Uint8Array(await response.arrayBuffer()) });
            console.log(`${fileName} fetched`);
        } catch (err) {
            console.error(`Error loading ${fileName}:`, err);
        }
    }
    return libraries;
}

function initialiseHost() {
    const plugins = multiHost.listPlugins();
    console.log("Plugins found:", plugins);

    pluginSelect.innerHTML = '';
    if (plugins.length === 0) {
        const option = document.createElement('option');
        option.text = "No plugins found (check console)";
        pluginSelect.add(option);
        pluginSelect.disabled = true;
    } else {
        for (const key of plugins) {
            const option = document.createElement('option');
            option.value = key;
            option.text = key;
            pluginSelect.add(option);
        }
        pluginSelect.disabled = false;
    }

    buildParameterControls(pluginSelect.value);
}

// Drag and Drop Handlers
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleFile(e.dataTransfer.files[0]);
    }
});

async function handleFile(file) {
    if (!file) return;
    if (!multiHost) return;
    
    const pluginKey = pluginSelect.value;
    if (!pluginKey) {
        alert("Please select a plugin first.");
        return;
    }

    statusEl.textContent = `Decoding ${file.name}...`;
    statusEl.className = "status loading";
    outputEl.textContent = "Processing...";

    try {
        const arrayBuffer = await file.arrayBuffer();
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        currentAudioBuffer = audioBuffer; // Store for re-processing
        processAudio(audioBuffer, pluginKey);
        
    } catch (err) {
        console.error(err);
        statusEl.textContent = "Error processing file: " + err.message;
        statusEl.className = "status error";
    }
}

function processAudio(audioBuffer, pluginKey) {
    statusEl.textContent = `Running ${pluginKey}...`;
    
    const sampleRate = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    
    // Create host
    vampHost = multiHost.createHost(sampleRate);
    
    if (!vampHost.loadPlugin(pluginKey)) {
        vampHost.delete();
        throw new Error(`Failed to load plugin ${pluginKey}`);
    }
    
    // Initialise (using standard block size, e.g. 1024)
    // Note: ZeroCrossing plugin prefers small blocks, but 1024 is standard.
    // However, if the plugin returns nothing, it might be because the audio is silent 
    // or the threshold is not met.
    // Parameters must be applied before initialise()
    for (const [id, value] of Object.entries(paramValues)) {
        vampHost.setParameter(id, value);
    }

    const blockSize = 1024;
    const stepSize = 1024; // No overlap for simplicity
    
    // IMPORTANT: Some plugins require specific block sizes or step sizes.
    // Ideally we should query the plugin's preferred block size.
    // But for now, let's stick to 1024.
    
    // Check channel count support
    // ZeroCrossing supports 1 channel (mono)
    // If audio is stereo, we might need to mix down or process only one channel.
    // The plugin's initialise method checks: if (channels < getMinChannelCount() || channels > getMaxChannelCount()) return false;
    // ZeroCrossing inherits from Plugin, which defaults min=1, max=1.
    
    let processingChannels = numChannels;
    if (numChannels > 1) {
        console.warn("Plugin might only support mono. Using first channel only.");
        processingChannels = 1;
    }

    if (!vampHost.initialise(processingChannels, stepSize, blockSize)) {
         vampHost.delete();
         throw new Error(`Failed to initialise plugin with ${processingChannels} channels, step ${stepSize}, block ${blockSize}`);
    }
    
    const length = audioBuffer.length;
    const results = {};
    
    // Process in blocks
    // We need to convert AudioBuffer to the format expected by process()
    // process() expects an array of Float32Arrays (one per channel)
    
    // Pre-allocate channel data pointers/arrays to avoid creating them every loop?
    // The JS API expects a JS Array of Float32Arrays.
    
    const channelData = [];
    for (let c = 0; c < numChannels; c++) {
        channelData.push(audioBuffer.getChannelData(c));
    }
    
    let processedSamples = 0;
    const startTime = performance.now();
    
    // We reuse the same Float32Array views to avoid allocation overhead
    const blockInput = [];
    for (let c = 0; c < processingChannels; c++) {
        blockInput.push(new Float32Array(blockSize));
    }
    
    while (processedSamples + blockSize <= length) {
        // Fill block
        for (let c = 0; c < processingChannels; c++) {
            // Subarray is a view, fast
            const chunk = channelData[c].subarray(processedSamples, processedSamples + blockSize);
            // We can pass this chunk directly if the C++ code handles it.
            // Our C++ code expects an object with .length and index access.
            // Passing the subarray directly is best.
            blockInput[c] = chunk;
        }
        
        const timestamp = processedSamples / sampleRate;
        
        // Debug: check if we are passing valid data
        // console.log("Processing block at", timestamp, blockInput[0][0]);
        
        const features = vampHost.process(blockInput, timestamp);
        
        // Accumulate features
        // features is an object { outputIndex: [featureObjects] }
        // We'll just dump them to a list
        if (features) {
            mergeFeatures(results, features);
        }
        
        processedSamples += stepSize;
    }
    
    // Get remaining features
    const remaining = vampHost.getRemainingFeatures();
    mergeFeatures(results, remaining);
    
    const endTime = performance.now();
    const duration = (endTime - startTime).toFixed(2);
    
    statusEl.textContent = `Done in ${duration}ms`;
    statusEl.className = "status ready";
    
    outputEl.textContent = JSON.stringify(results, null, 2);
    
    // Render Visualisation
    renderVisualisation(audioBuffer, results);

    // Cleanup
    vampHost.delete();
}

function mergeFeatures(allResults, newFeatures) {
    // newFeatures is { "0": [...], "1": [...] }
    // We want to append to allResults
    const keys = Object.keys(newFeatures); // This returns strings "0", "1"
    for (const key of keys) {
        if (!allResults[key]) allResults[key] = [];
        
        // The C++ binding returns a Vector/Array of objects.
        // We iterate and push.
        const list = newFeatures[key];
        // list is a JS Array because we converted it in C++ (val::array)
        for (let i = 0; i < list.length; i++) {
            allResults[key].push(list[i]);
        }
    }
}

// --- Visualisation ---

function renderVisualisation(audioBuffer, results) {
    // Use the global canvas and ctx defined at the top
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    // Set canvas resolution (handle high DPI)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    
    ctx.scale(dpr, dpr);
    
    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Draw Waveform (Mono mixdown for simplicity)
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;
    
    ctx.fillStyle = '#4caf50';
    ctx.beginPath();
    
    for (let i = 0; i < width; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
            const index = (i * step) + j;
            if (index < data.length) {
                const datum = data[index];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
        }
        
        const yMin = amp - (max * amp);
        const yMax = amp - (min * amp);
        
        ctx.fillRect(i, yMin, 1, Math.max(1, yMax - yMin));
    }
    
    // Draw Features
    // Output 0: Counts (Curve/Values) - Draw as Line Graph
    if (results["0"]) {
        drawFeatureCurve(ctx, results["0"], audioBuffer.duration, width, height, '#ffeb3b');
    }
    
    // Output 1: Locations (Timestamps) - Draw as Markers
    if (results["1"]) {
        drawFeatureMarkers(ctx, results["1"], audioBuffer.duration, width, height, '#ff5722');
    }
}

function drawFeatureCurve(ctx, features, totalDuration, width, height, colour) {
    if (!features.length) return;
    
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    // Find max value for normalisation
    let maxVal = 0;
    for (const f of features) {
        if (f.values && f.values.length > 0) {
            if (f.values[0] > maxVal) maxVal = f.values[0];
        }
    }
    if (maxVal === 0) maxVal = 1;
    
    const stepX = width / features.length;
    
    for (let i = 0; i < features.length; i++) {
        const f = features[i];
        const val = (f.values && f.values.length > 0) ? f.values[0] : 0;
        
        const x = i * stepX;
        const y = height - (val / maxVal) * height; // Scale to fit
        
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function drawFeatureMarkers(ctx, features, totalDuration, width, height, colour) {
    // Adjust alpha based on density to avoid "solid box" effect
    const density = features.length / width;
    let alpha = 0.7;
    if (density > 0.5) alpha = 0.4;
    if (density > 2) alpha = 0.1;
    if (density > 10) alpha = 0.05;

    ctx.fillStyle = colour;
    ctx.globalAlpha = alpha;
    
    for (const f of features) {
        if (f.hasTimestamp) {
            const t = f.timestamp;
            const x = (t / totalDuration) * width;
            
            // Draw a thin vertical line
            ctx.fillRect(x, 0, 1, height);
        }
    }
    ctx.globalAlpha = 1.0;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
