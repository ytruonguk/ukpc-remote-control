import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
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

  /** Dashboard tổng quan: kết nối, quyền, lag, nhiệt, thiếu tương tác, phiên bản... và danh sách máy cần chú ý. */
  @Get('dashboard')
  dashboard(@CurrentUser() user: OperatorJwt) {
    return this.fleet.dashboard(user.sub);
  }

  /** Tiến độ cập nhật agent tới một phiên bản đích: `?target=1.4.8` (bỏ trống = bản cao nhất đang chạy). */
  @Get('rollout')
  rollout(@CurrentUser() user: OperatorJwt, @Query('target') target?: string) {
    return this.fleet.rollout(user.sub, target);
  }

  /** Các máy đứng sau một chỉ số của dashboard (ví dụ `offline`, `missingA11y`, `lagging`, `ver:1.4.7`). */
  @Get('dashboard/:key')
  dashboardList(@CurrentUser() user: OperatorJwt, @Param('key') key: string) {
    return this.fleet.dashboardList(user.sub, key);
  }

  /** Toàn fleet: lý do ngắt phổ biến và các máy ngắt nhiều nhất (chỉ máy operator có quyền xem). */
  @Get('connections')
  connections(@CurrentUser() user: OperatorJwt, @Query('hours') hours?: string) {
    return this.fleet.connections(user.sub, hours ? Number(hours) : undefined);
  }
}
