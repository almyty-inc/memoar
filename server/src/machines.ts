import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Patch, Post, Sse, type MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import type { MachineRecord, MachineStore, SessionStore, TenantContext } from "./archive-store.js";
import { RequireScopes, Tenant } from "./auth.js";
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

  async register(context: TenantContext, body: RegisterMachineDto): Promise<Record<string, unknown>> {
    const machine: MachineRecord = {
      id: uuidV7(),
      tenantId: context.tenantId,
      name: body.name.trim(),
      platform: normalizePlatform(body.platform),
      agentVersion: body.agentVersion ?? null,
      sourceSettings: {},
      lastSeenAt: null,
    };
    await this.store.saveMachine(context, machine);
    return machineResponse(machine, new Map());
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
  streamCommands(context: TenantContext, machineId: string, pollMs = Number(process.env.MACHINE_COMMAND_POLL_MS ?? 3000)): Observable<MessageEvent> {
    this.assertMachineBinding(context, machineId);
    return new Observable<MessageEvent>((subscriber) => {
      let initial = true;
      let stopped = false;
      const poll = async (): Promise<void> => {
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
  constructor(private readonly machines: MachinesService) {}

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
    @Param("machineId") machineId: string,
    @Body() body: UpdateMachineDto,
  ): Promise<Record<string, unknown>> {
    return this.machines.update(context, machineId, body);
  }

  @Sse(":machineId/commands/stream")
  @RequireScopes("materialize:read")
  stream(@Tenant() context: TenantContext, @Param("machineId") machineId: string): Observable<MessageEvent> {
    return this.machines.streamCommands(context, machineId);
  }

  @Post(":machineId/commands/:commandId/ack")
  @RequireScopes("materialize:read")
  @HttpCode(204)
  ack(
    @Tenant() context: TenantContext,
    @Param("machineId") machineId: string,
    @Param("commandId") commandId: string,
    @Body() body: AckCommandDto,
  ): Promise<void> {
    return this.machines.ackCommand(context, machineId, commandId, body);
  }
}
