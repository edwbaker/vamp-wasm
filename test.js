
const fs = require('fs');
const path = require('path');
const VampHostModule = require('./dist/vamp-host.js');

VampHostModule().then(hostModule => {
    console.log("Vamp Host Module Loaded");
    
    // Mount the plugin file into the WASM virtual filesystem
    // [file in dist/, name in the virtual filesystem]; the plugin key prefix is the latter's basename
    const plugins = [
        ['vamp-example-plugins.so', 'vamp-example-plugins.so'],
        ['vamp-ecoacoustics.wasm', 'vamp-ecoacoustics.so'],
    ];
    
    try { hostModule.FS.mkdir('/vamp'); } catch(e) {}

    plugins.forEach(([pluginFileName, vfsName]) => {
        const pluginPath = path.join(__dirname, 'dist', pluginFileName);
        if (fs.existsSync(pluginPath)) {
            console.log(`Loading plugin binary from ${pluginPath}...`);
            const pluginBinary = fs.readFileSync(pluginPath);
            hostModule.FS.writeFile('/vamp/' + vfsName, pluginBinary);
            console.log(`Wrote ${pluginFileName} to virtual filesystem at /vamp/${vfsName}`);
        } else {
            console.log(`Plugin binary ${pluginFileName} not found.`);
        }
    });

    // Set environment variable for Vamp SDK to find it
    process.env.VAMP_PATH = '/vamp';

    const sampleRate = 44100;
    const host = new hostModule.WasmVampHost(sampleRate);
    
    // Set VAMP_PATH environment variable in the C++ environment
    host.setEnv("VAMP_PATH", "/vamp");

    const pluginList = host.listPlugins();
    const pluginsArray = [];
    for (let i = 0; i < pluginList.size(); i++) {
        pluginsArray.push(pluginList.get(i));
    }
    console.log("Available Plugins:", pluginsArray);
    
    // Test loading an ecoacoustic plugin
    const ecoPlugin = "vamp-ecoacoustics:aci";
    if (host.loadPlugin(ecoPlugin)) {
        console.log(`Plugin loaded: ${ecoPlugin}`);
    } else {
        console.error(`Failed to load: ${ecoPlugin}`);
        process.exitCode = 1;
    }

    // Example of how one would process if a plugin was loaded
    if (host.loadPlugin("vamp-example-plugins:zerocrossing")) {
        console.log("Plugin loaded: vamp-example-plugins:zerocrossing");
        host.initialise(1, 512, 512);
        
        // Create dummy audio (1 channel, 512 samples)
        // Note: The C++ code expects an array of Float32Arrays
        const audioBlock = [new Float32Array(512).fill(0.1)];
        
        // Add some zero crossings
        for(let i=0; i<512; i+=50) audioBlock[0][i] = -0.1;

        const features = host.process(audioBlock, 0.0);
        console.log("Features:", JSON.stringify(features, null, 2));
    } else {
        console.error("Failed to load plugin");
        process.exitCode = 1;
    }
});
