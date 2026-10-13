
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vamp-hostsdk/PluginHostAdapter.h>
#include <vamp-hostsdk/PluginLoader.h>
#include <vamp-hostsdk/RealTime.h>
#include <iostream>
#include <algorithm>
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
        m_initialised = false;

        PluginLoader *loader = PluginLoader::getInstance();
        // Note: PluginLoader in Wasm will only find plugins if they are in the virtual filesystem
        // and dlopen is supported, OR if we statically link them and register them.
        // ADAPT_ALL_SAFE (input domain + channel count) matches ReVAMP, so frequency-domain
        // plugins receive spectra and channel-count mismatches are mixed/augmented.
        m_plugin = loader->loadPlugin(pluginKey, m_sampleRate, PluginLoader::ADAPT_ALL_SAFE);

        if (!m_plugin) {
            std::cerr << "Failed to load plugin: " << pluginKey << std::endl;
            return false;
        }

        return true;
    }

    bool initialise(int channels, int stepSize, int blockSize) {
        m_initialised = false;
        if (!m_plugin || channels < 1 || stepSize < 1 || blockSize < 1) return false;
        m_channels = channels;
        m_stepSize = stepSize;
        m_blockSize = blockSize;
        m_initialised = m_plugin->initialise(channels, stepSize, blockSize);
        return m_initialised;
    }

    // Process a single block of audio
    // inputChannels is a JS array of Float32Arrays
    val process(val inputChannels, double timestampSec) {
        if (!m_plugin || !m_initialised) {
            std::cerr << "process() called before a successful initialise()" << std::endl;
            return val::null();
        }

        int numChannels = inputChannels["length"].as<int>();
        if (numChannels != m_channels) {
            std::cerr << "Channel mismatch" << std::endl;
            return val::null();
        }

        // Each channel is copied into a buffer of exactly m_blockSize samples: the plugin
        // reads that many, so a short final block is zero-padded and excess is ignored.
        std::vector<std::vector<float>> tempStorage(numChannels);
        std::vector<float*> buffers(numChannels);

        for (int c = 0; c < numChannels; ++c) {
            val channelData = inputChannels[c];
            unsigned int length = channelData["length"].as<unsigned int>();
            unsigned int n = std::min(length, (unsigned int)m_blockSize);
            tempStorage[c].assign(m_blockSize, 0.0f);

            // View the C++ buffer as a typed array and let JS copy into it
            val view = val(typed_memory_view(n, tempStorage[c].data()));
            view.call<void>("set", n < length ? channelData.call<val>("subarray", 0, n) : channelData);

            buffers[c] = tempStorage[c].data();
        }

        RealTime rt = RealTime::fromSeconds(timestampSec);
        Plugin::FeatureSet features = m_plugin->process(buffers.data(), rt);

        return convertFeatures(features);
    }

    val getRemainingFeatures() {
        if (!m_plugin) return val::null();
        Plugin::FeatureSet features = m_plugin->getRemainingFeatures();
        return convertFeatures(features);
    }

    // Parameters must be set before initialise()
    void setParameter(std::string identifier, float value) {
        if (m_plugin) m_plugin->setParameter(identifier, value);
    }

    // null if no plugin is loaded
    val getParameter(std::string identifier) {
        if (!m_plugin) return val::null();
        return val(m_plugin->getParameter(identifier));
    }

    void reset() {
        if (m_plugin) m_plugin->reset();
    }

    // Describe the loaded plugin: metadata, preferred sizes, parameters and outputs.
    // Output indices in the objects returned by process() index into info.outputs.
    val getPluginInfo() {
        if (!m_plugin) return val::null();

        val info = val::object();
        info.set("identifier", m_plugin->getIdentifier());
        info.set("name", m_plugin->getName());
        info.set("description", m_plugin->getDescription());
        info.set("maker", m_plugin->getMaker());
        info.set("copyright", m_plugin->getCopyright());
        info.set("pluginVersion", m_plugin->getPluginVersion());
        info.set("preferredBlockSize", (double)m_plugin->getPreferredBlockSize());
        info.set("preferredStepSize", (double)m_plugin->getPreferredStepSize());
        info.set("minChannelCount", (double)m_plugin->getMinChannelCount());
        info.set("maxChannelCount", (double)m_plugin->getMaxChannelCount());

        val params = val::array();
        for (const auto& p : m_plugin->getParameterDescriptors()) {
            val o = val::object();
            o.set("identifier", p.identifier);
            o.set("name", p.name);
            o.set("description", p.description);
            o.set("unit", p.unit);
            o.set("minValue", p.minValue);
            o.set("maxValue", p.maxValue);
            o.set("defaultValue", p.defaultValue);
            o.set("isQuantized", p.isQuantized);
            if (p.isQuantized) o.set("quantizeStep", p.quantizeStep);
            val names = val::array();
            for (const auto& n : p.valueNames) names.call<void>("push", n);
            o.set("valueNames", names);
            params.call<void>("push", o);
        }
        info.set("parameters", params);

        val outputs = val::array();
        for (const auto& d : m_plugin->getOutputDescriptors()) {
            val o = val::object();
            o.set("identifier", d.identifier);
            o.set("name", d.name);
            o.set("description", d.description);
            o.set("unit", d.unit);
            o.set("hasFixedBinCount", d.hasFixedBinCount);
            if (d.hasFixedBinCount) o.set("binCount", (double)d.binCount);
            o.set("hasKnownExtents", d.hasKnownExtents);
            if (d.hasKnownExtents) {
                o.set("minValue", d.minValue);
                o.set("maxValue", d.maxValue);
            }
            const char* sampleType =
                d.sampleType == Plugin::OutputDescriptor::OneSamplePerStep ? "OneSamplePerStep" :
                d.sampleType == Plugin::OutputDescriptor::FixedSampleRate ? "FixedSampleRate" :
                "VariableSampleRate";
            o.set("sampleType", sampleType);
            o.set("sampleRate", d.sampleRate);
            o.set("hasDuration", d.hasDuration);
            outputs.call<void>("push", o);
        }
        info.set("outputs", outputs);

        return info;
    }

private:
    float m_sampleRate;
    int m_channels = 0;
    int m_stepSize = 0;
    int m_blockSize = 0;
    bool m_initialised = false;
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
        .function("setParameter", &WasmVampHost::setParameter)
        .function("getParameter", &WasmVampHost::getParameter)
        .function("reset", &WasmVampHost::reset)
        .function("getPluginInfo", &WasmVampHost::getPluginInfo)
        .function("setEnv", &WasmVampHost::setEnv)
        ;
    
    register_vector<std::string>("VectorString");
}
