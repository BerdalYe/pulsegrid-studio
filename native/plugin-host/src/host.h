// PulseGrid plugin host: what main.cpp, instance.cpp and editor.cpp share.
#pragma once

#include <windows.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "nlohmann/json.hpp"

#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"

using json = nlohmann::json;

namespace pulsegrid {

/* ─────────────────────────────── talking to the studio ─────────────────────────────── */

// Every message, either way, is a frame: its kind, the length of its JSON, the length of its binary part, then the
// JSON and the binary bytes. Little-endian 32-bit lengths.
enum FrameKind : uint32_t {
  kRequest = 1,   // studio → host: { id, cmd, ... }
  kResponse = 2,  // host → studio: { id, ok, error?, ... } (+ audio for "render")
  kEvent = 3      // host → studio, unasked: { event, ... }
};

void writeFrame(FrameKind kind, const json& message, const void* binary = nullptr, size_t binaryBytes = 0);
void emitEvent(const json& event);
void logLine(const std::string& text);

std::string utf8(const std::wstring& text);
std::wstring wide(const std::string& text);
std::string base64Encode(const std::vector<char>& bytes);
std::vector<char> base64Decode(const std::string& text);

/* ─────────────────────────────── a loaded plugin ─────────────────────────────── */

struct Editor;

// One note, controller move or pitch bend for a plugin, at a frame of the block being rendered.
struct NoteEvent {
  int offset = 0;
  enum Kind { NoteOn, NoteOff, Control, Bend, AllOff } kind = NoteOn;
  int a = 0;        // pitch, or controller number
  double b = 0;     // velocity 0..1, controller value 0..1, or bend -1..1
};

// Asked of the plugin's edit controller: the studio forwards knob turns from the plugin's window to its sound engine,
// as VST3 hosts must, and is told the project changed.
class ComponentHandler : public Steinberg::Vst::IComponentHandler {
public:
  explicit ComponentHandler(struct Instance* owner) : owner(owner) {}
  Steinberg::tresult PLUGIN_API beginEdit(Steinberg::Vst::ParamID) override { return Steinberg::kResultOk; }
  Steinberg::tresult PLUGIN_API performEdit(Steinberg::Vst::ParamID id, Steinberg::Vst::ParamValue value) override;
  Steinberg::tresult PLUGIN_API endEdit(Steinberg::Vst::ParamID) override;
  Steinberg::tresult PLUGIN_API restartComponent(Steinberg::int32 flags) override;
  Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID iid, void** object) override;
  // Owned by its instance: a plugin releasing it must not delete it.
  Steinberg::uint32 PLUGIN_API addRef() override { return 1000; }
  Steinberg::uint32 PLUGIN_API release() override { return 1000; }

private:
  struct Instance* owner;
};

struct Instance {
  int id = 0;
  std::string path;
  std::string uid;
  std::string name;
  std::string vendor;

  VST3::Hosting::Module::Ptr module;
  Steinberg::IPtr<Steinberg::Vst::PlugProvider> provider;
  Steinberg::IPtr<Steinberg::Vst::IComponent> component;
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor;
  Steinberg::IPtr<Steinberg::Vst::IEditController> controller;
  Steinberg::IPtr<Steinberg::Vst::IMidiMapping> midiMapping;

  Steinberg::Vst::HostProcessData data;
  Steinberg::Vst::EventList events{1024};
  Steinberg::Vst::ParameterChanges changes{512};
  Steinberg::Vst::ProcessContext context{};
  int outputBus = -1;
  int maxBlock = 512;
  double sampleRate = 48000;
  bool processing = false;

  // Held while the audio is made, and while the plugin is changed from the window thread (state, unloading).
  std::mutex processLock;

  // Knob turns from the plugin's own window, waiting for the next block of audio.
  std::mutex pendingLock;
  std::vector<std::pair<Steinberg::Vst::ParamID, double>> pending;

  // The notes sounding, so "all notes off" can end each one.
  std::set<int> held;

  Steinberg::Vst::ParamID bendParam = Steinberg::Vst::kNoParamId;
  Steinberg::Vst::ParamID modParam = Steinberg::Vst::kNoParamId;
  Steinberg::Vst::ParamID sustainParam = Steinberg::Vst::kNoParamId;

  ComponentHandler handler{this};
  Editor* editor = nullptr;

  ~Instance();
};

using InstancePtr = std::shared_ptr<Instance>;

// Load a plugin (on the window thread). Throws std::runtime_error with a plain message on failure.
InstancePtr loadInstance(int id, const json& request, double sampleRate, int maxBlock);
void unloadInstance(Instance& instance);
json instanceState(Instance& instance);
void restoreState(Instance& instance, const json& state);

// Make `frames` of audio, stereo, into left and right. Never blocks: if the plugin is busy, it is silence.
void renderInstance(Instance& instance, std::vector<NoteEvent>& events, int frames, double tempo, bool playing,
                    double ppq, int64_t startFrame, float* left, float* right);

/* ─────────────────────────────── plugin windows ─────────────────────────────── */

void registerEditorClass(HINSTANCE module);
void showEditor(Instance& instance, const std::string& title);
void closeEditor(Instance& instance, bool tell);
bool editorOpen(const Instance& instance);
// Keep the plugin windows with the studio's window: above it while the studio is the program in use, behind other
// programs otherwise, and hidden while the studio is minimised. Called a few times a second.
void arrangeEditors(HWND studio);

}  // namespace pulsegrid
