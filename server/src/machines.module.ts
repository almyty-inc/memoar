import { Module } from "@nestjs/common";
import { MachinesController, MachinesService } from "./machines.js";

@Module({ controllers: [MachinesController], providers: [MachinesService], exports: [MachinesService] })
export class MachinesModule {}
