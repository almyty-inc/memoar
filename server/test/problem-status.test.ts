import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { statusFor } from "../src/observability.js";

/**
 * An oversized body is the caller's problem, and must say so.
 *
 * body-parser throws a plain Error carrying `status: 413` rather than a Nest
 * HttpException. That fell through to 500 "internal error": logged as an
 * unhandled server fault, fingerprinted as ours, and telling the client nothing
 * it could act on. A capture agent whose manifest was too large to describe saw
 * only "internal_error" and retried the same batch forever.
 */
describe("the status an exception is reported with", () => {
  it("keeps a status the exception already carries", () => {
    const oversized = Object.assign(new Error("request entity too large"), { status: 413 });
    expect(statusFor(oversized)).toBe(413);
  });

  it("honours statusCode as well, which is what some middleware sets", () => {
    const refused = Object.assign(new Error("unsupported media type"), { statusCode: 415 });
    expect(statusFor(refused)).toBe(415);
  });

  it("still reports an ordinary fault as ours", () => {
    expect(statusFor(new Error("something broke"))).toBe(500);
  });

  it("leaves a Nest exception alone", () => {
    expect(statusFor(new HttpException("nope", HttpStatus.FORBIDDEN))).toBe(403);
  });
});
