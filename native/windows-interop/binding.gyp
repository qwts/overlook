{
  "targets": [
    {
      "target_name": "overlook_windows_pipe",
      "sources": ["windows_pipe.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "libraries": ["Advapi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++20"]
        }
      }
    }
  ]
}
