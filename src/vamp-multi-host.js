// Loads each plugin library into its own VampHostModule instance.
//
// Every plugin library bundles its own copy of the Vamp SDK (PluginAdapter), and Emscripten
// resolves a side module's symbols to the first definition already loaded. Libraries loaded
// into one module therefore end up using each other's SDK copy, and plugins from the later
// library report no channels or outputs and fail to initialise. Giving each library its own
// module (a separate wasm instance and heap) keeps them isolated, whatever the library was
// built with.
//
//   const multi = await VampMultiHost.create(VampHostModule, [
//       { name: 'vamp-example-plugins.so', data: exampleBytes },
//       { name: 'vamp-ecoacoustics.so', data: ecoBytes },
//   ]);
//   multi.listPlugins();                     // ['vamp-ecoacoustics:aci', ...]
//   multi.describePlugins();                 // [{ key, library, name, description, maker }, ...]
//   const host = multi.createHost(44100);    // same API as WasmVampHost
//   host.loadPlugin('vamp-ecoacoustics:aci');

(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.VampMultiHost = factory();
}(typeof self !== 'undefined' ? self : this, function () {

    const VAMP_DIR = '/vamp';

    // The plugin key prefix is the library's file name without its extension
    function libraryPrefix(name) {
        return name.replace(/^.*[\\/]/, '').replace(/\.(so|wasm)$/, '');
    }

    function vectorToArray(vec) {
        const out = [];
        for (let i = 0; i < vec.size(); i++) out.push(vec.get(i));
        return out;
    }

    class VampMultiHost {
        // createModule: the VampHostModule factory from vamp-host.js
        // libraries: [{ name, data }] with data a Uint8Array of the plugin library
        static async create(createModule, libraries) {
            const multi = new VampMultiHost();
            for (const lib of libraries) {
                const prefix = libraryPrefix(lib.name);
                if (multi._modules.has(prefix)) {
                    throw new Error(`Duplicate plugin library "${prefix}"`);
                }
                const mod = await createModule({
                    preRun: [(m) => {
                        m.ENV = m.ENV || {};
                        m.ENV['VAMP_PATH'] = VAMP_DIR;
                    }],
                });
                try { mod.FS.mkdir(VAMP_DIR); } catch (e) { /* already exists */ }
                mod.FS.writeFile(`${VAMP_DIR}/${prefix}.so`, lib.data);
                // The preRun ENV above does not reach the C environment the plugin loader reads,
                // so set it there too; otherwise loadPlugin fails until listPlugins has run
                const tmp = new mod.WasmVampHost(44100);
                try {
                    tmp.setEnv('VAMP_PATH', VAMP_DIR);
                } finally {
                    tmp.delete();
                }
                multi._modules.set(prefix, mod);
            }
            return multi;
        }

        constructor() {
            this._modules = new Map();   // library prefix -> module
        }

        // Keys of every plugin in every library
        listPlugins() {
            const keys = [];
            for (const mod of this._modules.values()) {
                const tmp = new mod.WasmVampHost(44100);
                try {
                    tmp.setEnv('VAMP_PATH', VAMP_DIR);
                    keys.push(...vectorToArray(tmp.listPlugins()));
                } finally {
                    tmp.delete();
                }
            }
            return [...new Set(keys)];
        }

        // Key, library and descriptive metadata (name, description, maker) of every plugin
        describePlugins() {
            return this.listPlugins().map((key) => {
                const host = this.createHost(44100);
                try {
                    const info = host.loadPlugin(key) ? host.getPluginInfo() : null;
                    return {
                        key,
                        library: key.slice(0, Math.max(key.lastIndexOf(':'), 0)),
                        name: (info && info.name) || key,
                        description: (info && info.description) || '',
                        maker: (info && info.maker) || '',
                    };
                } finally {
                    host.delete();
                }
            });
        }

        createHost(sampleRate) {
            return new MultiHost(this, sampleRate);
        }

        _moduleFor(pluginKey) {
            const i = pluginKey.lastIndexOf(':');
            return this._modules.get(i < 0 ? pluginKey : pluginKey.slice(0, i)) || null;
        }
    }

    // Mirrors WasmVampHost, forwarding to a host in the module that owns the loaded plugin
    class MultiHost {
        constructor(multi, sampleRate) {
            this._multi = multi;
            this._sampleRate = sampleRate;
            this._module = null;
            this._host = null;
        }

        loadPlugin(pluginKey) {
            const mod = this._multi._moduleFor(pluginKey);
            if (!mod) {
                console.error(`No plugin library for "${pluginKey}"`);
                return false;
            }
            if (this._module !== mod) {
                this._release();
                this._host = new mod.WasmVampHost(this._sampleRate);
                this._module = mod;
            }
            return this._host.loadPlugin(pluginKey);
        }

        initialise(channels, stepSize, blockSize) {
            return this._host ? this._host.initialise(channels, stepSize, blockSize) : false;
        }

        process(inputChannels, timestampSec) {
            return this._host ? this._host.process(inputChannels, timestampSec) : null;
        }

        getRemainingFeatures() {
            return this._host ? this._host.getRemainingFeatures() : null;
        }

        setParameter(identifier, value) {
            if (this._host) this._host.setParameter(identifier, value);
        }

        getParameter(identifier) {
            return this._host ? this._host.getParameter(identifier) : null;
        }

        reset() {
            if (this._host) this._host.reset();
        }

        getPluginInfo() {
            return this._host ? this._host.getPluginInfo() : null;
        }

        delete() {
            this._release();
        }

        _release() {
            if (this._host) this._host.delete();
            this._host = null;
            this._module = null;
        }
    }

    return VampMultiHost;
}));
