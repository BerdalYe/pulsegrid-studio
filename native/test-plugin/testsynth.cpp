// "PulseGrid Test Synth": the smallest VST3 instrument that does everything the plugin host relies on, for testing
// the host without anyone's commercial plugins. A sine for each note, a Volume knob (parameter 0), and its settings
// saved and restored. Not part of the app.
#include <cmath>
#include <cstdio>
#include <cstring>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/vstspeaker.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

const FUID kClassId(0x50756C73, 0x65477269, 0x64546573, 0x7453796E);  // "PulseGridTestSyn"
const uint32 kMagic = 0x50475453;                                     // "PGTS"

void copyString(String128 target, const char* text) {
  int i = 0;
  for (; text[i] && i < 127; ++i) target[i] = static_cast<char16>(text[i]);
  target[i] = 0;
}

using TestSynthBase = U::Implements<U::Directly<IComponent, IAudioProcessor, IEditController>>;

class TestSynth : public TestSynthBase {
public:
  // Hosts also ask for the shared base interface, which Implements can't list (three of the interfaces derive it).
  tresult PLUGIN_API queryInterface(const TUID iid, void** object) override {
    if (FUnknownPrivate::iidEqual(iid, IPluginBase::iid)) {
      *object = static_cast<IPluginBase*>(static_cast<IComponent*>(this));
      addRef();
      return kResultOk;
    }
    return TestSynthBase::queryInterface(iid, object);
  }
  // IPluginBase
  tresult PLUGIN_API initialize(FUnknown*) override { return kResultOk; }
  tresult PLUGIN_API terminate() override { return kResultOk; }

  // IComponent
  tresult PLUGIN_API getControllerClassId(TUID) override { return kNotImplemented; }  // single component
  tresult PLUGIN_API setIoMode(IoMode) override { return kResultOk; }
  int32 PLUGIN_API getBusCount(MediaType type, BusDirection dir) override {
    if (type == kAudio && dir == kOutput) return 1;
    if (type == kEvent && dir == kInput) return 1;
    return 0;
  }
  tresult PLUGIN_API getBusInfo(MediaType type, BusDirection dir, int32 index, BusInfo& bus) override {
    if (index != 0 || getBusCount(type, dir) == 0) return kInvalidArgument;
    bus.mediaType = type;
    bus.direction = dir;
    bus.channelCount = type == kAudio ? 2 : 16;
    copyString(bus.name, type == kAudio ? "Out" : "MIDI");
    bus.busType = kMain;
    bus.flags = BusInfo::kDefaultActive;
    return kResultOk;
  }
  tresult PLUGIN_API getRoutingInfo(RoutingInfo&, RoutingInfo&) override { return kNotImplemented; }
  tresult PLUGIN_API activateBus(MediaType, BusDirection, int32, TBool) override { return kResultOk; }
  tresult PLUGIN_API setActive(TBool) override { return kResultOk; }
  tresult PLUGIN_API setState(IBStream* stream) override {
    uint32 magic = 0;
    float value = 0;
    int32 read = 0;
    if (!stream || stream->read(&magic, 4, &read) != kResultOk || magic != kMagic) return kResultFalse;
    if (stream->read(&value, 4, &read) != kResultOk) return kResultFalse;
    volume = value;
    return kResultOk;
  }
  tresult PLUGIN_API getState(IBStream* stream) override {
    float value = static_cast<float>(volume);
    stream->write(const_cast<uint32*>(&kMagic), 4, nullptr);
    stream->write(&value, 4, nullptr);
    return kResultOk;
  }

  // IAudioProcessor
  tresult PLUGIN_API setBusArrangements(SpeakerArrangement*, int32, SpeakerArrangement* outputs, int32 count) override {
    return count == 1 && outputs[0] == SpeakerArr::kStereo ? kResultTrue : kResultFalse;
  }
  tresult PLUGIN_API getBusArrangement(BusDirection dir, int32 index, SpeakerArrangement& arr) override {
    if (dir != kOutput || index != 0) return kInvalidArgument;
    arr = SpeakerArr::kStereo;
    return kResultOk;
  }
  tresult PLUGIN_API canProcessSampleSize(int32 size) override { return size == kSample32 ? kResultTrue : kResultFalse; }
  uint32 PLUGIN_API getLatencySamples() override { return 0; }
  tresult PLUGIN_API setupProcessing(ProcessSetup& setup) override {
    sampleRate = setup.sampleRate;
    return kResultOk;
  }
  tresult PLUGIN_API setProcessing(TBool) override { return kResultOk; }
  uint32 PLUGIN_API getTailSamples() override { return kNoTail; }

