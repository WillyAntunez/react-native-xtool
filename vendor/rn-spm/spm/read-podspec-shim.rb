# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

# rn-xtool's podspec reader: runs a podspec with the system Ruby as CocoaPods runs it, against a shim of CocoaPods'
# DSL, and writes the spec in CocoaPods' JSON form (what `pod ipc spec` prints).
#
#   ruby read-podspec-shim.rb --probe
#     prints {"ruby":"<version>","floor":"<floor>","usable":true}, or "usable":false with a "why", and exits 0.
#   ruby read-podspec-shim.rb <podspec> <out.json> <installation-root>
#     run in the podspec's folder: exits 0 with the model in <out.json>, or 1 with {"error":{"kind","message"}} in it.
#     Nothing of the shim's own goes to stdout; the podspec's prints do.
#
# Ruby 2.7 syntax only: on an older Ruby the file must still parse, so that the floor check can say why it stops.

RN_XTOOL_RUBY_FLOOR = '2.7.0'
if (RUBY_VERSION.split('.').map(&:to_i) <=> RN_XTOOL_RUBY_FLOOR.split('.').map(&:to_i)) < 0
  why = "ruby #{RUBY_VERSION} is older than #{RN_XTOOL_RUBY_FLOOR}"
  abort why unless ARGV == ['--probe']
  puts %({"ruby":"#{RUBY_VERSION}","floor":"#{RN_XTOOL_RUBY_FLOOR}","usable":false,"why":"#{why}"})
  exit 0
end

require 'json'

if ARGV == ['--probe']
  puts JSON.generate('ruby' => RUBY_VERSION, 'floor' => RN_XTOOL_RUBY_FLOOR, 'usable' => true)
  exit 0
end

