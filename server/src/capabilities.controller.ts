import { Controller, Get } from "@nestjs/common";
import { ParserRegistry } from "../libs/parsers/src/index.js";
import { CONTRACT_VERSION } from "../libs/canonical/src/generated.js";
import { Public } from "./auth.js";

/**
 * What this deployment can read, answered from the thing that reads it.
 *
 * The web app carried the connector count as an English literal — "Eleven
 * agents' session stores" — coupled to a Rust array in another crate by
 * nothing at all. It happened to be right. A twelfth connector would have made
 * it a lie, silently, and the page that says it is the one a person reads
 * before deciding whether this is worth installing.
 *
 * Public on purpose: it describes the software, not an archive. Someone
 * deciding whether to run memoar has not signed in yet.
 */
@Controller("capabilities")
export class CapabilitiesController {
  private readonly parsers = new ParserRegistry();

  @Public()
  @Get()
  capabilities(): Record<string, unknown> {
    const connectors = this.parsers.connectors();
    return {
      contractVersion: CONTRACT_VERSION,
      connectors,
      connectorCount: connectors.length,
      uploadFormats: this.parsers.uploadFormats(),
    };
  }
}
