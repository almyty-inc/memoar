import { Module } from "@nestjs/common";
import { TeamSearchService } from "./search/team-search.js";
import { TeamsController, TeamsService } from "./teams.js";
import { TeamWorkspaceController, TeamWorkspaceService } from "./team-workspace.js";

@Module({
  controllers: [TeamsController, TeamWorkspaceController],
  providers: [TeamsService, TeamWorkspaceService, TeamSearchService],
  exports: [TeamsService, TeamWorkspaceService],
})
export class TeamsModule {}
