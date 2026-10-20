// Compatibility entry point for the preserved-source workflow. Arguments are
// now previous/current analysis JSON and a new output directory; see
// docs/native-source-adaptation.md. The old build-specific, identifier-erasing
// comparator is retained only in Git history and its historical reports.
import './native-source-diff.mjs';
