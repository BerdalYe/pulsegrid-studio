// PulseGrid's plugin host. The studio starts it and talks to it over standard input and output (see host.h for the
// framing). Two threads:
//  - the window thread (this program's main thread) loads plugins, opens their windows and saves their settings,
//    which is what VST3 expects of a host's "UI thread";
//  - the reader thread reads the studio's requests, makes audio for "render" straight away, and hands everything
//    else to the window thread.
//
//   pulsegrid-plugin-host.exe            serve the studio
//   pulsegrid-plugin-host.exe --scan F   print what plugins the file F holds, as JSON, and quit
#include "host.h"

#include <io.h>
#include <ole2.h>
#include <fcntl.h>
#include <shellapi.h>

#include <algorithm>
#include <cstdio>
#include <deque>
#include <map>
#include <shared_mutex>
#include <stdexcept>
#include <thread>

#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace pulsegrid {

/* ─────────────────────────────── text ─────────────────────────────── */

std::string utf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::wstring wide(const std::string& text) {
  if (text.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(size, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size);
  return out;
}

namespace {
const char* kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
}

std::string base64Encode(const std::vector<char>& bytes) {
  std::string out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < bytes.size(); i += 3) {
    const uint32_t n = (uint8_t(bytes[i]) << 16) | (uint8_t(bytes[i + 1]) << 8) | uint8_t(bytes[i + 2]);
    out += kAlphabet[(n >> 18) & 63];
    out += kAlphabet[(n >> 12) & 63];
    out += kAlphabet[(n >> 6) & 63];
    out += kAlphabet[n & 63];
  }
  if (i + 1 == bytes.size()) {
    const uint32_t n = uint8_t(bytes[i]) << 16;
    out += kAlphabet[(n >> 18) & 63];
    out += kAlphabet[(n >> 12) & 63];
    out += "==";
  } else if (i + 2 == bytes.size()) {
    const uint32_t n = (uint8_t(bytes[i]) << 16) | (uint8_t(bytes[i + 1]) << 8);
    out += kAlphabet[(n >> 18) & 63];
    out += kAlphabet[(n >> 12) & 63];
    out += kAlphabet[(n >> 6) & 63];
    out += '=';
  }
  return out;
}

std::vector<char> base64Decode(const std::string& text) {
  int table[256];
  std::fill(std::begin(table), std::end(table), -1);
  for (int i = 0; i < 64; ++i) table[static_cast<uint8_t>(kAlphabet[i])] = i;
  std::vector<char> out;
  out.reserve(text.size() / 4 * 3);
  uint32_t buffer = 0;
  int bits = 0;
  for (char c : text) {
    const int value = table[static_cast<uint8_t>(c)];
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<char>((buffer >> bits) & 0xFF));
    }
  }
  return out;
}

/* ─────────────────────────────── frames ─────────────────────────────── */

namespace {

HANDLE gIn = nullptr;
HANDLE gOut = nullptr;
std::mutex gWriteLock;

bool readExact(void* target, size_t bytes) {
  auto* at = static_cast<char*>(target);
  while (bytes > 0) {
    DWORD got = 0;
    const DWORD want = static_cast<DWORD>(std::min<size_t>(bytes, 1 << 20));
    if (!ReadFile(gIn, at, want, &got, nullptr) || got == 0) return false;
    at += got;
    bytes -= got;
  }
  return true;
}

bool writeExact(const void* source, size_t bytes) {
  auto* at = static_cast<const char*>(source);
  while (bytes > 0) {
    DWORD wrote = 0;
    const DWORD want = static_cast<DWORD>(std::min<size_t>(bytes, 1 << 20));
    if (!WriteFile(gOut, at, want, &wrote, nullptr) || wrote == 0) return false;
    at += wrote;
    bytes -= wrote;
  }
  return true;
}

}  // namespace

