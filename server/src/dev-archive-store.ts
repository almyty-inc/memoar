// Compatibility barrel: the in-memory store now lives in ./store/memory/*
// as per-domain classes over shared tables behind a delegating facade.
export { DevArchiveStore } from "./store/memory/index.js";
