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
2. Open `examples/web-demo/index.html` in your browser.
3. Select a plugin and drop an audio file to analyse.

`examples/wavesurfer-demo/index.html` is a second demo that shows the audio with [wavesurfer.js](https://wavesurfer.xyz) (waveform, spectrogram, playback), loaded from `cdn.audioblast.org`. Timestamped plugin features are drawn as regions on the waveform and every output is listed in a table.

### Using as a JavaScript Library

You can use the generated `vamp-host.js` in your own web or Node.js projects.

**Important**: You must serve `vamp-host.js`, `vamp-host.wasm` and `src/vamp-multi-host.js`. The JavaScript file automatically fetches the WASM file. By default, it expects `vamp-host.wasm` to be in the same directory as `vamp-host.js`.

Plugins are loaded through `VampMultiHost`, which gives each plugin library its own module instance. Every library bundles its own copy of the Vamp SDK, and libraries sharing one module use each other's copy, so the plugins of the later-loaded library fail to initialise.

1.  **Include the Scripts**:
    ```html
    <script src="dist/vamp-host.js"></script>
    <script src="src/vamp-multi-host.js"></script>
    ```
    In Node.js, use `require('./dist/vamp-host.js')` and `require('./src/vamp-multi-host.js')`.

2.  **Load the Plugin Libraries**:
    ```javascript
    // Each library is the content of a plugin .so as a Uint8Array. The plugin key prefix
    // is the name without its extension.
    const multi = await VampMultiHost.create(VampHostModule, [
        { name: 'my-plugin.so', data: pluginBinaryData },
    ]);
    multi.listPlugins();                  // ['my-plugin:identifier', ...]
    multi.describePlugins();              // [{ key, library, name, description, maker }, ...]
    ```

3.  **Create a Host and Load a Plugin**:
    ```javascript
    const sampleRate = 44100;
    const host = multi.createHost(sampleRate);

    if (host.loadPlugin("my-plugin:identifier")) {

        // Metadata, preferred block/step sizes, parameters and outputs.
        // Output indices in the features from process() index info.outputs.
        const info = host.getPluginInfo();

        // Parameters must be set before initialise()
        host.setParameter("threshold", 0.5);

        // Initialise (channels, stepSize, blockSize)
        host.initialise(1, 512, 1024);

        // Process Audio
        // Input must be an array of Float32Arrays (one per channel)
        const inputBlock = [new Float32Array(1024)];
        const features = host.process(inputBlock, 0.0); // timestamp

        console.log(features);
        host.delete();
    }
    ```

## Plugins

The host supports dynamic loading of plugins compiled as Emscripten side modules (`.so`).
- Plugins must be placed in the virtual filesystem (e.g., `/vamp`).
- The host is configured to look in `/vamp` by setting the `VAMP_PATH` environment variable.
- Plugins are loaded with the input-domain and channel-count adapters (`ADAPT_ALL_SAFE`, as in ReVAMP), so always pass time-domain audio: frequency-domain plugins receive spectra, and channel counts are mixed or duplicated as needed.
- In a browser, run the host in a Web Worker: `dlopen()` compiles the plugin synchronously, which browsers only allow for small modules on the main thread.

## Project Structure

- `src/WasmHost.cpp`: The C++ host implementation using Embind.
- `src/vamp-multi-host.js`: Loads each plugin library into its own module instance.
- `examples/web-demo/`: Simple web interface for testing.
- `examples/wavesurfer-demo/`: Demo using wavesurfer.js for waveform, spectrogram and playback.
- `inst/vamp/`: Source code for the Vamp SDK and example plugins.
