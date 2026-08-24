// Compatibility barrel: curation now lives in per-domain Nest modules under
// ./annotations, ./collections, and ./sharing.
export { AnnotationController } from "./annotations/annotations.controller.js";
export { AnnotationService } from "./annotations/annotations.service.js";
export { AnnotationsModule } from "./annotations/annotations.module.js";
export { CollectionController } from "./collections/collections.controller.js";
export { CollectionService } from "./collections/collections.service.js";
export { CollectionsModule } from "./collections/collections.module.js";
export { RedactionReviewController, ShareConsumeController, SharingController } from "./sharing/sharing.controller.js";
export { sessionContentDigest, SharingService } from "./sharing/sharing.service.js";
export { SharingModule } from "./sharing/sharing.module.js";
