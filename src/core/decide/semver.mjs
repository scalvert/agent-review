// How one version change moves, by semver. Anything that is not a clean
// release-to-release step (a prerelease, a downgrade, a range, or a version
// that does not parse) is "other", which no rule treats as a patch.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function versionChange(from, to) {
  const a = VERSION.exec(String(from ?? ""));
  const b = VERSION.exec(String(to ?? ""));
  if (!a || !b) return "other";
  const [, aM, am, ap] = a.map(Number);
  const [, bM, bm, bp] = b.map(Number);
  if (bM === aM && bm === am && bp > ap) return "patch";
  if (bM === aM && (bm > am || (bm === am && bp === ap))) return bm > am ? "minor" : "none";
  if (bM > aM) return "major";
  return "other";
}
