#include <napi.h>

#include <aclapi.h>
#include <sddl.h>
#include <windows.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace {

constexpr std::uint32_t kHeaderBytes = 4;
constexpr std::array<const wchar_t*, 4> kNativeHostRegistryKeys = {
    L"Software\\Google\\Chrome\\NativeMessagingHosts\\com.qwts.overlook.interop",
    L"Software\\Chromium\\NativeMessagingHosts\\com.qwts.overlook.interop",
    L"Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\com.qwts.overlook.interop",
    L"Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.qwts.overlook.interop",
};

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return {};
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), length) <= 0) {
    return {};
  }
  return result;
}

std::string WideToUtf8(const wchar_t* value) {
  if (value == nullptr || *value == L'\0') return {};
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (length <= 1) return {};
  std::string result(static_cast<std::size_t>(length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result.data(), length, nullptr, nullptr) <= 0) {
    return {};
  }
  result.resize(static_cast<std::size_t>(length - 1));
  return result;
}

Napi::Value ThrowError(Napi::Env env, const std::string& message, const char* code) {
  Napi::Error error = Napi::Error::New(env, message);
  error.Value().Set("code", Napi::String::New(env, code));
  error.ThrowAsJavaScriptException();
  return env.Null();
}

Napi::Value ThrowWindowsError(Napi::Env env, const std::string& operation, DWORD error_code) {
  return ThrowError(env, operation + " failed with Windows error " + std::to_string(error_code), "native-error");
}

enum class IoResult { kComplete, kTimeout, kError };

template <typename Operation>
IoResult RunOverlapped(HANDLE pipe, DWORD timeout_ms, DWORD* transferred, DWORD* error_code, Operation operation) {
  OVERLAPPED overlapped{};
  overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (overlapped.hEvent == nullptr) {
    *error_code = GetLastError();
    return IoResult::kError;
  }
  const BOOL immediate = operation(&overlapped);
  if (immediate == FALSE && GetLastError() != ERROR_IO_PENDING) {
    *error_code = GetLastError();
    CloseHandle(overlapped.hEvent);
    return IoResult::kError;
  }
  if (immediate == FALSE) {
    const DWORD wait = WaitForSingleObject(overlapped.hEvent, timeout_ms);
    if (wait == WAIT_TIMEOUT) {
      CancelIoEx(pipe, &overlapped);
      WaitForSingleObject(overlapped.hEvent, INFINITE);
      CloseHandle(overlapped.hEvent);
      return IoResult::kTimeout;
    }
    if (wait != WAIT_OBJECT_0) {
      *error_code = GetLastError();
      CancelIoEx(pipe, &overlapped);
      WaitForSingleObject(overlapped.hEvent, INFINITE);
      CloseHandle(overlapped.hEvent);
      return IoResult::kError;
    }
  }
  DWORD bytes = 0;
  if (GetOverlappedResult(pipe, &overlapped, &bytes, FALSE) == FALSE) {
    *error_code = GetLastError();
    CloseHandle(overlapped.hEvent);
    return IoResult::kError;
  }
  CloseHandle(overlapped.hEvent);
  *transferred = bytes;
  return IoResult::kComplete;
}

