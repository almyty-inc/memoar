import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, Sse, type MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import type { MachineRecord, MachineStore, SessionStore, TenantContext } from "./archive-store.js";
import { RequireScopes, Tenant } from "./auth.js";
import type { RequestLike } from "./auth/types.js";
import { MachineRevocationService } from "./machine-revocation.js";
import { AckCommandDto, RegisterMachineDto, UpdateMachineDto } from "./machines.dto.js";
import { uuidV7 } from "./ids.js";
import { ARCHIVE_STORE } from "./tokens.js";

/**
 * One name per operating system.
 *
 * The field is whatever the client sent, and different clients spell the same
 * system differently: the Rust agent reports Rust's `std::env::consts::OS`
 * ("macos"), anything written against Node reports `process.platform`
 * ("darwin"). One account ended up listing two machines as `macos` and `darwin`
 * — the same OS, looking like two.
 */
const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  darwin: "macos",
  "mac os x": "macos",
  macosx: "macos",
  osx: "macos",
  win32: "windows",
  win: "windows",
  linux2: "linux",
};

export function normalizePlatform(platform: string): string {
  const trimmed = platform.trim();
  return PLATFORM_ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * @param captured sessions archived per machine and source, keyed "machine:tool".
 */
function machineResponse(machine: MachineRecord, captured: Map<string, number>): Record<string, unknown> {
  const lastSeen = machine.lastSeenAt ? new Date(machine.lastSeenAt).valueOf() : null;
  const status = lastSeen === null ? "never_connected" : Date.now() - lastSeen <= 120_000 ? "online" : "offline";
  return {
    id: machine.id,
    name: machine.name,
    platform: machine.platform,
    status,
    lastSeenAt: machine.lastSeenAt,
    agentVersion: machine.agentVersion,
    sources: Object.entries(machine.sourceSettings).map(([source, settings]) => ({
      source,
      settings,
      // This view exists to say what each source has produced, and the field
      sessionCount: captured.get(`${machine.id}:${source}`) ?? 0,
    })),
  };
}

@Injectable()
export class MachinesService {
  constructor(@Inject(ARCHIVE_STORE) private readonly store: MachineStore & SessionStore) {}

  async list(context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    // One grouped count for the account, rather than one query per source.
    const [machines, captured] = await Promise.all([this.store.listMachines(context), this.capturedCounts(context)]);
    return { items: machines.map((machine) => machineResponse(machine, captured)) };
  }

  /**
   * Enrols a machine, or hands back the one this installation already has.
   *
   * Registering used to create unconditionally, and the agent registered on
   * every `login`, so one laptop became a machine record per login — four
   * identical rows on one dev account, and with them a duplicate of every
   * memory document, since those are unique on (tenant, machine, path).
   *
   * Two registrations are the same machine when they carry the same
   * `installationId`, and on nothing else. Not the name: the agent's fallback
   * name is the constant `memoar-machine`, which several unrelated laptops in
   * one account will report, and fusing those would make their instruction
   * files overwrite each other — a worse failure than duplicating them, and an
   * unrecoverable one. Not the platform either, which would fuse harder still.
   * Two agents deliberately run on one host have separate config directories,
   * hence separate installation ids, and stay two machines.
   *
   * A registration with no installation id creates, exactly as before. The
   * archive will not guess an identity a client declined to state.
   */
  async register(context: TenantContext, body: RegisterMachineDto): Promise<Record<string, unknown>> {
    const installationId = body.installationId?.trim() || null;
    const enrolled = installationId ? await this.store.findMachineByInstallation(context, installationId) : null;
    const machine: MachineRecord = {
      // What the installation reports now wins, so a renamed or upgraded
      // machine is not stuck describing itself as it did on its first login.
      ...(enrolled ?? { id: uuidV7(), tenantId: context.tenantId, sourceSettings: {}, lastSeenAt: null }),
      name: body.name.trim(),
      platform: normalizePlatform(body.platform),
      agentVersion: body.agentVersion ?? enrolled?.agentVersion ?? null,
      installationId,
    };
    await this.store.saveMachine(context, machine);
    // A machine enrolled before this call has captured sessions worth counting;
    // one created just now has none, and asking would be a query for an empty
    // answer.
    const captured = enrolled ? await this.capturedCounts(context) : new Map<string, number>();
    return machineResponse(machine, captured);
  }

  async update(context: TenantContext, machineId: string, body: UpdateMachineDto): Promise<Record<string, unknown>> {
    const machine = await this.store.getMachine(context, machineId);
    if (!machine) throw new NotFoundException("Machine not found");
    if (body.name !== undefined) machine.name = body.name.trim();
    if (body.agentVersion !== undefined) machine.agentVersion = body.agentVersion;
    if (body.sourceSettings !== undefined) machine.sourceSettings = body.sourceSettings;
    await this.store.saveMachine(context, machine);
    return machineResponse(machine, await this.capturedCounts(context));
  }

  /** Sessions archived per machine and source, keyed "machine:tool". */
  private async capturedCounts(context: TenantContext): Promise<Map<string, number>> {
    const counts = await this.store.countSessionsByMachineSource(context);
    return new Map(counts.map((row) => [`${row.machineId}:${row.tool}`, row.sessions]));
  }

  private assertMachineBinding(context: TenantContext, machineId: string): void {
    if (context.machineId && context.machineId !== machineId) {
      throw new ForbiddenException("Machine token is bound to a different machine");
    }
  }

  /**
   * Durable command channel: replays every unacknowledged command on connect
   * (marking them delivered), then polls for newly created commands. A command
   * only leaves the replay set through an explicit ack, so commands survive
   * dropped connections and server restarts.
   */
  streamCommands(
    context: TenantContext,
    machineId: string,
    pollMs = Number(process.env.MACHINE_COMMAND_POLL_MS ?? 3000),
    live?: () => Promise<boolean>,
  ): Observable<MessageEvent> {
    this.assertMachineBinding(context, machineId);
    return new Observable<MessageEvent>((subscriber) => {
      let initial = true;
      let stopped = false;
      const poll = async (): Promise<void> => {
        // The credential was checked once, when the stream opened. A revoked
        // token must not keep receiving commands on a connection it already had.
        if (live && !await live()) {
          stopped = true;
          subscriber.complete();
          return;
        }
        const commands = await this.store.listUnackedMachineCommands(context, machineId);
        const batch = initial ? commands : commands.filter((command) => command.status === "pending");
        initial = false;
        for (const command of batch) {
          subscriber.next({ type: "command", data: { id: command.id, kind: command.kind, payload: command.payload, createdAt: command.createdAt } });
        }
        if (batch.length > 0) await this.store.markMachineCommandsDelivered(context, batch.map((command) => command.id));
        subscriber.next({ type: "ping", data: new Date().toISOString() });
      };
      const touch = async (): Promise<void> => {
        const machine = await this.store.getMachine(context, machineId);
        if (!machine) throw new NotFoundException("Machine not found");
        await this.store.saveMachine(context, { ...machine, lastSeenAt: new Date().toISOString() });
      };
      const tick = (): void => {
        if (stopped) return;
        poll().catch((error: unknown) => { subscriber.error(error); });
      };
      touch().then(tick).catch((error: unknown) => { subscriber.error(error); });
      const timer = setInterval(tick, pollMs);
      return () => { stopped = true; clearInterval(timer); };
    });
  }

  async ackCommand(context: TenantContext, machineId: string, commandId: string, body: AckCommandDto): Promise<void> {
    this.assertMachineBinding(context, machineId);
    const acked = await this.store.ackMachineCommand(context, machineId, commandId, {
      status: body.status,
      ...(body.error !== undefined ? { error: body.error } : {}),
    });
    if (!acked) throw new NotFoundException("Command not found");
  }
}

@Controller("machines")
export class MachinesController {
  constructor(private readonly machines: MachinesService, private readonly revocation: MachineRevocationService) {}

  @Get()
  list(@Tenant() context: TenantContext): Promise<{ items: Record<string, unknown>[] }> {
    return this.machines.list(context);
  }

  @Post()
  register(@Tenant() context: TenantContext, @Body() body: RegisterMachineDto): Promise<Record<string, unknown>> {
    return this.machines.register(context, body);
  }

  @Patch(":machineId")
  update(
    @Tenant() context: TenantContext,
    @Param("machineId", ParseUUIDPipe) machineId: string,
    @Body() body: UpdateMachineDto,
  ): Promise<Record<string, unknown>> {
    return this.machines.update(context, machineId, body);
  }

  @Sse(":machineId/commands/stream")
  @RequireScopes("materialize:read")
  stream(
    @Tenant() context: TenantContext,
    @Param("machineId", ParseUUIDPipe) machineId: string,
    @Req() request: RequestLike,
  ): Observable<MessageEvent> {
    return this.machines.streamCommands(context, machineId, undefined, this.revocation.streamLiveness(context, request));
  }

  @Post(":machineId/commands/:commandId/ack")
  @RequireScopes("materialize:read")
  @HttpCode(204)
  ack(
    @Tenant() context: TenantContext,
    @Param("machineId", ParseUUIDPipe) machineId: string,
    @Param("commandId", ParseUUIDPipe) commandId: string,
    @Body() body: AckCommandDto,
  ): Promise<void> {
    return this.machines.ackCommand(context, machineId, commandId, body);
  }
}
