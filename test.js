const fs = require('fs');
const path = require('path');
const VampHostModule = require('./dist/vamp-host.js');
const VampMultiHost = require('./src/vamp-multi-host.js');

// [file in dist/, name in the virtual filesystem]; the plugin key prefix is the latter's basename
const pluginFiles = [
    ['vamp-example-plugins.so', 'vamp-example-plugins.so'],
    ['vamp-ecoacoustics.wasm', 'vamp-ecoacoustics.so'],
];

const libraries = [];
for (const [fileName, name] of pluginFiles) {
    const pluginPath = path.join(__dirname, 'dist', fileName);
    if (fs.existsSync(pluginPath)) {
        console.log(`Loading plugin binary from ${pluginPath}...`);
        libraries.push({ name, data: new Uint8Array(fs.readFileSync(pluginPath)) });
    } else {
        console.log(`Plugin binary ${fileName} not found.`);
    }
}

function fail(message) {
    console.error(message);
    process.exitCode = 1;
}

VampMultiHost.create(VampHostModule, libraries).then(multi => {
    console.log("Vamp Host Modules Loaded");

    const pluginsArray = multi.listPlugins();
    console.log("Available Plugins:", pluginsArray);

    // Every plugin must initialise with a single channel once all libraries are loaded together.
    // Libraries sharing one module used to break each other (no channels or outputs reported).
    for (const key of pluginsArray) {
        const host = multi.createHost(44100);
        if (!host.loadPlugin(key)) {
            fail(`Failed to load: ${key}`);
        } else {
            const info = host.getPluginInfo();
            const block = info.preferredBlockSize || 1024;
            const step = info.preferredStepSize || block;
            if (!host.initialise(1, step, block) || info.outputs.length === 0) {
                fail(`Failed to initialise ${key} (channels ${info.minChannelCount}-${info.maxChannelCount}, ${info.outputs.length} outputs)`);
            }
        }
        host.delete();
    }

    // Test loading an ecoacoustic plugin
    const ecoPlugin = "vamp-ecoacoustics:aci";
    const ecoHost = multi.createHost(44100);
    if (ecoHost.loadPlugin(ecoPlugin)) {
        console.log(`Plugin loaded: ${ecoPlugin}`);
    } else {
        fail(`Failed to load: ${ecoPlugin}`);
    }
    ecoHost.delete();

    // Example of how one would process if a plugin was loaded
    const host = multi.createHost(44100);
    if (host.loadPlugin("vamp-example-plugins:zerocrossing")) {
        console.log("Plugin loaded: vamp-example-plugins:zerocrossing");
        host.initialise(1, 512, 512);

        // Create dummy audio (1 channel, 512 samples)
        // Note: The C++ code expects an array of Float32Arrays
        const audioBlock = [new Float32Array(512).fill(0.1)];

        // Add some zero crossings
        for (let i = 0; i < 512; i += 50) audioBlock[0][i] = -0.1;

        const features = host.process(audioBlock, 0.0);
        console.log("Features:", JSON.stringify(features, null, 2));
    } else {
        fail("Failed to load plugin");
    }
    host.delete();
}).catch(err => fail(err.stack || String(err)));
