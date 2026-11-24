// The release tag this build was packaged from. The Windows workflow rewrites this file just before
// packaging; package.json only carries a three-part version, so without the tag every build compares
// as 0.9.7.0 and offers to reinstall the newest release over itself.
export const BUILD = { tag: '' };