void writeFrame(FrameKind kind, const json& message, const void* binary, size_t binaryBytes) {
  const std::string text = message.dump(-1, ' ', false, json::error_handler_t::replace);
  const uint32_t header[3] = {static_cast<uint32_t>(kind), static_cast<uint32_t>(text.size()),
                              static_cast<uint32_t>(binaryBytes)};
  std::lock_guard<std::mutex> guard(gWriteLock);
  writeExact(header, sizeof(header));
  writeExact(text.data(), text.size());
  if (binaryBytes) writeExact(binary, binaryBytes);
}

void emitEvent(const json& event) { writeFrame(kEvent, event); }

void logLine(const std::string& text) { emitEvent({{"event", "log"}, {"message", text}}); }

/* ─────────────────────────────── the plugins ─────────────────────────────── */

namespace {

HostApplication gHostApplication;
HWND gStudioWindow = nullptr;
double gSampleRate = 48000;
int gMaxBlock = 512;

std::shared_mutex gInstancesLock;
std::map<int, InstancePtr> gInstances;

InstancePtr findInstance(int id) {
  std::shared_lock<std::shared_mutex> guard(gInstancesLock);
  auto found = gInstances.find(id);
  return found == gInstances.end() ? nullptr : found->second;
}

json describe(const Instance& instance) {
  return {{"instance", instance.id}, {"name", instance.name}, {"vendor", instance.vendor}, {"uid", instance.uid},
          {"hasEditor", static_cast<bool>(instance.controller)}};
}

NoteEvent toNote(const json& raw) {
  NoteEvent note;
  note.offset = raw.value("offset", 0);
  const std::string kind = raw.value("kind", "");
  if (kind == "on") note.kind = NoteEvent::NoteOn;
  else if (kind == "off") note.kind = NoteEvent::NoteOff;
  else if (kind == "cc") note.kind = NoteEvent::Control;
  else if (kind == "bend") note.kind = NoteEvent::Bend;
  else note.kind = NoteEvent::AllOff;
  note.a = raw.value("a", 0);
  note.b = raw.value("b", 0.0);
  return note;
}

// { frames, start, tempo, playing, ppq, instances: [id], events: [{ instance, offset, kind, a, b }] }
// → the left then right channel of each instance, in order, as 32-bit floats.
void render(const json& request) {
  const int frames = std::clamp(request.value("frames", 0), 0, 1 << 22);
  const int64_t start = request.value("start", static_cast<int64_t>(0));
  const double tempo = request.value("tempo", 120.0);
  const bool playing = request.value("playing", false);
  const double ppq = request.value("ppq", 0.0);

  std::map<int, std::vector<NoteEvent>> events;
  if (request.contains("events"))
    for (const auto& raw : request["events"]) events[raw.value("instance", -1)].push_back(toNote(raw));

  const auto ids = request.value("instances", std::vector<int>{});
  std::vector<float> audio(static_cast<size_t>(frames) * 2 * ids.size(), 0.f);
  for (size_t i = 0; i < ids.size(); ++i) {
    float* left = audio.data() + i * 2 * frames;
    float* right = left + frames;
    if (auto instance = findInstance(ids[i]))
      renderInstance(*instance, events[ids[i]], frames, tempo, playing, ppq, start, left, right);
  }
  writeFrame(kResponse, {{"id", request.value("id", 0)}, {"ok", true}, {"frames", frames}}, audio.data(),
             audio.size() * sizeof(float));
}

// Everything that isn't sound: on the window thread.
json handle(const json& request) {
  const std::string command = request.value("cmd", "");

  if (command == "hello") return {{"version", 1}};

  if (command == "setup") {
    gSampleRate = request.value("sampleRate", 48000.0);
    gMaxBlock = std::clamp(request.value("maxBlock", 512), 32, 4096);
    // The studio's window, as a number: plugin windows keep to it (see arrangeEditors).
    const std::string studio = request.value("studioWindow", "");
    if (!studio.empty()) gStudioWindow = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(studio)));
    return json::object();
  }

  if (command == "load") {
    const int id = request.value("instance", 0);
    auto instance = loadInstance(id, request, gSampleRate, gMaxBlock);
    InstancePtr previous;
    {
      std::unique_lock<std::shared_mutex> guard(gInstancesLock);
      previous = gInstances[id];
      gInstances[id] = instance;
    }
    if (previous) unloadInstance(*previous);
    return describe(*instance);
  }

  if (command == "unload") {
    InstancePtr instance;
    {
      std::unique_lock<std::shared_mutex> guard(gInstancesLock);
      auto found = gInstances.find(request.value("instance", 0));
      if (found != gInstances.end()) {
        instance = found->second;
        gInstances.erase(found);
      }
    }
    if (instance) unloadInstance(*instance);
    return json::object();
  }

  auto instance = findInstance(request.value("instance", 0));
  if (!instance) throw std::runtime_error("That plugin isn't loaded.");

  if (command == "showEditor") {
    showEditor(*instance, request.value("title", instance->name));
    return json::object();
  }
  if (command == "closeEditor") {
    closeEditor(*instance, false);
    return json::object();
  }
  if (command == "getState") return {{"state", instanceState(*instance)}, {"editorOpen", editorOpen(*instance)}};
  if (command == "parameters") {
    json list = json::array();
    if (instance->controller) {
      const int32 count = instance->controller->getParameterCount();
      for (int32 i = 0; i < count; ++i) {
        ParameterInfo info{};
        if (instance->controller->getParameterInfo(i, info) != kResultOk) continue;
        std::wstring title(reinterpret_cast<const wchar_t*>(info.title));
        String128 shown{};
        instance->controller->getParamStringByValue(info.id, instance->controller->getParamNormalized(info.id), shown);
        list.push_back({{"id", info.id},
                        {"title", utf8(title)},
                        {"steps", info.stepCount},
                        {"value", instance->controller->getParamNormalized(info.id)},
                        {"shown", utf8(std::wstring(reinterpret_cast<const wchar_t*>(shown)))},
                        {"program", (info.flags & ParameterInfo::kIsProgramChange) != 0}});
      }
    }
    return {{"parameters", list}};
  }
  if (command == "setParameter") {
    const ParamID id = request.value("param", 0u);
    const double value = request.value("value", 0.0);
    if (instance->controller) instance->controller->setParamNormalized(id, value);
    instance->handler.performEdit(id, value);
    return json::object();
  }
  if (command == "setState") {
    std::lock_guard<std::mutex> guard(instance->processLock);
    restoreState(*instance, request.value("state", json::object()));
    return json::object();
  }

  throw std::runtime_error("Unknown request: " + command);
}

