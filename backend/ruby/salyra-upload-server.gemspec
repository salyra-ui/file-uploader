Gem::Specification.new do |spec|
  spec.name = 'salyra-upload-server'
  spec.version = '0.1.0'
  spec.summary = 'Streaming upload sessions and configurable storage'
  spec.authors = ['Salyra UI']
  spec.license = 'MIT'
  spec.required_ruby_version = '>= 3.1'
  spec.files = Dir['lib/**/*.rb'] + ['README.md', 'LICENSE']
  spec.homepage = 'https://salyra-ui.github.io/docs/upload-server.html'
  spec.metadata = { 'source_code_uri' => 'https://github.com/salyra-ui/file-upload', 'documentation_uri' => spec.homepage }
  spec.require_paths = ['lib']
end
