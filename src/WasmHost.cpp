
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vamp-hostsdk/PluginHostAdapter.h>
#include <vamp-hostsdk/PluginLoader.h>
#include <vamp-hostsdk/RealTime.h>
#include <iostream>
#include <vector>
#include <string>
#include <map>
#include <set>

using namespace emscripten;
using namespace Vamp;
using namespace Vamp::HostExt;

// Declaration of the entry point defined in examples/plugins.cpp
// extern "C" const VampPluginDescriptor *vampGetPluginDescriptor(unsigned int version, unsigned int index);

class WasmVampHost {
public:
    WasmVampHost(float sampleRate) : m_sampleRate(sampleRate), m_plugin(nullptr) {}

    ~WasmVampHost() {
        if (m_plugin) delete m_plugin;
    }

    void setEnv(std::string key, std::string value) {
        setenv(key.c_str(), value.c_str(), 1);
    }

    std::vector<std::string> listPlugins() {
        std::vector<std::string> keys;
        std::set<std::string> seen;
        
        // Use the standard loader to list plugins found in the virtual filesystem
        PluginLoader *loader = PluginLoader::getInstance();
        std::vector<PluginLoader::PluginKey> pluginKeys = loader->listPlugins();
        for (const auto& key : pluginKeys) {
            if (seen.find(key) == seen.end()) {
                keys.push_back(key);
                seen.insert(key);
            }
        }
        return keys;
    }

    bool loadPlugin(std::string pluginKey) {
        if (m_plugin) {
            delete m_plugin;
            m_plugin = nullptr;
        }

        PluginLoader *loader = PluginLoader::getInstance();
        // Note: PluginLoader in Wasm will only find plugins if they are in the virtual filesystem
        // and dlopen is supported, OR if we statically link them and register them.
        m_plugin = loader->loadPlugin(pluginKey, m_sampleRate);
        
        if (!m_plugin) {
            std::cerr << "Failed to load plugin: " << pluginKey << std::endl;
            return false;
        }

        return true;
    }

    bool initialise(int channels, int stepSize, int blockSize) {
        if (!m_plugin) return false;
        m_channels = channels;
        m_stepSize = stepSize;
        m_blockSize = blockSize;
        return m_plugin->initialise(channels, stepSize, blockSize);
    }

    // Process a single block of audio
    // inputChannels is a JS array of Float32Arrays
    val process(val inputChannels, double timestampSec) {
        if (!m_plugin) return val::null();

        int numChannels = inputChannels["length"].as<int>();
        if (numChannels != m_channels) {
            std::cerr << "Channel mismatch" << std::endl;
            return val::null();
        }

        // Allocate buffers
        float** buffers = new float*[numChannels];
        std::vector<std::vector<float>> tempStorage(numChannels);

        for (int c = 0; c < numChannels; ++c) {
            val channelData = inputChannels[c];
            // Copy data from JS Float32Array to C++ vector
            // We assume channelData is a Float32Array or Array
            unsigned int length = channelData["length"].as<unsigned int>();
            tempStorage[c].resize(length);
            
            // Efficient copy using memory view
            // We create a view on the C++ vector memory and ask JS to copy data into it
            // typed_memory_view returns a memory_view object, not a val.
            // We can use it directly to call JS methods if we wrap it in val() or use it as an argument.
            // However, memory_view itself doesn't have a .call method like val does.
            // The correct pattern is to pass the view to a JS function or use it in a way that Embind handles.
            
            // Actually, typed_memory_view returns a helper object that converts to a JS TypedArray when passed to JS.
            // To call "set" on it from C++, we need to be careful.
            // The easiest way to copy FROM JS TO C++ efficiently is to expose the C++ memory as a TypedArray
            // and call .set() on that TypedArray in JS land.
            
            // But here we are in C++.
            // Let's use the val wrapper to treat the memory view as a JS object (TypedArray)
            val view = val(typed_memory_view(length, tempStorage[c].data()));
            view.call<void>("set", channelData);
            
            buffers[c] = tempStorage[c].data();
        }

        RealTime rt = RealTime::fromSeconds(timestampSec);
        Plugin::FeatureSet features = m_plugin->process(buffers, rt);

        delete[] buffers; // Pointers only, data is in tempStorage

        return convertFeatures(features);
    }

    val getRemainingFeatures() {
        if (!m_plugin) return val::null();
        Plugin::FeatureSet features = m_plugin->getRemainingFeatures();
        return convertFeatures(features);
    }

private:
    float m_sampleRate;
    int m_channels;
    int m_stepSize;
    int m_blockSize;
    Plugin *m_plugin;

    val convertFeatures(const Plugin::FeatureSet& features) {
        val result = val::object();
        
        for (const auto& output : features) {
            int outputIdx = output.first;
            val featureList = val::array();
            
            for (const auto& feature : output.second) {
                val fObj = val::object();
                fObj.set("hasTimestamp", feature.hasTimestamp);
                if (feature.hasTimestamp) {
                    // Return seconds
                    double sec = feature.timestamp.sec + (double)feature.timestamp.nsec / 1e9;
                    fObj.set("timestamp", sec);
                }
                fObj.set("hasDuration", feature.hasDuration);
                if (feature.hasDuration) {
                    double dur = feature.duration.sec + (double)feature.duration.nsec / 1e9;
                    fObj.set("duration", dur);
                }
                
                // Efficient copy: create a JS Float32Array from the C++ vector
                // typed_memory_view creates a view into WASM memory
                // val::global("Float32Array").new_(view) creates a COPY of that data in JS memory
                // This is safe because the copy happens immediately, before feature.values goes out of scope
                if (!feature.values.empty()) {
                    val view = val(typed_memory_view(feature.values.size(), feature.values.data()));
                    val values = val::global("Float32Array").new_(view);
                    fObj.set("values", values);
                } else {
                    fObj.set("values", val::array());
                }

                fObj.set("label", feature.label);
                
                featureList.call<void>("push", fObj);
            }
            result.set(std::to_string(outputIdx), featureList);
        }
        return result;
    }
};

EMSCRIPTEN_BINDINGS(vamp_host) {
    class_<WasmVampHost>("WasmVampHost")
        .constructor<float>()
        .function("listPlugins", &WasmVampHost::listPlugins)
        .function("loadPlugin", &WasmVampHost::loadPlugin)
        .function("initialise", &WasmVampHost::initialise)
        .function("process", &WasmVampHost::process)
        .function("getRemainingFeatures", &WasmVampHost::getRemainingFeatures)
        .function("setEnv", &WasmVampHost::setEnv)
        ;
    
    register_vector<std::string>("VectorString");
}