/* ─────────────────────────────── the window thread's mailbox ─────────────────────────────── */

constexpr UINT kWakeUp = WM_APP + 1;
HWND gMailbox = nullptr;
std::mutex gQueueLock;
std::deque<json> gQueue;
std::atomic<bool> gQuitting{false};

void drainQueue() {
  for (;;) {
    json request;
    {
      std::lock_guard<std::mutex> guard(gQueueLock);
      if (gQueue.empty()) return;
      request = std::move(gQueue.front());
      gQueue.pop_front();
    }
    json reply;
    try {
      reply = handle(request);
      reply["ok"] = true;
    } catch (const std::exception& error) {
      reply = {{"ok", false}, {"error", error.what()}};
    } catch (...) {
      reply = {{"ok", false}, {"error", "The plugin stopped with an error."}};
    }
    reply["id"] = request.value("id", 0);
    writeFrame(kResponse, reply);
  }
}

LRESULT CALLBACK mailboxProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_TIMER) {
    arrangeEditors(gStudioWindow);
    return 0;
  }
  if (message == kWakeUp) {
    if (gQuitting) PostQuitMessage(0);
    else drainQueue();
    return 0;
  }
  return DefWindowProcW(hwnd, message, wParam, lParam);
}

void readerThread() {
  for (;;) {
    uint32_t header[3];
    if (!readExact(header, sizeof(header))) break;
    std::string text(header[1], '\0');
    if (header[1] && !readExact(text.data(), header[1])) break;
    std::vector<char> binary(header[2]);
    if (header[2] && !readExact(binary.data(), header[2])) break;

    json request = json::parse(text, nullptr, false);
    if (request.is_discarded()) continue;

    if (request.value("cmd", "") == "render") {
      render(request);
      continue;
    }
    {
      std::lock_guard<std::mutex> guard(gQueueLock);
      gQueue.push_back(std::move(request));
    }
    PostMessageW(gMailbox, kWakeUp, 0, 0);
  }
  // The studio has gone: close down.
  gQuitting = true;
  PostMessageW(gMailbox, kWakeUp, 0, 0);
}

