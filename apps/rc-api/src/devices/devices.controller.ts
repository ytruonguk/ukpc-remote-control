import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { ConnService } from './conn.service';
import { HwService } from './hw.service';
import { CurrentUser, JwtAuthGuard, type OperatorJwt } from '../auth/jwt.guard';

@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly hw: HwService,
    private readonly conn: ConnService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: OperatorJwt,
    @Query('group') group?: string,
    @Query('tier') tier?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('stale') stale?: string,
  ) {
    return this.devices.list(
      {
        group,
        tier,
        q,
        page: page ? Number(page) : 1,
        stale: stale === 'true' ? true : stale === 'false' ? false : undefined,
      },
      user.sub,
    );
  }

  @Get(':deviceId')
  get(@CurrentUser() user: OperatorJwt, @Param('deviceId') deviceId: string) {
    return this.devices.get(deviceId, user.sub);
  }

  @Get(':deviceId/hw')
  hwSamples(
    @CurrentUser() user: OperatorJwt,
    @Param('deviceId') deviceId: string,
    @Query('minutes') minutes?: string,
    @Query('limit') limit?: string,
  ) {
    return this.hw.samples(deviceId, user.sub, {
      minutes: minutes ? Number(minutes) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':deviceId/conn')
  connHistory(@CurrentUser() user: OperatorJwt, @Param('deviceId') deviceId: string, @Query('hours') hours?: string) {
    return this.conn.device(deviceId, user.sub, hours ? Number(hours) : undefined);
  }

  @Get(':deviceId/hw/events')
  hwEvents(@CurrentUser() user: OperatorJwt, @Param('deviceId') deviceId: string, @Query('limit') limit?: string) {
    return this.hw.events(deviceId, user.sub, limit ? Number(limit) : undefined);
  }

  @Post(':deviceId/hw/dump')
  hwDump(
    @CurrentUser() user: OperatorJwt,
    @Param('deviceId') deviceId: string,
    @Body() body?: { n?: number },
  ) {
    return this.hw.dump(deviceId, user.sub, body?.n);
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

  @Delete(':deviceId')
  remove(@CurrentUser() user: OperatorJwt, @Param('deviceId') deviceId: string) {
    return this.devices.remove(deviceId, user.sub);
  }
}