class PipeServer final : public Napi::ObjectWrap<PipeServer> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
        env,
        "PipeServer",
        {
            InstanceMethod("read", &PipeServer::Read),
            InstanceMethod("write", &PipeServer::Write),
            InstanceMethod("disconnect", &PipeServer::DisconnectMethod),
            InstanceMethod("securityDescriptor", &PipeServer::SecurityDescriptor),
            InstanceMethod("close", &PipeServer::CloseMethod),
        });
  }

  explicit PipeServer(const Napi::CallbackInfo& info) : Napi::ObjectWrap<PipeServer>(info) {
    Napi::Env env = info.Env();
    if (info.Length() != 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsNumber()) {
      Napi::TypeError::New(env, "PipeServer requires endpoint, SDDL, and maximum frame bytes").ThrowAsJavaScriptException();
      return;
    }
    const std::wstring endpoint = Utf8ToWide(info[0].As<Napi::String>().Utf8Value());
    const std::wstring sddl = Utf8ToWide(info[1].As<Napi::String>().Utf8Value());
    max_frame_bytes_ = info[2].As<Napi::Number>().Uint32Value();
    if (endpoint.rfind(L"\\\\.\\pipe\\", 0) != 0 || endpoint.size() > 256 || sddl.empty() || max_frame_bytes_ == 0 ||
        max_frame_bytes_ > 1024 * 1024) {
      Napi::TypeError::New(env, "PipeServer arguments are outside their security bounds").ThrowAsJavaScriptException();
      return;
    }
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) == FALSE) {
      ThrowWindowsError(env, "ConvertStringSecurityDescriptorToSecurityDescriptorW", GetLastError());
      return;
    }
    SECURITY_ATTRIBUTES attributes{};
    attributes.nLength = sizeof(attributes);
    attributes.lpSecurityDescriptor = descriptor;
    pipe_ = CreateNamedPipeW(
        endpoint.c_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,
        max_frame_bytes_ + kHeaderBytes,
        max_frame_bytes_ + kHeaderBytes,
        0,
        &attributes);
    const DWORD create_error = pipe_ == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    LocalFree(descriptor);
    if (pipe_ == INVALID_HANDLE_VALUE) {
      ThrowWindowsError(env, "CreateNamedPipeW", create_error);
    }
  }

  ~PipeServer() override { Close(); }

 private:
  bool Connect(DWORD timeout_ms, DWORD* error_code) {
    if (connected_) return true;
    OVERLAPPED overlapped{};
    overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (overlapped.hEvent == nullptr) {
      *error_code = GetLastError();
      return false;
    }
    if (ConnectNamedPipe(pipe_, &overlapped) != FALSE) {
      CloseHandle(overlapped.hEvent);
      connected_ = true;
      return true;
    }
    const DWORD connect_error = GetLastError();
    if (connect_error == ERROR_PIPE_CONNECTED) {
      CloseHandle(overlapped.hEvent);
      connected_ = true;
      return true;
    }
    if (connect_error != ERROR_IO_PENDING) {
      *error_code = connect_error;
      CloseHandle(overlapped.hEvent);
      return false;
    }
    const DWORD wait = WaitForSingleObject(overlapped.hEvent, timeout_ms);
    if (wait == WAIT_TIMEOUT) {
      CancelIoEx(pipe_, &overlapped);
      WaitForSingleObject(overlapped.hEvent, INFINITE);
      CloseHandle(overlapped.hEvent);
      DisconnectNamedPipe(pipe_);
      return false;
    }
    if (wait != WAIT_OBJECT_0) {
      *error_code = GetLastError();
      CancelIoEx(pipe_, &overlapped);
      WaitForSingleObject(overlapped.hEvent, INFINITE);
      CloseHandle(overlapped.hEvent);
      return false;
    }
    DWORD transferred = 0;
    if (GetOverlappedResult(pipe_, &overlapped, &transferred, FALSE) == FALSE) {
      *error_code = GetLastError();
      CloseHandle(overlapped.hEvent);
      return false;
    }
    CloseHandle(overlapped.hEvent);
    connected_ = true;
    return true;
  }

  IoResult ReadExact(std::uint8_t* target, DWORD length, DWORD timeout_ms, DWORD* error_code) {
    DWORD offset = 0;
    while (offset < length) {
      DWORD transferred = 0;
      const IoResult result = RunOverlapped(pipe_, timeout_ms, &transferred, error_code, [&](OVERLAPPED* overlapped) {
        return ReadFile(pipe_, target + offset, length - offset, nullptr, overlapped);
      });
      if (result != IoResult::kComplete) return result;
      if (transferred == 0) {
        *error_code = ERROR_BROKEN_PIPE;
        return IoResult::kError;
      }
      offset += transferred;
    }
    return IoResult::kComplete;
  }

  IoResult WriteExact(const std::uint8_t* source, DWORD length, DWORD timeout_ms, DWORD* error_code) {
    DWORD offset = 0;
    while (offset < length) {
      DWORD transferred = 0;
      const IoResult result = RunOverlapped(pipe_, timeout_ms, &transferred, error_code, [&](OVERLAPPED* overlapped) {
        return WriteFile(pipe_, source + offset, length - offset, nullptr, overlapped);
      });
      if (result != IoResult::kComplete) return result;
      if (transferred == 0) {
        *error_code = ERROR_BROKEN_PIPE;
        return IoResult::kError;
      }
      offset += transferred;
    }
    return IoResult::kComplete;
  }

  Napi::Value Read(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (pipe_ == INVALID_HANDLE_VALUE || info.Length() != 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
      return ThrowError(env, "invalid pipe read", "native-error");
    }
    const DWORD connect_timeout = info[0].As<Napi::Number>().Uint32Value();
    const DWORD io_timeout = info[1].As<Napi::Number>().Uint32Value();
    DWORD error_code = ERROR_SUCCESS;
    if (!Connect(connect_timeout, &error_code)) {
      if (error_code == ERROR_SUCCESS) return env.Null();
      return ThrowWindowsError(env, "ConnectNamedPipe", error_code);
    }
    std::uint8_t header[kHeaderBytes]{};
    IoResult result = ReadExact(header, kHeaderBytes, io_timeout, &error_code);
    if (result == IoResult::kTimeout) return ThrowError(env, "named-pipe control read timed out", "timeout");
    if (result == IoResult::kError) return ThrowWindowsError(env, "ReadFile", error_code);
    const std::uint32_t length = static_cast<std::uint32_t>(header[0]) |
                                 (static_cast<std::uint32_t>(header[1]) << 8U) |
                                 (static_cast<std::uint32_t>(header[2]) << 16U) |
                                 (static_cast<std::uint32_t>(header[3]) << 24U);
    if (length > max_frame_bytes_) return ThrowError(env, "named-pipe control frame exceeds its bound", "over-budget");
    std::vector<std::uint8_t> payload(length);
    if (length > 0) {
      result = ReadExact(payload.data(), length, io_timeout, &error_code);
      if (result == IoResult::kTimeout) return ThrowError(env, "named-pipe control read timed out", "timeout");
      if (result == IoResult::kError) return ThrowWindowsError(env, "ReadFile", error_code);
    }
    return Napi::Buffer<std::uint8_t>::Copy(env, payload.data(), payload.size());
  }

  Napi::Value Write(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!connected_ || info.Length() != 2 || !info[0].IsBuffer() || !info[1].IsNumber()) {
      return ThrowError(env, "invalid pipe write", "native-error");
    }
    const auto payload = info[0].As<Napi::Buffer<std::uint8_t>>();
    if (payload.Length() > max_frame_bytes_) return ThrowError(env, "named-pipe response exceeds its bound", "over-budget");
    std::vector<std::uint8_t> frame(kHeaderBytes + payload.Length());
    const std::uint32_t length = static_cast<std::uint32_t>(payload.Length());
    frame[0] = static_cast<std::uint8_t>(length & 0xffU);
    frame[1] = static_cast<std::uint8_t>((length >> 8U) & 0xffU);
    frame[2] = static_cast<std::uint8_t>((length >> 16U) & 0xffU);
    frame[3] = static_cast<std::uint8_t>((length >> 24U) & 0xffU);
    if (length > 0) std::copy(payload.Data(), payload.Data() + payload.Length(), frame.data() + kHeaderBytes);
    DWORD error_code = ERROR_SUCCESS;
    const IoResult result = WriteExact(frame.data(), static_cast<DWORD>(frame.size()), info[1].As<Napi::Number>().Uint32Value(), &error_code);
    Disconnect();
    if (result == IoResult::kTimeout) return ThrowError(env, "named-pipe control write timed out", "timeout");
    if (result == IoResult::kError) return ThrowWindowsError(env, "WriteFile", error_code);
    return env.Undefined();
  }

  Napi::Value DisconnectMethod(const Napi::CallbackInfo& info) {
    Disconnect();
    return info.Env().Undefined();
  }

  Napi::Value SecurityDescriptor(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (pipe_ == INVALID_HANDLE_VALUE) return ThrowError(env, "pipe is closed", "native-error");
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD status = GetSecurityInfo(
        pipe_, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &descriptor);
    if (status != ERROR_SUCCESS) return ThrowWindowsError(env, "GetSecurityInfo", status);
    LPWSTR serialized = nullptr;
    if (ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &serialized, nullptr) == FALSE) {
      const DWORD error_code = GetLastError();
      LocalFree(descriptor);
      return ThrowWindowsError(env, "ConvertSecurityDescriptorToStringSecurityDescriptorW", error_code);
    }
    const std::string result = WideToUtf8(serialized);
    LocalFree(serialized);
    LocalFree(descriptor);
    return Napi::String::New(env, result);
  }

  Napi::Value CloseMethod(const Napi::CallbackInfo& info) {
    Close();
    return info.Env().Undefined();
  }

  void Disconnect() {
    if (pipe_ != INVALID_HANDLE_VALUE && connected_) {
      DisconnectNamedPipe(pipe_);
      connected_ = false;
    }
  }

  void Close() {
    if (pipe_ == INVALID_HANDLE_VALUE) return;
    CancelIoEx(pipe_, nullptr);
    Disconnect();
    CloseHandle(pipe_);
    pipe_ = INVALID_HANDLE_VALUE;
  }

  HANDLE pipe_ = INVALID_HANDLE_VALUE;
  std::uint32_t max_frame_bytes_ = 0;
  bool connected_ = false;
};

