#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

constexpr const char* kServiceLiteral = "com.zts1.overlook.library-master";

void Wipe(std::vector<std::uint8_t>& bytes) {
  volatile std::uint8_t* cursor = bytes.data();
  for (std::size_t index = 0; index < bytes.size(); ++index) cursor[index] = 0;
  bytes.clear();
}

bool IsUlid(const std::string& account) {
  if (account.size() != 26) return false;
  static const std::string alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return account.find_first_not_of(alphabet) == std::string::npos;
}

Napi::Object Status(Napi::Env env, const char* status) {
  Napi::Object result = Napi::Object::New(env);
  result.Set("status", Napi::String::New(env, status));
  return result;
}

const char* Failure(OSStatus status) {
  switch (status) {
    case errSecAuthFailed:
    case errSecInteractionNotAllowed:
    case errSecUserCanceled:
      return "denied";
    default:
      return "unavailable";
  }
}

NSMutableDictionary* BaseQuery(NSString* account) {
  LAContext* context = [[LAContext alloc] init];
  // A missing grant fails the call. Library open does not raise a keychain dialog.
  context.interactionNotAllowed = YES;
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : [NSString stringWithUTF8String:kServiceLiteral],
    (__bridge id)kSecAttrAccount : account,
    (__bridge id)kSecAttrSynchronizable : @NO,
    (__bridge id)kSecUseDataProtectionKeychain : @NO,
    (__bridge id)kSecUseAuthenticationContext : context,
  } mutableCopy];
}

enum class AccountGate { ready, status, thrown };

AccountGate ReadAccount(const Napi::CallbackInfo& info, std::string& account, Napi::Value& failure) {
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(info.Env(), "service and account are required").ThrowAsJavaScriptException();
    return AccountGate::thrown;
  }
  const std::string service = info[0].As<Napi::String>().Utf8Value();
  account = info[1].As<Napi::String>().Utf8Value();
  if (service != kServiceLiteral || !IsUlid(account)) {
    failure = Status(info.Env(), "unavailable");
    return AccountGate::status;
  }
  return AccountGate::ready;
}

Napi::Value Write(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string account;
  Napi::Value failure = env.Undefined();
  const AccountGate gate = ReadAccount(info, account, failure);
  if (gate == AccountGate::thrown) return env.Undefined();
  if (gate == AccountGate::status) return failure;
  if (info.Length() < 3 || !info[2].IsBuffer()) {
    Napi::TypeError::New(env, "secret must be a Buffer").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const Napi::Buffer<std::uint8_t> secret = info[2].As<Napi::Buffer<std::uint8_t>>();
  std::vector<std::uint8_t> copy(secret.Data(), secret.Data() + secret.Length());
  @autoreleasepool {
    NSString* accountName = [[NSString alloc] initWithBytes:account.data() length:account.size() encoding:NSUTF8StringEncoding];
    NSMutableData* value = [NSMutableData dataWithLength:copy.size()];
    if (!copy.empty()) memcpy(value.mutableBytes, copy.data(), copy.size());
    Wipe(copy);
    NSMutableDictionary* query = BaseQuery(accountName);
    NSDictionary* update = @{(__bridge id)kSecValueData : value};
    const OSStatus updated = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)update);
    if (updated == errSecSuccess) {
      [value resetBytesInRange:NSMakeRange(0, value.length)];
      return Status(env, "stored");
    }
    if (updated != errSecItemNotFound) {
      [value resetBytesInRange:NSMakeRange(0, value.length)];
      return Status(env, Failure(updated));
    }

    // Login-keychain trusted-application ACL. The data-protection keychain would need a
    // keychain access group this app's profile-free entitlements do not ship.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    SecTrustedApplicationRef trusted = nullptr;
    if (SecTrustedApplicationCreateFromPath(nullptr, &trusted) != errSecSuccess || trusted == nullptr) {
      [value resetBytesInRange:NSMakeRange(0, value.length)];
      return Status(env, "unavailable");
    }
    NSArray* trustedApplications = @[ (__bridge id)trusted ];
    SecAccessRef access = nullptr;
    const OSStatus created =
        SecAccessCreate(CFSTR("Overlook library master"), (__bridge CFArrayRef)trustedApplications, &access);
    CFRelease(trusted);
#pragma clang diagnostic pop
    if (created != errSecSuccess || access == nullptr) {
      [value resetBytesInRange:NSMakeRange(0, value.length)];
      return Status(env, "unavailable");
    }
    query[(__bridge id)kSecAttrAccess] = (__bridge id)access;
    query[(__bridge id)kSecValueData] = value;
    const OSStatus added = SecItemAdd((__bridge CFDictionaryRef)query, nullptr);
    [value resetBytesInRange:NSMakeRange(0, value.length)];
    CFRelease(access);
    return Status(env, added == errSecSuccess ? "stored" : Failure(added));
  }
}

Napi::Value Read(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string account;
  Napi::Value failure = env.Undefined();
  const AccountGate gate = ReadAccount(info, account, failure);
  if (gate == AccountGate::thrown) return env.Undefined();
  if (gate == AccountGate::status) return failure;
  @autoreleasepool {
    NSString* accountName = [[NSString alloc] initWithBytes:account.data() length:account.size() encoding:NSUTF8StringEncoding];
    NSMutableDictionary* query = BaseQuery(accountName);
    query[(__bridge id)kSecReturnData] = @YES;
    query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    CFTypeRef result = nullptr;
    const OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecItemNotFound) return Status(env, "absent");
    if (status != errSecSuccess || result == nullptr || CFGetTypeID(result) != CFDataGetTypeID()) {
      if (result != nullptr) CFRelease(result);
      return Status(env, Failure(status));
    }
    const auto* data = static_cast<CFDataRef>(result);
    const UInt8* bytes = CFDataGetBytePtr(data);
    const CFIndex length = CFDataGetLength(data);
    Napi::Object value = Status(env, "value");
    if (bytes != nullptr && length > 0) {
      value.Set("data", Napi::Buffer<std::uint8_t>::Copy(env, bytes, static_cast<std::size_t>(length)));
    } else {
      value.Set("data", Napi::Buffer<std::uint8_t>::Copy(env, nullptr, 0));
    }
    CFRelease(result);
    return value;
  }
}

Napi::Value Remove(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string account;
  Napi::Value failure = env.Undefined();
  const AccountGate gate = ReadAccount(info, account, failure);
  if (gate == AccountGate::thrown) return env.Undefined();
  if (gate == AccountGate::status) return failure;
  @autoreleasepool {
    NSString* accountName = [[NSString alloc] initWithBytes:account.data() length:account.size() encoding:NSUTF8StringEncoding];
    const OSStatus status = SecItemDelete((__bridge CFDictionaryRef)BaseQuery(accountName));
    if (status == errSecSuccess || status == errSecItemNotFound) return Status(env, "stored");
    return Status(env, Failure(status));
  }
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("write", Napi::Function::New(env, Write));
  exports.Set("read", Napi::Function::New(env, Read));
  exports.Set("remove", Napi::Function::New(env, Remove));
  return exports;
}

}  // namespace

NODE_API_MODULE(overlook_library_master, Init)
