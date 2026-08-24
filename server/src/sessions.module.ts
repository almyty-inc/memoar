import { Module } from "@nestjs/common";
import { SessionsController, SessionsService } from "./sessions.js";

@Module({ controllers: [SessionsController], providers: [SessionsService], exports: [SessionsService] })
export class SessionsModule {}
