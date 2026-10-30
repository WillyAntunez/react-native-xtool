# Excerpt of expo-router 58.0.28's ios/ExpoRouter.podspec: the podspec sits under ios/, compiler_flags is a local
# variable (not the pod attribute), and vendored_frameworks is set on the spec.
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

new_arch_enabled = ENV['RCT_NEW_ARCH_ENABLED'] == '1'
new_arch_compiler_flags = '-DRCT_NEW_ARCH_ENABLED'
compiler_flags = ''

if new_arch_enabled
  compiler_flags << ' ' << new_arch_compiler_flags
end

Pod::Spec.new do |s|
  s.name           = 'ExpoRouter'
  s.version        = package['version']
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_SWIFT_FLAGS' => "$(inherited) #{compiler_flags}",
  }

  if File.exist?("#{s.name}.xcframework")
    s.source_files = "**/*.h"
    s.vendored_frameworks = "#{s.name}.xcframework"
  else
    s.source_files = "**/*.{h,m,swift,mm,cpp}"
  end
end
