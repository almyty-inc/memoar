import { Module } from "@nestjs/common";
import { ErrorsController } from "./errors.controller.js";

@Module({ controllers: [ErrorsController] })
export class ErrorsModule {}
