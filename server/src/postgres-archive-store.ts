// Compatibility barrel: the Postgres store now lives in ./store/postgres/*
// as per-domain classes behind a delegating facade.
export { PostgresArchiveStore, TenantRunner, TenantScope } from "./store/postgres/index.js";
