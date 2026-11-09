import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../src/tools/exec.js";
import { SHIM, needsRuby, runShim, tempDir } from "./support/ruby.js";
import { needsTarball, tarballPath } from "./support/tarballs.js";
import { tool } from "./support/tools.js";

// The podspec reader's Ruby shim (vendor/rn-spm/spm/read-podspec-shim.rb), run by the real `ruby` on podspecs written
// into temp folders. The shim-ruby-floor CI job runs this file on the oldest Ruby the shim supports.
const spec = (...lines: string[]) => ["Pod::Spec.new do |s|", ' s.name = "Foo"', ...lines, "end"].join("\n");
// React Native's folly compiler flags, as get_folly_config answers them.
const FOLLY_FLAGS =
  "-DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -DFOLLY_CFG_NO_COROUTINES=1 -DFOLLY_HAVE_CLOCK_GETTIME=1 -Wno-comma -Wno-shorten-64-to-32";
// The React Native lines rn-xtool supports, whose scripts/cocoapods/helpers.rb define the helpers' values.
const RN_LINES = ["0.85.0", "0.86.3", "0.87.1", "0.88.0", "0.88.1"].map((v) => `react-native@${v}`);
const NEEDS_RN = RN_LINES.map((line) => needsTarball(line)).find((needs) => needs !== "") ?? "";
const WORKLETS = path.join(packageRoot(), "tests", "fixtures", "podspecs", "RNWorklets-0.8.3");

