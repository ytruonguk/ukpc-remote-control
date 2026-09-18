import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FleetService } from './fleet.service';

@Controller('fleet')
@UseGuards(JwtAuthGuard)
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  @Get('health')
  health() {
    return this.fleet.health();
  }
}
