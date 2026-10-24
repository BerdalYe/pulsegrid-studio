// Loading a VST3 instrument, making its sound a block at a time, and saving and restoring its settings.
#include "host.h"

#include <algorithm>
#include <cstring>
#include <stdexcept>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/common/memorystream.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace pulsegrid {

/* ─────────────────────────────── the plugin's window talking back ─────────────────────────────── */

tresult PLUGIN_API ComponentHandler::performEdit(ParamID id, ParamValue value) {
  std::lock_guard<std::mutex> guard(owner->pendingLock);
  owner->pending.emplace_back(id, value);
  return kResultOk;
}

tresult PLUGIN_API ComponentHandler::endEdit(ParamID) {
  // A knob let go of: the project has changed, and the studio fetches the new settings.
  emitEvent({{"event", "edited"}, {"instance", owner->id}});
  return kResultOk;
}

tresult PLUGIN_API ComponentHandler::restartComponent(int32 flags) {
  if (flags & (kParamValuesChanged | kReloadComponent)) emitEvent({{"event", "edited"}, {"instance", owner->id}});
  return kResultOk;
}

tresult PLUGIN_API ComponentHandler::queryInterface(const TUID iid, void** object) {
  if (FUnknownPrivate::iidEqual(iid, IComponentHandler::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
    *object = static_cast<IComponentHandler*>(this);
    return kResultOk;
  }
  *object = nullptr;
  return kNoInterface;
}

/* ─────────────────────────────── loading ─────────────────────────────── */

namespace {

void setUpBuses(Instance& instance) {
  auto& component = *instance.component;

  // The main stereo output is the one the studio plays; extra outputs and side-chain inputs are switched off.
  const int32 outputs = component.getBusCount(kAudio, kOutput);
  for (int32 index = 0; index < outputs; ++index) {
    BusInfo info{};
    if (component.getBusInfo(kAudio, kOutput, index, info) != kResultOk) continue;
    if (instance.outputBus < 0 && info.busType == kMain && info.channelCount > 0) instance.outputBus = index;
  }
  if (instance.outputBus < 0 && outputs > 0) instance.outputBus = 0;
  if (instance.outputBus < 0) throw std::runtime_error("This plugin makes no sound of its own (it has no audio output).");

  // Ask for stereo on the main output, keeping whatever the plugin has elsewhere.
  if (instance.processor) {
    const int32 inputs = component.getBusCount(kAudio, kInput);
    std::vector<SpeakerArrangement> in(inputs), out(outputs);
    for (int32 i = 0; i < inputs; ++i) instance.processor->getBusArrangement(kInput, i, in[i]);
    for (int32 i = 0; i < outputs; ++i) instance.processor->getBusArrangement(kOutput, i, out[i]);
    out[instance.outputBus] = SpeakerArr::kStereo;
    instance.processor->setBusArrangements(inputs ? in.data() : nullptr, inputs, out.data(), outputs);

    for (int32 i = 0; i < inputs; ++i) component.activateBus(kAudio, kInput, i, false);
    for (int32 i = 0; i < outputs; ++i) component.activateBus(kAudio, kOutput, i, i == instance.outputBus);
  }

  const int32 eventInputs = component.getBusCount(kEvent, kInput);
  for (int32 i = 0; i < eventInputs; ++i) component.activateBus(kEvent, kInput, i, i == 0);
}

void findMidiControls(Instance& instance) {
  if (!instance.midiMapping) return;
  auto lookup = [&](CtrlNumber control) {
    ParamID id = kNoParamId;
    if (instance.midiMapping->getMidiControllerAssignment(0, 0, control, id) == kResultTrue) return id;
    return static_cast<ParamID>(kNoParamId);
  };
  instance.bendParam = lookup(kPitchBend);
  instance.modParam = lookup(kCtrlModWheel);
  instance.sustainParam = lookup(kCtrlSustainOnOff);
}

void startProcessing(Instance& instance) {
  ProcessSetup setup{kRealtime, kSample32, instance.maxBlock, instance.sampleRate};
  if (instance.processor->setupProcessing(setup) != kResultOk)
    throw std::runtime_error("The plugin can't play at this sample rate.");

  instance.data.prepare(*instance.component, instance.maxBlock, kSample32);
  instance.data.inputEvents = &instance.events;
  instance.data.inputParameterChanges = &instance.changes;
  instance.data.processContext = &instance.context;

  if (instance.component->setActive(true) != kResultOk) throw std::runtime_error("The plugin wouldn't start.");
  instance.processor->setProcessing(true);
  instance.processing = true;
}

}  // namespace

InstancePtr loadInstance(int id, const json& request, double sampleRate, int maxBlock) {
  auto instance = std::make_shared<Instance>();
  instance->id = id;
  instance->path = request.value("path", "");
  instance->uid = request.value("uid", "");
  instance->sampleRate = sampleRate;
  instance->maxBlock = maxBlock;

  std::string error;
  instance->module = VST3::Hosting::Module::create(instance->path, error);
  if (!instance->module) throw std::runtime_error("Couldn't open the plugin file. " + error);

  const auto& factory = instance->module->getFactory();
  for (const auto& info : factory.classInfos()) {
    if (info.category() != kVstAudioEffectClass) continue;
    if (!instance->uid.empty() && info.ID().toString() != instance->uid) continue;
    instance->provider = owned(new PlugProvider(factory, info, true));
    instance->name = info.name();
    instance->vendor = info.vendor();
    instance->uid = info.ID().toString();
    break;
  }
  if (!instance->provider) throw std::runtime_error("That plugin isn't in the file any more.");
  if (!instance->provider->initialize()) throw std::runtime_error("The plugin failed to start.");

  instance->component = instance->provider->getComponentPtr();
  instance->controller = instance->provider->getControllerPtr();
  instance->processor = U::cast<IAudioProcessor>(instance->component);
  if (!instance->component || !instance->processor) throw std::runtime_error("This plugin can't make sound in a host.");

  if (instance->controller) {
    instance->controller->setComponentHandler(&instance->handler);
    instance->midiMapping = U::cast<IMidiMapping>(instance->controller);
  }

  setUpBuses(*instance);
  if (request.contains("state") && request["state"].is_object()) restoreState(*instance, request["state"]);
  findMidiControls(*instance);
  startProcessing(*instance);
  return instance;
}

void unloadInstance(Instance& instance) {
  closeEditor(instance, false);
  std::lock_guard<std::mutex> guard(instance.processLock);
  if (instance.processing) {
    instance.processor->setProcessing(false);
    instance.component->setActive(false);
    instance.processing = false;
  }
  instance.data.unprepare();
  if (instance.controller) instance.controller->setComponentHandler(nullptr);
  instance.midiMapping = nullptr;
  instance.processor = nullptr;
  instance.controller = nullptr;
  instance.component = nullptr;
  instance.provider = nullptr;
}

Instance::~Instance() {
  if (provider) unloadInstance(*this);
}

/* ─────────────────────────────── settings ─────────────────────────────── */

namespace {

std::vector<char> streamBytes(MemoryStream& stream) {
  int64 size = 0;
  stream.tell(&size);
  const char* data = stream.getData();
  return std::vector<char>(data, data + size);
}

}  // namespace

json instanceState(Instance& instance) {
  // VST3 lets a host read the settings while the plugin plays, so this doesn't stop the sound.
  json state = json::object();

  auto component = owned(new MemoryStream());
  if (instance.component->getState(component) == kResultOk) state["component"] = base64Encode(streamBytes(*component));

  if (instance.controller) {
    auto controller = owned(new MemoryStream());
    if (instance.controller->getState(controller) == kResultOk)
      state["controller"] = base64Encode(streamBytes(*controller));
  }
  return state;
}

void restoreState(Instance& instance, const json& state) {
  if (state.contains("component") && state["component"].is_string()) {
    auto bytes = base64Decode(state["component"].get<std::string>());
    if (!bytes.empty()) {
      auto stream = owned(new MemoryStream(bytes.data(), static_cast<TSize>(bytes.size())));
      instance.component->setState(stream);
      if (instance.controller) {
        stream->seek(0, IBStream::kIBSeekSet, nullptr);
        instance.controller->setComponentState(stream);
      }
    }
  }
  if (instance.controller && state.contains("controller") && state["controller"].is_string()) {
    auto bytes = base64Decode(state["controller"].get<std::string>());
    if (!bytes.empty()) {
      auto stream = owned(new MemoryStream(bytes.data(), static_cast<TSize>(bytes.size())));
      instance.controller->setState(stream);
    }
  }
}

/* ─────────────────────────────── sound ─────────────────────────────── */

namespace {

void addParameter(Instance& instance, ParamID id, double value, int32 offset) {
  if (id == kNoParamId) return;
  int32 index = 0;
  if (auto* queue = instance.changes.addParameterData(id, index)) {
    int32 point = 0;
    queue->addPoint(offset, value, point);
  }
}

void addNote(Instance& instance, bool on, int pitch, double velocity, int32 offset) {
  Event event{};
  event.busIndex = 0;
  event.sampleOffset = offset;
  event.flags = Event::kIsLive;
  if (on) {
    event.type = Event::kNoteOnEvent;
    event.noteOn.channel = 0;
    event.noteOn.pitch = static_cast<int16>(pitch);
    event.noteOn.velocity = static_cast<float>(std::clamp(velocity, 0.0, 1.0));
    event.noteOn.noteId = -1;
    instance.held.insert(pitch);
  } else {
    event.type = Event::kNoteOffEvent;
    event.noteOff.channel = 0;
    event.noteOff.pitch = static_cast<int16>(pitch);
    event.noteOff.velocity = 0.f;
    event.noteOff.noteId = -1;
    instance.held.erase(pitch);
  }
  instance.events.addEvent(event);
}

void applyEvent(Instance& instance, const NoteEvent& note, int32 offset) {
  switch (note.kind) {
    case NoteEvent::NoteOn:
      addNote(instance, true, note.a, note.b, offset);
      break;
    case NoteEvent::NoteOff:
      addNote(instance, false, note.a, 0, offset);
      break;
    case NoteEvent::Bend:
      // -1..1 around the middle, as a normalised parameter.
      addParameter(instance, instance.bendParam, std::clamp((note.b + 1.0) / 2.0, 0.0, 1.0), offset);
      break;
    case NoteEvent::Control: {
      ParamID id = kNoParamId;
      if (note.a == kCtrlModWheel) id = instance.modParam;
      else if (note.a == kCtrlSustainOnOff) id = instance.sustainParam;
      else if (instance.midiMapping) instance.midiMapping->getMidiControllerAssignment(0, 0, static_cast<CtrlNumber>(note.a), id);
      addParameter(instance, id, std::clamp(note.b, 0.0, 1.0), offset);
      break;
    }
    case NoteEvent::AllOff: {
      const std::set<int> sounding = instance.held;
      for (int pitch : sounding) addNote(instance, false, pitch, 0, offset);
      addParameter(instance, instance.sustainParam, 0.0, offset);
      break;
    }
  }
}

}  // namespace

void renderInstance(Instance& instance, std::vector<NoteEvent>& events, int frames, double tempo, bool playing,
                    double ppq, int64_t startFrame, float* left, float* right) {
  std::fill(left, left + frames, 0.f);
  std::fill(right, right + frames, 0.f);

  std::unique_lock<std::mutex> guard(instance.processLock, std::try_to_lock);
  if (!guard.owns_lock() || !instance.processing) return;

  std::stable_sort(events.begin(), events.end(), [](const NoteEvent& x, const NoteEvent& y) { return x.offset < y.offset; });
  size_t nextEvent = 0;

  for (int done = 0; done < frames;) {
    const int block = std::min(instance.maxBlock, frames - done);
    instance.events.clear();
    instance.changes.clearQueue();

    if (done == 0) {
      std::vector<std::pair<ParamID, double>> knobs;
      {
        std::lock_guard<std::mutex> pendingGuard(instance.pendingLock);
        knobs.swap(instance.pending);
      }
      for (const auto& [id, value] : knobs) addParameter(instance, id, value, 0);
    }

    while (nextEvent < events.size() && events[nextEvent].offset < done + block) {
      applyEvent(instance, events[nextEvent], std::max(0, events[nextEvent].offset - done));
      ++nextEvent;
    }

    auto& context = instance.context;
    context = {};
    context.sampleRate = instance.sampleRate;
    context.tempo = tempo;
    context.timeSigNumerator = 4;
    context.timeSigDenominator = 4;
    context.projectTimeSamples = startFrame + done;
    context.continousTimeSamples = startFrame + done;
    context.projectTimeMusic = ppq + (done / instance.sampleRate) * tempo / 60.0;
    context.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid |
                    ProcessContext::kContTimeValid | (playing ? ProcessContext::kPlaying : 0);

    instance.data.numSamples = block;
    instance.eventsSent += instance.events.getEventCount();
    const tresult result = instance.processor->process(instance.data);
    instance.lastResult = result;
    instance.lastSilence = instance.data.outputs[instance.outputBus].silenceFlags;
    const bool made = result == kResultOk;

    const auto& bus = instance.data.outputs[instance.outputBus];
    if (made && bus.numChannels >= 1 && bus.channelBuffers32) {
      const float* l = bus.channelBuffers32[0];
      const float* r = bus.numChannels >= 2 ? bus.channelBuffers32[1] : l;
      if (l) std::memcpy(left + done, l, sizeof(float) * block);
      if (r) std::memcpy(right + done, r, sizeof(float) * block);
    }
    done += block;
  }
}

}  // namespace pulsegrid
