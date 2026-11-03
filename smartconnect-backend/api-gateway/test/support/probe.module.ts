// TEST-ONLY routes that exercise the gateway's cross-cutting behaviour (validation, error mapping, request
// context). They live under test/, are mounted only by tests via `extraModules`, and are never part of the
// built gateway or its OpenAPI document.
import { setTimeout as delay } from 'node:timers/promises';
import { BadRequestException, Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProblemException, currentRequestId, Public } from '@smartconnect/backend-kit';

export class ProbeItemDto {
  @IsString()
  @MaxLength(20)
  label!: string;
}

export class ProbeNestedDto {
  @IsInt()
  @Min(1)
  level!: number;
}

export class ProbeDto {
  @IsString()
  @MaxLength(20)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  count?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProbeNestedDto)
  nested?: ProbeNestedDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProbeItemDto)
  items?: ProbeItemDto[];
}

export const INTERNAL_SECRET_MESSAGE = 'connect ECONNREFUSED 10.20.30.40:5432 user=sc_admin password=hunter2';

@Public()
@Controller('__probe')
export class ProbeController {
  @Post('echo')
  @HttpCode(200)
  echo(@Body() body: ProbeDto) {
    return { received: body, isDto: body instanceof ProbeDto, requestId: currentRequestId() };
  }

  /** Reads the request id after an async gap, as downstream service calls will. */
  @Get('context')
  async context() {
    await delay(5);
    return { requestId: currentRequestId() };
  }

  @Get('boom')
  boom(): never {
    throw new Error(INTERNAL_SECRET_MESSAGE);
  }

  @Get('framework-4xx')
  framework4xx(): never {
    throw new BadRequestException(INTERNAL_SECRET_MESSAGE);
  }

  @Get('domain-problem')
  domainProblem(): never {
    throw new ApiProblemException(409, 'name_taken', 'A channel with this name already exists.');
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