module Pod
  # A spec as CocoaPods 1.16's DSL builds it: each attribute is stored as the podspec gave it.
  class Specification
    # Set on the root spec only, never per platform.
    ROOT_ATTRIBUTES = %w[
      name version swift_versions cocoapods_version authors social_media_url license homepage readme changelog source
      summary description screenshots documentation_url prepare_command static_framework deprecated
      deprecated_in_favor_of
    ].freeze
    # Also set per platform (`s.ios.frameworks = ...`).
    PLATFORM_ATTRIBUTES = %w[
      requires_arc frameworks weak_frameworks libraries compiler_flags pod_target_xcconfig user_target_xcconfig xcconfig
      prefix_header_contents prefix_header_file module_name header_dir header_mappings_dir script_phases
      on_demand_resources info_plist source_files public_header_files project_header_files private_header_files
      vendored_frameworks vendored_libraries resource_bundles resources exclude_files preserve_paths module_map
      requires_app_host app_host_name scheme test_type
    ].freeze
    ATTRIBUTES = (ROOT_ATTRIBUTES + %w[platforms default_subspecs] + PLATFORM_ATTRIBUTES).freeze
    # Stored under the plural key.
    SINGULAR_ALIASES = {
      'swift_version' => 'swift_versions', 'author' => 'authors', 'screenshot' => 'screenshots',
      'framework' => 'frameworks', 'weak_framework' => 'weak_frameworks', 'library' => 'libraries',
      'compiler_flag' => 'compiler_flags', 'script_phase' => 'script_phases',
      'vendored_framework' => 'vendored_frameworks', 'vendored_library' => 'vendored_libraries',
      'resource_bundle' => 'resource_bundles', 'resource' => 'resources', 'preserve_path' => 'preserve_paths',
      'default_subspec' => 'default_subspecs'
    }.freeze
    # The platform proxies, and the platform each stores under.
    PLATFORMS = {
      'ios' => 'ios', 'osx' => 'osx', 'macos' => 'osx', 'tvos' => 'tvos', 'visionos' => 'visionos',
      'watchos' => 'watchos'
    }.freeze

    def initialize(parent = nil, name = nil)
      @parent = parent
      @attributes = {}
      @attributes['name'] = name if name
      @subspecs = []
      @testspecs = []
      @appspecs = []
      yield self if block_given?
    end

    ATTRIBUTES.each do |attribute|
      define_method("#{attribute}=") { |value| @attributes[attribute] = value }
      define_method(attribute) { @attributes[attribute] } unless attribute == 'name'
    end
    SINGULAR_ALIASES.each do |singular, plural|
      define_method("#{singular}=") { |value| @attributes[plural] = value }
    end
    PLATFORMS.each do |proxy, platform|
      define_method(proxy) { PlatformProxy.new(@attributes, platform) }
    end

    # A subspec's name reads as CocoaPods gives it, `Foo/core`; the model keeps its base name.
    def name
      @parent ? "#{@parent.name}/#{@attributes['name']}" : @attributes['name']
    end

    def platform=(value)
      platform, deployment_target = value
      @attributes['platforms'] = platform ? { PLATFORMS.fetch(platform.to_s, platform.to_s) => deployment_target } : {}
    end

    def dependency(name, *requirements)
      (@attributes['dependencies'] ||= {})[name] = requirements
    end

    def subspec(name, &block)
      add(@subspecs, name, &block)
    end

    def test_spec(name = 'Tests', &block)
      add(@testspecs, name, &block)
    end

    def app_spec(name = 'App', &block)
      add(@appspecs, name, &block)
    end

    # The spec in CocoaPods' JSON form.
    def to_model
      model = RnXtoolShim.plain(@attributes)
      if model.key?('default_subspecs')
        model['default_subspecs'] = Array(model['default_subspecs']) unless model['default_subspecs'] == 'none'
      end
      { 'subspecs' => @subspecs, 'testspecs' => @testspecs, 'appspecs' => @appspecs }.each do |key, specs|
        model[key] = specs.map(&:to_model) unless specs.empty?
      end
      model
    end

    private

    def add(list, name, &block)
      spec = Specification.new(self, name, &block)
      list << spec
      spec
    end

    # `s.ios`, `s.osx` (and `s.macos`), `s.tvos`, `s.visionos`, `s.watchos`: stores under the spec's platform key.
    class PlatformProxy
      def initialize(attributes, platform)
        @attributes = attributes
        @platform = platform
      end

      PLATFORM_ATTRIBUTES.each do |attribute|
        define_method("#{attribute}=") { |value| scoped[attribute] = value }
      end
      SINGULAR_ALIASES.each do |singular, plural|
        define_method("#{singular}=") { |value| scoped[plural] = value } if PLATFORM_ATTRIBUTES.include?(plural)
      end

      def deployment_target=(value)
        (@attributes['platforms'] ||= {})[@platform] = value
      end

      def dependency(name, *requirements)
        (scoped['dependencies'] ||= {})[name] = requirements
      end

      private

      def scoped
        @attributes[@platform] ||= {}
      end
    end
  end

  Spec = Specification

  # As CocoaPods-core evaluates a podspec: `self` is `Pod`, and `Spec` resolves inside it.
  def self._eval_podspec(string, path)
    eval(string, nil, path)
  end
end

