// leaflet.heat ships no type declarations, and it is not really a module
// either: the published dist is a bare script with no wrapper that reads and
// writes the GLOBAL `L`. HeatMapView arranges that global before importing
// it — see the loader comment there, which is where the runtime half of this
// story lives.
//
// This file is a global SCRIPT on purpose (no top-level import or export).
// `declare module 'leaflet.heat';` is a shorthand ambient declaration, and a
// shorthand is only legal in a script: inside a module file TypeScript reads
// any `declare module` as an AUGMENTATION and rejects one aimed at a package
// that has no types of its own to augment. The `L.heatLayer` signature the
// call site actually needs therefore lives beside it in
// `leaflet-heat-layer.d.ts`, which has to be a module for the opposite
// reason — augmenting `leaflet` is only legal there.
declare module 'leaflet.heat';
