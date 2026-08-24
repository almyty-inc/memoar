import { Module } from "@nestjs/common";
import { PackService, SearchController, SearchService } from "./search.js";

@Module({ controllers: [SearchController], providers: [SearchService, PackService], exports: [SearchService, PackService] })
export class SearchModule {}
