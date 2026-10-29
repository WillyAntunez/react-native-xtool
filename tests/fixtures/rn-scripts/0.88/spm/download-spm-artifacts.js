    .option('version', {
    .option('flavor', {
    .option('output', {
    .option('core-tarball', {
    .option('headers-tarball', {
    .option('deps-tarball', {
    .option('deps-headers-tarball', {
module.exports = {
  main,
  resolveCacheSlotVersion,
  resolveHermesArtifact,
  resolveLocalHermesCompilerVersion,
  REQUIRED_ARTIFACTS,
  validateArtifactsCache,
  // Exposed for unit tests (pure / fetch-stubbable helpers).
  mavenRepositoryUrls,
  reactNativeMavenMirrorEnabled,
  rnCoreReleaseUrls,
  rnDepsReleaseUrls,
  hermesReleaseUrls,
  firstExistingUrl,
  resolveSnapshotUrl,
  resolveNightlyVersion,
  resolveLatestV1Version,
  resolveRNCoreArtifact,
  resolveRNDepsArtifact,
  exists,
  formatBytes,
  formatSpeed,
  findFirst,
  extractXCFramework,
};
