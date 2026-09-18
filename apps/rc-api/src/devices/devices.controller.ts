import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { CurrentUser, JwtAuthGuard, type OperatorJwt } from '../auth/jwt.guard';

@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(
    @CurrentUser() user: OperatorJwt,
    @Query('group') group?: string,
    @Query('tier') tier?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
  ) {
    return this.devices.list({ group, tier, q, page: page ? Number(page) : 1 }, user.sub);
  }

  @Get(':deviceId')
  get(@CurrentUser() user: OperatorJwt, @Param('deviceId') deviceId: string) {
    return this.devices.get(deviceId, user.sub);
  }

  @Post(':deviceId/probe')
  async probe(@CurrentUser() user: OperatorJwt, @Param('deviceId') deviceId: string) {
    await this.devices.assertGroupAccess(user.sub, deviceId);
    const ok = await this.devices.probe(deviceId, 3000);
    const device = await this.devices.get(deviceId, user.sub);
    return { probed: ok, readiness: device.readiness };
  }

  @Post(':deviceId/selfheal')
  selfheal(@CurrentUser() user: OperatorJwt, @Param('deviceId') deviceId: string) {
    return this.devices.selfheal(deviceId, user.sub);
  }
}
