// A plugin's own window: a plain Windows window that the plugin draws its editor into.
#include "host.h"

#include <stdexcept>

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"

using namespace Steinberg;

namespace pulsegrid {

namespace {
const wchar_t* kWindowClass = L"PulseGridPluginWindow";
HINSTANCE gModule = nullptr;
std::set<struct Editor*> gEditors;
}  // namespace

// The plugin asks its frame to resize when its editor changes size; the frame is the window around it.
struct Editor : public IPlugFrame {
  Instance* instance = nullptr;
  IPtr<IPlugView> view;
  HWND window = nullptr;
  DWORD style = 0;
  bool resizing = false;
  bool onTop = false;
  bool hiddenWithStudio = false;

  tresult PLUGIN_API resizeView(IPlugView* from, ViewRect* size) override {
    if (!size || from != view || !window) return kInvalidArgument;
    if (resizing) return kResultFalse;
    resizing = true;
    RECT outer{0, 0, size->getWidth(), size->getHeight()};
    AdjustWindowRectExForDpi(&outer, style, FALSE, 0, GetDpiForWindow(window));
    SetWindowPos(window, nullptr, 0, 0, outer.right - outer.left, outer.bottom - outer.top,
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    view->onSize(size);
    resizing = false;
    return kResultTrue;
  }

  tresult PLUGIN_API queryInterface(const TUID iid, void** object) override {
    if (FUnknownPrivate::iidEqual(iid, IPlugFrame::iid) || FUnknownPrivate::iidEqual(iid, FUnknown::iid)) {
      *object = static_cast<IPlugFrame*>(this);
      return kResultOk;
    }
    *object = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1000; }
  uint32 PLUGIN_API release() override { return 1000; }

  void setScale() {
    if (auto scale = U::cast<IPlugViewContentScaleSupport>(view))
      scale->setContentScaleFactor(static_cast<float>(GetDpiForWindow(window)) / 96.f);
  }
};

namespace {

LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  auto* editor = reinterpret_cast<Editor*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
  switch (message) {
    case WM_NCCREATE: {
      auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
      break;
    }
    case WM_SIZE:
      if (editor && editor->view && !editor->resizing && wParam != SIZE_MINIMIZED) {
        ViewRect rect{0, 0, LOWORD(lParam), HIWORD(lParam)};
        ViewRect current{};
        if (editor->view->getSize(&current) != kResultTrue || current.getWidth() != rect.getWidth() ||
            current.getHeight() != rect.getHeight()) {
          editor->view->checkSizeConstraint(&rect);
          editor->view->onSize(&rect);
        }
      }
      return 0;
    case WM_DPICHANGED:
      if (editor) {
        editor->setScale();
        auto* suggested = reinterpret_cast<RECT*>(lParam);
        SetWindowPos(hwnd, nullptr, suggested->left, suggested->top, suggested->right - suggested->left,
                     suggested->bottom - suggested->top, SWP_NOZORDER | SWP_NOACTIVATE);
      }
      return 0;
    case WM_CLOSE:
      if (editor && editor->instance) closeEditor(*editor->instance, true);
      return 0;
    case WM_ERASEBKGND:
      return 1;
    default:
      break;
  }
  return DefWindowProcW(hwnd, message, wParam, lParam);
}

}  // namespace

void registerEditorClass(HINSTANCE module) {
  gModule = module;
  WNDCLASSEXW cls{};
  cls.cbSize = sizeof(cls);
  cls.lpfnWndProc = windowProc;
  cls.hInstance = module;
  cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  cls.hIcon = LoadIconW(module, MAKEINTRESOURCEW(1));
  cls.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  cls.lpszClassName = kWindowClass;
  RegisterClassExW(&cls);
}

bool editorOpen(const Instance& instance) { return instance.editor != nullptr; }

void showEditor(Instance& instance, const std::string& title) {
  if (instance.editor) {
    // Already open: bring it back to the front, and out of the taskbar if it was minimised.
    HWND window = instance.editor->window;
    if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
    SetWindowTextW(window, wide(title).c_str());
    SetForegroundWindow(window);
    return;
  }
  if (!instance.controller) throw std::runtime_error("This plugin has no window of its own.");

  auto view = owned(instance.controller->createView(Vst::ViewType::kEditor));
  if (!view) throw std::runtime_error("This plugin has no window of its own.");
  if (view->isPlatformTypeSupported(kPlatformTypeHWND) != kResultTrue)
    throw std::runtime_error("This plugin's window can't open on Windows.");

  ViewRect size{};
  if (view->getSize(&size) != kResultTrue || size.getWidth() <= 0 || size.getHeight() <= 0) size = ViewRect{0, 0, 640, 400};

  auto editor = std::make_unique<Editor>();
  editor->instance = &instance;
  editor->view = view;
  const bool resizable = view->canResize() == kResultTrue;
  editor->style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | (resizable ? WS_THICKFRAME | WS_MAXIMIZEBOX : 0);

  RECT outer{0, 0, size.getWidth(), size.getHeight()};
  AdjustWindowRectExForDpi(&outer, editor->style, FALSE, 0, GetDpiForSystem());
  HWND window = CreateWindowExW(0, kWindowClass, wide(title).c_str(), editor->style, CW_USEDEFAULT, CW_USEDEFAULT,
                                outer.right - outer.left, outer.bottom - outer.top, nullptr, nullptr, gModule,
                                editor.get());
  if (!window) throw std::runtime_error("The plugin's window couldn't be made.");
  editor->window = window;

  view->setFrame(editor.get());
  editor->setScale();
  if (view->attached(window, kPlatformTypeHWND) != kResultTrue) {
    view->setFrame(nullptr);
    DestroyWindow(window);
    throw std::runtime_error("The plugin's window failed to open.");
  }

  instance.editor = editor.release();
  gEditors.insert(instance.editor);
  ShowWindow(window, SW_SHOWNORMAL);
  SetForegroundWindow(window);
}

void closeEditor(Instance& instance, bool tell) {
  Editor* editor = instance.editor;
  if (!editor) return;
  instance.editor = nullptr;
  gEditors.erase(editor);
  if (editor->view) {
    editor->view->setFrame(nullptr);
    editor->view->removed();
    editor->view = nullptr;
  }
  SetWindowLongPtrW(editor->window, GWLP_USERDATA, 0);
  DestroyWindow(editor->window);
  delete editor;
  if (tell) emitEvent({{"event", "editorClosed"}, {"instance", instance.id}});
}

void arrangeEditors(HWND studio) {
  if (!studio || !IsWindow(studio) || gEditors.empty()) return;
  const bool minimised = IsIconic(studio) != FALSE;

  DWORD studioProcess = 0;
  GetWindowThreadProcessId(studio, &studioProcess);
  DWORD activeProcess = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &activeProcess);
  // The studio or one of its plugin windows is the program in use.
  const bool inUse = activeProcess == studioProcess || activeProcess == GetCurrentProcessId();

  for (Editor* editor : gEditors) {
    if (minimised && !editor->hiddenWithStudio && IsWindowVisible(editor->window)) {
      ShowWindow(editor->window, SW_HIDE);
      editor->hiddenWithStudio = true;
    } else if (!minimised && editor->hiddenWithStudio) {
      ShowWindow(editor->window, SW_SHOWNOACTIVATE);
      editor->hiddenWithStudio = false;
    }
    const bool wantOnTop = inUse && !minimised;
    if (wantOnTop != editor->onTop) {
      SetWindowPos(editor->window, wantOnTop ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                   SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      // Out of "always on top", it goes behind whatever program is in use now.
      if (!wantOnTop) SetWindowPos(editor->window, GetForegroundWindow(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      editor->onTop = wantOnTop;
    }
  }
}

}  // namespace pulsegrid
