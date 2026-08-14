#import <FileProvider/FileProvider.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <napi.h>

#include <string>
#include <vector>

namespace {

NSString* String(const std::string& value) {
  return [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
}

std::string Utf8(NSString* value) {
  const char* bytes = value.UTF8String;
  return bytes == nullptr ? std::string{} : std::string(bytes);
}

bool ValidCodeAtUrl(NSURL* url) {
  if (url == nil) return false;
  SecStaticCodeRef code = nullptr;
  if (SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code) != errSecSuccess || code == nullptr) return false;
  const bool valid = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, nullptr) == errSecSuccess;
  CFRelease(code);
  return valid;
}

bool Status(const Napi::CallbackInfo& info) {
  @autoreleasepool {
    const std::string appId = info[0].As<Napi::String>().Utf8Value();
    const std::string extensionId = info[1].As<Napi::String>().Utf8Value();
    NSBundle* app = NSBundle.mainBundle;
    NSURL* stateDirectory = [NSFileManager.defaultManager
        containerURLForSecurityApplicationGroupIdentifier:@"Z5DM34QS5U.com.zts1.overlook.file-provider"];
    if (stateDirectory == nil) return false;
    if (![app.bundleIdentifier isEqualToString:String(appId)] || !ValidCodeAtUrl(app.bundleURL)) return false;
    for (NSURL* candidate in [NSFileManager.defaultManager contentsOfDirectoryAtURL:app.builtInPlugInsURL includingPropertiesForKeys:nil options:0 error:nil]) {
      NSBundle* bundle = [NSBundle bundleWithURL:candidate];
      if ([bundle.bundleIdentifier isEqualToString:String(extensionId)] && ValidCodeAtUrl(candidate)) return true;
    }
    return false;
  }
}

Napi::Value StateDirectory(const Napi::CallbackInfo& info) {
  @autoreleasepool {
    NSURL* directory = [NSFileManager.defaultManager
        containerURLForSecurityApplicationGroupIdentifier:@"Z5DM34QS5U.com.zts1.overlook.file-provider"];
    if (directory == nil) return info.Env().Null();
    return Napi::String::New(info.Env(), Utf8(directory.path));
  }
}

enum class Operation { Add, Remove, Evict, Changed };

class DomainWorker final : public Napi::AsyncWorker {
 public:
  DomainWorker(Napi::Function callback, Operation operation, std::string id, std::string name,
               std::vector<std::string> container_ids = {})
      : Napi::AsyncWorker(callback),
        operation_(operation),
        id_(std::move(id)),
        name_(std::move(name)),
        container_ids_(std::move(container_ids)) {}

  void Execute() override {
    @autoreleasepool {
      NSFileProviderDomain* domain = [[NSFileProviderDomain alloc] initWithIdentifier:String(id_) displayName:String(name_)];
      dispatch_semaphore_t completed = dispatch_semaphore_create(0);
      __block NSError* failure = nil;
      void (^done)(NSError*) = ^(NSError* error) {
        failure = error;
        dispatch_semaphore_signal(completed);
      };
      if (operation_ == Operation::Add) {
        [NSFileProviderManager addDomain:domain completionHandler:done];
      } else if (operation_ == Operation::Remove) {
        [NSFileProviderManager removeDomain:domain completionHandler:done];
      } else {
        NSFileProviderManager* manager = [NSFileProviderManager managerForDomain:domain];
        if (manager == nil) {
          SetError("File Provider domain is unavailable");
          return;
        }
        if (operation_ == Operation::Evict) {
          [manager evictItemWithIdentifier:NSFileProviderRootContainerItemIdentifier completionHandler:done];
        } else {
          NSMutableArray<NSFileProviderItemIdentifier>* identifiers = [NSMutableArray arrayWithObject:NSFileProviderWorkingSetContainerItemIdentifier];
          for (const std::string& container_id : container_ids_) {
            NSFileProviderItemIdentifier identifier = container_id == "root" ? NSFileProviderRootContainerItemIdentifier : String(container_id);
            if (![identifiers containsObject:identifier]) [identifiers addObject:identifier];
          }
          for (NSFileProviderItemIdentifier identifier in identifiers) {
            failure = nil;
            [manager signalEnumeratorForContainerItemIdentifier:identifier completionHandler:done];
            dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
            if (failure != nil) {
              SetError(Utf8(failure.localizedDescription));
              return;
            }
          }
          return;
        }
      }
      dispatch_semaphore_wait(completed, DISPATCH_TIME_FOREVER);
      if (failure != nil) SetError(Utf8(failure.localizedDescription));
    }
  }

  void OnOK() override { Callback().Call({Env().Undefined()}); }

 private:
  Operation operation_;
  std::string id_;
  std::string name_;
  std::vector<std::string> container_ids_;
};

Napi::Value Start(const Napi::CallbackInfo& info, Operation operation) {
  std::string id;
  std::string name;
  std::vector<std::string> container_ids;
  Napi::Function callback;
  if (operation == Operation::Add) {
    Napi::Object domain = info[0].As<Napi::Object>();
    id = domain.Get("id").As<Napi::String>().Utf8Value();
    name = domain.Get("displayName").As<Napi::String>().Utf8Value();
    callback = info[1].As<Napi::Function>();
  } else if (operation == Operation::Changed) {
    id = info[0].As<Napi::String>().Utf8Value();
    name = id;
    Napi::Array containers = info[1].As<Napi::Array>();
    container_ids.reserve(containers.Length());
    for (uint32_t index = 0; index < containers.Length(); ++index) {
      container_ids.push_back(containers.Get(index).As<Napi::String>().Utf8Value());
    }
    callback = info[2].As<Napi::Function>();
  } else {
    id = info[0].As<Napi::String>().Utf8Value();
    name = id;
    callback = info[1].As<Napi::Function>();
  }
  (new DomainWorker(callback, operation, std::move(id), std::move(name), std::move(container_ids)))->Queue();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("status", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return Napi::Boolean::New(info.Env(), Status(info)); }));
  exports.Set("stateDirectory", Napi::Function::New(env, StateDirectory));
  exports.Set("register", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return Start(info, Operation::Add); }));
  exports.Set("remove", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return Start(info, Operation::Remove); }));
  exports.Set("evict", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return Start(info, Operation::Evict); }));
  exports.Set("changed", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return Start(info, Operation::Changed); }));
  return exports;
}

}  // namespace

NODE_API_MODULE(overlook_file_provider, Init)
