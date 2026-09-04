import { Global, Module } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { ArchiveStore } from "./archive-store.js";
import { dataSourceFactory } from "./data-source.js";
import { DevArchiveStore } from "./dev-archive-store.js";
import { distillationProviderFromEnv } from "./distillation.js";
import {
  AwsS3ClientPort, BullMqJobQueue, InMemoryJobQueue, MemoryObjectStorage,
  S3ObjectStorage, type JobQueue, type ObjectStorage,
} from "./ingest.js";
import { PostgresArchiveStore } from "./postgres-archive-store.js";
import {
  DeterministicLexicalBackend, DisabledSemanticSearchProvider, embeddingProviderFromEnv,
  PostgresFtsBackend, PostgresVectorSearchProvider,
} from "./search.js";
import { ARCHIVE_STORE, DISTILLATION_PROVIDER, JOB_QUEUE, OBJECT_STORAGE, SEARCH_BACKEND, SEMANTIC_SEARCH_PROVIDER } from "./tokens.js";

/**
 * Backing services shared by every domain module: database, archive store,
 * object storage, job queue, search backends, and the distillation provider.
 * Global so domain modules declare only their own controllers and services.
 */
@Global()
@Module({
  providers: [
    { provide: DataSource, useFactory: dataSourceFactory },
    {
      provide: ARCHIVE_STORE,
      inject: [DataSource],
      // An archive holds what was captured and nothing else. There is no
      // seeding step here: a session that nobody had is not a session.
      useFactory: (dataSource: DataSource | null): ArchiveStore =>
        dataSource ? new PostgresArchiveStore(dataSource) : new DevArchiveStore(),
    },
    {
      provide: OBJECT_STORAGE,
      useFactory: async (): Promise<ObjectStorage> => {
        const endpoint = process.env.S3_ENDPOINT;
        if (!endpoint) {
          if (process.env.NODE_ENV === "production") throw new Error("S3_ENDPOINT is required in production");
          return new MemoryObjectStorage();
        }
        const client = new AwsS3ClientPort({
          endpoint,
          ...(process.env.S3_PUBLIC_ENDPOINT
            ? { publicEndpoint: process.env.S3_PUBLIC_ENDPOINT }
            : process.env.NODE_ENV !== "production" ? { publicEndpoint: "http://localhost:59000" } : {}),
          region: process.env.S3_REGION ?? "us-east-1",
          accessKeyId: process.env.S3_ACCESS_KEY ?? "",
          secretAccessKey: process.env.S3_SECRET_KEY ?? "",
        });
        const storage = new S3ObjectStorage(client, process.env.S3_BUCKET ?? "memoar-raw");
        await storage.health();
        return storage;
      },
    },
    {
      provide: JOB_QUEUE,
      useFactory: (): JobQueue => {
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
          if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required in production");
          return new InMemoryJobQueue();
        }
        return new BullMqJobQueue(redisUrl);
      },
    },
    {
      provide: SEARCH_BACKEND,
      inject: [DataSource, ARCHIVE_STORE],
      useFactory: (dataSource: DataSource | null, store: ArchiveStore) => dataSource
        ? new PostgresFtsBackend(dataSource, store)
        : new DeterministicLexicalBackend(store),
    },
    {
      provide: SEMANTIC_SEARCH_PROVIDER,
      inject: [DataSource, ARCHIVE_STORE],
      useFactory: (dataSource: DataSource | null, store: ArchiveStore) => {
        const embeddings = embeddingProviderFromEnv();
        return dataSource && embeddings
          ? new PostgresVectorSearchProvider(dataSource, store, embeddings)
          : new DisabledSemanticSearchProvider();
      },
    },
    { provide: DISTILLATION_PROVIDER, useFactory: () => distillationProviderFromEnv() },
  ],
  exports: [DataSource, ARCHIVE_STORE, OBJECT_STORAGE, JOB_QUEUE, SEARCH_BACKEND, SEMANTIC_SEARCH_PROVIDER, DISTILLATION_PROVIDER],
})
export class InfrastructureModule {}