Napi::Value CurrentUserSid(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) == FALSE) {
    return ThrowWindowsError(env, "OpenProcessToken", GetLastError());
  }
  DWORD required = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &required);
  if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    const DWORD error_code = GetLastError();
    CloseHandle(token);
    return ThrowWindowsError(env, "GetTokenInformation", error_code);
  }
  std::vector<std::uint8_t> storage(required);
  if (GetTokenInformation(token, TokenUser, storage.data(), required, &required) == FALSE) {
    const DWORD error_code = GetLastError();
    CloseHandle(token);
    return ThrowWindowsError(env, "GetTokenInformation", error_code);
  }
  CloseHandle(token);
  const auto* user = reinterpret_cast<const TOKEN_USER*>(storage.data());
  LPWSTR sid = nullptr;
  if (ConvertSidToStringSidW(user->User.Sid, &sid) == FALSE) {
    return ThrowWindowsError(env, "ConvertSidToStringSidW", GetLastError());
  }
  const std::string result = WideToUtf8(sid);
  LocalFree(sid);
  return Napi::String::New(env, result);
}

bool RegistryDefaultValue(const wchar_t* subkey, std::wstring* value) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, subkey, 0, KEY_QUERY_VALUE, &key) != ERROR_SUCCESS) return false;
  DWORD type = 0;
  DWORD bytes = 0;
  LSTATUS status = RegQueryValueExW(key, nullptr, nullptr, &type, nullptr, &bytes);
  if (status != ERROR_SUCCESS || type != REG_SZ || bytes < sizeof(wchar_t)) {
    RegCloseKey(key);
    return false;
  }
  std::vector<wchar_t> buffer(bytes / sizeof(wchar_t));
  status = RegQueryValueExW(key, nullptr, nullptr, &type, reinterpret_cast<LPBYTE>(buffer.data()), &bytes);
  RegCloseKey(key);
  if (status != ERROR_SUCCESS || buffer.empty() || buffer.back() != L'\0') return false;
  *value = std::wstring(buffer.data());
  return true;
}

