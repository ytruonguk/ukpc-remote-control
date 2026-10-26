import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type OperatorJwt } from '../auth/jwt.guard';
import { FleetService } from './fleet.service';

@Controller('fleet')
@UseGuards(JwtAuthGuard)
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('health')
  health() {
    return this.fleet.health();
  }

  /** Toàn fleet: lý do ngắt phổ biến và các máy ngắt nhiều nhất (chỉ máy operator có quyền xem). */
  @Get('connections')
  connections(@CurrentUser() user: OperatorJwt, @Query('hours') hours?: string) {
    return this.fleet.connections(user.sub, hours ? Number(hours) : undefined);
  }
}