# The command line's run: evaluate, then write the model or the error file.
module RnXtoolShim
  module_function

  # Writes the model, or the error, to `out`; whether the podspec read.
  def run(podspec, out)
    spec = Pod._eval_podspec(File.read(podspec, encoding: 'UTF-8'), podspec)
    unless spec.is_a?(Pod::Specification)
      write(out, 'error' => { 'kind' => 'not-a-spec', 'message' => "#{podspec}: the podspec does not evaluate to a Pod::Spec" })
      return false
    end
    write(out, spec.to_model.merge(
      '__rn_xtool__' => { 'env' => [], 'helpers' => [], 'ui' => [], 'spm_dependencies' => [] }
    ))
    true
  rescue ScriptError, StandardError, SystemExit => e
    kind, message = failure(e, podspec)
    write(out, 'error' => { 'kind' => kind, 'message' => message })
    false
  end

  def write(out, value)
    File.write(out, JSON.generate(value))
  end

  # A value as CocoaPods' JSON form writes it: symbols, hash keys and Pathnames as strings.
  def plain(value)
    case value
    when Hash then value.each_with_object({}) { |(key, item), out| out[key.to_s] = plain(item) }
    when Array then value.map { |item| plain(item) }
    when String, Numeric, true, false, nil then value
    else value.to_s
    end
  end

  # [kind, message] of an exception the podspec's run raised.
  def failure(error, podspec)
    where = where(error, podspec)
    if error.is_a?(NameError)
      receiver = receiver_of(error)
      name = error.name.to_s
      if receiver.is_a?(Pod::Specification) || receiver.is_a?(Pod::Specification::PlatformProxy)
        attribute = name.chomp('=')
        return ['attribute', "#{where}: the podspec sets #{receiver_text(error, podspec, receiver, attribute)}.#{attribute}, " \
                             'which CocoaPods does not define']
      end
      if modeled?(receiver)
        if !error.is_a?(NoMethodError) && name.match?(/\A[A-Z]/)
          return ['constant', "#{where}: the podspec uses #{name}, which rn-xtool's podspec reader does not model"]
        end
        return ['method', "#{where}: the podspec calls #{name}(…), which rn-xtool's podspec reader does not model"]
      end
    end
    message = error.message
    message = message.sub(/\A.+?:\d+: /, '') if error.is_a?(SyntaxError)
    ['raised', "#{where}: #{message.rstrip}"]
  end

  # The error's receiver, or nil when Ruby kept none.
  def receiver_of(error)
    error.receiver
  rescue ArgumentError
    nil
  end

  # `Pod`, the main object, `Object` (a top-level constant) or an object of the shim's.
  def modeled?(receiver)
    return true if receiver.equal?(TOPLEVEL_BINDING.receiver) || receiver.equal?(Object)

    namespace = Module === receiver ? receiver : receiver.class
    namespace.name.to_s.split('::').first == 'Pod'
  end

  # How the podspec's line names the spec an unknown attribute was set on: `s`, `ss.ios`.
  def receiver_text(error, podspec, receiver, attribute)
    path, line = frame(error, podspec)
    source = path && source_line(path, line)
    found = source && source[/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\.\s*#{Regexp.escape(attribute)}(?!\w)/, 1]
    return found if found

    receiver.is_a?(Pod::Specification) ? 'spec' : "spec.#{receiver.instance_variable_get(:@platform)}"
  end

  def source_line(path, line)
    File.readlines(path, encoding: 'UTF-8')[line - 1]
  rescue SystemCallError
    nil
  end

  # `<podspec>:<line>` for a frame in the podspec, `<podspec> (<file>:<line>)` for one in another of the library's
  # files (relative to the podspec's folder), or `<podspec>` alone.
  def where(error, podspec)
    path, line = frame(error, podspec)
    return podspec unless path
    return "#{podspec}:#{line}" if File.expand_path(path) == File.expand_path(podspec)

    "#{podspec} (#{relative(path, podspec)}:#{line})"
  end

  # The innermost [path, line] of the error in the podspec or another of the library's files, never the shim's.
  def frame(error, podspec)
    frames = (error.backtrace_locations || []).map { |location| [location.path, location.lineno] }
    # A syntax error names its place only in its message.
    frames.unshift([Regexp.last_match(1), Regexp.last_match(2).to_i]) if error.is_a?(SyntaxError) && error.message =~ /\A(.+?):(\d+): /
    frames.find do |path, _|
      next true if File.expand_path(path) == File.expand_path(podspec)

      # Ruby's own frames (`<internal:…>`, `(eval)`) have no absolute path.
      path.start_with?('/') && File.expand_path(path) != File.expand_path(__FILE__) && !relative(path, podspec).nil?
    end
  end

  # `path` relative to the podspec's folder (as given or with its links resolved), or nil outside it.
  def relative(path, podspec)
    full = File.expand_path(path)
    folder = File.dirname(File.expand_path(podspec))
    [folder, real(folder)].each do |root|
      return full[(root.length + 1)..-1] if full.start_with?("#{root}/")
    end
    nil
  end

  def real(folder)
    File.realpath(folder)
  rescue SystemCallError
    folder
  end
end

abort 'usage: ruby read-podspec-shim.rb --probe | <podspec> <out.json> <installation-root>' unless ARGV.length == 3
exit(RnXtoolShim.run(ARGV[0], ARGV[1]) ? 0 : 1)
