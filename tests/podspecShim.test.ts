import { describe, expect, it } from "vitest";
import { SHIM, needsRuby, runShim } from "./support/ruby.js";
import { tool } from "./support/tools.js";

// The podspec reader's Ruby shim (vendor/rn-spm/spm/read-podspec-shim.rb), run by the real `ruby` on podspecs written
// into temp folders. The shim-ruby-floor CI job runs this file on the oldest Ruby the shim supports.
const spec = (...lines: string[]) => ["Pod::Spec.new do |s|", ' s.name = "Foo"', ...lines, "end"].join("\n");

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
});
