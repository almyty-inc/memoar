import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Res } from "@nestjs/common";
import type { Response } from "express";

import type { TenantContext } from "../archive-store.js";
import { Tenant } from "../auth.js";
import { DeltaDto, ManifestDto } from "./ingest.dto.js";
import { IngestService } from "./ingest.service.js";

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * The capture source, optionally with the format version the client asserts
 * ("claude-code@v1"). Held to a shape because it names a parser, is stored on
 * every artifact and is echoed back in the status response.
 */
const SOURCE_HEADER = /^[a-z0-9][a-z0-9._-]{0,63}(?:@[A-Za-z0-9._-]{1,32})?$/u;

/** A capture path: any length up to the filesystem's, but not control characters. */
const SOURCE_PATH_MAX = 4_096;

/** Headers arrive as text from a machine credential and are validated like a body. */
function ingestHeaders(source: string | undefined, sourcePath: string | undefined): { source: string; sourcePath: string } {
  if (!source || !SOURCE_HEADER.test(source)) {
    throw new BadRequestException("x-memoar-source must name a capture source, optionally as source@version");
  }
  const path = sourcePath ?? "";
  if (path.length > SOURCE_PATH_MAX || /[\u0000-\u001f]/u.test(path)) {
    throw new BadRequestException(`x-memoar-source-path must be at most ${SOURCE_PATH_MAX} characters and carry no control characters`);
  }
  return { source, sourcePath: path };
}

@Controller("ingest")
export class IngestController {
  constructor(@Inject(IngestService) private readonly ingest: IngestService) {}

  @Put("artifacts/:sha256")
  async put(
    @Tenant() context: TenantContext,
    @Param("sha256") sha256: string,
    @Headers("x-memoar-source") source: string,
    @Headers("x-memoar-source-path") sourcePath: string,
    @Body() body: Buffer,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Record<string, unknown>> {
    if (!Buffer.isBuffer(body)) throw new BadRequestException("application/octet-stream body is required");
    if (!SHA256.test(sha256)) throw new BadRequestException("sha256 must be a 64 character lowercase hex digest");
    const headers = ingestHeaders(source, sourcePath);
    const result = await this.ingest.putRaw(context, sha256, headers.source, headers.sourcePath, body);
    response.status(result.created ? 201 : 208);
    return { id: result.artifact.id, status: result.created ? "stored" : "duplicate" };
  }

  @Get("artifacts/:sha256/status")
  status(@Tenant() context: TenantContext, @Param("sha256") sha256: string): Promise<Record<string, unknown>> {
    // The contract pins the digest shape; anything else is a malformed request
    // rather than a lookup that happens to miss.
    if (!SHA256.test(sha256)) throw new BadRequestException("sha256 must be a 64 character lowercase hex digest");
    return this.ingest.status(context, sha256);
  }

  @Get("unparsed")
  unparsed(@Tenant() context: TenantContext): Promise<Record<string, unknown>> {
    return this.ingest.unparsed(context);
  }

  @Post("manifests")
  @HttpCode(202)
  manifest(@Tenant() context: TenantContext, @Body() body: ManifestDto) {
    return this.ingest.manifest(context, body);
  }

  @Post("delta")
  delta(@Tenant() context: TenantContext, @Body() body: DeltaDto) { return this.ingest.delta(context, body.hashes); }
}
