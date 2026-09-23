import { Module } from "@nestjs/common";
import { AuthModule } from "./auth.module.js";
import { MachineRevocationController, MachineRevocationService } from "./machine-revocation.js";
import { MachinesController, MachinesService } from "./machines.js";

@Module({
  // AuthModule for CredentialsService: deregistering a machine revokes its tokens.
  imports: [AuthModule],
  controllers: [MachinesController, MachineRevocationController],
  providers: [MachinesService, MachineRevocationService],
  exports: [MachinesService],
})
export class MachinesModule {}