  tresult PLUGIN_API process(ProcessData& data) override {
    if (auto* changes = data.inputParameterChanges) {
      for (int32 i = 0; i < changes->getParameterCount(); ++i) {
        auto* queue = changes->getParameterData(i);
        if (!queue || queue->getParameterId() != 0 || queue->getPointCount() == 0) continue;
        int32 offset = 0;
        ParamValue value = 0;
        queue->getPoint(queue->getPointCount() - 1, offset, value);
        volume = value;
      }
    }
    if (data.numOutputs < 1 || data.outputs[0].numChannels < 2) return kResultOk;
    float* left = data.outputs[0].channelBuffers32[0];
    float* right = data.outputs[0].channelBuffers32[1];

    int32 eventIndex = 0;
    const int32 eventCount = data.inputEvents ? data.inputEvents->getEventCount() : 0;
    for (int32 s = 0; s < data.numSamples; ++s) {
      while (eventIndex < eventCount) {
        Event event{};
        data.inputEvents->getEvent(eventIndex, event);
        if (event.sampleOffset > s) break;
        if (event.type == Event::kNoteOnEvent) start(event.noteOn.pitch, event.noteOn.velocity);
        if (event.type == Event::kNoteOffEvent) stop(event.noteOff.pitch);
        ++eventIndex;
      }
      float sample = 0;
      for (auto& voice : voices) {
        if (voice.level <= 0 && !voice.on) continue;
        voice.level += voice.on ? (voice.peak - voice.level) * 0.01 : -voice.level * 0.0015;
        if (!voice.on && voice.level < 1e-4) {
          voice.level = 0;
          continue;
        }
        sample += static_cast<float>(std::sin(voice.phase) * voice.level);
        voice.phase += voice.step;
        if (voice.phase > 6.283185307179586) voice.phase -= 6.283185307179586;
      }
      left[s] = right[s] = sample * static_cast<float>(volume) * 0.3f;
    }
    data.outputs[0].silenceFlags = 0;
    return kResultOk;
  }

  // IEditController
  tresult PLUGIN_API setComponentState(IBStream* stream) override { return setState(stream); }
  int32 PLUGIN_API getParameterCount() override { return 1; }
  tresult PLUGIN_API getParameterInfo(int32 index, ParameterInfo& info) override {
    if (index != 0) return kInvalidArgument;
    info = {};
    info.id = 0;
    copyString(info.title, "Volume");
    copyString(info.shortTitle, "Vol");
    info.defaultNormalizedValue = 0.8;
    info.flags = ParameterInfo::kCanAutomate;
    return kResultOk;
  }
  tresult PLUGIN_API getParamStringByValue(ParamID, ParamValue value, String128 text) override {
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "%d%%", static_cast<int>(value * 100 + 0.5));
    copyString(text, buffer);
    return kResultOk;
  }
  tresult PLUGIN_API getParamValueByString(ParamID, TChar*, ParamValue&) override { return kNotImplemented; }
  ParamValue PLUGIN_API normalizedParamToPlain(ParamID, ParamValue value) override { return value; }
  ParamValue PLUGIN_API plainParamToNormalized(ParamID, ParamValue value) override { return value; }
  ParamValue PLUGIN_API getParamNormalized(ParamID id) override { return id == 0 ? volume : 0; }
  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue value) override {
    if (id != 0) return kInvalidArgument;
    volume = value;
    return kResultOk;
  }
  tresult PLUGIN_API setComponentHandler(IComponentHandler*) override { return kResultOk; }
  IPlugView* PLUGIN_API createView(FIDString) override { return nullptr; }

private:
  struct Voice {
    int pitch = -1;
    bool on = false;
    double phase = 0, step = 0, level = 0, peak = 0;
  };

  void start(int pitch, float velocity) {
    for (auto& voice : voices)
      if (!voice.on && voice.level <= 0) {
        voice = {pitch, true, 0, 6.283185307179586 * 440.0 * std::pow(2.0, (pitch - 69) / 12.0) / sampleRate, 0, velocity};
        return;
      }
  }
  void stop(int pitch) {
    for (auto& voice : voices)
      if (voice.on && voice.pitch == pitch) voice.on = false;
  }

  Voice voices[16];
  double sampleRate = 48000;
  double volume = 0.8;
};

class Factory : public U::Implements<U::Directly<IPluginFactory2>, U::Indirectly<IPluginFactory>> {
public:
  tresult PLUGIN_API getFactoryInfo(PFactoryInfo* info) override {
    *info = PFactoryInfo("PulseGrid", "https://pulsegridstudio.netlify.app", "", PFactoryInfo::kUnicode);
    return kResultOk;
  }
  int32 PLUGIN_API countClasses() override { return 1; }
  tresult PLUGIN_API getClassInfo(int32 index, PClassInfo* info) override {
    if (index != 0) return kInvalidArgument;
    *info = PClassInfo(kClassId.toTUID(), PClassInfo::kManyInstances, kVstAudioEffectClass, "PulseGrid Test Synth");
    return kResultOk;
  }
  tresult PLUGIN_API getClassInfo2(int32 index, PClassInfo2* info) override {
    if (index != 0) return kInvalidArgument;
    *info = PClassInfo2(kClassId.toTUID(), PClassInfo::kManyInstances, kVstAudioEffectClass, "PulseGrid Test Synth", 0,
                        "Instrument|Synth", "PulseGrid", "1.0.0", kVstVersionString);
    return kResultOk;
  }
  tresult PLUGIN_API createInstance(FIDString cid, FIDString iid, void** object) override {
    if (!FUnknownPrivate::iidEqual(cid, kClassId.toTUID())) return kInvalidArgument;
    auto* synth = new TestSynth();
    const tresult result = synth->queryInterface(iid, object);
    synth->release();
    return result;
  }
};

}  // namespace

extern "C" {
SMTG_EXPORT_SYMBOL IPluginFactory* PLUGIN_API GetPluginFactory() {
  static Factory* factory = new Factory();
  factory->addRef();
  return factory;
}
SMTG_EXPORT_SYMBOL bool InitDll() { return true; }
SMTG_EXPORT_SYMBOL bool ExitDll() { return true; }
}
