import { describe, expect, it } from "vitest";
import type { MessageEvent } from "@nestjs/common";
import type { TenantContext } from "../src/archive-store.js";
import { DEMO_CONTEXT } from "../src/demo-data.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { MachinesService } from "../src/machines.js";

const MACHINE_ID = "0191cafe-0000-7000-8000-0000000000a1";

async function seededMachine(store: DevArchiveStore): Promise<MachinesService> {
  await store.saveMachine(DEMO_CONTEXT, {
    id: MACHINE_ID, tenantId: DEMO_CONTEXT.tenantId, name: "laptop", platform: "darwin",
    agentVersion: null, sourceSettings: {}, lastSeenAt: null,
  });
  return new MachinesService(store);
}

function collectEvents(service: MachinesService, context: TenantContext, durationMs: number): Promise<MessageEvent[]> {
  return new Promise((resolve, reject) => {
    const events: MessageEvent[] = [];
    const subscription = service.streamCommands(context, MACHINE_ID, 25).subscribe({
      next: (event) => events.push(event),
      error: reject,
    });
    setTimeout(() => {
      subscription.unsubscribe();
      resolve(events);
    }, durationMs);
  });
}

function commandEvents(events: MessageEvent[]): Record<string, unknown>[] {
  return events.filter((event) => event.type === "command").map((event) => event.data as Record<string, unknown>);
}

describe("durable machine commands", () => {
  it("replays unacked commands on connect, marks them delivered, and pushes new ones", async () => {
    const store = new DevArchiveStore();
    const service = await seededMachine(store);
    const first = await store.createMachineCommand(DEMO_CONTEXT, { machineId: MACHINE_ID, kind: "materialize", payload: { jobId: "job-1" } });

    const events = await (async () => {
      const promise = collectEvents(service, DEMO_CONTEXT, 120);
      setTimeout(() => {
        void store.createMachineCommand(DEMO_CONTEXT, { machineId: MACHINE_ID, kind: "materialize", payload: { jobId: "job-2" } });
      }, 40);
      return promise;
    })();

    const commands = commandEvents(events);
    expect(commands.map((command) => (command.payload as { jobId: string }).jobId)).toEqual(["job-1", "job-2"]);
    expect(events.some((event) => event.type === "ping")).toBe(true);

    const unacked = await store.listUnackedMachineCommands(DEMO_CONTEXT, MACHINE_ID);
    expect(unacked.map((command) => command.status)).toEqual(["delivered", "delivered"]);
    expect(unacked[0]!.id).toBe(first.id);
  });

  it("replays delivered-but-unacked commands on reconnect and drops them after ack", async () => {
    const store = new DevArchiveStore();
    const service = await seededMachine(store);
    const command = await store.createMachineCommand(DEMO_CONTEXT, { machineId: MACHINE_ID, kind: "materialize", payload: { jobId: "job-1" } });

    expect(commandEvents(await collectEvents(service, DEMO_CONTEXT, 60))).toHaveLength(1);
    expect(commandEvents(await collectEvents(service, DEMO_CONTEXT, 60))).toHaveLength(1);

    await service.ackCommand(DEMO_CONTEXT, MACHINE_ID, command.id, { status: "completed" });
    expect(commandEvents(await collectEvents(service, DEMO_CONTEXT, 60))).toHaveLength(0);
    expect(await store.listUnackedMachineCommands(DEMO_CONTEXT, MACHINE_ID)).toHaveLength(0);
  });

  it("records failed acks with their error and 404s unknown commands", async () => {
    const store = new DevArchiveStore();
    const service = await seededMachine(store);
    const command = await store.createMachineCommand(DEMO_CONTEXT, { machineId: MACHINE_ID, kind: "materialize", payload: {} });

    await service.ackCommand(DEMO_CONTEXT, MACHINE_ID, command.id, { status: "failed", error: "target store locked" });
    expect(await store.listUnackedMachineCommands(DEMO_CONTEXT, MACHINE_ID)).toHaveLength(0);

    await expect(service.ackCommand(DEMO_CONTEXT, MACHINE_ID, "0191cafe-0000-7000-8000-00000000dead", { status: "completed" })).rejects.toThrow("Command not found");
  });

  it("rejects machine tokens bound to a different machine for stream and ack", async () => {
    const store = new DevArchiveStore();
    const service = await seededMachine(store);
    const other: TenantContext = { ...DEMO_CONTEXT, machineId: "0191cafe-0000-7000-8000-0000000000ff" };
    expect(() => service.streamCommands(other, MACHINE_ID)).toThrow("bound to a different machine");
    await expect(service.ackCommand(other, MACHINE_ID, "0191cafe-0000-7000-8000-00000000dead", { status: "completed" })).rejects.toThrow("bound to a different machine");
  });

  it("errors the stream for an unknown machine", async () => {
    const store = new DevArchiveStore();
    const service = new MachinesService(store);
    await expect(collectEvents(service, DEMO_CONTEXT, 60)).rejects.toThrow("Machine not found");
  });
});