describe.skipIf(needsRuby !== "")(`the podspec shim${needsRuby}`, () => {
  it("--probe prints the Ruby version and the floor", () => {
    expect(JSON.parse(tool("ruby", [SHIM, "--probe"]).stdout)).toEqual({ ruby: expect.stringMatching(/^\d+\.\d+\.\d+/), floor: "2.7.0", usable: true });
  });

  it("writes the spec in CocoaPods' JSON form", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.name = "Foo"\n s.version = "1.2.3"\n s.source_files = "ios/**/*.{h,m}"\n s.dependency "React-Core"\n s.dependency "Bar", "~> 1.0"\n s.pod_target_xcconfig = { "OTHER_CFLAGS" => "-DX=1" }\n s.ios.deployment_target = "15.1"\n s.source = { :git => "x", :tag => "v#{s.version}" }\nend`);
    expect(r.status).toBe(0);
    expect(r.json).toEqual({ name: "Foo", version: "1.2.3", source_files: "ios/**/*.{h,m}", dependencies: { "React-Core": [], Bar: ["~> 1.0"] },
      pod_target_xcconfig: { OTHER_CFLAGS: "-DX=1" }, platforms: { ios: "15.1" }, source: { git: "x", tag: "v1.2.3" },
      __rn_xtool__: { env: [], helpers: [], ui: [], spm_dependencies: [] } });
  });

  it("nests subspecs under their base name and keeps test specs apart", () => {
    const r = runShim(spec(
      ' s.default_subspec = "core"',
      ' s.subspec "core" do |ss|',
      "  ss.summary = ss.name",
      '  ss.subspec "deep" do |d|',
      "   d.summary = d.name",
      "  end",
      " end",
      ' s.test_spec "Tests" do |t|',
      '  t.source_files = "Tests/*.m"',
      " end",
    ));
    expect(r.status).toBe(0);
    expect(r.json.subspecs).toEqual([{ name: "core", summary: "Foo/core", subspecs: [{ name: "deep", summary: "Foo/core/deep" }] }]);
    expect(r.json.default_subspecs).toEqual(["core"]);
    expect(r.json.testspecs).toEqual([{ name: "Tests", source_files: "Tests/*.m" }]);
    expect(r.json.subspecs.map((s: { name: string }) => s.name)).not.toContain("Tests");
    expect(runShim(spec(" s.default_subspecs = :none")).json.default_subspecs).toBe("none");
  });

  it("stores platform-scoped attributes under their platform", () => {
    const r = runShim(spec(
      ' s.platform = :ios, "12.0"',
      ' s.ios.exclude_files = "a"',
      ' s.osx.exclude_files = "b"',
      ' s.macos.frameworks = "AppKit"',
      " s.summary = s.respond_to?(:visionos).to_s",
      ' s.subspec "core" do |ss|',
      '  ss.ios.dependency "X"',
      " end",
    ));
    expect(r.status).toBe(0);
    expect(r.json.platforms).toEqual({ ios: "12.0" });
    expect(r.json.ios).toEqual({ exclude_files: "a" });
    expect(r.json.osx).toEqual({ exclude_files: "b", frameworks: "AppKit" });
    expect(r.json.summary).toBe("true");
    expect(r.json.subspecs[0].ios).toEqual({ dependencies: { X: [] } });
  });

  it("stores a singular alias under the plural key", () => {
    const r = runShim(spec(' s.framework = "UIKit"', ' s.author = "a"'));
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ frameworks: "UIKit", authors: "a" });
    expect(r.json).not.toHaveProperty("framework");
    expect(r.json).not.toHaveProperty("author");
  });

  it("answers attributes_hash with the attributes as stored", () => {
    // Nitro's generated add_nitrogen_files reads the attributes set so far and adds its own to them.
    const r = runShim(spec(
      ' s.source_files = "ios/**/*.swift"',
      ' s.pod_target_xcconfig = { "DEFINES_MODULE" => "NO", "OTHER_CFLAGS" => "-DX=1" }',
      ' s.ios.frameworks = "UIKit"',
      " s.source_files = Array(s.attributes_hash['source_files']) + ['nitrogen/**/*.swift']",
      " s.pod_target_xcconfig = (s.attributes_hash['pod_target_xcconfig'] || {}).merge('DEFINES_MODULE' => 'YES')",
      " s.summary = s.attributes_hash['ios']['frameworks']",
      " s.description = s.attributes_hash['public_header_files'].nil?.to_s",
      ' s.subspec "core" do |ss|',
      "  ss.summary = ss.attributes_hash.keys.join(',')",
      " end",
    ));
    expect(r.status).toBe(0);
    expect(r.json.source_files).toEqual(["ios/**/*.swift", "nitrogen/**/*.swift"]);
    expect(r.json.pod_target_xcconfig).toEqual({ DEFINES_MODULE: "YES", OTHER_CFLAGS: "-DX=1" });
    expect([r.json.summary, r.json.description]).toEqual(["UIKit", "true"]);
    expect(r.json.subspecs[0].summary).toBe("name");
  });

  it("refuses an attribute CocoaPods does not define", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.name = "Foo"\n s.not_an_attribute = 1\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "attribute"]);
    expect(r.json.error.message).toBe(`${r.podspec}:3: the podspec sets s.not_an_attribute, which CocoaPods does not define`);
  });

  it("names an unmodeled method with its line", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.source_files = sources_for("ios")\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "method"]);
    expect(r.json.error.message).toBe(`${r.podspec}:2: the podspec calls sources_for(…), which rn-xtool's podspec reader does not model`);
  });

  it("names an unmodeled constant", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.version = Foo::Bar.baz\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "constant"]);
    expect(r.json.error.message).toBe(`${r.podspec}:2: the podspec uses Foo, which rn-xtool's podspec reader does not model`);
  });

  it("names the library file a failure comes from", () => {
    const r = runShim(`require_relative "scripts/x"\n${spec()}`, { files: { "scripts/x.rb": "# one\n# two\n# three\nnope()\n" } });
    expect([r.status, r.json.error.kind]).toEqual([1, "method"]);
    expect(r.json.error.message).toBe(`${r.podspec} (scripts/x.rb:4): the podspec calls nope(…), which rn-xtool's podspec reader does not model`);
  });

  it("passes the podspec's own raise on with its line", () => {
    const r = runShim(`Pod::Spec.new do |s|\n raise "boom"\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "raised"]);
    expect(r.json.error.message).toBe(`${r.podspec}:2: boom`);
  });

  // Ruby words these messages differently from version to version: the tests pin the kind and the place only.
  it("passes a syntax error in the podspec on with its line", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.name = "Foo" )\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "raised"]);
    expect(r.json.error.message.startsWith(`${r.podspec}:2: `)).toBe(true);
  });

  it("passes a syntax error in a library file on with that file's line", () => {
    const r = runShim(`require_relative "scripts/x"\n${spec()}`, { files: { "scripts/x.rb": 'x = "a" )\n' } });
    expect([r.status, r.json.error.kind]).toEqual([1, "raised"]);
    expect(r.json.error.message.startsWith(`${r.podspec} (scripts/x.rb:1): `)).toBe(true);
  });

  it("passes a method called on nil on as the podspec's own failure", () => {
    const r = runShim(`Pod::Spec.new do |s|\n s.name = nil.upcase\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "raised"]);
    expect(r.json.error.message.startsWith(`${r.podspec}:2: `)).toBe(true);
  });

  it("passes the podspec's exit on as a failure", () => {
    const r = runShim(`Pod::Spec.new do |s|\n exit 0\nend`);
    expect([r.status, r.json.error.kind]).toEqual([1, "raised"]);
    expect(r.json.error.message.startsWith(`${r.podspec}:2: `)).toBe(true);
  });

  it("refuses a file that is not a spec", () => {
    const r = runShim("42\n");
    expect([r.status, r.json.error.kind]).toEqual([1, "not-a-spec"]);
    expect(r.json.error.message).toBe(`${r.podspec}: the podspec does not evaluate to a Pod::Spec`);
  });

  it("keeps the model out of the podspec's prints", () => {
    const r = runShim(`puts "{ not json }"\n${spec()}`);
    expect(r.status).toBe(0);
    expect(r.json.name).toBe("Foo");
    expect(r.stdout).toContain("{ not json }");
  });

  describe("the environment", () => {
    it("captures Pod::UI and does not print it", () => {
      const r = runShim(`Pod::UI.puts "hi"\nPod::UI.warn "w"\n${spec()}`);
      expect(r.status).toBe(0);
      expect(r.json.__rn_xtool__.ui).toEqual(["hi", "w"]);
      expect(r.stdout).toBe("");
    });

    it("answers Pod::Config with the installation root", () => {
      const r = runShim(spec(
        " c = Pod::Config.instance",
        ' s.summary = [c.installation_root, c.project_root, c.project_pods_root].map(&:to_s).join("|")',
        ' s.readme = [c.installation_root, c.project_root, c.project_pods_root].map { |p| p.class.name }.uniq.join',
        " s.description = c.instance_variable_defined?(:@podfile).to_s",
      ), { root: "/r/ios" });
      expect(r.status).toBe(0);
      expect(r.json).toMatchObject({ summary: "/r/ios|/r/ios|/r/ios/Pods", readme: "Pathname", description: "false" });
    });

    it("is CocoaPods 1.16.2 to Gem::Version checks", () => {
      const r = runShim(spec(' s.summary = (Gem::Version.new(Pod::VERSION) >= Gem::Version.new("1.13.0")).to_s', " s.description = Pod::VERSION"));
      expect(r.status).toBe(0);
      expect(r.json).toMatchObject({ summary: "true", description: "1.16.2" });
    });

    it("records React Native's helpers", () => {
      const r = runShim(spec(
        " install_modules_dependencies(s)",
        ' add_dependency(s, "React-Codegen", subspec: "x")',
        " f = get_folly_config()[:compiler_flags]",
        ' f << " -DMORE"',
        " s.compiler_flags = get_folly_config()[:compiler_flags]",
        " s.ios.deployment_target = min_ios_version_supported",
        ' spm_dependency(s, url: "u", requirement: {kind: "exact"}, products: ["P"])',
      ));
      expect(r.status).toBe(0);
      // React Native's add_dependency takes subspec: and drops it.
      expect(r.json.dependencies).toEqual({ "React-Codegen": [] });
      expect(r.json.compiler_flags).toBe(FOLLY_FLAGS);
      expect(r.json.platforms).toEqual({ ios: "15.1" });
      expect(r.json.__rn_xtool__.helpers).toEqual(
        ["add_dependency", "get_folly_config", "install_modules_dependencies", "min_ios_version_supported", "spm_dependency"],
      );
      expect(r.json.__rn_xtool__.spm_dependencies).toEqual([{ url: "u", requirement: { kind: "exact" }, products: ["P"] }]);
    });

    it("answers defined? and respond_to? as React Native's Podfile does", () => {
      const r = runShim(spec(
        " s.summary = defined?(install_modules_dependencies()).to_s",
        ' s.description = [respond_to?(:install_modules_dependencies, true), respond_to?(:install_modules_dependencies)].join("|")',
        " s.readme = defined?(use_expo_modules!).inspect",
      ));
      expect(r.status).toBe(0);
      expect(r.json).toMatchObject({ summary: "method", description: "true|false", readme: "nil" });
      expect(r.json.__rn_xtool__.helpers).toEqual([]);
      const f = runShim(`Pod::Spec.new do |s|\n s.compiler_flags = folly_flags()\nend`);
      expect([f.status, f.json.error.kind]).toEqual([1, "method"]);
      expect(f.json.error.message).toBe(`${f.podspec}:2: the podspec calls folly_flags(…), which rn-xtool's podspec reader does not model`);
    });

    it("answers Expo's PackagesConfig for a source build", () => {
      const r = runShim(spec(
        " s.summary = Expo::PackagesConfig.instance.coreFeatures.inspect",
        " s.description = Expo::PackagesConfig.instance.try_link_with_prebuilt_xcframework(s).inspect",
      ));
      expect(r.status).toBe(0);
      expect(r.json).toMatchObject({ summary: "[]", description: "false" });
    });

    it("stubs colored2 and refuses other gems", () => {
      const r = runShim(`require 'json'\nrequire 'rubygems'\nrequire 'colored2'\n${spec(' s.summary = "x".yellow')}`);
      expect(r.status).toBe(0);
      expect(r.json.summary).toBe("x");
      const g = runShim(`require 'json'\nrequire 'xcodeproj'\n${spec()}`);
      expect([g.status, g.json.error.kind]).toEqual([1, "require"]);
      expect(g.json.error.message).toBe(`${g.podspec}: cannot load such file -- xcodeproj; rn-xtool's podspec reader stubs only colored2`);
    });

    it("records no ENV name Ruby's own require reads", () => {
      const r = runShim(`require 'fileutils'\nrequire 'set'\nrequire 'yaml'\n${spec()}`);
      expect(r.status).toBe(0);
      expect(r.json.__rn_xtool__.env).toEqual([]);
    });

    it("loads Ruby's own files and the library's own by path", () => {
      const r = runShim(`require File.join(__dir__, 'scripts/helper')\n${spec(
        " s.summary = Gem::SourceList.new.class.name",
        " s.description = $helper_value",
      )}`, { files: { "scripts/helper.rb": "$helper_value = \"loaded #{ENV['HELPER_X'].inspect}\"\n" } });
      expect(r.status).toBe(0);
      expect(r.json).toMatchObject({ summary: "Gem::SourceList", description: "loaded nil" });
      expect(r.json.__rn_xtool__.env).toEqual(["HELPER_X"]);
    });

    it("records the ENV names a podspec reads", () => {
      const r = runShim(spec(" ENV['A']", " ENV.fetch('B', nil)", " ENV.key?('C')", " s.summary = ENV['RCT_NEW_ARCH_ENABLED']"));
      expect(r.status).toBe(0);
      expect(r.json.__rn_xtool__.env).toEqual(["A", "B", "C", "RCT_NEW_ARCH_ENABLED"]);
      expect(r.json.summary).toBe("1");
      const more = runShim(spec(" ENV.has_key?('E')", " ENV.include?('D')", " ENV.member?('F')", " ENV.values_at('H', 'G')", " ENV['D']"));
      expect(more.status).toBe(0);
      expect(more.json.__rn_xtool__.env).toEqual(["D", "E", "F", "G", "H"]);
    });

    it("runs node from the installation root", () => {
      const root = tempDir();
      mkdirSync(path.join(root, "node_modules", "react-native"), { recursive: true });
      writeFileSync(path.join(root, "node_modules", "react-native", "package.json"), JSON.stringify({ name: "react-native", version: "0.88.1" }));
      const r = runShim(spec(
        ' s.version = `cd "#{Pod::Config.instance.installation_root}" && node --print "require(\'react-native/package.json\').version"`.strip',
        " s.summary = system(\"node -e 'process.exit(0)'\").to_s",
      ), { root });
      expect(r.status).toBe(0);
      expect(r.json).toMatchObject({ version: "0.88.1", summary: "true" });
    });

    it("passes worklets 0.8.3's own stop on", () => {
      // A project whose node_modules has no react-native; the variable is the one worklets' message asks for.
      const project = tempDir();
      mkdirSync(path.join(project, "ios"));
      mkdirSync(path.join(project, "node_modules"));
      const r = runShim(readFileSync(path.join(WORKLETS, "RNWorklets.podspec"), "utf8"), {
        files: {
          "package.json": readFileSync(path.join(WORKLETS, "package.json"), "utf8"),
          "scripts/worklets_utils.rb": readFileSync(path.join(WORKLETS, "scripts", "worklets_utils.rb"), "utf8"),
        },
        root: path.join(project, "ios"),
        env: { REACT_NATIVE_NODE_MODULES_DIR: path.join(project, "node_modules") },
      });
      expect([r.status, r.json.error.kind]).toEqual([1, "raised"]);
      expect(r.json.error.message.startsWith(`${r.podspec} (scripts/worklets_utils.rb:31): [Worklets] Unable to recognize your`)).toBe(true);
    });

    it("writes UTF-8 values when LANG is C", () => {
      const r = runShim(spec(
        ' s.summary = JSON.parse(File.read(File.join(__dir__, "package.json")))["description"]',
        ' s.description = File.read(File.join(__dir__, "package.json"))[/"description":"([^"]*)"/, 1]',
      ), {
        files: { "package.json": JSON.stringify({ description: "Ünïcødé ❤️" }) },
        env: { LANG: "C" },
      });
      expect(r.status).toBe(0);
      expect(r.json).toMatchObject({ summary: "Ünïcødé ❤️", description: "Ünïcødé ❤️" });
    });

    it.skipIf(NEEDS_RN !== "")(`holds the folly flags and iOS floor every supported line defines${NEEDS_RN}`, () => {
      const r = runShim(spec(" s.compiler_flags = get_folly_config()[:compiler_flags]", " s.ios.deployment_target = min_ios_version_supported"));
      expect(r.status).toBe(0);
      for (const line of RN_LINES) {
        const helpers = tool("tar", ["-xzOf", tarballPath(line)!, "package/scripts/cocoapods/helpers.rb"]);
        expect(helpers.status, line).toBe(0);
        expect(helpers.stdout, line).toContain(`:compiler_flags => '${r.json.compiler_flags}'`);
        expect(helpers.stdout, line).toMatch(new RegExp(`def self\\.min_ios_version_supported\\s+return '${r.json.platforms.ios.replace(".", "\\.")}'`));
      }
    });
  });
});
