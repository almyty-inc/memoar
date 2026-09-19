import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { MemoryDocument } from "../../libs/canonical/src/generated.js";
import type { MemoryStore, TenantContext } from "../archive-store.js";
import { buildMemoryBundle, type MemoryConversionBundle, type MemorySource } from "../convert/memory-conversion.js";
import { ARCHIVE_STORE } from "../tokens.js";
import { requireReviewed } from "./memory-redaction.js";
import { currentText } from "./memory-revisions.js";
import type { ConvertMemoryDto } from "./memory.dto.js";

@Injectable()
export class MemoryConversionService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: MemoryStore) {}

  /**
   * Ports the files one tool reads into the dialect another one reads.
   *
   * Same text, target tool's path and filename, nothing rewritten. There is no
   * model call and no job: a conversion here is a handful of files somebody
   * typed by hand, where a session conversion renders and hashes every turn,
   * which is why that one is queued and this one answers in the request.
   */
  async convert(context: TenantContext, input: ConvertMemoryDto): Promise<MemoryConversionBundle> {
    if (input.source === input.target) {
      throw new BadRequestException({
        type: "https://memoar.dev/problems/memory-conversion-noop",
        title: "That is the same dialect",
        status: 400,
        code: "memory_conversion_noop",
        detail: "The source and the target are the same tool, so there is nothing to port.",
      });
    }
    if (input.scope === "project" && !input.workspacePath) {
      throw new BadRequestException({
        type: "https://memoar.dev/problems/memory-workspace-required",
        title: "A project conversion needs a workspace",
        status: 400,
        code: "memory_workspace_required",
        detail: "Project instruction files belong to one repository. Name the workspace whose files should be ported.",
      });
    }
    const documents = await this.select(context, input);
    if (documents.length === 0) {
      throw new NotFoundException({
        type: "https://memoar.dev/problems/no-memory-to-convert",
        title: "Nothing to convert",
        status: 404,
        code: "no_memory_to_convert",
        detail: `No captured ${input.scope} instruction file is read by ${input.source}.`,
      });
    }
    const sources: MemorySource[] = [];
    for (const document of documents) {
      /*
        The gate, before a single byte is read out of the archive.

        Conversion is egress in the plainest sense: it takes the text of a file
        and writes it onto a disk, at a path a tool loads unprompted, on a
        machine that may not be the one it was captured from. These files are
        where people write "the staging key is sk-…", and the scanner's finding
        is the only thing standing between that and a second copy of it. Same
        `requireReviewed` the MCP read path calls — one rule, not two.
      */
      requireReviewed(document);
      const revisions = await this.store.listMemoryRevisions(context, document.id);
      sources.push({ path: document.path, text: currentText(document, revisions) });
    }
    return buildMemoryBundle({
      source: input.source,
      target: input.target,
      scope: input.scope,
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      sources,
    });
  }

  /**
   * The files this conversion is about.
   *
   * A document is in the source dialect when the capture agent recorded that
   * tool among its readers — the same `readers` the connector table fills in
   * from the path it matched. Filtering on readers rather than on the filename
   * is what makes "everything Claude Code reads" a single request, including
   * the per-fact files under `~/.claude/projects/*\/memory/`, which is the case
   * that makes concatenation worth having at all.
   */
  private async select(context: TenantContext, input: ConvertMemoryDto): Promise<MemoryDocument[]> {
    const documents = await this.store.listMemoryDocuments(context, {
      ...(input.machineId ? { machineId: input.machineId } : {}),
      scope: input.scope,
    });
    return documents
      .filter((document) => document.readers.includes(input.source))
      .filter((document) => input.scope === "global" || document.workspacePath === input.workspacePath)
      .sort((left, right) => left.path.localeCompare(right.path));
  }
}
