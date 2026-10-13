# Detect Windows
ifdef OS
   # Setup Emscripten environment for each command
   # Use cmd /c to ensure batch files are handled correctly
   CXX = cmd /c "call emsdk\emsdk_env.bat && call em++"
   RM = del /Q
   FixPath = $(subst /,\,$1)
   MKDIR_CMD = if not exist $(DIST_DIR) mkdir $(DIST_DIR)
   CLEAN_CMD = if exist $(DIST_DIR) rmdir /s /q $(DIST_DIR)
else
   CXX = em++
   RM = rm -rf
   FixPath = $1
   MKDIR_CMD = mkdir -p $(DIST_DIR)
   CLEAN_CMD = rm -rf $(DIST_DIR)
endif

CXXFLAGS = -O3 -g0 -std=c++17 -Iinst/vamp
DIST_DIR = dist

# Host Flags
HOST_LDFLAGS = -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME="VampHostModule" \
               -s ALLOW_MEMORY_GROWTH=1 --bind -s ENVIRONMENT=web,worker,node \
               -s MAIN_MODULE=1 -s "EXPORTED_RUNTIME_METHODS=['FS']"

# Side Module Flags
SIDE_LDFLAGS = -s SIDE_MODULE=1

# Source Files
# The host must not contain the plugin SDK (vamp-sdk/*.cpp): Emscripten resolves a side
# module's symbols to the main module's definitions first, so plugins would run the
# host's copy of PluginAdapter, which breaks if their SDK copy differs.
HOST_SOURCES = \
    inst/vamp/src/vamp-hostsdk/PluginBufferingAdapter.cpp \
    inst/vamp/src/vamp-hostsdk/PluginChannelAdapter.cpp \
    inst/vamp/src/vamp-hostsdk/PluginHostAdapter.cpp \
    inst/vamp/src/vamp-hostsdk/PluginInputDomainAdapter.cpp \
    inst/vamp/src/vamp-hostsdk/PluginLoader.cpp \
    inst/vamp/src/vamp-hostsdk/PluginSummarisingAdapter.cpp \
    inst/vamp/src/vamp-hostsdk/PluginWrapper.cpp \
    inst/vamp/src/vamp-hostsdk/RealTime.cpp \
    inst/vamp/src/vamp-hostsdk/Files.cpp \
    src/WasmHost.cpp

EXAMPLE_PLUGIN_SOURCES = \
    inst/vamp/examples/ZeroCrossing.cpp \
    inst/vamp/examples/SpectralCentroid.cpp \
    inst/vamp/examples/PercussionOnsetDetector.cpp \
    inst/vamp/examples/FixedTempoEstimator.cpp \
    inst/vamp/examples/AmplitudeFollower.cpp \
    inst/vamp/examples/PowerSpectrum.cpp \
    inst/vamp/examples/plugins.cpp \
    inst/vamp/src/vamp-sdk/PluginAdapter.cpp \
    inst/vamp/src/vamp-sdk/RealTime.cpp

# Targets
.PHONY: all host plugins clean

all: host plugins

$(DIST_DIR):
	$(MKDIR_CMD)

host: $(DIST_DIR)
	$(CXX) $(CXXFLAGS) $(HOST_LDFLAGS) -o $(DIST_DIR)/vamp-host.js $(HOST_SOURCES)

plugins: $(DIST_DIR)
	$(CXX) $(CXXFLAGS) $(SIDE_LDFLAGS) -o $(DIST_DIR)/vamp-example-plugins.so $(EXAMPLE_PLUGIN_SOURCES)

clean:
	$(CLEAN_CMD)
