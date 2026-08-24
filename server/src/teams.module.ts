import { Module } from "@nestjs/common";
import { TeamsController, TeamsService } from "./teams.js";

@Module({ controllers: [TeamsController], providers: [TeamsService], exports: [TeamsService] })
export class TeamsModule {}
