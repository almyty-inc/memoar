import { Controller, Get, Header, Res } from "@nestjs/common";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { Public } from "./auth.js";

interface HttpResponse {
  setHeader(name: string, value: string): void;
  type(value: string): HttpResponse;
  send(body: string): HttpResponse;
}

function reviewedContractSource(): Buffer {
  const configured = process.env.MEMOAR_OPENAPI_PATH;
  const candidates = [
    ...(configured ? [configured] : []),
    resolve(process.cwd(), "contracts/openapi.yaml"),
    resolve(process.cwd(), "../contracts/openapi.yaml"),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error("Reviewed contracts/openapi.yaml was not found");
  return readFileSync(path);
}

const source = reviewedContractSource();
const document = parse(source.toString("utf8")) as Record<string, unknown>;
const json = JSON.stringify(document);
const sourceSha256 = createHash("sha256").update(source).digest("hex");

export function reviewedOpenApiJson(): string { return json; }

@Controller()
export class OpenApiController {
  @Public()
  @Get("openapi.json")
  @Header("cache-control", "public, max-age=60")
  serve(@Res() response: HttpResponse): void {
    response.setHeader("x-memoar-contract-sha256", sourceSha256);
    response.type("application/json").send(json);
  }
}
