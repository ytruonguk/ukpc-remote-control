import { Body, Controller, Delete, Get, Ip, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { EntryPoint } from '@rc/shared';
import { CurrentUser, JwtAuthGuard, type OperatorJwt } from '../auth/jwt.guard';
import { SessionsService } from './sessions.service';

class StartSessionDto {
  @IsString()
  deviceId!: string;

  @IsOptional()
  @IsIn(['hmdm_deeplink', 'rc_console', 'api'])
  entryPoint: EntryPoint = 'rc_console';
}

@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  @Throttle({ default: { limit: Number(process.env.SESSION_RATE_LIMIT ?? 10), ttl: 60_000 } })
  start(@CurrentUser() user: OperatorJwt, @Body() body: StartSessionDto, @Ip() ip: string) {
    return this.sessions.start(body.deviceId, user.sub, body.entryPoint, ip);
  }

  @Delete(':id')
  close(@CurrentUser() user: OperatorJwt, @Param('id') id: string) {
    return this.sessions.close(id, user.sub);
  }

  @Get()
  list(
    @Query('deviceId') deviceId?: string,
    @Query('operatorId') operatorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.sessions.list({ deviceId, operatorId, from, to });
  }
}
