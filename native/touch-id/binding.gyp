{
  "targets": [
    {
      "target_name": "overlook_touch_id",
      "sources": ["touch_id.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc"],
        "OTHER_LDFLAGS": ["-framework Foundation", "-framework LocalAuthentication", "-framework Security"]
      }
    },
    {
      "target_name": "overlook_raw_preview",
      "sources": ["raw_preview.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc"],
        "OTHER_LDFLAGS": ["-framework Foundation", "-framework CoreImage", "-framework ImageIO", "-framework CoreGraphics"]
      }
    },
    {
      "target_name": "overlook_icloud_drive",
      "sources": ["icloud_drive.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc"],
        "OTHER_LDFLAGS": ["-framework Foundation", "-framework Security"]
      }
    },
    {
      "target_name": "overlook_native_drag",
      "sources": ["native_drag.mm"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc"],
        "OTHER_LDFLAGS": ["-framework AppKit", "-framework Foundation", "-framework Security"]
      }
    }
  ]
}