/* ─────────────────────────────── scanning ─────────────────────────────── */

int scan(const std::string& path) {
  json result = {{"path", path}, {"plugins", json::array()}};
  std::string error;
  auto module = VST3::Hosting::Module::create(path, error);
  if (!module) {
    result["error"] = error.empty() ? "Couldn't open the file." : error;
  } else {
    for (const auto& info : module->getFactory().classInfos()) {
      if (info.category() != kVstAudioEffectClass) continue;
      const std::string sub = info.subCategoriesString();
      result["plugins"].push_back({{"uid", info.ID().toString()},
                                   {"name", info.name()},
                                   {"vendor", info.vendor()},
                                   {"version", info.version()},
                                   {"subCategories", sub},
                                   {"instrument", sub.find("Instrument") != std::string::npos}});
    }
  }
  const std::string text = result.dump(-1, ' ', false, json::error_handler_t::replace);
  DWORD wrote = 0;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), static_cast<DWORD>(text.size()), &wrote, nullptr);
  return 0;
}

}  // namespace
}  // namespace pulsegrid

int wmain(int argc, wchar_t** argv) {
  using namespace pulsegrid;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  OleInitialize(nullptr);
  PluginContextFactory::instance().setPluginContext(&gHostApplication);

  if (argc >= 3 && std::wstring(argv[1]) == L"--scan") {
    const int code = scan(utf8(argv[2]));
    OleUninitialize();
    return code;
  }

  gIn = GetStdHandle(STD_INPUT_HANDLE);
  gOut = GetStdHandle(STD_OUTPUT_HANDLE);

  HINSTANCE module = GetModuleHandleW(nullptr);
  registerEditorClass(module);

  WNDCLASSEXW mailbox{};
  mailbox.cbSize = sizeof(mailbox);
  mailbox.lpfnWndProc = mailboxProc;
  mailbox.hInstance = module;
  mailbox.lpszClassName = L"PulseGridPluginHostMailbox";
  RegisterClassExW(&mailbox);
  gMailbox = CreateWindowExW(0, mailbox.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, module, nullptr);

  // The studio starts this program hidden, and Windows applies that to the first window it shows, which would be a
  // plugin's. A throwaway window takes that first "show" instead.
  if (HWND spare = CreateWindowExW(0, mailbox.lpszClassName, L"", WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr, module, nullptr)) {
    ShowWindow(spare, SW_HIDE);
    DestroyWindow(spare);
  }

  SetTimer(gMailbox, 1, 200, nullptr);
  std::thread reader(readerThread);
  reader.detach();
  emitEvent({{"event", "ready"}});

  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  {
    std::unique_lock<std::shared_mutex> guard(gInstancesLock);
    for (auto& [id, instance] : gInstances) unloadInstance(*instance);
    gInstances.clear();
  }
  PluginContextFactory::instance().setPluginContext(nullptr);
  OleUninitialize();
  return 0;
}
