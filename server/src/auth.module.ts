import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController, AuthGuard, AuthService, TokenService } from "./auth.js";

@Module({
  controllers: [AuthController],
  providers: [TokenService, AuthService, AuthGuard, { provide: APP_GUARD, useExisting: AuthGuard }],
  exports: [TokenService, AuthService, AuthGuard],
})
export class AuthModule {}
