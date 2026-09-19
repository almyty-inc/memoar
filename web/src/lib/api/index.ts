import type { TimelineGroup } from '../types';
import { MemoarApiClient } from './client-library';

export { MemoarApiError } from './errors';
export { MemoarApiClient } from './client-library';
export type {
  ArchiveCapabilities,
  AuthMethods,
  DistillationSettings,
  ImportProgress,
  ImportSource,
  ImportStage,
  McpStatus,
  RawArtifactStatus,
  TenantSettings,
} from './contracts';

const environment = import.meta.env as Record<string, unknown>;
const configuredApiUrl: unknown = environment.VITE_API_URL;
const apiUrl = typeof configuredApiUrl === 'string' ? configuredApiUrl : '';


export const memoarApi = new MemoarApiClient(apiUrl);
memoarApi.consumeOAuthCallback();

export type { TimelineGroup };