Napi::Value RegisterNativeHost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsString()) return ThrowError(env, "manifest path is required", "native-error");
  const std::wstring manifest = Utf8ToWide(info[0].As<Napi::String>().Utf8Value());
  if (manifest.size() < 3 || manifest.size() > 32767 || manifest[1] != L':' ||
      (manifest[2] != L'\\' && manifest[2] != L'/')) {
    return ThrowError(env, "manifest path must be an absolute Windows path", "native-error");
  }
  std::vector<const wchar_t*> written;
  for (const wchar_t* subkey : kNativeHostRegistryKeys) {
    HKEY key = nullptr;
    const LSTATUS create = RegCreateKeyExW(
        HKEY_CURRENT_USER, subkey, 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr, &key, nullptr);
    if (create != ERROR_SUCCESS) {
      return ThrowWindowsError(env, "RegCreateKeyExW", static_cast<DWORD>(create));
    }
    const DWORD bytes = static_cast<DWORD>((manifest.size() + 1) * sizeof(wchar_t));
    const LSTATUS write = RegSetValueExW(
        key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(manifest.c_str()), bytes);
    RegCloseKey(key);
    if (write != ERROR_SUCCESS) {
      return ThrowWindowsError(env, "RegSetValueExW", static_cast<DWORD>(write));
    }
    written.push_back(subkey);
  }
  return Napi::Number::New(env, static_cast<double>(written.size()));
}

Napi::Value UnregisterNativeHost(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() != 1 || !info[0].IsString()) return ThrowError(env, "manifest path is required", "native-error");
  const std::wstring expected = Utf8ToWide(info[0].As<Napi::String>().Utf8Value());
  std::uint32_t removed = 0;
  for (const wchar_t* subkey : kNativeHostRegistryKeys) {
    std::wstring actual;
    if (!RegistryDefaultValue(subkey, &actual) || actual != expected) continue;
    const LSTATUS status = RegDeleteKeyW(HKEY_CURRENT_USER, subkey);
    if (status == ERROR_SUCCESS) removed += 1;
    else if (status != ERROR_FILE_NOT_FOUND) return ThrowWindowsError(env, "RegDeleteKeyW", static_cast<DWORD>(status));
  }
  return Napi::Number::New(env, removed);
}

Napi::Value NativeHostRegistryValues(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array values = Napi::Array::New(env, kNativeHostRegistryKeys.size());
  std::uint32_t index = 0;
  for (const wchar_t* subkey : kNativeHostRegistryKeys) {
    std::wstring value;
    if (RegistryDefaultValue(subkey, &value)) values.Set(index, Napi::String::New(env, WideToUtf8(value.c_str())));
    else values.Set(index, env.Null());
    index += 1;
  }
  return values;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("PipeServer", PipeServer::Define(env));
  exports.Set("currentUserSid", Napi::Function::New(env, CurrentUserSid));
  exports.Set("registerNativeHost", Napi::Function::New(env, RegisterNativeHost));
  exports.Set("unregisterNativeHost", Napi::Function::New(env, UnregisterNativeHost));
  exports.Set("nativeHostRegistryValues", Napi::Function::New(env, NativeHostRegistryValues));
  return exports;
}

}  // namespace

NODE_API_MODULE(overlook_windows_pipe, Init)
