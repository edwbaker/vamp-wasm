# Vamp Wasm Host

This directory contains a WebAssembly implementation of a Vamp Plugin Host, allowing you to run Vamp plugins in a web browser or Node.js environment.

## Prerequisites

- **Emscripten**: You need the Emscripten SDK (`emcc`) installed and in your PATH.
- **Node.js**: For running the test script.

## Building

This project uses `make` for building.

To build everything:
```bash
make
```

To build individual components:
```bash
make host
make plugins
```

## Usage

### Node.js
Run the test script to verify the host and plugins:
```bash
node test.js
```

### Web Demo
1. Serve the root directory (e.g., using `python -m http.server` or `npx http-server`).
2. Open `web-demo/index.html` in your browser.
3. Select a plugin and drop an audio file to analyze.

### Using as a JavaScript Library

You can use the generated `vamp-host.js` in your own web or Node.js projects.

**Important**: You must serve both `vamp-host.js` and `vamp-host.wasm`. The JavaScript file automatically fetches the WASM file. By default, it expects `vamp-host.wasm` to be in the same directory as `vamp-host.js`.

1.  **Include the Script**:
    ```html
    <script src="dist/vamp-host.js"></script>
    ```

2.  **Initialize the Module**:
    ```javascript
    VampHostModule().then(hostModule => {
        // 1. Mount plugins to the virtual filesystem
        // (Assuming you have fetched the .so file content as a Uint8Array)
        hostModule.FS.mkdir('/vamp');
        hostModule.FS.writeFile('/vamp/my-plugin.so', pluginBinaryData);

        // 2. Create the Host
        const sampleRate = 44100;
        const host = new hostModule.WasmVampHost(sampleRate);
        
        // 3. Configure Environment
        host.setEnv("VAMP_PATH", "/vamp");

        // 4. Load a Plugin
        if (host.loadPlugin("my-plugin:identifier")) {

            // Metadata, preferred block/step sizes, parameters and outputs.
            // Output indices in the features from process() index info.outputs.
            const info = host.getPluginInfo();

            // Parameters must be set before initialise()
            host.setParameter("threshold", 0.5);

            // 5. Initialize (channels, stepSize, blockSize)
            host.initialise(1, 512, 1024);

            // 6. Process Audio
            // Input must be an array of Float32Arrays (one per channel)
            const inputBlock = [new Float32Array(1024)]; 
            const features = host.process(inputBlock, 0.0); // timestamp
            
            console.log(features);
        }
    });
    ```

## Plugins

The host supports dynamic loading of plugins compiled as Emscripten side modules (`.so`).
- Plugins must be placed in the virtual filesystem (e.g., `/vamp`).
- The host is configured to look in `/vamp` by setting the `VAMP_PATH` environment variable.
- Plugins are loaded with the input-domain and channel-count adapters (`ADAPT_ALL_SAFE`, as in ReVAMP), so always pass time-domain audio: frequency-domain plugins receive spectra, and channel counts are mixed or duplicated as needed.
- In a browser, run the host in a Web Worker: `dlopen()` compiles the plugin synchronously, which browsers only allow for small modules on the main thread.

## Project Structure

- `src/WasmHost.cpp`: The C++ host implementation using Embind.
- `web-demo/`: Simple web interface for testing.
- `inst/vamp/`: Source code for the Vamp SDK and example plugins.
