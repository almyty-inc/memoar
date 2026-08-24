import { Module } from "@nestjs/common";
import { ConversionService, ConvertController } from "./convert.js";
import { SearchModule } from "./search.module.js";

@Module({ imports: [SearchModule], controllers: [ConvertController], providers: [ConversionService], exports: [ConversionService] })
export class ConvertModule {}
