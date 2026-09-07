Pod::Spec.new do |s|
  s.name = 'SyncachuBackgroundBackup'
  s.version = '1.0.0'
  s.summary = 'Account-scoped native background backups for Syncachu'
  s.description = 'Durable, file-backed background URLSession media uploads.'
  s.license = { :type => 'MIT' }
  s.author = 'Syncachu'
  s.homepage = 'https://github.com/Blynks/Syncachu'
  s.source = { :git => 'https://github.com/Blynks/Syncachu.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Foundation', 'UIKit', 'Photos', 'CryptoKit', 'Security',
                 'BackgroundTasks', 'AVFoundation', 'ImageIO', 'Network'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
