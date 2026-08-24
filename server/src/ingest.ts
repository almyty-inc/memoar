// Compatibility barrel: ingest is split into object storage adapters, queue
// adapters, format detection/secret scanning, and the pipeline/service.
export * from "./ingest/object-storage.js";
export * from "./ingest/queues.js";
export * from "./ingest/detection.js";
export * from "./ingest/ingest.service.js";
